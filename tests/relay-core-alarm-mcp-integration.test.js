import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayFixture} from './relay-fixture.js';
import {Hub} from '../backend/worker.js';
import {sharedStore,SHARED_OBJECT} from '../backend/shared.js';
import {publicationSchema,COMMENTS_URL,nextPublicationReconciliationAt} from '../backend/publications.js';
import {relayOAuthStore} from '../backend/relay-oauth.js';
import {relayOwnerSchema} from '../backend/relay-owner.js';
import {relaySubscribe,relayUnsubscribe,scheduleRelayAlarm,drainRelayOutbox,enqueueRelayOwnerMessage} from '../backend/relay-events.js';
import {PUBLIC_RESULT_EVENT} from '../backend/public-coordination-tools.js';
import {RELAY_ALARM_RETRY_MS,RELAY_PRECOMMIT_EXPIRY_MS} from '../backend/relay-core-alarm.js';
import {RELAY_VERSION,RELAY_INBOX,RELAY_OWNER,RELAY_OWNER_SCOPE,RELAY_OWNER_INBOX,RELAY_OWNER_EVENT,RELAY_EVENT,RELAY_CALLBACK,random,hash,challenge} from '../backend/relay-common.js';

const uuid=()=>crypto.randomUUID(),stamp='2026-10-08T00:00:00Z';
const meta={'io.modelcontextprotocol/protocolVersion':RELAY_VERSION,'io.modelcontextprotocol/clientCapabilities':{}};
const comment=(payload,id)=>({id,user:{id:183016859},body:JSON.stringify(payload),created_at:stamp,updated_at:stamp});
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function grant(f,scope='relay:read relay:reply relay:events') {
  const client=random(),grantId=random(),code=random(),access=random(),accessHash=await hash(access),resource=f.env.RELAY_MCP_ORIGIN+'/relay/mcp';
  const registry=async body=>{const response=await relayOAuthStore(f.ctx,body);assert.equal(response.status,200);return response.json();};
  await registry({op:'put',key:'client:'+client,category:'client',value:{redirect:RELAY_CALLBACK},expiresAt:Date.now()+600000});
  const params={client_id:client,redirect_uri:RELAY_CALLBACK,code_challenge:await challenge(random()),scope};
  await registry({op:'authorize',grantId,codeKey:'code:'+await hash(code),params,resource});
  await registry({op:'exchange',key:'code:'+await hash(code),match:{client_id:client,redirect_uri:RELAY_CALLBACK,challenge:params.code_challenge,resource},accessKey:'access:'+accessHash,refreshKey:'refresh:'+await hash(random())});
  return {principal:RELAY_OWNER,grantId,scopes:scope.split(' '),accessHash,access,client,registry};
}
function fixture(t,{env={},response=async()=>Response.json([])}={}) {
  const clock={now:Date.now()};t.mock.method(Date,'now',()=>clock.now);
  const calls=[],state={response};
  const publicationFetcher=async(url,init={})=>{
    assert.equal(new URL(url).origin+new URL(url).pathname,COMMENTS_URL);
    assert.equal(init.method||'GET','GET');assert.equal(init.redirect,'manual');
    assert.equal(init.headers.Authorization,undefined);assert.equal(init.headers.Cookie,undefined);
    calls.push({url,at:clock.now});return state.response(url,init);
  };
  const f=createRelayFixture({env:{RELAY_OWNER_ENABLED:'true',...env},publicationFetcher});t.after(()=>f.close());
  const object=f.object(SHARED_OBJECT),ctx=object.ctx;
  const rpc=(auth,method,params={})=>f.request('/relay/mcp',{method:'POST',headers:{Authorization:'Bearer '+auth.access,
    'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':RELAY_VERSION,'Mcp-Method':method,
    ...(method==='tools/call'?{'Mcp-Name':params.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:meta}})});
  return {...f,...object,clock,calls,state,publicationFetcher,rpc,rows:(query,...values)=>[...ctx.storage.sql.exec(query,...values)],
    tool:async(auth,name,args)=>{const response=await rpc(auth,'tools/call',{name,arguments:args});assert.equal(response.status,200);return response.json();},
    add:(body='Fictional public request',id=uuid())=>{assert.equal(sharedStore(ctx,'/internal/shared/message',{id,body}).status,201);return id;},
    restart(){const hub=new Hub({storage:ctx.storage},f.env,{publicationFetcher});object.hub=hub;return hub;}};
}
function localTransport(t,deliveries=[]) {
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'https://transport.example.test/fixed');
    const envelope=JSON.parse(init.body),body=JSON.parse(envelope.body);
    if(body.type==='verification')return Response.json({status:200,body:JSON.stringify({challenge:body.challenge})});
    deliveries.push(body);return Response.json({status:204,body:''});
  });
}
const delivery={mode:'webhook',url:'https://callback.example.test/fictional',secret:'whsec_'+Buffer.alloc(32,17).toString('base64')};
const transportEnv={RELAY_WEBHOOK_EGRESS_URL:'https://transport.example.test/fixed',RELAY_WEBHOOK_EGRESS_TOKEN:'fictional-local-transport'};

