import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {relayAccountAdmissionHash as hash, RELAY_ACCOUNT_ADMISSION_LIMITS as LIMITS} from '../backend/relay-account-admission.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const configuration = JSON.parse(readFileSync(new URL('../backend/wrangler.jsonc', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-09T11:00:00Z');
const cost = (rowsRead = 1, rowsWritten = 1, storedBytes = 1) => ({rowsRead, rowsWritten, storedBytes});
function plan(scopes = 2, maxReservations = 16) {
  return {v: 1, planId: 'fictional_native_plan', day: '2026-10-09', sourceHash: 'a'.repeat(64), catalogHash: 'b'.repeat(64),
    account: {identityHash: 'c'.repeat(64), evidenceHash: 'd'.repeat(64), capturedAt: NOW, used: cost(10, 10, 10), limit: cost(1000000, 1000000, 10000000)},
    scopes: Array.from({length: scopes}, (_, i) => ({id: 'scope_' + i, identityHash: 'e'.repeat(64), preparation: cost(10000, 10000, 100000), ordinary: cost(10000, 10000, 100000)})),
    coordination: {maxReservations, maxRejections: 4, storedBytes: LIMITS.ledgerBytes + LIMITS.sealBytes}, final: {construction: cost(10000, 10000, 100000)}};
}
const reservation = (p, id, scope = p.scopes[0].id, lane = 'preparation') => ({planId: p.planId, day: p.day, scope, lane, id, payloadHash: 'f'.repeat(64), cost: cost()});
async function finalInput(p, receipts) {
  const reports = p.scopes.map(scope => ({scope: scope.id, reportHash: '1'.repeat(64), preparationIds: receipts.filter(r => r.scope === scope.id).map(r => r.id), constructionCost: cost(2, 2, 2)}));
  return {planId: p.planId, day: p.day, id: 'FINAL', payloadHash: '2'.repeat(64), sourceHash: p.sourceHash, catalogHash: p.catalogHash,
    reportsHash: await hash(reports), reports, constructionCost: cost(2 * p.scopes.length, 2 * p.scopes.length, 2 * p.scopes.length)};
}
const fixture = `
import {RelayAccountAdmission,RELAY_ACCOUNT_ADMISSION_KEYS as KEYS,consumeRelayAccountReservation,accountAdmissionPlan,accountAdmissionCoordinationEnvelope} from './backend/relay-account-admission.js';
const binding=r=>Object.fromEntries(['planId','day','scope','lane','id','payloadHash','sourceHash','catalogHash','reportsHash'].map(k=>[k,r[k]]));
export class AllocatorFixture {
 constructor(ctx){
  this.ctx=ctx;this.metrics={transactions:0,kvGets:0,kvPuts:0,jsonPutBytes:0,sql:0,egress:0};this.handles=new Map();this.fail=false;
  const metrics=this.metrics;
  this.measured={storage:{get sql(){metrics.sql++;throw Error('Native allocator SQL forbidden');},transaction:fn=>ctx.storage.transaction(async txn=>{
   metrics.transactions++;
   const result=await fn({get:async key=>{metrics.kvGets++;return txn.get(key);},put:async(key,value)=>{
    metrics.kvPuts+=typeof key==='string'?1:Object.keys(key).length;
    metrics.jsonPutBytes+=new TextEncoder().encode(JSON.stringify(typeof key==='string'?value:key)).byteLength;
    return txn.put(key,value);
   }});
   if(this.fail){this.fail=false;throw Error('Fictional transaction rejection before commit');}return result;
  })}};this.engine=new RelayAccountAdmission(this.measured);
 }
 async fetch(request){
  const input=await request.json();for(const key of Object.keys(this.metrics))this.metrics[key]=0;
  const now=input.now;let result;
  if(input.op==='provision')result=await this.engine.provision(input.plan,now);
  else if(input.op==='reserve'||input.op==='final'){
   result=input.op==='final'?await this.engine.reserveFinal(input.input,now):await this.engine.reserve(input.input,now);
   if(result.status==='granted')this.handles.set(result.id,result);
  }else if(input.op==='concurrent'){
   result=await Promise.all(Array.from({length:input.count},()=>this.engine.reserve(input.input,now)));
   for(const r of result)if(r.status==='granted')this.handles.set(r.id,r);
  }else if(input.op==='consume'){
   const r=this.handles.get(input.id);result=consumeRelayAccountReservation(r,r?binding(r):{},now);
  }else if(input.op==='inspect')result=await this.engine.inspect(now);
  else if(input.op==='public'){const response=await this.engine.fetch(request);result={status:response.status,...await response.json()};}
  else if(input.op==='reload'){this.engine=new RelayAccountAdmission(this.measured);this.handles.clear();result={status:'reloaded'};}
  else if(input.op==='lose'){
   await this.ctx.storage.delete(KEYS.ledger);result=await this.engine.inspect(now);
  }else if(input.op==='corrupt'){
   const state=await this.ctx.storage.get(KEYS.ledger);state.entries[0].receipt.extra=true;await this.ctx.storage.put(KEYS.ledger,state);
   result=await this.engine.inspect(now);
  }else if(input.op==='fail'){
   this.fail=true;result=await this.engine.reserve(input.input,now);
  }else if(input.op==='revoke')result=await this.engine.revoke(now);
  const state=await this.ctx.storage.get(KEYS.ledger);
  return Response.json({result,metrics:this.metrics,cache:accountAdmissionPlan(this.engine),coordinationEnvelope:accountAdmissionCoordinationEnvelope(this.engine),ledgerBytes:state?new TextEncoder().encode(JSON.stringify(state)).byteLength:0});
 }
}
export default {fetch(request,env){const name=new URL(request.url).pathname.slice(1)||'fictional';return env.ALLOCATOR.get(env.ALLOCATOR.idFromName(name)).fetch(request);}};
`;
async function native(t, persist = false) {
  const compiled = await build({stdin: {contents: fixture, resolveDir: root, sourcefile: 'fictional-allocator.js'}, bundle: true, format: 'esm', platform: 'browser', write: false});
  const directory = persist ? mkdtempSync(join(tmpdir(), 'jarvis-account-kv-')) : null;
  let mf;
  async function start() {
    const options = convertV4MiniflareOptions({name: 'fictional-account-native', modules: true, script: compiled.outputFiles[0].text,
      compatibilityDate: configuration.compatibility_date, compatibilityFlags: configuration.compatibility_flags || [], cf: false,
      telemetry: {enabled: false}, durableObjects: {ALLOCATOR: {className: 'AllocatorFixture', useSQLite: false}},
      outboundService() {throw Error('Fictional provider egress forbidden');}});
    if (directory) options.resourcePersistencePath = directory;
    mf = new Miniflare(options);
  }
  await start();
  t.after(async () => {await mf.dispose(); if (directory) rmSync(directory, {recursive: true, force: true});});
  return {async call(op, values = {}, name = 'fictional') {
    const response = await mf.dispatchFetch('https://local.test/' + name, {method: 'POST', body: JSON.stringify({op, now: NOW, ...values})});
    assert.equal(response.status, 200); const value = await response.json(); assert.equal(value.metrics.sql, 0); assert.equal(value.metrics.egress, 0); return value;
  }, async restart() {await mf.dispose(); await start();}};
}

