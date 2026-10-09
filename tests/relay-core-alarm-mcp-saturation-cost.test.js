import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions,Response as FixtureResponse} from 'miniflare';

// Real Hub.alarm/restarted Hub instances and native workerd cursor costs. The
// clock, OAuth records, comments and callback transport are local fictional data.
// Setup/observation are excluded; all shared and legacy lane operations count.
const source=`
import {Hub} from './worker.js';
import {sharedStore,SHARED_OBJECT,PUBLIC_KEY} from './shared.js';
import {COMMENTS_URL} from './publications.js';
import {relayOAuthStore} from './relay-oauth.js';
import {relaySubscribe} from './relay-events.js';
import {reserveRelayCoreWake,releaseRelayCoreWake,beginRelayCoreAlarm,scheduleRelayCoreAlarm,RELAY_PRECOMMIT_EXPIRY_MS} from './relay-core-alarm.js';
import {RELAY_OWNER,RELAY_CALLBACK,RELAY_INBOX,RELAY_EVENT,random,hash,challenge} from './relay-common.js';
const first='00000000-0000-4000-8000-000000000801',second='00000000-0000-4000-8000-000000000802',eventId='00000000-0000-4000-8000-000000000803';
const bytes=value=>value===undefined?0:new TextEncoder().encode(JSON.stringify(value)).length;
export class SaturatedAlarmFixture extends Hub {
  constructor(ctx,env){
    const state={comments:[],egress:0,interrupt:false,rejectCompose:false};
    super(ctx,env,{publicationFetcher:async(url,init={})=>{
      if(new URL(url).origin+new URL(url).pathname!==COMMENTS_URL||(init.method||'GET')!=='GET'||init.redirect!=='manual'||init.headers?.Authorization||init.headers?.Cookie)
        throw Error('Unexpected fictional publication request');
      state.egress++;return Response.json(state.comments);
    }});
    this.state=state;this.raw=ctx.storage;this.queries=[];this.now=Date.now()+3600000;
    this.counters={alarmSets:0,alarmDeletes:0,kvReads:0,kvReadJsonBytes:0,kvWrites:0,kvWriteJsonBytes:0,kvDeletes:0};
    const counters=this.counters,sql={exec:(query,...values)=>{
      if(state.interrupt&&query==='SELECT * FROM relay_subscriptions'){state.interrupt=false;throw Error('Fictional native alarm interruption');}
      const cursor=ctx.storage.sql.exec(query,...values);this.queries.push({query,cursor});return cursor;
    }};
    const storage=new Proxy(ctx.storage,{get:(target,key)=>{
      if(key==='sql')return sql;
      if(key==='setAlarm')return async value=>{
        counters.alarmSets++;
        if(state.rejectCompose&&counters.alarmSets===2){state.rejectCompose=false;throw Error('Fictional native post-release compositor rejection');}
        return target.setAlarm(value);
      };
      if(key==='deleteAlarm')return async()=>{counters.alarmDeletes++;return target.deleteAlarm();};
      if(key==='get')return async name=>{const value=await target.get(name);counters.kvReads++;counters.kvReadJsonBytes+=bytes(value);return value;};
      if(key==='put')return async(name,value)=>{counters.kvWrites++;counters.kvWriteJsonBytes+=bytes(value);return target.put(name,value);};
      if(key==='delete')return async name=>{counters.kvDeletes++;return target.delete(name);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    this.ctx=new Proxy(ctx,{get:(target,key)=>{if(key==='storage')return storage;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  }
  reset(){this.queries=[];this.state.egress=0;for(const key of Object.keys(this.counters))this.counters[key]=0;}
  costs(){
    const queries=this.queries.map(({query,cursor})=>({query:query.replace(/\\s+/g,' ').trim(),rowsRead:cursor.rowsRead,rowsWritten:cursor.rowsWritten}));
    return {...this.counters,egress:this.state.egress,rowsRead:queries.reduce((n,q)=>n+q.rowsRead,0),rowsWritten:queries.reduce((n,q)=>n+q.rowsWritten,0),queries};
  }
  async clock(operation){const previous=Date.now;Date.now=()=>this.now;try{return await operation();}finally{Date.now=previous;}}
  fillRequests(){
    const now=this.now;this.expiry=now+RELAY_PRECOMMIT_EXPIRY_MS;
    this.raw.sql.exec('DELETE FROM relay_core_alarm_wakes');
    this.raw.sql.exec("INSERT INTO relay_core_alarm_wakes WITH RECURSIVE slots(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM slots WHERE n<256) SELECT printf('fictional-orphan-%03d',n),?,? FROM slots",now+100,this.expiry);
  }
  async seed(){
    sharedStore(this.ctx,'/internal/shared/message',{id:first,body:'Fictional saturated FIFO first'});
    sharedStore(this.ctx,'/internal/shared/message',{id:second,body:'Fictional saturated FIFO second'});
    await this.syncPublicRead();
    const client=random(),grantId=random(),code=random(),accessHash=await hash(random()),resource=this.env.RELAY_MCP_ORIGIN+'/relay/mcp';
    const registry=async body=>{const response=await relayOAuthStore(this.ctx,body);if(!response.ok)throw Error('Fictional grant seed failed');return response.json();};
    await registry({op:'put',key:'client:'+client,category:'client',value:{redirect:RELAY_CALLBACK},expiresAt:Date.now()+600000});
    const params={client_id:client,redirect_uri:RELAY_CALLBACK,code_challenge:await challenge(random()),scope:'relay:read relay:events'};
    await registry({op:'authorize',grantId,codeKey:'code:'+await hash(code),params,resource});
    await registry({op:'exchange',key:'code:'+await hash(code),match:{client_id:client,redirect_uri:RELAY_CALLBACK,challenge:params.code_challenge,resource},accessKey:'access:'+accessHash,refreshKey:'refresh:'+await hash(random())});
    await relaySubscribe(this.ctx,{principal:RELAY_OWNER,grantId,scopes:['relay:read','relay:events'],accessHash},
      {name:RELAY_EVENT,arguments:{inbox_id:RELAY_INBOX},cursor:'relay1:0',delivery:{mode:'webhook',url:'https://callback.example.test/fictional',secret:'whsec_'+btoa(String.fromCharCode(...new Uint8Array(32).fill(17)))}},
      this.env,async(_url,init)=>Response.json({challenge:JSON.parse(init.body).challenge}),Date.now());
    this.fillRequests();
    this.state.comments=[{id:2801,user:{id:183016859},created_at:'2026-10-08T00:00:00Z',body:JSON.stringify({schema:'jarvis-coordination-v2',
      eventId,requestId:first,attemptId:'00000000-0000-4000-8000-000000000804',stage:'final',resultVersion:1,body:'Fictional first-due imported final',artifacts:[]})}];
    for(const key of ['publisher-next-attempt','publisher-local-next-attempt'])this.raw.sql.exec('INSERT OR REPLACE INTO shared_meta VALUES(?,?)',key,JSON.stringify(this.now+100));
    await this.raw.setAlarm(this.now+100);this.now+=100;
  }
  async restartedAlarm(){
    const restarted=new Hub({storage:this.ctx.storage},this.env,{publicationFetcher:this.publicationFetcher});
    let error=null;try{await restarted.alarm();}catch(cause){error=cause.message;}
    return {error,now:this.now,nextAlarm:await this.raw.getAlarm(),reservations:[...this.raw.sql.exec('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')][0].n,
      imported:[...this.raw.sql.exec('SELECT COUNT(*) AS n FROM public_coordination_events WHERE event_id=?',eventId)][0].n,
      outbox:[...this.raw.sql.exec('SELECT event_seq,status,attempts FROM relay_outbox ORDER BY event_seq')]};
  }
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/fixture/reset'){this.reset();return Response.json({reset:true});}
    if(path==='/fixture/costs')return Response.json(this.costs());
    if(path==='/fixture/fail-drain'){this.state.interrupt=true;return Response.json({configured:true});}
    if(path==='/fixture/fail-compose'){this.state.rejectCompose=true;return Response.json({configured:true});}
    if(path==='/fixture/seed'){await this.clock(()=>this.seed());return Response.json({expiry:this.expiry});}
    if(['/fixture/first','/fixture/second','/fixture/expiry','/fixture/early-retry','/fixture/end'].includes(path)){
      if(path==='/fixture/second'||path==='/fixture/end')this.now=await this.raw.getAlarm();
      if(path==='/fixture/early-retry')this.now+=2000;
      if(path==='/fixture/expiry')this.now=this.expiry;
      return Response.json(await this.clock(()=>this.restartedAlarm()));
    }
    if(path==='/fixture/expired-admission')return Response.json(await this.clock(async()=>{
      const initial=this.now;await reserveRelayCoreWake(this.ctx,initial);this.fillRequests();this.now=this.expiry;
      this.reset();const id=await reserveRelayCoreWake({storage:this.ctx.storage},this.now);const costs=this.costs();
      const remaining=[...this.raw.sql.exec('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')][0].n;
      releaseRelayCoreWake(this.ctx,id);return {remaining,...costs};
    }));
    if(path==='/fixture/overlap')return Response.json(await this.clock(async()=>{
      await reserveRelayCoreWake(this.ctx,this.now);this.fillRequests();this.now+=100;
      const restarted={storage:this.ctx.storage};this.reset();
      const first=await beginRelayCoreAlarm(restarted,this.now);this.now+=1000;
      const second=await beginRelayCoreAlarm(restarted,this.now),during=[...this.raw.sql.exec('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')][0].n;
      releaseRelayCoreWake(restarted,first);await scheduleRelayCoreAlarm(restarted,()=>null,this.now);
      const heldUntil=await this.raw.getAlarm(),expected=this.now+60000;
      releaseRelayCoreWake(restarted,second);await scheduleRelayCoreAlarm(restarted,()=>null,this.now);
      return {during,heldUntil,expected,remaining:[...this.raw.sql.exec('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')][0].n,...this.costs()};
    }));
    return super.fetch(request);
  }
}
const fixture=(object,name)=>object.fetch(new Request('https://internal/fixture/'+name));
export default {async fetch(request,env){
  const path=new URL(request.url).pathname.slice(1),shared=env.HUBS.get(env.HUBS.idFromName(SHARED_OBJECT)),legacy=env.HUBS.get(env.HUBS.idFromName(await hash(PUBLIC_KEY)));
  if(path.startsWith('interrupted-')||path.startsWith('rejected-')){
    const [mode,operation]=path.split('-'),object=env.HUBS.get(env.HUBS.idFromName('fictional-'+mode));
    if(operation==='seed'){
      const response=await fixture(object,'seed');await fixture(object,mode==='interrupted'?'fail-drain':'fail-compose');return response;
    }
    await Promise.all([object,legacy].map(item=>fixture(item,'reset')));
    const phase=operation==='retry'?(mode==='interrupted'?'early-retry':'second'):operation;
    const result=await (await fixture(object,phase)).json();
    const objects=await Promise.all([object,legacy].map(async item=>(await fixture(item,'costs')).json()));
    const keys=['rowsRead','rowsWritten','egress','alarmSets','alarmDeletes','kvReads','kvReadJsonBytes','kvWrites','kvWriteJsonBytes','kvDeletes'];
    return Response.json({result,...Object.fromEntries(keys.map(key=>[key,objects.reduce((sum,cost)=>sum+cost[key],0)])),queries:objects.flatMap(cost=>cost.queries)});
  }
  if(path==='seed')return fixture(shared,'seed');
  if(['expired-admission','overlap'].includes(path))return fixture(env.HUBS.get(env.HUBS.idFromName('fictional-'+path)),path);
  if(!['first','second','expiry'].includes(path))return new Response('Unknown fictional case',{status:404});
  await Promise.all([shared,legacy].map(object=>fixture(object,'reset')));
  const response=await fixture(shared,path),result=await response.json();
  const objects=await Promise.all([shared,legacy].map(async object=>(await fixture(object,'costs')).json()));
  const keys=['rowsRead','rowsWritten','egress','alarmSets','alarmDeletes','kvReads','kvReadJsonBytes','kvWrites','kvWriteJsonBytes','kvDeletes'];
  return Response.json({status:response.status,result,...Object.fromEntries(keys.map(key=>[key,objects.reduce((sum,cost)=>sum+cost[key],0)])),queries:objects.flatMap(cost=>cost.queries)});
}};
`;

