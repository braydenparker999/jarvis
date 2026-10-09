// Inactive account-budget engine. No binding, public provisioning route, SQL,
// alarm, migration activation or new authentication is installed by this file.
// A durable ledger bounds ACCEPTED work. It cannot bound unsolicited platform
// requests or repeated cold coordination reads without a real upstream gate.
// Consequently fetch() remains closed before even reading KV. Local JS methods
// are operator/internal engineering APIs, not a routable admission authority.
export const RELAY_ACCOUNT_ADMISSION_LIMITS = Object.freeze({
  scopes: 16, reservations: 128, rejections: 128, ledgerBytes: 65536, sealBytes: 9216,
  evidenceAgeMs: 300000, receiptAgeMs: 30000,
});
export const RELAY_ACCOUNT_ADMISSION_KEYS = Object.freeze({ledger: 'relay-account-admission-v1', seal: 'relay-account-admission-seal-v1'});
const LIMITS = RELAY_ACCOUNT_ADMISSION_LIMITS, KEYS = RELAY_ACCOUNT_ADMISSION_KEYS;
const instances = new WeakMap(), receipts = new WeakMap();
const dimensions = ['rowsRead', 'rowsWritten', 'storedBytes'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const label = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validNow = now => integer(now) && Number.isFinite(new Date(now).getTime());
const day = now => new Date(now).toISOString().slice(0, 10);
const cost = value => exact(value, dimensions) && dimensions.every(key => integer(value[key]));
const zero = () => ({rowsRead: 0, rowsWritten: 0, storedBytes: 0});
const plus = (...values) => {
  const result = zero();
  for (const value of values) for (const key of dimensions) {
    result[key] += value[key]; if (!integer(result[key])) throw Error('Finite bound overflow');
  }
  return result;
};
const fits = (used, limit) => dimensions.every(key => used[key] <= limit[key]);
const equalCost = (a, b) => dimensions.every(key => a[key] === b[key]);
const copy = value => JSON.parse(JSON.stringify(value));
const freeze = value => {
  if (object(value) || Array.isArray(value)) {Object.values(value).forEach(freeze); Object.freeze(value);} return value;
};
const blocked = reason => ({status: 'blocked', reason});
export async function relayAccountAdmissionHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function relayAccountAdmissionPlanProblem(plan, now = Date.now()) {
  if (!validNow(now) || !exact(plan, ['v', 'planId', 'day', 'sourceHash', 'catalogHash', 'account', 'scopes', 'coordination', 'final'])
    || plan.v !== 1 || !label(plan.planId) || plan.day !== day(now) || !digest(plan.sourceHash) || !digest(plan.catalogHash)) return 'account_plan_unknown';
  if (!exact(plan.account, ['identityHash', 'evidenceHash', 'capturedAt', 'used', 'limit'])
    || !digest(plan.account.identityHash) || !digest(plan.account.evidenceHash) || !validNow(plan.account.capturedAt)
    || day(plan.account.capturedAt) !== plan.day || plan.account.capturedAt > now || now - plan.account.capturedAt > LIMITS.evidenceAgeMs
    || !cost(plan.account.used) || !cost(plan.account.limit) || dimensions.some(key => !plan.account.limit[key])
    || !fits(plan.account.used, plan.account.limit)) return 'account_evidence_unknown';
  if (!Array.isArray(plan.scopes) || !plan.scopes.length || plan.scopes.length > LIMITS.scopes
    || new Set(plan.scopes.map(scope => scope?.id)).size !== plan.scopes.length
    || plan.scopes.some(scope => !exact(scope, ['id', 'identityHash', 'preparation', 'ordinary']) || !label(scope.id)
      || !digest(scope.identityHash) || !cost(scope.preparation) || dimensions.some(key => !scope.preparation[key]) || !cost(scope.ordinary))) return 'account_scopes_unknown';
  if (!exact(plan.coordination, ['maxReservations', 'maxRejections', 'storedBytes'])
    || !integer(plan.coordination.maxReservations) || plan.coordination.maxReservations < plan.scopes.length + 1 || plan.coordination.maxReservations > LIMITS.reservations
    || !integer(plan.coordination.maxRejections) || plan.coordination.maxRejections > LIMITS.rejections
    || !integer(plan.coordination.storedBytes) || plan.coordination.storedBytes < LIMITS.ledgerBytes + LIMITS.sealBytes
    || !exact(plan.final, ['construction']) || !cost(plan.final.construction)
    || !plan.final.construction.rowsRead || !plan.final.construction.rowsWritten || !plan.final.construction.storedBytes) return 'account_reserves_unknown';
  try {
    if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > 8192) return 'account_plan_unknown';
    const allocated = plus(...plan.scopes.flatMap(scope => [scope.preparation, scope.ordinary]), plan.final.construction,
      {rowsRead: 0, rowsWritten: 0, storedBytes: plan.coordination.storedBytes});
    if (!fits(plus(plan.account.used, allocated), plan.account.limit)) return 'account_budget_insufficient';
  } catch {return 'account_budget_overflow';}
  return null;
}

