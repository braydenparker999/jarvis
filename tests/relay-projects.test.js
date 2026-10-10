import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayFixture} from './relay-fixture.js';
import {projectStore, PROJECT_LIMITS} from '../backend/relay-projects.js';
import {relayOAuthStore} from '../backend/relay-oauth.js';
import {hash, RELAY_OWNER, RELAY_CALLBACK, challenge} from '../backend/relay-common.js';
import {sharedStore} from '../backend/shared.js';
import {relayOwnerSchema} from '../backend/relay-owner.js';

// Fictional, in-memory grants only. Never generates or configures a real credential.
export async function setup(t) {
  const s = createRelayFixture({env: {RELAY_PROJECT_ENABLED: 'true', RELAY_PROJECT_ADMIN_ENABLED: 'true', RELAY_OWNER_ENABLED: 'true'}});
  t.after(() => s.close());
  const {ctx, db, hub} = s.object('jarvis-shared-v2');
  const access = 'e'.repeat(64), grantId = 'fixture-owner-grant', client = 'fixture-client', resource = s.env.RELAY_MCP_ORIGIN + '/relay/mcp', scope = 'relay:read relay:reply relay:events relay:owner';
  const registry = b => relayOAuthStore(ctx, b).json();
  await registry({op:'put', key:'client:'+client, category:'client', value:{redirect:RELAY_CALLBACK}, expiresAt:Date.now()+3600000});
  const params = {client_id:client,redirect_uri:RELAY_CALLBACK,code_challenge:await challenge('fictional-code'),scope};
  await registry({op:'authorize',grantId,codeKey:'code:fixture',params,resource});
  await registry({op:'exchange',key:'code:fixture',match:{client_id:client,redirect_uri:RELAY_CALLBACK,challenge:params.code_challenge,resource},accessKey:'access:'+await hash(access),refreshKey:'refresh:fixture'});
  const principal = {principal:RELAY_OWNER,grantId,scopes:scope.split(' '),accessHash:await hash(access)};
  const tokens = {lucy:'jpi_'+'1'.repeat(64),mast:'jpi_'+'2'.repeat(64),other:'jpi_'+'3'.repeat(64)};
  const hashes = Object.fromEntries(await Promise.all(Object.entries(tokens).map(async ([name, token]) => [name, await hash(token)])));
  const grants = {};
  async function admin(args, token = access) {
    return s.request('/relay/projects/_grants', {method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args)});
  }
  for (const name of Object.keys(tokens)) {
    const args = {op:'create',grantId:crypto.randomUUID(),tokenHash:hashes[name],project:name==='other'?'other-project':'jarvis',agent:name==='other'?'lucy':name,expiresAt:new Date(Date.now()+86400000).toISOString(),confirm:true};
    grants[name] = args; assert.equal((await admin(args)).status, 200);
  }
  const call = async (op, args = {}, who = 'lucy', project = 'jarvis') => {
    const get = ['identity','messages','message','events','work'].includes(op);
    const response = await s.request(`/relay/projects/${project}/${op}`+(get&&Object.keys(args).length?'?'+new URLSearchParams(args):''), {
      method:get?'GET':'POST',headers:{Authorization:'Bearer '+tokens[who],...(get?{}:{'Content-Type':'application/json'})},...(get?{}:{body:JSON.stringify(args)})});
    return {status:response.status, data:await response.json(), headers:response.headers};
  };
  const direct = (op, args, who = 'lucy', now = Date.now(), project = 'jarvis') => projectStore(ctx,s.env,{op,args,project,tokenHash:hashes[who]},now);
  const send = (body='Task',who='lucy',extra={}) => call('send',{idempotencyKey:crypto.randomUUID(),recipient:who==='lucy'?'mast':'lucy',kind:'request',body,...extra},who);
  return {...s,ctx,db,hub,principal,registry,access,tokens,hashes,grants,admin,call,direct,send};
}
const leaseArgs = claim => ({messageId:claim.work.messageId,runId:claim.work.runId,claimId:claim.claimId,fence:claim.work.fence});
const count = (s, table) => s.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;

