// Inactive, internal-only storage migration preparation. This module deliberately
// imports no owner/shared/event schema and has no HTTP, MCP, alarm or logging API.
// A separately reviewed caller must authenticate, reserve the account-wide budget,
// cover every affected Hub, and run this BEFORE any candidate schema helper.
import {RELAY_MIGRATION_CATALOG as CATALOG, relayMigrationSchemaSql} from './relay-migration-preflight-catalog.js';
export const RELAY_MIGRATION_PREFLIGHT_PLAN = Object.freeze({
  revision: 'relay-storage-c4-combined-core-v3',
  sourceCommit: 'c4d62409a3b67e4e5dac88809c6a4a0290b6e39e',
  candidateCommit: 'ed7bbd436689be3ac9cca1ab5f111341dd690b80',
  maxBatch: 250, maxScopes: 16, evidenceMaxAgeMs: 300000, reportMaxAgeMs: 30000,
  installSourcesPerStep: 8,
  // Reserve a whole invocation before starting it, including tiny checkpoint
  // DDL/DML. Native fixtures verify these envelopes; they are not account usage.
  stepRowsRead: 2000, stepRowsWritten: 64, checkpointBytes: 1048576,
});
const PLAN = RELAY_MIGRATION_PREFLIGHT_PLAN;
const CHECKPOINT = 'relay_migration_preflight';
const SOURCES = 'relay_migration_preflight_sources';
const ATTEMPTS = 'relay_migration_preflight_attempts';
const permits = new WeakMap();
const admittedContexts = new WeakMap();
const MIN_TRAFFIC = {rowsRead: 10000, rowsWritten: 1000, storedBytes: 1048576};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const label = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const blocked = reason => ({status: 'blocked', reason, planRevision: PLAN.revision});
const beforeSqlBlocked = reason => ({...blocked(reason), native: {rowsRead: 0, rowsWritten: 0, databaseBytes: null}});
const add = (...values) => {const total = values.reduce((a, b) => a + b, 0); if (!integer(total)) throw Error('Migration bound exceeds safe numeric range'); return total;};
const multiply = (a, b) => {const total = a * b; if (!integer(total)) throw Error('Migration bound exceeds safe numeric range'); return total;};
const sum = values => values.reduce((a, b) => ({rowsRead: add(a.rowsRead, b.rowsRead), rowsWritten: add(a.rowsWritten, b.rowsWritten), storedBytes: add(a.storedBytes, b.storedBytes)}), {rowsRead: 0, rowsWritten: 0, storedBytes: 0});
const day = now => new Date(now).toISOString().slice(0, 10);

// Every projection returns row keys or scalar sizes/count flags. No body, reply,
// publication, callback, identity, token, signing key or JSON payload is returned.
const tables = [
  {name: 'shared_entries', columns: "length(CAST(id AS BLOB))+COALESCE(length(CAST(reply_to AS BLOB)),0)+length(CAST(kind AS BLOB)) AS key_bytes"},
  {name: 'imported_comments', columns: 'CASE WHEN imported=0 THEN 1 ELSE 0 END AS pending,CASE WHEN imported=2 THEN 1 ELSE 0 END AS conflicts,length(CAST(publication AS BLOB)) AS payload_bytes'},
  {name: 'relay_events', columns: '0 AS key_bytes,length(CAST(data AS BLOB)) AS payload_bytes,CASE WHEN json_valid(data) THEN 0 ELSE 1 END AS invalid_json'},
  {name: 'relay_outbox', columns: "length(CAST(subscription_id AS BLOB)) AS key_bytes,CASE WHEN status IN ('pending','failed') THEN 1 ELSE 0 END AS unsettled,CASE WHEN status='delivered' THEN 1 ELSE 0 END AS delivered"},
  {name: 'relay_owner_entries', columns: "length(CAST(id AS BLOB)) AS key_bytes,CASE WHEN kind='user' THEN 1 ELSE 0 END AS private_requests"},
  {name: 'relay_owner_jobs', columns: '0 AS key_bytes'},
  {name: 'relay_owner_job_events', columns: 'length(CAST(job_id AS BLOB)) AS key_bytes'},
  {name: 'relay_owner_job_result_corrections', columns: '0 AS key_bytes'},
  {name: 'relay_owner_job_deadlines', columns: 'length(CAST(job_id AS BLOB)) AS key_bytes'},
  {name: 'relay_outbox_recoveries', columns: '0 AS key_bytes'},
  {name: 'public_coordination_events', columns: 'length(CAST(payload AS BLOB)) AS payload_bytes,length(CAST(request_id AS BLOB))+length(CAST(attempt_id AS BLOB)) AS key_bytes,CASE WHEN disposition=\'accepted\' AND result_version IS NOT NULL THEN 1 ELSE 0 END AS accepted_version'},
  {name: 'public_changes', columns: 'COALESCE(length(CAST(request_id AS BLOB)),0) AS key_bytes'},
  {name: 'relay_oauth', columns: '8+length(CAST(category AS BLOB)) AS key_bytes'},
];
// Every retained/new application table is either scanned or positively known
// absent. No unexpected table, index or trigger can become a zero-row credit.
for (const table of CATALOG.tables) if (!tables.some(item => item.name === table.name)) tables.push({name: table.name, columns: '0 AS key_bytes'});
const indices = CATALOG.indices.map(index => ({name: index.name, table: index.table,
  ...(index.name === 'relay_outbox_unsettled' ? {partial: 'unsettled'} : index.name === 'public_coordination_version' ? {partial: 'accepted_version'} : {})}));