export function isRelayAccountAdmission(value) {return instances.has(value);}
export function accountAdmissionPlan(value) {
  const state = instances.get(value)?.snapshot;
  return state ? copy({...state.plan, signature: state.signature, counters: state.counters, spent: state.spent, scopesSpent: state.scopesSpent}) : null;
}
export function accountAdmissionPreparationIds(value, scope) {
  const state = instances.get(value)?.snapshot;
  return state && label(scope) ? state.entries.filter(entry => entry.receipt.scope === scope && entry.receipt.lane === 'preparation').map(entry => entry.id) : [];
}
// This is a separate logical KV-operation ceiling for successful provisioning,
// accepted reservations (including FINAL), charged rejections and one terminal
// revocation. KV operations are NOT native SQL billing rows. Exact duplicates,
// exhausted refusals, inspections, failed/cold probes and runtime invocations
// remain outside this ceiling; no finite upstream/billing proof is installed.
export function accountAdmissionCoordinationEnvelope(value) {
  const state = instances.get(value)?.snapshot;
  if (!state) return null;
  const grants = state.plan.coordination.maxReservations, rejections = state.plan.coordination.maxRejections;
  return freeze({units: 'logical_KV_operations', provision: {kvGets: 2, kvPuts: 2},
    acceptedReservations: {maximum: grants, kvGets: 2 * grants, kvPuts: grants},
    chargedRejections: {maximum: rejections, kvGets: 2 * rejections, kvPuts: rejections},
    terminalRevocation: {maximum: 1, kvGets: 2, kvPuts: 1},
    admittedTotal: {kvGets: 4 + 2 * (grants + rejections), kvPuts: 3 + grants + rejections},
    ledgerJSONBytes: LIMITS.ledgerBytes, sealJSONBytes: LIMITS.sealBytes,
    providerBillingMapping: 'unknown', upstreamInvocationBound: 'unknown',
    excluded: ['duplicate', 'exhausted', 'inspection', 'failed_or_cold_probe', 'platform_invocation']});
}
export function consumeRelayAccountReservation(receipt, binding, now = Date.now()) {
  const known = object(receipt) ? receipts.get(receipt) : null;
  if (known) receipts.delete(receipt);
  const keys = ['planId', 'day', 'scope', 'lane', 'id', 'payloadHash', 'sourceHash', 'catalogHash', 'reportsHash'];
  const grant = known?.grant, issuer = known?.issuer;
  if (!grant || !issuer?.snapshot || issuer.blocked || issuer.epoch !== known.epoch || issuer.snapshot.revoked
    || relayAccountAdmissionPlanProblem(issuer.snapshot.plan, now)
    || !issuer.snapshot.entries.some(entry => JSON.stringify(entry.receipt) === JSON.stringify(grant))
    || !exact(binding, keys) || !validNow(now) || day(now) !== grant.day || now < grant.issuedAt
    || now - grant.issuedAt > LIMITS.receiptAgeMs || keys.some(key => binding[key] !== grant[key])) return blocked('account_receipt_invalid');
  return freeze(copy(grant));
}

