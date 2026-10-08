import {sharedStore} from './shared.js';
import {decodeCoordination} from './public-coordination.js';
export const COMMENTS_URL='https://api.github.com/repos/braydenparker999/jarvis/issues/2/comments';
const OWNER=183016859, INTERVAL=300000;
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const nonempty=(x,max)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
export function decodePublication(comment) {
  if(comment?.user?.id!==OWNER||!Number.isSafeInteger(comment.id)||comment.id<1||typeof comment.body!=='string'||comment.body.length>30000)return null;
  let p;try{p=JSON.parse(comment.body);}catch{return null;}
  if (p?.schema === 'jarvis-coordination-v2') {
    if (!decodeCoordination(p) || !Number.isFinite(Date.parse(comment.created_at))) return null;
    return {type:'coordination',payload:p,provenance:{source:'github-issue',repository:'braydenparker999/jarvis',issue:2,
      commentId:comment.id,authorId:OWNER,publishedAt:comment.created_at}};
  }
  if(!p||p.schema!=='jarvis-publication-v1'||!uuid(p.id)||!['reply','briefing'].includes(p.type)||!nonempty(p.body,p.type==='briefing'?20000:6000)||!Number.isFinite(Date.parse(comment.created_at)))return null;
  if(p.type==='reply'&&!uuid(p.replyTo))return null;
  if(p.type==='briefing'&&(!nonempty(p.title,120)||typeof p.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.date)||!Number.isFinite(Date.parse(p.date))||new Date(p.date).toISOString().slice(0,10)!==p.date))return null;
  return {id:p.id,body:p.body.trim(),createdAt:comment.created_at,type:p.type,
    ...(p.type==='reply'?{replyTo:p.replyTo}:{title:p.title.trim(),date:p.date})};
}
async function boundedJson(response) {
  const reader=response.body?.getReader();if(!reader)throw Error('GitHub returned an empty response');
  let size=0;const chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2000000){await reader.cancel();throw Error('GitHub response exceeded the import limit');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
function legacyUpdate(p, commentId) {
  return {payload:{schema:'jarvis-publication-v1-update',eventId:p.id,requestId:p.replyTo,attemptId:p.id,stage:'final',
    body:p.body,artifacts:[],resultVersion:1},provenance:{source:'github-issue',repository:'braydenparker999/jarvis',issue:2,
    commentId,authorId:OWNER,publishedAt:p.createdAt,legacyConflict:true}};
}
export async function applyPendingPublications(ctx) {
  const sql=ctx.storage.sql,rows=(q,...args)=>[...sql.exec(q,...args)];
  // A bounded fixed-point pass resolves predecessors that arrived out of order.
  // Only successful writes remove pending work; unavailable originals/dependencies
  // remain durable and retryable, even during the normal GitHub cooldown.
  for(let round=0;round<8;round++) {
    let progressed=false;
    const after=Number(JSON.parse(rows("SELECT value FROM shared_meta WHERE key='publisher-pending-cursor'")[0]?.value||'0'));
    const page=rows('SELECT * FROM imported_comments WHERE imported=0 AND comment_id>? ORDER BY comment_id LIMIT 500',after);
    for(const item of page) {
      const p=JSON.parse(item.publication);
      const r=sharedStore(ctx,p.type==='coordination'?'/internal/shared/coordination':p.type==='reply'?'/internal/shared/reply':'/internal/shared/briefing',p);
      if(r.ok){sql.exec('UPDATE imported_comments SET imported=1,error=NULL WHERE comment_id=?',item.comment_id);progressed=true;}
      else if(r.status===409){
        if(p.type==='reply')sharedStore(ctx,'/internal/shared/coordination',legacyUpdate(p,item.comment_id));
        const failure=p.type==='coordination'?await r.json():null;
        sql.exec('UPDATE imported_comments SET imported=2,error=? WHERE comment_id=?',failure?.code||'Conflicting publication; original kept',item.comment_id);progressed=true;
      } else if(![404,425].includes(r.status))throw Error('Publication could not be saved');
    }
    sql.exec("INSERT OR REPLACE INTO shared_meta VALUES('publisher-pending-cursor',?)",JSON.stringify(page.length===500?page.at(-1).comment_id:0));
    if(!progressed&&page.length<500&&after===0)break;
  }
  // Recover already imported hidden v1 finals from the existing conflict journal.
  // The original reply and conflict diagnostics are kept; the new event is an
  // explicitly labelled later public report, not a rewrite or authority upgrade.
  for(const item of rows(`SELECT i.* FROM imported_comments i JOIN shared_entries u ON u.id=json_extract(i.publication,'$.replyTo') AND u.kind='user'
    WHERE imported=2 AND json_extract(i.publication,'$.type')='reply' AND NOT EXISTS(
    SELECT 1 FROM public_coordination_events e WHERE e.event_id=json_extract(i.publication,'$.id')) ORDER BY comment_id LIMIT 500`)) {
    const p=JSON.parse(item.publication);
    if(p.type==='reply')sharedStore(ctx,'/internal/shared/coordination',legacyUpdate(p,item.comment_id));
  }
}
export async function syncPublications(ctx,fetcher=fetch,now=Date.now()) {
  // Initialize schema through the same storage implementation used for reads.
  sharedStore(ctx,'/internal/shared/state');
  const sql=ctx.storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS imported_comments (comment_id INTEGER PRIMARY KEY, publication TEXT NOT NULL, imported INTEGER NOT NULL DEFAULT 0, error TEXT)');
  const rows=(q,...args)=>[...sql.exec(q,...args)];
  const get=key=>{const v=rows('SELECT value FROM shared_meta WHERE key=?',key)[0]?.value;return v?JSON.parse(v):null;};
  const put=(key,value)=>sql.exec('INSERT OR REPLACE INTO shared_meta VALUES(?,?)',key,JSON.stringify(value));
  try {
    await applyPendingPublications(ctx);
    if(now<Number(get('publisher-next-attempt')||0)){
      const status=get('publisher-status');
      if(status)put('publisher-status',{...status,pending:rows('SELECT COUNT(*) AS n FROM imported_comments WHERE imported=0')[0].n,conflicts:rows('SELECT COUNT(*) AS n FROM imported_comments WHERE imported=2')[0].n});
      return;
    }
    put('publisher-next-attempt',now+INTERVAL);
    const scan=get('publisher-scan')||{since:get('publisher-since')||null,page:1,newest:null};
    let complete=false;
    // Cap work per request; retain progress for a backlog larger than 300 comments.
    for(let pages=0;pages<3;pages++) {
      const url=new URL(COMMENTS_URL);url.searchParams.set('per_page','100');url.searchParams.set('page',String(scan.page));
      if(scan.since)url.searchParams.set('since',scan.since);
      const r=await fetcher(url.href,{headers:{Accept:'application/vnd.github+json','User-Agent':'Jarvis-publications','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(8000)});
      if(!r.ok){
        if(r.status===403||r.status===429){const reset=Number(r.headers.get('x-ratelimit-reset'))*1000,retry=Number(r.headers.get('retry-after'))*1000;put('publisher-next-attempt',Math.max(now+INTERVAL,Number.isFinite(reset)?reset+1000:0,Number.isFinite(retry)?now+retry:0));}
        throw Error('GitHub publication sync returned '+r.status);
      }
      const comments=await boundedJson(r);if(!Array.isArray(comments))throw Error('GitHub returned invalid publication data');
      ctx.storage.transactionSync(()=>{
        for(const comment of comments){
          if(Number.isFinite(Date.parse(comment.updated_at))&&(!scan.newest||comment.updated_at>scan.newest))scan.newest=comment.updated_at;
          const p=decodePublication(comment);
          if(p)sql.exec('INSERT OR IGNORE INTO imported_comments(comment_id,publication) VALUES(?,?)',comment.id,JSON.stringify(p));
        }
        scan.page++;
        if(comments.length<100){
          complete=true;
          if(scan.newest)put('publisher-since',new Date(Date.parse(scan.newest)-1000).toISOString());
          sql.exec("DELETE FROM shared_meta WHERE key='publisher-scan'");
        }else put('publisher-scan',scan);
      });
      await applyPendingPublications(ctx);if(complete)break;
    }
    const pending=rows('SELECT COUNT(*) AS n FROM imported_comments WHERE imported=0')[0].n;
    const conflicts=rows('SELECT COUNT(*) AS n FROM imported_comments WHERE imported=2')[0].n;
    put('publisher-status',{ok:true,lastAttempt:new Date(now).toISOString(),lastSuccessfulSync:new Date(now).toISOString(),catchingUp:!complete,pending,conflicts});
  } catch(e) {
    const previous=get('publisher-status')||{};
    put('publisher-status',{...previous,ok:false,lastAttempt:new Date(now).toISOString(),error:e.message||'Publication sync unavailable'});
    // A publication outage must not erase history or prevent public messaging.
  }
}
