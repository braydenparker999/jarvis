import test from 'node:test';
import assert from 'node:assert/strict';
import {messageAttachments} from '../public/assets/relay-attachment-contract.js';
import {createRelayOwnerApi,OWNER_SESSION_KEY} from '../public/assets/relay-owner-api.js';
import {createRelayOwnerController} from '../public/assets/relay-owner-ui.js';
const originalId=crypto.randomUUID(),replyId=crypto.randomUUID(),deliveryId=crypto.randomUUID(),deviceId=crypto.randomUUID();
const metadata={id:crypto.randomUUID(),messageId:deliveryId,name:'Synthetic report.pdf',mimeType:'application/pdf',sizeBytes:20,sha256:'a'.repeat(64),createdAt:'2026-10-10T18:00:02Z',state:'linked',visibility:'private'};
const delivery={id:deliveryId,sequence:3,role:'assistant',body:'',createdAt:metadata.createdAt,replyTo:originalId,visibility:'private',author_authenticated:true,principal:'github:183016859',authentication_source:'owner-oauth-mcp',attachments:[metadata]};
const original={id:originalId,sequence:1,role:'user',body:'Synthetic report request',createdAt:'2026-10-10T18:00:00Z',visibility:'private',author_authenticated:true};
const reply={...delivery,id:replyId,sequence:2,body:'Accepted text reply remains unchanged.',createdAt:'2026-10-10T18:00:01Z',attachments:[]};
const token='a'.repeat(64),storage={getItem:key=>key===OWNER_SESSION_KEY?JSON.stringify({device_token:token,device_id:deviceId}):null};
test('private assistant file metadata requires authenticated owner MCP provenance and exact delivery linkage',()=>{
 assert.deepEqual(messageAttachments(delivery),[metadata]);
 for(const change of [{role:'system'},{visibility:'public'},{author_authenticated:false},{principal:'github:other'},{authentication_source:'owner-device-session'},{replyTo:null},{replyTo:deliveryId},{attachments:[{...metadata,messageId:replyId}]},{attachments:[metadata,metadata]}])assert.throws(()=>messageAttachments({...delivery,...change}));
});
test('owner message API accepts authenticated assistant files and rejects foreign or public metadata',async()=>{
 let response=delivery;const api=createRelayOwnerApi({storage,fetcher:async()=>Response.json({messages:[response],nextCursor:null})});
 assert.deepEqual((await api.messages()).messages[0].attachments,[metadata]);
 for(const change of [{visibility:'public'},{authentication_source:'shared'},{attachments:[{...metadata,visibility:'public'}]}]){response={...delivery,...change};await assert.rejects(api.messages(),{kind:'invalid'});}
});
test('incremental subsequent file delivery preserves the accepted text reply and deduplicates the delivery identity',async()=>{
 let round=0;const calls=[];const api={hasCredential:true,selectedMode:'owner',session:async()=>({device:{id:deviceId},attachments_enabled:true}),messages:async after=>{calls.push(after);return {messages:round++===0?[original,reply]:[delivery],nextCursor:null};}};
 const controller=createRelayOwnerController({api,draftStore:{read:()=>'',save:()=>true}});await controller.refresh();await controller.refresh();await controller.refresh();const state=controller.snapshot();assert.equal(state.messages.length,3);assert.equal(state.messages.find(m=>m.id===replyId).body,reply.body);assert.deepEqual(state.messages.find(m=>m.id===deliveryId).attachments,[metadata]);assert.deepEqual(calls,['0','2','3']);
});
