import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {RELAY_MIGRATION_PREFLIGHT_PLAN as PLAN, relayMigrationPreflightBudget, relayMigrationPreflightStep} from '../backend/relay-migration-preflight.js';

// All stores, labels, messages and usage evidence below are fictional. This
// worker exists only in local workerd and has no credential or external access.
const fixture = `
import {relayMigrationPreflightStep} from './backend/relay-migration-preflight.js';
import {publicationSchema} from './backend/publications.js';
import {relayEventSchema} from './backend/relay-events.js';
import {relayOwnerSchema} from './backend/relay-owner.js';
import {relayOwnerJobEnsure,relayOwnerJobsChanges} from './backend/relay-owner-jobs.js';
export class PreflightFixture {
  constructor(ctx,env){
    this.ctx=ctx;this.env=env;this.queries=[];this.failCheckpoint=false;
    const measuredSql={get databaseSize(){return ctx.storage.sql.databaseSize;},exec:(query,...values)=>{
      if(this.failCheckpoint&&query.startsWith('INSERT INTO relay_migration_preflight(')){this.failCheckpoint=false;throw Error('Fictional interrupted checkpoint commit');}
      const cursor=ctx.storage.sql.exec(query,...values);this.queries.push({query,cursor});return cursor;
    }};
    const storage=new Proxy(ctx.storage,{get:(target,key)=>key==='sql'?measuredSql:typeof target[key]==='function'?target[key].bind(target):target[key]});
    this.measured=new Proxy(ctx,{get:(target,key)=>key==='storage'?storage:typeof target[key]==='function'?target[key].bind(target):target[key]});
  }
  async fetch(request){
    const path=new URL(request.url).pathname,body=request.method==='POST'?await request.json():{},sql=this.ctx.storage.sql;
    if(path==='/seed'){
      // Retained-row shapes from qualified c4. None of the five candidate
      // retained-row indexes or public change tables exist before preflight.
      sql.exec("CREATE TABLE shared_entries(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('user','reply','briefing')),reply_to TEXT UNIQUE,title TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL)");
      sql.exec('CREATE TABLE shared_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      sql.exec('CREATE TABLE imported_comments(comment_id INTEGER PRIMARY KEY,publication TEXT NOT NULL,imported INTEGER NOT NULL DEFAULT 0,error TEXT)');
      sql.exec('CREATE TABLE relay_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,message_id TEXT NOT NULL UNIQUE,occurred_at TEXT NOT NULL,created_ms INTEGER NOT NULL,data TEXT NOT NULL)');
      sql.exec('CREATE TABLE relay_outbox(subscription_id TEXT NOT NULL,event_seq INTEGER NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL,last_error TEXT,PRIMARY KEY(subscription_id,event_seq))');
      sql.exec('CREATE INDEX relay_outbox_due ON relay_outbox(status,next_attempt_ms)');
      sql.exec('CREATE TABLE relay_event_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL)');
      sql.exec("INSERT INTO relay_event_meta VALUES('receipts-backfilled',1)");
      sql.exec("CREATE TABLE relay_owner_entries(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('user','reply')),reply_to TEXT UNIQUE,body TEXT NOT NULL,created_at TEXT NOT NULL,principal TEXT NOT NULL,device_id TEXT NOT NULL,authentication_source TEXT NOT NULL)");
      sql.exec('CREATE INDEX relay_owner_entry_kind_seq ON relay_owner_entries(kind,seq)');
      sql.exec('CREATE TABLE fixture_numbers(n INTEGER PRIMARY KEY)');
      sql.exec('INSERT INTO fixture_numbers WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<?) SELECT n FROM numbers',body.rows);
      sql.exec("INSERT INTO shared_entries(id,kind,body,created_at) SELECT printf('00000000-0000-4000-8000-%012d',n),'user','Fictional public request','2026-10-08T00:00:00Z' FROM fixture_numbers");
      // Comment IDs intentionally have large gaps; max(key) is not cardinality.
      sql.exec("INSERT INTO imported_comments SELECT n*1000000000,'{}',1,NULL FROM fixture_numbers");
      sql.exec("INSERT INTO relay_events(event_id,message_id,occurred_at,created_ms,data) SELECT 'fictional-event-'||n,'fictional-message-'||n,'2026-10-08T00:00:00Z',?,'{}' FROM fixture_numbers",Date.now());
      sql.exec("INSERT INTO relay_outbox SELECT 'fictional-subscription',n,'{}',CASE WHEN n%2=0 THEN 'delivered' ELSE 'failed' END,0,?,NULL FROM fixture_numbers",Date.now());
      sql.exec("INSERT INTO relay_owner_entries(id,kind,body,created_at,principal,device_id,authentication_source) SELECT printf('10000000-0000-4000-8000-%012d',n),'user','Fictional private request','2026-10-08T00:00:00Z','github:183016859','fictional-device','owner-device-session' FROM fixture_numbers WHERE n<=?",body.privateRows??body.rows);
      return Response.json({databaseBytes:sql.databaseSize});
    }
    if(path==='/state')return Response.json({checkpoint:[...sql.exec("SELECT name FROM sqlite_master WHERE name='relay_migration_preflight'")].length?[...sql.exec('SELECT checkpoint FROM relay_migration_preflight')].map(row=>JSON.parse(row.checkpoint)):[],
      attempts:[...sql.exec("SELECT name FROM sqlite_master WHERE name='relay_migration_preflight_attempts'")].length?[...sql.exec('SELECT attempts FROM relay_migration_preflight_attempts')][0]?.attempts:0,
      candidateIndices:[...sql.exec("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('shared_kind_seq','imported_comments_status','relay_event_created_seq','relay_outbox_event','relay_outbox_unsettled')")].map(row=>row.name)});
    if(path==='/old-write'){
      // Old workers retain positional inserts; only the tiny additive revision
      // monitor changes. No existing columns, replies or auth policies change.
      sql.exec("INSERT INTO relay_owner_entries VALUES(NULL,'ffffffff-0000-4000-8000-000000000001','user',NULL,'Fictional old worker message','2026-10-08T00:00:00Z','github:183016859','fictional-device','owner-device-session')");
      sql.exec("INSERT INTO shared_entries VALUES(NULL,'ffffffff-0000-4000-8000-000000000002','user',NULL,NULL,'Fictional old public message','2026-10-08T00:00:00Z')");
      sql.exec("INSERT INTO relay_outbox VALUES('fictional-old-subscription',999999,'{}','pending',0,0,NULL)");
      return Response.json({privateRows:[...sql.exec('SELECT COUNT(*) AS n FROM relay_owner_entries')][0].n});
    }
    if(path==='/same-cardinality-update'){sql.exec("UPDATE shared_entries SET body='Fictional changed message' WHERE seq=1");return Response.json({ok:true});}
    if(path==='/remove-watch'){sql.exec('DROP TRIGGER relay_migration_preflight_shared_entries_insert');return Response.json({ok:true});}
    if(path==='/unsupported-source'){sql.exec('DROP TABLE relay_events');sql.exec('CREATE VIEW relay_events AS SELECT n AS seq FROM fixture_numbers');return Response.json({ok:true});}
    if(path==='/old-job-history'){
      relayOwnerSchema(this.ctx);
      for(const request of sql.exec('SELECT * FROM relay_owner_entries')){
        const job=relayOwnerJobEnsure(this.ctx,request);
        for(let n=0;n<90;++n)sql.exec('INSERT INTO relay_owner_job_events(id,job_id,kind,summary,created_ms,authentication_source,argument_json,writer_id) VALUES(?,?,?,?,?,?,?,?)',
          job.id+'-fictional-'+n,job.id,'legacy_note','Fictional historical note',Date.now(),'owner-device-session','{}','fictional-device');
      }
      return Response.json({ok:true});
    }
    if(path==='/reload-step')return new PreflightFixture(this.ctx,this.env).fetch(new Request('https://fictional.example.test/step',{method:'POST',body:JSON.stringify(body)}));
    this.queries=[];
    if(path==='/apply-candidate'){
      this.ctx.storage.transactionSync(()=>{publicationSchema(this.measured);relayEventSchema(this.measured);relayOwnerSchema(this.measured);});
      let after='0',done=false,pages=0,executionClaims=0;
      while(!done&&pages<200){const value=this.ctx.storage.transactionSync(()=>relayOwnerJobsChanges(this.measured,this.env,after,50));after=value.cursor;done=!value.bootstrapPending&&value.nextCursor===null;
        executionClaims+=value.changes.filter(change=>change.job.stage!=='queued'||change.job.execution!==null||change.job.completion!==null).length;++pages;}
      return Response.json({...this.cost(),privateBackfillDone:done,executionClaims});
    }
    this.failCheckpoint=path==='/interrupt';
    const value=relayMigrationPreflightStep(this.measured,body.input,body.now);
    return Response.json({...value,fixtureCost:this.cost()});
  }
  cost(){return {rowsRead:this.queries.reduce((n,{cursor})=>n+cursor.rowsRead,0),rowsWritten:this.queries.reduce((n,{cursor})=>n+cursor.rowsWritten,0),databaseBytes:this.ctx.storage.sql.databaseSize,queries:this.queries.map(({query})=>query)};}
}
export default {fetch(request,env){const url=new URL(request.url),scope=url.searchParams.get('scope')||'fictional-main';return env.HUBS.get(env.HUBS.idFromName(scope)).fetch(request);}};
`;

