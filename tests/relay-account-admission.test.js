import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RelayAccountAdmission, RELAY_ACCOUNT_ADMISSION_KEYS as KEYS,
  RELAY_ACCOUNT_ADMISSION_LIMITS as LIMITS, relayAccountAdmissionHash as hash,
  relayAccountAdmissionPlanProblem, accountAdmissionPlan, accountAdmissionPreparationIds,
  accountAdmissionCoordinationEnvelope,
  consumeRelayAccountReservation, isRelayAccountAdmission,
} from '../backend/relay-account-admission.js';

const NOW = Date.parse('2026-10-09T11:00:00Z');
const cost = (rowsRead = 1, rowsWritten = 1, storedBytes = 1) => ({rowsRead, rowsWritten, storedBytes});
const clone = value => structuredClone(value);
function plan(scopeCount = 2, maxReservations = 16) {
  return {v: 1, planId: 'fictional_plan', day: '2026-10-09', sourceHash: 'a'.repeat(64), catalogHash: 'b'.repeat(64),
    account: {identityHash: 'c'.repeat(64), evidenceHash: 'd'.repeat(64), capturedAt: NOW, used: cost(10, 10, 10), limit: cost(1000000, 1000000, 10000000)},
    scopes: Array.from({length: scopeCount}, (_, i) => ({id: 'scope_' + i, identityHash: 'e'.repeat(64), preparation: cost(10000, 10000, 100000), ordinary: cost(10000, 10000, 100000)})),
    coordination: {maxReservations, maxRejections: 8, storedBytes: LIMITS.ledgerBytes + LIMITS.sealBytes}, final: {construction: cost(10000, 10000, 100000)}};
}
function store() {
  const data = new Map(), metrics = {get: 0, put: 0, transactions: 0, sql: 0}, state = {failCommit: false};
  let tail = Promise.resolve();
  const storage = {get sql() {metrics.sql++; throw Error('SQL forbidden');}, transaction(fn) {
    const action = tail.then(async () => {
      metrics.transactions++; const next = new Map([...data].map(([key, value]) => [key, clone(value)]));
      const result = await fn({async get(key) {metrics.get++; return clone(next.get(key));}, async put(key, value) {
        metrics.put += typeof key === 'string' ? 1 : Object.keys(key).length;
        if (typeof key === 'string') next.set(key, clone(value)); else for (const [name, item] of Object.entries(key)) next.set(name, clone(item));
      }});
      if (state.failCommit) {state.failCommit = false; throw Error('Fictional commit rejection');}
      data.clear(); for (const [key, value] of next) data.set(key, value); return result;
    }); tail = action.catch(() => {}); return action;
  }};
  return {data, metrics, state, ctx: {storage}, engine: new RelayAccountAdmission({storage})};
}
function reservation(p, id, scope = p.scopes[0].id, lane = 'preparation', debit = cost()) {
  return {planId: p.planId, day: p.day, scope, lane, id, payloadHash: 'f'.repeat(64), cost: debit};
}
const binding = receipt => Object.fromEntries(['planId', 'day', 'scope', 'lane', 'id', 'payloadHash', 'sourceHash', 'catalogHash', 'reportsHash'].map(key => [key, receipt[key]]));
async function finalInput(p, preparations, id = 'final') {
  const reports = p.scopes.map(scope => ({scope: scope.id, reportHash: '1'.repeat(64), preparationIds: preparations.filter(r => r.scope === scope.id).map(r => r.id), constructionCost: cost(2, 2, 2)}));
  return {planId: p.planId, day: p.day, id, payloadHash: '2'.repeat(64), sourceHash: p.sourceHash, catalogHash: p.catalogHash,
    reportsHash: await hash(reports), reports, constructionCost: cost(p.scopes.length * 2, p.scopes.length * 2, p.scopes.length * 2)};
}
async function prepared(s, p) {
  assert.equal((await s.engine.provision(p, NOW)).status, 'provisioned');
  const receipts = []; for (const scope of p.scopes) receipts.push(await s.engine.reserve(reservation(p, 'prep_' + scope.id, scope.id), NOW));
  return receipts;
}

