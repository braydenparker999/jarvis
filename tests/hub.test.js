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
