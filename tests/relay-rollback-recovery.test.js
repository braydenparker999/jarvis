import test from 'node:test';
import assert from 'node:assert/strict';
import {createDirectApi} from '../public/assets/direct-api.js';
import {createRollbackHarness,ROLLBACK_NOW as NOW,rollbackId as id,rollbackStamp as stamp,
  rollbackMessage as message,rollbackComment as comment} from './helpers/relay-rollback-recovery-harness.js';

const report=(requestId,n,extra={})=>({schema:'jarvis-coordination-v2',eventId:id(n),requestId,attemptId:id(n+100),stage:'final',
  body:'Fictional retained final '+n,artifacts:[],resultVersion:1,...extra});
const store=(h,path,body,old=false)=>h.control({op:'store',path:'/internal/shared/'+path,body,old});
const snapshot=h=>h.control({op:'snapshot'}).then(result=>result.body);
const adapter=h=>createDirectApi(input=>h.read(new URL(input).pathname+new URL(input).search),'https://rollback.example.test');

test('actual candidate to immutable c4 to candidate preserves pending v2 while old polling and saved pc2/exact/cache reads recover once', {timeout:60000},async t=>{
  const h=await createRollbackHarness(t);assert.equal(h.oldSource,'c4d62409a3b67e4e5dac88809c6a4a0290b6e39e');
  assert.equal((await h.control({op:'store',path:'/internal/shared/message',body:message(1),now:NOW})).status,201);
  const hold={id:id(2),replyTo:id(1),body:'Fictional immutable hold',createdAt:stamp};assert.equal((await store(h,'reply',hold)).status,201);
  const initial=await adapter(h)('/shared/state'),saved=structuredClone(initial.publicReader);
  const missing=report(id(4),3),first=report(id(1),9,{attemptId:id(10),artifacts:[{id:id(14),revision:1,label:'Fictional artifact',url:'https://example.test/rollback-r1'}]});
  const correction={...first,eventId:id(13),stage:'correction',supersedesEventId:first.eventId,resultVersion:2,
    body:'Fictional revised artifact',artifacts:[{...first.artifacts[0],revision:2,url:'https://example.test/rollback-r2'}]};
  await h.control({op:'sync',now:NOW+300001,comments:[comment(90001,missing),comment(90002,correction)]});
  let before=await snapshot(h);assert.deepEqual(before.imported.map(row=>row.imported),[-1,-1]);assert.equal(before.rollbackCompatible,true);
  const hint=await h.control({op:'hint',commentId:90002});assert.equal(hint.status,202);assert.equal(hint.body.status,'pending');assert.equal(hint.calls,0);
  await h.restart();assert.equal((await store(h,'message',message(6),true)).status,201);
  const reply={schema:'jarvis-publication-v1',type:'reply',id:id(7),replyTo:id(6),body:'Fictional rollback reply'};
  const briefing={schema:'jarvis-publication-v1',type:'briefing',id:id(8),title:'Fictional rollback briefing',body:'Fictional briefing content',date:'2026-10-01'};
  const old=await h.control({op:'sync',old:true,now:NOW+3600000,comments:[comment(90003,reply),comment(90004,briefing)]});
  assert.equal(old.calls,1,'The genuine old importer reaches its poll instead of treating pending v2 as briefing');
  assert.equal((await snapshot(h)).publisher.ok,true);assert.equal((await store(h,'message',message(4),true)).status,201);
  before=await snapshot(h);assert.deepEqual(before.imported.filter(row=>row.comment_id<90003).map(row=>row.imported),[-1,-1]);
  assert.equal(before.changes.filter(row=>[id(4),id(6),id(7),id(8)].includes(row.item_id)).length,4,
    'The retained native AFTER INSERT trigger journals actual c4 writes atomically');
  await h.restart();
  const recovered=await adapter(h)('/shared/state',{publicReader:saved});
  for(const entry of [id(4),id(6),id(7)])assert.equal(recovered.messages.filter(row=>row.id===entry).length,1);
  assert.equal(recovered.posts.filter(row=>row.id===id(8)).length,1);
  const exact=await (await h.read('/shared/result?requestId='+id(6))).json();assert.equal(exact.message.id,id(6));assert.equal(exact.reply.id,id(7));
  const resumed=await adapter(h)('/shared/state',{publicReader:structuredClone(recovered.publicReader)});
  assert.deepEqual(resumed.publicReader,recovered.publicReader,'A restored completed cache does not lose or duplicate old writes');
  const sync=await h.control({op:'sync',now:NOW+3900001,comments:[comment(90005,first)]});assert.equal(sync.calls,1);
  const result=await (await h.read('/shared/result?requestId='+id(1))).json();
  assert.equal(result.reply.id,hold.id);assert.equal(result.reply.body,hold.body);
  assert.deepEqual(result.events.map(event=>event.eventId),[first.eventId,correction.eventId]);
  assert.equal(result.events.at(-1).artifacts[0].revision,2);
  const complete=await snapshot(h);assert.deepEqual(complete.imported.map(row=>row.imported),[1,1,1,1,1]);
  const immutable=complete.events.map(row=>[row.event_id,row.payload,row.provenance]);
  await h.control({op:'sync',now:NOW+4200002,comments:[comment(90006,first)]});
  assert.deepEqual((await snapshot(h)).events.map(row=>[row.event_id,row.payload,row.provenance]),immutable,'Canonical replay keeps event identity and authenticated provenance');
  for(const entry of [id(1),id(2),id(3),id(4),id(6),id(7),id(8)])
    assert.equal(complete.changes.filter(row=>row.kind==='entry'&&row.item_id===entry).length,1);
  assert.equal(h.external,0);
});

