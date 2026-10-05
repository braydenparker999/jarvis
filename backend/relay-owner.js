// Private owner devices and messages. Never persist, log, or return a device
// credential through MCP; the display code is deliberately not a credential.
import {RELAY_OWNER, RELAY_OWNER_SCOPE, RELAY_OWNER_INBOX, RELAY_OAUTH_OBJECT, RelayError, fields, uuid, cursor, random, hash, equal, boundedText, json, relayEnabled, relayIssuer} from './relay-common.js';
import {relayTokenActiveInStore} from './relay-oauth.js';
import {FRONTEND_ORIGINS} from './origins.js';

export {RELAY_OWNER_SCOPE, RELAY_OWNER_INBOX};
export const RELAY_OWNER_SESSION_MS = 365 * 86400000;
const PAIR_MS = 10 * 60000, MAX_DEVICES = 10;
const hex = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const rows = (ctx, q, ...v) => [...ctx.storage.sql.exec(q, ...v)];
const iso = ms => new Date(ms).toISOString();
const fail = (status, message, code) => { throw new RelayError(status === 401 || status === 403 ? -32012 : status === 429 ? -32013 : -32602, message, {status, ...(code ? {code} : {})}); };
export const relayOwnerEnabled = env => relayEnabled(env) && env?.RELAY_OWNER_ENABLED === 'true';

