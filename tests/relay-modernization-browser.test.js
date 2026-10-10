import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createConversationFixture,launchQualifiedBrowser,openConversationPage,conversationMenu,closeConversationHarness,assertBrowserContained,assertNoPrivatePersistence,writeSyntheticEvidence,RELAY_URL} from './helpers/relay-conversation-browser-fixture.js';
import {RELAY_OWNER_INBOX} from '../backend/relay-common.js';
import {sharedStore} from '../backend/shared.js';

// The qualification workflow already publishes JARVIS_SCREENSHOT_DIR. Keep
// fictional Relay evidence in its own subdirectory without altering that recipe.
if(!process.env.RELAY_QA_EVIDENCE_DIR&&process.env.JARVIS_SCREENSHOT_DIR)process.env.RELAY_QA_EVIDENCE_DIR=resolve(process.env.JARVIS_SCREENSHOT_DIR,'relay-modernization-checks');

async function journey(t){
  const browser=await launchQualifiedBrowser(t);if(!browser)return;
  const h=createConversationFixture(t),pages=[],auth=await h.oauth(),owner=await h.pair(auth,'Fictional redesign phone');
  t.after(()=>closeConversationHarness(browser,h,pages));
  const open=async(size={})=>{const phone=await openConversationPage(browser,h,{owner,clock:false,...size});pages.push(phone);await phone.page.goto(RELAY_URL);await phone.page.locator('#relay-owner-message-text').waitFor();await phone.page.waitForFunction(()=>!document.querySelector('#relay-owner-message-form [role=status]')?.textContent.includes('Refreshing'));return phone;};
  const create=async(data)=>{const response=await h.phone('/jobs',{id:crypto.randomUUID(),title:'Fictional task',body:'Fictional scope note.',action_kind:'read_only',...data},owner.device_token);assert.equal(response.status,201);return (await response.json()).job;};
  return {browser,h,owner,auth,pages,open,create,rpc:(name,args)=>h.rpc(auth,name,{inbox_id:RELAY_OWNER_INBOX,...args})};
}
async function geometry(page){return page.evaluate(()=>{
  const modal=document.querySelector('dialog[open]'),root=modal||document;
  const targets=[...root.querySelectorAll('button,input,select,textarea,summary,.topbar a,.relay-home')].filter(n=>{const r=n.getBoundingClientRect();return r.width&&r.height&&!n.closest('[hidden]')&&getComputedStyle(n).visibility!=='hidden';}).map(n=>{const target=n.type==='checkbox'?n.closest('label')||n:n,r=target.getBoundingClientRect();return {name:n.getAttribute('aria-label')||n.id||n.textContent.trim(),width:r.width,height:r.height};});
  return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,appHeight:parseFloat(document.documentElement.style.getPropertyValue('--app-height')),targets};
});}
function assertGeometry(value){assert.ok(value.documentWidth<=value.width+1,JSON.stringify(value));for(const t of value.targets){assert.ok(t.width>=48&&t.height>=48,JSON.stringify(t));}}
function contrast(foreground,background){const luminance=value=>{const rgb=value.match(/[\d.]+/g).slice(0,3).map(c=>Number(c)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};const a=luminance(foreground),b=luminance(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
async function chatAnchor(page){return page.locator('.relay-owner-chat .messages').evaluate(panel=>{const b=panel.getBoundingClientRect(),r=[...panel.children].find(n=>n.dataset.messageId&&n.getBoundingClientRect().bottom>b.top);return {id:r?.dataset.messageId,offset:r?r.getBoundingClientRect().top-b.top:0,scroll:panel.scrollTop};});}

test('visible Chat and Work preserve local context, reading and private draft without expansion requests',{timeout:120000},async t=>{
  const j=await journey(t);if(!j)return;const jobs=[];
  for(let i=0;i<16;i++)jobs.push(await j.create({title:'Fictional studio task '+i,body:'Fictional scope note '+i+'. Keep this work private.',project_title:'Fictional studio project',goal_title:'Prepare the room'}));
  const phone=await j.open(),page=phone.page;await page.locator('[data-job-id="'+jobs.at(-1).id+'"]').waitFor();
  assert.equal(await page.locator('#relay-nav-chat').getAttribute('aria-current'),'page');
  await page.locator('#chat-search-toggle').click();await page.locator('#relay-owner-search').fill('scope note');
  const panel=page.locator('.relay-owner-chat .messages');await panel.evaluate(n=>n.scrollTop=220);const chat=await chatAnchor(page);assert.ok(chat.scroll>0);
  await page.locator('#relay-owner-message-text').fill('A fictional private draft to retain.');const before=phone.records.length;
  await page.locator('#relay-nav-work').click();assert.equal(await page.locator('#relay-nav-work').getAttribute('aria-current'),'page');
  const work=page.locator('#relay-owner-current-work');await work.waitFor();assert.equal(await page.locator('#relay-owner-message-form').isVisible(),false,'Work allocates its canvas to tasks');
  await page.locator('#relay-owner-search').fill('studio project');await work.locator('#relay-owner-work-filter').selectOption('queued');
  await work.locator('[data-job-id="'+jobs[6].id+'"]>summary').click();await panel.evaluate(n=>n.scrollTop=300);const workScroll=await panel.evaluate(n=>n.scrollTop);
  await page.locator('#relay-nav-chat').click();assert.equal(await page.locator('#relay-owner-search').inputValue(),'scope note');assert.equal(await page.locator('#relay-owner-message-text').inputValue(),'A fictional private draft to retain.');
  const restored=await chatAnchor(page);assert.equal(restored.id,chat.id);assert.ok(Math.abs(restored.offset-chat.offset)<=3,JSON.stringify({chat,restored}));
  await page.locator('#relay-nav-work').click();assert.equal(await page.locator('#relay-owner-search').inputValue(),'studio project');assert.equal(await work.locator('#relay-owner-work-filter').inputValue(),'queued');assert.equal(await work.locator('[data-job-id="'+jobs[6].id+'"]').evaluate(n=>n.open),true);assert.ok(Math.abs((await panel.evaluate(n=>n.scrollTop))-workScroll)<=3);
  assert.equal(phone.records.slice(before).filter(r=>r.path.startsWith('/relay/owner/')).length,0,'Navigation, search, filter and disclosures use loaded records');
  await page.locator('#relay-owner-new-task').click();assert.equal(await page.locator('.relay-owner-chat').getAttribute('data-task-editor'),'false');assert.match(await page.locator('.conversation-notice [role=status]').innerText(),/Finish or clear your current draft/);
  assert.equal(await page.locator('#relay-owner-message-text').inputValue(),'A fictional private draft to retain.');
  await conversationMenu(page,'Public chat');await page.locator('#message-text').waitFor();assert.equal(await page.locator('#relay-owner-current-work').count(),0);assert.equal((await page.locator('body').innerText()).includes('Fictional studio project'),false);
  await assertNoPrivatePersistence(page,['Fictional studio project','Fictional scope note'],{draft:'A fictional private draft to retain.'});assertBrowserContained(phone);
});

test('focused task editor retains the draft and uncertain original payload across Back and retry',{timeout:120000},async t=>{
  const j=await journey(t);if(!j)return;const phone=await j.open(),page=phone.page;
  await page.locator('#relay-nav-work').click();await page.locator('#relay-owner-current-work').waitFor();const before=phone.records.length;await page.locator('#relay-owner-new-task').click();
  assert.equal(await page.evaluate(()=>document.activeElement.id),'relay-owner-job-title');assert.equal(await page.locator('.relay-owner-chat .messages').isVisible(),false);
  await page.locator('#relay-owner-job-title').fill('Fictional welcome draft');await page.locator('#relay-owner-job-kind').selectOption('draft');await page.locator('#relay-owner-message-text').fill('Fictional reminder for owner review.');
  for(const size of [{width:360,height:800},{width:390,height:844},{width:390,height:520},{width:320,height:568},{width:844,height:390}]){
    await page.setViewportSize(size);await page.locator('#relay-owner-job-title').scrollIntoViewIfNeeded();const g=await geometry(page);assertGeometry(g);const form=await page.locator('#relay-owner-message-form').boundingBox();assert.ok(form&&form.y>=0&&form.y+form.height<=size.height+1,JSON.stringify({size,form}));
    const send=await page.getByRole('button',{name:'Send private request',exact:true}).boundingBox();assert.ok(send&&send.y>=0&&send.y+send.height<=size.height+1,JSON.stringify({size,send}));await writeSyntheticEvidence(phone,'redesign-task-'+size.width+'x'+size.height,{synthetic:true,geometry:g});
  }
  await page.setViewportSize({width:390,height:844});await page.locator('#relay-owner-task-back').click();assert.equal(await page.locator('#relay-owner-job-title').inputValue(),'Fictional welcome draft');assert.equal(await page.evaluate(()=>document.activeElement.id),'relay-owner-new-task');
  await page.locator('#relay-nav-chat').click();assert.match(await page.locator('#relay-owner-message-form [role=status]').innerText(),/Task draft kept/);assert.equal(await page.getByRole('button',{name:'Send private message',exact:true}).isDisabled(),true,'Back cannot change the saved task scope into a message submission');
  await page.locator('#relay-owner-job-toggle').click();assert.equal(await page.locator('#relay-owner-job-kind').inputValue(),'draft');assert.equal(await page.locator('#relay-owner-message-text').inputValue(),'Fictional reminder for owner review.');
  await page.locator('#relay-owner-job-title').fill('');await page.locator('#relay-owner-task-back').click();assert.equal(await page.getByRole('button',{name:'Send private message',exact:true}).isDisabled(),true,'An untitled task draft also keeps its requested scope');await page.locator('#relay-owner-message-text').dispatchEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:false});assert.equal(phone.records.slice(before).filter(r=>r.method==='POST').length,0,'Keyboard submission cannot bypass retained scope');await page.locator('#relay-owner-job-toggle').click();assert.equal(await page.locator('#relay-owner-job-kind').inputValue(),'draft');await page.locator('#relay-owner-job-title').fill('Fictional welcome draft');
  await page.locator('#relay-owner-message-text').fill('   ');assert.equal(await page.getByRole('button',{name:'Send private request',exact:true}).isDisabled(),true);await page.locator('#relay-owner-message-text').fill('Fictional reminder for owner review.');
  await page.locator('#relay-owner-message-text').dispatchEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true});assert.equal(phone.records.slice(before).filter(r=>r.method==='POST').length,0,'Opening, editing, Back, resize and IME composition do not submit');
  phone.rule(r=>r.method==='POST'&&r.path==='/relay/owner/jobs',async({forward})=>{const accepted=await forward();assert.equal(accepted.status,201);return {abort:true};});await page.getByRole('button',{name:'Send private request',exact:true}).click();await page.getByRole('button',{name:'Retry private send',exact:true}).waitFor();
  const writes=()=>phone.records.filter(r=>r.method==='POST'&&r.path==='/relay/owner/jobs'),original=JSON.parse(writes()[0].body);assert.equal(j.h.rows('SELECT COUNT(*) AS n FROM relay_owner_jobs')[0].n,1);
  await page.locator('#relay-owner-task-back').click();await page.locator('#relay-nav-work').click();await page.getByRole('button',{name:'Retry private send',exact:true}).waitFor();await page.locator('#relay-owner-new-task').click();assert.equal(await page.locator('.relay-owner-chat').getAttribute('data-task-editor'),'false');assert.match(await page.locator('.conversation-notice [role=status]').innerText(),/Resolve your unconfirmed send/);assert.equal(writes().length,1);
  const confirmed=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/relay/owner/jobs'&&r.ok());await page.getByRole('button',{name:'Retry private send',exact:true}).click();await confirmed;await page.waitForFunction(()=>!document.querySelector('#relay-owner-message-form [role=status]')?.textContent.includes('Saving'));
  assert.equal(writes().length,2);assert.deepEqual(JSON.parse(writes()[1].body),original);assert.equal(j.h.rows('SELECT COUNT(*) AS n FROM relay_owner_jobs')[0].n,1,'The frozen UUID prevents a duplicate accepted task');assertBrowserContained(phone);
});