test('completed historical flags force bounded reindex, atomic trigger installation, no-browser restart resume and stable saved cursors', {timeout:60000},async t=>{
  const h=await createRollbackHarness(t);
  assert.equal((await h.control({op:'store',path:'/internal/shared/message',body:message(1),now:NOW})).status,201);
  const initial=await adapter(h)('/shared/state'),saved=structuredClone(initial.publicReader);
  assert.equal((await snapshot(h)).ready,true);
  await h.control({op:'remove-index-version'});
  await h.control({op:'old-burst',start:1000,count:251});
  let state=await snapshot(h);assert.equal(state.entries.length,252);assert.equal(state.changes.length,1);
  await h.restart();
  const failed=await h.control({op:'schema',failKey:'public-entry-index-version'});assert.match(failed.body.error,/interrupted checkpoint/);
  state=await snapshot(h);assert.equal(state.triggers.includes('public_changes_entry_insert'),false);assert.equal(state.checkpoint,null,
    'Trigger, readiness and reindex watermark roll back in the same real native SQL transaction');
  assert.equal((await h.control({op:'schema'})).body.error,null);
  state=await snapshot(h);assert.deepEqual(state.checkpoint,{entryAfter:0,eventAfter:0,throughEntry:252,throughEvent:0});assert.equal(state.ready,false);
  const cold=await h.read('/shared/changes?cursor='+saved.cursor);assert.equal(cold.status,503);
  const body=await cold.json();assert.equal(body.code,'public_history_initializing');assert.equal(body.cursor,undefined);
  state=await snapshot(h);assert.equal(state.checkpoint.entryAfter,100);assert.equal(state.changes.length,100);
  assert.equal((await store(h,'message',message(9000),true)).status,201,'Old writes during repair use the newly installed persistent trigger');
  state=await snapshot(h);assert.equal(state.checkpoint.throughEntry,252,'The old repair snapshot remains frozen');
  assert.equal(state.changes.filter(row=>row.item_id===id(9000)).length,1);
  await h.restart();await h.control({op:'alarm',now:NOW+60000});
  state=await snapshot(h);assert.equal(state.checkpoint.entryAfter,200);assert.equal(state.ready,false);
  await h.restart();await h.control({op:'alarm',now:NOW+120000});
  state=await snapshot(h);assert.equal(state.checkpoint,null);assert.equal(state.ready,true);assert.equal(state.changes.length,253);
  const recovered=await adapter(h)('/shared/state',{publicReader:saved});assert.equal(recovered.messages.length,253);
  assert.equal(new Set(recovered.messages.map(row=>row.id)).size,253);
  assert.equal(recovered.publicReader.changes.find(row=>row.entry?.id===id(1)).sequence,initial.publicReader.changes[0].sequence,
    'Existing accepted journal sequence and saved cursor survive repair');
  const complete=await adapter(h)('/shared/state',{publicReader:structuredClone(recovered.publicReader)});assert.deepEqual(complete.publicReader,recovered.publicReader);
  assert.equal(h.external,0);
});