test('disabled default; public, owner and project credentials have distinct authority', async t => {
  const s = await setup(t);
  for (const token of [undefined,'public-browser-key',s.access]) {
    const r = await s.request('/relay/projects/jarvis/identity',{headers:token?{Authorization:'Bearer '+token}:{}});
    assert.equal(r.status,401);
  }
  assert.equal((await s.call('identity')).data.agent,'lucy');
  assert.equal((await s.call('identity')).data.authority,'project-agent');
  assert.equal((await s.admin({...s.grants.lucy},s.tokens.mast)).status,401);
  s.env.RELAY_PROJECT_ENABLED = 'false';
  assert.equal((await s.call('identity')).status,503);
  s.env.RELAY_PROJECT_ENABLED = 'true';
  assert.equal((await s.request('/relay/projects/jarvis/identity',{headers:{Origin:'https://relay.example.test',Authorization:'Bearer '+s.tokens.lucy}})).status,403);
  assert.equal((await s.request('/internal/relay/projects',{method:'POST',body:JSON.stringify({op:'identity',project:'jarvis',tokenHash:s.hashes.lucy,args:{}})})).status,404);
});

test('messages, explicit reply events, delivery ACK, claim, and result remain separate', async t => {
  const s = await setup(t), first = await s.send('Find the work'); assert.equal(first.status,200);
  const m = first.data.message;
  assert.equal(m.sender,'lucy'); assert.equal(m.recipient,'mast'); assert.equal(m.visibility,'shared-project'); assert.equal(m.content_trust,'untrusted-data');
  assert.equal((await s.call('events',{},'lucy')).data.events.length,0);
  const events = (await s.call('events',{},'mast')).data.events;
  assert.equal(events.length,1); assert.equal(events[0].name,'relay.project.message.created');
  await s.call('ack',{eventIds:events.map(e=>e.id)},'mast');
  assert.equal((await s.call('message',{messageId:m.id})).data.work.state,'pending');
  assert.equal((await s.call('message',{messageId:m.id})).data.delivery.state,'acknowledged');
  const claim = (await s.call('claim',{messageId:m.id,runId:crypto.randomUUID()},'mast')).data;
  const args = leaseArgs(claim);
  assert.equal((await s.call('result',{...args,outcome:'completed',replyId:crypto.randomUUID(),summary:'No accepted answer'},'mast')).status,409);
  const reply = await s.send('Answer','mast',{kind:'reply',replyTo:m.id,claimId:args.claimId,runId:args.runId,fence:args.fence});
  assert.equal(reply.status,200);
  const returning = (await s.call('events',{},'lucy')).data.events;
  assert.equal(returning.length,1); assert.equal(returning[0].messageId,reply.data.message.id);
  assert.equal((await s.call('work',{},'lucy')).data.work.length,0,'replies never recursively become tasks');
  const result = {...args,outcome:'completed',replyId:reply.data.message.id,summary:'Actual accepted reply'};
  assert.equal((await s.call('result',result,'mast')).status,200);
  assert.equal((await s.call('result',result,'mast')).data.duplicate,true);
  assert.equal((await s.call('result',{...result,summary:'Replacement'},'mast')).status,409);
  assert.equal((await s.call('message',{messageId:m.id})).data.work.state,'reported');
});

test('concurrent duplicate sends, conflicting keys and spoofed metadata cannot change accepted data', async t => {
  const s = await setup(t), input = {idempotencyKey:crypto.randomUUID(),recipient:'mast',kind:'request',body:'Fixed'};
  const outputs = await Promise.all(Array.from({length:10},()=>s.call('send',input)));
  assert.ok(outputs.every(r=>r.status===200)); assert.equal(new Set(outputs.map(r=>r.data.message.id)).size,1);
  assert.equal(count(s,'project_messages'),1); assert.equal(count(s,'project_events'),1); assert.equal(count(s,'project_work'),1);
  assert.equal((await s.call('send',{...input,body:'Different'})).status,409);
  for (const extra of [{sender:'mast'},{project:'other-project'},{createdAt:'1999'},{principal:RELAY_OWNER},{id:crypto.randomUUID()}]) assert.equal((await s.call('send',{...input,...extra})).status,400);
});

