import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {challenge} from '../backend/relay-common.js';
import {MAKIMA_CALLBACK as CALLBACK} from '../backend/relay-makima-policy.js';

const ORIGIN = 'https://makima.example.test', PATH = '/relay/makima';
const CANONICAL_CALLBACK = 'https://cursor.com/agents/mcp/oauth/callback';
const CLIENT = 'c'.repeat(64), VERIFIER = 'synthetic-redirect-verifier-'.repeat(3);
const executablePath = [process.env.JARVIS_CHROME, '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));

test('Makima consent allows the fixed Cursor canonical host; old CSP blocks after consuming consent', {timeout: 90000}, async t => {
  if (!executablePath) { assert.ok(!process.env.CI, 'Chromium is required in CI'); t.skip('Chromium unavailable'); return; }
  const bundle = await build({entryPoints: [fileURLToPath(new URL('../backend/worker.js', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:crypto']});
  const mf = new Miniflare(convertV4MiniflareOptions({name: 'makima-callback-browser', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-19', cf: false, telemetry: {enabled: false},
    bindings: {RELAY_MCP_ENABLED: 'true', RELAY_MAKIMA_ENABLED: 'true', RELAY_MCP_ORIGIN: ORIGIN, RELAY_MAKIMA_CLIENT_ID: CLIENT, RELAY_MAKIMA_GITHUB_CLIENT_ID: 'fixture-app', RELAY_MAKIMA_GITHUB_CLIENT_SECRET: 'fixture-secret'},
    durableObjects: {HUBS: {className: 'Hub', useSQLite: true}}, outboundService(request) {
      if (request.url === 'https://github.com/login/oauth/access_token') return Response.json({access_token: 'synthetic-token', token_type: 'bearer'});
      if (request.url === 'https://api.github.com/user') return Response.json({id: 183016859});
      throw Error('Unexpected fixture egress');
    }}));
  let browser;
  try {
    await mf.ready;
    browser = await chromium.launch({executablePath, args: ['--no-sandbox', '--disable-background-networking']});
    const authorize = ORIGIN + PATH + '/oauth/authorize?' + new URLSearchParams({response_type: 'code', client_id: CLIENT, redirect_uri: CALLBACK, resource: ORIGIN + PATH + '/mcp', scope: 'relay:makima', state: 'synthetic-state', code_challenge_method: 'S256', code_challenge: await challenge(VERIFIER)});
    for (const mode of ['deployed-csp', 'fixed-csp', 'unlisted-host']) await t.test(mode, async () => {
      const context = await browser.newContext({offline: true, serviceWorkers: 'block'});
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const cdp = await context.newCDPSession(page), pending = new Set(), errors = [], destinations = [], violations = [];
      let closing = false, consentHtml, approval;
      page.on('console', message => { if (message.type() === 'error' && message.text().includes('form-action')) violations.push(message.text()); });
      async function bridge(event) {
        const req = event.request, url = new URL(req.url);
        let status = 200, headers = {'Content-Type': 'text/html'}, body = '';
        if (url.pathname === '/favicon.ico') status = 204;
        else if (url.origin + url.pathname === CALLBACK) {
          destinations.push(CALLBACK);
          // Verified live on 2026-10-16: www canonicalizes with HTTP 308.
          status = 308; headers = {Location: (mode === 'unlisted-host' ? 'https://unlisted.invalid/agents/mcp/oauth/callback' : CANONICAL_CALLBACK) + url.search};
        } else if (url.origin + url.pathname === CANONICAL_CALLBACK) { destinations.push(CANONICAL_CALLBACK); body = '<title>Complete</title>'; }
        else if (url.origin === 'https://unlisted.invalid') throw Error('CSP allowed an unlisted redirect host');
        else if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/authorize') { status = 302; headers = {Location: ORIGIN + PATH + '/oauth/github/callback?' + new URLSearchParams({state: url.searchParams.get('state'), code: 'synthetic-code'})}; }
        else if (url.origin === ORIGIN && url.pathname === '/stale') body = consentHtml;
        else if (url.origin === ORIGIN && url.pathname.startsWith(PATH + '/oauth/')) {
          const response = await mf.dispatchFetch(req.url, {method: req.method, headers: req.headers, body: req.postData, redirect: 'manual'});
          status = response.status; headers = Object.fromEntries(response.headers); body = await response.text();
          if (status === 200 && url.pathname.endsWith('/github/callback')) {
            consentHtml = body;
            assert.ok(headers['content-security-policy'].includes(CANONICAL_CALLBACK));
            if (mode === 'deployed-csp') headers['content-security-policy'] = headers['content-security-policy'].replace(' ' + CANONICAL_CALLBACK, '');
          }
          if (url.pathname.endsWith('/approve')) approval = {status, body};
        } else throw Error('Unexpected browser fixture URL');
        await cdp.send('Fetch.fulfillRequest', {requestId: event.requestId, responseCode: status, responseHeaders: Object.entries(headers).map(([name, value]) => ({name, value})), body: Buffer.from(body).toString('base64')});
      }
      cdp.on('Fetch.requestPaused', event => {
        const operation = bridge(event).catch(async error => { if (!closing) errors.push(error); await cdp.send('Fetch.failRequest', {requestId: event.requestId, errorReason: 'Failed'}).catch(() => {}); });
        pending.add(operation); operation.finally(() => pending.delete(operation));
      });
      try {
        await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]});
        await page.goto(authorize);
        await page.locator('button[value="allow"]').click();
        if (mode === 'fixed-csp') {
          await page.waitForURL(CANONICAL_CALLBACK + '**');
          assert.deepEqual(destinations, [CALLBACK, CANONICAL_CALLBACK]);
          assert.equal(approval.status, 302); assert.deepEqual(violations, []);
          const returned = new URL(page.url());
          assert.equal(returned.searchParams.get('state'), 'synthetic-state');
          assert.equal(returned.searchParams.get('iss'), ORIGIN + PATH);
          const code = returned.searchParams.get('code');
          assert.match(code, /^[a-f0-9]{64}$/);
          const exchanged = await mf.dispatchFetch(ORIGIN + PATH + '/oauth/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', client_id: CLIENT, redirect_uri: CALLBACK, resource: ORIGIN + PATH + '/mcp', code, code_verifier: VERIFIER}).toString()});
          assert.equal(exchanged.status, 200); assert.equal((await exchanged.json()).scope, 'relay:makima');
        } else {
          await assert.doesNotReject(async () => { for (let i = 0; i < 100 && !violations.length; i++) await page.waitForTimeout(50); assert.ok(violations.length, 'Expected Chromium form-action violation'); });
          assert.equal(approval.status, 302, 'Consent was consumed and code issued before navigation failed');
          assert.deepEqual(destinations, [CALLBACK]);
          await page.goto(ORIGIN + '/stale'); await page.locator('button[value="allow"]').click();
          assert.equal(JSON.parse(await page.locator('body').innerText()).error_description, 'consent_session_expired_or_used');
        }
        assert.deepEqual(errors, []);
      } finally { await Promise.allSettled([...pending]); closing = true; await context.close(); }
    });
  } finally { await browser?.close(); await mf.dispose(); }
});