test('retained unsafe zero-pending conversion is indexed, <=600 attempts per pass, transactional and restartable before declaring old rollback compatible', {timeout:60000},async t=>{
  const h=await createRollbackHarness(t);await h.control({op:'seed-unsafe',count:1501,now:NOW});
  await h.control({op:'prepare-unsafe'});let state=await snapshot(h);
  assert.deepEqual(state.compatibility,{after:0,through:1501,complete:false});assert.equal(state.rollbackCompatible,false);
  const failed=await h.control({op:'interrupt-compatibility',now:NOW});assert.equal(failed.calls,0);
  state=await snapshot(h);assert.equal(state.compatibility.after,0);assert.equal(state.imported.filter(row=>row.imported===0).length,1501,
    'An interruption after retags restores both dispositions and examined checkpoint');
  assert.equal(state.rollbackCompatible,false);
  let passes=0;
  for(;passes<8;passes++){
    await h.restart();const work=await h.control({op:'sync',now:NOW+(passes+1)*60000});
    const pendingQueries=work.queries.filter(row=>/^SELECT \* FROM imported_comments WHERE imported=(?:0|-1) AND comment_id>/.test(row.query));
    assert.ok(pendingQueries.every(row=>row.rowsRead<=100));
    const previous=state.pendingWork?.hourly||0;state=await snapshot(h);
    assert.ok(state.pendingWork.hourly-previous<=600,'Cleanup plus direct and retry application share the original bounded attempt allowance');
    assert.equal(state.compatibility.through,1501);
    if(state.rollbackCompatible)break;
    assert.equal(state.compatibility.complete,false);assert.equal(state.imported.some(row=>row.imported===0),true);
  }
  assert.ok(passes>=2&&passes<8);assert.equal(state.rollbackCompatible,true);
  assert.equal(state.imported.filter(row=>row.imported===-1).length,1501);assert.equal(state.imported.some(row=>row.imported===0),false);
  const plans=(await h.control({op:'pending-plan'})).body;
  for(const item of plans){assert.ok(item.plan.some(row=>row.detail.includes('imported_comments_status')));assert.equal(item.plan.some(row=>/TEMP B-TREE|SCAN imported_comments/.test(row.detail)),false);}
  const old=await h.control({op:'sync',old:true,now:NOW+3600000,comments:[]});assert.equal(old.calls,1);
  const hint=await h.control({op:'hint',commentId:1400});assert.equal(hint.status,202);assert.equal(hint.body.status,'pending');assert.equal(hint.calls,0);
  assert.equal(h.external,0);
});

test('an original partial checkpoint preserves its examined prefix, extends the frozen old append bound once, and rolls back an interrupted repair batch', {timeout:60000},async t=>{
  const h=await createRollbackHarness(t);
  await h.control({op:'store',path:'/internal/shared/message',body:message(1),now:NOW});
  await adapter(h)('/shared/state');await h.control({op:'remove-index-version'});
  await h.control({op:'old-burst',start:1000,count:251});await h.control({op:'old-partial-index',after:100,through:252});
  assert.equal((await store(h,'message',message(9000),true)).status,201);
  const prefix=(await snapshot(h)).changes;
  await h.restart();await h.control({op:'schema'});let state=await snapshot(h);
  assert.deepEqual(state.checkpoint,{entryAfter:100,eventAfter:0,throughEntry:253,throughEvent:0});assert.equal(state.ready,false);
  assert.deepEqual(state.changes,prefix,'Installing the trigger never rewrites the accepted examined prefix');
  const failure=await h.control({op:'interrupt-backfill'});assert.match(failure.body.error,/interrupted checkpoint/);
  state=await snapshot(h);assert.equal(state.checkpoint.entryAfter,100);assert.deepEqual(state.changes,prefix,
    'Native rollback removes all journal entries in the faulted page together with its uncommitted checkpoint');
  assert.equal((await store(h,'message',message(9001),true)).status,201);
  await h.restart();const second=await h.control({op:'backfill',limit:10000});assert.equal(second.body.examined,100);
  state=await snapshot(h);assert.equal(state.checkpoint.entryAfter,200);assert.equal(state.checkpoint.throughEntry,253);
  await h.restart();const final=await h.control({op:'backfill',limit:10000});assert.equal(final.body.examined,53);assert.equal(final.body.complete,true);
  state=await snapshot(h);assert.equal(state.changes.length,254);assert.equal(new Set(state.changes.map(row=>row.item_id)).size,254);
  assert.deepEqual(state.changes.slice(0,prefix.length),prefix);assert.equal(h.external,0);
});

test('native mixed v1/v2 dependency scans merge indexed ranges in exact global comment order with at most twice the selected page reads', {timeout:60000},async t=>{
  const h=await createRollbackHarness(t);await h.control({op:'seed-mixed',count:1001,now:NOW});
  for(let page=1;page<=7;page++){
    const result=await h.control({op:'pending-batch'});assert.equal(result.body.examined,100);assert.equal(result.body.cursor,page*100);
    const ranges=result.queries.filter(row=>/^SELECT \* FROM imported_comments WHERE imported=(?:0|-1) AND comment_id>/.test(row.query));
    assert.equal(ranges.length,2);assert.ok(ranges.every(row=>row.rowsRead<=100));assert.ok(ranges.reduce((sum,row)=>sum+row.rowsRead,0)<=200);
    assert.equal(result.calls,0);
  }
  const state=await snapshot(h);assert.equal(state.imported.at(-1).imported,-2,'Unsupported negative dispositions are not part of the pending category');
  assert.equal(state.pendingWork.hourly,700);assert.equal(state.events.length,0);assert.equal(h.external,0);
});
