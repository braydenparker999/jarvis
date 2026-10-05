import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayFixture} from './relay-fixture.js';
import {relayOAuthStore} from '../backend/relay-oauth.js';
import {relayRpc} from '../backend/relay-connector.js';
import {relayOwnerRpc} from '../backend/relay-owner.js';
import {relaySubscribe,drainRelayOutbox} from '../backend/relay-events.js';
import {sharedStore,SHARED_OBJECT} from '../backend/shared.js';
import {PRIMARY_SITE} from '../backend/origins.js';
import {RELAY_OWNER,RELAY_CALLBACK,RELAY_PUBLIC_SCOPES,RELAY_OWNER_SCOPE,RELAY_OWNER_INBOX,RELAY_OWNER_EVENT,RELAY_INBOX,RELAY_EVENT,RELAY_VERSION,random,hash,challenge} from '../backend/relay-common.js';

async function grant(s,scope=RELAY_PUBLIC_SCOPES.join(' ')){
  const ctx=s.object(SHARED_OBJECT).ctx,client=random(),grantId=random(),verifier=random(),code=random(),access=random(),refresh=random();
  const registry=b=>relayOAuthStore(ctx,b).json(),resource=s.env.RELAY_MCP_ORIGIN+'/relay/mcp';
  await registry({op:'put',key:'client:'+client,category:'client',value:{redirect:RELAY_CALLBACK},expiresAt:Date.now()+600000});
  const params={client_id:client,redirect_uri:RELAY_CALLBACK,code_challenge:await challenge(verifier),scope};
  await registry({op:'authorize',grantId,codeKey:'code:'+await hash(code),params,resource});
  const accessHash=await hash(access);
  await registry({op:'exchange',key:'code:'+await hash(code),match:{client_id:client,redirect_uri:RELAY_CALLBACK,challenge:params.code_challenge,resource},accessKey:'access:'+accessHash,refreshKey:'refresh:'+await hash(refresh)});
  return {principal:RELAY_OWNER,grantId,scopes:scope.split(' '),accessHash,access,refresh,client,registry,resource};
}
function fixture(t){
  const s=createRelayFixture({env:{RELAY_OWNER_ENABLED:'true'}});t.after(()=>s.close());
  s.ctx=s.object(SHARED_OBJECT).ctx;
  s.rows=(q,...v)=>[...s.ctx.storage.sql.exec(q,...v)];
  s.phone=(path,body,token)=>s.request('/relay/owner'+path,{method:body===undefined?'GET':'POST',headers:{Origin:PRIMARY_SITE,...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  s.rpc=(auth,method,p={})=>s.request('/relay/mcp',{method:'POST',headers:{Authorization:'Bearer '+auth.access,Accept:'application/json, text/event-stream','Content-Type':'application/json','MCP-Protocol-Version':RELAY_VERSION,'Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':p.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...p,_meta:{'io.modelcontextprotocol/protocolVersion':RELAY_VERSION,'io.modelcontextprotocol/clientCapabilities':{}}}})}).then(r=>r.json());
  return s;
}
async function pair(s,auth,label){
  const response=await s.phone('/pair/start',{label});assert.equal(response.status,201);
  const pending=await response.json();
  const inspect=await relayOwnerRpc(s.ctx,s.env,auth,'relay_owner_pairing_inspect',{code:pending.code});
  assert.equal(inspect.request_id,pending.request_id);
  await relayOwnerRpc(s.ctx,s.env,auth,'relay_owner_pairing_approve',{request_id:pending.request_id,code:pending.code,access_days:365,confirm:true});
  const status=await (await s.phone('/pair/status',{request_id:pending.request_id},pending.device_token)).json();
  assert.equal(status.status,'approved');return {...pending,device:status.device};
}
const receiver=async (_url,init)=>{const body=JSON.parse(init.body);return body.type==='verification'?Response.json({challenge:body.challenge}):new Response(null,{status:204});};
const subscription=(name,inbox_id,url)=>({name,arguments:{inbox_id},delivery:{mode:'webhook',url,secret:'whsec_'+Buffer.alloc(32,17).toString('base64')},cursor:'relay1:0'});

test('owner capability is explicit, default challenge stays public and old grants never expand',async t=>{
  const s=fixture(t),ordinary=await grant(s),owner=await grant(s,RELAY_OWNER_SCOPE);
  const unauth=await s.request('/relay/mcp');assert.match(unauth.headers.get('WWW-Authenticate'),/scope="relay:read relay:reply relay:events"/);assert.doesNotMatch(unauth.headers.get('WWW-Authenticate'),/relay:owner/);
  const publicTools=(await s.rpc(ordinary,'tools/list')).result.tools;
  assert.equal(publicTools.length,3);assert.ok(publicTools.every(x=>!x.name.startsWith('relay_owner_')));
  assert.equal((await s.rpc(owner,'tools/list')).result.tools.length,7);
  assert.deepEqual((await s.rpc(owner,'events/list')).result.events.map(x=>x.name),[RELAY_OWNER_EVENT]);
  await assert.rejects(relayOwnerRpc(s.ctx,s.env,ordinary,'relay_owner_devices_list',{}),e=>e.code===-32012);
  const widened=await ordinary.registry({op:'exchange',key:'refresh:'+await hash(ordinary.refresh),match:{client_id:ordinary.client,resource:ordinary.resource},scope:ordinary.scopes.join(' ')+' '+RELAY_OWNER_SCOPE,accessKey:'access:'+await hash(random()),refreshKey:'refresh:'+await hash(random())});
  assert.deepEqual(widened,{});
  const stored=s.rows('SELECT value FROM relay_oauth WHERE key=?','grant:'+ordinary.grantId)[0];assert.equal(JSON.parse(stored.value).scope,ordinary.scopes.join(' '));
  s.env.RELAY_OWNER_ENABLED='false';
  assert.equal((await s.rpc(owner,'tools/list')).result.tools.length,0);
  assert.deepEqual((await s.rpc(owner,'events/list')).result.events,[]);
  assert.equal((await s.phone('/pair/start',{label:'Disabled'})).status,503);
});

test('two phone sessions and private replies stay isolated from all public reads/tools',async t=>{
  const s=fixture(t),owner=await grant(s,RELAY_OWNER_SCOPE),ordinary=await grant(s),a=await pair(s,owner,'Unrestricted phone'),b=await pair(s,owner,'Main phone');
  assert.notEqual(a.device_token,b.device_token);assert.notEqual(a.device.id,b.device.id);
  const id=crypto.randomUUID(),body='Private owner text never goes to public Relay';
  assert.equal((await s.phone('/messages',{id,body,principal:RELAY_OWNER,author_authenticated:true},a.device_token)).status,400);
  const inserted=await s.phone('/messages',{id,body},a.device_token);assert.equal(inserted.status,201);
  const entry=(await inserted.json()).entry;assert.equal(entry.author_authenticated,true);assert.equal(entry.device_id,a.device.id);assert.equal(entry.authentication_source,'owner-device-session');
  const publicState=await sharedStore(s.ctx,'/internal/shared/state').json();assert.ok(!JSON.stringify(publicState).includes(body));
  const publicRead=await relayRpc(s.ctx,s.env,ordinary,{method:'tools/call',params:{_meta:{},name:'relay_read_conversation',arguments:{inbox_id:RELAY_INBOX,message_id:id}}});assert.equal(publicRead.isError,true);
  const publicReply=await relayRpc(s.ctx,s.env,ordinary,{method:'tools/call',params:{_meta:{},name:'relay_reply',arguments:{inbox_id:RELAY_INBOX,message_id:id,body:'Wrong channel'}}});assert.equal(publicReply.isError,true);
  const reply=await s.rpc(owner,'tools/call',{name:'relay_owner_reply',arguments:{inbox_id:RELAY_OWNER_INBOX,message_id:id,body:'Private answer'}});assert.equal(reply.result.structuredContent.visibility,'private');
  const both=await (await s.phone('/messages',undefined,b.device_token)).json();assert.equal(both.messages.length,2);assert.equal(both.messages[1].body,'Private answer');
  const anonymous=await s.phone('/messages');assert.equal(anonymous.status,401);
  assert.equal(s.rows('SELECT COUNT(*) AS n FROM shared_entries WHERE id=? OR reply_to=?',id,id)[0].n,0);
  assert.equal((await s.phone('/devices/revoke',{device_id:a.device.id},b.device_token)).status,200);
  assert.equal((await s.phone('/session',undefined,a.device_token)).status,401);
  assert.equal((await s.phone('/session',undefined,b.device_token)).status,200);
});

test('private event delivery is scoped, metadata-only, replayable and separated from public events',async t=>{
  const s=fixture(t),owner=await grant(s,RELAY_OWNER_SCOPE),ordinary=await grant(s),phone=await pair(s,owner,'Main phone');
  const pub=subscription(RELAY_EVENT,RELAY_INBOX,'https://public.example/callback'),priv=subscription(RELAY_OWNER_EVENT,RELAY_OWNER_INBOX,'https://private.example/callback');
  await assert.rejects(relaySubscribe(s.ctx,ordinary,priv,s.env,receiver),e=>e.code===-32012);
  await relaySubscribe(s.ctx,ordinary,pub,s.env,receiver);await relaySubscribe(s.ctx,owner,priv,s.env,receiver);
  // IDs can coincide across inboxes without suppressing either event.
  const id=crypto.randomUUID();sharedStore(s.ctx,'/internal/shared/message',{id,body:'Public text'});
  assert.equal((await s.phone('/messages',{id,body:'Private financial and account context'},phone.device_token)).status,201);
  const deliveries=[];await drainRelayOutbox(s.ctx,s.env,async(url,init)=>{deliveries.push({url,payload:JSON.parse(init.body)});return new Response(null,{status:204});});
  assert.equal(deliveries.length,2);
  const privateEvent=deliveries.find(x=>x.url==='https://private.example/callback').payload;
  assert.equal(privateEvent.name,RELAY_OWNER_EVENT);assert.equal(privateEvent.data.author_authenticated,true);assert.equal(privateEvent.data.principal,RELAY_OWNER);assert.equal(privateEvent.data.device_id,phone.device.id);
  assert.ok(!JSON.stringify(privateEvent).includes('financial'));assert.equal(privateEvent.data.body_preview,undefined);
  const publicEvent=deliveries.find(x=>x.url==='https://public.example/callback').payload;assert.equal(publicEvent.name,RELAY_EVENT);assert.equal(publicEvent.data.author_authenticated,false);
  const replay=subscription(RELAY_OWNER_EVENT,RELAY_OWNER_INBOX,'https://replay.example/callback');replay.arguments.message_contains='financial';
  await relaySubscribe(s.ctx,owner,replay,s.env,receiver);const replayed=[];await drainRelayOutbox(s.ctx,s.env,async(url,init)=>{replayed.push({url,payload:JSON.parse(init.body)});return new Response(null,{status:204});});
  assert.equal(replayed.length,1);assert.equal(replayed[0].payload.data.message_id,id);
});

test('owner grant revocation during signing blocks private callback transmission',async t=>{
  const s=fixture(t),owner=await grant(s,RELAY_OWNER_SCOPE),phone=await pair(s,owner,'Main phone');
  await relaySubscribe(s.ctx,owner,subscription(RELAY_OWNER_EVENT,RELAY_OWNER_INBOX,'https://private.example/callback'),s.env,receiver);
  await s.phone('/messages',{id:crypto.randomUUID(),body:'Private pending'},phone.device_token);
  const sign=crypto.subtle.sign.bind(crypto.subtle);t.mock.method(crypto.subtle,'sign',async(...args)=>{await owner.registry({op:'revoke',tokenHash:owner.accessHash,client_id:owner.client});return sign(...args);});
  let transmitted=0;await drainRelayOutbox(s.ctx,s.env,async()=>{transmitted++;return new Response(null,{status:204});});
  assert.equal(transmitted,0);assert.equal(s.rows('SELECT COUNT(*) AS n FROM relay_subscriptions')[0].n,0);
  // Explicitly approved phone access has an independent lifetime and revocation control.
  assert.equal((await s.phone('/session',undefined,phone.device_token)).status,200);
});