test('a first public message seeds a persisted maintenance wake and a restarted alarm imports its result without any read or hint',async t=>{
  const requestId=uuid(),replyId=uuid(),f=fixture(t,{response:async()=>Response.json([comment({schema:'jarvis-publication-v1',
    id:replyId,type:'reply',replyTo:requestId,body:'Fictional final found by maintenance'},41)])});
  const created=await f.request('/shared/messages',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id:requestId,body:'Fictional first public message'})});
  assert.equal(created.status,201);assert.equal(f.calls.length,0,'Public writes seed a wake without performing an importer fetch');
  const due=await f.ctx.storage.getAlarm();assert.equal(due,f.clock.now+300000);
  f.clock.now+=1000;
  assert.equal((await f.request('/shared/messages',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id:uuid(),body:'Fictional later public message'})})).status,201);
  assert.equal(await f.ctx.storage.getAlarm(),due,'Repeated writes cannot postpone the first reconciliation');
  f.clock.now=due;await f.restart().alarm();
  assert.equal(f.calls.length,1);
  assert.equal(f.rows('SELECT id,body FROM shared_entries WHERE reply_to=?',requestId)[0].id,replyId);
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_events WHERE message_id=?',requestId)[0].n,1);
  assert.ok(await f.ctx.storage.getAlarm()>due);
});

