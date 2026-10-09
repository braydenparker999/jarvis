import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayFixture} from './relay-fixture.js';
import {publicationSchema} from '../backend/publications.js';
import {SHARED_OBJECT} from '../backend/shared.js';
import {scheduleRelayCoreAlarm,reserveRelayCoreWake,releaseRelayCoreWake,beginRelayCoreAlarm,RELAY_ALARM_RETRY_MS,RELAY_PRECOMMIT_EXPIRY_MS} from '../backend/relay-core-alarm.js';

function fixture(t) {
  const f=createRelayFixture();t.after(()=>f.close());
  const object=f.object(SHARED_OBJECT);publicationSchema(object.ctx);
  return {...object,rows:(query,...values)=>[...object.ctx.storage.sql.exec(query,...values)]};
}
function deferred() { let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve}; }

test('core scheduler composes once and avoids identical maintenance writes and empty deletes',async t=>{
  const f=fixture(t),now=Date.now();let deletes=0;
  const remove=f.ctx.storage.deleteAlarm;f.ctx.storage.deleteAlarm=async()=>{deletes++;await remove();};
  assert.equal(await scheduleRelayCoreAlarm(f.ctx,()=>null,now),null);
  assert.equal(deletes,0);assert.equal(f.alarms.length,0);
  assert.equal(await scheduleRelayCoreAlarm(f.ctx,()=>now+16000,now),now+16000);
  await scheduleRelayCoreAlarm(f.ctx,()=>now+16000,now);
  assert.deepEqual(f.alarms,[now+16000]);
  await scheduleRelayCoreAlarm(f.ctx,()=>null,now);await scheduleRelayCoreAlarm(f.ctx,()=>null,now);
  assert.equal(deletes,1);assert.equal(await f.ctx.storage.getAlarm(),null);
});

test('each mutation acknowledges durable wake storage while retaining another earlier precommit',async t=>{
  const f=fixture(t),now=Date.now();
  const first=await reserveRelayCoreWake(f.ctx,now,100),second=await reserveRelayCoreWake(f.ctx,now,1000);
  assert.equal(await f.ctx.storage.getAlarm(),now+100);
  assert.deepEqual(f.alarms,[now+100,now+100],'Explicit mutation admission is one storage acknowledgement per attempt');
  releaseRelayCoreWake(f.ctx,second);
  await scheduleRelayCoreAlarm(f.ctx,()=>now+16000,now);
  assert.equal(await f.ctx.storage.getAlarm(),now+100,'Another request cannot erase the earlier durable precommit');
  releaseRelayCoreWake(f.ctx,first);
  await scheduleRelayCoreAlarm(f.ctx,()=>now+16000,now);
  assert.equal(await f.ctx.storage.getAlarm(),now+16000);
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')[0].n,0);
});

test('source selection is fresh after alarm I/O, and concurrent setters cannot erase a newer wake',async t=>{
  const f=fixture(t),now=Date.now(),entered=deferred(),resume=deferred();
  const get=f.ctx.storage.getAlarm;let held=true,delivery=null;
  f.ctx.storage.getAlarm=async()=>{if(held){held=false;entered.resolve();await resume.promise;}return get();};
  const composing=scheduleRelayCoreAlarm(f.ctx,()=>delivery,now);
  await entered.promise;
  delivery=now+8000;
  const reserving=reserveRelayCoreWake(f.ctx,now,100);
  resume.resolve();await composing;const id=await reserving;
  assert.equal(await get(),now+100);
  releaseRelayCoreWake(f.ctx,id);
  await scheduleRelayCoreAlarm(f.ctx,()=>delivery,now);
  assert.equal(await get(),now+8000);
});