function evidenceProblem(evidence, now) {
  if (!integer(now) || !Number.isFinite(new Date(now).getTime()) || !exact(evidence, ['plan', 'utcDay', 'windowStart', 'capturedAt', 'account', 'namespace', 'perObjectStoredBytesLimit'])) return 'quota_evidence_unknown';
  if (!['workers-free', 'workers-paid'].includes(evidence.plan) || !integer(evidence.capturedAt) || !integer(evidence.windowStart)
    || evidence.utcDay !== day(now) || evidence.windowStart !== Date.parse(evidence.utcDay + 'T00:00:00Z')
    || evidence.capturedAt < evidence.windowStart || evidence.capturedAt > now || now - evidence.capturedAt > PLAN.evidenceMaxAgeMs) return 'quota_evidence_stale';
  if (!exact(evidence.account, ['rowsRead', 'rowsWritten', 'storedBytes']) || !exact(evidence.namespace, ['binding', 'rowsRead', 'rowsWritten', 'storedBytes'])
    || evidence.namespace.binding !== 'HUBS' || !integer(evidence.perObjectStoredBytesLimit) || evidence.perObjectStoredBytesLimit === 0) return 'quota_evidence_unknown';
  for (const dimension of ['rowsRead', 'rowsWritten', 'storedBytes']) {
    const value = evidence.account[dimension];
    if (!exact(value, ['used', 'limit']) || !integer(value.used) || !integer(value.limit) || value.limit === 0 || !integer(evidence.namespace[dimension])) return 'quota_evidence_unknown';
    if (value.used > value.limit || evidence.namespace[dimension] > value.used) return 'quota_evidence_inconsistent';
  }
  return null;
}
function budgetInputsProblem(options, now) {
  const problem = evidenceProblem(options?.evidence, now); if (problem) return problem;
  if (!exact(options.reserve, ['rowsRead', 'rowsWritten', 'storedBytes'])
    || Object.keys(MIN_TRAFFIC).some(key => !integer(options.reserve[key]) || options.reserve[key] < MIN_TRAFFIC[key])) return 'ordinary_traffic_reserve_unknown';
  if (!Array.isArray(options.allocations) || !options.allocations.length || options.allocations.length > PLAN.maxScopes
    || options.allocations.some(item => !exact(item, ['scope', 'rowsRead', 'rowsWritten', 'storedBytes']) || !label(item.scope)
      || !integer(item.rowsRead) || item.rowsRead < PLAN.stepRowsRead || !integer(item.rowsWritten) || item.rowsWritten < PLAN.stepRowsWritten
      || !integer(item.storedBytes) || item.storedBytes < PLAN.checkpointBytes)
    || new Set(options.allocations.map(item => item.scope)).size !== options.allocations.length) return 'affected_scope_allocation_unknown';
  const coordination = options.coordination;
  if (!exact(coordination, ['planId', 'maxReservations', 'maxRejections', 'rowsRead', 'rowsWritten', 'storedBytes']) || !label(coordination.planId)
    || !integer(coordination.maxReservations) || coordination.maxReservations < 1 || !integer(coordination.maxRejections)
    || !integer(coordination.rowsRead) || !integer(coordination.rowsWritten) || !integer(coordination.storedBytes)
    || coordination.storedBytes < PLAN.checkpointBytes) return 'external_coordination_budget_unknown';
  try {
    const operations = add(coordination.maxReservations, coordination.maxRejections);
    if (coordination.rowsRead < operations || coordination.rowsWritten < operations) return 'external_coordination_budget_unknown';
    const reserved = preparationReserve(options);
    if (Object.keys(reserved).some(key => add(options.evidence.account[key].used, reserved[key]) > options.evidence.account[key].limit)) return 'preflight_quota_insufficient';
  } catch {return 'bound_overflow';}
  return null;
}
const allocationSignature = options => JSON.stringify(options.allocations.toSorted((a, b) => a.scope.localeCompare(b.scope)));
const coordinationReserve = options => ({rowsRead: options.coordination.rowsRead, rowsWritten: options.coordination.rowsWritten, storedBytes: options.coordination.storedBytes});
const preparationReserve = options => sum([sum(options.allocations), options.reserve, coordinationReserve(options)]);
const accountPlanSignature = options => JSON.stringify({planRevision: PLAN.revision, allocations: allocationSignature(options), ordinaryTraffic: options.reserve, coordination: options.coordination});

function stepInputsProblem(input, now) {
  if (!exact(input, ['action', 'runId', 'scope', 'expectedRevision', 'batchSize', 'evidence', 'reserve', 'allocations', 'coordination'])
    || !['start', 'continue', 'report', 'discard'].includes(input.action) || !label(input.runId) || !label(input.scope)
    || !(input.expectedRevision === null || integer(input.expectedRevision)) || !integer(input.batchSize) || input.batchSize < 1 || input.batchSize > PLAN.maxBatch) return 'invalid_preflight_input';
  return budgetInputsProblem(input, now) || (!input.allocations.some(item => item.scope === input.scope) ? 'affected_scope_allocation_unknown' : null);
}