test('native restarted saturated alarms run both lanes with bounded rows, alarm calls and expiry cleanup',{timeout:30000},async()=>{
  const configuration=JSON.parse(readFileSync(new URL('../backend/wrangler.jsonc',import.meta.url),'utf8'));
  const bundle=await build({stdin:{contents:source,resolveDir:fileURLToPath(new URL('../backend/',import.meta.url)),sourcefile:'fictional-saturated-alarm-cost.js'},
    bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:crypto']});
  const deliveries=[];let transportRequests=0;
  const mf=new Miniflare(convertV4MiniflareOptions({name:'local-fictional-saturated-alarm-cost',modules:true,script:bundle.outputFiles[0].text,
    compatibilityDate:configuration.compatibility_date,compatibilityFlags:configuration.compatibility_flags||[],cf:false,telemetry:{enabled:false},
    bindings:{RELAY_MCP_ENABLED:'true',RELAY_MCP_ORIGIN:'https://relay.example.test',RELAY_WEBHOOK_EGRESS_URL:'https://transport.example.test/fixed',RELAY_WEBHOOK_EGRESS_TOKEN:'fictional-local-transport'},
    durableObjects:{HUBS:{className:'SaturatedAlarmFixture',useSQLite:true}},outboundService:async request=>{
      transportRequests++;
      assert.equal(request.url,'https://transport.example.test/fixed');assert.equal(request.method,'POST');
      const envelope=await request.json(),payload=JSON.parse(envelope.body);assert.equal(payload.name,'relay.message.created');
      assert.equal(payload.data.author_authenticated,false);deliveries.push(payload.data.message_id);
      return FixtureResponse.json({status:204,body:''});
    }}));
  try{
    const run=async name=>{
      const before=transportRequests,response=await mf.dispatchFetch('https://cost.example.test/'+name);assert.equal(response.status,200);
      const {egress,...result}=await response.json(),publisherFetches=egress??0,callbackTransportRequests=transportRequests-before;
      return {...result,publisherFetches,callbackTransportRequests,egressAttempts:publisherFetches+callbackTransportRequests};
    };
    const {expiry}=await run('seed'),first=await run('first');
    assert.equal(first.status,200);assert.equal(first.result.error,null,JSON.stringify({scope:'native restarted first-due saturated alarm',
      error:first.result.error,rowsRead:first.rowsRead,rowsWritten:first.rowsWritten,egressAttempts:first.egressAttempts,alarmSets:first.alarmSets,reservations:first.result.reservations}));
    assert.equal(first.result.imported,1);assert.equal(first.result.reservations,256);
    assert.deepEqual(deliveries,['00000000-0000-4000-8000-000000000801']);assert.equal(first.publisherFetches,1);assert.equal(first.callbackTransportRequests,1);
    assert.equal(first.result.outbox[0].status,'delivered');assert.equal(first.result.outbox[1].status,'pending');
    assert.ok(first.result.nextAlarm>first.result.now&&first.result.nextAlarm<expiry);
    const second=await run('second');assert.equal(second.result.error,null);assert.equal(second.result.imported,1);assert.equal(second.result.reservations,256);assert.equal(second.publisherFetches,0);assert.equal(second.callbackTransportRequests,1);
    assert.deepEqual(deliveries,['00000000-0000-4000-8000-000000000801','00000000-0000-4000-8000-000000000802']);
    assert.equal(second.result.nextAlarm,expiry);
    const cleanup=await run('expiry');assert.equal(cleanup.result.error,null);assert.equal(cleanup.result.reservations,0);assert.equal(cleanup.result.imported,1);assert.equal(cleanup.egressAttempts,0);
    assert.ok(cleanup.result.nextAlarm>expiry);assert.equal(deliveries.length,2);
    for(const result of [first,second,cleanup]){
      assert.ok(result.rowsRead<=1100);assert.ok(result.rowsWritten<=1100);
      assert.ok(result.alarmSets<=2);assert.equal(result.alarmDeletes,0);
      assert.equal(result.kvWrites,0);assert.equal(result.kvDeletes,0);
    }
    const admission=await run('expired-admission');assert.equal(admission.remaining,1);assert.ok(admission.rowsRead<=270);assert.ok(admission.rowsWritten<=780);
    assert.equal(admission.alarmSets,1);assert.equal(admission.alarmDeletes,0);assert.equal(admission.egressAttempts,0);
    const overlap=await run('overlap');assert.equal(overlap.during,257);assert.equal(overlap.remaining,256);assert.equal(overlap.heldUntil,overlap.expected);
    assert.ok(overlap.rowsRead<=3*256+32,'Indexed promotion touches at most the 256 request rows and their indexes, plus fixed scheduling reads');
    assert.ok(overlap.rowsWritten<=2*256+32);assert.equal(overlap.egressAttempts,0);assert.ok(overlap.alarmSets<=4);
    const interruptedSeed=await run('interrupted-seed'),interrupted=await run('interrupted-first');
    assert.equal(interrupted.result.error,'Fictional native alarm interruption');assert.equal(interrupted.result.imported,1);
    assert.equal(interrupted.result.reservations,257);assert.equal(interrupted.result.nextAlarm,interrupted.result.now+60000);
    const recovered=await run('interrupted-retry');assert.equal(recovered.result.error,null);assert.equal(recovered.result.imported,1);
    assert.equal(recovered.result.reservations,257);assert.equal(recovered.publisherFetches,0);assert.equal(recovered.callbackTransportRequests,1);assert.ok(recovered.result.nextAlarm<interruptedSeed.expiry);
    const recoveredSecond=await run('interrupted-second');assert.equal(recoveredSecond.result.error,null);assert.equal(recoveredSecond.publisherFetches,0);assert.equal(recoveredSecond.callbackTransportRequests,1);
    assert.equal(recoveredSecond.result.nextAlarm,interruptedSeed.expiry);
    const interruptedCleanup=await run('interrupted-expiry');assert.equal(interruptedCleanup.result.error,null);assert.equal(interruptedCleanup.result.reservations,1);
    assert.equal(interruptedCleanup.result.nextAlarm,interrupted.result.now+300000,'Successful retries retain the original failed alarm expiry');
    assert.equal(interruptedCleanup.egressAttempts,0);assert.equal(interruptedCleanup.result.imported,1);
    const interruptedFinished=await run('interrupted-end');assert.equal(interruptedFinished.result.error,null);assert.equal(interruptedFinished.result.reservations,0);
    assert.equal(interruptedFinished.result.imported,1);assert.ok(interruptedFinished.result.nextAlarm>interruptedFinished.result.now);
    const rejectedSeed=await run('rejected-seed'),rejected=await run('rejected-first');
    assert.equal(rejected.result.error,'Fictional native post-release compositor rejection');assert.equal(rejected.result.reservations,256);
    assert.equal(rejected.result.imported,1);assert.equal(rejected.result.nextAlarm,rejected.result.now+60000);
    const repaired=await run('rejected-retry');assert.equal(repaired.result.error,null);assert.equal(repaired.result.reservations,256);
    assert.equal(repaired.result.imported,1);assert.equal(repaired.publisherFetches,0);assert.equal(repaired.callbackTransportRequests,1);assert.equal(repaired.result.nextAlarm,rejectedSeed.expiry);
    for(const result of [interrupted,recovered,recoveredSecond,interruptedCleanup,interruptedFinished,rejected,repaired]){
      assert.ok(result.rowsRead<=1100);assert.ok(result.rowsWritten<=1100);assert.ok(result.alarmSets<=2);assert.equal(result.alarmDeletes,0);
      assert.equal(result.kvWrites,0);assert.equal(result.kvDeletes,0);
    }
    for(const result of [second,interruptedFinished,repaired]){
      assert.equal(result.result.outbox.length,2);assert.ok(result.result.outbox.every(item=>item.status==='delivered'&&item.attempts===1));
    }
    const compact=({queries,result,...cost})=>({scope:'native whole restarted Hub.alarm across shared and legacy objects; setup/observation excluded',...cost});
    process.stdout.write('LOCAL_FICTIONAL_SATURATED_ALARM_NATIVE_COST '+JSON.stringify({first:compact(first),second:compact(second),cleanup:compact(cleanup),
      expiredAdmission:{...compact(admission),scope:'native ordinary admission after all 256 slots expired'},overlap:{...compact(overlap),scope:'native overlapping alarm reservation/composition at 256 ordinary slots'},
      interrupted:compact(interrupted),recovered:compact(recovered),recoveredSecond:compact(recoveredSecond),interruptedCleanup:compact(interruptedCleanup),interruptedFinished:compact(interruptedFinished),rejected:compact(rejected),repaired:compact(repaired)})+'\n');
  }finally{await mf.dispose();}
});
