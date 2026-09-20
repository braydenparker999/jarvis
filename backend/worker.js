import {sharedRoutes,SharedInbox} from './shared.js';
import {connector,oauthStore} from './connector.js';
const ALLOWED_ORIGIN = 'https://gray-meadow-09216fd10.1.azurestaticapps.net';
const paths = new Set(['/v1/state', '/v1/messages', '/v1/board', '/v1/responder/connect', '/v1/responder/revoke', '/v1/agent/inbox', '/v1/agent/replies', '/v1/agent/board']);
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
const json = (data, status=200) => Response.json(data, {status});
const publicState = state => ({messages:state.messages, posts:state.posts});
const unanswered = state => state.messages.filter(m=>m.role==='user' && !state.messages.some(r=>r.kind==='reply' && r.replyTo===m.id));
export default {
  async fetch(request, env) {
    const shared=await sharedRoutes(request,env);if(shared)return shared;
    const connected=await connector(request,env);if(connected)return connected;
    const origin=request.headers.get('Origin');
    if(origin && origin!==ALLOWED_ORIGIN) return json({error:'Origin not allowed'},403);
    const headers={'Access-Control-Allow-Origin':ALLOWED_ORIGIN,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600','Vary':'Origin','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...headers,'Content-Type':'application/json'}});
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers});
    const path=new URL(request.url).pathname;
    if(path==='/health' && request.method==='GET') return reply({ok:true,mode:'connector-ready',version:4});
    if(!paths.has(path)) return reply({error:'Not found'},404);
    const readPath=path==='/v1/state' || path==='/v1/agent/inbox';
    if((readPath && request.method!=='GET') || (!readPath && request.method!=='POST')) return reply({error:'Method not allowed'},405);
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
      if(!path.startsWith('/v1/responder/')) {
      if(!body || typeof body.id!=='string' || !/^[a-f0-9-]{36}$/.test(body.id) || typeof body.body!=='string' || !body.body.trim() || body.body.length>(path==='/v1/messages'?4000:6000)) return reply({error:'Invalid entry'},400);
      if((path==='/v1/board' || path==='/v1/agent/board') && (typeof body.title!=='string' || !body.title.trim() || body.title.length>120)) return reply({error:'Invalid title'},400);
      if(path==='/v1/agent/replies' && (typeof body.replyTo!=='string' || !/^[a-f0-9-]{36}$/.test(body.replyTo))) return reply({error:'Reply target required'},400);
      }
    }
    const name=await digest(token);
    const object=n=>env.HUBS.get(env.HUBS.idFromName(n));
    const internal=(n,p,data,headers={})=>object(n).fetch(new Request('https://internal'+p,{method:data?'POST':'GET',headers,body:data?JSON.stringify(data):undefined}));
    try {
      let response;
      if(path==='/v1/responder/connect') {
        // Separate responder credential; never hand the browser's owner key to an agent.
        const responderToken=randomKey(), responderHash=await digest(responderToken);
        const expiresAt=null;
        await internal('responder:'+responderHash,'/internal/register',{workspace:name,expiresAt});
        await internal(name,'/internal/authorize',{hash:responderHash,expiresAt});
        return reply({token:responderToken,expiresAt});
      } else if(path==='/v1/responder/revoke') {
        response=await internal(name,'/internal/authorize',{hash:null,expiresAt:0});
      } else if(path.startsWith('/v1/agent/')) {
        const access=await (await internal('responder:'+name,'/internal/access')).json();
        if(!access.workspace || (access.expiresAt!==null && access.expiresAt<=Date.now())) return reply({error:'Responder connection expired or invalid'},401);
        response=await internal(access.workspace,path,body,{'X-Responder-Hash':name});
      } else response=await internal(name,path,body);
      return new Response(response.body,{status:response.status,headers:{...headers,'Content-Type':'application/json'}});
    } catch {return reply({error:'Storage unavailable; retry later'},503);}
  }
};
export class Hub {
  constructor(ctx){this.ctx=ctx;this.shared=new SharedInbox(ctx);}
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path.startsWith('/internal/shared/'))return this.shared.fetch(request);
    if(path==='/internal/oauth-store')return oauthStore(this.ctx.storage,await request.json());
    if(path==='/internal/register'){await this.ctx.storage.put('access',await request.json());return json({ok:true});}
    if(path==='/internal/access')return json(await this.ctx.storage.get('access') || {});
    if(path==='/internal/authorize'){await this.ctx.storage.put('responder',await request.json());return json({ok:true});}
    if(path.startsWith('/v1/agent/')) {
      const access=await this.ctx.storage.get('responder');
      if(!access || (access.expiresAt!==null && access.expiresAt<=Date.now()) || access.hash!==request.headers.get('X-Responder-Hash'))return json({error:'Responder disconnected'},401);
    }
    if(request.method==='GET'){
      const state=await this.ctx.storage.get('state') || {messages:[],posts:[]};
      return json(path==='/v1/agent/inbox'?{...publicState(state),unanswered:unanswered(state)}:publicState(state));
    }
    const body=await request.json();
    return this.ctx.storage.transaction(async tx=>{
      const state=await tx.get('state') || {messages:[],posts:[],lastWrite:0};
      // Repeat checks inside the write transaction so revocation cannot race a reply.
      if(path.startsWith('/v1/agent/')) {
        const access=await tx.get('responder');
        if(!access || (access.expiresAt!==null && access.expiresAt<=Date.now()) || access.hash!==request.headers.get('X-Responder-Hash'))return json({error:'Responder disconnected'},401);
      }
      if(path==='/v1/agent/replies') {
        if(!state.messages.some(m=>m.id===body.replyTo && m.role==='user'))return json({error:'Original message not found'},404);
        const prior=state.messages.find(m=>m.kind==='reply' && m.replyTo===body.replyTo);
        if(prior)return prior.body===body.body.trim()?json(publicState(state)):json({error:'Message already answered'},409);
      }
      const existing=[...state.messages,...state.posts].find(x=>x.id===body.id);
      if(existing){
        if(existing.body!==body.body.trim() || ((path==='/v1/board' || path==='/v1/agent/board') && existing.title!==body.title.trim()) || (path==='/v1/messages' && existing.role!=='user') || (path==='/v1/agent/replies' && (existing.kind!=='reply' || existing.replyTo!==body.replyTo)))return json({error:'Entry ID conflict'},409);
        return json(publicState(state));
      }
      const now=Date.now();
      const createdAt=new Date(now).toISOString();
      if(path==='/v1/messages')state.messages.push({id:body.id,role:'user',body:body.body.trim(),createdAt},{id:'receipt-'+body.id,role:'assistant',kind:'receipt',body:'Message received and saved. This is an automatic delivery receipt, not a Jarvis reply.',createdAt});
      else if(path==='/v1/agent/replies')state.messages.push({id:body.id,role:'assistant',kind:'reply',replyTo:body.replyTo,body:body.body.trim(),createdAt});
      else state.posts.push({id:body.id,title:body.title.trim(),body:body.body.trim(),createdAt});
      state.lastWrite=now;
      if(new TextEncoder().encode(JSON.stringify(state)).length>100000)return json({error:'Workspace is full; export before adding more entries'},507);
      await tx.put('state',state);
      return json(publicState(state),201);
    });
  }
}