test('abandoned reservations survive restart with one conservative recovery and bounded expiry',async t=>{
  const f=fixture(t),now=Date.now();
  await reserveRelayCoreWake(f.ctx,now,100);
  // A restarted context sees the same persisted SQLite and host alarm, without
  // any in-memory scheduler table/cache or unfinished request promise.
  const restarted={storage:f.ctx.storage};
  const id=await beginRelayCoreAlarm(restarted,now+100);
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')[0].n,2);
  assert.equal(await f.ctx.storage.getAlarm(),now+100+RELAY_ALARM_RETRY_MS);
  releaseRelayCoreWake(restarted,id);
  await scheduleRelayCoreAlarm(restarted,()=>null,now+100);
  assert.equal(await f.ctx.storage.getAlarm(),now+RELAY_PRECOMMIT_EXPIRY_MS);
  const expired=await beginRelayCoreAlarm(restarted,now+RELAY_PRECOMMIT_EXPIRY_MS);
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')[0].n,1);
  releaseRelayCoreWake(restarted,expired);
  await scheduleRelayCoreAlarm(restarted,()=>null,now+RELAY_PRECOMMIT_EXPIRY_MS);
  assert.equal(await f.ctx.storage.getAlarm(),null);
});

test('a request held before commit keeps recovery after its first alarm and a rejected final setter',async t=>{
  const f=fixture(t),now=Date.now(),request=await reserveRelayCoreWake(f.ctx,now,100);
  // Hold the original request before its message transaction. An alarm cannot
  // infer abandonment from the first due time, or erase its recovery wake.
  const recovery=await beginRelayCoreAlarm(f.ctx,now+100);
  releaseRelayCoreWake(f.ctx,recovery);
  await scheduleRelayCoreAlarm(f.ctx,()=>null,now+100);
  assert.equal(await f.ctx.storage.getAlarm(),now+RELAY_PRECOMMIT_EXPIRY_MS);
  let committed=true;
  releaseRelayCoreWake(f.ctx,request);
  const set=f.ctx.storage.setAlarm;f.ctx.storage.setAlarm=async()=>{throw Error('Fictional postcommit alarm rejection');};
  await assert.rejects(scheduleRelayCoreAlarm(f.ctx,()=>committed?now+200:null,now+200),/postcommit/);
  assert.equal(await f.ctx.storage.getAlarm(),now+RELAY_PRECOMMIT_EXPIRY_MS);
  f.ctx.storage.setAlarm=set;
  const restarted={storage:f.ctx.storage};
  const alarm=await beginRelayCoreAlarm(restarted,now+RELAY_PRECOMMIT_EXPIRY_MS);
  assert.equal(committed,true,'The restarted recovery reaches the committed work');committed=false;
  releaseRelayCoreWake(restarted,alarm);
  await scheduleRelayCoreAlarm(restarted,()=>committed?now+200:null,now+RELAY_PRECOMMIT_EXPIRY_MS);
  assert.equal(await f.ctx.storage.getAlarm(),null);
});

test('failed wake admission removes only its reservation and bounds stalled concurrent admissions',async t=>{
  const f=fixture(t),now=Date.now(),first=await reserveRelayCoreWake(f.ctx,now,100);
  const set=f.ctx.storage.setAlarm;f.ctx.storage.setAlarm=async()=>{throw Error('Fictional alarm rejection');};
  await assert.rejects(reserveRelayCoreWake(f.ctx,now,200),/Fictional alarm rejection/);
  assert.deepEqual(f.rows('SELECT id FROM relay_core_alarm_wakes').map(row=>row.id),[first]);
  assert.equal(await f.ctx.storage.getAlarm(),now+100);
  f.ctx.storage.setAlarm=set;
  for(let index=1;index<256;index++)f.ctx.storage.sql.exec('INSERT INTO relay_core_alarm_wakes VALUES(?,?,?)','fictional-'+index,now+100,now+RELAY_PRECOMMIT_EXPIRY_MS);
  const writes=f.alarms.length;
  await assert.rejects(reserveRelayCoreWake(f.ctx,now,200),/admission is busy/);
  assert.equal(f.alarms.length,writes);assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')[0].n,256);
  const recovery=await beginRelayCoreAlarm(f.ctx,now+RELAY_PRECOMMIT_EXPIRY_MS);
  assert.equal(f.rows('SELECT COUNT(*) AS n FROM relay_core_alarm_wakes')[0].n,1);
  releaseRelayCoreWake(f.ctx,recovery);
});