test('atomic persistence rolls back on event failure, retry after storage outage is duplicate-safe', async t => {
  const s = await setup(t), input={idempotencyKey:crypto.randomUUID(),recipient:'mast',kind:'request',body:'Once'};
  const original = s.ctx.storage.sql.exec;
  s.ctx.storage.sql.exec = (q,...v) => { if (q.startsWith('INSERT INTO project_events')) throw Error('fictional disk outage'); return original(q,...v); };
  assert.equal((await s.call('send',input)).status,503);
  assert.equal(count(s,'project_messages'),0); assert.equal(count(s,'project_events'),0);
  s.ctx.storage.sql.exec=original;
  const accepted=await s.call('send',input); assert.equal(accepted.status,200);
  // Simulate a response lost after commit: send the exact uncertain operation.
  assert.equal((await s.call('send',input)).data.message.id,accepted.data.message.id);
  assert.equal(count(s,'project_events'),1);
});

test('concurrent claims have one winner, retries preserve lease, expired fences cannot reply or finish', async t => {
  const s=await setup(t), id=(await s.send()).data.message.id;
  const runId=crypto.randomUUID();
  const claims=await Promise.all([s.call('claim',{messageId:id,runId},'mast'),s.call('claim',{messageId:id,runId:crypto.randomUUID()},'mast')]);
  assert.deepEqual(claims.map(c=>c.status).sort(),[200,409]);
  const first=claims.find(c=>c.status===200).data, a=leaseArgs(first);
  assert.equal((await s.call('claim',{messageId:id,runId:first.work.runId},'mast')).data.claimId,first.claimId);
  const future=Date.parse(first.work.leaseUntil)+1;
  const unknown=await s.direct('claim',{messageId:id,runId:crypto.randomUUID()},'mast',future).json();
  assert.equal(unknown.work.state,'unknown'); assert.equal(unknown.claimId,null);
  assert.equal(s.direct('retry',{messageId:id,confirm:true},'mast',future).status,400);
  assert.equal(s.direct('retry',{messageId:id,confirm:true,resolution:'not_started',evidence:'Synthetic host run lookup confirmed no launch'},'mast',future).status,200);
  const second=await s.direct('claim',{messageId:id,runId:crypto.randomUUID()},'mast',future).json();
  assert.equal(second.work.fence,2);
  for (const op of ['renew','result','release']) {
    const extra=op==='result'?{outcome:'failed',summary:'stale'}:op==='release'?{reason:'timeout'}:{};
    assert.equal(s.direct(op,{...a,...extra},'mast',future).status,409);
  }
  const stale={idempotencyKey:crypto.randomUUID(),recipient:'lucy',kind:'reply',body:'stale',replyTo:id,claimId:a.claimId,runId:a.runId,fence:a.fence};
  assert.equal(s.direct('send',stale,'mast',future).status,409);
  assert.equal((await s.call('claim',{messageId:id,runId:crypto.randomUUID()},'lucy')).status,404);
});

test('accepted reply survives lease expiry and recovery, including conflicting second reply', async t => {
  const s=await setup(t), id=(await s.send()).data.message.id;
  const first=(await s.call('claim',{messageId:id,runId:crypto.randomUUID()},'mast')).data;
  const input={idempotencyKey:crypto.randomUUID(),recipient:'lucy',kind:'reply',body:'Accepted',replyTo:id,...Object.fromEntries(Object.entries(leaseArgs(first)).filter(([key])=>key!=='messageId'))};
  const accepted=await s.call('send',input,'mast');
  const future=Date.parse(first.work.leaseUntil)+1;
  const next=await s.direct('claim',{messageId:id,runId:crypto.randomUUID()},'mast',future).json();
  assert.equal(s.direct('send',{...input,idempotencyKey:crypto.randomUUID(),body:'Overwrite',claimId:next.claimId,runId:next.work.runId,fence:next.work.fence},'mast',future).status,409);
  assert.equal((await s.direct('send',input,'mast',future).json()).duplicate,true);
  assert.equal(s.direct('result',{...leaseArgs(next),outcome:'completed',replyId:accepted.data.message.id,summary:'Recovered existing answer'},'mast',future).status,200);
  assert.equal((await s.call('message',{messageId:id})).data.acceptedReply.body,'Accepted');
  assert.equal(count(s,'project_events'),2);
});

