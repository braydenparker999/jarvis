import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {relayAccountHubPath,relayAccountRequestGate,RELAY_ACCOUNT_INGRESS_LIMITS} from '../backend/relay-account-ingress.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const configuration=JSON.parse(readFileSync(new URL('../backend/wrangler.jsonc',import.meta.url),'utf8'));
const fixture=`
import worker,{Hub,sharedInternal,syncShared} from './backend/worker.js';
export class IngressFixture {
 constructor(ctx){this.ctx=ctx;}
 async fetch(request){
  const input=await request.json(),metrics={sql:0,storage:0,egress:0,namespace:0,callback:0};
  const before=this.ctx.storage.sql.databaseSize;
  const storage=new Proxy(this.ctx.storage,{get:(target,key)=>{
   metrics.storage++;
   if(key==='sql')return {exec:(...args)=>{metrics.sql++;return target.sql.exec(...args);},get databaseSize(){return target.sql.databaseSize;}};
   return typeof target[key]==='function'?target[key].bind(target):target[key];
  }});
  const ctx=new Proxy(this.ctx,{get:(target,key)=>key==='storage'?storage:typeof target[key]==='function'?target[key].bind(target):target[key]});
  const env={RELAY_ENABLED:'true',RELAY_OWNER_ENABLED:'true',HUBS:{idFromName(){metrics.namespace++;throw Error('No fixture namespace access');},get(){metrics.namespace++;throw Error('No fixture namespace access');}}};
  if(input.modePresent!==false)env.RELAY_ACCOUNT_ADMISSION_MODE=Object.hasOwn(input,'mode')?input.mode:'enforced';
  const oldFetch=globalThis.fetch;globalThis.fetch=()=>{metrics.egress++;throw Error('Fictional closed provider boundary');};
  let response;
  try{
   const hub=new Hub(ctx,env,{publicationFetcher:()=>{metrics.egress++;throw Error('Fictional publication boundary');},...(input.runtime?{accountAdmission:input.runtime}:{})});
   const init={method:input.method||'GET',headers:input.headers||{}};
   if(!['GET','HEAD'].includes(init.method))init.body=input.body??'not JSON';
   const inner=new Request('https://fictional.example'+(input.path||'/internal/shared/state'),init);
   if(input.target==='outer')response=await worker.fetch(inner,env);
   else if(input.target==='alarm')response=Response.json(await hub.alarm());
   else if(input.target==='sync'){await hub.syncPublicRead();response=Response.json({ok:true});}
   else if(input.target==='wake'){await hub.withCoreWake(()=>{metrics.callback++;});response=Response.json({ok:true});}
   else if(input.target==='shared')response=await sharedInternal(env,'/state',{});
   else if(input.target==='syncShared'){await syncShared(env);response=Response.json({ok:true});}
   else response=await hub.fetch(inner);
  }catch(error){response=Response.json({error:error.message,code:error.code},{status:503});}
  finally{globalThis.fetch=oldFetch;}
  const body=await response.text(),after=this.ctx.storage.sql.databaseSize;
  return Response.json({status:response.status,body,metrics,before,after});
 }
}
export default {fetch(request,env){return env.FIXTURE.get(env.FIXTURE.idFromName('fictional-admission')).fetch(request);}};
`;
async function local(t){
 const compiled=await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'fictional-ingress.js'},bundle:true,format:'esm',platform:'browser',external:['node:crypto'],write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:configuration.compatibility_date,compatibilityFlags:configuration.compatibility_flags||[],cf:false,telemetry:{enabled:false},outboundService(){throw Error('External egress denied');},durableObjects:{FIXTURE:{className:'IngressFixture',useSQLite:true}},unsafeModuleFallbackService:()=>{throw Error('External module denied');}}));
 t.after(()=>mf.dispose());
 return async input=>{const response=await mf.dispatchFetch('https://local.test',{method:'POST',body:JSON.stringify(input)});assert.equal(response.status,200);return response.json();};
}
function untouched(value){assert.deepEqual(value.metrics,{sql:0,storage:0,egress:0,namespace:0,callback:0});assert.equal(value.after,value.before);}
const hubPaths=['/internal/relay/oauth','/internal/relay/owner','/internal/relay/rpc','/internal/shared/legacy-page','/internal/shared/reconcile-legacy','/internal/shared/import-hint','/internal/shared/message','/internal/shared/state','/internal/shared/changes','/internal/shared/result','/internal/oauth-store','/internal/register','/internal/access','/internal/authorize','/v1/agent/inbox','/v1/agent/replies','/v1/state','/v1/messages'];
const publicPaths=['/relay/mcp','/relay/oauth/authorize','/relay/oauth/register','/relay/oauth/github/callback','/relay/oauth/token','/relay/oauth/revoke','/relay/owner/jobs','/relay/owner/messages','/relay/owner/login','/shared/state','/shared/changes','/shared/result','/shared/messages','/shared/import-hint','/oauth/authorize','/oauth/register','/oauth/token','/oauth/revoke','/mcp','/v1/responder/connect','/v1/responder/revoke','/v1/agent/replies','/v1/state'];

