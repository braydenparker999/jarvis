import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationFixture,launchQualifiedBrowser,openConversationPage,conversationMenu,closeConversationHarness,assertBrowserContained,assertNoPrivatePersistence,writeSyntheticEvidence,RELAY_URL} from './helpers/relay-conversation-browser-fixture.js';
import {RELAY_OWNER_INBOX} from '../backend/relay-common.js';

test('natural chat shows authenticated plan and progress in place, groups explicit follow-ups and remains private on narrow screens',{timeout:120000},async t=>{
  const browser=await launchQualifiedBrowser(t);if(!browser)return;const h=createConversationFixture(t),pages=[];
  try{
    const auth=await h.oauth(),owner=await h.pair(auth),rpc=(name,args)=>h.rpc(auth,name,{inbox_id:RELAY_OWNER_INBOX,...args});
    const phone=await openConversationPage(browser,h,{owner,clock:false,width:320,height:740});pages.push(phone);const page=phone.page;
    await page.goto(RELAY_URL);const input=page.locator('#relay-owner-message-text');await input.waitFor();
    await input.fill('What is a fictional garden?');await page.getByRole('button',{name:'Send private message',exact:true}).click();
    await page.locator('.message-row.outgoing').waitFor();assert.equal(await page.locator('.message-job').count(),0,'Ordinary chat has no task controls');
    await input.fill('Prepare a draft plan for my fictional garden.');await page.getByRole('button',{name:'Send private message',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.message-row.outgoing').length===2);
    const request=h.rows("SELECT id FROM relay_owner_entries WHERE kind='user' ORDER BY seq DESC LIMIT 1")[0];
    await rpc('relay_owner_job_plan',{job_id:request.id,event_id:crypto.randomUUID(),expected_revision:0,title:'Fictional garden options',goal:'A quiet fictional path <img src=x onerror=alert(1)>',plan:['Inspect the fictional layout','Draft two options for review']});
    const run_id=crypto.randomUUID();await rpc('relay_owner_job_claim',{job_id:request.id,run_id,event_id:crypto.randomUUID()});
    await rpc('relay_owner_job_update',{job_id:request.id,run_id,event_id:crypto.randomUUID(),stage:'running',summary:'Compared the two fictional layouts.'});
    await page.reload();const row=page.locator('[data-message-id="'+request.id+'"]');await row.getByText('Fictional garden options',{exact:true}).waitFor();assert.match(await row.innerText(),/Compared the two fictional layouts/);await writeSyntheticEvidence(phone,'chat-work-progress-320',{classified:true});
    await page.locator('#relay-owner-inspect-'+request.id).click();await page.locator('#relay-owner-work-plan').waitFor();assert.match(await page.locator('#relay-owner-work-plan').innerText(),/Draft two options for review/);assert.equal(await page.locator('#relay-owner-work-plan img').count(),0);await writeSyntheticEvidence(phone,'chat-work-plan-320',{inertMarkup:true});
    assert.match(await page.locator('#relay-owner-work-plan').innerText(),/<img src=x onerror=alert\(1\)>/);await page.getByRole('button',{name:'Back from task',exact:true}).click();
    await input.fill('For the fictional garden, use the first option.');await page.getByRole('button',{name:'Send private message',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.message-row.outgoing').length===3);
    const follow=h.rows("SELECT id FROM relay_owner_entries WHERE kind='user' ORDER BY seq DESC LIMIT 1")[0];
    await rpc('relay_owner_job_link',{job_id:follow.id,work_id:request.id,event_id:crypto.randomUUID(),reason:'Explicit fictional garden reference.'});
    await page.reload();await page.getByRole('button',{name:'View original work',exact:true}).waitFor();
    await conversationMenu(page,'Requests');const work=page.locator('#relay-owner-current-work');assert.equal(await work.locator('button[data-job-id]').count(),1);
    await work.locator('button[data-job-id]').click();await page.getByRole('heading',{name:'Follow-up messages',exact:true}).waitFor();await page.getByRole('button',{name:'For the fictional garden, use the first option.',exact:true}).click();await page.getByRole('button',{name:'View original work',exact:true}).click();await page.getByRole('heading',{name:'Fictional garden options',exact:true}).waitFor();
    for(const size of [{width:320,height:740},{width:390,height:844},{width:390,height:520}]){await page.setViewportSize(size);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
    await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('button',{name:'Back from task',exact:true}).click();await conversationMenu(page,'Public chat');assert.equal((await page.locator('body').innerText()).includes('Fictional garden options'),false);
    assertBrowserContained(phone);await assertNoPrivatePersistence(page,['Fictional garden options','Compared the two fictional layouts']);
  }finally{await closeConversationHarness(browser,h,pages);}
});
