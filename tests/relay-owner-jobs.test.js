import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayFixture} from './relay-fixture.js';
import {Hub} from '../backend/worker.js';
import {relayOwnerStore, relayOwnerRpc} from '../backend/relay-owner.js';
import {relayOwnerJobTools} from '../backend/relay-owner-job-tools.js';
import {RELAY_OWNER_JOB_LEASE_MS} from '../backend/relay-owner-jobs.js';
import {relayOAuthStore} from '../backend/relay-oauth.js';
import {relayRpc} from '../backend/relay-connector.js';
import {relaySubscribe, relayEventSchema, enqueueRelayOwnerMessage, drainRelayOutbox} from '../backend/relay-events.js';
import {sharedStore, SHARED_OBJECT} from '../backend/shared.js';
import {PRIMARY_SITE} from '../backend/origins.js';
import {RELAY_OWNER, RELAY_OWNER_INBOX, RELAY_OWNER_SCOPE, RELAY_PUBLIC_SCOPES, RELAY_OWNER_EVENT, RELAY_CALLBACK, random, hash, challenge} from '../backend/relay-common.js';

async function grant(s, scope = RELAY_OWNER_SCOPE) {
  const client = random(), grantId = random(), code = random(), access = random(), refresh = random();
  const registry = body => relayOAuthStore(s.ctx, body).json(), resource = s.env.RELAY_MCP_ORIGIN + '/relay/mcp';
  await registry({op: 'put', key: 'client:' + client, category: 'client', value: {redirect: RELAY_CALLBACK}, expiresAt: Date.now() + 600000});
  const params = {client_id: client, redirect_uri: RELAY_CALLBACK, code_challenge: await challenge(random()), scope};
  await registry({op: 'authorize', grantId, codeKey: 'code:' + await hash(code), params, resource});
  const accessHash = await hash(access);
  await registry({op: 'exchange', key: 'code:' + await hash(code), match: {client_id: client, redirect_uri: RELAY_CALLBACK, challenge: params.code_challenge, resource},
    accessKey: 'access:' + accessHash, refreshKey: 'refresh:' + await hash(refresh)});
  return {principal: RELAY_OWNER, grantId, scopes: scope.split(' '), accessHash, access, client, registry};
}
async function fixture(t) {
  const s = createRelayFixture({env: {RELAY_OWNER_ENABLED: 'true'}}); t.after(() => s.close());
  s.ctx = s.object(SHARED_OBJECT).ctx;
  relayEventSchema(s.ctx);
  s.sql = (query, ...values) => [...s.ctx.storage.sql.exec(query, ...values)];
  s.auth = await grant(s);
  s.rpc = (name, args, principal = s.auth) => relayOwnerRpc(s.ctx, s.env, principal, name, {inbox_id: RELAY_OWNER_INBOX, ...args});
  s.phone = (path, body, token = s.token, options = {}) => s.request('/relay/owner' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: {Origin: PRIMARY_SITE, ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      ...(token ? {Authorization: 'Bearer ' + token} : {}), ...options.headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const pair = await (await s.phone('/pair/start', {label: 'Private job fixture'}, null)).json();
  const approval = await relayOwnerRpc(s.ctx, s.env, s.auth, 'relay_owner_pairing_approve', {request_id: pair.request_id, code: pair.code, access_days: 365, confirm: true});
  s.token = pair.device_token; s.tokenHash = await hash(s.token); s.deviceId = approval.device.id;
  s.create = async (options = {}) => {
    const payload = {id: crypto.randomUUID(), title: 'Inspect a private request', body: 'Private fixture request', action_kind: 'read_only', ...options};
    const response = await s.phone('/jobs', payload);
    return {response, payload, ...await response.json()};
  };
  s.read = id => s.phone('/jobs/detail?job_id=' + id).then(response => response.json());
  s.claim = (id, options = {}) => s.rpc('relay_owner_job_claim', {job_id: id, event_id: crypto.randomUUID(), run_id: crypto.randomUUID(), ...options});
  return s;
}
const receiver = async (_url, init) => {
  const body = JSON.parse(init.body);
  return body.type === 'verification' ? Response.json({challenge: body.challenge}) : new Response(null, {status: 204});
};
const subscription = {name: RELAY_OWNER_EVENT, arguments: {inbox_id: RELAY_OWNER_INBOX}, delivery: {mode: 'webhook', url: 'https://private.example/callback', secret: 'whsec_' + Buffer.alloc(32, 17).toString('base64')}, cursor: 'relay1:0'};
const rejects = (operation, status = 409) => assert.rejects(operation, error => error.data?.status === status);

test('private jobs atomically save their ordinary request, durable lifecycle and existing private event', async t => {
  const s = await fixture(t), created = await s.create();
  assert.equal(created.response.status, 201); assert.equal(created.newWrite, true);
  assert.equal(created.job.id, created.payload.id); assert.equal(created.entry.id, created.job.id);
  assert.equal(created.job.sequence, created.entry.sequence); assert.equal(created.job.stage, 'queued');
  assert.equal(created.job.execution, null); assert.equal(created.job.result, null);
  assert.equal(created.job.author_authenticated, true); assert.equal(created.job.principal, RELAY_OWNER);
  assert.equal(created.job.device_id, s.deviceId); assert.equal(created.job.visibility, 'private');
  assert.equal(s.sql('SELECT COUNT(*) AS n FROM relay_owner_jobs')[0].n, 1);
  assert.equal(s.sql('SELECT COUNT(*) AS n FROM relay_owner_entries')[0].n, 1);
  assert.equal(s.sql('SELECT COUNT(*) AS n FROM relay_events WHERE message_id=?', 'owner:' + created.job.id)[0].n, 1);
  assert.ok(s.object(SHARED_OBJECT).alarms.length, 'the existing durable wake precedes insertion');
  const restarted = new Hub(s.ctx, s.env);
  const restored = await restarted.fetch(new Request('https://internal/internal/relay/owner', {method: 'POST', body: JSON.stringify({op: 'job_read', token_hash: s.tokenHash, job_id: created.job.id})}));
  assert.deepEqual((await restored.json()).job, created.job, 'fresh Hub reads the same durable SQLite record');
  const publicState = await sharedStore(s.ctx, '/internal/shared/state').json();
  assert.ok(!JSON.stringify(publicState).includes(created.payload.body));
  assert.equal(s.sql('SELECT COUNT(*) AS n FROM shared_entries WHERE id=?', created.job.id)[0].n, 0);
});

test('create is idempotent by stable request and payload, while conflicting bodies, metadata and device provenance fail', async t => {
  const s = await fixture(t), first = await s.create();
  const duplicate = await s.phone('/jobs', first.payload), replay = await duplicate.json();
  assert.equal(duplicate.status, 200); assert.equal(replay.newWrite, false); assert.equal(replay.job.id, first.job.id);
  for (const change of [{body: 'Conflicting body'}, {title: 'Different title'}, {action_kind: 'draft'}]) {
    assert.equal((await s.phone('/jobs', {...first.payload, ...change})).status, 409);
  }
  const otherPair = await (await s.phone('/pair/start', {label: 'Other'}, null)).json();
  await relayOwnerRpc(s.ctx, s.env, s.auth, 'relay_owner_pairing_approve', {request_id: otherPair.request_id, code: otherPair.code, access_days: 365, confirm: true});
  assert.equal((await s.phone('/jobs', first.payload, otherPair.device_token)).status, 409);
  assert.equal(s.sql('SELECT COUNT(*) AS n FROM relay_owner_jobs')[0].n, 1);
  assert.equal(s.sql('SELECT COUNT(*) AS n FROM relay_events WHERE message_id=?', 'owner:' + first.job.id)[0].n, 1);
  assert.equal(s.sql('SELECT value FROM relay_owner_meta WHERE key LIKE ?', 'messages:%')[0].value, '1');
});

test('event or job persistence failure rolls back message, job, events, rate accounting and session renewal together', async t => {
  let now = 1700000000000; t.mock.method(Date, 'now', () => now);
  const s = await fixture(t), before = s.sql('SELECT * FROM relay_owner_sessions')[0]; now += 1000;
  const input = {op: 'job_create', token_hash: s.tokenHash, id: crypto.randomUUID(), title: 'Rollback', body: 'Private rollback', action_kind: 'draft'};
  await assert.rejects(relayOwnerStore(s.ctx, s.env, input, (ctx, entry) => { enqueueRelayOwnerMessage(ctx, entry); throw Error('Outbox unavailable'); }));
  for (const table of ['relay_owner_entries', 'relay_owner_jobs', 'relay_owner_job_events', 'relay_owner_meta', 'relay_events']) assert.equal(s.sql('SELECT COUNT(*) AS n FROM ' + table)[0].n, 0, table);
  assert.deepEqual(s.sql('SELECT * FROM relay_owner_sessions')[0], before);
  const exec = s.ctx.storage.sql.exec;
  s.ctx.storage.sql.exec = (query, ...values) => {
    if (query.startsWith('INSERT INTO relay_owner_job_events')) throw Error('Job journal unavailable');
    return exec(query, ...values);
  };
  await assert.rejects(relayOwnerStore(s.ctx, s.env, input, enqueueRelayOwnerMessage));
  s.ctx.storage.sql.exec = exec;
  assert.equal(s.sql('SELECT COUNT(*) AS n FROM relay_owner_entries')[0].n, 0);
  assert.equal(s.sql('SELECT COUNT(*) AS n FROM relay_owner_jobs')[0].n, 0);
});

test('normal authenticated owner reply completes a queued job without new catalog, claim, body marker or callback', async t => {
  const s = await fixture(t), created = await s.create(), body = 'Verified release result. <script>private data</script> https://example.test/result';
  const first = await s.rpc('relay_owner_reply', {message_id: created.job.id, body});
  assert.equal(first.newWrite, true);
  const read = await s.read(created.job.id);
  assert.equal(read.job.stage, 'completed'); assert.equal(read.job.result.body, body);
  assert.equal(read.job.result.format, 'plain_text'); assert.equal(read.job.result.replyId, first.entry.id);
  assert.equal(read.job.execution, null); assert.equal(read.job.delivery.state, 'reply_saved');
  assert.equal(read.events.filter(event => event.kind === 'completed').length, 1);
  assert.ok(!read.events.some(event => ['running', 'claimed'].includes(event.kind)));
  const retry = await s.rpc('relay_owner_reply', {message_id: created.job.id, body});
  assert.equal(retry.newWrite, false); assert.equal(retry.entry.id, first.entry.id);
  await rejects(s.rpc('relay_owner_reply', {message_id: created.job.id, body: 'A conflicting result'}));
  assert.equal((await s.read(created.job.id)).events.filter(event => event.kind === 'completed').length, 1);
});

test('historical ordinary requests materialize lazily as unclassified and use actual immutable replies as completion evidence', async t => {
  const s = await fixture(t), ids = [crypto.randomUUID(), crypto.randomUUID()], replyId = crypto.randomUUID();
  const firstAt = '2025-01-01T12:00:00.000Z', secondAt = '2025-01-02T12:00:00.000Z', replyAt = '2025-01-03T12:00:00.000Z';
  for (const [i, id] of ids.entries()) s.sql("INSERT INTO relay_owner_entries(id,kind,body,created_at,principal,device_id,authentication_source) VALUES(?,'user',?,?,?,?,?)", id,
    i ? 'Perform consequential private work' : 'Read data (never infer read-only from this body)', i ? secondAt : firstAt, RELAY_OWNER, s.deviceId, 'owner-device-session');
  s.sql("INSERT INTO relay_owner_entries(id,kind,reply_to,body,created_at,principal,device_id,authentication_source) VALUES(?,'reply',?,?,?,?,?,?)", replyId, ids[1], 'Actual prior final result', replyAt, RELAY_OWNER, s.deviceId, 'owner-oauth-mcp');
  const eventCount = s.sql('SELECT COUNT(*) AS n FROM relay_events')[0].n;
  assert.equal(s.sql('SELECT COUNT(*) AS n FROM relay_owner_jobs')[0].n, 0);
  const firstPage = await (await s.phone('/jobs?limit=1')).json();
  assert.equal(firstPage.jobs.length, 1); assert.equal(firstPage.jobs[0].actionKind, 'unclassified');
  assert.equal(firstPage.jobs[0].stage, 'queued'); assert.equal(firstPage.jobs[0].retryAllowed, false);
  assert.equal(s.sql('SELECT COUNT(*) AS n FROM relay_owner_jobs')[0].n, 1, 'only selected page materializes');
  const nextPage = await (await s.phone('/jobs?limit=1&after=' + firstPage.nextCursor)).json();
  assert.equal(nextPage.jobs[0].stage, 'completed'); assert.equal(nextPage.jobs[0].result.replyId, replyId);
  assert.equal(nextPage.jobs[0].finishedAt, replyAt); assert.equal(nextPage.jobs[0].execution, null);
  assert.equal(nextPage.nextCursor, null); assert.ok(nextPage.jobs[0].sequence > firstPage.jobs[0].sequence);
  assert.equal(s.sql('SELECT COUNT(*) AS n FROM relay_events')[0].n, eventCount, 'historical materialization never replays callbacks');
});

test('reply from a restored older Worker reconciles existing durable metadata without inventing execution', async t => {
  const s = await fixture(t), created = await s.create(), replyId = crypto.randomUUID(), acceptedAt = new Date().toISOString();
  s.sql("INSERT INTO relay_owner_entries(id,kind,reply_to,body,created_at,principal,device_id,authentication_source) VALUES(?,'reply',?,?,?,?,?,?)", replyId, created.job.id, 'Accepted by prior Worker', acceptedAt, RELAY_OWNER, s.deviceId, 'owner-oauth-mcp');
  assert.equal(s.sql('SELECT stage FROM relay_owner_jobs WHERE id=?', created.job.id)[0].stage, 'queued');
  const restored = await s.read(created.job.id);
  assert.equal(restored.job.stage, 'completed'); assert.equal(restored.job.finishedAt, acceptedAt);
  assert.equal(restored.job.result.replyId, replyId); assert.equal(restored.job.execution, null);
});

test('callback 2xx and duplicate delivery receipts never claim execution or complete the durable job', async t => {
  const s = await fixture(t);
  await relaySubscribe(s.ctx, s.auth, subscription, s.env, receiver);
  const created = await s.create();
  await drainRelayOutbox(s.ctx, s.env, receiver); await drainRelayOutbox(s.ctx, s.env, receiver);
  const read = await s.read(created.job.id);
  assert.equal(read.job.delivery.state, 'callback_accepted'); assert.ok(read.job.delivery.callbackAcceptedAt);
  assert.equal(read.job.stage, 'queued'); assert.equal(read.job.execution, null); assert.equal(read.job.result, null);
  assert.ok(!read.events.some(event => ['claimed', 'completed'].includes(event.kind)));
});

test('competing authenticated claims are atomic, grant/run-bound, and exact event retries do not renew leases', async t => {
  let now = 1700000000000; t.mock.method(Date, 'now', () => now);
  const s = await fixture(t), created = await s.create(), other = await grant(s);
  const args = {job_id: created.job.id, event_id: crypto.randomUUID(), run_id: crypto.randomUUID()};
  const claims = await Promise.allSettled([s.rpc('relay_owner_job_claim', args), s.rpc('relay_owner_job_claim', {...args, event_id: crypto.randomUUID(), run_id: crypto.randomUUID()}, other)]);
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(claims[0].value.job.stage, 'running'); assert.equal(claims[0].value.job.execution.runId, args.run_id);
  const expiry = claims[0].value.job.execution.leaseExpiresAt; now += 1000;
  const repeated = await s.rpc('relay_owner_job_claim', args);
  assert.equal(repeated.newWrite, false); assert.equal(repeated.job.execution.leaseExpiresAt, expiry);
  await rejects(s.rpc('relay_owner_job_claim', args, other));
  await rejects(s.rpc('relay_owner_job_claim', {...args, run_id: crypto.randomUUID()}));
  await rejects(s.rpc('relay_owner_reply', {message_id: created.job.id, body: 'Different execution'}, other));
  const heartbeat = {job_id: created.job.id, run_id: args.run_id, event_id: crypto.randomUUID(), stage: 'running'};
  await rejects(s.rpc('relay_owner_job_update', {...heartbeat, run_id: crypto.randomUUID()}));
  await rejects(s.rpc('relay_owner_job_update', heartbeat, other));
  const renewed = await s.rpc('relay_owner_job_update', heartbeat);
  assert.equal(Date.parse(renewed.job.execution.leaseExpiresAt), now + RELAY_OWNER_JOB_LEASE_MS);
  now += 1000;
  assert.equal((await s.rpc('relay_owner_job_update', heartbeat)).job.execution.leaseExpiresAt, renewed.job.execution.leaseExpiresAt);
  await s.rpc('relay_owner_reply', {message_id: created.job.id, body: 'Matching authenticated final result'});
  assert.equal((await s.read(created.job.id)).job.stage, 'completed');
});

test('expired execution acknowledgement reports unknown outcome, never silently reclaims, and guards retry attempts', async t => {
  let now = 1700000000000; t.mock.method(Date, 'now', () => now);
  const s = await fixture(t), created = await s.create(), claimed = await s.claim(created.job.id);
  now += RELAY_OWNER_JOB_LEASE_MS;
  const stale = await s.read(created.job.id);
  assert.equal(stale.job.stage, 'outcome_unknown'); assert.equal(stale.job.failure.outcome, 'unknown');
  assert.equal(stale.job.retryAllowed, true); assert.equal(stale.job.retryRequiresConfirmation, true);
  assert.equal(stale.job.execution.acknowledgedAt, claimed.job.execution.acknowledgedAt);
  await rejects(s.claim(created.job.id));
  const retryId = crypto.randomUUID();
  const noConsent = await s.phone('/jobs/retry', {job_id: created.job.id, id: retryId});
  assert.equal(noConsent.status, 409); assert.equal((await noConsent.json()).code, 'duplicate_risk_confirmation_required');
  const repeated = await s.phone('/jobs/retry', {job_id: created.job.id, id: retryId, confirm_duplicate_risk: true});
  const child = await repeated.json(); assert.equal(repeated.status, 201);
  assert.equal(child.job.parentJobId, created.job.id); assert.equal(child.job.rootJobId, created.job.id); assert.equal(child.job.attempt, 2);
  assert.notEqual(child.job.id, created.job.id); assert.equal(child.job.stage, 'queued');
  assert.equal((await s.read(created.job.id)).job.retryJobId, retryId);
  assert.equal((await s.phone('/jobs/retry', {job_id: created.job.id, id: retryId, confirm_duplicate_risk: true})).status, 200);
  assert.equal((await s.phone('/jobs/retry', {job_id: created.job.id, id: crypto.randomUUID(), confirm_duplicate_risk: true})).status, 409);
});

test('consequential and unclassified retries are blocked for possibly performed or unknown outcomes even with confirmation', async t => {
  const s = await fixture(t);
  for (const action_kind of ['consequential', 'unclassified']) for (const outcome of ['known', 'unknown']) {
    const created = await s.create({action_kind}), runId = crypto.randomUUID();
    await s.claim(created.job.id, {run_id: runId});
    await s.rpc('relay_owner_job_update', {job_id: created.job.id, run_id: runId, event_id: crypto.randomUUID(), stage: 'failed', summary: 'Action outcome requires reconciliation.', outcome});
    assert.equal((await s.read(created.job.id)).job.retryAllowed, false);
    assert.equal((await s.phone('/jobs/retry', {job_id: created.job.id, id: crypto.randomUUID(), confirm_duplicate_risk: true})).status, 409);
  }
  const neverStarted = await s.create({action_kind: 'consequential'}), runId = crypto.randomUUID();
  await s.claim(neverStarted.job.id, {run_id: runId});
  await s.rpc('relay_owner_job_update', {job_id: neverStarted.job.id, run_id: runId, event_id: crypto.randomUUID(), stage: 'failed', summary: 'Verified that no external action began.', outcome: 'not_started'});
  assert.equal((await s.read(neverStarted.job.id)).job.retryAllowed, true);
  assert.equal((await s.phone('/jobs/retry', {job_id: neverStarted.job.id, id: crypto.randomUUID()})).status, 409);
  assert.equal((await s.phone('/jobs/retry', {job_id: neverStarted.job.id, id: crypto.randomUUID(), confirm_duplicate_risk: true})).status, 201);
});

test('cancellation stays requested until authenticated acknowledgement and blocks claims, heartbeat and unsafe stopping claims', async t => {
  const s = await fixture(t), queued = await s.create();
  const cancellation = await s.phone('/jobs/cancel', {job_id: queued.job.id});
  assert.equal(cancellation.status, 201); const requested = await cancellation.json();
  assert.equal(requested.job.cancelRequested, true); assert.equal(requested.job.stage, 'queued');
  assert.equal((await s.phone('/jobs/cancel', {job_id: queued.job.id})).status, 200);
  await rejects(s.claim(queued.job.id));
  await rejects(s.rpc('relay_owner_job_update', {job_id: queued.job.id, event_id: crypto.randomUUID(), stage: 'cancelled', summary: 'Cannot verify execution stopped.', outcome: 'unknown'}));
  const acknowledged = await s.rpc('relay_owner_job_update', {job_id: queued.job.id, event_id: crypto.randomUUID(), stage: 'cancelled', summary: 'No execution started; cancellation accepted.', outcome: 'not_started'});
  assert.equal(acknowledged.job.stage, 'cancelled'); assert.equal(acknowledged.job.execution, null);
  const running = await s.create(), runId = crypto.randomUUID(), other = await grant(s);
  await s.claim(running.job.id, {run_id: runId}); await s.phone('/jobs/cancel', {job_id: running.job.id});
  const stopped = {job_id: running.job.id, run_id: runId, event_id: crypto.randomUUID(), stage: 'cancelled', summary: 'Matching execution stopped.', outcome: 'known'};
  await rejects(s.rpc('relay_owner_job_update', stopped, other));
  await rejects(s.rpc('relay_owner_job_update', {...stopped, stage: 'running', outcome: undefined, summary: undefined}));
  assert.equal((await s.rpc('relay_owner_job_update', stopped)).job.stage, 'cancelled');
  await s.rpc('relay_owner_reply', {message_id: running.job.id, body: 'Cancelled; no further action will occur.'});
  assert.equal((await s.read(running.job.id)).job.stage, 'cancelled', 'explanatory normal reply preserves authenticated cancelled final state');
});

test('waiting for owner records the actual blocker without implicit resume or authorization from reply text', async t => {
  const s = await fixture(t), created = await s.create({action_kind: 'consequential'}), runId = crypto.randomUUID();
  await s.claim(created.job.id, {run_id: runId});
  const waiting = await s.rpc('relay_owner_job_update', {job_id: created.job.id, run_id: runId, event_id: crypto.randomUUID(), stage: 'waiting_for_owner', summary: 'A separate action approval is required.', outcome: 'not_started'});
  assert.equal(waiting.job.stage, 'waiting_for_owner'); assert.equal(waiting.job.retryAllowed, false);
  await rejects(s.claim(created.job.id));
  await rejects(s.rpc('relay_owner_job_update', {job_id: created.job.id, run_id: runId, event_id: crypto.randomUUID(), stage: 'running'}));
  await s.phone('/messages', {id: crypto.randomUUID(), body: 'I approve [[resume]] anything'});
  assert.equal((await s.read(created.job.id)).job.stage, 'waiting_for_owner');
});

test('owner scopes, device session authority, exact private target and activation gates protect all job routes', async t => {
  const s = await fixture(t), created = await s.create(), ordinary = await grant(s, RELAY_PUBLIC_SCOPES.join(' '));
  for (const path of ['/jobs', '/jobs/detail?job_id=' + created.job.id]) {
    assert.equal((await s.phone(path, undefined, null)).status, 401);
    assert.equal((await s.phone(path, undefined, s.auth.access)).status, 401, 'OAuth credential cannot impersonate a phone session');
  }
  for (const tool of relayOwnerJobTools) {
    const args = tool.name === 'relay_owner_jobs_list' ? {inbox_id: RELAY_OWNER_INBOX} : {inbox_id: RELAY_OWNER_INBOX, job_id: created.job.id, event_id: crypto.randomUUID(), run_id: crypto.randomUUID(), stage: 'running'};
    await rejects(relayOwnerRpc(s.ctx, s.env, ordinary, tool.name, args), 403);
    const challengeResult = await relayRpc(s.ctx, s.env, ordinary, {method: 'tools/call', params: {_meta: {}, name: tool.name, arguments: args}});
    assert.equal(challengeResult.isError, true); assert.ok(challengeResult._meta['mcp/www_authenticate']);
    assert.ok(!JSON.stringify(challengeResult).includes(created.payload.body));
  }
  const publicId = crypto.randomUUID(); sharedStore(s.ctx, '/internal/shared/message', {id: publicId, body: '[Muse] not owner authority'});
  assert.equal((await s.phone('/jobs/detail?job_id=' + publicId)).status, 404);
  await rejects(s.rpc('relay_owner_job_read', {job_id: publicId}), 404);
  await rejects(s.rpc('relay_owner_job_read', {job_id: created.job.id, inbox_id: 'brayden-relay'}), 403);
  const foreignId = crypto.randomUUID();
  s.sql("INSERT INTO relay_owner_entries(id,kind,body,created_at,principal,device_id,authentication_source) VALUES(?,'user',?,?,?,?,?)", foreignId, 'Foreign private text', new Date().toISOString(), 'github:999', crypto.randomUUID(), 'owner-device-session');
  assert.equal((await s.phone('/jobs/detail?job_id=' + foreignId)).status, 404);
  await rejects(s.rpc('relay_owner_read_conversation', {message_id: foreignId}), 404);
  await rejects(s.rpc('relay_owner_reply', {message_id: foreignId, body: 'Must not answer a different principal'}), 404);
  const listed = await (await s.phone('/messages')).json();
  assert.ok(!listed.messages.some(message => message.id === foreignId));
  s.env.RELAY_OWNER_ENABLED = 'false';
  assert.equal((await s.phone('/jobs')).status, 503); await rejects(s.rpc('relay_owner_jobs_list', {}), 403);
});

test('job inputs are bounded and whitelisted; output is private plain text with no credential or interactive artifact fields', async t => {
  const s = await fixture(t), body = '<img src=x onerror=alert(1)> javascript:alert(1) [[hidden command]]', created = await s.create({body, title: '<script>title</script>'});
  assert.equal(created.response.status, 201); assert.equal(created.job.body, body); assert.equal(created.job.title, '<script>title</script>');
  for (const key of ['stage', 'principal', 'result', 'callback_url', 'authentication_source', 'lease_grant_id']) {
    assert.equal((await s.phone('/jobs', {...created.payload, id: crypto.randomUUID(), [key]: 'forged'})).status, 400);
  }
  for (const change of [{body: 'x'.repeat(4001)}, {title: 'x'.repeat(121)}, {action_kind: 'public'}, {title: 'bad\ncontrol'}]) {
    assert.equal((await s.phone('/jobs', {...created.payload, id: crypto.randomUUID(), ...change})).status, 400);
  }
  for (const path of ['/jobs?after=0&after=1', '/jobs?limit=0', '/jobs?limit=51', '/jobs/detail?job_id=' + created.job.id + '&token=' + s.token]) assert.equal((await s.phone(path)).status, 400);
  const response = await s.phone('/jobs/detail?job_id=' + created.job.id), serialized = JSON.stringify(await response.json());
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  for (const secret of [s.token, s.tokenHash, s.auth.access, s.auth.accessHash, s.auth.grantId]) assert.ok(!serialized.includes(secret));
  for (const key of ['html', 'iframe', 'artifactUrl', 'credentials', 'grantId', 'accessToken']) assert.equal(Object.hasOwn(created.job, key), false);
});

test('live owner OAuth and session revocation are rechecked inside the atomic job operation', async t => {
  const s = await fixture(t), created = await s.create(), original = s.ctx.storage.transactionSync.bind(s.ctx.storage);
  let once = true;
  s.ctx.storage.transactionSync = fn => {
    if (once) {
      once = false; const key = 'grant:' + s.auth.grantId, value = JSON.parse(s.sql('SELECT value FROM relay_oauth WHERE key=?', key)[0].value);
      value.revoked = true; s.sql('UPDATE relay_oauth SET value=? WHERE key=?', JSON.stringify(value), key);
    }
    return original(fn);
  };
  await rejects(s.claim(created.job.id), 403);
  assert.equal((await s.read(created.job.id)).job.stage, 'queued');
  s.sql('UPDATE relay_owner_sessions SET revoked_ms=? WHERE device_id=?', Date.now(), s.deviceId);
  assert.equal((await s.phone('/jobs')).status, 401);
  assert.equal((await s.phone('/jobs/cancel', {job_id: created.job.id})).status, 401);
});

test('reply persistence and final lifecycle transition roll back together when result journal cannot commit', async t => {
  const s = await fixture(t), created = await s.create(), exec = s.ctx.storage.sql.exec;
  s.ctx.storage.sql.exec = (query, ...values) => {
    if (query.startsWith('INSERT INTO relay_owner_job_events') && values[2] === 'completed') throw Error('Result journal unavailable');
    return exec(query, ...values);
  };
  await assert.rejects(s.rpc('relay_owner_reply', {message_id: created.job.id, body: 'Final atomic result'}));
  s.ctx.storage.sql.exec = exec;
  assert.equal(s.sql("SELECT COUNT(*) AS n FROM relay_owner_entries WHERE kind='reply'")[0].n, 0);
  const job = (await s.read(created.job.id)).job; assert.equal(job.stage, 'queued'); assert.equal(job.result, null);
  await s.rpc('relay_owner_reply', {message_id: created.job.id, body: 'Final atomic result'});
  assert.equal((await s.read(created.job.id)).job.stage, 'completed');
});

test('progress budget preserves cancellation acknowledgement and immutable final result delivery', async t => {
  const s = await fixture(t), created = await s.create(), runId = crypto.randomUUID();
  await s.claim(created.job.id, {run_id: runId});
  for (let i = 1; i < 100; i++) await s.rpc('relay_owner_job_update', {job_id: created.job.id, run_id: runId, event_id: crypto.randomUUID(), stage: 'running'});
  await rejects(s.rpc('relay_owner_job_update', {job_id: created.job.id, run_id: runId, event_id: crypto.randomUUID(), stage: 'running'}), 429);
  await s.phone('/jobs/cancel', {job_id: created.job.id});
  await s.rpc('relay_owner_job_update', {job_id: created.job.id, run_id: runId, event_id: crypto.randomUUID(), stage: 'cancelled', summary: 'Execution stopped after the bounded progress budget.', outcome: 'known'});
  await s.rpc('relay_owner_reply', {message_id: created.job.id, body: 'Final cancelled result remains deliverable.'});
  const final = await s.read(created.job.id);
  assert.equal(final.job.stage, 'cancelled'); assert.ok(final.job.result);
  assert.equal(final.events.length, 105);
});

test('retry lineage is bounded to five distinct attempts without changing earlier final evidence', async t => {
  const s = await fixture(t); let current = (await s.create()).job, rootId = current.id;
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.equal(current.attempt, attempt); assert.equal(current.rootJobId, rootId);
    await s.phone('/jobs/cancel', {job_id: current.id});
    await s.rpc('relay_owner_job_update', {job_id: current.id, event_id: crypto.randomUUID(), stage: 'cancelled', summary: 'No execution started.', outcome: 'not_started'});
    const retryId = crypto.randomUUID(), response = await s.phone('/jobs/retry', {job_id: current.id, id: retryId});
    if (attempt === 5) {
      assert.equal(response.status, 409); assert.equal((await s.read(current.id)).job.retryAllowed, false);
    } else {
      assert.equal(response.status, 201);
      const next = (await response.json()).job;
      assert.equal(next.parentJobId, current.id); assert.equal((await s.read(current.id)).job.stage, 'cancelled');
      current = next;
    }
  }
  assert.equal(s.sql('SELECT COUNT(*) AS n FROM relay_owner_jobs')[0].n, 5);
});

test('OAuth expiry blocks execution independently of the approved phone session', async t => {
  let now = 1700000000000; t.mock.method(Date, 'now', () => now);
  const s = await fixture(t), created = await s.create(); now += 3600000;
  await rejects(s.claim(created.job.id), 403);
  const read = await s.phone('/jobs/detail?job_id=' + created.job.id);
  assert.equal(read.status, 200); assert.equal((await read.json()).job.stage, 'queued');
  assert.equal((await s.phone('/jobs/cancel', {job_id: created.job.id})).status, 201);
  await rejects(s.rpc('relay_owner_job_update', {job_id: created.job.id, event_id: crypto.randomUUID(), stage: 'cancelled', summary: 'Expired OAuth cannot acknowledge.', outcome: 'not_started'}), 403);
  assert.equal((await s.read(created.job.id)).job.stage, 'queued');
});