test('phone result-first detail and desktop pane retain immutable correction and completion evidence',{timeout:120000},async t=>{
  const j=await journey(t);if(!j)return;const job=await j.create({title:'Fictional completed checklist',body:'Fictional original scope. Prepare a checklist without external changes.',project_title:'Fictional studio',goal_title:'Open the room'}),run=crypto.randomUUID();
  await j.rpc('relay_owner_job_claim',{job_id:job.id,run_id:run,event_id:crypto.randomUUID()});const reply=await j.rpc('relay_owner_reply',{message_id:job.id,body:'Fictional original result: three chairs.'});await j.rpc('relay_owner_job_update',{job_id:job.id,run_id:run,event_id:crypto.randomUUID(),stage:'completed',outcome:'known',summary:'Fictional checklist preparation reported complete.',expected_reply_id:reply.entry.id,expected_version:1});await j.rpc('relay_owner_job_result_correct',{job_id:job.id,event_id:crypto.randomUUID(),expected_reply_id:reply.entry.id,expected_version:1,body:'Fictional corrected result: four chairs. https://example.test/fictional-checklist',correction_summary:'Checked the second fictional note.'});
  for(const size of [{width:390,height:844,mobile:true},{width:1280,height:900,mobile:false}]){
    const phone=await j.open(size),page=phone.page;await page.locator('[data-job-id="'+job.id+'"]').waitFor();await page.locator('#relay-nav-work').click();await page.locator('.owner-work-finished>summary').click();const row=page.locator('#relay-owner-current-work [data-job-id="'+job.id+'"]');await row.locator('summary').first().click();const evidence=row.getByRole('button',{name:'Evidence and result',exact:true});await evidence.click();await page.waitForFunction(()=>{const r=document.querySelector('#relay-owner-request-refresh');return r&&!r.disabled;});
    const detail=page.locator('#relay-owner-request-dialog');assert.equal(await detail.locator('#relay-owner-request-properties').evaluate(n=>n.open),false);assert.equal(await detail.locator('#relay-owner-objective').evaluate(n=>n.open),false);
    const order=await detail.evaluate(dialog=>({result:dialog.querySelector('#relay-owner-result-latest').getBoundingClientRect().top,properties:dialog.querySelector('#relay-owner-request-properties').getBoundingClientRect().top,rect:dialog.getBoundingClientRect().toJSON()}));assert.ok(order.result<order.properties&&order.result<size.height/2,JSON.stringify(order));
    if(size.mobile)assert.ok(order.rect.top===0&&order.rect.width===390&&order.rect.height===844);else{assert.equal(order.rect.width,420);assert.equal(await page.locator('.relay-navigation').evaluate(n=>n.getBoundingClientRect().width),224);}
    assert.equal(await detail.locator('#relay-owner-result-latest').getAttribute('data-result-version'),'2');assert.equal(await detail.locator('#relay-owner-completion').getAttribute('data-result-version'),'1');assert.match(await detail.locator('#relay-owner-completion').textContent(),/does not certify factual claims or external outcomes/);assert.match(await detail.locator('.request-state').textContent(),/Work reported complete/);assert.equal(await detail.getByRole('button',{name:'Request cancellation',exact:true}).count(),0);assert.equal(await detail.getByRole('button',{name:'Try again',exact:true}).count(),0);
    const g=await geometry(page);assertGeometry(g);await writeSyntheticEvidence(phone,'redesign-result-'+size.width+'x'+size.height,{synthetic:true,geometry:g,order,completionVersion:1,resultVersion:2});
    await page.keyboard.press('Escape');await detail.waitFor({state:'detached'});assert.equal(await detail.count(),0);assert.equal(await page.evaluate(()=>document.activeElement.id),'owner-work-evidence-'+job.id);assert.equal(await row.evaluate(n=>n.open),true);assertBrowserContained(phone);
  }
});

