import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {relayAccountPrepare,relayAccountConstructCatalog,relayAccountRuntimeIdentity} from '../backend/relay-account-ingress.js';
import {RELAY_MIGRATION_CATALOG as CATALOG} from '../backend/relay-migration-preflight-catalog.js';
const root=fileURLToPath(new URL('../',import.meta.url)),configuration=JSON.parse(readFileSync(new URL('../backend/wrangler.jsonc',import.meta.url),'utf8'));
const fixture=`
import {RelayAccountAdmission,accountAdmissionPlan,relayAccountAdmissionHash} from './backend/relay-account-admission.js';
import {relayAccountPrepare,relayAccountConstructCatalog,relayAccountRuntimeIdentity,relayAccountScopeIdentity} from './backend/relay-account-ingress.js';
import {RELAY_MIGRATION_CATALOG} from './backend/relay-migration-preflight-catalog.js';
// Source SQL is actual local workerd. Its allocator is the genuine module
// engine over a fictional external KV transaction model outside source SQL.
// Sibling native allocator tests establish actual durable KV separately; this
// fixture deliberately does NOT claim working cross-DO production transport.
let account;let elapsedOffset=0;const actualMonotonic=performance.now.bind(performance);Object.defineProperty(performance,'now',{value:()=>actualMonotonic()+elapsedOffset});const reports=new Map(),externalKV=new Map();let tail=Promise.resolve();
const externalStorage={transaction(action){const execute=async()=>{const staged=new Map([...externalKV].map(([k,v])=>[k,structuredClone(v)]));const txn={get:async key=>structuredClone(staged.get(key)),put:async(key,value)=>{if(typeof key==='object'){for(const [k,v] of Object.entries(key))staged.set(k,structuredClone(v));}else staged.set(key,structuredClone(value));}};const value=await action(txn);externalKV.clear();for(const [k,v] of staged)externalKV.set(k,v);return value;};const result=tail.then(execute,execute);tail=result.catch(()=>{});return result;}};
export class AllocatorFixture {
 constructor(){this.engine=new RelayAccountAdmission({storage:externalStorage});account=this.engine;}
 async fetch(request){const b=await request.json();if(b.op==='provision')return Response.json(await this.engine.provision(b.plan,b.now));if(b.op==='inspect')return Response.json(await this.engine.inspect(b.now));if(b.op==='restart'){this.engine=new RelayAccountAdmission({storage:externalStorage});account=this.engine;return Response.json(await this.engine.inspect(b.now));}if(b.op==='lose'){const reserve=this.engine.reserve.bind(this.engine);let once=true;this.engine.reserve=async(...args)=>{const result=await reserve(...args);if(once){once=false;return {status:'blocked',reason:'fictional_lost_ack'};}return result;};return Response.json({status:'armed'});}if(b.op==='delay'){const method=b.method==='final'?'reserveFinal':'reserve',original=this.engine[method].bind(this.engine);this.engine[method]=async(...args)=>{const result=await original(...args);await Promise.resolve();elapsedOffset+=b.advance;return result;};return Response.json({status:'armed'});}if(b.op==='revoke')return Response.json(await this.engine.revoke(b.now));return Response.json({status:'blocked'});}
}
export class SourceFixture {
 constructor(ctx){this.ctx=ctx;}
 async fetch(request){
  const b=await request.json(),sql=this.ctx.storage.sql;
  if(b.op==='identity')return Response.json({scopeHash:await relayAccountScopeIdentity(this.ctx),runtime:await relayAccountRuntimeIdentity(),nativeBytes:sql.databaseSize,accountLocal:!!account});
  if(b.op==='seed'){for(const row of RELAY_MIGRATION_CATALOG.tables.filter(row=>row.retainedInSource))sql.exec(row.sql);for(const row of RELAY_MIGRATION_CATALOG.indices.filter(row=>row.retainedInSource))sql.exec(row.sql);return Response.json({status:'seeded'});}
  if(b.op==='drift'){sql.exec("UPDATE shared_meta SET value='fictional-changed' WHERE key='missing'");sql.exec("INSERT INTO shared_meta VALUES('fictional-key','fictional-value')");return Response.json({status:'changed'});}
  if(b.op==='prepare'){const value=await relayAccountPrepare(account,this.ctx,b.input,b.now);if(value.status==='complete')reports.set(value.scope,value);return Response.json(value);}
  if(b.op==='construct')return Response.json(await relayAccountConstructCatalog(account,[...reports.values()],b.now));
  if(b.op==='forged')return Response.json(await relayAccountConstructCatalog(account,[b.report||{status:'complete',approved:true}],b.now));
  if(b.op==='catalog')return Response.json({catalog:[...sql.exec('SELECT name,type,tbl_name,sql FROM sqlite_master')],nativeBytes:sql.databaseSize});
  return Response.json({status:'blocked'});
 }
}
export default {fetch(request,env){const name=new URL(request.url).pathname.split('/')[1];return env[name==='allocator'?'ACCOUNT':'SOURCE'].get(env[name==='allocator'?'ACCOUNT':'SOURCE'].idFromName('fictional-'+name)).fetch(request);}};
`;
async function local(t){
 const bundle=await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'fictional-paid-migration.js'},bundle:true,write:false,format:'esm',platform:'browser',external:['node:crypto']});
 let egress=0;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:configuration.compatibility_date,compatibilityFlags:configuration.compatibility_flags||[],cf:false,telemetry:{enabled:false},durableObjects:{ACCOUNT:{className:'AllocatorFixture',useSQLite:true},SOURCE:{className:'SourceFixture',useSQLite:true}},outboundService(){egress++;throw Error('Closed fictional network');}}));
 t.after(async()=>{await mf.dispose();assert.equal(egress,0);});
 const call=async(path,b)=>{const r=await mf.dispatchFetch('https://local.test/'+path,{method:'POST',body:JSON.stringify({...b,...(b.now===undefined?{}:{now:Math.max(b.now,Date.now())})})});assert.equal(r.status,200);return r.json();};
 return call;
}
async function setup(call){
 const now=Date.now(),day=new Date(now).toISOString().slice(0,10),id=await call('source',{op:'identity'});
 const evidence={plan:'workers-paid',utcDay:day,windowStart:Date.parse(day+'T00:00:00Z'),capturedAt:now,account:{rowsRead:{used:10000,limit:5000000},rowsWritten:{used:1000,limit:2000000},storedBytes:{used:10000000,limit:5000000000}},namespace:{binding:'HUBS',rowsRead:1000,rowsWritten:100,storedBytes:1000000},perObjectStoredBytesLimit:1000000000};
 const reserve={rowsRead:100000,rowsWritten:10000,storedBytes:10000000},preparation={rowsRead:200000,rowsWritten:6400,storedBytes:100*1048576};
 const plan={v:1,planId:'fictional-routing',day,...id.runtime,account:{identityHash:'a'.repeat(64),evidenceHash:createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),capturedAt:now,used:{rowsRead:10000,rowsWritten:1000,storedBytes:10000000},limit:{rowsRead:5000000,rowsWritten:2000000,storedBytes:5000000000}},scopes:[{id:'fictional-source',identityHash:id.scopeHash,preparation,ordinary:reserve}],coordination:{maxReservations:100,maxRejections:16,storedBytes:1048576},final:{construction:{rowsRead:1000000,rowsWritten:1000000,storedBytes:1000000000}}};
 assert.equal((await call('allocator',{op:'provision',plan,now})).status,'provisioned');
 await call('source',{op:'seed'});
 const input={action:'start',runId:'fictional-preparation',scope:'fictional-source',expectedRevision:null,batchSize:250,evidence,reserve,allocations:[{scope:'fictional-source',...preparation}],coordination:{planId:plan.planId,maxReservations:100,maxRejections:16,rowsRead:10000,rowsWritten:1000,storedBytes:1048576}};
 return {now,input};
}
async function complete(call,c){let result;for(let n=0;n<40;n++){result=await call('source',{op:'prepare',input:c.input,now:c.now});assert.notEqual(result.status,'blocked',JSON.stringify(result));if(result.status==='complete')return result;c.input={...c.input,action:'continue',expectedRevision:result.revision};}assert.fail('Preparation did not finish within paid bounded steps');}

