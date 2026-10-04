import {PRIMARY_SITE} from './origins.js';
import {RELAY_OWNER, RELAY_INBOX, RELAY_EVENT, RelayError, fields, inboxArgs, cursor, httpsURL, signingKey, signWebhook, hash, canonical, random, equal, boundedText, encoder, relayEnabled, json} from './relay-common.js';
import {relayGrantActiveInStore,relayTokenActiveInStore} from './relay-oauth.js';
export const EVENT_RETENTION_MS = 30 * 86400000;
const DEFAULT_TTL = 86400000;
const VERIFY_TTL = 300000;
const ROTATION_MS = 300000;
const MAX_ATTEMPTS = 6;
const MAX_SUBSCRIPTIONS = 8;
const MAX_QUEUED = 2000;
const rows = (ctx, q, ...v) => [...ctx.storage.sql.exec(q, ...v)];
export function relayEventSchema(ctx) {
  const sql = ctx.storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS relay_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
    message_id TEXT NOT NULL UNIQUE, occurred_at TEXT NOT NULL, created_ms INTEGER NOT NULL, data TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS relay_subscriptions (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL, grant_id TEXT NOT NULL,
    name TEXT NOT NULL, arguments TEXT NOT NULL, callback TEXT NOT NULL,
    secret TEXT NOT NULL, previous_secret TEXT, rotate_until INTEGER,
    expires_ms INTEGER NOT NULL, ack_seq INTEGER NOT NULL, start_seq INTEGER NOT NULL,
    generation TEXT NOT NULL, state TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS relay_outbox (
    subscription_id TEXT NOT NULL, event_seq INTEGER NOT NULL, body TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_ms INTEGER NOT NULL, last_error TEXT,
    PRIMARY KEY(subscription_id,event_seq))`);
  sql.exec('CREATE INDEX IF NOT EXISTS relay_outbox_due ON relay_outbox(status,next_attempt_ms)');
  sql.exec('CREATE TABLE IF NOT EXISTS relay_verified (identity TEXT PRIMARY KEY, verified_until INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS relay_activations (id TEXT PRIMARY KEY, revision TEXT NOT NULL, expires_ms INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS relay_event_meta (key TEXT PRIMARY KEY,value INTEGER NOT NULL)');
}
const latest = ctx => Math.max(rows(ctx, 'SELECT COALESCE(MAX(seq),0) AS n FROM relay_events')[0].n,rows(ctx,"SELECT value FROM relay_event_meta WHERE key='floor'")[0]?.value||0);
const eventCursor = seq => 'relay1:' + seq;
export const relayEventDefinition = {
  name: RELAY_EVENT,
  description: 'A newly saved visitor message in Brayden’s public Relay inbox. Visitors are unauthenticated. Replies, briefings, imports, and duplicate submissions never emit this event. Fetch conversation context before replying.',
  delivery: ['webhook'],
  inputSchema: {type: 'object', properties: {inbox_id: {type: 'string', const: RELAY_INBOX}, message_contains: {type: 'string', minLength: 1, maxLength: 100, description: 'Optional case-insensitive literal substring filter'}}, required: ['inbox_id'], additionalProperties: false},
  payloadSchema: {type: 'object', properties: {inbox_id: {type: 'string', const: RELAY_INBOX}, message_id: {type: 'string', format: 'uuid'}, body_preview: {type: 'string', maxLength: 240}, author_authenticated: {type: 'boolean', const: false}, url: {type: 'string', format: 'uri'}}, required: ['inbox_id', 'message_id', 'body_preview', 'author_authenticated', 'url'], additionalProperties: false}
};
function eventArguments(value) {
  fields(value, ['inbox_id', 'message_contains'], ['inbox_id']); inboxArgs(value);
  if (value.message_contains !== undefined && (typeof value.message_contains !== 'string' || !value.message_contains.trim() || value.message_contains.length > 100)) throw new RelayError(-32602, 'Invalid message filter');
  return value;
}
const matches = (sub, row) => {
  const args = JSON.parse(sub.arguments);
  // Filter against full persisted message, not a truncated preview.
  return !args.message_contains || row.body.toLowerCase().includes(args.message_contains.toLowerCase());
};
function enqueueFor(ctx, sub, event, now,budget) {
  const message = event.message_body!==undefined?{body:event.message_body}:rows(ctx, "SELECT body FROM shared_entries WHERE id=? AND kind='user'", event.message_id)[0];
  if (!message || !matches(sub, message)) return;
  if(budget?budget.remaining<=0:rows(ctx,"SELECT COUNT(*) AS n FROM relay_outbox WHERE subscription_id=? AND status IN ('pending','failed')",sub.id)[0].n>=MAX_QUEUED)return;
  const body = JSON.stringify({eventId: event.event_id, name: RELAY_EVENT, timestamp: event.occurred_at, data: JSON.parse(event.data), cursor: eventCursor(event.seq)});
  if (encoder.encode(body).length > 262144) throw Error('Relay event exceeds payload limit');
  ctx.storage.sql.exec("INSERT OR IGNORE INTO relay_outbox(subscription_id,event_seq,body,status,next_attempt_ms) VALUES(?,?,?,'pending',?)", sub.id, event.seq, body, now);
  if(budget)budget.remaining--;
}
function fillOutbox(ctx,sub,start,now){
  const count=rows(ctx,"SELECT COUNT(*) AS n FROM relay_outbox WHERE subscription_id=? AND status IN ('pending','failed')",sub.id)[0].n;
  const budget={remaining:MAX_QUEUED-count};if(budget.remaining<=0)return;
  if(!rows(ctx,'SELECT seq FROM relay_events WHERE seq>? LIMIT 1',start).length)return;
  // One joined scan, not thousands of per-row count/message queries. Existing
  // outbox rows are excluded so capacity is used only for missing occurrences.
  const missing=rows(ctx,`SELECT e.*,u.body AS message_body FROM relay_events e
    JOIN shared_entries u ON u.id=e.message_id AND u.kind='user'
    LEFT JOIN relay_outbox o ON o.subscription_id=? AND o.event_seq=e.seq
    WHERE e.seq>? AND o.event_seq IS NULL ORDER BY e.seq`,sub.id,start);
  for(const event of missing){enqueueFor(ctx,sub,event,now,budget);if(budget.remaining<=0)break;}
}
export function enqueueRelayMessage(ctx, message, now = Date.now()) {
  // Called synchronously inside the same transaction as the new user row.
  // Migration/import paths deliberately do not call this function.
  relayEventSchema(ctx);
  const sql = ctx.storage.sql;
  const data = {inbox_id: RELAY_INBOX, message_id: message.id, body_preview: message.body.slice(0, 240), author_authenticated: false, url: PRIMARY_SITE + '/reader/'};
  sql.exec('INSERT OR IGNORE INTO relay_events(event_id,message_id,occurred_at,created_ms,data) VALUES(?,?,?,?,?)', 'relay_msg_' + message.id, message.id, message.createdAt, now, JSON.stringify(data));
  const event = rows(ctx, 'SELECT * FROM relay_events WHERE message_id=?', message.id)[0];
  for (const sub of rows(ctx, "SELECT * FROM relay_subscriptions WHERE state='active' AND expires_ms>?", now)) enqueueFor(ctx, sub, event, now);
}
export function webhookTransport(env) {
  // The trusted adapter validates DNS on every connection and pins the public IP.
  // Do not replace this with Workers fetch: it cannot pin DNS while preserving TLS.
  if (!env.RELAY_WEBHOOK_EGRESS_URL || !env.RELAY_WEBHOOK_EGRESS_TOKEN) return null;
  const endpoint = httpsURL(env.RELAY_WEBHOOK_EGRESS_URL).href;
  return async (url, options) => {
    const response = await fetch(endpoint, {method: 'POST', redirect: 'error', signal: options.signal, headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RELAY_WEBHOOK_EGRESS_TOKEN}, body: JSON.stringify({url, headers: options.headers, body: options.body})});
    const text = await boundedText(response, 65536);
    if (!response.ok) {
      let reason;try{reason=JSON.parse(text).reason;}catch{}
      throw new RelayError(-32015, 'Callback transport failed', {reason:['timeout','tls_error','connection_refused'].includes(reason)?reason:'connection_refused'});
    }
    const result = JSON.parse(text);
    if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599 || typeof result.body !== 'string') throw new RelayError(-32015, 'Invalid callback transport response', {reason: 'connection_refused'});
    return new Response([204,205,304].includes(result.status) ? null : result.body, {status: result.status, headers: {'Content-Type': 'application/json'}});
  };
}
async function signedPost(sub, body, eventId, fetcher, now,beforeSend) {
  const seconds = Math.floor(now / 1000);
  let signature = await signWebhook(sub.secret, eventId, seconds, body);
  if (sub.previous_secret && sub.rotate_until > now) signature += ' ' + await signWebhook(sub.previous_secret, eventId, seconds, body);
  // HMAC operations await. Revalidate at the actual send boundary, so a revoke
  // or unsubscribe during signing cannot initiate a new application callback.
  if(beforeSend&&!beforeSend())throw new RelayError(-32012,'Connection revoked or subscription changed');
  return fetcher(sub.callback, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: {'Content-Type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': String(seconds), 'webhook-signature': signature, 'X-MCP-Subscription-Id': sub.id}, body});
}
function failureReason(error) {
  if (error instanceof RelayError && error.data?.reason) return error.data.reason;
  if (['TimeoutError', 'AbortError'].includes(error.name)) return 'timeout';
  return 'connection_refused';
}
async function verifyCallback(ctx, sub, fetcher, now) {
  const identity = await hash(canonical([sub.principal, sub.callback]));
  if (rows(ctx, 'SELECT identity FROM relay_verified WHERE identity=? AND verified_until>?', identity, now).length) return;
  const challenge = random(), body = JSON.stringify({type: 'verification', challenge});
  let response;
  try { response = await signedPost(sub, body, 'verification_' + random(), fetcher, now); }
  catch (error) { throw new RelayError(-32015, 'Callback endpoint verification failed', {reason: failureReason(error)}); }
  if (!response.ok) throw new RelayError(-32015, 'Callback endpoint verification failed', {reason: response.status >= 500 ? 'http_5xx' : 'http_4xx'});
  let echoed; try { echoed = JSON.parse(await boundedText(response, 4096)).challenge; } catch {}
  if (typeof echoed !== 'string' || !equal(echoed, challenge) || Date.now() - now > 10000) throw new RelayError(-32015, 'Callback challenge failed', {reason: 'challenge_failed'});
  ctx.storage.sql.exec('INSERT OR REPLACE INTO relay_verified VALUES(?,?)', identity, now + VERIFY_TTL);
}
function subscriptionParams(p, subscribing) {
  fields(p, subscribing ? ['name', 'arguments', 'delivery', 'cursor', 'ttlMs', 'maxAgeMs', '_meta'] : ['name', 'arguments', 'delivery', '_meta'], ['name', 'arguments', 'delivery']);
  if (p.name !== RELAY_EVENT) throw new RelayError(-32011, 'Unknown event', {kind: 'event'});
  eventArguments(p.arguments);
  fields(p.delivery, subscribing ? ['mode', 'url', 'secret'] : ['mode', 'url'], subscribing ? ['mode', 'url', 'secret'] : ['mode', 'url']);
  if (p.delivery.mode !== 'webhook') throw new RelayError(-32014, 'Unsupported delivery mode', {feature: 'deliveryMode', value: p.delivery.mode});
  httpsURL(p.delivery.url);
  if (subscribing) signingKey(p.delivery.secret);
}
export async function relaySubscribe(ctx, principal, p, env, fetcher = webhookTransport(env), now = Date.now()) {
  relayEventSchema(ctx); subscriptionParams(p, true);
  if (principal.principal!==RELAY_OWNER || !principal.scopes.includes('relay:events')) throw new RelayError(-32012, 'Event scope required');
  if (!fetcher) throw new RelayError(-32014, 'Secure callback transport is not configured', {feature: 'webhookDelivery'});
  if (p.ttlMs !== undefined && p.ttlMs !== null && (!Number.isSafeInteger(p.ttlMs) || p.ttlMs <= 0)) throw new RelayError(-32602, 'Invalid subscription lifetime');
  if (p.maxAgeMs !== undefined && (!Number.isSafeInteger(p.maxAgeMs) || p.maxAgeMs < 0 || p.maxAgeMs > EVENT_RETENTION_MS)) throw new RelayError(-32602, 'Invalid replay age');
  const requested = cursor(p.cursor, 'relay1:');
  if (requested !== null && requested > latest(ctx)) throw new RelayError(-32602, 'Cursor is ahead of event history');
  const id = 'sub_' + await hash(canonical([principal.principal, p.delivery.url, p.name, p.arguments]));
  if(!relayGrantActiveInStore(ctx,env,principal.grantId,'relay:events')||principal.accessHash&&!relayTokenActiveInStore(ctx,env,principal,'relay:events'))throw new RelayError(-32012,'Connection rotated or revoked');
  const at=Math.max(now,Date.now());
  ctx.storage.sql.exec('DELETE FROM relay_activations WHERE expires_ms<=?',at);
  const prior = rows(ctx, 'SELECT * FROM relay_subscriptions WHERE id=?', id)[0];
  const activeCount = rows(ctx,'SELECT COUNT(*) AS n FROM (SELECT id FROM relay_subscriptions WHERE expires_ms>? UNION SELECT id FROM relay_activations WHERE expires_ms>?)',at,at)[0].n;
  const reserved=rows(ctx,'SELECT id FROM relay_activations WHERE id=?',id)[0];
  if (!(prior&&prior.expires_ms>at)&&!reserved && activeCount >= MAX_SUBSCRIPTIONS) throw new RelayError(-32013, 'Subscription limit reached', {limit: 'subscriptions', max: MAX_SUBSCRIPTIONS});
  const revision='rev_'+random();
  // Reservation contains no signing key or application data. Unsubscribe can
  // cancel it while callback verification is awaiting an external response.
  ctx.storage.sql.exec('INSERT OR REPLACE INTO relay_activations VALUES(?,?,?)',id,revision,Math.max(now,Date.now())+10000);
  const sub = {id, principal: principal.principal, grant_id: principal.grantId, callback: p.delivery.url, secret: p.delivery.secret};
  try{
  await verifyCallback(ctx, sub, fetcher, now);
  // Verification awaits external I/O. Recheck revocation before activating storage.
  if (!relayGrantActiveInStore(ctx,env,principal.grantId,'relay:events')) throw new RelayError(-32012, 'Connection revoked');
  if(principal.accessHash&&!relayTokenActiveInStore(ctx,env,principal,'relay:events'))throw new RelayError(-32012,'Connection rotated or revoked');
  const expires = Math.max(now,Date.now()) + Math.min(p.ttlMs ?? DEFAULT_TTL, DEFAULT_TTL);
  const result = ctx.storage.transactionSync(() => {
    if(!rows(ctx,'SELECT id FROM relay_activations WHERE id=? AND revision=? AND expires_ms>?',id,revision,Math.max(now,Date.now())).length)throw new RelayError(-32012,'Subscription activation canceled or superseded');
    const current = rows(ctx, 'SELECT * FROM relay_subscriptions WHERE id=?', id)[0];
    const at=Math.max(now,Date.now());
    if(!(current&&current.expires_ms>at)&&rows(ctx,'SELECT COUNT(*) AS n FROM relay_subscriptions WHERE expires_ms>?',at)[0].n>=MAX_SUBSCRIPTIONS)throw new RelayError(-32013,'Subscription limit reached',{limit:'subscriptions',max:MAX_SUBSCRIPTIONS});
    const newest = latest(ctx), floor = rows(ctx, "SELECT value FROM relay_event_meta WHERE key='floor'")[0]?.value || 0;
    let start = requested === null ? (current?.ack_seq ?? newest) : requested;
    // Never advance past a still-pending occurrence during a refresh, even if a client sends a newer cursor.
    if (current) start = Math.min(start, current.ack_seq);
    const ageFloor = p.maxAgeMs === undefined ? 0 : rows(ctx, 'SELECT COALESCE(MAX(seq),0) AS n FROM relay_events WHERE created_ms<?', now - p.maxAgeMs)[0].n;
    const truncated = start < floor || start < ageFloor;
    start = Math.max(start, floor, ageFloor);
    const changed = current && current.secret !== sub.secret;
    const previous = changed ? current.secret : current?.previous_secret || null;
    const rotate = changed ? now + ROTATION_MS : current?.rotate_until || null;
    // A fresh revision cannot collide with an unsubscribed/recreated identity.
    // In-flight acknowledgments must never mutate its replacement subscription.
    ctx.storage.sql.exec('INSERT OR REPLACE INTO relay_subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, principal.principal, principal.grantId, p.name, canonical(p.arguments), p.delivery.url, sub.secret, previous, rotate, expires, start, current?.start_seq ?? start, revision, 'active');
    ctx.storage.sql.exec("DELETE FROM relay_outbox WHERE subscription_id=? AND event_seq<=?", id, start);
    ctx.storage.sql.exec("UPDATE relay_outbox SET status='pending',attempts=0,next_attempt_ms=?,last_error=NULL WHERE subscription_id=? AND status='failed'", now, id);
    const saved = rows(ctx, 'SELECT * FROM relay_subscriptions WHERE id=?', id)[0];
    fillOutbox(ctx,saved,start,now);
    return {id, refreshBefore: new Date(expires).toISOString(), cursor: eventCursor(start), truncated};
  });
  await scheduleRelayAlarm(ctx, now);
  return result;
  }finally{ctx.storage.sql.exec('DELETE FROM relay_activations WHERE id=? AND revision=?',id,revision);}
}
export async function relayUnsubscribe(ctx, principal, p, now = Date.now(),env) {
  relayEventSchema(ctx); subscriptionParams(p, false);
  if (principal.principal!==RELAY_OWNER||!principal.scopes.includes('relay:events')) throw new RelayError(-32012, 'Event scope required');
  const id = 'sub_' + await hash(canonical([principal.principal, p.delivery.url, p.name, p.arguments]));
  if(env&&!relayTokenActiveInStore(ctx,env,principal,'relay:events'))throw new RelayError(-32012,'Connection rotated or revoked');
  ctx.storage.transactionSync(() => {
    ctx.storage.sql.exec('DELETE FROM relay_activations WHERE id=?',id);
    ctx.storage.sql.exec('DELETE FROM relay_outbox WHERE subscription_id=?', id);
    ctx.storage.sql.exec('DELETE FROM relay_subscriptions WHERE id=? AND principal=?', id, principal.principal);
  });
  await scheduleRelayAlarm(ctx, now); return {};
}
export async function scheduleRelayAlarm(ctx, now = Date.now(),pendingDelay=0) {
  if (!ctx.storage.setAlarm) return;
  relayEventSchema(ctx);
  const next = rows(ctx, "SELECT MIN(o.next_attempt_ms) AS n FROM relay_outbox o JOIN relay_subscriptions s ON s.id=o.subscription_id WHERE o.status='pending' AND s.state='active' AND s.expires_ms>?", now)[0].n;
  const expiration = rows(ctx, 'SELECT MIN(expires_ms) AS n FROM relay_subscriptions')[0].n;
  const history = rows(ctx, 'SELECT MIN(created_ms) AS n FROM relay_events')[0].n;
  const times = [next===null?null:Math.max(next,now+pendingDelay), expiration, history === null ? null : history + EVENT_RETENTION_MS].filter(x => x !== null);
  if (times.length) await ctx.storage.setAlarm(Math.max(now + 50, Math.min(...times)));
  else if (ctx.storage.deleteAlarm) await ctx.storage.deleteAlarm();
}
export async function drainRelayOutbox(ctx, env, fetcher = webhookTransport(env), now = Date.now()) {
  relayEventSchema(ctx);
  const sql = ctx.storage.sql;
  // Cleanup also destroys expired callback secrets. Do not retain them in diagnostics.
  const stop = id => { sql.exec('DELETE FROM relay_outbox WHERE subscription_id=?', id); sql.exec('DELETE FROM relay_subscriptions WHERE id=?', id); };
  for (const sub of rows(ctx, 'SELECT * FROM relay_subscriptions')) {
    if (sub.expires_ms <= now || !relayEnabled(env) || !relayGrantActiveInStore(ctx,env,sub.grant_id,'relay:events')) { stop(sub.id); continue; }
    if (sub.rotate_until && sub.rotate_until <= now) sql.exec('UPDATE relay_subscriptions SET previous_secret=NULL,rotate_until=NULL WHERE id=?', sub.id);
  }
  sql.exec('DELETE FROM relay_verified WHERE verified_until<=?', now);
  sql.exec('DELETE FROM relay_activations WHERE expires_ms<=?',now);
  const expired = rows(ctx, 'SELECT COALESCE(MAX(seq),0) AS n FROM relay_events WHERE created_ms<=?', now - EVENT_RETENTION_MS)[0].n;
  if (expired) {
    sql.exec("INSERT OR REPLACE INTO relay_event_meta VALUES('floor',?)", expired);
    sql.exec('DELETE FROM relay_events WHERE seq<=?', expired);
  }
  if (fetcher) {
    // At most one oldest occurrence per subscription per alarm. Ordering keeps cursor safe.
    for (const sub of rows(ctx, "SELECT * FROM relay_subscriptions WHERE state='active' ORDER BY id LIMIT 8")) {
      // Refill from the durable journal, including occurrences skipped while the
      // bounded pending outbox was full. Delivered rows stay deduplicated.
      fillOutbox(ctx,sub,sub.ack_seq,now);
      const item = rows(ctx, "SELECT * FROM relay_outbox WHERE subscription_id=? AND status IN ('pending','failed') ORDER BY event_seq LIMIT 1", sub.id)[0];
      if (!item || item.status !== 'pending' || item.next_attempt_ms > now) continue;
      const fresh = rows(ctx, "SELECT id FROM relay_subscriptions WHERE id=? AND generation=? AND state='active' AND expires_ms>?", sub.id, sub.generation, now)[0];
      if (!fresh || !relayGrantActiveInStore(ctx,env,sub.grant_id,'relay:events')) continue;
      let status = 0, reason = null;
      try { status = (await signedPost(sub, item.body, JSON.parse(item.body).eventId, fetcher, now,()=>{
        const at=Math.max(now,Date.now());
        return !!rows(ctx,"SELECT id FROM relay_subscriptions WHERE id=? AND generation=? AND state='active' AND expires_ms>?",sub.id,sub.generation,at).length&&relayGrantActiveInStore(ctx,env,sub.grant_id,'relay:events');
      })).status; }
      catch (error) { reason = failureReason(error); }
      // Unsubscribe/renew may have happened while delivery was in flight.
      if (!rows(ctx, 'SELECT id FROM relay_subscriptions WHERE id=? AND generation=?', sub.id, sub.generation).length) continue;
      if(!relayGrantActiveInStore(ctx,env,sub.grant_id,'relay:events')){stop(sub.id);continue;}
      if (status >= 200 && status < 300) {
        ctx.storage.transactionSync(() => {
          sql.exec("UPDATE relay_outbox SET status='delivered',attempts=attempts+1,last_error=NULL WHERE subscription_id=? AND event_seq=?", sub.id, item.event_seq);
          sql.exec('UPDATE relay_subscriptions SET ack_seq=? WHERE id=?', item.event_seq, sub.id);
        });
      } else if (status === 410) stop(sub.id);
      else {
        const attempts = item.attempts + 1;
        const transient = !status || status === 408 || status === 429 || status >= 500;
        const retry = transient && attempts < MAX_ATTEMPTS && status !== 413;
        const delay = Math.min(300000, 1000 * 2 ** (attempts - 1));
        sql.exec('UPDATE relay_outbox SET status=?,attempts=?,next_attempt_ms=?,last_error=? WHERE subscription_id=? AND event_seq=?', retry ? 'pending' : 'failed', attempts, now + delay, reason || 'http_' + status, sub.id, item.event_seq);
        if (!retry) sql.exec("UPDATE relay_subscriptions SET state='delivery_failed' WHERE id=?", sub.id);
      }
    }
  }
  // Missing deployment configuration must not produce a 50ms alarm busy loop.
  await scheduleRelayAlarm(ctx, now,fetcher?0:60000);
}