// Mandatory external admission contract, not a production allocator. reserve()
// must atomically persist a finite account/scope reservation OUTSIDE source SQL
// before replying. Unknown state and exhausted/failed/lost replies fail closed.
// Its own finite rejection/coordination cost belongs in the external reservation.
// No adapter is installed here; a plain input flag/receipt cannot enter Step.
export async function relayMigrationPreflightAdmission(ctx, input, now, reserve) {
  const problem = stepInputsProblem(input, now); if (problem) return beforeSqlBlocked(problem);
  if (!object(ctx)) return beforeSqlBlocked('native_context_unknown');
  if (typeof reserve !== 'function') return beforeSqlBlocked('external_admission_required');
  // Capture the complete binding before handing control to the reservation
  // callback. Neither a changed input nor a changed validation reference may
  // attach an original scope's receipt to a different SQL operation.
  const inputBinding = JSON.stringify(input), snapshot = JSON.parse(inputBinding);
  const snapshotProblem = stepInputsProblem(snapshot, now); if (snapshotProblem) return beforeSqlBlocked(snapshotProblem);
  const request = Object.freeze({planRevision: PLAN.revision, reservationId: crypto.randomUUID(), utcDay: day(now), scope: snapshot.scope,
    allocationSignature: allocationSignature(snapshot), allocation: Object.freeze({...snapshot.allocations.find(item => item.scope === snapshot.scope)}),
    accountPlanSignature: accountPlanSignature(snapshot), coordination: Object.freeze({...snapshot.coordination}), accountReserved: Object.freeze(preparationReserve(snapshot)),
    envelope: Object.freeze({rowsRead: PLAN.stepRowsRead, rowsWritten: PLAN.stepRowsWritten, storedBytes: PLAN.checkpointBytes})});
  const previous = admittedContexts.get(ctx);
  if (previous?.utcDay === request.utcDay) {
    if (previous.scope !== request.scope || previous.allocationSignature !== request.allocationSignature || previous.accountPlanSignature !== request.accountPlanSignature) return beforeSqlBlocked('preflight_allocation_plan_changed');
    if (previous.blockReason) return beforeSqlBlocked(previous.blockReason);
    if (previous.attempt >= Math.min(Math.floor(request.allocation.rowsRead / PLAN.stepRowsRead), Math.floor(request.allocation.rowsWritten / PLAN.stepRowsWritten))) return beforeSqlBlocked('preflight_allocation_exhausted');
  }
  let receipt;
  try {receipt = await reserve(request);} catch {return beforeSqlBlocked('external_admission_unavailable');}
  try {if (JSON.stringify(input) !== inputBinding) return beforeSqlBlocked('external_admission_invalid');}
  catch {return beforeSqlBlocked('external_admission_invalid');}
  if (exact(receipt, ['status', 'reason']) && receipt.status === 'blocked'
    && ['preflight_allocation_exhausted', 'preflight_allocation_plan_changed', 'external_admission_unknown', 'external_rejection_budget_exhausted', 'external_account_budget_exhausted'].includes(receipt.reason)) {
    if (['external_rejection_budget_exhausted', 'external_account_budget_exhausted'].includes(receipt.reason)) admittedContexts.set(ctx,
      {utcDay: request.utcDay, scope: request.scope, allocationSignature: request.allocationSignature, accountPlanSignature: request.accountPlanSignature,
        attempt: admittedContexts.get(ctx)?.attempt ?? 0, blockReason: receipt.reason});
    return beforeSqlBlocked(receipt.reason);
  }
  if (!exact(receipt, ['status', 'reservationId', 'utcDay', 'scope', 'allocationSignature', 'attempt', 'reserved', 'coordination']) || receipt.status !== 'reserved'
    || ['reservationId', 'utcDay', 'scope', 'allocationSignature'].some(key => receipt[key] !== request[key])
    || !integer(receipt.attempt) || receipt.attempt < 1 || !exact(receipt.reserved, ['rowsRead', 'rowsWritten', 'storedBytes'])
    || !exact(receipt.coordination, ['planId', 'signature', 'reservations', 'rejections', 'reserved']) || receipt.coordination.planId !== request.coordination.planId
    || receipt.coordination.signature !== request.accountPlanSignature || !integer(receipt.coordination.reservations) || receipt.coordination.reservations < receipt.attempt
    || receipt.coordination.reservations > request.coordination.maxReservations || !integer(receipt.coordination.rejections) || receipt.coordination.rejections > request.coordination.maxRejections
    || !exact(receipt.coordination.reserved, ['rowsRead', 'rowsWritten', 'storedBytes'])
    || Object.keys(request.accountReserved).some(key => receipt.coordination.reserved[key] !== request.accountReserved[key])) return beforeSqlBlocked('external_admission_invalid');
  try {
    const expected = {rowsRead: multiply(receipt.attempt, PLAN.stepRowsRead), rowsWritten: multiply(receipt.attempt, PLAN.stepRowsWritten), storedBytes: PLAN.checkpointBytes};
    if (Object.keys(expected).some(key => receipt.reserved[key] !== expected[key] || expected[key] > request.allocation[key])) return beforeSqlBlocked('external_admission_invalid');
  } catch {return beforeSqlBlocked('external_admission_invalid');}
  // A concurrent reservation can finish while this callback is pending. Check
  // the current context fence so a delayed older receipt cannot rewind it.
  const latest = admittedContexts.get(ctx);
  if (latest?.utcDay === request.utcDay) {
    if (latest.scope !== request.scope || latest.allocationSignature !== request.allocationSignature || latest.accountPlanSignature !== request.accountPlanSignature) return beforeSqlBlocked('preflight_allocation_plan_changed');
    if (latest.blockReason) return beforeSqlBlocked(latest.blockReason);
    if (receipt.attempt <= latest.attempt) return beforeSqlBlocked('preflight_admission_obsolete');
  }
  admittedContexts.set(ctx, {utcDay: request.utcDay, scope: request.scope, allocationSignature: request.allocationSignature, accountPlanSignature: request.accountPlanSignature, attempt: receipt.attempt});
  const permit = Object.freeze({});
  permits.set(permit, {ctx, input: inputBinding, issuedAt: now, attempt: receipt.attempt, reserved: {...receipt.reserved}, accountPlanSignature: request.accountPlanSignature,
    coordination: {...receipt.coordination, reserved: {...receipt.coordination.reserved}}});
  return permit;
}

