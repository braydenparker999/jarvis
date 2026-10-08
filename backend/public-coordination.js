import {canonical, uuid, isObject} from './relay-common.js';
import {enqueueRelayPublicResult} from './relay-events.js';

export const COORDINATION_SCHEMA = 'jarvis-coordination-v2';
const stages = ['receipt', 'progress', 'final', 'correction'];
const nonempty = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
const artifact = value => {
  if (!isObject(value) || Object.keys(value).some(key => !['id', 'revision', 'label', 'url'].includes(key)) ||
      !uuid(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !nonempty(value.label, 120) ||
      typeof value.url !== 'string' || value.url.length > 2048) return false;
  try {
    const url = new URL(value.url);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443');
  } catch { return false; }
};

// Public JSON is data. No submitted identity, grant, run or execution attestation
// fields are accepted. The importer supplies transport provenance separately.
export function decodeCoordination(value) {
  const allowed = ['schema', 'eventId', 'requestId', 'attemptId', 'stage', 'body', 'artifacts', 'resultVersion', 'supersedesEventId'];
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key)) || value.schema !== COORDINATION_SCHEMA ||
      !uuid(value.eventId) || !uuid(value.requestId) || !uuid(value.attemptId) || !stages.includes(value.stage) ||
      !nonempty(value.body, 6000) || !Array.isArray(value.artifacts) || value.artifacts.length > 8 ||
      !value.artifacts.every(artifact) || new Set(value.artifacts.map(item => item.id)).size !== value.artifacts.length) return null;
  if (value.stage === 'final') {
    if (value.resultVersion !== 1 || value.supersedesEventId !== undefined) return null;
  } else if (value.stage === 'correction') {
    if (!Number.isSafeInteger(value.resultVersion) || value.resultVersion < 2 || !uuid(value.supersedesEventId)) return null;
  } else if (value.resultVersion !== undefined || value.supersedesEventId !== undefined || value.artifacts.length) return null;
  // Preserve exact text, including whitespace; retry equality uses the complete
  // canonical payload, independent of JSON key order and transport timestamps.
  return value;
}