test('revocation and expiry deny reads, ACKs, writes and in-flight claims; admin cannot revive a revoked grant', async t => {
  const s=await setup(t), id=(await s.send()).data.message.id;
  const claim=(await s.call('claim',{messageId:id,runId:crypto.randomUUID()},'mast')).data;
  assert.equal((await s.admin({op:'revoke',grantId:s.grants.mast.grantId,confirm:true})).status,200);
  for (const [op,args] of [['identity',{}],['events',{}],['messages',{}],['ack',{eventIds:[crypto.randomUUID()]}],['renew',leaseArgs(claim)],['send',{idempotencyKey:crypto.randomUUID(),recipient:'lucy',kind:'note',body:'Denied'}]]) assert.equal((await s.call(op,args,'mast')).status,401);
  assert.equal((await s.admin(s.grants.mast)).status,409);
  assert.equal(s.direct('identity',{},'lucy',Date.parse(s.grants.lucy.expiresAt)+1).status,401);
  // Recheck owner authorization in same transaction, even if edge auth was earlier.
  s.db.prepare("UPDATE relay_oauth SET value=json_set(value,'$.revoked',1) WHERE key=?").run('grant:'+s.principal.grantId);
  assert.equal(projectStore(s.ctx,s.env,{op:'admin',principal:s.principal,args:{op:'revoke',grantId:s.grants.lucy.grantId,confirm:true}}).status,403);
});

test('cross-project reads/cursors/ACK/claims/replies denied, private owner and public history isolated', async t => {
  const s=await setup(t), id=(await s.send('Project only')).data.message.id;
  const secret=crypto.randomUUID();
  relayOwnerSchema(s.ctx);
  s.db.prepare('INSERT INTO relay_owner_entries(id,kind,body,created_at,principal,device_id,authentication_source) VALUES(?,?,?,?,?,?,?)').run(secret,'user','OWNER SECRET',new Date().toISOString(),RELAY_OWNER,'fixture-device','owner-device-session');
  sharedStore(s.ctx,'/internal/shared/message',{id:crypto.randomUUID(),body:'PUBLIC VISITOR'});
  assert.equal((await s.call('messages',{},'other')).status,403);
  assert.equal((await s.call('message',{messageId:id},'other','other-project')).status,404);
  assert.equal((await s.call('message',{messageId:secret})).status,404);
  assert.equal((await s.call('events',{cursor:'project1:other-project:lucy:0'})).status,400);
  const event=(await s.call('events',{},'mast')).data.events[0];
  assert.equal((await s.call('ack',{eventIds:[event.id]},'lucy')).status,404);
  assert.equal((await s.call('ack',{eventIds:[event.id]},'other','other-project')).status,404);
  assert.equal((await s.call('claim',{messageId:id,runId:crypto.randomUUID()},'other','other-project')).status,404);
  assert.equal((await s.send('Leak','mast',{kind:'reply',replyTo:secret})).status,404);
  const projectJSON=JSON.stringify((await s.call('messages')).data);
  assert.ok(!projectJSON.includes('OWNER SECRET')); assert.ok(!projectJSON.includes('PUBLIC VISITOR'));
  const publicJSON=JSON.stringify(await sharedStore(s.ctx,'/internal/shared/state',{}).json());
  assert.ok(!publicJSON.includes('Project only')); assert.ok(!publicJSON.includes('OWNER SECRET'));
  const ownerRead=await s.request('/relay/owner/messages',{headers:{Authorization:'Bearer '+s.tokens.mast}});
  assert.equal(ownerRead.status,401);
  const mcp=await s.request('/relay/mcp',{method:'POST',headers:{Authorization:'Bearer '+s.tokens.mast,'Content-Type':'application/json'},body:'{}'});
  assert.equal(mcp.status,401);
});

