import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{Hub} from '../backend/worker.js';
import {emptyState,mergeState,readState,STORAGE_KEY} from '../public/assets/store.js';
function env(){
 const objects=new Map();
 return {HUBS:{idFromName:n=>n,get(id){if(!objects.has(id)){
   const values=new Map();
   const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){values.set(k,structuredClone(v));},async transaction(fn){return fn(storage);}};
   objects.set(id,new Hub({storage}));
 }return objects.get(id);}}};
}
const key='a'.repeat(64);
const call=(environment,path,body,token=key)=>worker.fetch(new Request('https://api.example'+path,{method:body?'POST':'GET',headers:{Origin:'https://gray-meadow-09216fd10.1.azurestaticapps.net',Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),environment);
test('message survives fresh read and retry creates exactly one receipt',async()=>{
 const e=env(),body={id:crypto.randomUUID(),body:'Phone connection test'};
 assert.equal((await call(e,'/v1/messages',body)).status,201);
 const retry=await call(e,'/v1/messages',body);assert.equal(retry.status,200);
 const data=await (await call(e,'/v1/state')).json();assert.equal(data.messages.length,2);assert.equal(data.messages[0].body,body.body);assert.match(data.messages[1].body,/automatic delivery receipt/);
 assert.equal((await call(e,'/v1/messages',{...body,body:'changed'})).status,409);
});
test('workspace keys isolate data',async()=>{
 const e=env();await call(e,'/v1/board',{id:crypto.randomUUID(),title:'Today',body:'Private workspace note'});
 assert.equal((await (await call(e,'/v1/state',null,'b'.repeat(64))).json()).posts.length,0);
 assert.equal((await (await call(e,'/v1/state')).json()).posts.length,1);
});
test('rejects untrusted origin, invalid key, oversize body, invalid fields',async()=>{
 const e=env();
 assert.equal((await worker.fetch(new Request('https://api.example/v1/state',{headers:{Origin:'https://evil.example'}}),e)).status,403);
 assert.equal((await call(e,'/v1/state',null,'bad')).status,401);
 assert.equal((await call(e,'/v1/messages',{id:crypto.randomUUID(),body:'x'.repeat(31000)})).status,413);
 assert.equal((await call(e,'/v1/board',{id:crypto.randomUUID(),title:'',body:'note'})).status,400);
});
test('merge keeps pending drafts and deduplicates accepted messages',()=>{
 const s=emptyState();s.messages=[{id:'local',createdAt:'2026-01-01',body:'draft'},{id:'saved',createdAt:'2026-01-02',body:'sent'}];s.outbox=[{id:'local'}];
 const merged=mergeState(s,{messages:[{id:'saved',createdAt:'2026-01-02',body:'sent'}],posts:[]});
 assert.equal(merged.messages.length,2);assert.equal(merged.messages[1].saved,true);assert.equal(merged.messages[0].body,'draft');
});
test('malformed saved data is not silently overwritten',()=>{
 const store={getItem:k=>k===STORAGE_KEY?'{"version":99}':null};
 assert.throws(()=>readState(store));
});
test('responder reads correct inbox, replies once, and removes answered message from pending',async()=>{
 const e=env(),message={id:crypto.randomUUID(),body:'Can you hear me?'};
 await call(e,'/v1/messages',message);
 const access=await (await call(e,'/v1/responder/connect',{})).json();
 assert.match(access.token,/^[a-f0-9]{64}$/);assert.notEqual(access.token,key);
 let inbox=await (await call(e,'/v1/agent/inbox',null,access.token)).json();
 assert.equal(inbox.unanswered.length,1);assert.equal(inbox.unanswered[0].id,message.id);
 assert.equal((await call(e,'/v1/agent/inbox',null,key)).status,401);
 const reply={id:crypto.randomUUID(),replyTo:message.id,body:'Yes, I can read your message.'};
 assert.equal((await call(e,'/v1/agent/replies',reply,access.token)).status,201);
 assert.equal((await call(e,'/v1/agent/replies',{...reply,id:crypto.randomUUID()},access.token)).status,200);
 assert.equal((await call(e,'/v1/agent/replies',{...reply,body:'different'},access.token)).status,409);
 inbox=await (await call(e,'/v1/agent/inbox',null,access.token)).json();
 assert.equal(inbox.unanswered.length,0);assert.equal(inbox.messages.filter(m=>m.kind==='reply').length,1);
 assert.equal((await (await call(e,'/v1/state')).json()).messages.at(-1).body,reply.body);
});
test('responder connections rotate, revoke, isolate workspaces and reject invalid reply targets',async()=>{
 const e=env();
 const first=await (await call(e,'/v1/responder/connect',{})).json();
 const second=await (await call(e,'/v1/responder/connect',{})).json();
 assert.equal((await call(e,'/v1/agent/inbox',null,first.token)).status,401);
 assert.equal((await call(e,'/v1/agent/replies',{id:crypto.randomUUID(),replyTo:crypto.randomUUID(),body:'orphan'},second.token)).status,404);
 const other=await (await call(e,'/v1/responder/connect',{},'b'.repeat(64))).json();
 await call(e,'/v1/messages',{id:crypto.randomUUID(),body:'owner message'});
 assert.equal((await (await call(e,'/v1/agent/inbox',null,other.token)).json()).messages.length,0);
 await call(e,'/v1/responder/revoke',{});
 assert.equal((await call(e,'/v1/agent/inbox',null,second.token)).status,401);
 assert.equal((await call(e,'/v1/agent/inbox',null,other.token)).status,200);
});

test('ongoing responder publishes briefings and revocation blocks publishing',async()=>{
 const e=env(),access=await (await call(e,'/v1/responder/connect',{})).json();
 assert.equal(access.expiresAt,null);
 const post={id:crypto.randomUUID(),title:'Daily briefing',body:'Your hub update.'};
 assert.equal((await call(e,'/v1/agent/board',post,access.token)).status,201);
 assert.equal((await call(e,'/v1/agent/board',post,access.token)).status,200);
 const state=await (await call(e,'/v1/state')).json();
 assert.equal(state.posts.length,1);assert.equal(state.posts[0].title,post.title);
 await call(e,'/v1/responder/revoke',{});
 assert.equal((await call(e,'/v1/agent/board',{...post,id:crypto.randomUUID()},access.token)).status,401);
});
