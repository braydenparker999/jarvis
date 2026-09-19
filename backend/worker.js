const ALLOWED_ORIGIN = 'https://gray-meadow-09216fd10.1.azurestaticapps.net';
const paths = new Set(['/v1/state', '/v1/messages', '/v1/board']);
const json = (data, status=200) => Response.json(data, {status});
const publicState = state => ({messages:state.messages, posts:state.posts});
export default {
  async fetch(request, env) {
    const origin=request.headers.get('Origin');
    if(origin && origin!==ALLOWED_ORIGIN) return json({error:'Origin not allowed'},403);
    const headers={'Access-Control-Allow-Origin':ALLOWED_ORIGIN,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600','Vary':'Origin','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...headers,'Content-Type':'application/json'}});
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers});
    const path=new URL(request.url).pathname;
    if(path==='/health' && request.method==='GET') return reply({ok:true,mode:'delivery-receipts',version:2});
    if(!paths.has(path)) return reply({error:'Not found'},404);
    if((path==='/v1/state' && request.method!=='GET') || (path!=='/v1/state' && request.method!=='POST')) return reply({error:'Method not allowed'},405);
    const token=(request.headers.get('Authorization')||'').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if(!token) return reply({error:'Workspace key required'},401);
    let body;
    if(request.method==='POST') {
      if(!request.headers.get('Content-Type')?.startsWith('application/json')) return reply({error:'Expected JSON'},415);
      // Bound actual streamed bytes, not just a client-controlled length header.
      const reader=request.body?.getReader();
      if(!reader) return reply({error:'Body required'},400);
      const chunks=[];let length=0;
      while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>30000){await reader.cancel();return reply({error:'Body too large'},413);}chunks.push(value);}
      const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{return reply({error:'Invalid JSON'},400);}
      if(!body || typeof body.id!=='string' || !/^[a-f0-9-]{36}$/.test(body.id) || typeof body.body!=='string' || !body.body.trim() || body.body.length>(path==='/v1/messages'?4000:6000)) return reply({error:'Invalid entry'},400);
      if(path==='/v1/board' && (typeof body.title!=='string' || !body.title.trim() || body.title.length>120)) return reply({error:'Invalid title'},400);
    }
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
    const name=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
    const object=env.HUBS.get(env.HUBS.idFromName(name));
    try {
      const response=await object.fetch(new Request('https://internal'+path,{method:request.method,body:body?JSON.stringify(body):undefined}));
      return new Response(response.body,{status:response.status,headers:{...headers,'Content-Type':'application/json'}});
    } catch {return reply({error:'Storage unavailable; retry later'},503);}
  }
};
export class Hub {
  constructor(ctx){this.ctx=ctx;}
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(request.method==='GET')return json(publicState(await this.ctx.storage.get('state') || {messages:[],posts:[]}));
    const body=await request.json();
    return this.ctx.storage.transaction(async tx=>{
      const state=await tx.get('state') || {messages:[],posts:[],lastWrite:0};
      const existing=[...state.messages,...state.posts].find(x=>x.id===body.id);
      if(existing){
        if(existing.body!==body.body.trim() || (path==='/v1/board' && existing.title!==body.title.trim()) || (path==='/v1/messages' && existing.role!=='user'))return json({error:'Entry ID conflict'},409);
        return json(publicState(state));
      }
      const now=Date.now();
      const createdAt=new Date(now).toISOString();
      if(path==='/v1/messages')state.messages.push({id:body.id,role:'user',body:body.body.trim(),createdAt},{id:'receipt-'+body.id,role:'assistant',body:'Message received and saved. Cloud messaging is working. This is an automatic delivery receipt; AI replies are not connected yet.',createdAt});
      else state.posts.push({id:body.id,title:body.title.trim(),body:body.body.trim(),createdAt});
      state.lastWrite=now;
      if(new TextEncoder().encode(JSON.stringify(state)).length>100000)return json({error:'Workspace is full; export before adding more entries'},507);
      await tx.put('state',state);
      return json(publicState(state),201);
    });
  }
}