test('bounded pages and retained replay recover ACKed events, ACK batches roll back atomically', async t => {
  const s=await setup(t); for(let i=0;i<4;i++) await s.send('Message '+i);
  const first=(await s.call('events',{limit:2},'mast')).data;
  assert.equal(first.events.length,2); assert.ok(first.nextCursor);
  const next=(await s.call('events',{limit:2,cursor:first.nextCursor},'mast')).data;
  assert.equal(next.events.length,2); assert.equal(next.nextCursor,null);
  assert.equal((await s.call('ack',{eventIds:[first.events[0].id,crypto.randomUUID()]},'mast')).status,404);
  assert.equal((await s.call('events',{},'mast')).data.events.length,4);
  await s.call('ack',{eventIds:first.events.map(e=>e.id)},'mast');
  assert.equal((await s.call('events',{},'mast')).data.events.length,2);
  assert.equal((await s.call('events',{mode:'replay'},'mast')).data.events.length,4);
  assert.equal((await s.call('work',{},'mast')).data.work.length,4);
  assert.equal((await s.call('events',{limit:51},'mast')).status,400);
  assert.equal((await s.call('messages',{limit:'1e1'})).status,400);
  assert.equal((await s.call('messages',{limit:2})).data.messages.length,2);
  assert.equal((await s.call('events',{cursor:'project1:jarvis:lucy:0'},'mast')).status,400);
});

test('bounded admission does not lose accepted messages; retry remains possible while full', async t => {
  const s=await setup(t), input={idempotencyKey:crypto.randomUUID(),recipient:'mast',kind:'request',body:'Kept'};
  const accepted=await s.call('send',input);
  const insert=s.db.prepare('INSERT INTO project_events(id,message_id,project,recipient,created_ms) VALUES(?,?,?,?,?)');
  for(let i=1;i<PROJECT_LIMITS.outstanding;i++) insert.run(crypto.randomUUID(),crypto.randomUUID(),'jarvis','mast',Date.now());
  const full=await s.send(); assert.equal(full.status,429); assert.equal(full.headers.get('Retry-After'),'60');
  assert.equal((await s.call('send',input)).data.message.id,accepted.data.message.id);
  assert.equal(count(s,'project_messages'),1);
});

test('durable backoff and bounded recovery stop a failing host from spinning', async t => {
  const s=await setup(t), id=(await s.send()).data.message.id;
  let now=Date.now(), last;
  for(let i=0;i<PROJECT_LIMITS.attempts;i++) {
    const claim=await s.direct('claim',{messageId:id,runId:crypto.randomUUID()},'mast',now).json();
    assert.ok(claim.claimId);
    last=await s.direct('release',{...leaseArgs(claim),reason:'host_unavailable'},'mast',now).json();
    assert.equal(s.direct('claim',{messageId:id,runId:crypto.randomUUID()},'mast',now).status,i===PROJECT_LIMITS.attempts-1?409:429);
    now=Date.parse(last.work.nextAttemptAt)+1;
  }
  assert.equal(last.work.state,'blocked');
  assert.equal(s.direct('retry',{messageId:id,confirm:true},'lucy',now).status,409);
  assert.equal(s.direct('retry',{messageId:id,confirm:true},'lucy',now+60000).status,200);
  assert.equal((await s.direct('claim',{messageId:id,runId:crypto.randomUUID()},'mast',now+60000).json()).work.recoveries,1);
});

test('grant creation requires explicit finite approval and management enablement', async t => {
  const s=await setup(t);
  for (const modification of [{confirm:false},{agent:'owner'},{project:'../private'},{expiresAt:null},{expiresAt:new Date(Date.now()+366*86400000).toISOString()}]) assert.equal((await s.admin({...s.grants.lucy,...modification})).status,400);
  s.env.RELAY_PROJECT_ADMIN_ENABLED='false';
  assert.equal((await s.admin(s.grants.lucy)).status,403);
  assert.equal((await s.call('identity')).status,200,'administration can be closed during normal operations');
});

