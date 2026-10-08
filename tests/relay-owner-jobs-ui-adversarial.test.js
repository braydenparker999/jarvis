import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationFixture, deferred, SITE, WORKER, OWNER_KEY} from './helpers/relay-conversation-browser-fixture.js';
import {createRelayOwnerApi} from '../public/assets/relay-owner-api.js';
import {createRelayOwnerController} from '../public/assets/relay-owner-ui.js';
import {RELAY_OWNER_INBOX} from '../backend/relay-common.js';

async function client(t, intercept = async (_request, response) => response) {
  const h = createConversationFixture(t); t.after(() => h.close());
  const owner = await h.oauth(), phone = await h.pair(owner), calls = [];
  const values = new Map([[OWNER_KEY, JSON.stringify({device_token: phone.device_token, device_id: phone.device.id})]]);
  const api = createRelayOwnerApi({origin: WORKER, storage: {getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key)},
    fetcher: async (url, options) => {
      const request = {url, options, path: new URL(url).pathname}; calls.push(request);
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
      assert.equal(new URL(url).search.includes(phone.device_token), false);
      const response = await h.fixture.request(new URL(url).pathname + new URL(url).search, {...options, headers: {...options.headers, Origin: SITE}});
      return intercept(request, response);
    }});
  return {h, owner, phone, api, calls, values};
}
async function job(f, options = {}) {
  const id = options.id || crypto.randomUUID();
  const response = await f.h.phone('/jobs', {id, title: options.title || 'Synthetic client request', body: options.body || 'Synthetic private client text', action_kind: options.actionKind || 'read_only'}, f.phone.device_token);
  assert.equal(response.status, 201); return (await response.json()).job;
}

test('private job client rejects forged provenance and executable result formats while dropping unexpected nested secrets', async t => {
  let mutation = value => value;
  const f = await client(t, async (request, response) => request.path.endsWith('/jobs/detail') ? Response.json(mutation(await response.json())) : response);
  const saved = await job(f);
  for (const mutate of [
    value => ({...value, job: {...value.job, visibility: 'public'}}),
    value => ({...value, job: {...value.job, author_authenticated: false}}),
    value => ({...value, job: {...value.job, principal: 'github:999'}}),
    value => ({...value, job: {...value.job, messageId: crypto.randomUUID()}}),
    value => ({...value, job: {...value.job, stage: 'running', execution: null}}),
    value => ({...value, job: {...value.job, stage: 'completed', result: null}}),
    value => ({...value, job: {...value.job, result: {format: 'html', body: '<script>unsafe</script>', replyId: crypto.randomUUID(), createdAt: new Date().toISOString()}}}),
    value => ({...value, events: value.events.map(event => ({...event, jobId: crypto.randomUUID()}))}),
  ]) {
    mutation = mutate;
    await assert.rejects(() => f.api.jobDetail(saved.id), error => error.kind === 'invalid');
    assert.equal(f.api.hasCredential, true, 'Malformed lifecycle evidence cannot masquerade as logout');
  }
  const secret = 'SYNTHETIC-EXTRA-SECRET-2354';
  mutation = value => ({...value, credential: secret, job: {...value.job, html: secret, device_token: secret,
    execution: {runId: crypto.randomUUID(), acknowledgedAt: value.job.createdAt, leaseExpiresAt: value.job.createdAt, secret},
    result: {format: 'plain_text', body: 'Fictional saved result', replyId: crypto.randomUUID(), createdAt: value.job.createdAt, secret},
    failure: {code: 'synthetic', message: 'Fictional failure summary', outcome: 'not_started', secret},
    delivery: {...value.job.delivery, callback_url: secret}}, events: value.events.map(event => ({...event, secret}))});
  const projected = await f.api.jobDetail(saved.id);
  assert.equal(JSON.stringify(projected).includes(secret), false, 'Unexpected nested credentials/transport/HTML fields stay outside controller data');
  assert.equal(projected.job.result.body, 'Fictional saved result');
});