test('actual MCP-only reads recover a hidden final and a restarted alarm imports an artifact without a browser',async t=>{
  const deliveries=[];localTransport(t,deliveries);
  const f=fixture(t,{env:transportEnv}),auth=await grant(f),requestId=f.add(),hold=uuid(),late=uuid();
  sharedStore(f.ctx,'/internal/shared/reply',{id:hold,replyTo:requestId,body:'Fictional immutable hold'});publicationSchema(f.ctx);
  f.ctx.storage.sql.exec('INSERT INTO imported_comments VALUES(?,?,2,?)',11,JSON.stringify({id:late,type:'reply',replyTo:requestId,
    body:'Fictional previously hidden final https://example.test/hidden',createdAt:stamp}),'Conflicting publication; original kept');
  const first=await f.tool(auth,'relay_read_public_result',{inbox_id:RELAY_INBOX,message_id:requestId});
  assert.equal(first.error,undefined);assert.equal(first.result.structuredContent.reply.id,hold);
  assert.equal(first.result.structuredContent.events[0].eventId,late);assert.equal(first.result.structuredContent.events[0].execution_authorized,false);
  assert.equal(f.calls.length,1);
  const subscribed=await (await f.rpc(auth,'events/subscribe',{name:PUBLIC_RESULT_EVENT,arguments:{inbox_id:RELAY_INBOX,request_id:requestId},delivery})).json();
  assert.ok(subscribed.result.id);assert.equal(f.calls.length,1,'Warm subscribe joins the public reconciliation lane');
  const artifact={schema:'jarvis-coordination-v2',eventId:uuid(),requestId,attemptId:uuid(),stage:'final',resultVersion:1,
    body:'Fictional later artifact report',artifacts:[{id:uuid(),revision:1,label:'Fictional artifact',url:'https://example.test/artifact'}]};
  f.state.response=async()=>Response.json([comment(artifact,12)]);
  const persisted=await f.ctx.storage.getAlarm();assert.ok(persisted>f.clock.now);
  const restarted=f.restart();let wakes=0;
  while(f.calls.length<2&&wakes++<20){const next=await f.ctx.storage.getAlarm();assert.ok(next>f.clock.now);f.clock.now=next;await restarted.alarm();}
  assert.equal(f.calls.length,2);assert.equal(deliveries.length,1);assert.equal(deliveries[0].name,PUBLIC_RESULT_EVENT);
  assert.equal(deliveries[0].data.should_execute,false);assert.equal(deliveries[0].data.execution_authorized,false);
  assert.equal(f.rows('SELECT body FROM shared_entries WHERE reply_to=?',requestId)[0].body,'Fictional immutable hold');
  const result=await f.tool(auth,'relay_read_public_result',{inbox_id:RELAY_INBOX,message_id:requestId});
  assert.deepEqual(result.result.structuredContent.events.map(item=>item.eventId),[late,artifact.eventId]);
  assert.equal(result.result.structuredContent.events.at(-1).artifacts[0].url,'https://example.test/artifact');
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_subscriptions')[0].n,1,'Only the explicit existing result subscription was activated');
  assert.equal(f.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='relay_owner_sessions'")[0].n,0);
});

test('concurrent authorized public MCP reads share one bounded sync and warmed polls do not rewrite alarms',async t=>{
  const entered=deferred(),resume=deferred(),f=fixture(t,{response:async()=>{entered.resolve();await resume.promise;return Response.json([]);}});
  const auth=await grant(f),requestId=f.add(),names=['relay_list_pending','relay_read_conversation','relay_read_public_changes','relay_read_public_result'];
  const args=name=>({inbox_id:RELAY_INBOX,...(['relay_read_conversation','relay_read_public_result'].includes(name)?{message_id:requestId}:{})});
  const reads=Array.from({length:24},(_,index)=>f.tool(auth,names[index%4],args(names[index%4])));
  await entered.promise;assert.equal(f.calls.length,1);resume.resolve();
  const responses=await Promise.all(reads);assert.ok(responses.every(result=>!result.error&&!result.result.isError));
  const writes=f.alarms.length;assert.ok(writes<=2,'One shared admission and one composed wake, not one per concurrent reader');
  for(let index=0;index<40;index++)assert.equal((await f.tool(auth,names[index%4],args(names[index%4]))).error,undefined);
  assert.equal(f.calls.length,1);assert.equal(f.alarms.length,writes,'Warmed reads leave an identical composed wake alone');
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')[0].n,0);
  process.stdout.write('LOCAL_FICTIONAL_CORE_CONCURRENCY '+JSON.stringify({requests:64,publicationEgress:f.calls.length,alarmSets:writes})+'\n');
});

test('private/discovery, malformed cursors/arguments, private targets and forged/revoked scope induce no public egress or migration',async t=>{
  const f=fixture(t),reader=await grant(f,'relay:read'),owner=await grant(f,RELAY_OWNER_SCOPE),requestId=f.add();
  relayOwnerSchema(f.ctx);const privateId=uuid(),privateText='Fictional private body never sent to publisher';
  f.ctx.storage.sql.exec("INSERT INTO relay_owner_entries(id,kind,body,created_at,principal,device_id,authentication_source) VALUES(?,'user',?,?,?,?,?)",
    privateId,privateText,stamp,RELAY_OWNER,'fictional-existing-device','owner-oauth-mcp');
  const snapshot=()=>['shared_entries','shared_meta','public_changes','public_coordination_events'].map(table=>f.rows('SELECT * FROM '+table));
  const before=snapshot();
  for(const method of ['server/discover','ping','tools/list','events/list'])assert.equal((await f.rpc(reader,method)).status,200);
  for(const [name,args] of [
    ['relay_list_pending',{inbox_id:RELAY_INBOX,cursor:'bad'}],
    ['relay_read_conversation',{inbox_id:RELAY_INBOX,message_id:'bad'}],
    ['relay_read_public_changes',{inbox_id:RELAY_INBOX,cursor:'pc2:999999'}],
    ['relay_read_public_changes',{inbox_id:RELAY_INBOX,limit:101}],
    ['relay_read_public_result',{inbox_id:RELAY_INBOX,message_id:requestId,cursor:'pr2:'+uuid()+':0'}],
    ['relay_read_public_result',{inbox_id:RELAY_INBOX,message_id:requestId,authority:'owner'}],
  ])assert.equal((await f.tool(reader,name,args)).error.code,-32602);
  for(const name of ['relay_read_conversation','relay_read_public_result'])assert.equal((await f.tool(reader,name,{inbox_id:RELAY_INBOX,message_id:privateId})).result.isError,true);
  assert.equal((await f.tool(owner,'relay_list_pending',{inbox_id:RELAY_INBOX})).error.code,-32012);
  assert.equal((await f.tool(owner,'relay_owner_jobs_list',{inbox_id:RELAY_OWNER_INBOX})).error,undefined);
  const forged=await f.hub.fetch(new Request('https://internal/internal/relay/rpc',{method:'POST',body:JSON.stringify({principal:{...reader,grantId:random()},
    rpc:{method:'tools/call',params:{_meta:meta,name:'relay_list_pending',arguments:{inbox_id:RELAY_INBOX}}}})}));
  assert.equal((await forged.json()).error.code,-32012);
  await reader.registry({op:'revoke',tokenHash:reader.accessHash,client_id:reader.client});
  assert.equal((await f.rpc(reader,'tools/call',{name:'relay_list_pending',arguments:{inbox_id:RELAY_INBOX}})).status,401);
  assert.equal(f.calls.length,0);assert.equal(f.alarms.length,0);assert.deepEqual(snapshot(),before);
  assert.equal(JSON.stringify(f.calls).includes(privateText),false);
});

test('live public read grant is rechecked after an awaited import revocation race',async t=>{
  const entered=deferred(),resume=deferred(),f=fixture(t,{response:async()=>{entered.resolve();await resume.promise;return Response.json([]);}});
  const auth=await grant(f,'relay:read'),requestId=f.add();
  const reading=f.tool(auth,'relay_read_public_result',{inbox_id:RELAY_INBOX,message_id:requestId});
  await entered.promise;await auth.registry({op:'revoke',tokenHash:auth.accessHash,client_id:auth.client});resume.resolve();
  const response=await reading;assert.equal(response.error.code,-32012);assert.equal(response.result,undefined);
  assert.equal(f.calls.length,1);assert.ok(await f.ctx.storage.getAlarm(),'Public durable work retains its own wake after the reader is revoked');
});

test('publisher429 survives restart without read or alarm egress before shared backoff',async t=>{
  const f=fixture(t,{response:async()=>Response.json({},{status:429,headers:{'retry-after':'900'}})}),auth=await grant(f,'relay:read');
  const first=await f.tool(auth,'relay_list_pending',{inbox_id:RELAY_INBOX});assert.equal(first.error,undefined);assert.equal(f.calls.length,1);
  const backoff=JSON.parse(f.rows("SELECT value FROM shared_meta WHERE key='publisher-upstream-not-before'")[0].value);
  for(let index=0;index<20;index++)assert.equal((await f.tool(auth,'relay_list_pending',{inbox_id:RELAY_INBOX})).error,undefined);
  assert.equal(f.calls.length,1);
  const restarted=f.restart();let wakes=0;
  while((await f.ctx.storage.getAlarm())<backoff&&wakes<20){
    const next=await f.ctx.storage.getAlarm();assert.ok(next>=f.clock.now+1000,'Backoff has no rapid empty alarm loop');f.clock.now=next;await restarted.alarm();wakes++;
  }
  assert.ok(wakes<20);assert.equal(f.calls.length,1);
  f.clock.now=await f.ctx.storage.getAlarm();f.state.response=async()=>Response.json([]);await restarted.alarm();
  assert.equal(f.calls.length,2);assert.ok(f.clock.now>=backoff);
});

test('nested subscription, retry and unsubscribe scheduling retain an earlier publication due time',async t=>{
  const f=fixture(t),auth=await grant(f),requestId=f.add();
  await f.tool(auth,'relay_read_conversation',{inbox_id:RELAY_INBOX,message_id:requestId});
  const publicAt=nextPublicationReconciliationAt(f.ctx,f.clock.now);assert.ok(publicAt>f.clock.now);
  const params={name:RELAY_EVENT,arguments:{inbox_id:RELAY_INBOX},delivery,cursor:'relay1:0'};
  const receiver=async(_url,init)=>Response.json({challenge:JSON.parse(init.body).challenge});
  const sub=await relaySubscribe(f.ctx,auth,params,f.env,receiver,f.clock.now);
  f.ctx.storage.sql.exec("UPDATE relay_outbox SET next_attempt_ms=? WHERE subscription_id=?",publicAt+600000,sub.id);
  await scheduleRelayAlarm(f.ctx,f.clock.now);assert.equal(await f.ctx.storage.getAlarm(),publicAt);
  await relaySubscribe(f.ctx,auth,params,f.env,receiver,f.clock.now);assert.equal(await f.ctx.storage.getAlarm(),publicAt);
  await relayUnsubscribe(f.ctx,auth,{name:params.name,arguments:params.arguments,delivery:{mode:'webhook',url:delivery.url}},f.clock.now,f.env);
  assert.equal(await f.ctx.storage.getAlarm(),publicAt);
});

test('actual worker precommit wake survives a fired alarm, late message commit, rejected reschedule and restart',async t=>{
  const f=fixture(t),entered=deferred(),set=f.ctx.storage.setAlarm,requestId=uuid();let controller;
  publicationSchema(f.ctx);
  f.ctx.storage.setAlarm=async value=>{await set(value);entered.resolve();};
  const body=new ReadableStream({start(value){controller=value;value.enqueue(new TextEncoder().encode('{"id":"'+requestId+'","body":"Fictional held'))}});
  const saving=f.hub.fetch(new Request('https://internal/internal/shared/message',{method:'POST',body,duplex:'half'}));
  await entered.promise;const first=await f.ctx.storage.getAlarm();f.clock.now=first;await f.hub.alarm();
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM shared_entries')[0].n,0,'The original request is still held before commit');
  const recovery=await f.ctx.storage.getAlarm();assert.ok(recovery>=first+RELAY_ALARM_RETRY_MS);
  assert.ok(recovery<=first+RELAY_PRECOMMIT_EXPIRY_MS);
  f.ctx.storage.setAlarm=async()=>{throw Error('Fictional late reschedule rejection');};
  controller.enqueue(new TextEncoder().encode(' before commit"}'));controller.close();
  assert.equal((await saving).status,201);assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_events')[0].n,1);
  assert.equal(await f.ctx.storage.getAlarm(),recovery);
  f.ctx.storage.setAlarm=set;f.clock.now=recovery;await f.restart().alarm();
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM shared_entries WHERE id=?',requestId)[0].n,1);
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_events WHERE message_id=?',requestId)[0].n,1);
  const next=await f.ctx.storage.getAlarm();assert.ok(next>f.clock.now,'Restart repairs the independent reconciliation wake');
  if(!f.calls.length){f.clock.now=next;await f.object(SHARED_OBJECT).hub.alarm();}
  assert.equal(f.calls.length,1,'The surviving wake reaches the late committed publication lane');
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM shared_entries WHERE id=?',requestId)[0].n,1);
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_events WHERE message_id=?',requestId)[0].n,1);
});

test('a body held beyond admission expiry fails before message or hint mutation and a stable-ID retry re-admits once',async t=>{
  let hintEgress=0;t.mock.method(globalThis,'fetch',async()=>{hintEgress++;throw Error('Expired fictional hint must not fetch');});
  for(const path of ['/shared/messages','/shared/import-hint']){
    const f=fixture(t),requestId=uuid(),entered=deferred(),set=f.ctx.storage.setAlarm;let controller,hold=true;
    publicationSchema(f.ctx);
    f.ctx.storage.setAlarm=async value=>{await set(value);entered.resolve();};
    const payload=path==='/shared/messages'?{id:requestId,body:'Fictional expired admission'}:{commentId:42};
    const encoded=JSON.stringify(payload),body=new ReadableStream({start(value){controller=value;value.enqueue(new TextEncoder().encode(encoded.slice(0,-1)));}});
    const fetch=f.hub.fetch.bind(f.hub);
    t.mock.method(f.hub,'fetch',request=>{
      if(hold&&new URL(request.url).pathname.startsWith('/internal/shared/')){
        hold=false;return fetch(new Request(request,{body,duplex:'half'}));
      }
      return fetch(request);
    });
    const saving=f.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:encoded});
    await entered.promise;f.clock.now=await f.ctx.storage.getAlarm();await f.hub.alarm();
    f.clock.now=await f.ctx.storage.getAlarm();await f.hub.alarm();
    assert.equal(await f.ctx.storage.getAlarm(),null,'Abandoned admission expires without renewing an empty wake');
    controller.enqueue(new TextEncoder().encode('}'));controller.close();
    assert.equal((await saving).status,503);
    assert.equal(f.rows('SELECT COUNT(*) AS n FROM shared_entries')[0].n,0);
    assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_events')[0].n,0);
    assert.equal(f.rows('SELECT COUNT(*) AS n FROM imported_comments')[0].n,0);
    assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')[0].n,0);
    assert.equal(f.calls.length,0);assert.equal(hintEgress,0,'Expired hint admission is rejected before importer fetch');
    if(path==='/shared/messages'){
      assert.equal((await f.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:encoded})).status,201);
      assert.equal((await f.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:encoded})).status,200);
      assert.equal(f.rows('SELECT COUNT(*) AS n FROM shared_entries WHERE id=?',requestId)[0].n,1);
      assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_events WHERE message_id=?',requestId)[0].n,1);
      assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')[0].n,0);
    }
  }
});