const rows = (ctx, query, ...values) => [...ctx.storage.sql.exec(query, ...values)];
export function coordinationSchema(ctx) {
  const sql = ctx.storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS public_coordination_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, stage TEXT NOT NULL,
    result_version INTEGER, disposition TEXT NOT NULL, error_code TEXT,
    payload TEXT NOT NULL, provenance TEXT NOT NULL, recorded_at TEXT NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS public_coordination_request ON public_coordination_events(request_id, seq)');
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS public_coordination_version ON public_coordination_events(request_id, attempt_id, result_version)
    WHERE disposition='accepted' AND result_version IS NOT NULL`);
  sql.exec(`CREATE TABLE IF NOT EXISTS public_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, item_id TEXT NOT NULL,
    request_id TEXT, UNIQUE(kind,item_id))`);
  sql.exec('CREATE INDEX IF NOT EXISTS public_changes_request ON public_changes(request_id, seq)');
  if (!rows(ctx, "SELECT value FROM shared_meta WHERE key='public-changes-backfilled'").length) {
    ctx.storage.transactionSync(() => {
      sql.exec(`INSERT OR IGNORE INTO public_changes(kind,item_id,request_id)
        SELECT 'entry',id,CASE WHEN kind='user' THEN id ELSE reply_to END FROM shared_entries ORDER BY seq`);
      sql.exec("INSERT OR REPLACE INTO shared_meta VALUES('public-changes-backfilled','true')");
    });
  }
}
export function recordPublicEntry(ctx, id) {
  ctx.storage.sql.exec(`INSERT OR IGNORE INTO public_changes(kind,item_id,request_id)
    SELECT 'entry',id,CASE WHEN kind='user' THEN id ELSE reply_to END FROM shared_entries WHERE id=?`, id);
}
const publicEntry = row => ({id: row.id, body: row.body, createdAt: row.created_at,
  ...(row.kind === 'briefing' ? {title: row.title} : {role: row.kind === 'user' ? 'user' : 'assistant'}),
  ...(row.kind === 'reply' ? {kind: 'reply', replyTo: row.reply_to} : {})});
export function publicEvent(ctx, row) {
  const original = rows(ctx, "SELECT body FROM shared_entries WHERE id=? AND kind='user'", row.request_id)[0];
  return {...JSON.parse(row.payload), sequence: row.seq, recordedAt: row.recorded_at,
    provenance: JSON.parse(row.provenance), disposition: row.disposition,
    ...(row.error_code ? {errorCode: row.error_code} : {}),
    destination: row.request_id === 'f62e9e27-d106-465c-a2e7-c4dd64323040' || original?.body.startsWith('[Jarvis Muse v1]\n') ? 'muse' : 'jarvis',
    visibility: 'public', author_authenticated: false, execution_authorized: false};
}

export function appendCoordination(ctx, payload, provenance, now = Date.now()) {
  const legacy = payload?.schema === 'jarvis-publication-v1-update';
  if (!legacy && !decodeCoordination(payload)) return Response.json({error: 'Invalid coordination event'}, {status: 400});
  return ctx.storage.transactionSync(() => {
    const encoded = canonical(payload);
    const existing = rows(ctx, 'SELECT * FROM public_coordination_events WHERE event_id=?', payload.eventId)[0];
    if (existing) {
      if (existing.payload !== encoded) return Response.json({error: 'Event ID has different payload', code: 'event_id_conflict'}, {status: 409});
      return Response.json({event: publicEvent(ctx, existing), duplicate: true,
        ...(existing.error_code?{error:'Public result version conflict',code:existing.error_code}:{})}, {status: existing.disposition === 'conflict' ? 409 : 200});
    }
    if (!rows(ctx, "SELECT id FROM shared_entries WHERE id=? AND kind='user'", payload.requestId).length)
      return Response.json({error: 'Public original message not found'}, {status: 404});
    if (!legacy && rows(ctx, 'SELECT id FROM shared_entries WHERE id=?', payload.eventId).length)
      return Response.json({error:'Event ID conflicts with an immutable chat entry',code:'event_id_conflict'},{status:409});
    let conflict = null;
    const attempt = rows(ctx, 'SELECT request_id FROM public_coordination_events WHERE attempt_id=? LIMIT 1', payload.attemptId)[0];
    if (attempt && attempt.request_id !== payload.requestId) conflict = 'attempt_request_conflict';
    if (payload.stage === 'correction') {
      const prior = rows(ctx, 'SELECT * FROM public_coordination_events WHERE event_id=?', payload.supersedesEventId)[0];
      if (!prior) return Response.json({error: 'Predecessor not yet imported', code: 'predecessor_pending'}, {status: 425});
      if (prior.request_id !== payload.requestId || prior.attempt_id !== payload.attemptId || prior.disposition !== 'accepted' ||
          prior.result_version !== payload.resultVersion - 1) conflict = 'predecessor_conflict';
      else {
        // Removal from one version does not reset a stable artifact's revision.
        // Retain the latest historical revision when a later correction restores it.
        const oldArtifacts = new Map();
        for(const previous of rows(ctx,"SELECT payload FROM public_coordination_events WHERE request_id=? AND attempt_id=? AND disposition='accepted' AND result_version<? ORDER BY result_version DESC",
          payload.requestId,payload.attemptId,payload.resultVersion)) {
          for(const item of JSON.parse(previous.payload).artifacts)if(!oldArtifacts.has(item.id))oldArtifacts.set(item.id,item);
        }
        for (const item of payload.artifacts) {
          const old = oldArtifacts.get(item.id);
          if (old && (item.revision < old.revision || item.revision === old.revision && canonical(item) !== canonical(old))) conflict = 'artifact_revision_conflict';
        }
      }
    }
    if (payload.resultVersion !== undefined && rows(ctx,
      "SELECT event_id FROM public_coordination_events WHERE request_id=? AND attempt_id=? AND result_version=? AND disposition='accepted'",
      payload.requestId, payload.attemptId, payload.resultVersion).length) conflict = 'result_version_conflict';
    const recordedAt = new Date(now).toISOString();
    ctx.storage.sql.exec(`INSERT INTO public_coordination_events(event_id,request_id,attempt_id,stage,result_version,disposition,error_code,payload,provenance,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, payload.eventId, payload.requestId, payload.attemptId, payload.stage,
      payload.resultVersion ?? null, conflict ? 'conflict' : 'accepted', conflict, encoded, JSON.stringify(provenance), recordedAt);
    ctx.storage.sql.exec("INSERT INTO public_changes(kind,item_id,request_id) VALUES('event',?,?)", payload.eventId, payload.requestId);
    // A first final also supplies the single immutable reply for v1 readers and
    // pending queues. Later reports/corrections never change that accepted row.
    if (!conflict && payload.stage === 'final' && !rows(ctx, 'SELECT id FROM shared_entries WHERE reply_to=?', payload.requestId).length &&
        !rows(ctx, 'SELECT id FROM shared_entries WHERE id=?', payload.eventId).length) {
      ctx.storage.sql.exec("INSERT INTO shared_entries(id,kind,reply_to,body,created_at) VALUES(?,'reply',?,?,?)",
        payload.eventId, payload.requestId, payload.body.trim(), recordedAt);
      recordPublicEntry(ctx, payload.eventId);
    }
    const event = publicEvent(ctx, rows(ctx, 'SELECT * FROM public_coordination_events WHERE event_id=?', payload.eventId)[0]);
    enqueueRelayPublicResult(ctx,event,now);
    return Response.json({event, ...(conflict ? {error: 'Public result version conflict', code: conflict} : {})}, {status: conflict ? 409 : 201});
  });
}