function basicReservation(input, now) {
  return validNow(now) && exact(input, ['planId', 'day', 'scope', 'lane', 'id', 'payloadHash', 'cost'])
    && label(input.planId) && input.day === day(now) && label(input.scope) && ['preparation', 'ordinary'].includes(input.lane)
    && label(input.id) && digest(input.payloadHash) && cost(input.cost)
    && (input.cost.rowsRead || input.cost.rowsWritten || input.cost.storedBytes);
}
function basicFinal(input, now) {
  return validNow(now) && exact(input, ['planId', 'day', 'id', 'payloadHash', 'sourceHash', 'catalogHash', 'reportsHash', 'reports', 'constructionCost'])
    && label(input.planId) && input.day === day(now) && label(input.id) && digest(input.payloadHash) && digest(input.sourceHash)
    && digest(input.catalogHash) && digest(input.reportsHash) && cost(input.constructionCost) && dimensions.every(key => input.constructionCost[key] > 0)
    && Array.isArray(input.reports) && input.reports.length > 0 && input.reports.length <= LIMITS.scopes
    && input.reports.every(report => exact(report, ['scope', 'reportHash', 'preparationIds', 'constructionCost']) && label(report.scope)
      && digest(report.reportHash) && cost(report.constructionCost) && dimensions.every(key => report.constructionCost[key] > 0) && Array.isArray(report.preparationIds)
      && report.preparationIds.length > 0 && report.preparationIds.length <= LIMITS.reservations && report.preparationIds.every(label));
}
function stateProblem(state, seal, now) {
  if (!exact(state, ['v', 'plan', 'signature', 'spent', 'scopesSpent', 'counters', 'entries', 'final', 'revoked']) || state.v !== 1 || typeof state.revoked !== 'boolean'
    || !exact(seal, ['v', 'planId', 'day', 'signature']) || seal.v !== 1 || seal.planId !== state.plan?.planId
    || seal.day !== state.plan?.day || seal.signature !== state.signature || !digest(state.signature)
    || relayAccountAdmissionPlanProblem(state.plan, now) || !cost(state.spent)
    || !exact(state.counters, ['reservations', 'rejections']) || !integer(state.counters.reservations) || !integer(state.counters.rejections)
    || state.counters.reservations > state.plan.coordination.maxReservations || state.counters.rejections > state.plan.coordination.maxRejections
    || !Array.isArray(state.entries) || state.entries.length !== state.counters.reservations || state.entries.length > LIMITS.reservations
    || !Array.isArray(state.scopesSpent) || state.scopesSpent.length !== state.plan.scopes.length
    || !(state.final === null || object(state.final))) return 'account_state_unknown';
  // Recompute accepted debit from durable occurrences. A corrupt counter or
  // dropped occurrence cannot reset credit by looking like a smaller balance.
  try {
    const scoped = state.plan.scopes.map(scope => ({id: scope.id, preparation: zero(), ordinary: zero(), preparationAttempts: 0, ordinaryAttempts: 0}));
    const ids = new Set(); let final = null, spent = {rowsRead: 0, rowsWritten: 0, storedBytes: state.plan.coordination.storedBytes};
    for (const [index, entry] of state.entries.entries()) {
      if (!exact(entry, ['id', 'fingerprint', 'receipt']) || !label(entry.id) || !digest(entry.fingerprint) || ids.has(entry.id)) return 'account_state_unknown';
      ids.add(entry.id); const r = entry.receipt;
      if (!exact(r, ['status', 'planId', 'day', 'scope', 'lane', 'id', 'payloadHash', 'sourceHash', 'catalogHash', 'reportsHash', 'cost', 'attempt', 'issuedAt', 'signature', 'counters'])
        || r.status !== 'granted' || r.id !== entry.id || r.planId !== state.plan.planId || r.day !== state.plan.day
        || r.sourceHash !== state.plan.sourceHash || r.catalogHash !== state.plan.catalogHash || r.signature !== state.signature
        || !digest(r.payloadHash) || !cost(r.cost) || !integer(r.attempt) || r.attempt < 1 || !validNow(r.issuedAt)
        || day(r.issuedAt) !== state.plan.day || r.issuedAt > now || !exact(r.counters, ['reservations', 'rejections'])
        || r.counters.reservations !== index + 1 || !integer(r.counters.rejections) || r.counters.rejections > state.counters.rejections) return 'account_state_unknown';
      spent = plus(spent, r.cost);
      if (r.lane === 'final') {if (final || r.scope !== 'FINAL' || !digest(r.reportsHash) || r.attempt !== 1
        || dimensions.some(key => !r.cost[key]) || !fits(r.cost, state.plan.final.construction)) return 'account_state_unknown'; final = r;}
      else {
        const lane = scoped.find(scope => scope.id === r.scope);
        if (!lane || !['preparation', 'ordinary'].includes(r.lane) || r.reportsHash !== null || r.attempt !== lane[r.lane + 'Attempts'] + 1) return 'account_state_unknown';
        lane[r.lane] = plus(lane[r.lane], r.cost); lane[r.lane + 'Attempts']++;
      }
    }
    if (!equalCost(spent, state.spent) || JSON.stringify(scoped) !== JSON.stringify(state.scopesSpent)
      || JSON.stringify(final) !== JSON.stringify(state.final) || !fits(plus(state.plan.account.used, spent), state.plan.account.limit)) return 'account_state_unknown';
    for (const scope of scoped) for (const lane of ['preparation', 'ordinary']) {
      if (!fits(scope[lane], state.plan.scopes.find(item => item.id === scope.id)[lane])) return 'account_state_unknown';
    }
  } catch {return 'account_state_unknown';}
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > LIMITS.ledgerBytes) return 'account_state_unknown';
  return null;
}

