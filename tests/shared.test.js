import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{Hub} from '../backend/worker.js';
import {SharedInbox} from '../backend/shared.js';
import {readState,mergeState,LEGACY_KEY,STORAGE_KEY} from '../public/assets/shared-store.js';
function setup(){
 const objects=new Map(),stores=new Map();let feed={version:1,replies:[],posts:[]},fail=false;
 const env={HUBS:{idFromName:n=>n,get(id){if(!objects.has(id)){
 const values=new Map(),storage={async get(k){return structuredClone(values.get(k));},async put(k,v){values.set(k,structuredClone(v));},async transaction(fn){return fn(storage);}};
 const hub=new Hub({storage});hub.shared=new SharedInbox({storage},async url=>{assert.match(url,/^https:\/\/raw.githubusercontent.com\/braydenparker999\/jarvis\/main\/content\/jarvis.json\?/);if(fail)throw Error('offline');return Response.json(feed);});objects.set(id,hub);stores.set(id,storage);
 }return objects.get(id);}}};
 const call=(path,body,headers={})=>worker.fetch(new Request('https://api.example'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined}),env);
 return {call,feed,setFail(){fail=true;},async refresh(){await stores.get('jarvis-shared-v1').put('publisher',{});}};
}
test('public clients share persisted inbox; retries deduplicate; visitors cannot publish as Jarvis',async()=>{
 const s=setup(),id=crypto.randomUUID();
 assert.equal((await s.call('/shared/messages',{id,body:'Hello',role:'assistant',kind:'reply',replyTo:id})).status,201);
 assert.equal((await s.call('/shared/messages',{id,body:'Hello'})).status,200);
 const state=await (await s.call('/shared/state')).json();assert.equal(state.messages.length,1);assert.equal(state.messages[0].role,'user');assert.equal(state.messages[0].kind,undefined);assert.equal(state.unanswered.length,1);
 assert.equal((await s.call('/shared/replies',{id,body:'Fake'})).status,404);
 assert.equal((await s.call('/shared/board',{id,title:'Fake',body:'Fake'})).status,404);
 assert.equal((await s.call('/shared/state',null,{Origin:'https://evil.example'})).status,403);
});
test('trusted publisher replies and briefings appear once; outages preserve data',async()=>{
 const s=setup(),id=crypto.randomUUID(),createdAt=new Date().toISOString();
 await s.call('/shared/messages',{id,body:'Test'});
 s.feed.replies.push({id:crypto.randomUUID(),replyTo:id,body:'Real response',createdAt});s.feed.posts.push({id:crypto.randomUUID(),title:'Briefing',body:'Ready',createdAt});
 let state=await (await s.call('/shared/state')).json();assert.equal(state.messages.length,2);assert.equal(state.unanswered.length,0);assert.equal(state.posts.length,1);assert.equal(state.publisher.ok,true);
 await s.refresh();state=await (await s.call('/shared/state')).json();assert.equal(state.messages.length,2);
 s.setFail();await s.refresh();state=await (await s.call('/shared/state')).json();assert.equal(state.publisher.ok,false);assert.equal(state.messages.length,2);assert.equal(state.posts.length,1);
});
test('old inbox migrates once without changing original data or copying receipts',async()=>{
 const s=setup(),key='c'.repeat(64),headers={Authorization:'Bearer '+key},id=crypto.randomUUID();
 await s.call('/v1/messages',{id,body:'Old phone message'},headers);
 assert.equal((await s.call('/shared/migrate',{})).status,401);
 await s.call('/shared/migrate',{},headers);await s.call('/shared/migrate',{},headers);
 const state=await (await s.call('/shared/state')).json();assert.equal(state.messages.length,1);assert.equal(state.messages[0].id,id);
 assert.equal((await (await s.call('/v1/state',null,headers)).json()).messages.length,2);
});
test('pending drafts survive migration and remote refresh; damaged storage is not reset',()=>{
 const old={key:'a'.repeat(64),messages:[{id:'draft',role:'user',body:'Keep me',createdAt:'2026-01-01'}],outbox:[{id:'draft',type:'message'}],composer:'Unfinished'};
 const store={getItem:k=>k===LEGACY_KEY?JSON.stringify(old):null};const state=readState(store);assert.equal(state.legacyPending,true);assert.equal(state.composer,'Unfinished');
 const next=mergeState(state,{messages:[],posts:[]});assert.equal(next.messages[0].body,'Keep me');assert.equal(next.composer,'Unfinished');
 assert.throws(()=>readState({getItem:k=>k===STORAGE_KEY?'broken':null}));
});