test('authenticated private conversation exposes only transport route diagnostics in the existing lifecycle block',async t=>{
  const f=fixture(t),auth=await grant(f,RELAY_OWNER_SCOPE),messageId=uuid(),body='Fictional private route body';
  relayOwnerSchema(f.ctx);
  f.ctx.storage.sql.exec("INSERT INTO relay_owner_entries(id,kind,body,created_at,principal,device_id,authentication_source) VALUES(?,'user',?,?,?,?,?)",
    messageId,body,stamp,RELAY_OWNER,'fictional-existing-device','owner-oauth-mcp');
  enqueueRelayOwnerMessage(f.ctx,{id:messageId,body,createdAt:stamp,device_id:'fictional-existing-device'});
  const receiver=async(_url,init)=>Response.json({challenge:JSON.parse(init.body).challenge});
  await relaySubscribe(f.ctx,auth,{name:RELAY_OWNER_EVENT,arguments:{inbox_id:RELAY_OWNER_INBOX},delivery,cursor:'relay1:0'},f.env,receiver,f.clock.now);
  await drainRelayOutbox(f.ctx,f.env,async()=>new Response('',{status:503}),f.clock.now);
  const result=(await f.tool(auth,'relay_owner_read_conversation',{inbox_id:RELAY_OWNER_INBOX,message_id:messageId})).result;
  assert.equal(result.content.length,4);assert.equal(Object.hasOwn(result.structuredContent.message,'delivery'),false);
  const label='Private job lifecycle (authenticated server evidence; callback acceptance never establishes execution): ';
  const lifecycle=JSON.parse(result.content[3].text.slice(label.length));
  assert.equal(lifecycle.deliveryRoute.state,'retrying');assert.equal(lifecycle.deliveryRoute.lastError,'http_503');
  assert.equal(lifecycle.deliveryRoute.callbackAccepted,false);assert.equal(lifecycle.execution,null);assert.equal(lifecycle.completion,null);
  assert.match(lifecycle.deliveryRouteMeaning,/Transport route evidence only/);
  for(const secret of [body,auth.access,auth.accessHash,auth.grantId,delivery.url,delivery.secret])assert.equal(JSON.stringify(lifecycle).includes(secret),false);
  f.clock.now=Date.parse(lifecycle.deliveryRoute.nextAttemptAt);
  await drainRelayOutbox(f.ctx,f.env,async()=>new Response(null,{status:204}),f.clock.now);
  const readLifecycle=async()=>{
    const result=(await f.tool(auth,'relay_owner_read_conversation',{inbox_id:RELAY_OWNER_INBOX,message_id:messageId})).result;
    assert.equal(result.content.length,4);return JSON.parse(result.content[3].text.slice(label.length));
  };
  const accepted=await readLifecycle();assert.equal(accepted.deliveryRoute.state,'callback_accepted');
  assert.equal(accepted.deliveryRoute.callbackAccepted,true);assert.equal(accepted.execution,null);assert.equal(accepted.completion,null);
  const replacement={...delivery,url:'https://replacement.example.test/fictional'};
  const sub=await relaySubscribe(f.ctx,auth,{name:RELAY_OWNER_EVENT,arguments:{inbox_id:RELAY_OWNER_INBOX},delivery:replacement,cursor:'relay1:0'},f.env,receiver,f.clock.now);
  f.ctx.storage.sql.exec("UPDATE relay_outbox SET status='failed',attempts=6,last_error='http_503' WHERE subscription_id=?",sub.id);
  f.ctx.storage.sql.exec("UPDATE relay_subscriptions SET state='delivery_failed' WHERE id=?",sub.id);
  const exhausted=await readLifecycle();assert.equal(exhausted.deliveryRoute.state,'exhausted');assert.equal(exhausted.deliveryRoute.retryable,true);
  assert.equal((await f.tool(auth,'relay_owner_reply',{inbox_id:RELAY_OWNER_INBOX,message_id:messageId,body:'Fictional immutable private reply'})).result.isError,false);
  const replied=await readLifecycle();assert.equal(replied.deliveryRoute.retryable,false);assert.equal(replied.deliveryRoute.retryAfter,null);
  assert.equal(replied.deliveryRoute.callbackAccepted,true);assert.equal(replied.execution,null);assert.equal(replied.completion,null);
  for(const secret of [body,'Fictional immutable private reply',auth.access,auth.accessHash,auth.grantId,delivery.url,delivery.secret,replacement.url])
    assert.equal(JSON.stringify(replied).includes(secret),false);
  assert.equal(f.calls.length,0,'Private route reads never start the publisher');
});

test('an interrupted alarm keeps a bounded retry and later clears expired recovery reservations',async t=>{
  const f=fixture(t);publicationSchema(f.ctx);
  const exec=f.ctx.storage.sql.exec;
  f.ctx.storage.sql.exec=(query,...values)=>{if(query==='SELECT * FROM relay_subscriptions')throw Error('Fictional alarm interruption');return exec(query,...values);};
  await assert.rejects(f.hub.alarm(),/Fictional alarm interruption/);
  const retry=await f.ctx.storage.getAlarm();assert.ok(retry>=f.clock.now+RELAY_ALARM_RETRY_MS);
  f.ctx.storage.sql.exec=exec;f.clock.now=retry;const restarted=f.restart();await restarted.alarm();
  const expiry=await f.ctx.storage.getAlarm();assert.ok(expiry>retry+1000,'Abandoned recovery does not create a rapid no-work loop');
  f.clock.now=expiry;await restarted.alarm();assert.equal(await f.ctx.storage.getAlarm(),null);
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')[0].n,0);
});