function pageBounds(ctx, params, requestId) {
  const prefix=requestId?'pr2:'+requestId+':':'pc2:';
  const value = params.get('cursor') ?? prefix+'0';
  const match = new RegExp('^'+prefix+'(0|[1-9]\\d{0,14})(?::(0|[1-9]\\d{0,14}))?$').exec(value);
  const max = rows(ctx, 'SELECT COALESCE(MAX(seq),0) AS n FROM public_changes')[0].n;
  const after = match ? Number(match[1]) : -1, through = match?.[2] === undefined ? max : Number(match[2]);
  const limitText = params.get('limit') ?? '100', limit = Number(limitText);
  if (!match || after > through || through > max || !/^[1-9]\d{0,2}$/.test(limitText) || limit > 100) return null;
  return {after, through, limit, prefix};
}
export function readPublicCoordination(ctx, path, params) {
  const requestId = params.get('requestId');
  const exact = path.endsWith('/result');
  if (exact && !uuid(requestId)) return Response.json({error: 'Invalid request ID'}, {status: 400});
  const bounds = pageBounds(ctx, params, exact?requestId:null);
  if (!bounds) return Response.json({error: 'Invalid public change cursor or limit'}, {status: 400});
  const {after, through, limit, prefix} = bounds;
  const message = exact ? rows(ctx, "SELECT * FROM shared_entries WHERE id=? AND kind='user'", requestId)[0] : null;
  if (exact && !message) return Response.json({error: 'Public original message not found'}, {status: 404});
  const page = rows(ctx, `SELECT * FROM public_changes WHERE seq>? AND seq<=?${exact ? " AND request_id=? AND kind='event'" : ''} ORDER BY seq LIMIT ?`,
    after, through, ...(exact ? [requestId] : []), limit + 1);
  const selected = page.slice(0, limit);
  const changes = selected.map(change => ({sequence: change.seq, kind: change.kind,
    ...(change.kind === 'event' ? {event: publicEvent(ctx, rows(ctx, 'SELECT * FROM public_coordination_events WHERE event_id=?', change.item_id)[0])}
      : {entry: publicEntry(rows(ctx, 'SELECT * FROM shared_entries WHERE id=?', change.item_id)[0])})}));
  const reply = exact ? rows(ctx, "SELECT * FROM shared_entries WHERE reply_to=? AND kind='reply'", requestId)[0] : null;
  return Response.json({mode: 'github-publications', coordinationVersion: 2,
    ...(exact ? {message: publicEntry(message), reply: reply ? publicEntry(reply) : null, events: changes.map(change => change.event)} : {changes}),
    cursor: prefix + through, nextCursor: page.length > limit ? `${prefix}${selected.at(-1).seq}:${through}` : null,
    public_inbox: true, author_authenticated: false, execution_authorized: false});
}