test('forged allocator/report authority denies before any native context access',async()=>{
 const ctx={get storage(){assert.fail('No source storage access');}};
 assert.equal((await relayAccountPrepare({reserve:()=>({status:'granted'})},ctx,{},Date.now())).status,'blocked');
 assert.equal((await relayAccountConstructCatalog({},[{status:'complete',approved:true}],Date.now())).status,'blocked');
});
test('genuine allocator with fictional external KV funds native source preparation and final schema construction',async t=>{
 const call=await local(t),c=await setup(call),report=await complete(call,c);
 assert.equal(report.status,'complete');assert.ok(report.paidReservationId);assert.ok(report.native.rowsRead<=2000);assert.ok(report.native.rowsWritten<=64);
 const state=await call('allocator',{op:'inspect',now:c.now});assert.ok(state.counters.reservations>1);assert.ok(state.spent.rowsRead>=2000*state.counters.reservations);
 const final=await call('source',{op:'construct',now:c.now});assert.equal(final.status,'schema_constructed',JSON.stringify(final));assert.equal(final.dataBackfill,'pending');assert.equal(final.ordinaryTransport,'blocked');t.diagnostic(JSON.stringify({fictional:true,preparation:{rowsRead:report.native.rowsRead,rowsWritten:report.native.rowsWritten,paidAttempts:report.admission.attempt},construction:final.native,constructionReserved:report.estimate.total}));
 const actual=await call('source',{op:'catalog'});for(const item of [...CATALOG.tables,...CATALOG.indices,...CATALOG.triggers])assert.ok(actual.catalog.some(row=>row.name===item.name&&row.type===item.type),item.name);
 const again=await call('source',{op:'construct',now:c.now});assert.equal(again.status,'blocked');
});
test('native forged complete report and changed source cannot unlock final candidate DDL',async t=>{
 const call=await local(t),c=await setup(call);await complete(call,c);
 assert.equal((await call('source',{op:'forged',now:c.now})).reason,'account_final_report_unattested');
 await call('source',{op:'drift'});
 const final=await call('source',{op:'construct',now:c.now});assert.equal(final.status,'blocked');
 const actual=await call('source',{op:'catalog'});assert.equal(actual.catalog.some(row=>row.name==='relay_event_kind_seq'),false);
});
test('exact wrapper identity covers new admission/ingress bytes without changing SQL schema basis',async()=>{
 assert.equal(CATALOG.schemaBasis.sourceCommit,CATALOG.sourceCommit);assert.equal(CATALOG.schemaBasis.candidateCommit,CATALOG.candidateCommit);
 for(const [path,digest] of Object.entries(CATALOG.sourceFiles))assert.equal(createHash('sha256').update(readFileSync(new URL('../'+path,import.meta.url))).digest('hex'),digest,path);
 const id=await relayAccountRuntimeIdentity();assert.match(id.sourceHash,/^[a-f0-9]{64}$/);assert.match(id.catalogHash,/^[a-f0-9]{64}$/);
 assert.equal(CATALOG.tables.length,36);assert.equal(CATALOG.indices.length,20);assert.equal(CATALOG.triggers.length,20);
});