test('a stale private inspector response after real server expiry cannot revive jobs, results or drafts', async t => {
  const entered = deferred(), release = deferred(); let hold = false;
  const f = await client(t, async (request, response) => {
    if (hold && request.path.endsWith('/jobs/detail')) { entered.resolve(); await release.promise; }
    return response;
  });
  t.after(() => release.resolve());
  const saved = await job(f, {body: 'PRIVATE-STALE-INSPECTOR-1463'}), c = createRelayOwnerController({api: f.api});
  await c.refresh(); c.setDraft('PRIVATE-STALE-INSPECTOR-DRAFT-3546'); c.setJobTitle('PRIVATE-STALE-TITLE-1114');
  hold = true; const pending = c.inspectJob(saved.id); await entered.promise;
  f.h.ctx.storage.sql.exec('UPDATE relay_owner_sessions SET expires_ms=? WHERE device_id=?', Date.now() - 1, f.phone.device.id);
  await c.refresh();
  assert.equal(c.status, 'expired'); assert.equal(f.values.has(OWNER_KEY), false);
  release.resolve(); await pending;
  const state = c.snapshot();
  assert.deepEqual(state.messages, []); assert.deepEqual(state.jobs, []); assert.equal(state.jobDetail, null);
  assert.equal(state.jobDetailId, null); assert.equal(state.draft, ''); assert.equal(state.jobTitle, '');
  assert.equal(f.calls.some(call => ['/shared/messages', '/v1/messages'].includes(call.path)), false);
});

test('uncertain request receipt preserves its original UUID and mutable lifecycle refreshes independently of message history', async t => {
  let lose = true;
  const f = await client(t, async (request, response) => {
    if (lose && request.path.endsWith('/jobs') && request.options.method === 'POST') { lose = false; assert.equal(response.status, 201); return Response.json({ok: true}); }
    return response;
  });
  const id = crypto.randomUUID(), c = createRelayOwnerController({api: f.api, uuid: () => id});
  await c.refresh(); c.setJobMode(true); c.setJobTitle('Fictional request title'); c.setJobKind('draft'); c.setDraft('PRIVATE-UNCERTAIN-JOB-BODY-6874');
  await c.send();
  const unconfirmed = c.snapshot(); assert.equal(unconfirmed.sendUnconfirmed, true);
  assert.equal(unconfirmed.draft, 'PRIVATE-UNCERTAIN-JOB-BODY-6874'); assert.equal(unconfirmed.jobTitle, 'Fictional request title'); assert.equal(unconfirmed.jobMode, true);
  await c.send();
  const requests = f.calls.filter(call => call.path.endsWith('/jobs') && call.options.method === 'POST').map(call => JSON.parse(call.options.body));
  assert.equal(requests.length, 2); assert.equal(requests[0].id, requests[1].id);
  assert.equal(f.h.rows('SELECT COUNT(*) AS n FROM relay_owner_entries WHERE id=?', id)[0].n, 1);
  assert.equal(c.snapshot().draft, ''); assert.equal(c.snapshot().jobs[0].stage, 'queued', 'Successful storage does not imply assistant execution');
  await f.h.rpc(f.owner, 'relay_owner_job_claim', {inbox_id: RELAY_OWNER_INBOX, job_id: id, run_id: crypto.randomUUID(), event_id: crypto.randomUUID()});
  await c.refresh(); assert.equal(c.snapshot().jobs[0].stage, 'running', 'Mutable progress remains visible after the message cursor advances');
  await f.h.rpc(f.owner, 'relay_owner_reply', {inbox_id: RELAY_OWNER_INBOX, message_id: id, body: 'Fictional immutable final answer'});
  await c.refresh();
  assert.equal(c.snapshot().jobs[0].stage, 'completed'); assert.equal(c.snapshot().jobs[0].result.body, 'Fictional immutable final answer');
  assert.equal(JSON.stringify([...f.values.values()]).includes('PRIVATE-UNCERTAIN-JOB-BODY-6874'), false);
});