function native(ctx) {
  let rowsRead = 0, rowsWritten = 0;
  return {exec(query, ...values) {
    const cursor = ctx.storage.sql.exec(query, ...values), selected = [...cursor];
    if (!integer(cursor.rowsRead) || !integer(cursor.rowsWritten)) throw Error('Native SQL metering unavailable');
    rowsRead = add(rowsRead, cursor.rowsRead); rowsWritten = add(rowsWritten, cursor.rowsWritten); return selected;
  }, measure() {return {rowsRead, rowsWritten};}};
}
function schema(sql) {
  // LIMIT applies before JS filtering: even a surprising schema cannot produce
  // an unbounded sqlite_master inventory. No source index is created here.
  const selected = sql.exec('SELECT name,type,tbl_name,sql FROM sqlite_master LIMIT 256');
  if (selected.length === 256) throw Error('Schema inventory exceeds reviewed bound');
  const entities = [...CATALOG.tables, ...CATALOG.indices, ...CATALOG.triggers, ...CATALOG.provider];
  const ownTables = new Map([
    [CHECKPOINT, `CREATE TABLE ${CHECKPOINT}(id INTEGER PRIMARY KEY CHECK(id=1),checkpoint TEXT NOT NULL)`],
    [SOURCES, `CREATE TABLE ${SOURCES}(name TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991))`],
    [ATTEMPTS, `CREATE TABLE ${ATTEMPTS}(id INTEGER PRIMARY KEY CHECK(id=1),utc_day TEXT NOT NULL,scope TEXT NOT NULL,allocation_signature TEXT NOT NULL,attempts INTEGER NOT NULL,database_base INTEGER NOT NULL)`],
  ]);
  const ownTriggers = new Map(tables.flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(operation =>
    [`relay_migration_preflight_${table.name}_${operation.toLowerCase()}`, watcher(table.name, operation)])));
  for (const row of selected) {
    if (row.sql === null && row.type === 'index' && row.name.startsWith('sqlite_autoindex_' + row.tbl_name + '_') && /^[0-9]+$/.test(row.name.slice(('sqlite_autoindex_' + row.tbl_name + '_').length))
      && (CATALOG.tables.some(table => table.name === row.tbl_name) || CATALOG.provider.some(table => table.name === row.tbl_name) || ownTables.has(row.tbl_name))) continue;
    const entity = entities.find(item => item.name === row.name && item.type === row.type);
    const expected = entity?.sql ?? (row.type === 'table' ? ownTables.get(row.name) : row.type === 'trigger' ? ownTriggers.get(row.name) : null);
    if (!expected || relayMigrationSchemaSql(row.sql) !== relayMigrationSchemaSql(expected)) throw Error('Unsupported source schema');
  }
  return selected;
}
const signature = selected => JSON.stringify(selected.map(row => [row.name, row.type, row.sql]).toSorted((a, b) => a[0].localeCompare(b[0])));
function watcher(name, operation) {
  return `CREATE TRIGGER relay_migration_preflight_${name}_${operation.toLowerCase()} AFTER ${operation} ON ${name}
    BEGIN UPDATE ${SOURCES} SET revision=revision+1 WHERE name='${name}'; END`;
}
function discardSources(sql, state, catalogRows) {
  // Native DROP TRIGGER examines sqlite_master even for a named trigger. Its
  // read cost scales with the installed catalog. Reserve three full catalog
  // probes per source plus metadata margin before choosing a teardown page.
  const capacity = Math.max(1, Math.min(PLAN.installSourcesPerStep,
    Math.floor((PLAN.stepRowsRead - sql.measure().rowsRead - 32) / (3 * catalogRows + 8))));
  const selected = state.presentTables.slice(state.discardAfter, Math.min(state.installationAfter, state.discardAfter + capacity));
  for (const name of selected) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) sql.exec(`DROP TRIGGER IF EXISTS relay_migration_preflight_${name}_${operation.toLowerCase()}`);
    sql.exec(`DELETE FROM ${SOURCES} WHERE name=?`, name);
  }
  state.discardAfter += selected.length;
}
function install(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${CHECKPOINT}(id INTEGER PRIMARY KEY CHECK(id=1),checkpoint TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${SOURCES}(name TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991))`);
}
function installSources(sql, state) {
  const selected = state.presentTables.slice(state.installationAfter, state.installationAfter + PLAN.installSourcesPerStep);
  for (const name of selected) {
    sql.exec(`INSERT OR IGNORE INTO ${SOURCES}(name,revision) VALUES(?,0)`, name);
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) sql.exec(watcher(name, operation));
  }
  state.installationAfter += selected.length;
}
function sourceFences(sql, state) {
  return tables.map(table => {
    const through = state.presentTables.includes(table.name) ? sql.exec(`SELECT rowid AS scan_key FROM ${table.name} NOT INDEXED ORDER BY rowid DESC LIMIT 1`)[0]?.scan_key ?? null : null;
    if (through !== null && !Number.isSafeInteger(through)) throw Error('Unsafe source row key');
    return {name: table.name, through, after: null, count: 0, complete: through === null, key_bytes: 0, pending: 0, unsettled: 0,
      delivered: 0, private_requests: 0, payload_bytes: 0, accepted_version: 0, invalid_json: 0, conflicts: 0};
  });
}
function estimate(state) {
  const count = name => state.tables.find(table => table.name === name)?.count ?? 0;
  const scalar = (name, key) => state.tables.find(table => table.name === name)?.[key] ?? 0;
  const construction = sum(indices.filter(index => !state.existingIndices.includes(index.name)).map(index => {
    const scanned = count(index.table), written = index.partial ? scalar(index.table, index.partial) : scanned;
    // Index creation also reads/writes bounded schema metadata. Include it even
    // for empty inputs; exact native OAuth construction exceeds 4N reads across
    // its two new indexes before any legacy-row cleanup is counted.
    return {rowsRead: add(256, multiply(scanned, 4)), rowsWritten: add(64, multiply(written, 2)),
      storedBytes: add(65536, multiply(add(scalar(index.table, 'key_bytes'), multiply(written, 128)), 4))};
  }));
  // relayOAuthStore also extends retained legacy clients and deletes expired
  // rows on first access. Reserve one worst-case pass, including both new index
  // updates and preflight revision monitors, without reading identity payloads.
  const oauthMaintenance = {rowsRead: add(512, multiply(count('relay_oauth'), 8)), rowsWritten: add(256, multiply(count('relay_oauth'), 16)),
    storedBytes: add(65536, multiply(count('relay_oauth'), 256))};
  // Reserve the complete public history and receipt population even if an old
  // marker might permit a cheaper no-op. Unknown marker state is never a credit.
  const publicRows = add(count('shared_entries'), count('public_coordination_events'));
  const backfill = {rowsRead: add(multiply(publicRows, 16), multiply(count('relay_outbox'), 4)),
    rowsWritten: add(multiply(publicRows, 16), multiply(scalar('relay_outbox', 'delivered'), 4)),
    storedBytes: add(1048576, multiply(publicRows, 4096), multiply(count('relay_outbox'), 256))};
  // CORE resolves named predecessors and artifact revisions through the
  // reviewed event/artifact keys. Keep a deliberately generous history term
  // for one inventory-sized pending/conflict/recovery replay cycle. Repeated
  // dependency polls and future upstream imports require their own enforced
  // external ordinary-traffic reserve; page/day caps alone are not SQL bounds.
  const pending = add(scalar('imported_comments', 'pending'), scalar('imported_comments', 'conflicts'), count('publication_recovery'));
  const history = add(count('shared_entries'), count('public_coordination_events'), count('imported_comments'), count('public_artifact_state'));
  const replay = {rowsRead: multiply(pending, add(1000, multiply(history, 8))), rowsWritten: multiply(pending, 256),
    storedBytes: add(multiply(scalar('imported_comments', 'payload_bytes'), 4), multiply(pending, 131072))};
  // The private feed is part of this exact combined target. Account for the
  // full cold checkpointed pass, lease/recovery deadlines and retained history.
  const privateRequests = add(scalar('relay_owner_entries', 'private_requests'), count('relay_owner_jobs'));
  const privateHistory = add(count('relay_owner_job_events'), count('relay_owner_job_result_corrections'));
  const corePrivateReserve = {rowsRead: add(multiply(privateRequests, 128), multiply(privateHistory, 16), multiply(count('relay_owner_job_deadlines'), 16)),
    rowsWritten: add(multiply(privateRequests, 64), multiply(count('relay_owner_job_deadlines'), 8)),
    storedBytes: add(multiply(privateRequests, 8192), multiply(count('relay_outbox_recoveries'), 512))};
  const missingTables = CATALOG.tables.filter(table => !state.presentTables.includes(table.name)).length;
  const missingTriggers = CATALOG.triggers.filter(trigger => !state.existingTriggers.includes(trigger.name)).length;
  const catalogCreation = {rowsRead: add(4096, multiply(missingTables, 128), multiply(missingTriggers, 64)),
    rowsWritten: add(1024, multiply(missingTables, 64), multiply(missingTriggers, 16)),
    storedBytes: add(1048576, multiply(missingTables, 65536), multiply(missingTriggers, 8192))};
  const authRows = ['relay_owner_pairings', 'relay_owner_sessions', 'relay_owner_session_audit', 'relay_owner_pair_rates',
    'relay_owner_credentials', 'relay_owner_credential_consents', 'relay_owner_password_rates', 'relay_verified', 'relay_activations'].reduce((n, name) => add(n, count(name)), 0);
  const ownerAuthStartup = {rowsRead: add(1024, multiply(authRows, 16)), rowsWritten: add(512, multiply(authRows, 8)), storedBytes: add(65536, multiply(authRows, 512))};
  // This target admits at most 120 legacy reconciliation pages/day, with at
  // most 100 positions/page. Reserve the entire daily lane even with no source
  // count proof. KV-only broker/responder/workspace traffic remains part of the
  // separately supplied account-wide ordinary-traffic and coordination bounds.
  const legacyRecovery = {rowsRead: 120 * 100 * 32 + 4096, rowsWritten: 120 * 100 * 32 + 1024,
    storedBytes: 120 * 100 * 8192 + 65536};
  return {construction, catalogCreation, oauthMaintenance, ownerAuthStartup, backfill, replay, corePrivateReserve, legacyRecovery,
    total: sum([construction, catalogCreation, oauthMaintenance, ownerAuthStartup, backfill, replay, corePrivateReserve, legacyRecovery])};
}
function currentState(sql) {
  const selected = schema(sql);
  if (!selected.some(row => row.name === CHECKPOINT)) return {selected, state: null};
  const row = sql.exec(`SELECT checkpoint FROM ${CHECKPOINT} WHERE id=1`)[0];
  return {selected, state: row ? JSON.parse(row.checkpoint) : null};
}
function reserveAttempt(sql, input, admission, now, databaseBytes) {
  // This small reservation commits BEFORE the inventory transaction. An aborted
  // scan consumes its reservation too; reloading or discarding cannot erase it.
  sql.exec(`CREATE TABLE IF NOT EXISTS ${ATTEMPTS}(id INTEGER PRIMARY KEY CHECK(id=1),utc_day TEXT NOT NULL,scope TEXT NOT NULL,allocation_signature TEXT NOT NULL,attempts INTEGER NOT NULL,database_base INTEGER NOT NULL)`);
  const row = sql.exec(`SELECT * FROM ${ATTEMPTS} WHERE id=1`)[0];
  const allocation_signature = accountPlanSignature(input);
  if (row && (row.scope !== input.scope || row.allocation_signature !== allocation_signature)) return blocked('preflight_allocation_plan_changed');
  // The external counter can include a lost permit or a response lost before
  // SQL. Persist its monotonic value; neither case can reclaim spent allocation.
  const attempts = admission.attempt, reserved = admission.reserved;
  if (attempts <= (row?.utc_day === day(now) ? row.attempts : 0)) return blocked('preflight_admission_obsolete');
  sql.exec(`INSERT INTO ${ATTEMPTS} VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET utc_day=excluded.utc_day,attempts=excluded.attempts`, day(now), input.scope, allocation_signature, attempts, databaseBytes);
  return {reserved, databaseBase: row?.database_base ?? databaseBytes};
}
function drift(sql, selected, state) {
  if (signature(selected) !== state.schemaSignature) return 'schema_drift';
  const revisions = sql.exec(`SELECT name,revision FROM ${SOURCES} ORDER BY name`);
  if (JSON.stringify(revisions) !== state.sourceRevisions) return 'cardinality_or_content_drift';
  return null;
}
function report(state, now, measured, databaseBytes) {
  return {status: state.phase === 'complete' ? 'complete' : state.phase === 'blocked' ? 'blocked' : 'scanning', reason: state.reason ?? null,
    planRevision: PLAN.revision, sourceCommit: PLAN.sourceCommit, candidateCommit: PLAN.candidateCommit,
    runId: state.runId, scope: state.scope, revision: state.revision, observedAt: now, batchExamined: state.batchExamined ?? 0,
    tables: state.tables.map(({name, count, complete}) => ({name, count, complete})),
    native: {...measured, databaseBytes, databaseBytesAtStart: state.databaseBytesAtStart},
    preflightReserved: {...state.preflightReserved}, allocationSignature: state.allocationSignature, accountPlanSignature: state.accountPlanSignature,
    catalogInstallation: {readySources: state.installationAfter, totalSources: state.presentTables.length, bootstrapPending: state.phase === 'installing',
      discardPending: state.phase === 'discarding', discardedSources: state.discardAfter ?? 0},
    catalog: {applicationTables: CATALOG.tables.length, namedIndices: CATALOG.indices.length, privateChangeTriggers: CATALOG.triggers.length,
      managedKvObserved: state.managedKvObserved},
    estimate: state.phase === 'complete' ? estimate(state) : null};
}

// Owns only its tiny checkpoint/source-revision tables and additive triggers.
// No target CREATE INDEX, data migration, credentials, grant or alarm is executed.
// Call synchronously; each transaction consumes every native cursor before exit.
export function relayMigrationPreflightStep(ctx, input, now = Date.now(), permit = null) {
  const admission = object(permit) ? permits.get(permit) : null;
  if (admission) permits.delete(permit);
  const problem = stepInputsProblem(input, now); if (problem) return beforeSqlBlocked(problem);
  if (!admission) return beforeSqlBlocked('external_admission_required');
  if (admission.ctx !== ctx || admission.input !== JSON.stringify(input) || now < admission.issuedAt || now - admission.issuedAt > PLAN.reportMaxAgeMs) return beforeSqlBlocked('external_admission_invalid');
  const allocation = input.allocations.find(item => item.scope === input.scope);
  const databaseBytes = ctx?.storage?.sql?.databaseSize;
  if (!integer(databaseBytes) || typeof ctx?.storage?.transactionSync !== 'function') return blocked('native_storage_unknown');
  // The same fresh screenshot may precede our checkpoint's small growth. That
  // growth is explicitly allocated, rather than requiring another screenshot
  // after every page. A new scan still verifies its unmodified starting size.
  if (databaseBytes > add(input.evidence.namespace.storedBytes, sum(input.allocations).storedBytes)
    || databaseBytes > input.evidence.perObjectStoredBytesLimit) return blocked('storage_evidence_inconsistent');
  const sql = native(ctx);
  try {
    const reservation = ctx.storage.transactionSync(() => reserveAttempt(sql, input, admission, now, databaseBytes));
    const charged = value => ({...value, preflightReserved: {...admission.reserved}, admission: {mode: 'external_atomic_before_sql', attempt: admission.attempt,
      accountPlanSignature: admission.accountPlanSignature, coordination: admission.coordination},
      native: {...sql.measure(), databaseBytes: ctx.storage.sql.databaseSize, ...(value.native?.databaseBytesAtStart === undefined ? {} : {databaseBytesAtStart: value.native.databaseBytesAtStart})}});
    if (reservation.status === 'blocked') return charged(reservation);
    const reserved = reservation.reserved;
    return charged(ctx.storage.transactionSync(() => {
      let {selected, state} = currentState(sql);
      if (state && (state.planRevision !== PLAN.revision || state.scope !== input.scope || state.runId !== input.runId
        || state.allocationSignature !== allocationSignature(input) || state.accountPlanSignature !== accountPlanSignature(input))) return blocked('checkpoint_plan_mismatch');
      if (state && input.expectedRevision !== null && input.expectedRevision !== state.revision) return blocked('checkpoint_revision_mismatch');
      if (state) state.preflightReserved = {...reserved};
      if (input.action === 'discard') {
        if (!state || input.expectedRevision === null) return blocked('checkpoint_revision_mismatch');
        state.phase = 'discarding'; state.reason = null; state.discardAfter ??= 0;
      }
      if (!state) {
        if (input.action !== 'start' || input.expectedRevision !== null) return blocked('checkpoint_missing');
        if (reservation.databaseBase > input.evidence.namespace.storedBytes) return blocked('storage_evidence_inconsistent');
        install(sql); selected = schema(sql);
        state = {planRevision: PLAN.revision, runId: input.runId, scope: input.scope, revision: 0, phase: 'installing', installationAfter: 0,
          allocationSignature: allocationSignature(input), accountPlanSignature: accountPlanSignature(input), databaseBytesAtStart: databaseBytes,
          schemaSignature: signature(selected), sourceRevisions: JSON.stringify(sql.exec(`SELECT name,revision FROM ${SOURCES} ORDER BY name`)),
          existingIndices: selected.filter(row => row.type === 'index').map(row => row.name), preflightReserved: {...reserved},
          existingTriggers: selected.filter(row => row.type === 'trigger').map(row => row.name),
          presentTables: tables.filter(table => selected.some(row => row.name === table.name && row.type === 'table')).map(table => table.name),
          managedKvObserved: selected.some(row => row.name === '_cf_KV'), tables: []};
      } else {
        const changed = state.phase === 'discarding' ? null : drift(sql, selected, state);
        if (changed) {state.phase = 'blocked'; state.reason = changed;}
        if (input.action === 'start' || input.action === 'report' || !['scanning', 'installing', 'discarding'].includes(state.phase)) {
          state.batchExamined = 0; return report(state, now, sql.measure(), ctx.storage.sql.databaseSize);
        }
        if (input.expectedRevision === null) return blocked('checkpoint_revision_mismatch');
      }
      if (state.phase === 'discarding') {
        discardSources(sql, state, selected.length); state.batchExamined = 0; state.revision = add(state.revision, 1);
        if (state.discardAfter === state.installationAfter) sql.exec(`DELETE FROM ${CHECKPOINT} WHERE id=1`);
        else sql.exec(`UPDATE ${CHECKPOINT} SET checkpoint=? WHERE id=1`, JSON.stringify(state));
        const measured = sql.measure();
        if (measured.rowsRead > PLAN.stepRowsRead || measured.rowsWritten > PLAN.stepRowsWritten) throw Error('Native preflight exceeded reserved envelope');
        return state.discardAfter === state.installationAfter ? blocked('checkpoint_discarded') : report(state, now, measured, ctx.storage.sql.databaseSize);
      }
      if (state.phase === 'installing') {
        installSources(sql, state); selected = schema(sql);
        state.schemaSignature = signature(selected);
        state.sourceRevisions = JSON.stringify(sql.exec(`SELECT name,revision FROM ${SOURCES} ORDER BY name`));
        // Capture fences only after every source has a durable monitor. A write
        // before its monitor exists must not move past an earlier stored fence.
        if (state.installationAfter === state.presentTables.length) {state.tables = sourceFences(sql, state); state.phase = 'scanning';}
      }
      let remaining = input.batchSize, examined = 0;
      for (const table of state.tables) {
        if (table.complete || !remaining) continue;
        const projection = tables.find(item => item.name === table.name).columns;
        const page = sql.exec(`SELECT rowid AS scan_key,${projection} FROM ${table.name} NOT INDEXED WHERE ${table.after === null ? '' : 'rowid>? AND '}rowid<=? ORDER BY rowid LIMIT ?`,
          ...(table.after === null ? [] : [table.after]), table.through, remaining);
        for (const row of page) {
          if (!Number.isSafeInteger(row.scan_key)) throw Error('Unsafe source row key');
          table.count = add(table.count, 1);
          for (const key of ['key_bytes', 'pending', 'unsettled', 'delivered', 'private_requests', 'payload_bytes', 'accepted_version', 'invalid_json', 'conflicts']) if (row[key] !== undefined) {
            if (!integer(row[key])) throw Error('Invalid source scalar'); table[key] = add(table[key], row[key]);
          }
          table.after = row.scan_key;
        }
        remaining -= page.length; examined += page.length;
        if (!page.length || table.after === table.through) table.complete = true;
      }
      state.batchExamined = examined; state.revision = add(state.revision, 1);
      if (state.phase === 'scanning' && state.tables.every(table => table.complete)) state.phase = 'complete';
      if (state.tables.some(table => table.invalid_json)) {state.phase = 'blocked'; state.reason = 'unsupported_expression_index_data';}
      // One integer-primary-key row update is inside the pre-reserved envelope.
      sql.exec(`INSERT INTO ${CHECKPOINT}(id,checkpoint) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET checkpoint=excluded.checkpoint`, JSON.stringify(state));
      const measured = sql.measure(), size = ctx.storage.sql.databaseSize;
      if (measured.rowsRead > PLAN.stepRowsRead || measured.rowsWritten > PLAN.stepRowsWritten || size - state.databaseBytesAtStart > allocation.storedBytes
        || size > input.evidence.perObjectStoredBytesLimit) throw Error('Native preflight exceeded reserved envelope');
      return report(state, now, measured, size);
    }));
  } catch {return {...blocked('native_preflight_rolled_back'), preflightReserved: {...admission.reserved}, admission: {mode: 'external_atomic_before_sql', attempt: admission.attempt,
    accountPlanSignature: admission.accountPlanSignature, coordination: admission.coordination},
    native: {...sql.measure(), databaseBytes: ctx.storage.sql.databaseSize}};}
}

// A pure aggregate review, not a production authorization or quota reservation.
// Reports must come from current authenticated internal steps, never public input.
export function relayMigrationPreflightBudget(reports, options, now = Date.now()) {
  const problem = budgetInputsProblem(options, now); if (problem) return blocked(problem);
  if (!Array.isArray(reports) || reports.length !== options.allocations.length || new Set(reports.map(item => item?.scope)).size !== reports.length
    || reports.some(item => !item || !options.allocations.some(allocation => allocation.scope === item.scope))) return blocked('affected_scope_inventory_incomplete');
  if (reports.some(item => item.status !== 'complete' || item.planRevision !== PLAN.revision || item.sourceCommit !== PLAN.sourceCommit || item.candidateCommit !== PLAN.candidateCommit
    || item.admission?.mode !== 'external_atomic_before_sql' || !integer(item.admission.attempt) || item.admission.attempt < 1
    || item.accountPlanSignature !== accountPlanSignature(options) || item.admission.accountPlanSignature !== accountPlanSignature(options)
    || !exact(item.admission.coordination, ['planId', 'signature', 'reservations', 'rejections', 'reserved'])
    || item.admission.coordination.planId !== options.coordination.planId || item.admission.coordination.signature !== accountPlanSignature(options)
    || !integer(item.admission.coordination.reservations) || item.admission.coordination.reservations < item.admission.attempt || item.admission.coordination.reservations > options.coordination.maxReservations
    || !integer(item.admission.coordination.rejections) || item.admission.coordination.rejections > options.coordination.maxRejections
    || !exact(item.admission.coordination.reserved, ['rowsRead', 'rowsWritten', 'storedBytes'])
    || Object.keys(item.admission.coordination.reserved).some(key => item.admission.coordination.reserved[key] !== preparationReserve(options)[key])
    || item.allocationSignature !== allocationSignature(options) || !integer(item.observedAt) || item.observedAt > now || now - item.observedAt > PLAN.reportMaxAgeMs)) return blocked('inventory_incomplete_or_stale');
  try {
    // Include whole allocated preflight budgets, not only observed successful
    // statements. Failed/rolled-back calls still consume Cloudflare quota.
    const migration = sum(reports.map(item => item.estimate.total)), preflight = sum(options.allocations);
    const externalCoordinationReserve = coordinationReserve(options), total = sum([migration, preflight, options.reserve, externalCoordinationReserve]);
    if (Object.keys(total).some(key => add(options.evidence.account[key].used, total[key]) > options.evidence.account[key].limit)) return {...blocked('aggregate_quota_insufficient'), total};
    if (reports.some(item => add(item.native.databaseBytes, item.estimate.total.storedBytes) > options.evidence.perObjectStoredBytesLimit)) return {...blocked('object_storage_insufficient'), total};
    return {status: 'reviewable', reason: 'aggregate_bounds_fit_observed_evidence', planRevision: PLAN.revision,
      sourceCommit: PLAN.sourceCommit, candidateCommit: PLAN.candidateCommit, migration, preflight, ordinaryTrafficReserve: {...options.reserve}, externalCoordinationReserve, total,
      activation: 'requires_separately_reviewed_pre_ddl_routing_and_account_reservation'};
  } catch {return blocked('bound_overflow_or_invalid_report');}
}