export function relayOwnerSchema(ctx) {
  const sql = ctx.storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS relay_owner_pairings (
    request_id TEXT PRIMARY KEY, code TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created_ms INTEGER NOT NULL,
    expires_ms INTEGER NOT NULL, approved_ms INTEGER, approval_grant_id TEXT)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS relay_owner_sessions (
    device_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, principal TEXT NOT NULL,
    label TEXT NOT NULL, created_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL,
    expires_ms INTEGER NOT NULL, revoked_ms INTEGER, approval_grant_id TEXT NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS relay_owner_session_expiry ON relay_owner_sessions(expires_ms)');
  sql.exec(`CREATE TABLE IF NOT EXISTS relay_owner_entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('user','reply')), reply_to TEXT UNIQUE,
    body TEXT NOT NULL, created_at TEXT NOT NULL, principal TEXT NOT NULL,
    device_id TEXT NOT NULL, authentication_source TEXT NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS relay_owner_entry_kind_seq ON relay_owner_entries(kind,seq)');
  sql.exec('CREATE TABLE IF NOT EXISTS relay_owner_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS relay_owner_pair_rates (identity TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_ms INTEGER NOT NULL)');
}
function entry(row) {
  return {id: row.id, sequence: row.seq, body: row.body, role: row.kind === 'user' ? 'user' : 'assistant', createdAt: row.created_at,
    author_authenticated: true, principal: row.principal, device_id: row.device_id,
    authentication_source: row.authentication_source, visibility: 'private',
    ...(row.kind === 'reply' ? {kind: 'reply', replyTo: row.reply_to} : {})};
}
// Synchronous internal-only lookup for the private event outbox. Never route
// this helper through a public/shared API or use it without event grant checks.
export function relayOwnerMessage(ctx, id) {
  relayOwnerSchema(ctx);
  const row = rows(ctx, "SELECT * FROM relay_owner_entries WHERE id=? AND kind='user'", id)[0];
  return row ? entry(row) : null;
}
function device(row, current) {
  return {id: row.device_id, label: row.label, label_verified: false, principal: RELAY_OWNER, createdAt: iso(row.created_ms),
    lastSeenAt: iso(row.last_seen_ms), expiresAt: iso(row.expires_ms),
    revokedAt: row.revoked_ms === null ? null : iso(row.revoked_ms),
    ...(current ? {current: row.device_id === current} : {})};
}
function shortDevice(row) {
  return {id: row.device_id, label: row.label, label_verified: false, expiresAt: iso(row.expires_ms), principal: RELAY_OWNER};
}
function requireSession(ctx, tokenHash, now) {
  if (!hex(tokenHash)) fail(401, 'Owner device authentication required');
  const row = rows(ctx, 'SELECT * FROM relay_owner_sessions WHERE token_hash=?', tokenHash)[0];
  if (!row || row.principal !== RELAY_OWNER) fail(401, 'Owner device authentication required');
  if (row.revoked_ms !== null) fail(401, 'Owner device session revoked', 'session_revoked');
  if (row.expires_ms <= now) fail(401, 'Owner device session expired', 'session_expired');
  return row;
}
function requireOwner(ctx, env, principal) {
  if (!relayOwnerEnabled(env) || principal?.principal !== RELAY_OWNER || !Array.isArray(principal.scopes)
    || !principal.scopes.includes(RELAY_OWNER_SCOPE) || !relayTokenActiveInStore(ctx, env, principal, RELAY_OWNER_SCOPE)) fail(403, 'Active owner OAuth scope required');
}
function renew(ctx, session, now) {
  ctx.storage.sql.exec('UPDATE relay_owner_sessions SET last_seen_ms=?,expires_ms=? WHERE device_id=? AND revoked_ms IS NULL AND expires_ms>?', now, now + RELAY_OWNER_SESSION_MS, session.device_id, now);
  return {...session, last_seen_ms: now, expires_ms: now + RELAY_OWNER_SESSION_MS};
}
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, 'Invalid device label');
  return value.trim();
}
function pageArgs(after, limit) {
  cursor(after);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) fail(400, 'Invalid page size');
  return {after: cursor(after) || 0, limit: limit || 50};
}
function text(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) fail(400, 'Invalid message body');
  return value.trim();
}
function listMessages(ctx, after, limit, pending = false) {
  const p = pageArgs(after, limit);
  const selected = rows(ctx, `SELECT u.* FROM relay_owner_entries u WHERE u.seq>? ${pending ? "AND u.kind='user' AND NOT EXISTS(SELECT 1 FROM relay_owner_entries r WHERE r.reply_to=u.id)" : ''} ORDER BY u.seq LIMIT ?`, p.after, p.limit + 1);
  return {messages: selected.slice(0, p.limit).map(entry), nextCursor: selected.length > p.limit ? String(selected[p.limit - 1].seq) : null};
}
function conversation(ctx, messageId) {
  if (!uuid(messageId)) fail(400, 'Invalid message ID');
  const message = rows(ctx, "SELECT * FROM relay_owner_entries WHERE id=? AND kind='user'", messageId)[0];
  if (!message) fail(404, 'Original private message not found');
  const reply = rows(ctx, "SELECT * FROM relay_owner_entries WHERE reply_to=? AND kind='reply'", messageId)[0];
  const context = rows(ctx, 'SELECT * FROM relay_owner_entries WHERE seq<? ORDER BY seq DESC LIMIT 25', message.seq).reverse().map(entry);
  return {message: entry(message), reply: reply ? entry(reply) : null, context};
}
function insertMessage(ctx, session, body, enqueue, now) {
  if (!uuid(body.id)) fail(400, 'Invalid message ID');
  const content = text(body.body, 4000);
  const previous = rows(ctx, 'SELECT * FROM relay_owner_entries WHERE id=?', body.id)[0];
  if (previous) {
    if (previous.kind !== 'user' || previous.body !== content || previous.device_id !== session.device_id) fail(409, 'Private message ID conflict');
    return {entry: entry(previous), newWrite: false};
  }
  const today = iso(now).slice(0, 10), key = 'messages:' + today;
  const count = Number(rows(ctx, 'SELECT value FROM relay_owner_meta WHERE key=?', key)[0]?.value || 0);
  if (count >= 200) fail(429, 'Private daily message limit reached');
  ctx.storage.sql.exec("DELETE FROM relay_owner_meta WHERE key LIKE 'messages:%' AND key<>?", key);
  ctx.storage.sql.exec('INSERT OR REPLACE INTO relay_owner_meta VALUES(?,?)', key, String(count + 1));
  ctx.storage.sql.exec("INSERT INTO relay_owner_entries(id,kind,body,created_at,principal,device_id,authentication_source) VALUES(?,'user',?,?,?,?,?)", body.id, content, iso(now), RELAY_OWNER, session.device_id, 'owner-device-session');
  const value = entry(rows(ctx, 'SELECT * FROM relay_owner_entries WHERE id=?', body.id)[0]);
  // This seam must enqueue synchronously in this very transaction. An event
  // failure rolls the message and rate accounting back rather than losing it.
  if (enqueue(ctx, value)?.then) throw Error('Owner message enqueue must be synchronous');
  return {entry: value, newWrite: true};
}
function revokeDevice(ctx, id, now) {
  if (!uuid(id)) fail(400, 'Invalid device ID');
  const target = rows(ctx, 'SELECT device_id FROM relay_owner_sessions WHERE device_id=? AND principal=?', id, RELAY_OWNER)[0];
  if (!target) fail(404, 'Owner device not found');
  ctx.storage.sql.exec('UPDATE relay_owner_sessions SET revoked_ms=COALESCE(revoked_ms,?) WHERE device_id=? AND principal=?', now, id, RELAY_OWNER);
  return {revoked: true, device_id: id};
}

// Only the existing Durable Object can invoke this dispatch. Public inputs are
// strictly whitelisted and bearer hashes are made by relayOwnerPublic, not JS
// supplied identity fields. All session checks and writes are synchronous.
export async function relayOwnerStore(ctx, env, body, enqueueOwnerMessage = () => {}) {
  if (!relayOwnerEnabled(env)) return json({error: 'Owner Relay is not activated', code: 'owner_not_enabled'}, 503);
  relayOwnerSchema(ctx);
  try {
    if (body?.op === 'pair_start') {
      fields(body, ['op', 'label', 'rate_hash'], ['op', 'label', 'rate_hash']);
      const name = label(body.label);
      if (!hex(body.rate_hash)) fail(400, 'Invalid pairing rate identity');
      const requestId = random(), token = random(), tokenHash = await hash(token), deviceId = crypto.randomUUID();
      const display = random().slice(0, 8).toUpperCase(), code = display.slice(0, 4) + '-' + display.slice(4);
      return ctx.storage.transactionSync(() => {
        const now = Date.now(), sql = ctx.storage.sql;
        sql.exec('DELETE FROM relay_owner_pairings WHERE expires_ms<=?', now - 86400000);
        sql.exec('DELETE FROM relay_owner_pair_rates WHERE expires_ms<=?', now);
        const rate = rows(ctx, 'SELECT * FROM relay_owner_pair_rates WHERE identity=?', body.rate_hash)[0];
        if ((rate?.count || 0) >= 10 || !rate && rows(ctx, 'SELECT COUNT(*) AS n FROM relay_owner_pair_rates')[0].n >= 500) fail(429, 'Pairing rate limit reached');
        if (rows(ctx, 'SELECT COUNT(*) AS n FROM relay_owner_pairings WHERE expires_ms>? AND approved_ms IS NULL', now)[0].n >= 100) fail(429, 'Pairing capacity reached');
        sql.exec('INSERT OR REPLACE INTO relay_owner_pair_rates VALUES(?,?,?)', body.rate_hash, (rate?.count || 0) + 1, rate?.expires_ms || now + PAIR_MS);
        sql.exec('INSERT INTO relay_owner_pairings(request_id,code,token_hash,device_id,label,created_ms,expires_ms) VALUES(?,?,?,?,?,?,?)', requestId, code, tokenHash, deviceId, name, now, now + PAIR_MS);
        return json({request_id: requestId, code, device_token: token, expires_at: iso(now + PAIR_MS)}, 201);
      });
    }
    const allowed = {
      pair_status: ['request_id'], session: [], messages_list: ['after', 'limit'], message: ['id', 'body'],
      conversation: ['message_id'], devices_list: [], device_revoke: ['device_id'],
    };
    if (!body || !Object.hasOwn(allowed, body.op)) fail(400, 'Invalid owner operation');
    fields(body, ['op', 'token_hash', ...allowed[body.op]], ['op', 'token_hash', ...(['pair_status', 'message', 'conversation', 'device_revoke'].includes(body.op) ? allowed[body.op] : [])]);
    if (!hex(body.token_hash)) fail(401, 'Owner device authentication required');
    return ctx.storage.transactionSync(() => {
      const now = Date.now();
      if (body.op === 'pair_status') {
        if (!hex(body.request_id)) fail(400, 'Invalid pairing request ID');
        const pairing = rows(ctx, 'SELECT * FROM relay_owner_pairings WHERE request_id=?', body.request_id)[0];
        if (!pairing) return json({status: 'expired'});
        if (!equal(pairing.token_hash, body.token_hash)) fail(401, 'Pairing verifier required');
        if (pairing.approved_ms === null) return json({status: pairing.expires_ms <= now ? 'expired' : 'pending'});
        const session = rows(ctx, 'SELECT * FROM relay_owner_sessions WHERE device_id=? AND token_hash=?', pairing.device_id, body.token_hash)[0];
        if (!session || session.revoked_ms !== null) return json({status: 'revoked'});
        if (session.expires_ms <= now) return json({status: 'expired'});
        const active = requireSession(ctx, body.token_hash, now);
        return json({status: 'approved', device: shortDevice(renew(ctx, active, now))});
      }
      const session = requireSession(ctx, body.token_hash, now);
      let result;
      if (body.op === 'session') result = {status: 'approved', device: shortDevice({...session, expires_ms: now + RELAY_OWNER_SESSION_MS})};
      if (body.op === 'messages_list') result = listMessages(ctx, body.after, body.limit);
      if (body.op === 'conversation') result = conversation(ctx, body.message_id);
      if (body.op === 'message') result = insertMessage(ctx, session, body, enqueueOwnerMessage, now);
      if (body.op === 'devices_list') result = {devices: rows(ctx, 'SELECT * FROM relay_owner_sessions WHERE principal=? ORDER BY created_ms,device_id', RELAY_OWNER).map(row => device(row.device_id === session.device_id ? {...row, last_seen_ms: now, expires_ms: now + RELAY_OWNER_SESSION_MS} : row, session.device_id))};
      if (body.op === 'device_revoke') result = revokeDevice(ctx, body.device_id, now);
      // Nothing asynchronous, including hashing, may occur between this check
      // and the transaction's writes/revocation. Failed routes do not renew.
      if (body.op !== 'device_revoke' || body.device_id !== session.device_id) renew(ctx, session, now);
      return json(result, result.newWrite ? 201 : 200);
    });
  } catch (error) {
    if (error instanceof RelayError) return json({error: error.message, ...(error.data?.code ? {code: error.data.code} : {})}, error.data?.status || 400);
    throw error;
  }
}

// MCP never returns a token or its hash. relay:read/reply/events or a claimed
// owner identity are insufficient; the live OAuth token and grant must both
// hold the new explicitly-consented relay:owner capability.
export async function relayOwnerRpc(ctx, env, principal, name, args, enqueueOwnerMessage = () => {}) {
  relayOwnerSchema(ctx);
  requireOwner(ctx, env, principal);
  const pairing = ['relay_owner_pairing_inspect', 'relay_owner_pairing_approve'].includes(name);
  const controls = ['relay_owner_devices_list', 'relay_owner_device_revoke'].includes(name);
  if (pairing) {
    const approving = name.endsWith('_approve');
    fields(args, approving ? ['request_id', 'code', 'access_days', 'confirm'] : ['request_id', 'code'], approving ? ['request_id', 'code', 'access_days', 'confirm'] : []);
    if (approving || Object.hasOwn(args, 'request_id')) {
      if (!hex(args.request_id)) fail(400, 'Invalid pairing request ID');
    }
    if (!approving && (Object.hasOwn(args, 'request_id') === Object.hasOwn(args, 'code') || args.code !== undefined && (typeof args.code !== 'string' || !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(args.code)))) fail(400, 'Inspect requires exactly one pairing request ID or display code');
    if (name.endsWith('_approve') && (typeof args.code !== 'string' || !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(args.code) || args.access_days !== 365 || args.confirm !== true)) fail(400, 'Approval requires matching code and explicit 365-day device access confirmation');
  } else if (controls) {
    fields(args, name === 'relay_owner_device_revoke' ? ['device_id'] : [], name === 'relay_owner_device_revoke' ? ['device_id'] : []);
  } else {
    const allowed = {relay_owner_list_pending: ['inbox_id', 'cursor', 'limit'], relay_owner_read_conversation: ['inbox_id', 'message_id'], relay_owner_reply: ['inbox_id', 'message_id', 'body']};
    if (!Object.hasOwn(allowed, name)) fail(400, 'Unknown owner tool');
    fields(args, allowed[name], name === 'relay_owner_list_pending' ? ['inbox_id'] : allowed[name]);
    if (args.inbox_id !== RELAY_OWNER_INBOX) fail(403, 'Forbidden private inbox');
    if (name === 'relay_owner_list_pending') pageArgs(args.cursor, args.limit);
    else if (!uuid(args.message_id)) fail(400, 'Invalid message ID');
    if (name === 'relay_owner_reply') text(args.body, 6000);
  }
  // Server-generated reply IDs need no hashing/await, and their unique
  // reply_to constraint makes retries atomic across independent responders.
  const replyId = name === 'relay_owner_reply' ? crypto.randomUUID() : null;
  return ctx.storage.transactionSync(() => {
    requireOwner(ctx, env, principal);
    const now = Date.now();
    if (pairing) {
      const candidates = args.request_id ? rows(ctx, 'SELECT * FROM relay_owner_pairings WHERE request_id=?', args.request_id)
        : rows(ctx, 'SELECT * FROM relay_owner_pairings WHERE code=? AND expires_ms>? AND approved_ms IS NULL', args.code, now);
      if (candidates.length > 1) fail(409, 'Display code is ambiguous; use the full pairing request ID');
      const row = candidates[0];
      if (!row || row.expires_ms <= now) fail(410, 'Pairing request expired');
      if (name.endsWith('_inspect')) return {request_id: row.request_id, code: row.code, label: row.label, label_verified: false, expires_at: iso(row.expires_ms), status: row.approved_ms === null ? 'pending' : 'approved', access_days: 365, approval_prompt: `Approve only if code ${row.code} matches the device. This grants private owner access for 365 days of inactivity, renewed on successful authenticated use, until revoked.`};
      if (!equal(row.code, args.code)) fail(403, 'Pairing display code mismatch');
      const previous = rows(ctx, 'SELECT * FROM relay_owner_sessions WHERE device_id=?', row.device_id)[0];
      if (row.approved_ms !== null) {
        if (!previous || previous.revoked_ms !== null || previous.expires_ms <= now) fail(409, 'Pairing was already used and the device is unavailable');
        return {approved: true, device: shortDevice(previous), access_days: 365};
      }
      if (rows(ctx, 'SELECT COUNT(*) AS n FROM relay_owner_sessions WHERE principal=? AND revoked_ms IS NULL AND expires_ms>?', RELAY_OWNER, now)[0].n >= MAX_DEVICES) fail(429, 'Owner device limit reached');
      // The session lifetime is independent of the short-lived MCP grant. The
      // approving grant is audit provenance, not a silent 30-day device limit.
      ctx.storage.sql.exec('INSERT INTO relay_owner_sessions VALUES(?,?,?,?,?,?,?,?,?)', row.device_id, row.token_hash, RELAY_OWNER, row.label, now, now, now + RELAY_OWNER_SESSION_MS, null, principal.grantId);
      ctx.storage.sql.exec('UPDATE relay_owner_pairings SET approved_ms=?,approval_grant_id=? WHERE request_id=? AND approved_ms IS NULL', now, principal.grantId, row.request_id);
      return {approved: true, device: shortDevice(rows(ctx, 'SELECT * FROM relay_owner_sessions WHERE device_id=?', row.device_id)[0]), access_days: 365};
    }
    if (name === 'relay_owner_devices_list') return {devices: rows(ctx, 'SELECT * FROM relay_owner_sessions WHERE principal=? ORDER BY created_ms,device_id', RELAY_OWNER).map(row => device(row))};
    if (name === 'relay_owner_device_revoke') return revokeDevice(ctx, args.device_id, now);
    if (name === 'relay_owner_list_pending') return {inbox_id: RELAY_OWNER_INBOX, ...listMessages(ctx, args.cursor, args.limit, true), visibility: 'private'};
    const data = conversation(ctx, args.message_id);
    if (name === 'relay_owner_read_conversation') return {inbox_id: RELAY_OWNER_INBOX, ...data, visibility: 'private'};
    const content = text(args.body, 6000);
    if (data.reply) {
      if (data.reply.body !== content) fail(409, 'Private message already has a different reply');
      return {inbox_id: RELAY_OWNER_INBOX, entry: data.reply, newWrite: false, visibility: 'private'};
    }
    ctx.storage.sql.exec("INSERT INTO relay_owner_entries(id,kind,reply_to,body,created_at,principal,device_id,authentication_source) VALUES(?,'reply',?,?,?,?,?,?)", replyId, args.message_id, content, iso(now), RELAY_OWNER, data.message.device_id, 'owner-oauth-mcp');
    return {inbox_id: RELAY_OWNER_INBOX, entry: entry(rows(ctx, 'SELECT * FROM relay_owner_entries WHERE id=?', replyId)[0]), newWrite: true, visibility: 'private'};
  });
}

export async function relayOwnerPublic(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/relay/owner/')) return null;
  const origin = request.headers.get('Origin'), allowed = new Set([...FRONTEND_ORIGINS, relayIssuer(env)]);
  if (origin && !allowed.has(origin)) return json({error: 'Origin not allowed'}, 403);
  const cors = origin ? {'Access-Control-Allow-Origin': origin, Vary: 'Origin'} : {};
  const wrap = response => {
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set('Referrer-Policy', 'no-referrer'); headers.set('Pragma', 'no-cache');
    return new Response(response.body, {status: response.status, headers});
  };
  if (!relayOwnerEnabled(env)) return wrap(json({error: 'Owner Relay is not activated', code: 'owner_not_enabled'}, 503));
  if (request.method === 'OPTIONS') return wrap(new Response(null, {status: 204, headers: {'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store'}}));
  try {
    const routes = {'/pair/start': ['POST', 'pair_start'], '/pair/status': ['POST', 'pair_status'], '/session': ['GET', 'session'], '/messages': [request.method === 'POST' ? 'POST' : 'GET', request.method === 'POST' ? 'message' : 'messages_list'], '/conversation': ['GET', 'conversation'], '/devices': ['GET', 'devices_list'], '/devices/revoke': ['POST', 'device_revoke']};
    const suffix = path.slice('/relay/owner'.length), route = Object.hasOwn(routes, suffix) ? routes[suffix] : null;
    if (!route) return wrap(json({error: 'Not found'}, 404));
    if (request.method !== route[0]) return wrap(json({error: 'Method not allowed'}, 405, {Allow: route[0] + ', OPTIONS'}));
    const queryFields = route[1] === 'messages_list' ? ['after', 'limit'] : route[1] === 'conversation' ? ['message_id'] : [];
    if ([...url.searchParams.keys()].some(k => !queryFields.includes(k) || url.searchParams.getAll(k).length !== 1)) fail(400, 'Invalid owner query');
    let body = {};
    if (request.method === 'POST') {
      if (!origin) fail(403, 'Owner request origin required');
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) return wrap(json({error: 'Expected JSON'}, 415));
      try { body = JSON.parse(await boundedText(request, 16000)); } catch { fail(400, 'Invalid owner JSON'); }
    }
    const inputFields = {pair_start: ['label'], pair_status: ['request_id'], message: ['id', 'body'], device_revoke: ['device_id']};
    fields(body, inputFields[route[1]] || [], inputFields[route[1]] || []);
    const input = {op: route[1], ...body};
    if (route[1] === 'pair_start') input.rate_hash = await hash('owner-pair-ip:' + (request.headers.get('CF-Connecting-IP') || 'unknown'));
    else {
      const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!token) fail(401, 'Owner device bearer required');
      input.token_hash = await hash(token);
    }
    if (route[1] === 'messages_list') {
      if (url.searchParams.has('after')) input.after = url.searchParams.get('after');
      if (url.searchParams.has('limit')) {
        const limit = url.searchParams.get('limit');
        if (!/^[0-9]{1,2}$/.test(limit)) fail(400, 'Invalid page size');
        input.limit = Number(limit);
      }
    }
    if (route[1] === 'conversation') input.message_id = url.searchParams.get('message_id');
    const response = await env.HUBS.get(env.HUBS.idFromName(RELAY_OAUTH_OBJECT)).fetch(new Request('https://internal/internal/relay/owner', {method: 'POST', body: JSON.stringify(input)}));
    return wrap(response);
  } catch (error) {
    if (error instanceof RelayError) return wrap(json({error: error.message, ...(error.data?.code ? {code: error.data.code} : {})}, error.data?.status || 400));
    return wrap(json({error: 'Owner Relay storage unavailable'}, 503));
  }
}
