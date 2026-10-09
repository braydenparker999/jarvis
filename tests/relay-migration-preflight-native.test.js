import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {RELAY_MIGRATION_PREFLIGHT_PLAN as PLAN, relayMigrationPreflightAdmission, relayMigrationPreflightBudget, relayMigrationPreflightStep} from '../backend/relay-migration-preflight.js';

// All stores, labels, messages and usage evidence below are fictional. This
// worker exists only in local workerd and has no credential or external access.
const fixture = `
import {relayMigrationPreflightAdmission,relayMigrationPreflightStep} from './backend/relay-migration-preflight.js';
import {relayOAuthStore} from './backend/relay-oauth.js';
import {publicationSchema} from './backend/publications.js';
import {relayEventSchema} from './backend/relay-events.js';
import {relayOwnerSchema} from './backend/relay-owner.js';
import {relayOwnerJobEnsure,relayOwnerJobsList} from './backend/relay-owner-jobs.js';
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
      // Retained-row shapes from qualified c4. None of the seven candidate
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
    if(path==='/seed-oauth'){
      sql.exec('CREATE TABLE relay_oauth(key TEXT PRIMARY KEY,category TEXT NOT NULL,value TEXT NOT NULL,expires_at INTEGER NOT NULL)');
      sql.exec("INSERT INTO relay_oauth WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<?) SELECT 'fictional-oauth-'||n,CASE WHEN ? AND n%2=0 THEN 'client' ELSE 'grant' END,?,? FROM numbers",body.rows,body.legacyClients?1:0,JSON.stringify({fictional:true}),Date.now()+86400000);
      return Response.json({databaseBytes:sql.databaseSize});
    }
    if(path==='/state')return Response.json({checkpoint:[...sql.exec("SELECT name FROM sqlite_master WHERE name='relay_migration_preflight'")].length?[...sql.exec('SELECT checkpoint FROM relay_migration_preflight')].map(row=>JSON.parse(row.checkpoint)):[],
      attempts:[...sql.exec("SELECT name FROM sqlite_master WHERE name='relay_migration_preflight_attempts'")].length?[...sql.exec('SELECT attempts FROM relay_migration_preflight_attempts')][0]?.attempts:0,
      candidateIndices:[...sql.exec("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('shared_kind_seq','imported_comments_status','relay_event_created_seq','relay_outbox_event','relay_outbox_unsettled','relay_oauth_expiry','relay_oauth_category_expiry')")].map(row=>row.name)});
    if(path==='/old-write'){
      // Old workers retain positional inserts; only the tiny additive revision
      // monitor changes. No existing columns, replies or auth policies change.
      sql.exec("INSERT INTO relay_owner_entries VALUES(NULL,'ffffffff-0000-4000-8000-000000000001','user',NULL,'Fictional old worker message','2026-10-08T00:00:00Z','github:183016859','fictional-device','owner-device-session')");
      sql.exec("INSERT INTO shared_entries VALUES(NULL,'ffffffff-0000-4000-8000-000000000002','user',NULL,NULL,'Fictional old public message','2026-10-08T00:00:00Z')");
      sql.exec("INSERT INTO relay_outbox VALUES('fictional-old-subscription',999999,'{}','pending',0,0,NULL)");
      return Response.json({privateRows:[...sql.exec('SELECT COUNT(*) AS n FROM relay_owner_entries')][0].n});
    }
    if(path==='/same-cardinality-update'){sql.exec("UPDATE shared_entries SET body='Fictional changed message' WHERE seq=1");return Response.json({ok:true});}
    if(path==='/oauth-update'){sql.exec('UPDATE relay_oauth SET value=? WHERE rowid=1',JSON.stringify({fictional:'updated'}));return Response.json({ok:true});}
    if(path==='/old-oauth-write'){sql.exec("INSERT INTO relay_oauth VALUES('fictional-old-positional','grant','{}',?)",Date.now()+86400000);return Response.json({ok:true});}
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
    if(path==='/apply-oauth'){
      const value=relayOAuthStore(this.measured,{op:'get',key:'fictional-missing'},Date.now());
      return Response.json({...this.cost(),status:value.status});
    }
    if(path==='/apply-candidate'){
      this.ctx.storage.transactionSync(()=>{publicationSchema(this.measured);relayEventSchema(this.measured);relayOwnerSchema(this.measured);relayOAuthStore(this.measured,{op:'get',key:'fictional-missing'},Date.now());});
      let after='0',done=false,pages=0,executionClaims=0;
      while(!done&&pages<200){const value=this.ctx.storage.transactionSync(()=>relayOwnerJobsList(this.measured,this.env,after,50));done=value.nextCursor===null;if(value.nextCursor!==null)after=value.nextCursor;
        executionClaims+=value.jobs.filter(job=>job.stage!=='queued'||job.execution!==null||job.completion!==null).length;++pages;}
      return Response.json({...this.cost(),privateBackfillDone:done,executionClaims});
    }
    this.failCheckpoint=path==='/interrupt';
    if(path==='/no-admission')return Response.json({...relayMigrationPreflightStep(this.measured,body.input,body.now,body.permit),fixtureCost:this.cost()});
    const permit=await relayMigrationPreflightAdmission(this.measured,body.input,body.now,async reservation=>{
      const response=await this.env.FICTIONAL_ADMISSION.fetch('https://fictional-admission.test/reserve',{method:'POST',body:JSON.stringify(reservation)});
      if(!response.ok)throw Error('Fictional lost admission response');return response.json();
    });
    const value=permit.status==='blocked'?permit:relayMigrationPreflightStep(this.measured,body.input,body.now,permit);
    if(path==='/replay-permit'){
      this.queries=[];const replay=relayMigrationPreflightStep(this.measured,body.input,body.now,permit);
      return Response.json({first:value,replay,fixtureCost:this.cost()});
    }
    if(path==='/lost-step-response')return Response.json({status:'fictional-lost-response',fixtureCost:this.cost()});
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
  let egress = 0, loseAdmissionResponse = false;
  // The fictional test-host ledger is outside native SQL and survives object
  // reinstantiation. Plans are explicitly provisioned below before a request.
  // This does not implement or attest a production durable account allocator.
  const admissions = new Map(), provisioned = new Set();
  const key = (utcDay, scope) => utcDay + ':' + scope;
  const allocationSignature = allocations => JSON.stringify(allocations.toSorted((a,b)=>a.scope.localeCompare(b.scope)));
  const reserveAdmission = async request => {
    const claim = await request.json(), entry = admissions.get(key(claim.utcDay,claim.scope));
    if (!entry) return Response.json({status:'blocked',reason:'external_admission_unknown'});
    if (entry.signature !== claim.allocationSignature) return Response.json({status:'blocked',reason:'preflight_allocation_plan_changed'});
    const attempt = entry.attempts + 1;
    const reserved = {rowsRead:attempt*PLAN.stepRowsRead,rowsWritten:attempt*PLAN.stepRowsWritten,storedBytes:PLAN.checkpointBytes};
    if (Object.keys(reserved).some(dimension=>reserved[dimension]>entry.allocation[dimension])) {++entry.denials;return Response.json({status:'blocked',reason:'preflight_allocation_exhausted'});}
    // Synchronous atomic commit before responding, even if that response is lost.
    entry.attempts = attempt;
    if (loseAdmissionResponse) {loseAdmissionResponse=false;return new Response('Fictional lost receipt',{status:503});}
    return Response.json({status:'reserved',reservationId:claim.reservationId,utcDay:claim.utcDay,scope:claim.scope,
      allocationSignature:claim.allocationSignature,attempt,reserved});
  };
  const mf = new Miniflare(convertV4MiniflareOptions({name: 'fictional-preflight', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: configuration.compatibility_date, compatibilityFlags: configuration.compatibility_flags || [], cf: false, telemetry: {enabled: false},
    bindings: {RELAY_MCP_ENABLED: 'true', RELAY_OWNER_ENABLED: 'true'}, durableObjects: {HUBS: {className: 'PreflightFixture', useSQLite: true}},
    serviceBindings:{FICTIONAL_ADMISSION:reserveAdmission},
    outboundService() {++egress; throw Error('External egress prohibited in this fictional fixture');}}));
  t.after(async () => {await mf.dispose(); assert.equal(egress, 0);});
  return {loseNextAdmissionResponse(){loseAdmissionResponse=true;},loseAdmissionState(scope='fictional-main',utcDay=new Date().toISOString().slice(0,10)){admissions.delete(key(utcDay,scope));},
    admission(scope='fictional-main',utcDay=new Date().toISOString().slice(0,10)){return structuredClone(admissions.get(key(utcDay,scope)));},
    async call(path, body, scope = 'fictional-main') {
    if (body?.input) for (const allocation of body.input.allocations) {
      const entryKey=key(body.input.evidence.utcDay,allocation.scope);
      if(!provisioned.has(entryKey)){provisioned.add(entryKey);admissions.set(entryKey,{attempts:0,denials:0,allocation:structuredClone(allocation),signature:allocationSignature(body.input.allocations)});}
    }
    const response = await mf.dispatchFetch('https://fictional.example.test' + path + '?scope=' + scope,
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

test('admission is mandatory before native storage, binds the complete request and rejects stale, replayed or oversized reservation receipts', async () => {
  const now=Date.now(), configuration=options(now), request=input(configuration), ctx={get storage(){assert.fail('Denied admission must precede all native storage access');}};
  for(const permit of [undefined,{}, {status:'reserved',attempt:1}, {externalAdmission:true}]) {
    const result=relayMigrationPreflightStep(ctx,request,now,permit);
    assert.equal(result.reason,'external_admission_required');assert.equal(result.native.rowsRead,0);assert.equal(result.native.rowsWritten,0);
  }
  assert.equal((await relayMigrationPreflightAdmission(ctx,request,now)).reason,'external_admission_required');
  let previous, attempts=0;
  const reserve=claim=>previous={status:'reserved',reservationId:claim.reservationId,utcDay:claim.utcDay,scope:claim.scope,
    allocationSignature:claim.allocationSignature,attempt:++attempts,reserved:{rowsRead:attempts*PLAN.stepRowsRead,rowsWritten:attempts*PLAN.stepRowsWritten,storedBytes:PLAN.checkpointBytes}};
  const permit=await relayMigrationPreflightAdmission(ctx,request,now,reserve);
  assert.equal(relayMigrationPreflightStep(ctx,{...request,runId:'fictional-edited-run'},now,permit).reason,'external_admission_invalid');
  assert.equal(relayMigrationPreflightStep(ctx,request,now,permit).reason,'external_admission_required','A rejected use consumes its prepaid permit too');
  assert.equal((await relayMigrationPreflightAdmission(ctx,request,now,()=>previous)).reason,'external_admission_invalid','An old receipt cannot answer the next nonce');
  const differentContext=await relayMigrationPreflightAdmission(ctx,request,now,reserve);
  assert.equal(relayMigrationPreflightStep({get storage(){assert.fail('A different native context must not use the reservation');}},request,now,differentContext).reason,'external_admission_invalid');
  const invalidInput=await relayMigrationPreflightAdmission(ctx,request,now,reserve);
  assert.equal(relayMigrationPreflightStep(ctx,{...request,batchSize:999999},now,invalidInput).reason,'invalid_preflight_input');
  assert.equal(relayMigrationPreflightStep(ctx,request,now,invalidInput).reason,'external_admission_required');
  const stale=await relayMigrationPreflightAdmission(ctx,request,now,reserve);
  assert.equal(relayMigrationPreflightStep(ctx,request,now+PLAN.reportMaxAgeMs+1,stale).reason,'external_admission_invalid');
  for(const malformed of [claim=>({...reserve(claim),attempt:251,reserved:{rowsRead:251*PLAN.stepRowsRead,rowsWritten:251*PLAN.stepRowsWritten,storedBytes:PLAN.checkpointBytes}}),
    claim=>({...reserve(claim),reserved:{rowsRead:0,rowsWritten:0,storedBytes:0}}), claim=>({...reserve(claim),scope:'fictional-wrong-scope'})])
    assert.equal((await relayMigrationPreflightAdmission(ctx,request,now,malformed)).reason,'external_admission_invalid');
  const repeatedCounter=await relayMigrationPreflightAdmission(ctx,request,now,claim=>({...reserve(claim),attempt:1,
    reserved:{rowsRead:PLAN.stepRowsRead,rowsWritten:PLAN.stepRowsWritten,storedBytes:PLAN.checkpointBytes}}));
  assert.equal(repeatedCounter.reason,'preflight_admission_obsolete');assert.equal(repeatedCounter.native.rowsRead,0);assert.equal(repeatedCounter.native.rowsWritten,0);
  const concurrentContext={get storage(){assert.fail('An older concurrent receipt must be rejected before native storage');}};
  const receipt=(claim,attempt)=>({status:'reserved',reservationId:claim.reservationId,utcDay:claim.utcDay,scope:claim.scope,
    allocationSignature:claim.allocationSignature,attempt,reserved:{rowsRead:attempt*PLAN.stepRowsRead,rowsWritten:attempt*PLAN.stepRowsWritten,storedBytes:PLAN.checkpointBytes}});
  let releaseEarlier;
  const earlier=relayMigrationPreflightAdmission(concurrentContext,request,now,claim=>new Promise(resolve=>{releaseEarlier=()=>resolve(receipt(claim,1));}));
  await relayMigrationPreflightAdmission(concurrentContext,request,now,claim=>receipt(claim,2));
  releaseEarlier();const delayed=await earlier;
  assert.equal(delayed.reason,'preflight_admission_obsolete');assert.equal(delayed.native.rowsRead,0);assert.equal(delayed.native.rowsWritten,0);
});

test('native pinned OAuth inventory bounds both retained-row indexes and first-access legacy maintenance without exposing identity payloads', {timeout:30000}, async t=>{
  const f=await local(t),now=Date.now();
  for(const legacyClients of [false,true]) {
    const scope=legacyClients?'fictional-oauth-legacy':'fictional-oauth-cold',configuration=options(now,{scope});
    const seeded=await f.call('/seed-oauth',{rows:10000,legacyClients},scope);
    let value=await f.call('/step',{input:input(configuration),now},scope),pages=1,totalRead=value.native.rowsRead,totalWrite=value.native.rowsWritten;
    assert.deepEqual((await f.call('/state',undefined,scope)).candidateIndices,[]);
    while(value.status==='scanning'&&pages<50) {
      assert.ok(value.fixtureCost.queries.every(query=>!/(?:SELECT[^;]*(?:\bvalue\b|\bkey\b)\s+FROM\s+relay_oauth|CREATE\s+(?:UNIQUE\s+)?INDEX|COUNT\s*\()/i.test(query)));
      value=await f.call('/step',{input:input(configuration,{action:'continue',expectedRevision:value.revision}),now},scope);
      assert.ok(value.batchExamined<=250);assert.ok(value.native.rowsRead<=PLAN.stepRowsRead);assert.ok(value.native.rowsWritten<=PLAN.stepRowsWritten);
      totalRead+=value.native.rowsRead;totalWrite+=value.native.rowsWritten;++pages;
    }
    assert.equal(value.status,'complete');assert.equal(pages,40);assert.equal(value.tables.find(table=>table.name==='relay_oauth').count,10000);
    assert.ok(value.estimate.construction.rowsRead>=80000);assert.ok(value.estimate.construction.rowsWritten>=40000);
    assert.ok(value.estimate.oauthMaintenance.rowsRead>=80000);assert.ok(value.estimate.oauthMaintenance.rowsWritten>=160000);
    const decision=relayMigrationPreflightBudget([value],configuration,now);assert.equal(decision.status,'reviewable');
    const applied=await f.call('/apply-oauth',{},scope);assert.equal(applied.status,200);
    assert.deepEqual((await f.call('/state',undefined,scope)).candidateIndices.toSorted(),['relay_oauth_category_expiry','relay_oauth_expiry']);
    assert.ok(applied.rowsRead<=decision.migration.rowsRead);assert.ok(applied.rowsWritten<=decision.migration.rowsWritten);
    assert.ok(applied.databaseBytes-value.native.databaseBytes<=decision.migration.storedBytes);
    assert.ok(value.native.databaseBytes-seeded.databaseBytes<PLAN.checkpointBytes);
    process.stdout.write('FICTIONAL_NATIVE_OAUTH_PREFLIGHT '+JSON.stringify({legacyClients,pages,preflightRowsRead:totalRead,preflightRowsWritten:totalWrite,
      databaseBytesBefore:seeded.databaseBytes,databaseBytesAfterInventory:value.native.databaseBytes,
      migrationRowsRead:applied.rowsRead,migrationRowsWritten:applied.rowsWritten,databaseBytesAfterMigration:applied.databaseBytes,reservedMigration:decision.migration})+'\n');
  }
});

test('native OAuth content edits and old positional writes invalidate the durable inventory without changing registry shape or building indexes', {timeout:30000}, async t=>{
  const f=await local(t),now=Date.now();
  for(const path of ['/oauth-update','/old-oauth-write']) {
    const scope=path==='/oauth-update'?'fictional-oauth-update':'fictional-oauth-old',configuration=options(now,{scope});
    await f.call('/seed-oauth',{rows:11},scope);
    const initial=await f.call('/step',{input:input(configuration),now},scope);assert.equal(initial.status,'complete');
    await f.call(path,{},scope);
    const changed=await f.call('/reload-step',{input:input(configuration,{action:'report',expectedRevision:initial.revision}),now},scope);
    assert.equal(changed.reason,'cardinality_or_content_drift');assert.equal(relayMigrationPreflightBudget([changed],configuration,now).reason,'inventory_incomplete_or_stale');
    assert.deepEqual((await f.call('/state',undefined,scope)).candidateIndices,[]);
  }
});

test('native finite admissions make repeated exhausted, forged and replayed denials SQL-free, including object reload and concurrent callers', {timeout:30000}, async t=>{
  const f=await local(t),now=Date.now(),configuration=options(now);await f.call('/seed',{rows:17});
  configuration.allocations[0].rowsRead=PLAN.stepRowsRead;configuration.allocations[0].rowsWritten=PLAN.stepRowsWritten;
  for(const permit of [null,{}, {attempt:1,reserved:{rowsRead:PLAN.stepRowsRead}}]) {
    const denied=await f.call('/no-admission',{input:input(configuration),now,permit});
    assert.equal(denied.reason,'external_admission_required');assert.equal(denied.fixtureCost.rowsRead,0);assert.equal(denied.fixtureCost.rowsWritten,0);assert.deepEqual(denied.fixtureCost.queries,[]);
  }
  const competing=await Promise.all(['/step','/reload-step'].map(path=>f.call(path,{input:input(configuration),now})));
  assert.equal(competing.filter(result=>result.status==='complete').length,1);
  assert.equal(competing.filter(result=>result.reason==='preflight_allocation_exhausted').length,1);
  for(let n=0;n<20;++n) {
    const denied=await f.call(n%2?'/step':'/reload-step',{input:input(configuration,{action:'report'}),now});
    assert.equal(denied.reason,'preflight_allocation_exhausted');assert.equal(denied.native.rowsRead,0);assert.equal(denied.native.rowsWritten,0);
    assert.equal(denied.fixtureCost.rowsRead,0);assert.equal(denied.fixtureCost.rowsWritten,0);assert.deepEqual(denied.fixtureCost.queries,[]);
  }
  assert.equal((await f.call('/state')).attempts,1);assert.equal(f.admission().attempts,1);assert.ok(f.admission().denials>=1&&f.admission().denials<=21,'Known exhausted contexts avoid another external denial call too');
  const scope='fictional-replay',second=options(now,{scope});await f.call('/seed',{rows:3},scope);
  const replay=await f.call('/replay-permit',{input:input(second),now},scope);
  assert.equal(replay.first.status,'complete');assert.equal(replay.replay.reason,'external_admission_required');
  assert.equal(replay.fixtureCost.rowsRead,0);assert.equal(replay.fixtureCost.rowsWritten,0);assert.deepEqual(replay.fixtureCost.queries,[]);
});

test('native lost admission/SQL responses consume finite reservations and recover without rescan, while unknown external state cannot restart from zero', {timeout:30000}, async t=>{
  const f=await local(t),now=Date.now(),configuration=options(now);await f.call('/seed',{rows:123});
  configuration.allocations[0].rowsRead=5*PLAN.stepRowsRead;configuration.allocations[0].rowsWritten=5*PLAN.stepRowsWritten;
  f.loseNextAdmissionResponse();
  const noReceipt=await f.call('/step',{input:input(configuration,{batchSize:17}),now});
  assert.equal(noReceipt.reason,'external_admission_unavailable');assert.equal(noReceipt.fixtureCost.rowsRead,0);assert.equal(noReceipt.fixtureCost.rowsWritten,0);
  assert.equal(f.admission().attempts,1);assert.equal((await f.call('/state')).attempts,0);
  const initial=await f.call('/reload-step',{input:input(configuration,{batchSize:17}),now});
  assert.equal(initial.preflightReserved.rowsRead,2*PLAN.stepRowsRead);assert.equal(initial.admission.attempt,2);
  const lost=await f.call('/lost-step-response',{input:input(configuration,{action:'continue',expectedRevision:initial.revision,batchSize:17}),now});
  assert.equal(lost.status,'fictional-lost-response');assert.ok(lost.fixtureCost.rowsRead>0);
  const duplicate=await f.call('/reload-step',{input:input(configuration,{action:'continue',expectedRevision:initial.revision,batchSize:17}),now});
  assert.equal(duplicate.reason,'checkpoint_revision_mismatch');assert.ok(duplicate.native.rowsRead>0);assert.equal(duplicate.preflightReserved.rowsRead,4*PLAN.stepRowsRead);
  const recovered=await f.call('/reload-step',{input:input(configuration,{action:'report'}),now});
  assert.equal(recovered.tables[0].count,34);assert.equal(recovered.revision,initial.revision+1);assert.equal(recovered.batchExamined,0);
  assert.equal(recovered.preflightReserved.rowsRead,5*PLAN.stepRowsRead);assert.equal((await f.call('/state')).attempts,5);
  const exhausted=await f.call('/reload-step',{input:input(configuration,{action:'report'}),now});
  assert.equal(exhausted.reason,'preflight_allocation_exhausted');assert.equal(exhausted.fixtureCost.rowsRead,0);assert.equal(exhausted.fixtureCost.rowsWritten,0);
  f.loseAdmissionState();
  const unknown=await f.call('/reload-step',{input:input(configuration,{action:'report'}),now});
  assert.equal(unknown.reason,'external_admission_unknown');assert.equal(unknown.fixtureCost.rowsRead,0);assert.equal(unknown.fixtureCost.rowsWritten,0);
  assert.equal((await f.call('/state')).attempts,5);assert.deepEqual((await f.call('/state')).candidateIndices,[]);
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
