import {sharedStore} from './shared.js';
import {decodeCoordination} from './public-coordination.js';
import {canonical} from './relay-common.js';
export const COMMENTS_URL='https://api.github.com/repos/braydenparker999/jarvis/issues/2/comments';
export const ISSUE_URL='https://api.github.com/repos/braydenparker999/jarvis/issues/2';
export const COMMENT_URL='https://api.github.com/repos/braydenparker999/jarvis/issues/comments/';
const OWNER=183016859, INTERVAL=300000;
const GITHUB_HEADERS={Accept:'application/vnd.github+json','User-Agent':'Jarvis-publications','X-GitHub-Api-Version':'2022-11-28'};
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
async function boundedJson(response,limit=2000000) {
  const reader=response.body?.getReader();if(!reader)throw Error('GitHub returned an empty response');
  let size=0;const chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('GitHub response exceeded the import limit');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function publicationSchema(ctx) {
  sharedStore(ctx,'/internal/shared/state');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS imported_comments (comment_id INTEGER PRIMARY KEY, publication TEXT NOT NULL, imported INTEGER NOT NULL DEFAULT 0, error TEXT)');
}
const meta=(ctx,key)=>JSON.parse([...ctx.storage.sql.exec('SELECT value FROM shared_meta WHERE key=?',key)][0]?.value||'null');
const putMeta=(ctx,key,value)=>ctx.storage.sql.exec('INSERT OR REPLACE INTO shared_meta VALUES(?,?)',key,JSON.stringify(value));
// Shared across all anonymous hints and normal reads, not per browser/IP. Hints
// cannot exhaust the reconciler's reserved maximum of 36 hourly requests.
export function takePublicationFetch(ctx,kind,now=Date.now()) {
  const upstream=Number(meta(ctx,'publisher-upstream-not-before')||0);
  if(now<upstream)return {ok:false,retryAt:upstream,reason:'github_backoff'};
  const hour=Math.floor(now/3600000),minute=Math.floor(now/60000);
  const stored=meta(ctx,'publisher-egress-budget');
  const budget=stored?.hour===hour?stored:{hour,total:0,hints:0,minute,burst:0};
  if(budget.minute!==minute){budget.minute=minute;budget.burst=0;}
  if(budget.total>=48||kind==='hint'&&budget.hints>=12)return {ok:false,retryAt:(hour+1)*3600000,reason:'egress_budget'};
  if(kind==='hint'&&budget.burst>=2)return {ok:false,retryAt:(minute+1)*60000,reason:'hint_burst'};
  budget.total++;if(kind==='hint'){budget.hints++;budget.burst++;}putMeta(ctx,'publisher-egress-budget',budget);
  return {ok:true};
}
export function publicationBackoff(ctx,response,now=Date.now()) {
  if(![403,429].includes(response.status)&&response.headers.get('x-ratelimit-remaining')!=='0')return;
  const reset=Number(response.headers.get('x-ratelimit-reset'))*1000;
  const retryText=response.headers.get('retry-after'),seconds=retryText===null?NaN:Number(retryText);
  const retry=Number.isFinite(seconds)?now+seconds*1000:Date.parse(retryText);
  const retryAt=Math.max(now+INTERVAL,Number.isFinite(reset)?reset+1000:0,Number.isFinite(retry)?retry:0);
  putMeta(ctx,'publisher-upstream-not-before',Math.max(Number(meta(ctx,'publisher-upstream-not-before')||0),retryAt));
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
        let failure=p.type==='coordination'?await r.json():null;
        if(p.type==='reply'){
          const update=sharedStore(ctx,'/internal/shared/coordination',legacyUpdate(p,item.comment_id));
          if(!update.ok)failure=await update.json();
        }
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
  publicationSchema(ctx);
  const sql=ctx.storage.sql;
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
      const permit=takePublicationFetch(ctx,'reconcile',now);if(!permit.ok)throw Error('GitHub publication sync waiting for '+permit.reason);
      const r=await fetcher(url.href,{headers:GITHUB_HEADERS,redirect:'manual',signal:AbortSignal.timeout(8000)});
      publicationBackoff(ctx,r,now);
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

function hintReceipt(ctx,commentId) {
  const item=[...ctx.storage.sql.exec('SELECT * FROM imported_comments WHERE comment_id=?',commentId)][0];
  if(!item)return null;
  const publication=JSON.parse(item.publication),id=publication.type==='coordination'?publication.payload.eventId:publication.id;
  const event=publication.type==='reply'&&item.imported===2?[...ctx.storage.sql.exec('SELECT request_id,payload,disposition,error_code FROM public_coordination_events WHERE event_id=?',id)][0]:null;
  const matches=event&&event.request_id===publication.replyTo&&event.payload===canonical(legacyUpdate(publication,commentId).payload);
  const update=matches&&event.disposition==='accepted';
  // Older rejected legacy rows kept only a generic conflict diagnostic. Their
  // durable event proves a precise ID/payload conflict without changing history.
  const errorCode=event&&!matches?'event_id_conflict':event?.error_code||item.error;
  return Response.json({commentId,publicationId:id,status:!item.imported?'pending':update?'update-imported':item.imported===1?'imported':'conflict',
    ...(item.imported===2&&!update?{errorCode}:{}),public_inbox:true,execution_authorized:false},
    {status:!item.imported?202:item.imported===2&&!update?409:200});
}
export async function importPublicationHint(ctx,input,fetcher=fetch,now=Date.now()) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Number.isSafeInteger(input.commentId)||input.commentId<1)
    return Response.json({error:'Expected only a positive numeric commentId'},{status:400});
  publicationSchema(ctx);
  const sql=ctx.storage.sql,commentId=input.commentId;
  await applyPendingPublications(ctx);
  const prior=hintReceipt(ctx,commentId);if(prior)return prior;
  sql.exec('CREATE TABLE IF NOT EXISTS public_import_hints (comment_id INTEGER PRIMARY KEY,status INTEGER NOT NULL,expires_ms INTEGER NOT NULL)');
  sql.exec('DELETE FROM public_import_hints WHERE expires_ms<=?',now);
  const cached=[...sql.exec('SELECT * FROM public_import_hints WHERE comment_id=?',commentId)][0];
  if(cached)return Response.json({commentId,status:cached.status===202?'fetching':'retry-later',retryAt:new Date(cached.expires_ms).toISOString()},
    {status:cached.status,headers:{'Retry-After':String(Math.max(1,Math.ceil((cached.expires_ms-now)/1000)))}});
  if([...sql.exec('SELECT COUNT(*) AS n FROM public_import_hints')][0].n>=128)return Response.json({error:'Hint cache busy; use the existing reconciler'},{status:429});
  const permit=takePublicationFetch(ctx,'hint',now);
  if(!permit.ok)return Response.json({error:'Import hint rate limited; the existing reconciler is retained',reason:permit.reason,retryAt:new Date(permit.retryAt).toISOString()},
    {status:429,headers:{'Retry-After':String(Math.max(1,Math.ceil((permit.retryAt-now)/1000)))}});
  // Durable short reservation suppresses concurrent retries and bounds egress
  // after a process loss. No caller URLs, headers, secrets or identities survive.
  sql.exec('INSERT INTO public_import_hints VALUES(?,202,?)',commentId,now+10000);
  try {
    const response=await fetcher(COMMENT_URL+commentId,{headers:GITHUB_HEADERS,redirect:'manual',signal:AbortSignal.timeout(3500)});
    publicationBackoff(ctx,response,now);
    if(!response.ok){
      const status=[403,429].includes(response.status)?429:response.status===404?422:503;
      sql.exec('UPDATE public_import_hints SET status=?,expires_ms=? WHERE comment_id=?',status,now+INTERVAL,commentId);
      return Response.json({error:'GitHub comment could not be validated; use the existing reconciler'},{status});
    }
    const comment=await boundedJson(response,131072);
    // The GET path selects a repository, not an issue. Check independently
    // returned issue_url and numeric ID before trusting owner/schema decoding.
    const publication=comment?.id===commentId&&comment.issue_url===ISSUE_URL?decodePublication(comment):null;
    if(!publication){sql.exec('UPDATE public_import_hints SET status=422,expires_ms=? WHERE comment_id=?',now+INTERVAL,commentId);
      return Response.json({error:'Comment is not a valid publication in the fixed issue'},{status:422});}
    sql.exec('INSERT OR IGNORE INTO imported_comments(comment_id,publication) VALUES(?,?)',commentId,JSON.stringify(publication));
    await applyPendingPublications(ctx);
    sql.exec('DELETE FROM public_import_hints WHERE comment_id=?',commentId);
    return hintReceipt(ctx,commentId);
  } catch {
    sql.exec('UPDATE public_import_hints SET status=503,expires_ms=? WHERE comment_id=?',now+INTERVAL,commentId);
    return Response.json({error:'Import hint unavailable; the existing reconciler is retained'},{status:503});
  }
}