// Capacity forecasts reserve both mandatory preparation occurrences and the
// duplicated final receipt before ordinary/repeated preparation can enter.
function capacityBytes(state) {
  const future = copy(state), max = Number.MAX_SAFE_INTEGER;
  const placeholder = (scope, lane) => ({status: 'granted', planId: state.plan.planId, day: state.plan.day, scope, lane,
    id: 'x'.repeat(64), payloadHash: 'a'.repeat(64), sourceHash: state.plan.sourceHash, catalogHash: state.plan.catalogHash,
    reportsHash: lane === 'final' ? 'a'.repeat(64) : null, cost: {rowsRead: max, rowsWritten: max, storedBytes: max}, attempt: max,
    issuedAt: max, signature: state.signature, counters: {reservations: max, rejections: max}});
  for (const scope of future.scopesSpent.filter(item => !item.preparationAttempts)) {
    const receipt = placeholder(scope.id, 'preparation'); future.entries.push({id: receipt.id, fingerprint: 'a'.repeat(64), receipt});
    scope.preparation = copy(receipt.cost); scope.preparationAttempts = max;
  }
  if (!future.final) {const receipt = placeholder('FINAL', 'final'); future.entries.push({id: receipt.id, fingerprint: 'a'.repeat(64), receipt}); future.final = receipt;}
  future.spent = {rowsRead: max, rowsWritten: max, storedBytes: max}; future.counters = {reservations: max, rejections: max};
  return new TextEncoder().encode(JSON.stringify(future)).byteLength;
}

