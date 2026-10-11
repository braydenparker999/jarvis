import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createConversationFixture} from './helpers/relay-conversation-browser-fixture.js';
import {hash,random} from '../backend/relay-common.js';

test('explicit Muse hook: real store lost receipts, restart, held dispatch, cancellation and completion',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mast-work-hook-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const token=random(),h=createConversationFixture(t,{env:{RELAY_MAST_ENABLED:'true',RELAY_MAST_TOKEN_SHA256:await hash(token)}});t.after(()=>h.close());const owner=await h.pair(await h.oauth());
 const create=async()=>{const id=crypto.randomUUID();assert.equal((await h.phone('/mast/work',{id,title:'Synthetic request',body:'Draft only',action_kind:'draft'},owner.device_token)).status,201);return id;};
 const calls=[];
 async function bridge(job,mode,lose=true){
  const child=spawn('python3',[fileURLToPath(new URL('./helpers/mast-work-hook-bridge.py',import.meta.url)),join(directory,job+'.sqlite'),job,mode],{stdio:['pipe','pipe','pipe']});
  let stderr='',result;child.stderr.on('data',x=>stderr+=x);
  const exit=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  const lost=new Set();
  for await(const line of createInterface({input:child.stdout})){
   const msg=JSON.parse(line);
   if(msg.request){const {method,path,payload}=msg.request;calls.push(msg.request);
    const url='/relay/mast/'+path+(method==='GET'?'?'+new URLSearchParams(payload):'');
    const response=await h.fixture.request(url,{method,headers:{Authorization:'Bearer '+token},...(method==='GET'?{}:{body:JSON.stringify(payload)})});
    const data=await response.json();
    const key=path==='work/claim'||path==='reply'?path:payload.stage==='completed'?'completion':null;
    if(lose&&response.ok&&key&&!lost.has(key)){lost.add(key);child.stdin.write(JSON.stringify({status:503,data:{}})+'\n');}
    else child.stdin.write(JSON.stringify({status:response.status,data})+'\n');
   }else if(msg.control==='correct'){
    const reply=h.rows("SELECT id FROM relay_mast_entries WHERE reply_to=?",job)[0].id;
    const response=await h.fixture.request('/relay/mast/work/correct',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({job_id:job,event_id:crypto.randomUUID(),expected_reply_id:reply,expected_version:1,body:'Correction',correction_summary:'Synthetic correction'})});
    assert.equal(response.status,200);child.stdin.write('{"ok":true}\n');
   }else if(msg.control){assert.equal((await h.phone('/mast/work/cancel',{job_id:job,event_id:crypto.randomUUID()},owner.device_token)).status,201);child.stdin.write('{"ok":true}\n');}
   else result=msg.result;
  }
  assert.equal(await exit,mode==='crash'?9:0,stderr);if(mode!=='crash')assert.equal(result?.ok,true);
 }
 const complete=await create();await bridge(complete,'complete');
 const posts=calls.filter(r=>r.method==='POST'&&(r.payload.job_id===complete||r.payload.reply_to===complete));
 for(const path of ['work/claim','reply']){const matched=posts.filter(r=>r.path===path);assert.equal(matched.length,2);assert.deepEqual(matched[0],matched[1]);}
 const finals=posts.filter(r=>r.payload.stage==='completed');assert.equal(finals.length,2);assert.deepEqual(finals[0],finals[1]);
 const job=JSON.parse(h.rows('SELECT value FROM relay_mast_work WHERE id=?',complete)[0].value);assert.equal(job.stage,'completed');assert.equal(job.completion.resultVersion,1);
 assert.equal(h.rows("SELECT COUNT(*) AS n FROM relay_mast_entries WHERE reply_to=?",complete)[0].n,1);
 await bridge(await create(),'cancel');
 const corrected=await create();await bridge(corrected,'correction');assert.equal(calls.filter(r=>r.payload.job_id===corrected&&r.payload.stage==='completed').length,0);
 const held=await create();await bridge(held,'crash',false);
 const expired=JSON.parse(h.rows('SELECT value FROM relay_mast_work WHERE id=?',held)[0].value);expired.expires=1;h.rows('UPDATE relay_mast_work SET value=? WHERE id=?',JSON.stringify(expired),held);
 await bridge(held,'held',false);
 assert.equal(calls.filter(r=>r.path==='work/claim'&&r.payload.job_id===held).length,1);
});

test('Muse hook bounded pagination and verified request files',async()=>{
 const {spawnSync}=await import('node:child_process');
 const result=spawnSync('python3',[fileURLToPath(new URL('./helpers/mast-work-hook-tests.py',import.meta.url))],{encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