test('inactive constructor and public fetch refuse without any storage, SQL or body work', async () => {
  const s = store(); assert.equal(isRelayAccountAdmission(s.engine), true); assert.equal(isRelayAccountAdmission({reserve() {}}), false);
  for (let n = 0; n < 20; n++) assert.equal((await s.engine.fetch({json() {throw Error('Body forbidden');}})).status, 503);
  assert.deepEqual(s.metrics, {get: 0, put: 0, transactions: 0, sql: 0});
});
test('unknown/lost durable state never initializes zero, and retained seal refuses reprovisioning', async () => {
  const s = store(), p = plan(); assert.equal((await s.engine.inspect(NOW)).reason, 'account_state_unknown');
  const coldGets = s.metrics.get; assert.equal((await s.engine.inspect(NOW)).reason, 'account_state_unknown'); assert.equal(s.metrics.get, coldGets);
  s.engine = new RelayAccountAdmission(s.ctx); assert.equal((await s.engine.provision(p, NOW)).status, 'provisioned');
  s.data.delete(KEYS.ledger); s.engine = new RelayAccountAdmission(s.ctx);
  assert.equal((await s.engine.inspect(NOW)).reason, 'account_state_unknown');
  assert.equal((await s.engine.provision(p, NOW)).reason, 'account_already_provisioned'); assert.equal(s.data.has(KEYS.ledger), false);
});
test('plans reject stale/day/identity/unknown fields, overflow, zero mandatory costs and impossible slots', () => {
  const p = plan(); assert.equal(relayAccountAdmissionPlanProblem(p, NOW), null);
  for (const mutate of [x => x.day = '2026-10-08', x => x.account.capturedAt -= 300001, x => x.account.identityHash = 'unknown',
    x => x.extra = true, x => x.final.construction = cost(0, 0, 0), x => x.scopes[0].preparation = cost(0, 0, 0),
    x => x.coordination.maxReservations = 2, x => x.coordination.storedBytes = 1,
    x => x.scopes[0].ordinary.rowsRead = Number.MAX_SAFE_INTEGER]) {
    const bad = clone(p); mutate(bad); assert.notEqual(relayAccountAdmissionPlanProblem(bad, NOW), null);
  }
});
test('concurrent exact-payload reservations are charged once and replay cannot mint execution authority', async () => {
  const s = store(), p = plan(); await s.engine.provision(p, NOW); const input = reservation(p, 'same');
  const results = await Promise.all(Array.from({length: 16}, () => s.engine.reserve(input, NOW)));
  assert.equal(results.filter(x => x.status === 'granted').length, 1); assert.equal(results.filter(x => x.status === 'duplicate').length, 15);
  const receipt = results.find(x => x.status === 'granted'); assert.equal(consumeRelayAccountReservation(receipt, binding(receipt), NOW).status, 'granted');
  assert.equal(consumeRelayAccountReservation(receipt, binding(receipt), NOW).status, 'blocked');
  for (const duplicate of results.filter(x => x.status === 'duplicate')) assert.equal(consumeRelayAccountReservation(duplicate, binding(duplicate), NOW).status, 'blocked');
  const writes = s.metrics.put; const duplicate = await new RelayAccountAdmission(s.ctx).reserve(input, NOW);
  assert.equal(duplicate.status, 'duplicate'); assert.equal(s.metrics.put, writes); assert.equal(s.data.get(KEYS.ledger).counters.reservations, 1);
  assert.equal((await s.engine.reserve({...input, payloadHash: '3'.repeat(64)}, NOW)).reason, 'account_payload_conflict');
});
test('lost response/reload preserve paid attempts and source work requires a new one-use grant', async () => {
  const s = store(), p = plan(); await s.engine.provision(p, NOW); await s.engine.reserve(reservation(p, 'lost'), NOW);
  const reloaded = new RelayAccountAdmission(s.ctx); const duplicate = await reloaded.reserve(reservation(p, 'lost'), NOW);
  assert.equal(duplicate.status, 'duplicate'); assert.equal(consumeRelayAccountReservation(duplicate, binding(duplicate), NOW).status, 'blocked');
  const next = await reloaded.reserve(reservation(p, 'next'), NOW); assert.equal(next.attempt, 2);
  assert.deepEqual(accountAdmissionPreparationIds(reloaded, p.scopes[0].id), ['lost', 'next']);
  assert.equal(accountAdmissionPlan(reloaded).spent.rowsRead, 2); assert.equal(s.metrics.sql, 0);
});
test('receipt rejects copied/altered binding, TTL and evidence expiry without admitting source work', async () => {
  const s = store(), p = plan(); await s.engine.provision(p, NOW);
  let r = await s.engine.reserve(reservation(p, 'copied'), NOW); assert.equal(consumeRelayAccountReservation(clone(r), binding(r), NOW).status, 'blocked');
  assert.equal(consumeRelayAccountReservation(r, {...binding(r), sourceHash: '3'.repeat(64)}, NOW).status, 'blocked');
  r = await s.engine.reserve(reservation(p, 'expired'), NOW); assert.equal(consumeRelayAccountReservation(r, binding(r), NOW + 30001).status, 'blocked');
  r = await s.engine.reserve(reservation(p, 'evidence'), NOW + 299990); assert.equal(r.status, 'granted');
  assert.equal(consumeRelayAccountReservation(r, binding(r), NOW + 300001).status, 'blocked');
});
test('observed ledger loss, revocation and commit failure invalidate outstanding authority without refund', async () => {
  for (const kind of ['loss', 'revoke', 'commit']) {
    const s = store(), p = plan(); await s.engine.provision(p, NOW); const r = await s.engine.reserve(reservation(p, 'outstanding'), NOW);
    if (kind === 'loss') {s.data.delete(KEYS.ledger); assert.equal((await s.engine.inspect(NOW)).reason, 'account_state_unknown');}
    else if (kind === 'revoke') assert.equal((await s.engine.revoke(NOW)).status, 'revoked');
    else {s.state.failCommit = true; assert.equal((await s.engine.reserve(reservation(p, 'failed'), NOW)).reason, 'account_storage_unavailable'); assert.equal(s.data.get(KEYS.ledger).counters.reservations, 1);}
    assert.equal(accountAdmissionPlan(s.engine), null); assert.equal(consumeRelayAccountReservation(r, binding(r), NOW).status, 'blocked');
  }
});
test('failed provision ACK cannot leave a cached provisioned plan', async () => {
  const s = store(); s.state.failCommit = true; assert.equal((await s.engine.provision(plan(), NOW)).reason, 'account_storage_unavailable');
  assert.equal(accountAdmissionPlan(s.engine), null); assert.equal(s.data.size, 0);
  assert.equal((await s.engine.inspect(NOW)).reason, 'account_state_unknown');
});
test('strict durable hydration refuses corrupt/extra receipt fields, counters, attempts, costs and plan seal', async () => {
  for (const mutate of [state => state.entries[0].receipt.extra = true, state => state.entries[0].receipt.attempt = 8,
    state => state.entries[0].receipt.payloadHash = 'unknown', state => state.entries[0].receipt.issuedAt = NOW + 1,
    state => state.entries[0].receipt.cost.rowsRead = 0, state => state.scopesSpent[0].preparationAttempts = 0,
    state => state.counters.reservations = 0, state => state.plan.account.limit.rowsRead++]) {
    const s = store(), p = plan(); await s.engine.provision(p, NOW); await s.engine.reserve(reservation(p, 'original'), NOW);
    const state = s.data.get(KEYS.ledger); mutate(state); const reload = new RelayAccountAdmission(s.ctx);
    const before = s.metrics.put; assert.equal((await reload.inspect(NOW)).reason, 'account_state_unknown'); assert.equal(s.metrics.put, before);
  }
});
test('FINAL atomically prepays positive remaining construction with exact all-scope report and preparation binding', async () => {
  const s = store(), p = plan(); const preparations = await prepared(s, p); const input = await finalInput(p, preparations);
  const receipt = await s.engine.reserveFinal(input, NOW); assert.equal(receipt.status, 'granted'); assert.equal(receipt.lane, 'final');
  assert.deepEqual(receipt.cost, cost(4, 4, 4)); assert.equal(accountAdmissionPlan(s.engine).spent.rowsRead, 6);
  assert.equal(consumeRelayAccountReservation(receipt, binding(receipt), NOW).status, 'granted');
  const writes = s.metrics.put; const duplicate = await s.engine.reserveFinal(input, NOW); assert.equal(duplicate.status, 'duplicate');
  assert.equal(s.metrics.put, writes); assert.equal(consumeRelayAccountReservation(duplicate, binding(duplicate), NOW).status, 'blocked');
});
test('zero/mismatched/unknown FINAL reports cannot reserve construction or authorize DDL', async () => {
  const mutations = [x => x.constructionCost = cost(0, 0, 0), x => x.reports[0].constructionCost = cost(0, 0, 0),
    x => x.sourceHash = '9'.repeat(64), x => x.catalogHash = '9'.repeat(64), x => x.reportsHash = '9'.repeat(64),
    x => x.reports[0].preparationIds = ['not_paid'], x => x.reports.pop(), x => x.constructionCost.rowsRead++, x => x.extra = true];
  for (const mutate of mutations) {const s = store(), p = plan(); const preparations = await prepared(s, p); const input = await finalInput(p, preparations); mutate(input);
    assert.equal((await s.engine.reserveFinal(input, NOW)).status, 'blocked'); assert.equal(s.data.get(KEYS.ledger).final, null); assert.equal(s.data.get(KEYS.ledger).counters.reservations, 2);}
});
test('ordinary/preparation floods preserve mandatory first preparation slots and FINAL at coordination cap', async () => {
  const s = store(), p = plan(3, 8); await s.engine.provision(p, NOW);
  const preparations = []; preparations.push(await s.engine.reserve(reservation(p, 'first'), NOW));
  for (let n = 0; n < 4; n++) assert.equal((await s.engine.reserve(reservation(p, 'ordinary_' + n, p.scopes[0].id, 'ordinary'), NOW)).status, 'granted');
  assert.equal((await s.engine.reserve(reservation(p, 'flood', p.scopes[0].id, 'ordinary'), NOW)).reason, 'account_coordination_exhausted');
  assert.equal((await s.engine.reserve(reservation(p, 'repeated'), NOW)).reason, 'account_coordination_exhausted');
  for (const scope of p.scopes.slice(1)) {const r = await s.engine.reserve(reservation(p, 'prep_' + scope.id, scope.id), NOW); assert.equal(r.status, 'granted'); preparations.push(r);}
  const final = await s.engine.reserveFinal(await finalInput(p, preparations), NOW); assert.equal(final.status, 'granted');
  assert.equal(s.data.get(KEYS.ledger).counters.reservations, 8); assert.ok(Buffer.byteLength(JSON.stringify(s.data.get(KEYS.ledger))) <= LIMITS.ledgerBytes);
});
test('conservative ledger byte cap leaves FINAL and every missing preparation report record available', async () => {
  const s = store(), p = plan(16, 128); await s.engine.provision(p, NOW); const preparations = [];
  for (const scope of p.scopes) {const r = await s.engine.reserve(reservation(p, 'prep_' + scope.id, scope.id), NOW); assert.equal(r.status, 'granted'); preparations.push(r);}
  let grants = 0, reason;
  for (let n = 0; n < 128; n++) {const r = await s.engine.reserve(reservation(p, 'ordinary_' + String(n).padStart(3, '0') + '_'.repeat(45), p.scopes[0].id, 'ordinary'), NOW); if (r.status !== 'granted') {reason = r.reason; break;} grants++;}
  assert.ok(grants > 20); assert.equal(reason, 'account_ledger_exhausted');
  assert.equal((await s.engine.reserveFinal(await finalInput(p, preparations), NOW)).status, 'granted');
  assert.ok(Buffer.byteLength(JSON.stringify(s.data.get(KEYS.ledger))) <= LIMITS.ledgerBytes);
});
test('charged rejection cap is finite; exhausted and exact duplicate calls add no writes', async () => {
  const s = store(), p = plan(); p.coordination.maxRejections = 2; await s.engine.provision(p, NOW);
  const r = await s.engine.reserve(reservation(p, 'accepted'), NOW);
  for (let n = 0; n < 2; n++) assert.equal((await s.engine.reserve(reservation(p, 'bad_' + n, 'not_in_plan'), NOW)).reason, 'account_scope_unknown');
  const before = s.metrics.put; assert.equal((await s.engine.reserve(reservation(p, 'bad_more', 'not_in_plan'), NOW)).reason, 'account_rejection_exhausted');
  assert.equal((await s.engine.reserve(reservation(p, r.id), NOW)).status, 'duplicate'); assert.equal(s.metrics.put, before);
});
test('admitted coordinator KV ceiling includes provision, FINAL, charged rejection and terminal revoke separately from SQL rows', async () => {
  const s = store(), p = plan(); assert.equal(accountAdmissionCoordinationEnvelope(s.engine), null);
  await s.engine.provision(p, NOW); const envelope = accountAdmissionCoordinationEnvelope(s.engine);
  assert.deepEqual(envelope.admittedTotal, {kvGets: 52, kvPuts: 27});
  assert.deepEqual(envelope.provision, {kvGets: 2, kvPuts: 2});
  assert.deepEqual(envelope.acceptedReservations, {maximum: 16, kvGets: 32, kvPuts: 16});
  assert.deepEqual(envelope.chargedRejections, {maximum: 8, kvGets: 16, kvPuts: 8});
  assert.equal(envelope.providerBillingMapping, 'unknown'); assert.equal(envelope.upstreamInvocationBound, 'unknown');
  assert.deepEqual(envelope.excluded, ['duplicate', 'exhausted', 'inspection', 'failed_or_cold_probe', 'platform_invocation']);
  assert.equal(accountAdmissionPlan(s.engine).spent.rowsRead, 0); assert.equal(accountAdmissionPlan(s.engine).spent.rowsWritten, 0);
});
