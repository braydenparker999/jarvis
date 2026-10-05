import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {servePowerampFixture,openFixturePage,reportFixtureFailure} from './helpers/poweramp-fixture.js';

// Required trusted-input target: missing or broken Chromium fails, never skips.
const executablePath=[process.env.JARVIS_CHROME,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome',chromium.executablePath()].find(p=>p&&existsSync(p));
test('Poweramp mandatory Chromium library history contracts',{timeout:120000},async t=>{
  assert.ok(executablePath,'Chromium is required: install it or set JARVIS_CHROME');
  const fixture=await servePowerampFixture();let browser;
  try{
    browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
    const run=(name,fn,options={})=>t.test(name,async()=>{const h=await openFixturePage(browser,fixture,options);try{await fn(h);assert.deepEqual(h.errors,[]);}catch(error){await reportFixtureFailure(h,error,name);throw error;}finally{await h.close();}});
    await run('trusted row-origin right/left restores Library and its just-left category',async h=>{
      const {page,library,swipe}=h;await library();await page.evaluate(()=>{window.pageTrace=[];document.addEventListener('pointerdown',e=>pageTrace.push({trusted:e.isTrusted,row:!!e.target.closest('.trow')}),true);});
      await swipe('#list-body .trow:nth-of-type(3)',120,0);await page.waitForFunction(()=>PA.Nav.cur==='library'&&document.querySelector('#library-page-motion').hidden);
      assert.equal(await page.evaluate(()=>PA.LibraryPageHistory.peek(1).spec.kind),'all');
      await swipe('#lib-cats .catrow:first-child',-120,0);await page.waitForFunction(()=>PA.Nav.cur==='list'&&document.querySelector('#library-page-motion').hidden);
      assert.equal(await page.evaluate(()=>PA.Views.currentSpec.kind),'all');assert.ok(await page.evaluate(()=>pageTrace.every(e=>e.trusted)));assert.ok(await page.evaluate(()=>pageTrace.some(e=>e.row)));
    });
    await run('ordinary trusted row taps and keyboard actions retain playback',async h=>{
      const {page,library,center,tap}=h;await library();await page.evaluate(()=>{window.playRowCalls=0;const set=PA.Engine.setQueue;PA.Engine.setQueue=function(...args){playRowCalls++;return set.apply(this,args);};});
      const expected=await page.locator('#list-body .trow[data-i="1"]').getAttribute('data-id'),p=await center('#list-body .trow[data-i="1"]');await tap(p.x,p.y);await page.waitForFunction(()=>playRowCalls===1);assert.equal(await page.evaluate(()=>PA.Engine.current.id),expected);
      await library();const keyboard=page.locator('#list-body .trow[data-i="2"]'),keyboardId=await keyboard.getAttribute('data-id');await keyboard.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>playRowCalls===2);assert.equal(await page.evaluate(()=>PA.Engine.current.id),keyboardId);
    });
    await run('trusted nested Back/Forward and new category branches keep exact ancestry',async h=>{
      const {page,swipe}=h;await page.locator('[data-nav="library"]').tap();await page.getByRole('button',{name:'Artists',exact:true}).tap();await page.waitForFunction(()=>PA.Nav.cur==='list'&&!document.querySelector('#sc-list').inert);
      const group=page.locator('#list-body .trow,#list-body .gcard').first(),name=await group.getAttribute('aria-label');await group.tap();await page.waitForFunction(()=>PA.Views.currentSpec.kind==='artist');
      await swipe('#list-body',120,0);await page.waitForFunction(()=>PA.Views.currentSpec.kind==='artists'&&document.querySelector('#library-page-motion').hidden);
      assert.deepEqual(await page.evaluate(()=>PA.Views.stack.map(s=>s.kind)),['artists']);
      await swipe('#list-body',-120,0);await page.waitForFunction(()=>PA.Views.currentSpec.kind==='artist'&&document.querySelector('#library-page-motion').hidden);assert.equal(await page.evaluate(()=>PA.Views.currentSpec.title),name);
      await page.locator('#sc-list .library-back').tap();await page.waitForFunction(()=>PA.Views.currentSpec.kind==='artists');await page.locator('#list-body .trow,#list-body .gcard').nth(1).tap();await page.waitForFunction(()=>PA.Views.currentSpec.kind==='artist');
      assert.equal(await page.evaluate(()=>PA.LibraryPageHistory.peek(1)),null);assert.deepEqual(await page.evaluate(()=>PA.Views.stack.map(s=>s.kind)),['artists','artist']);
    });
    await run('5000-song Back/Forward restores a large viewport without mounting all tracks',async h=>{
      const {page,library,swipe}=h;await library();await page.evaluate(()=>{document.querySelector('#list-body').scrollTop=120000;});await h.frame();await h.frame();
      const saved=await page.locator('#list-body').evaluate(n=>n.scrollTop);assert.ok(saved>100000);
      const p=await h.center('#list-body');await h.start(p.x,p.y);await h.move(p.x+120,p.y);await h.frame();
      assert.ok(Math.abs((await page.evaluate(()=>PA.LibraryPageMotion.state.from.querySelector('[data-page-source-id="list-body"]').scrollTop))-saved)<2,'in-flight snapshot preserves the laid-out viewport');
      await h.end();await page.waitForFunction(()=>PA.Nav.cur==='library'&&document.querySelector('#library-page-motion').hidden);
      await swipe('#lib-cats',-120,0);await page.waitForFunction(()=>PA.Nav.cur==='list'&&document.querySelector('#library-page-motion').hidden);await h.frame();
      assert.ok(Math.abs((await page.locator('#list-body').evaluate(n=>n.scrollTop))-saved)<2);assert.ok(await page.locator('#list-body .trow').count()<100);assert.equal(await page.locator('#list-body .zoom-list').evaluate(n=>n.__items.length),5000);
    },{count:5000,art:false});
    await run('real native vertical scrolling and long press retain the existing owners',async h=>{
      const {page,library,center,start,move,end,frame}=h;await library();const p=await center('#list-body .trow[data-i="2"]');const index=await page.evaluate(()=>PA.LibraryPageHistory.index);
      await start(p.x,p.y);for(let i=1;i<=5;i++){await move(p.x,p.y-120*i/5);await frame();}await end();await page.waitForTimeout(100);
      assert.ok(await page.locator('#list-body').evaluate(n=>n.scrollTop)>0);assert.equal(await page.evaluate(()=>PA.LibraryPageHistory.index),index);
      const row=await center('#list-body .trow[data-i="5"]');await start(row.x,row.y);await page.waitForTimeout(600);await end();assert.equal(await page.evaluate(()=>PA.Selection.mode),true);assert.equal(await page.evaluate(()=>PA.LibraryPageHistory.index),index);
    },{count:120,art:false});
    await run('trusted stationary row contact canceled by resize stays inert and a fresh tap works',async h=>{
      const {page,library,center,start,end,tap,frame}=h;await library();await page.evaluate(()=>{window.canceledRowCalls=0;const set=PA.Engine.setQueue;PA.Engine.setQueue=function(...args){canceledRowCalls++;return set.apply(this,args);};});
      const p=await center('#list-body .trow[data-i="2"]');await start(p.x,p.y);await page.setViewportSize({width:394,height:852});await frame();await end();assert.equal(await page.evaluate(()=>canceledRowCalls),0);
      const fresh=await center('#list-body .trow[data-i="2"]');await tap(fresh.x,fresh.y);await page.waitForFunction(()=>canceledRowCalls===1);
    });
    await run('trusted root category vertical scroll cannot become category navigation',async h=>{
      const {page,center,start,move,end,frame}=h;await page.locator('[data-nav="library"]').tap();await page.waitForFunction(()=>PA.Nav.cur==='library'&&!document.querySelector('#sc-library').inert&&!document.querySelector('#sc-library').dataset.scene);const index=await page.evaluate(()=>PA.LibraryPageHistory.index),p=await center('#lib-cats .catrow[data-k="albums"]');
      await start(p.x,p.y);for(let i=1;i<=5;i++){await move(p.x,p.y-i*24);await frame();}await end();await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>PA.Nav.cur),'library');assert.equal(await page.evaluate(()=>PA.LibraryPageHistory.index),index);assert.ok(await page.locator('#lib-cats').evaluate(n=>n.scrollTop)>0);
    });
    await run('trusted horizontal intent during generic vertical arrival leaves its geometry continuous',async h=>{
      const {page,start,move,end}=h;await page.evaluate(()=>{PA.SET.animations='disabled';PA.Nav.go('settings');PA.SET.animations='normal';PA.Nav.go('library');window.crossAxisTrace=null;document.addEventListener('pointermove',e=>{if(!e.target.closest('#sc-library'))return;const n=document.querySelector('#sc-library');crossAxisTrace={trusted:e.isTrusted,before:new DOMMatrixReadOnly(getComputedStyle(n).transform).m42};queueMicrotask(()=>crossAxisTrace.after=new DOMMatrixReadOnly(getComputedStyle(PA.LibraryPageMotion.state?.from||n).transform).m42);},true);});
      await page.waitForFunction(()=>document.querySelector('#sc-library').getBoundingClientRect().bottom>350&&document.querySelector('#sc-library').getBoundingClientRect().top<-35);await start(120,100);await move(240,100);
      const trace=await page.evaluate(()=>crossAxisTrace);assert.ok(trace?.trusted);assert.ok(Math.abs(trace.before-trace.after)<3);assert.equal(await page.evaluate(()=>PA.LibraryPageMotion.state?.backdrop?.node.dataset.librarySnapshot),'settings');await end();await page.waitForFunction(()=>document.querySelector('#library-page-motion').hidden);assert.equal(await page.evaluate(()=>PA.Nav.cur),'library');
    });
    await run('trusted settle regrab freezes displayed pages, stays inert, and reverses once',async h=>{
      const {page,library,start,move,end,frame,center}=h;await library();const p=await center('#list-body .trow[data-i="2"]');await start(p.x,p.y);await move(p.x+100,p.y);await frame();await page.waitForTimeout(125);await end();
      assert.equal(await page.evaluate(()=>PA.Nav.cur),'library');const initial=await page.evaluate(()=>({index:PA.LibraryPageHistory.index}));
      await page.evaluate(()=>{window.libraryInterruption=null;document.addEventListener('pointerdown',e=>{if(e.target.id!=='library-page-motion')return;const s=PA.LibraryPageMotion.state;libraryInterruption={trusted:e.isTrusted,before:new DOMMatrixReadOnly(getComputedStyle(s.commit?s.to:s.from).transform).m41};queueMicrotask(()=>libraryInterruption.after=new DOMMatrixReadOnly(getComputedStyle(PA.LibraryPageMotion.state.from).transform).m41);},true);});
      await start(160,200);const interrupted=await page.evaluate(()=>libraryInterruption);assert.ok(interrupted?.trusted);assert.ok(Math.abs(interrupted.before-interrupted.after)<3);const held=interrupted.after;await page.waitForTimeout(280);
      assert.ok(Math.abs((await page.evaluate(()=>new DOMMatrixReadOnly(getComputedStyle(PA.LibraryPageMotion.state.from).transform).m41))-held)<2);assert.equal(await page.evaluate(()=>document.querySelector('#sc-library').inert),true);
      await move(40,200);await frame();await end();await page.waitForFunction(()=>document.querySelector('#library-page-motion').hidden);assert.equal(await page.evaluate(()=>PA.Nav.cur),'list');assert.equal(await page.evaluate(()=>PA.LibraryPageHistory.index),initial.index+1);
      assert.equal(await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);return new Set(ids).size===ids.length;}),true);
    });
  }finally{await browser?.close();await fixture.close();}
});