// Isolated tests-only public callback transport probe. No production behavior changes.
{
  // Tests-only, opt-in locally; CI runs the bounded public callback probe.
  // No real OAuth code/state, login, credential, grant, or token exchange is used.
  const {default: test} = await import('node:test');
  const {default: assert} = await import('node:assert/strict');
  const {createHash, webcrypto} = await import('node:crypto');
  const {existsSync} = await import('node:fs');
  const {chromium} = await import('playwright-core');
  const {relayOAuth} = await import('../backend/relay-oauth.js');
  const {challenge, hash: sha256} = await import('../backend/relay-common.js');
  const {makimaOAuthPolicy: policy} = await import('../backend/relay-makima-policy.js');
  const {MAKIMA_CONSENT_SCRIPT: guard, MAKIMA_CONSENT_SCRIPT_HASH: guardHash} = await import('../backend/relay-makima-consent.js');
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  const ORIGIN = 'https://makima.example.test', BASE = '/relay/makima/oauth';
  const WWW = 'https://www.cursor.com/agents/mcp/oauth/callback';
  const APEX = 'https://cursor.com/agents/mcp/oauth/callback';
  const CONSENT = ORIGIN + BASE + '/github/callback', APPROVE = ORIGIN + BASE + '/approve';
  const CSP = `default-src 'none'; form-action 'self' ${WWW} ${APEX}; frame-ancestors 'none'; base-uri 'none'; script-src '${guardHash}'`;
  const liveEnabled = process.env.CI === 'true' || process.env.JARVIS_LIVE_CALLBACK_PROBE === '1';
  const executablePath = [process.env.JARVIS_CHROME, process.env.CHROMIUM_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
  const sanitized = (input, base) => { try { const u = new URL(input, base); return ['https:', 'http:'].includes(u.protocol) ? u.origin + u.pathname : 'non-http'; } catch { return 'non-url'; } };
  const failureCode = text => String(text || '').match(/(?:net::)?ERR_[A-Z0-9_]+/)?.[0] || 'unspecified';
  async function bounded(promise, milliseconds = 5000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('bounded_timeout')), milliseconds); })]); }
    finally { clearTimeout(timer); }
  }
  // This allowlist is intentionally small. A dependency blocked here is reported;
  // it cannot silently become evidence that production hydration is broken.
  function networkDecision(raw, method, type) {
    let u; try { u = new URL(raw); } catch { return 'block_url'; }
    if (u.username || u.password || u.protocol !== 'https:' || /%2f|%5c/i.test(u.pathname)) return 'block_url';
    if (!['GET', 'HEAD'].includes(method)) return 'block_mutation';
    if ([WWW, APEX].includes(u.origin + u.pathname)) return u.search || u.hash ? 'block_callback_parameters' : 'allow_callback';
    if (type === 'Document') return 'block_document';
    if (u.origin === 'https://cursor.com' && u.pathname.startsWith('/_next/static/')) return 'allow_static';
    if (u.origin === 'https://cursor.com' && /^\/(?:favicon\.ico|icon\.svg)$/.test(u.pathname)) return 'allow_static';
    if (u.origin === 'https://fonts.gstatic.com' && type === 'Font') return 'allow_static';
    if (u.origin === 'https://fonts.googleapis.com' && type === 'Stylesheet') return 'allow_static';
    return 'block_dependency';
  }
  function forbiddenOAuthAttempt(raw) {
    try { const u = new URL(raw); if ([WWW, APEX].includes(u.origin + u.pathname)) return !!(u.search || u.hash); return /\/(?:login|logout|authorize|token)(?:\/|$)|\/api\/mcp\/oauth\/complete(?:\/|$)/i.test(u.pathname); } catch { return false; }
  }
  async function realRenderedConsent() {
    const operations = [], state = 'a'.repeat(64), browser = 'b'.repeat(64), verifier = 'synthetic-live-probe-verifier-'.repeat(3);
    const params = {client_id: 'c'.repeat(64), redirect_uri: WWW, response_type: 'code', code_challenge_method: 'S256', code_challenge: await challenge(verifier), resource: ORIGIN + '/relay/makima/mcp', state: 'synthetic-local-only-state', scope: 'relay:makima'};
    let savedConsent;
    const env = {RELAY_MCP_ENABLED: 'true', RELAY_MAKIMA_ENABLED: 'true', RELAY_MCP_ORIGIN: ORIGIN, RELAY_MAKIMA_CLIENT_ID: params.client_id, RELAY_MAKIMA_GITHUB_CLIENT_ID: 'synthetic-app', RELAY_MAKIMA_GITHUB_CLIENT_SECRET: 'synthetic-secret'};
    env.HUBS = {
      idFromName(name) { assert.equal(name, policy.registry); return name; },
      get() { return {async fetch(request) {
        assert.equal(new URL(request.url).origin, 'https://internal');
        const b = await request.json(); operations.push(b.op);
        if (b.op === 'consume' && b.key === 'login:' + await sha256(state)) {
          assert.deepEqual(b.match, {browser: await sha256(browser)});
          return Response.json({value: {p: params, browser: b.match.browser, verifier}});
        }
        if (b.op === 'put' && b.key.startsWith('consent:') && b.category === 'session') { savedConsent = b.value; return Response.json({ok: true}); }
        // No authorize, exchange, token, or grant operation can succeed.
        throw new Error('forbidden_fixture_operation');
      }}; },
    };
    const upstream = [];
    const fakeGithub = async input => {
      upstream.push(input);
      if (input === 'https://github.com/login/oauth/access_token') return Response.json({access_token: 'synthetic-fixture-token', token_type: 'bearer'});
      if (input === 'https://api.github.com/user') return Response.json({id: 183016859});
      throw new Error('forbidden_fixture_upstream');
    };
    const response = await relayOAuth(new Request(CONSENT + '?' + new URLSearchParams({state, code: 'synthetic-fixture-code'}), {headers: {Cookie: `${policy.loginCookie}=${browser}`}}), env, fakeGithub, policy);
    assert.equal(response.status, 200);
    const html = await response.text(), headers = Object.fromEntries(response.headers);
    assert.equal(headers['content-security-policy'], CSP);
    assert.ok(html.includes('<script>' + guard + '</script>'));
    assert.deepEqual(operations, ['consume', 'put']);
    assert.equal(upstream.length, 2);
    assert.ok(savedConsent && /^[a-f0-9]{64}$/.test(savedConsent.csrf));
    return {html, headers, csrf: savedConsent.csrf, operations};
  }
  function terminalResponse() {
    // Deliberate tests-only difference: BARE callback, never real code/state/iss.
    const raw = new Response(null, {status: 302, headers: {Location: WWW, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}});
    return new Response(raw.body, {status: raw.status, headers: {...Object.fromEntries(raw.headers), 'Access-Control-Allow-Origin': ORIGIN, Vary: 'Origin'}});
  }
  test('live callback probe renders exact production consent without authorizing a grant', async () => {
    const f = await realRenderedConsent();
    assert.deepEqual(f.operations, ['consume', 'put']);
    assert.equal(guardHash, 'sha256-' + createHash('sha256').update(guard).digest('base64'));
  });
  test('live callback probe terminal response contains no OAuth parameters or credential cookie', () => {
    const r = terminalResponse(); assert.equal(r.status, 302); assert.equal(r.headers.get('Location'), WWW); assert.equal(r.headers.has('Set-Cookie'), false); assert.equal(r.body, null);
  });
  test('live callback probe network guard blocks OAuth, login, mutations and redirected documents', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(networkDecision(APEX, method, 'Document'), 'block_mutation');
    for (const url of [WWW + '?code=x', APEX + '?state=x', APEX + '#code=x']) assert.equal(networkDecision(url, 'GET', 'Document'), 'block_callback_parameters');
    for (const url of ['https://cursor.com/api/mcp/oauth/complete', 'https://cursor.com/api/auth/login', 'https://cursor.com/api/auth/logout', 'https://github.com/login/oauth/authorize', 'https://jarvis-hub-api.braydenparker999.workers.dev/relay/makima/oauth/token']) assert.match(networkDecision(url, 'GET', 'Document'), /^block_/);
    for (const url of [WWW, APEX]) assert.equal(networkDecision(url, 'GET', 'Document'), 'allow_callback');
    assert.equal(networkDecision('https://cursor.com/_next/static/chunks/test.js', 'GET', 'Script'), 'allow_static');
    assert.match(networkDecision('https://cursor.com:8443/_next/static/test.js', 'GET', 'Script'), /^block_/);
    assert.equal(networkDecision('https://cursor.com/_next/static/x%2f..%2fapi/auth/login', 'GET', 'Script'), 'block_url');
    assert.equal(forbiddenOAuthAttempt('https://cursor.com/api/mcp/oauth/complete'), true);
    assert.equal(forbiddenOAuthAttempt(APEX), false);
  });
  test('live callback probe logs only redacted URL and fixed failure classifications', () => {
    assert.equal(sanitized(APEX + '?code=never-log&state=never-log#fragment'), APEX);
    assert.equal(sanitized('data:text/plain,never-log'), 'non-http');
    assert.equal(failureCode('net::ERR_ABORTED at https://example.test/?code=never-log'), 'net::ERR_ABORTED');
  });
  test('live bare Cursor callback: native consent redirect, desktop and mobile-emulated Chromium (not Android Custom Tabs)', {skip: !liveEnabled, timeout: 400000}, async t => {
    assert.ok(executablePath, 'Qualified Chromium is required for the explicitly enabled live probe');
    let browser;
    try {
      browser = await chromium.launch({executablePath, timeout: 15000, args: ['--no-sandbox', '--disable-background-networking']});
      for (const profile of ['desktop', 'mobile-emulated']) for (const mode of ['direct-apex', 'direct-www', 'native-form', 'ordinary-link']) await t.test(profile + '/' + mode, {timeout: 60000}, async () => {
        const f = await realRenderedConsent(), observations = [], pending = new Set();
        const started = Date.now(); let closing = false, approvalCount = 0, bridgeFailure = false, forbiddenAttempt = false, safetyGuardUsed = false;
        const stage = (promise, limit = 5000) => bounded(promise, Math.max(1, Math.min(limit, 30000 - (Date.now() - started))));
        const record = event => { if (observations.length < 250) observations.push({ms: Date.now() - started, ...event}); };
        const context = await stage(browser.newContext({serviceWorkers: 'block', ...(profile === 'mobile-emulated' ? {viewport: {width: 412, height: 915}, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36'} : {})}));
        try {
        // No storageState, login cookies, or persisted owner profile are loaded.
        await stage(context.routeWebSocket('**', socket => { record({kind: 'blocked_websocket'}); socket.close(); }));
        const page = await stage(context.newPage()); page.setDefaultTimeout(15000);
        page.on('popup', popup => { safetyGuardUsed = true; record({kind: 'blocked_popup'}); void popup.close(); });
        const cdp = await stage(context.newCDPSession(page));
        const send = (method, params) => bounded(cdp.send(method, params));
        await stage(page.exposeBinding('__makimaProbeCsp', (_source, value) => {
          const directive = typeof value?.directive === 'string' && /^[a-z-]{1,64}$/.test(value.directive) ? value.directive : 'unknown';
          record({kind: 'csp', directive, originPath: sanitized(value?.blocked)});
        }));
        await stage(page.exposeBinding('__makimaProbeSafety', () => { safetyGuardUsed = true; record({kind: 'safety_guard_used'}); }));
        await stage(page.addInitScript(() => {
          // Safety-only guards prevent unguarded popup/worker network targets.
          // Any use makes the probe inconclusive, never a successful result.
          const blocked = () => { void window.__makimaProbeSafety(); return null; };
          Object.defineProperty(window, 'open', {value: blocked, configurable: false, writable: false});
          for (const key of ['Worker', 'SharedWorker']) if (key in window) Object.defineProperty(window, key, {value: function () { blocked(); throw new Error('probe_blocked_worker'); }, configurable: false, writable: false});
          document.addEventListener('securitypolicyviolation', event => {
            // Observer only; production HTML, CSP and guard remain unchanged.
            void window.__makimaProbeCsp({directive: event.effectiveDirective, blocked: (() => { try { const u = new URL(event.blockedURI); return u.origin + u.pathname; } catch { return 'non-url'; } })()});
          });
        }));
        page.on('console', message => { if (message.type() === 'error' && message.text().includes('form-action')) record({kind: 'csp_console', directive: 'form-action'}); });
        page.on('requestfailed', request => record({kind: 'request_failed', originPath: sanitized(request.url()), reason: failureCode(request.failure()?.errorText)}));
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) record({kind: 'document_commit', originPath: sanitized(frame.url())}); });
        page.on('response', response => {
          if (response.request().isNavigationRequest()) record({kind: 'response', originPath: sanitized(response.url()), status: response.status(), ...(response.headers().location ? {location: sanitized(response.headers().location, response.url())} : {})});
        });
        async function bridge(event) {
          const req = event.request, target = sanitized(req.url), u = new URL(req.url);
          if (target === CONSENT && req.method === 'GET' && !u.search && !u.hash) return send('Fetch.fulfillRequest', {requestId: event.requestId, responseCode: 200, responseHeaders: Object.entries(f.headers).map(([name, value]) => ({name, value})), body: Buffer.from(f.html).toString('base64')});
          if (target === ORIGIN + '/probe-link' && req.method === 'GET' && !u.search && !u.hash) return send('Fetch.fulfillRequest', {requestId: event.requestId, responseCode: 200, responseHeaders: [{name: 'Content-Type', value: 'text/html'}, {name: 'Referrer-Policy', value: 'no-referrer'}, {name: 'Content-Security-Policy', value: "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}], body: Buffer.from(`<a href="${WWW}">Continue to public callback</a>`).toString('base64')});
          if (target === APPROVE && req.method === 'POST') {
            assert.equal(mode, 'native-form'); assert.equal(u.search, ''); assert.equal(u.hash, ''); assert.equal(++approvalCount, 1);
            const submitted = new URLSearchParams(req.postData || '');
            assert.equal(submitted.get('csrf'), f.csrf); assert.equal(submitted.get('decision'), 'allow'); assert.equal(submitted.get('refresh_days'), '365');
            const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
            assert.equal(headers.origin, ORIGIN); assert.match(headers['content-type'], /^application\/x-www-form-urlencoded/);
            record({kind: 'synthetic_approval', count: approvalCount});
            const response = terminalResponse();
            return send('Fetch.fulfillRequest', {requestId: event.requestId, responseCode: response.status, responseHeaders: Object.entries(Object.fromEntries(response.headers)).map(([name, value]) => ({name, value})), body: ''});
          }
          const decision = networkDecision(req.url, req.method, event.resourceType);
          if (forbiddenOAuthAttempt(req.url)) { forbiddenAttempt = true; record({kind: 'forbidden_oauth_attempt', originPath: target}); }
          if (!decision.startsWith('allow_')) {
            record({kind: 'blocked_request', decision, originPath: target, method: req.method, resourceType: event.resourceType});
            return send('Fetch.failRequest', {requestId: event.requestId, errorReason: 'BlockedByClient'});
          }
          if (event.resourceType === 'Document') record({kind: 'navigation_request', originPath: target});
          return send('Fetch.continueRequest', {requestId: event.requestId});
        }
        cdp.on('Fetch.requestPaused', event => {
          const task = bridge(event).catch(async () => { if (!closing) { bridgeFailure = true; record({kind: 'bridge_failure'}); } await send('Fetch.failRequest', {requestId: event.requestId, errorReason: 'Failed'}).catch(() => {}); });
          pending.add(task); task.finally(() => pending.delete(task));
        });
        let outcome = 'not_started', finalLabel = 'unobserved';
        try {
          // Request-stage pauses inspect EVERY redirect hop before network egress.
          await send('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]});
          if (mode === 'native-form') {
            await stage(page.goto(CONSENT, {waitUntil: 'domcontentloaded'}), 15000);
            await stage(page.locator('input[name="refresh_days"][value="365"]').check());
            const box = await stage(page.locator('button[value="allow"]').boundingBox()); assert.ok(box);
            if (profile === 'mobile-emulated') await stage(page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2));
            else await stage(page.mouse.click(box.x + box.width / 2, box.y + box.height / 2));
          } else if (mode === 'ordinary-link') {
            await stage(page.goto(ORIGIN + '/probe-link', {waitUntil: 'domcontentloaded'}), 15000);
            const box = await stage(page.locator('a').boundingBox()); assert.ok(box);
            await stage(page.mouse.click(box.x + box.width / 2, box.y + box.height / 2));
          } else await stage(page.goto(mode === 'direct-apex' ? APEX : WWW, {waitUntil: 'commit'}), 15000);
          await stage(page.waitForFunction(() => document.body?.innerText.includes('Missing required parameters (code and state)'), undefined, {timeout: 20000}), 20000);
          outcome = 'hydrated_missing_parameters';
          assert.equal(sanitized(page.url()), APEX);
          assert.equal(new URL(page.url()).search, '');
          assert.equal(approvalCount, mode === 'native-form' ? 1 : 0);
          assert.equal(bridgeFailure, false);
          assert.equal(forbiddenAttempt, false, 'No OAuth completion/login/token request may be attempted');
          assert.equal(safetyGuardUsed, false, 'Popup/worker safety guard makes this probe inconclusive');
          assert.ok(observations.some(e => e.kind === 'response' && e.originPath === APEX && e.status === 200));
          if (mode !== 'direct-apex') assert.ok(observations.some(e => e.kind === 'response' && e.originPath === WWW && e.status === 308));
          assert.equal(observations.some(e => e.kind === 'csp' && e.directive === 'form-action'), false);
        } catch (error) {
          outcome = error?.message === 'bounded_timeout' || error?.name === 'TimeoutError' ? 'timeout_inconclusive' : 'failed_inconclusive';
          // Do not print Playwright exceptions: they may embed complete URLs.
          assert.fail('Public callback probe did not reach the expected hydrated error; inspect the sanitized diagnostic only.');
        } finally {
          finalLabel = await bounded(page.evaluate(() => { const text = document.body?.innerText || ''; if (text.includes('Missing required parameters (code and state)')) return 'cursor_missing_parameters'; if (text.includes('Sending your decision.')) return 'jarvis_sending'; if (text.includes('Processing authorization...')) return 'cursor_processing'; if (text.includes('Saving authorization...')) return 'cursor_saving'; return 'other'; }), 1000).catch(() => 'unavailable');
          t.diagnostic(JSON.stringify({profile, mode, chromium: browser.version(), outcome, finalLabel, approvalCount, forbiddenAttempt, safetyGuardUsed, observations, limit: 'Mobile emulation is not Android Chrome Custom Tabs; bare callback does not test real OAuth.'}));
          closing = true;
          await bounded(context.close(), 7000).catch(() => {});
          await bounded(Promise.allSettled([...pending]), 7000).catch(() => {});
        }
        } finally { if (!closing) { closing = true; await bounded(context.close(), 7000).catch(() => {}); } }
      });
    } finally { await bounded(Promise.resolve().then(() => browser?.close()), 10000).catch(() => {}); }
  });
}