test('history admission reserves answers for accepted work even when notes fill capacity', async t => {
  const s=await setup(t);
  // Populate retained history cheaply through real SQLite; no live identities.
  const insert=s.db.prepare('INSERT INTO project_messages(id,project,sender,recipient,kind,body,created_ms,sender_grant,idempotency_key,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?)');
  s.db.exec('BEGIN');
  for(let i=0;i<PROJECT_LIMITS.history-3;i++) insert.run(crypto.randomUUID(),'jarvis','lucy','mast','note','Old',Date.now(),'fixture',crypto.randomUUID(),'fixture');
  s.db.exec('COMMIT');
  const request=await s.send('Reserved answer'); assert.equal(request.status,200);
  assert.equal((await s.send('Last unreserved note','lucy',{kind:'note'})).status,200);
  assert.equal((await s.send('Would consume reserved slot','lucy',{kind:'note'})).status,429);
  assert.equal((await s.send('No room for another request')).status,429);
  const claim=(await s.call('claim',{messageId:request.data.message.id,runId:crypto.randomUUID()},'mast')).data;
  const {messageId,...lease}=leaseArgs(claim);
  const accepted=await s.send('Fits reserved slot','mast',{kind:'reply',replyTo:messageId,...lease});
  assert.equal(accepted.status,200);
  assert.equal(count(s,'project_messages'),PROJECT_LIMITS.history);
  assert.equal((await s.call('result',{messageId,...lease,outcome:'completed',replyId:accepted.data.message.id,summary:'Reserved slot consumed'},'mast')).status,200);
});

test('existing owner MCP can explicitly manage approved grants only behind both flags, without becoming a project agent', async t => {
  const s=await setup(t);
  const {relayRpc}=await import('../backend/relay-connector.js');
  const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}};
  const rpc=(method,params)=>relayRpc(s.ctx,s.env,s.principal,{method,params:{_meta:meta,...params}});
  let list=await rpc('tools/list',{});
  assert.ok(list.tools.some(x=>x.name==='relay_project_grant_register'));
  s.env.RELAY_PROJECT_ADMIN_ENABLED='false';
  list=await rpc('tools/list',{});
  assert.ok(!list.tools.some(x=>x.name==='relay_project_grant_register'));
  await assert.rejects(rpc('tools/call',{name:'relay_project_grant_revoke',arguments:{grantId:s.grants.mast.grantId,confirm:true}}),/not activated/);
  s.env.RELAY_PROJECT_ADMIN_ENABLED='true';
  const {op,...args}=s.grants.lucy;
  const existing=await rpc('tools/call',{name:'relay_project_grant_register',arguments:args});
  assert.equal(existing.isError,false);
  assert.equal(existing.structuredContent.grantId,args.grantId);
  await assert.rejects(rpc('tools/call',{name:'relay_project_grant_register',arguments:{...args,op:'revoke'}}),/Invalid arguments/);
  const revoked=await rpc('tools/call',{name:'relay_project_grant_revoke',arguments:{grantId:s.grants.mast.grantId,confirm:true}});
  assert.equal(revoked.isError,false); assert.equal((await s.call('identity',{},'mast')).status,401);
  assert.equal((await s.request('/relay/projects/jarvis/identity',{headers:{Authorization:'Bearer '+s.access}})).status,401);
});

test('grant revoked while a streamed send is in flight cannot commit after final authorization', async t => {
  const s=await setup(t);
  let release, started;
  const ready=new Promise(resolve=>{started=resolve;});
  const body=new ReadableStream({start(controller){
    controller.enqueue(new TextEncoder().encode('{'));started();
    release=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify({idempotencyKey:crypto.randomUUID(),recipient:'mast',kind:'request',body:'Late write'}).slice(1)));controller.close();};
  }});
  const pending=s.request('/relay/projects/jarvis/send',{method:'POST',duplex:'half',headers:{Authorization:'Bearer '+s.tokens.lucy,'Content-Type':'application/json'},body});
  await ready;
  assert.equal((await s.admin({op:'revoke',grantId:s.grants.lucy.grantId,confirm:true})).status,200);
  release();
  assert.equal((await pending).status,401);
  assert.equal(count(s,'project_messages'),0);
});