test('native legacy-KV allocator has closed public ingress and atomic idempotent concurrency', async t => {
  const n = await native(t), p = plan();
  const closed = await n.call('public'); assert.equal(closed.result.reason, 'upstream_invocation_gate_unavailable');
  assert.deepEqual(closed.metrics, {transactions: 0, kvGets: 0, kvPuts: 0, jsonPutBytes: 0, sql: 0, egress: 0});
  const initialized = await n.call('provision', {plan: p}); assert.equal(initialized.result.status, 'provisioned'); assert.equal(initialized.metrics.kvGets, 2); assert.equal(initialized.metrics.kvPuts, 2);
  const concurrent = await n.call('concurrent', {input: reservation(p, 'same'), count: 12});
  assert.equal(concurrent.result.filter(r => r.status === 'granted').length, 1); assert.equal(concurrent.result.filter(r => r.status === 'duplicate').length, 11);
  assert.equal(concurrent.metrics.kvGets, 24); assert.equal(concurrent.metrics.kvPuts, 1);
  assert.equal((await n.call('consume', {id: 'same'})).result.status, 'granted'); assert.equal((await n.call('consume', {id: 'same'})).result.status, 'blocked');
  const duplicate = await n.call('reserve', {input: reservation(p, 'same')}); assert.equal(duplicate.result.status, 'duplicate'); assert.equal(duplicate.metrics.kvPuts, 0);
  assert.equal(duplicate.metrics.kvGets, 2);
});
test('native persisted process restart/lost receipt retains debit and refuses replay authority', async t => {
  const n = await native(t, true), p = plan(); await n.call('provision', {plan: p}); await n.call('reserve', {input: reservation(p, 'lost_response')});
  await n.restart(); const duplicate = await n.call('reserve', {input: reservation(p, 'lost_response')});
  assert.equal(duplicate.result.status, 'duplicate'); assert.equal(duplicate.metrics.kvPuts, 0); assert.equal(duplicate.cache.counters.reservations, 1);
  assert.equal((await n.call('consume', {id: 'lost_response'})).result.status, 'blocked');
  const next = await n.call('reserve', {input: reservation(p, 'new_paid_attempt')}); assert.equal(next.result.attempt, 2); assert.equal(next.cache.spent.rowsRead, 2);
});
test('native transaction rollback ACK failure invalidates cached authority and retains only prior paid work', async t => {
  const n = await native(t), p = plan(); await n.call('provision', {plan: p}); await n.call('reserve', {input: reservation(p, 'outstanding')});
  const failed = await n.call('fail', {input: reservation(p, 'rollback')}); assert.equal(failed.result.reason, 'account_storage_unavailable'); assert.equal(failed.cache, null);
  assert.equal((await n.call('consume', {id: 'outstanding'})).result.status, 'blocked');
  const inspected = await n.call('inspect'); assert.equal(inspected.result.counters.reservations, 1); assert.equal(inspected.result.spent.rowsRead, 1);
  assert.equal(inspected.metrics.kvPuts, 0);
});
test('native loss/corruption/revocation refuse existing receipts and never recreate source or account ledger', async t => {
  const n = await native(t), p = plan();
  for (const op of ['lose', 'corrupt', 'revoke']) {
    await n.call('provision', {plan: p}, op); await n.call('reserve', {input: reservation(p, 'outstanding')}, op);
    const denied = await n.call(op, {}, op); assert.equal(denied.cache, null);
    assert.equal(denied.coordinationEnvelope, null);
    assert.equal((await n.call('consume', {id: 'outstanding'}, op)).result.status, 'blocked');
    assert.equal((await n.call('provision', {plan: p}, op)).result.reason, 'account_already_provisioned');
    const warm = await n.call('inspect', {}, op); assert.equal(warm.metrics.kvGets, 0); assert.equal(warm.metrics.kvPuts, 0);
  }
});
test('native finite ordinary flood leaves all mandatory preparation and FINAL capacity paid atomically', async t => {
  const n = await native(t), p = plan(3, 8), receipts = []; await n.call('provision', {plan: p});
  receipts.push((await n.call('reserve', {input: reservation(p, 'first')})).result);
  for (let i = 0; i < 4; i++) assert.equal((await n.call('reserve', {input: reservation(p, 'ordinary_' + i, p.scopes[0].id, 'ordinary')})).result.status, 'granted');
  assert.equal((await n.call('reserve', {input: reservation(p, 'flood', p.scopes[0].id, 'ordinary')})).result.reason, 'account_coordination_exhausted');
  for (const scope of p.scopes.slice(1)) receipts.push((await n.call('reserve', {input: reservation(p, 'prep_' + scope.id, scope.id)})).result);
  const input = await finalInput(p, receipts); const zero = structuredClone(input); zero.constructionCost = cost(0, 0, 0);
  const zeroDenied = await n.call('final', {input: zero}); assert.equal(zeroDenied.result.status, 'blocked'); assert.equal(zeroDenied.metrics.kvGets, 0); assert.equal(zeroDenied.metrics.kvPuts, 0);
  const final = await n.call('final', {input}); assert.equal(final.result.status, 'granted'); assert.equal(final.cache.counters.reservations, 8);
  assert.deepEqual(final.coordinationEnvelope.admittedTotal, {kvGets: 28, kvPuts: 15});
  assert.equal(final.coordinationEnvelope.providerBillingMapping, 'unknown');
  assert.equal(final.cache.spent.rowsRead, 13); assert.equal(final.metrics.kvGets, 2); assert.equal(final.metrics.kvPuts, 1); assert.ok(final.ledgerBytes <= LIMITS.ledgerBytes);
  const duplicate = await n.call('final', {input}); assert.equal(duplicate.result.status, 'duplicate'); assert.equal(duplicate.metrics.kvPuts, 0);
  t.diagnostic(JSON.stringify({fixture: 'local fictional legacy-KV Durable Object', provision: {gets: 2, puts: 2}, accepted: {gets: 2, puts: 1}, final: {gets: final.metrics.kvGets, puts: final.metrics.kvPuts, ledgerJsonBytes: final.ledgerBytes}, duplicate: {gets: duplicate.metrics.kvGets, puts: duplicate.metrics.kvPuts}, sqlAccess: 0, egress: 0, platformInvocationBound: 'unknown; activation closed'}));
});
