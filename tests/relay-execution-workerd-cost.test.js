import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {RELAY_OWNER_INBOX, RELAY_INBOX, RELAY_VERSION} from '../backend/relay-common.js';
import {PRIMARY_SITE} from '../backend/origins.js';

test('actual local workerd HTTP/MCP boundaries record stable rows-read/written costs with 5000 background rows', {timeout: 30000}, async () => {
  const config = JSON.parse(readFileSync(new URL('../backend/wrangler.jsonc', import.meta.url), 'utf8'));
  const bundle = await build({entryPoints: [fileURLToPath(new URL('./helpers/relay-execution-cost-worker.js', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:crypto']});
  const sourceSha256 = createHash('sha256').update(bundle.outputFiles[0].text).digest('hex');
  let egress = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({name: 'local-relay-execution-cost', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags || [], cf: false, telemetry: {enabled: false},
    bindings: {RELAY_MCP_ENABLED: 'true', RELAY_OWNER_ENABLED: 'true', RELAY_MCP_ORIGIN: 'https://cost.execution.test'},
    durableObjects: {HUBS: {className: 'ExecutionCostHub', useSQLite: true}}, outboundService() { egress++; throw Error('Fixture disallows all external network'); }}));
  const measurements = []; let rpcId = 0;
  const request = async (path, body, token, operation = 'setup', extra = {}) => {
    const started = performance.now();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = await mf.dispatchFetch('https://cost.execution.test' + path, {method: body === undefined ? 'GET' : 'POST',
      headers: {Origin: PRIMARY_SITE, ...(payload ? {'Content-Type': 'application/json'} : {}), ...(token ? {Authorization: 'Bearer ' + token} : {}), ...extra}, body: payload});
    const text = await response.text();
    if (operation !== 'setup') measurements.push({operation, elapsedMs: Number((performance.now() - started).toFixed(3)),
      status: response.status, requestBytes: Buffer.byteLength(payload || ''), responseBytes: Buffer.byteLength(text),
      sqlStatements: Number(response.headers.get('X-Fixture-Sql-Statements')), rowsRead: Number(response.headers.get('X-Fixture-Rows-Read')),
      rowsWritten: Number(response.headers.get('X-Fixture-Rows-Written'))});
    assert.equal(response.status < 400, true, 'Fixture cost boundary must succeed');
    return JSON.parse(text);
  };
  let access;
  const rpc = async (name, args, measured = false) => {
    const response = await request('/relay/mcp', {jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: {name, arguments: args,
      _meta: {'io.modelcontextprotocol/protocolVersion': RELAY_VERSION, 'io.modelcontextprotocol/clientCapabilities': {}}}}, access,
    measured ? name : 'setup', {Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': RELAY_VERSION, 'Mcp-Method': 'tools/call', 'Mcp-Name': name});
    assert.equal(response.error, undefined); assert.equal(response.result.isError, false); return response.result.structuredContent;
  };
  try {
    ({access} = await request('/__fixture/grant')); assert.ok(access);
    const pair = await request('/relay/owner/pair/start', {label: 'Fictional local workerd phone'});
    await rpc('relay_owner_pairing_approve', {request_id: pair.request_id, code: pair.code, access_days: 365, confirm: true});
    const requestId = randomUUID();
    const created = await request('/relay/owner/jobs', {id: requestId, title: 'Fictional cost request', body: 'Read the isolated fixture.', action_kind: 'read_only'}, pair.device_token);
    assert.equal(created.job.id, requestId);
    const publicId = randomUUID(); await request('/shared/messages', {id: publicId, body: 'Fictional public cost request.'});
    const ownerArgs = {inbox_id: RELAY_OWNER_INBOX, job_id: requestId}, publicArgs = {inbox_id: RELAY_INBOX, message_id: publicId, limit: 1};
    const warm = async () => {
      await rpc('relay_owner_job_read', ownerArgs);
      await rpc('relay_read_public_result', publicArgs);
      await request('/relay/owner/jobs/detail?job_id=' + requestId, undefined, pair.device_token);
    };
    await warm();
    const sample = async () => {
      for (let repeat = 0; repeat < 3; repeat++) {
        await rpc('relay_owner_job_read', ownerArgs, true);
        await rpc('relay_read_public_result', publicArgs, true);
        await request('/relay/owner/jobs/detail?job_id=' + requestId, undefined, pair.device_token, 'phone_exact_job');
      }
    };
    await sample();
    const before = measurements.splice(0);
    await request('/__fixture/background?count=5000'); await warm(); await sample();
    const after = measurements;
    const counts = items => items.map(({elapsedMs, requestBytes, responseBytes, ...rest}) => rest);
    assert.deepEqual(counts(after), counts(before), '5000 unrelated rows cannot amplify exact-read workerd row costs');
    for (const record of after) {
      assert.ok(record.rowsRead < 200, record.operation + ' exceeds exact-read rows budget');
      assert.ok(record.rowsWritten < 20, record.operation + ' exceeds warmed-write rows budget');
    }
    assert.equal(egress, 0);
    const report = {schema: 'relay-workerd-boundary-cost-v1', scope: 'local-workerd-fixture', sourceSha256, nodeVersion: process.version,
      compatibilityDate: config.compatibility_date, backgroundRows: 5000, requestId, publicRequestId: publicId, before, after, egress};
    process.stdout.write('LOCAL_BOUNDARY_COST ' + JSON.stringify(report) + '\n');
    if (process.env.RELAY_EXECUTION_COST_DIR) {
      mkdirSync(resolve(process.env.RELAY_EXECUTION_COST_DIR), {recursive: true});
      writeFileSync(resolve(process.env.RELAY_EXECUTION_COST_DIR, 'workerd-boundary-cost.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    }
  } finally { await mf.dispose(); }
});