function options(now, {scope = 'fictional-main', extraScope = null, storedBytes = 100000000, rowsWrittenLimit = 2000000} = {}) {
  return {evidence: {plan: 'workers-paid', utcDay: new Date(now).toISOString().slice(0, 10), windowStart: Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z'), capturedAt: now,
    account: {rowsRead: {used: 100000, limit: 5000000}, rowsWritten: {used: 1000, limit: rowsWrittenLimit}, storedBytes: {used: storedBytes + 1000000, limit: 5000000000}},
    namespace: {binding: 'HUBS', rowsRead: 10000, rowsWritten: 1000, storedBytes}, perObjectStoredBytesLimit: 1000000000},
    reserve: {rowsRead: 100000, rowsWritten: 10000, storedBytes: 10000000},
    allocations: [scope, ...(extraScope ? [extraScope] : [])].map(scope => ({scope, rowsRead: 500000, rowsWritten: 20000, storedBytes: 1048576}))};
}
const input = (configuration, overrides = {}) => ({action: 'start', runId: 'fictional-run-1', scope: configuration.allocations[0].scope,
  expectedRevision: null, batchSize: 250, ...configuration, ...overrides});
async function local(t) {
  const configuration = JSON.parse(readFileSync(new URL('../backend/wrangler.jsonc', import.meta.url), 'utf8'));
  const bundle = await build({stdin: {contents: fixture, resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'fictional-migration-preflight.js'}, bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', external: ['node:crypto']});
  let egress = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({name: 'fictional-preflight', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: configuration.compatibility_date, compatibilityFlags: configuration.compatibility_flags || [], cf: false, telemetry: {enabled: false},
    bindings: {RELAY_MCP_ENABLED: 'true', RELAY_OWNER_ENABLED: 'true'}, durableObjects: {HUBS: {className: 'PreflightFixture', useSQLite: true}},
    outboundService() {++egress; throw Error('External egress prohibited in this fictional fixture');}}));
  t.after(async () => {await mf.dispose(); assert.equal(egress, 0);});
  return {async call(path, body, scope = 'fictional-main') {const response = await mf.dispatchFetch('https://fictional.example.test' + path + '?scope=' + scope,
    body ? {method: 'POST', body: JSON.stringify(body)} : undefined); assert.equal(response.status, 200); return response.json();}};
}

test('missing, unknown, stale or inconsistent quota evidence and ordinary reserve cannot issue SQL or assume zero usage', () => {
  const now = Date.now(), configuration = options(now), ctx = {get storage() {throw Error('No native storage access allowed');}};
  for (const mutate of [value => {value.evidence = null;}, value => {delete value.evidence.account.rowsRead.used;},
    value => {value.evidence.capturedAt = now - PLAN.evidenceMaxAgeMs - 1;}, value => {value.evidence.capturedAt = now + 1;},
    value => {value.evidence.utcDay = '2020-01-01';}, value => {value.evidence.namespace.rowsWritten = 999999;},
    value => {value.evidence.windowStart += 3 * 3600000;}, value => {value.evidence.namespace.binding = 'unidentified-resource';},
    value => {value.reserve.rowsRead = 0;}, value => {value.allocations = [];}, value => {value.evidence.account.rowsWritten.limit = 1001;}]) {
    const value = input(structuredClone(configuration)); mutate(value);
    assert.equal(relayMigrationPreflightStep(ctx, value, now).status, 'blocked');
  }
});

test('native retained private lifecycle history increases the cold reserve without treating callback or historical notes as execution', {timeout: 30000}, async t => {
  const f = await local(t), now = Date.now(), configuration = options(now); await f.call('/seed', {rows: 100}); await f.call('/old-job-history', {});
  let value = await f.call('/step', {input: input(configuration), now}), pages = 1;
  while (value.status === 'scanning' && pages < 100) {value = await f.call('/step', {input: input(configuration, {action: 'continue', expectedRevision: value.revision}), now}); ++pages;}
  assert.equal(value.status, 'complete');
  assert.equal(value.tables.find(table => table.name === 'relay_owner_job_events').count, 9100);
  assert.ok(value.estimate.corePrivateReserve.rowsRead > 9100 * 16);
  const decision = relayMigrationPreflightBudget([value], configuration, now); assert.equal(decision.status, 'reviewable');
  const applied = await f.call('/apply-candidate', {}); assert.equal(applied.privateBackfillDone, true);
  assert.equal(applied.executionClaims, 0);
  assert.ok(applied.rowsRead <= decision.migration.rowsRead); assert.ok(applied.rowsWritten <= decision.migration.rowsWritten);
});

test('native bounded keyed scans checkpoint before retained-row indexes, then conservatively aggregate actual construction and backfill costs', {timeout: 30000}, async t => {
  const f = await local(t), now = Date.now(), configuration = options(now);
  const seeded = await f.call('/seed', {rows: 5000});
  let value = await f.call('/step', {input: input(configuration), now}), pages = 1, totalRead = value.native.rowsRead, totalWrite = value.native.rowsWritten;
  assert.equal(value.status, 'scanning'); assert.equal(value.batchExamined, 250);
  assert.deepEqual((await f.call('/state')).candidateIndices, []);
  while (value.status === 'scanning' && pages < 150) {
    assert.ok(value.fixtureCost.queries.every(query => !/COUNT\s*\(|CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(query)));
    value = await f.call('/step', {input: input(configuration, {action: 'continue', expectedRevision: value.revision}), now});
    assert.ok(value.batchExamined <= 250); assert.ok(value.native.rowsRead <= PLAN.stepRowsRead); assert.ok(value.native.rowsWritten <= PLAN.stepRowsWritten);
    assert.equal(value.native.rowsRead, value.fixtureCost.rowsRead); assert.equal(value.native.rowsWritten, value.fixtureCost.rowsWritten);
    totalRead += value.native.rowsRead; totalWrite += value.native.rowsWritten; ++pages;
  }
  assert.equal(value.status, 'complete'); assert.equal(pages, 100);
  assert.ok(value.tables.filter(table => table.count).every(table => table.count === 5000), 'Sparse, billion-scale comment keys are not table cardinality');
  assert.equal(value.tables.find(table => table.name === 'relay_owner_entries').count, 5000);
  assert.ok(value.native.databaseBytes >= seeded.databaseBytes); assert.ok(value.native.databaseBytes - seeded.databaseBytes < PLAN.checkpointBytes);
  const decision = relayMigrationPreflightBudget([value], configuration, now);
  assert.equal(decision.status, 'reviewable'); assert.match(decision.activation, /separately_reviewed/);
  const applied = await f.call('/apply-candidate', {});
  assert.equal(applied.privateBackfillDone, true); assert.equal(applied.executionClaims, 0);
  assert.ok(applied.rowsRead <= decision.migration.rowsRead); assert.ok(applied.rowsWritten <= decision.migration.rowsWritten);
  assert.ok(applied.databaseBytes - value.native.databaseBytes <= decision.migration.storedBytes);
  process.stdout.write('FICTIONAL_NATIVE_PREFLIGHT ' + JSON.stringify({pages, preflightRowsRead: totalRead, preflightRowsWritten: totalWrite,
    databaseBytesBefore: seeded.databaseBytes, databaseBytesAfterInventory: value.native.databaseBytes,
    migrationRowsRead: applied.rowsRead, migrationRowsWritten: applied.rowsWritten, databaseBytesAfterMigration: applied.databaseBytes,
    reservedMigration: decision.migration}) + '\n');
  const constrained = structuredClone(configuration); constrained.evidence.account.rowsWritten.limit = 100000;
  assert.equal(relayMigrationPreflightBudget([value], constrained, now).reason, 'aggregate_quota_insufficient');
});

test('native interrupted checkpoint rolls back inventory while keeping billed-attempt reservations durable across reload, stale pages and discard', {timeout: 30000}, async t => {
  const f = await local(t), now = Date.now(), seeded = await f.call('/seed', {rows: 123, privateRows: 3}), configuration = options(now, {storedBytes: seeded.databaseBytes});
  const start = await f.call('/step', {input: input(configuration, {batchSize: 17}), now});
  const failed = await f.call('/interrupt', {input: input(configuration, {action: 'continue', expectedRevision: start.revision, batchSize: 17}), now});
  assert.equal(failed.reason, 'native_preflight_rolled_back');
  const after = await f.call('/state'); assert.equal(after.checkpoint[0].revision, start.revision); assert.equal(after.attempts, 2);
  const resumed = await f.call('/reload-step', {input: input(configuration, {action: 'continue', expectedRevision: start.revision, batchSize: 17}), now});
  assert.equal(resumed.revision, start.revision + 1); assert.equal(resumed.tables[0].count, 34); assert.equal(resumed.preflightReserved.rowsRead, 3 * PLAN.stepRowsRead);
  const stale = await f.call('/step', {input: input(configuration, {action: 'continue', expectedRevision: start.revision, batchSize: 17}), now});
  assert.equal(stale.reason, 'checkpoint_revision_mismatch');
  await f.call('/step', {input: input(configuration, {action: 'discard', expectedRevision: resumed.revision}), now});
  const discarded = await f.call('/state'); assert.deepEqual(discarded.checkpoint, []); assert.equal(discarded.attempts, 5);
  const restart = await f.call('/step', {input: input(configuration, {runId: 'fictional-run-2', batchSize: 17}), now});
  assert.equal(restart.tables[0].count, 17); assert.equal(restart.preflightReserved.rowsWritten, 6 * PLAN.stepRowsWritten);
});

test('native first-page rollback retains its quota reservation and repeated failures cannot exceed the declared scan allocation', {timeout: 30000}, async t => {
  const f = await local(t), now = Date.now(), configuration = options(now); await f.call('/seed', {rows: 17});
  configuration.allocations[0].rowsRead = 2 * PLAN.stepRowsRead; configuration.allocations[0].rowsWritten = 2 * PLAN.stepRowsWritten;
  const first = await f.call('/interrupt', {input: input(configuration), now}); assert.equal(first.reason, 'native_preflight_rolled_back');
  const after = await f.call('/state'); assert.deepEqual(after.checkpoint, []); assert.equal(after.attempts, 1);
  const second = await f.call('/interrupt', {input: input(configuration), now}); assert.equal(second.reason, 'native_preflight_rolled_back');
  const exhausted = await f.call('/step', {input: input(configuration), now}); assert.equal(exhausted.reason, 'preflight_allocation_exhausted');
  assert.equal((await f.call('/state')).attempts, 2); assert.deepEqual((await f.call('/state')).candidateIndices, []);
});

test('native unsupported source schemas remain unknown rather than becoming an empty cardinality credit', {timeout: 30000}, async t => {
  const f = await local(t), now = Date.now(), configuration = options(now); await f.call('/seed', {rows: 17}); await f.call('/unsupported-source', {});
  const value = await f.call('/step', {input: input(configuration), now}); assert.equal(value.reason, 'native_preflight_rolled_back');
  assert.deepEqual((await f.call('/state')).checkpoint, []); assert.equal((await f.call('/state')).attempts, 1);
  assert.deepEqual((await f.call('/state')).candidateIndices, []);
});

test('native old positional inserts, equal-cardinality updates and removed source guards invalidate preflight without changing old worker contracts', {timeout: 30000}, async t => {
  const f = await local(t), now = Date.now();
  for (const [scope, path, reason] of [['fictional-old-worker', '/old-write', 'cardinality_or_content_drift'],
    ['fictional-update', '/same-cardinality-update', 'cardinality_or_content_drift'], ['fictional-schema', '/remove-watch', 'schema_drift']]) {
    const configuration = options(now, {scope}); await f.call('/seed', {rows: 17}, scope);
    const start = await f.call('/step', {input: input(configuration), now}, scope); assert.equal(start.status, 'complete');
    const changed = await f.call(path, {}, scope); if (path === '/old-write') assert.equal(changed.privateRows, 18);
    const fresh = await f.call('/step', {input: input(configuration, {action: 'report', expectedRevision: start.revision}), now}, scope);
    assert.equal(fresh.status, 'blocked'); assert.equal(fresh.reason, reason);
    assert.equal(relayMigrationPreflightBudget([fresh], configuration, now).reason, 'inventory_incomplete_or_stale');
    assert.deepEqual((await f.call('/state', undefined, scope)).candidateIndices, []);
  }
});

test('aggregate never grants an incomplete multi-Hub inventory, stale report or midnight quota rollover and preserves per-object storage headroom', {timeout: 30000}, async t => {
  const f = await local(t), now = Date.now(), configuration = options(now, {extraScope: 'fictional-legacy'}); await f.call('/seed', {rows: 3});
  const value = await f.call('/step', {input: input(configuration), now}); assert.equal(value.status, 'complete');
  assert.equal(relayMigrationPreflightBudget([value], configuration, now).reason, 'affected_scope_inventory_incomplete');
  await f.call('/seed', {rows: 2}, 'fictional-legacy');
  const second = await f.call('/step', {input: input(configuration, {scope: 'fictional-legacy'}), now}, 'fictional-legacy');
  assert.equal(relayMigrationPreflightBudget([value, second], configuration, now).status, 'reviewable');
  assert.equal(relayMigrationPreflightBudget([value, second], configuration, now + PLAN.reportMaxAgeMs + 1).reason, 'inventory_incomplete_or_stale');
  const tomorrow = Date.parse(configuration.evidence.utcDay + 'T00:00:00Z') + 86400000;
  assert.equal(relayMigrationPreflightBudget([value, second], configuration, tomorrow).reason, 'quota_evidence_stale');
  const tight = structuredClone(configuration); tight.evidence.perObjectStoredBytesLimit = value.native.databaseBytes + 1;
  assert.equal(relayMigrationPreflightBudget([value, second], tight, now).reason, 'object_storage_insufficient');
});