test('lost preparation acknowledgement spends once; restart reloads credit and resumes under fresh paid attempts',async t=>{
 const call=await local(t),c=await setup(call);await call('allocator',{op:'lose'});
 const lost=await call('source',{op:'prepare',input:c.input,now:c.now});assert.equal(lost.status,'blocked');assert.equal(lost.native.rowsRead,0);assert.equal(lost.native.rowsWritten,0);
 const first=await call('allocator',{op:'inspect',now:c.now});assert.equal(first.counters.reservations,1);assert.equal(first.spent.rowsRead,2000);
 assert.equal((await call('allocator',{op:'restart',now:c.now})).status,'known');
 const recovered=await complete(call,c);assert.equal(recovered.status,'complete');assert.ok(recovered.admission.attempt>1);
 assert.equal((await call('source',{op:'forged',report:recovered,now:c.now})).reason,'account_final_report_unattested');
 assert.equal((await call('source',{op:'construct',now:c.now})).status,'schema_constructed');
});
test('day rollover and account revocation refuse before source preflight or candidateDDL',async t=>{
 const call=await local(t),c=await setup(call);
 const next=await call('source',{op:'prepare',input:c.input,now:c.now+86400000});assert.equal(next.status,'blocked');assert.equal(next.native.rowsRead,0);
 assert.equal((await call('allocator',{op:'revoke',now:c.now})).status,'revoked');
 const revoked=await call('source',{op:'prepare',input:c.input,now:c.now});assert.equal(revoked.status,'blocked');assert.equal(revoked.native.rowsRead,0);assert.equal(revoked.native.rowsWritten,0);
 const actual=await call('source',{op:'catalog'});assert.equal(actual.catalog.some(row=>row.name==='relay_event_kind_seq'||row.name==='relay_migration_preflight'),false);
});


test('elapsed reservation latency refuses expired preparation receipt, evidence and UTC day before native SQL',async t=>{
 for(const advance of [31001,300001,86400000]){
  const call=await local(t),c=await setup(call);await call('allocator',{op:'delay',method:'prepare',advance});
  const result=await call('source',{op:'prepare',input:c.input,now:c.now});
  assert.equal(result.status,'blocked');assert.equal(result.native.rowsRead,0);assert.equal(result.native.rowsWritten,0);
  const actual=await call('source',{op:'catalog'});assert.equal(actual.catalog.some(row=>row.name==='relay_migration_preflight'),false);
 }
});
test('elapsed final reservation latency cannot reach candidate construction SQL',async t=>{
 const call=await local(t),c=await setup(call);await complete(call,c);
 await call('allocator',{op:'delay',method:'final',advance:31001});
 const result=await call('source',{op:'construct',now:c.now});
 assert.equal(result.status,'blocked');assert.equal(result.reason,'account_final_reservation_unavailable');
 assert.equal(result.native.rowsRead,0);assert.equal(result.native.rowsWritten,0);
 const actual=await call('source',{op:'catalog'});assert.equal(actual.catalog.some(row=>row.name==='relay_event_kind_seq'),false);
});
