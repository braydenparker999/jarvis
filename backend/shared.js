// One shared inbox. Public callers can create user messages only.
import publication from '../public/content/jarvis.json' with {type:'json'};
export const SHARED_OBJECT = 'jarvis-shared-v2';
export const PUBLIC_KEY = '2d9a0d0d4254cd5774d2d4e7806cbadae306271ffc1f31fef0d44cd7e226c2a5';
const id = x => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const text = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const json = (x, status = 200) => Response.json(x, {status});

export function sharedStore(ctx, path, body = {}, params = new URLSearchParams()) {
  const sql = ctx.storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS shared_entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('user','reply','briefing')),
    reply_to TEXT UNIQUE, title TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS shared_kind_seq ON shared_entries(kind, seq)');
  sql.exec('CREATE TABLE IF NOT EXISTS shared_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS shared_briefing_dates (date TEXT PRIMARY KEY, entry_id TEXT NOT NULL)');
  const rows = (q, ...v) => [...sql.exec(q, ...v)];
  const entry = r => ({id:r.id, body:r.body, createdAt:r.created_at,
    ...(r.kind === 'briefing' ? {title:r.title} : {role:r.kind === 'user' ? 'user' : 'assistant'}),
    ...(r.kind === 'reply' ? {kind:'reply', replyTo:r.reply_to} : {})});
  const insert = (m, kind) => sql.exec(
    'INSERT INTO shared_entries(id,kind,reply_to,title,body,created_at) VALUES(?,?,?,?,?,?)',
    m.id, kind, m.replyTo || null, m.title || null, m.body.trim(), m.createdAt || new Date().toISOString());
  if (path === '/internal/shared/import') {
    // Input comes only from the old DO and the checked-in, trusted publication.
    return ctx.storage.transactionSync(() => {
      for (const m of body.messages || []) {
        if (m.role === 'user' && id(m.id) && text(m.body,4000) && !rows('SELECT id FROM shared_entries WHERE id=?',m.id).length) insert(m,'user');
      }
      if (!rows("SELECT value FROM shared_meta WHERE key='publication-imported'").length) {
        for (const r of publication.replies) {
          if (rows("SELECT id FROM shared_entries WHERE id=? AND kind='user'",r.replyTo).length && !rows('SELECT id FROM shared_entries WHERE id=? OR reply_to=?',r.id,r.replyTo).length) insert(r,'reply');
        }
        for (const p of publication.posts) if (!rows('SELECT id FROM shared_entries WHERE id=?',p.id).length) insert(p,'briefing');
        // Do not mark complete until every original reply has its user message.
        if (publication.replies.every(r => rows('SELECT id FROM shared_entries WHERE reply_to=?',r.replyTo).length)) sql.exec("INSERT OR REPLACE INTO shared_meta VALUES('publication-imported','true')");
      }
      return json({ok:true});
    });
  }
  if (path === '/internal/shared/state' || path === '/internal/shared/inbox') {
    const cursor = params.get('after') || '0';
    if (!/^\d{1,15}$/.test(cursor)) return json({error:'Invalid cursor'},400);
    const page = rows('SELECT * FROM shared_entries WHERE seq>? ORDER BY seq LIMIT 201',Number(cursor));
    const selected = page.slice(0,200);
    const result = {messages:selected.filter(r=>r.kind!=='briefing').map(entry),posts:selected.filter(r=>r.kind==='briefing').map(entry),
      nextCursor:page.length>200 ? String(selected.at(-1).seq) : null,
      mode:'github-publications',serviceVersion:6,publisher:{source:'GitHub issue #2 → Cloudflare',...JSON.parse(rows("SELECT value FROM shared_meta WHERE key='publisher-status'")[0]?.value || '{"ok":false,"error":"Publication sync has not run yet"}')}};
    if (path.endsWith('/inbox')) {
      // Pending queue is independent of history pagination; never hide old pending messages.
      const pending=rows("SELECT * FROM shared_entries u WHERE kind='user' AND NOT EXISTS(SELECT 1 FROM shared_entries r WHERE r.reply_to=u.id) ORDER BY seq LIMIT 101");
      result.unanswered=pending.slice(0,100).map(entry);result.moreUnanswered=pending.length>100;

    }
    return json(result);
  }
  const kind = path === '/internal/shared/message' ? 'user' : path === '/internal/shared/reply' ? 'reply' : path === '/internal/shared/briefing' ? 'briefing' : null;
  if (!kind) return json({error:'Not found'},404);
  if (!id(body.id) || !text(body.body,kind==='user'?4000:6000) || kind==='reply'&&!id(body.replyTo) || kind==='briefing'&&!text(body.title,120)) return json({error:'Invalid entry'},400);
  return ctx.storage.transactionSync(() => {
    const existing=rows('SELECT * FROM shared_entries WHERE id=?',body.id)[0];
    const dated=kind==='briefing'&&body.date?rows('SELECT e.* FROM shared_entries e JOIN shared_briefing_dates d ON e.id=d.entry_id WHERE d.date=?',body.date)[0]:null;
    const prior=kind==='reply'?rows('SELECT * FROM shared_entries WHERE reply_to=?',body.replyTo)[0]:(dated||existing);
    const same=r=>r && r.kind===kind && r.body===body.body.trim() && (r.title||'')===(body.title?.trim()||'') && (r.reply_to||'')===(body.replyTo||'');
    if (existing && !same(existing)) return json({error:'Entry ID conflict'},409);
    if (prior) return same(prior)?json({entry:entry(prior)}):json({error:'Entry already exists with different content'},409);
    if (kind==='reply'&&!rows("SELECT id FROM shared_entries WHERE id=? AND kind='user'",body.replyTo).length) return json({error:'Original message not found'},404);
    // Public writes have a fixed daily cap. Paid upgrades are never automatic.
    if (kind==='user') {
      const today=new Date().toISOString().slice(0,10);
      const count=rows("SELECT value FROM shared_meta WHERE key=?",'messages:'+today)[0];
      if (Number(count?.value||0)>=200) return json({error:'Daily message limit reached. Try again tomorrow.'},429);
      sql.exec("DELETE FROM shared_meta WHERE key LIKE 'messages:%' AND key<>?",'messages:'+today);
      sql.exec('INSERT OR REPLACE INTO shared_meta VALUES(?,?)','messages:'+today,String(Number(count?.value||0)+1));
    }
    const value={...body,title:body.title?.trim()};insert(value,kind);
    if(kind==='briefing'&&body.date)sql.exec('INSERT INTO shared_briefing_dates VALUES(?,?)',body.date,body.id);
    return json({entry:entry(rows('SELECT * FROM shared_entries WHERE id=?',body.id)[0])},201);
  });
}
