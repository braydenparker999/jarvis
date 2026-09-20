const SITE='https://gray-meadow-09216fd10.1.azurestaticapps.net';
const FEED='https://raw.githubusercontent.com/braydenparker999/jarvis/main/content/jarvis.json';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const text=(x,max)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
const stamp=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const empty=()=>({messages:[],posts:[]});
const sizeOk=state=>new TextEncoder().encode(JSON.stringify(state)).length<=512000;
async function readJson(request,max=30000){
 const reader=request.body?.getReader();if(!reader)throw Error('Body required');
 let size=0;const chunks=[];
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw Error('Body too large');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
export async function sharedRoutes(request,env){
 const path=new URL(request.url).pathname;if(!path.startsWith('/shared/'))return null;
 const headers={'Access-Control-Allow-Origin':SITE,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
 const wrap=r=>new Response(r.body,{status:r.status,headers:{...headers,'Content-Type':'application/json'}});
 const origin=request.headers.get('Origin');if(origin&&origin!==SITE)return wrap(json({error:'Origin not allowed'},403));
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
 const hub=env.HUBS.get(env.HUBS.idFromName('jarvis-shared-v1'));
 try{
  if(path==='/shared/health'&&request.method==='GET')return wrap(json({ok:true,version:5,mode:'one-shared-inbox'}));
  if(path==='/shared/state'&&request.method==='GET')return wrap(await hub.fetch(new Request('https://internal/internal/shared/state')));
  if(path==='/shared/messages'&&request.method==='POST'){
   if(!request.headers.get('Content-Type')?.startsWith('application/json'))return wrap(json({error:'Expected JSON'},415));
   const b=await readJson(request);
   if(!b||!uuid(b.id)||!text(b.body,4000))return wrap(json({error:'Message must contain text, up to 4000 characters.'},400));
   return wrap(await hub.fetch(new Request('https://internal/internal/shared/message',{method:'POST',body:JSON.stringify({id:b.id,body:b.body.trim()})})));
  }
  if(path==='/shared/migrate'&&request.method==='POST'){
   // Read the old inbox only with its existing credential. Copy user messages;
   // keep the original inbox and its other data intact for recovery.
   const key=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
   if(!key)return wrap(json({error:'Existing inbox credential required'},401));
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),x=>x.toString(16).padStart(2,'0')).join('');
   const old=env.HUBS.get(env.HUBS.idFromName(hash));
   const response=await old.fetch(new Request('https://internal/v1/state'));if(!response.ok)return wrap(json({error:'Previous messages are still saved. Try again later.'},503));
   const data=await response.json();
   const messages=(data.messages||[]).filter(m=>m.role==='user'&&uuid(m.id)&&text(m.body,4000)&&stamp(m.createdAt)).map(({id,body,createdAt})=>({id,body,createdAt,role:'user'}));
   return wrap(await hub.fetch(new Request('https://internal/internal/shared/import',{method:'POST',body:JSON.stringify({messages})})));
  }
  return wrap(json({error:'Not found'},404));
 }catch(e){return wrap(json({error:e.message==='Body too large'?'Message too large':'Could not save or load messages. Please retry.'},e.message==='Body too large'?413:503));}
}
export class SharedInbox{
 constructor(ctx,fetcher=fetch){this.ctx=ctx;this.fetcher=fetcher;this.refreshing=null;}
 async refreshPublisher(){
  if(this.refreshing)return this.refreshing;
  this.refreshing=this.refreshOnce();try{await this.refreshing;}finally{this.refreshing=null;}
 }
 async refreshOnce(){
  const meta=await this.ctx.storage.get('publisher')||{};
  if(meta.checkedAt&&Date.now()-meta.checkedAt<15000)return;
  try{
   // Only repository-authenticated changes can publish assistant content.
   // No public write endpoint accepts a reply, briefing or alternate feed URL.
   const r=await this.fetcher(FEED+'?refresh='+Date.now(),{headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000),cf:{cacheTtl:0}});
   if(!r.ok)throw Error('Feed unavailable');
   const feed=await readJson(r,512000);
   if(feed.version!==1||!Array.isArray(feed.replies)||!Array.isArray(feed.posts)||feed.replies.length>1000||feed.posts.length>365)throw Error('Invalid feed');
   if(feed.replies.some(x=>!uuid(x.id)||!uuid(x.replyTo)||!text(x.body,6000)||!stamp(x.createdAt))||feed.posts.some(x=>!uuid(x.id)||!text(x.title,120)||!text(x.body,6000)||!stamp(x.createdAt)))throw Error('Invalid feed');
   await this.ctx.storage.transaction(async tx=>{
    const state=await tx.get('shared')||empty();
    for(const r of feed.replies){
     if(!state.messages.some(m=>m.role==='user'&&m.id===r.replyTo))continue;
     if(state.messages.some(m=>m.id===r.id||m.kind==='reply'&&m.replyTo===r.replyTo))continue;
     state.messages.push({id:r.id,replyTo:r.replyTo,body:r.body.trim(),createdAt:r.createdAt,role:'assistant',kind:'reply'});
    }
    for(const p of feed.posts)if(!state.posts.some(x=>x.id===p.id))state.posts.push({id:p.id,title:p.title.trim(),body:p.body.trim(),createdAt:p.createdAt});
    state.messages.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));state.posts.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    if(!sizeOk(state))throw Error('Inbox full');
    await tx.put('shared',state);await tx.put('publisher',{ok:true,checkedAt:Date.now(),lastSuccessAt:Date.now()});
   });
  }catch{await this.ctx.storage.put('publisher',{...meta,ok:false,checkedAt:Date.now()});}
 }
 async snapshot(status=200){
  const state=await this.ctx.storage.get('shared')||empty(),publisher=await this.ctx.storage.get('publisher')||{};
  const replied=new Set(state.messages.filter(m=>m.kind==='reply').map(m=>m.replyTo));
  return json({...state,unanswered:state.messages.filter(m=>m.role==='user'&&!replied.has(m.id)),publisher,mode:'one-shared-inbox'},status);
 }
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/internal/shared/state'){await this.refreshPublisher();return this.snapshot();}
  const b=await request.json();
  const result=await this.ctx.storage.transaction(async tx=>{
   const state=await tx.get('shared')||empty();
   if(path==='/internal/shared/import'){
    for(const m of b.messages)if(!state.messages.some(x=>x.id===m.id))state.messages.push(m);
    state.messages.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
   }else if(path==='/internal/shared/message'){
    const prior=state.messages.find(m=>m.id===b.id);
    if(prior)return prior.role==='user'&&prior.body===b.body?200:409;
    const rate=await tx.get('rate')||{start:0,count:0};
    if(Date.now()-rate.start>60000){rate.start=Date.now();rate.count=0;}
    if(rate.count>=12)return 429;
    rate.count++;await tx.put('rate',rate);
    state.messages.push({id:b.id,body:b.body,createdAt:new Date().toISOString(),role:'user'});
   }else return 404;
   if(!sizeOk(state))return 507;
   await tx.put('shared',state);return 201;
  });
  if(result>=400)return json({error:result===429?'Too many messages. Wait a minute and retry.':result===507?'Inbox storage is full. Your draft is still on this device.':'Message ID conflict'},result);
  return this.snapshot(result);
 }
}