test('reflow, enlarged text and visual-viewport-only keyboard keep real controls and drafts usable',{timeout:120000},async t=>{
  const j=await journey(t);if(!j)return;const job=await j.create({title:('Fictional long title with useful context ').repeat(3).slice(0,120),body:'Fictional scope note with a long URL https://example.test/'+('long-path-').repeat(20),project_title:('Fictional long project ').repeat(5).slice(0,120),goal_title:('Fictional long goal ').repeat(6).slice(0,120)}),phone=await j.open(),page=phone.page;await page.locator('[data-job-id="'+job.id+'"]').waitFor();await page.locator('#relay-owner-message-text').fill('Fictional draft stays through viewport changes.');
  const keyboard=await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>520});visualViewport.dispatchEvent(new Event('resize'));return {layout:innerHeight,visual:visualViewport.height,app:parseFloat(document.documentElement.style.getPropertyValue('--app-height')),compact:document.body.dataset.relayCompactViewport,composer:document.querySelector('#relay-owner-message-form').getBoundingClientRect().toJSON()};});
  assert.equal(keyboard.layout,844);assert.equal(keyboard.visual,520);assert.equal(keyboard.app,520);assert.equal(keyboard.compact,'true');assert.ok(keyboard.composer.bottom<=521);assert.equal(await page.locator('.relay-navigation').isVisible(),false,'Only visual viewport shrinks in this explicitly mocked Android-style resize');
  await page.evaluate(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});assert.equal(await page.locator('.relay-navigation').isVisible(),true);assert.equal(await page.locator('#relay-owner-message-text').inputValue(),'Fictional draft stays through viewport changes.');
  await page.locator('#relay-nav-work').click();await page.setViewportSize({width:320,height:568});assertGeometry(await geometry(page));assert.equal(await page.locator('.relay-navigation').isVisible(),true,'A short viewport without a keyboard retains both destinations');
  await page.evaluate(()=>{const sizes=[...document.querySelectorAll('h1,h2,h3,p,span,button,label,input,select,textarea,summary,a,li')].map(n=>{const s=getComputedStyle(n);return {n,font:parseFloat(s.fontSize),line:parseFloat(s.lineHeight)};});for(const {n,font,line}of sizes){n.style.fontSize=font*2+'px';n.style.lineHeight=(Number.isFinite(line)?line*2:font*3)+'px';}});
  const enlarged=await geometry(page);assertGeometry(enlarged);await writeSyntheticEvidence(phone,'redesign-work-320-enlarged',{synthetic:true,geometry:enlarged,textScale:2,keyboardSimulation:'mock VisualViewport height only; no physical IME'});assertBrowserContained(phone);
});