test('native Hub schema/auth/storage routes refuse enforcement before SQL, KV, namespace and egress',async t=>{
 const call=await local(t);
 for(const path of hubPaths){const value=await call({path,method:path.endsWith('/state')?'GET':'POST',headers:{'X-Account-Admission':'forged','Authorization':'Bearer '+'a'.repeat(64)},body:JSON.stringify({principal:'github:183016859',approved:true,budget:{rowsRead:999999999},permit:{status:'granted'}})});assert.equal(value.status,503,path);assert.equal(JSON.parse(value.body).code,'finite_upstream_admission_unknown');untouched(value);}
});
test('native outer OAuth, owner, RPC, import-hint and legacy ingress deny before authentication lookup',async t=>{
 const call=await local(t);
 for(const path of publicPaths){assert.equal(relayAccountHubPath(path),true,path);const value=await call({target:'outer',path,method:'POST',body:'not JSON'});assert.equal(value.status,503,path);untouched(value);}
});
test('direct public-read/wake/alarm/shared exports cannot bypass missing authority',async t=>{
 const call=await local(t);
 for(const target of ['alarm','sync','wake','shared','syncShared']){const value=await call({target});assert.equal(target==='alarm'?JSON.parse(value.body).status:value.status,target==='alarm'?'blocked':503,target);untouched(value);}
});
test('unknown mode, forged runtime, reload and concurrent denial remain closed with no source state',async t=>{
 const call=await local(t);
 for(const mode of ['true','false','legacy',true,{},null]){const value=await call({mode,path:'/internal/relay/oauth',method:'POST'});assert.equal(value.status,503);untouched(value);}
 const forged=await call({modePresent:false,runtime:{status:'granted',reserve:true},path:'/internal/shared/state'});assert.equal(forged.status,503);untouched(forged);
 for(const value of await Promise.all(Array.from({length:8},()=>call({target:'alarm'}))))untouched(value);
});
test('requested mode preserves health/music/Poweramp/podcast/songsterr paths and their existing guards',async t=>{
 const call=await local(t);
 for(const path of ['/health','/music/manifest.json','/music/uploads/audio/'+('a'.repeat(64))+'.opus','/podcasts/search','/guitar/search']){
  assert.equal(relayAccountHubPath(path),false,path);
  const baseline=await call({target:'outer',path,modePresent:false});
  const enforced=await call({target:'outer',path});
  assert.equal(enforced.status,baseline.status,path);assert.equal(enforced.body,baseline.body,path);assert.equal(enforced.metrics.storage,0);assert.equal(enforced.metrics.sql,0);assert.equal(enforced.metrics.namespace,0);
 }
});
test('absence of mode retains real legacy workspace KV behavior',async t=>{
 const call=await local(t);const value=await call({modePresent:false,path:'/v1/state'});assert.equal(value.status,200);assert.deepEqual(JSON.parse(value.body),{messages:[],posts:[]});assert.ok(value.metrics.storage>0);assert.equal(value.metrics.sql,0);
});
test('body bounds precede parsing/admission and caller markers never supply authority',async()=>{
 let cancelled=false;
 const huge=new Request('https://local.test/internal/relay/rpc',{method:'POST',body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(RELAY_ACCOUNT_INGRESS_LIMITS.bodyBytes+1));},cancel(){cancelled=true;}}),duplex:'half'});
 const denied=await relayAccountRequestGate(huge,{RELAY_ACCOUNT_ADMISSION_MODE:'enforced'});assert.equal(denied.response.status,413);assert.equal(cancelled,true);
 const fake=new Request('https://local.test',{method:'POST',headers:{'X-Account-Admission':'true','Content-Type':'application/json'},body:'{"approved":true,"scope":"private","budget":999999,"permit":{"status":"granted"}}'});
 assert.equal((await relayAccountRequestGate(fake,{RELAY_ACCOUNT_ADMISSION_MODE:'enforced'})).response.status,503);
});
test('tiny or stalled bodies cannot create an unbounded admission read',async()=>{
 const small=new Request('https://local.test',{method:'POST',body:new ReadableStream({start(controller){for(let n=0;n<=RELAY_ACCOUNT_INGRESS_LIMITS.bodyChunks;n++)controller.enqueue(new Uint8Array([1]));controller.close();}}),duplex:'half'});
 assert.equal((await relayAccountRequestGate(small,{RELAY_ACCOUNT_ADMISSION_MODE:'enforced'})).response.status,413);
 let cancelled=false;const stalled=new Request('https://local.test',{method:'POST',body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'});
 const before=performance.now();assert.equal((await relayAccountRequestGate(stalled,{RELAY_ACCOUNT_ADMISSION_MODE:'enforced'})).response.status,413);assert.equal(cancelled,true);assert.ok(performance.now()-before<2000);
});