test('both directions can initiate requests, bounded notes are inert, and oversized inputs never persist', async t => {
  const s=await setup(t);
  const reverse=await s.send('Mast asks Lucy','mast'); assert.equal(reverse.status,200);
  assert.equal((await s.call('work')).data.work[0].messageId,reverse.data.message.id);
  const note=await s.send('A notification','mast',{kind:'note'}); assert.equal(note.status,200);
  assert.equal((await s.call('work')).data.work.length,1);
  assert.equal((await s.call('events')).data.events.length,2);
  assert.equal((await s.send('😀'.repeat(3001))).status,400);
  assert.equal((await s.send('\ufeff')).status,400);
  const large=await s.request('/relay/projects/jarvis/send',{method:'POST',headers:{Authorization:'Bearer '+s.tokens.lucy,'Content-Type':'application/json'},body:JSON.stringify({idempotencyKey:crypto.randomUUID(),recipient:'mast',kind:'note',body:'x'.repeat(40001)})});
  assert.equal(large.status,400);
  assert.equal(count(s,'project_messages'),2);
});

test('ambiguous host timeout stays unknown, explicit reconciled retry is audited, outcome reports remain held', async t => {
  const s=await setup(t), id=(await s.send('Uncertain host run')).data.message.id;
  const first=(await s.call('claim',{messageId:id,runId:crypto.randomUUID()},'mast')).data;
  const released=await s.call('release',{...leaseArgs(first),reason:'timeout'},'mast');
  assert.equal(released.data.work.state,'unknown');
  assert.equal((await s.call('claim',{messageId:id,runId:crypto.randomUUID()},'mast')).status,409);
  const future=Date.parse(released.data.work.nextAttemptAt)+60001;
  assert.equal(s.direct('retry',{messageId:id,confirm:true},'lucy',future).status,400);
  assert.equal(s.direct('retry',{messageId:id,confirm:true,resolution:'safe_to_repeat',evidence:'Fictional operator reconciled host run and its side effects'},'lucy',future).status,200);
  const detail=(await s.call('message',{messageId:id})).data;
  assert.equal(detail.recoveries.length,1); assert.equal(detail.recoveries[0].verification,'unverified');
  const claim=await s.direct('claim',{messageId:id,runId:crypto.randomUUID()},'mast',future).json();
  const result={...leaseArgs(claim),outcome:'failed',summary:'Host reports unavailable'};
  assert.equal(s.direct('result',{...result,verification:'verified'},'mast',future).status,400);
  const held=await s.direct('result',result,'mast',future).json();
  assert.equal(held.work.state,'reported');assert.equal(held.work.result.verification,'held');assert.equal(held.work.result.basis,'agent-report');
  assert.equal((await s.call('work',{mode:'all'},'mast')).data.work[0].state,'reported');
  assert.equal((await s.call('work',{},'mast')).data.work.length,0);
  assert.equal(s.direct('claim',{messageId:id,runId:crypto.randomUUID()},'mast',future+300001).status,409);
});

test('timeout after an accepted reply permits report-only recovery and never replaces that reply', async t => {
  const s=await setup(t), id=(await s.send('Lost send response')).data.message.id;
  const claim=(await s.call('claim',{messageId:id,runId:crypto.randomUUID()},'mast')).data;
  const {messageId,...lease}=leaseArgs(claim);
  const reply=await s.send('Preserved','mast',{kind:'reply',replyTo:messageId,...lease});
  const released=await s.call('release',{messageId,...lease,reason:'timeout'},'mast');
  assert.equal(released.data.work.state,'pending');
  const now=Date.parse(released.data.work.nextAttemptAt)+1;
  const recovery=await s.direct('claim',{messageId:id,runId:crypto.randomUUID()},'mast',now).json();
  const result=await s.direct('result',{...leaseArgs(recovery),outcome:'completed',replyId:reply.data.message.id,summary:'Reconciled already accepted answer'},'mast',now).json();
  assert.equal(result.work.state,'reported');assert.equal(result.work.result.verification,'held');
  assert.equal(count(s,'project_messages'),2);assert.equal(count(s,'project_events'),2);
});