test('Relay choice sheets, owner connection and pending public timestamps retain readable rendered contrast',{timeout:120000},async t=>{
  const j=await journey(t);if(!j)return;const phone=await j.open(),page=phone.page;
  const assertHeading=async(name)=>{
    const colors=await page.locator('dialog[open] .dialog-heading').evaluate(n=>({background:getComputedStyle(n).backgroundColor,text:getComputedStyle(n.querySelector('h2')).color}));
    assert.equal(colors.background,'rgb(255, 255, 255)');assert.equal(colors.text,'rgb(32, 36, 43)');assert.ok(contrast(colors.text,colors.background)>=4.5,JSON.stringify(colors));assertGeometry(await geometry(page));
    await writeSyntheticEvidence(phone,name,{synthetic:true,colors,contrast:contrast(colors.text,colors.background)});
  };
  await page.locator('#chat-menu').click();await assertHeading('redesign-conversation-menu-contrast');
  await page.getByRole('dialog').getByRole('button',{name:'Connection details',exact:true}).click();await page.getByRole('dialog',{name:'Private owner connection',exact:true}).waitFor();await assertHeading('redesign-owner-connection-contrast');
  await page.getByRole('button',{name:'Close connection details',exact:true}).click();
  const id=crypto.randomUUID();assert.equal(sharedStore(j.h.ctx,'/internal/shared/message',{id,body:'Fictional public question awaiting a reply.'}).status,201);
  await conversationMenu(page,'Public chat');await page.evaluate(()=>dispatchEvent(new Event('online')));const pending=page.locator('#messages [data-message-id="'+id+'"] .message-footer>.message-time[data-pending=true]');await pending.waitFor();
  const colors=await pending.evaluate(n=>({text:getComputedStyle(n).color,background:getComputedStyle(document.body).backgroundColor}));assert.equal(colors.text,'rgb(98, 104, 115)');assert.ok(contrast(colors.text,colors.background)>=4.5,JSON.stringify(colors));assert.match(await pending.innerText(),/Awaiting reply/);
  await writeSyntheticEvidence(phone,'redesign-public-pending-contrast',{synthetic:true,colors,contrast:contrast(colors.text,colors.background)});assertBrowserContained(phone);
  if(process.env.JARVIS_SCREENSHOT_DIR){
    const helper=fileURLToPath(new URL('./helpers/relay-modernization-visual-fixture.mjs',import.meta.url));
    const output=resolve(process.env.JARVIS_SCREENSHOT_DIR,'relay-visual-review');
    const result=await promisify(execFile)(process.execPath,[helper,output],{timeout:90000,maxBuffer:1024*1024});
    assert.match(result.stdout,/"captures":31,"unexpected":\[\],"browserErrors":\[\]/,'The fictional review artifact must contain all 31 rendered after scenarios without uncontained routes or browser errors');
  }
});