export class RelayAccountAdmission {
  constructor(ctx) {
    // Constructor does not access storage. A namespace export/configuration is
    // deliberately not added to the production Worker.
    instances.set(this, {ctx, snapshot: null, tail: Promise.resolve(), blocked: null, epoch: 0});
  }
  async fetch() {return Response.json(blocked('upstream_invocation_gate_unavailable'), {status: 503});}
  async provision(plan, now = Date.now()) {
    const local = instances.get(this); if (!local) return blocked('account_instance_unknown');
    let snapshot; try {snapshot = copy(plan);} catch {return blocked('account_plan_unknown');}
    const problem = relayAccountAdmissionPlanProblem(snapshot, now); if (problem) return blocked(problem);
    return this._serial(async () => {
      try {
        let committed;
        const result = await local.ctx.storage.transaction(async txn => {
          const [seal, existing] = await Promise.all([txn.get(KEYS.seal), txn.get(KEYS.ledger)]);
          if (seal !== undefined || existing !== undefined) return blocked('account_already_provisioned');
          const signature = await relayAccountAdmissionHash(snapshot), state = {v: 1, plan: snapshot, signature,
            spent: {rowsRead: 0, rowsWritten: 0, storedBytes: snapshot.coordination.storedBytes},
            scopesSpent: snapshot.scopes.map(scope => ({id: scope.id, preparation: zero(), ordinary: zero(), preparationAttempts: 0, ordinaryAttempts: 0})),
            counters: {reservations: 0, rejections: 0}, entries: [], final: null, revoked: false};
          if (stateProblem(state, {v: 1, planId: snapshot.planId, day: snapshot.day, signature}, now)) return blocked('account_state_unknown');
          if (capacityBytes(state) > LIMITS.ledgerBytes) return blocked('account_ledger_exhausted');
          await txn.put({[KEYS.seal]: {v: 1, planId: snapshot.planId, day: snapshot.day, signature}, [KEYS.ledger]: state});
          committed = copy(state);
          return {status: 'provisioned', planId: snapshot.planId, day: snapshot.day, signature};
        });
        if (committed) {local.snapshot = committed; local.blocked = null;}
        return result;
      } catch {local.snapshot = null; local.epoch++; return blocked('account_storage_unavailable');}
    });
  }
  _serial(action) {
    const local = instances.get(this); if (!local) return Promise.resolve(blocked('account_instance_unknown'));
    const next = local.tail.then(action, action); local.tail = next.catch(() => {}); return next;
  }
  async _state(action, now) {
    const local = instances.get(this); if (!local) return blocked('account_instance_unknown');
    if (local.blocked) return blocked(local.blocked);
    return this._serial(async () => {
      if (local.blocked) return blocked(local.blocked);
      try {
        let committed;
        const result = await local.ctx.storage.transaction(async txn => {
          const [seal, state] = await Promise.all([txn.get(KEYS.seal), txn.get(KEYS.ledger)]);
          const problem = stateProblem(state, seal, now) || (state.signature !== await relayAccountAdmissionHash(state.plan) ? 'account_state_unknown' : null);
          if (problem || state.revoked) {local.blocked = problem || 'account_revoked'; local.snapshot = null; local.epoch++; return blocked(local.blocked);}
          const result = await action(state, txn); committed = copy(state); return result;
        });
        if (committed) local.snapshot = committed;
        return result;
      } catch {local.snapshot = null; local.epoch++; return blocked('account_storage_unavailable');}
    });
  }
  async inspect(now = Date.now()) {
    if (!validNow(now)) return blocked('account_plan_unknown');
    return this._state(state => ({status: 'known', plan: copy(state.plan), signature: state.signature, spent: copy(state.spent), counters: copy(state.counters)}), now);
  }
  async revoke(now = Date.now()) {
    if (!validNow(now)) return blocked('account_plan_unknown');
    const result = await this._state(async (state, txn) => {const next = copy(state); next.revoked = true;
      await txn.put(KEYS.ledger, next); Object.assign(state, next); return {status: 'revoked'};}, now);
    if (result.status === 'revoked') {const local = instances.get(this); local.blocked = 'account_revoked'; local.snapshot = null; local.epoch++;}
    return result;
  }
  async _reserve(input, now, lane, fingerprint) {
    const result = await this._state(async (state, txn) => {
      const prior = state.entries.find(entry => entry.id === input.id);
      if (prior) return prior.fingerprint === fingerprint ? {...copy(prior.receipt), status: 'duplicate'} : this._reject(state, txn, 'account_payload_conflict');
      if (input.planId !== state.plan.planId || input.day !== state.plan.day) return this._reject(state, txn, 'account_plan_changed');
      // An ordinary/preparation caller cannot consume the final grant's slot.
      const missingPreparation = state.scopesSpent.filter(item => !item.preparationAttempts && !(lane === 'preparation' && item.id === input.scope)).length;
      if (state.counters.reservations + 1 + (lane === 'final' ? 0 : 1 + missingPreparation) > state.plan.coordination.maxReservations) return this._reject(state, txn, 'account_coordination_exhausted');
      let scope, attempt, debit, reportsHash = null;
      if (lane === 'final') {
        if (state.final) return this._reject(state, txn, 'account_final_already_reserved');
        if (input.sourceHash !== state.plan.sourceHash || input.catalogHash !== state.plan.catalogHash
          || input.reportsHash !== await relayAccountAdmissionHash(input.reports)) return this._reject(state, txn, 'account_final_binding_invalid');
        const allPreparation = state.entries.filter(entry => entry.receipt.lane === 'preparation').map(entry => entry.id).sort();
        const referenced = input.reports.flatMap(report => report.preparationIds).sort();
        if (JSON.stringify(input.reports.map(report => report.scope).sort()) !== JSON.stringify(state.plan.scopes.map(item => item.id).sort())
          || new Set(referenced).size !== referenced.length || JSON.stringify(referenced) !== JSON.stringify(allPreparation)
          || input.reports.some(report => report.preparationIds.some(id => state.entries.find(entry => entry.id === id)?.receipt.scope !== report.scope)))
          return this._reject(state, txn, 'account_final_preparation_unknown');
        try {debit = plus(...input.reports.map(report => report.constructionCost));} catch {return this._reject(state, txn, 'account_budget_overflow');}
        if (!equalCost(debit, input.constructionCost) || !fits(debit, state.plan.final.construction)) return this._reject(state, txn, 'account_final_budget_exhausted');
        attempt = 1; reportsHash = input.reportsHash;
      } else {
        scope = state.scopesSpent.find(item => item.id === input.scope);
        const allocation = state.plan.scopes.find(item => item.id === input.scope);
        if (!scope || !allocation) return this._reject(state, txn, 'account_scope_unknown');
        debit = input.cost;
        try {if (!fits(plus(scope[lane], debit), allocation[lane])) return this._reject(state, txn, 'account_scope_budget_exhausted');}
        catch {return this._reject(state, txn, 'account_budget_overflow');}
        attempt = scope[lane + 'Attempts'] + 1;
      }
      let spent; try {spent = plus(state.spent, debit);} catch {return this._reject(state, txn, 'account_budget_overflow');}
      if (!fits(plus(state.plan.account.used, spent), state.plan.account.limit)) return this._reject(state, txn, 'account_budget_exhausted');
      const receipt = {status: 'granted', planId: state.plan.planId, day: state.plan.day, scope: lane === 'final' ? 'FINAL' : input.scope,
        lane, id: input.id, payloadHash: input.payloadHash, sourceHash: state.plan.sourceHash, catalogHash: state.plan.catalogHash, reportsHash,
        cost: copy(debit), attempt, issuedAt: now, signature: state.signature,
        counters: {reservations: state.counters.reservations + 1, rejections: state.counters.rejections}};
      const next = copy(state); next.spent = spent; next.counters.reservations++;
      if (scope) {const target = next.scopesSpent.find(item => item.id === input.scope); target[lane] = plus(target[lane], debit); target[lane + 'Attempts']++;}
      next.entries.push({id: input.id, fingerprint, receipt}); if (lane === 'final') next.final = receipt;
      if (capacityBytes(next) > LIMITS.ledgerBytes) return this._reject(state, txn, 'account_ledger_exhausted');
      await txn.put(KEYS.ledger, next); Object.assign(state, next); return copy(receipt);
    }, now);
    if (result.status === 'granted') {const receipt = freeze(result), issuer = instances.get(this); receipts.set(receipt, {grant: copy(result), issuer, epoch: issuer.epoch}); return receipt;}
    return freeze(result);
  }
  async _reject(state, txn, reason) {
    if (state.counters.rejections >= state.plan.coordination.maxRejections) return blocked('account_rejection_exhausted');
    const next = copy(state); next.counters.rejections++; await txn.put(KEYS.ledger, next); Object.assign(state, next);
    return blocked(reason);
  }
  async reserve(input, now = Date.now()) {
    let snapshot; try {snapshot = copy(input);} catch {return blocked('account_input_unknown');}
    if (!basicReservation(snapshot, now)) return blocked('account_input_unknown');
    return this._reserve(snapshot, now, snapshot.lane, await relayAccountAdmissionHash(snapshot));
  }
  async reserveFinal(input, now = Date.now()) {
    let snapshot; try {snapshot = copy(input);} catch {return blocked('account_final_input_unknown');}
    if (!basicFinal(snapshot, now)) return blocked('account_final_input_unknown');
    return this._reserve(snapshot, now, 'final', await relayAccountAdmissionHash(snapshot));
  }
}
