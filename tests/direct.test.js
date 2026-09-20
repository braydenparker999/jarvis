import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker,{Hub} from '../backend/worker.js';
import {PUBLIC_KEY} from '../backend/shared.js';
import {createDirectApi} from '../public/assets/direct-api.js';
const BASE='https://jarvis-hub-api.braydenparker999.workers.dev';
const SITE='https://gray-meadow-09216fd10.1.azurestaticapps.net';
const CALLBACK='https://chatgpt.com/connector_platform_oauth_redirect';
function setup() {
  const objects=new Map();
  const env={GITHUB_CLIENT_ID:'test-client',GITHUB_CLIENT_SECRET:'test-secret',HUBS:{idFromName:n=>n,get(name){
    if(!objects.has(name)){
      const db=new DatabaseSync(':memory:'),kv=new Map();let queue=Promise.resolve();
      const storage={sql:{exec(q,...v){const stmt=db.prepare(q);if(stmt.columns().length)return stmt.all(...v);stmt.run(...v);return [];}},
        async get(k){return structuredClone(kv.get(k));},async put(k,v){kv.set(k,structuredClone(v));},
        transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},
        transaction(fn){const next=queue.then(()=>fn(storage));queue=next.catch(()=>{});return next;}};
      objects.set(name,new Hub({storage}));
    }return objects.get(name);
  }}};
  const fetcher=(url,opts)=>worker.fetch(new Request(url,opts),env);
  const req=(path,body,headers={})=>fetcher(BASE+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},body:body?typeof body==='string'?body:JSON.stringify(body):undefined});
  const api=createDirectApi(fetcher,BASE);return {env,req,api};
}
async function authorize(s,{owner=183016859,wrongCookie=false}={}) {
  const client=await (await s.req('/oauth/register',{redirect_uris:[CALLBACK],token_endpoint_auth_method:'none'})).json();
  const verifier='x'.repeat(43),challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  const p={client_id:client.client_id,redirect_uri:CALLBACK,resource:BASE+'/mcp',response_type:'code',code_challenge_method:'S256',code_challenge:challenge,state:'chatgpt-state',scope:'inbox:read replies:write briefings:write'};
  const consent=await s.req('/oauth/authorize?'+new URLSearchParams(p));assert.equal(consent.status,200);
  const cookie=consent.headers.get('Set-Cookie').split(';')[0],session=cookie.split('=')[1];
  const start=await s.req('/oauth/start',new URLSearchParams({consent:session}).toString(),{Origin:BASE,Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'});assert.equal(start.status,302);
  const gh=new URL(start.headers.get('Location'));assert.equal(gh.origin,'https://github.com');assert.equal(gh.searchParams.get('scope'),'');assert.equal(gh.searchParams.get('code_challenge_method'),'S256');
  const original=globalThis.fetch;let upstreamCalls=0;
  globalThis.fetch=async(url,options)=>{
    upstreamCalls++;
    if(url==='https://github.com/login/oauth/access_token'){
      assert.equal(new URLSearchParams(options.body).get('client_secret'),'test-secret');
      return Response.json({access_token:'github-token-test'});
    }
    assert.equal(url,'https://api.github.com/user');return Response.json({id:owner});
  };
  let callback;try{callback=await s.req('/oauth/github/callback?'+new URLSearchParams({code:'github-code',state:gh.searchParams.get('state')}),null,{Cookie:wrongCookie?'__Host-jarvis_oauth='+'z'.repeat(64):cookie});}finally{globalThis.fetch=original;}
  if(owner!==183016859||wrongCookie)return {response:callback,upstreamCalls};
  assert.equal(callback.status,302);const redirect=new URL(callback.headers.get('Location'));
  assert.equal(redirect.origin+redirect.pathname,CALLBACK);assert.equal(redirect.searchParams.get('state'),p.state);
  const exchange={grant_type:'authorization_code',client_id:p.client_id,redirect_uri:CALLBACK,resource:BASE+'/mcp',code:redirect.searchParams.get('code'),code_verifier:verifier};
  assert.equal((await s.req('/oauth/token',new URLSearchParams({...exchange,code_verifier:'y'.repeat(43)}).toString())).status,400);
  const r=await s.req('/oauth/token',new URLSearchParams(exchange).toString());assert.equal(r.status,200);
  assert.equal((await s.req('/oauth/token',new URLSearchParams(exchange).toString())).status,400);
  return {tokens:await r.json(),clientId:p.client_id};
}
const rpc=(s,token,name,args={})=>s.req('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{Authorization:'Bearer '+token});
test('direct shared inbox persists across clients and public users cannot forge replies or briefings',async()=>{
  const s=setup(),m={id:crypto.randomUUID(),body:'Hello',role:'assistant',kind:'reply',replyTo:crypto.randomUUID()};
  assert.equal((await s.req('/shared/messages',m)).status,201);
  assert.equal((await s.req('/shared/messages',m)).status,200);
  const state=await s.api('/shared/state');assert.equal(state.messages.length,1);assert.equal(state.messages[0].role,'user');assert.equal(state.messages[0].replyTo,undefined);
  assert.equal((await s.req('/shared/replies',m)).status,404);
  assert.equal((await s.req('/internal/shared/reply',m)).status,404);
  assert.equal((await s.req('/shared/messages',{...m,body:'changed'})).status,409);
  assert.equal((await s.req('/shared/messages',{...m,id:crypto.randomUUID(),body:'x'.repeat(25000)})).status,413);
  assert.equal((await s.req('/shared/state?after=-1')).status,400);
});
test('migration preserves old users and ignores forged legacy assistant and board entries',async()=>{
  const s=setup(),headers={Authorization:'Bearer '+PUBLIC_KEY};
  const m={id:crypto.randomUUID(),body:'Old phone'};
  await s.req('/v1/messages',m,headers);await s.req('/v1/board',{id:crypto.randomUUID(),title:'Spoofed',body:'Bad'},headers);
  const legacy=await (await s.req('/v1/responder/connect',{},headers)).json();
  await s.req('/v1/agent/replies',{id:crypto.randomUUID(),replyTo:m.id,body:'Forged assistant'},{Authorization:'Bearer '+legacy.token});
  let data=await s.api('/shared/state');assert.equal(data.messages.length,1);assert.equal(data.unanswered.length,1);assert.equal(data.posts.some(p=>p.title==='Spoofed'),false);
  data=await s.api('/shared/state');assert.equal(data.messages.length,1);
  assert.equal((await s.req('/mcp',null,{Authorization:'Bearer '+legacy.token})).status,401);
  assert.equal((await s.req('/oauth/approve',{},{Authorization:'Bearer '+PUBLIC_KEY,Origin:SITE})).status,410);
});
test('owner OAuth reads shared messages, publishes once, refreshes tokens and revokes access',async()=>{
  const s=setup(),m={id:crypto.randomUUID(),body:'Can you see this?'};await s.api('/shared/messages',m);
  const {tokens,clientId}=await authorize(s);
  const inbox=await (await rpc(s,tokens.access_token,'jarvis_read_inbox')).json();const data=JSON.parse(inbox.result.content[0].text);
  assert.equal(data.unanswered[0].id,m.id);assert.ok(data.lastSuccessfulCheck);
  const reply={replyTo:m.id,body:'Yes, directly.'};
  for(let i=0;i<2;i++)assert.equal((await (await rpc(s,tokens.access_token,'jarvis_reply',reply)).json()).result.isError,false);
  assert.equal((await (await rpc(s,tokens.access_token,'jarvis_reply',{...reply,body:'Conflict'})).json()).result.isError,true);
  const briefing={id:crypto.randomUUID(),title:'Daily briefing — 2026-09-20',body:'The connection test passed locally.'};
  for(let i=0;i<2;i++)assert.equal((await (await rpc(s,tokens.access_token,'jarvis_publish_briefing',briefing)).json()).result.isError,false);
  const state=await s.api('/shared/state');assert.equal(state.messages.filter(m=>m.kind==='reply').length,1);assert.equal(state.unanswered.length,0);assert.equal(state.posts.filter(p=>p.id===briefing.id).length,1);
  const form={grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:clientId,resource:BASE+'/mcp'};
  const refreshed=await (await s.req('/oauth/token',new URLSearchParams(form).toString())).json();assert.ok(refreshed.access_token);
  assert.equal((await s.req('/oauth/token',new URLSearchParams(form).toString())).status,400);
  assert.equal((await rpc(s,tokens.access_token,'jarvis_read_inbox')).status,401);
  assert.equal((await rpc(s,refreshed.access_token,'jarvis_read_inbox')).status,200);
  await s.req('/oauth/revoke',new URLSearchParams({client_id:clientId,token:refreshed.refresh_token}).toString());
  assert.equal((await rpc(s,refreshed.access_token,'jarvis_read_inbox')).status,401);
});
test('owner authorization rejects another GitHub account and mismatched browser state',async()=>{
  assert.equal((await authorize(setup(),{owner:123})).response.status,403);
  const rejected=await authorize(setup(),{wrongCookie:true});assert.equal(rejected.response.status,400);assert.equal(rejected.upstreamCalls,0);
  const s=setup();delete s.env.GITHUB_CLIENT_SECRET;assert.equal((await s.req('/oauth/authorize')).status,503);
});
test('SQL storage exceeds old 100KB cap, paginates without gaps, and bounds daily public writes',async()=>{
  const s=setup();
  for(let i=0;i<200;i++)assert.equal((await s.req('/shared/messages',{id:crypto.randomUUID(),body:String(i)+'x'.repeat(1500)})).status,201);
  assert.equal((await s.req('/shared/messages',{id:crypto.randomUUID(),body:'Over limit'})).status,429);
  const {tokens}=await authorize(s);
  const first=await (await rpc(s,tokens.access_token,'jarvis_read_inbox')).json();const pending=JSON.parse(first.result.content[0].text);assert.equal(pending.unanswered.length,100);assert.equal(pending.moreUnanswered,true);
  assert.equal((await (await rpc(s,tokens.access_token,'jarvis_reply',{replyTo:pending.unanswered[0].id,body:'Reply creates page two'})).json()).result.isError,false);
  const page=await (await s.req('/shared/state')).json();assert.ok(page.nextCursor);
  const full=await s.api('/shared/state');assert.equal(full.messages.length,201);assert.equal(new Set(full.messages.map(m=>m.id)).size,201);
  assert.equal(full.unanswered.length,199);
});
