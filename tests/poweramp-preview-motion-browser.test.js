import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {buildPreview} from '../scripts/build-poweramp-preview.mjs';
import {fixtureSceneSettled,installFixtureInputTrace,mobileContext,reportFixtureFailure} from './helpers/poweramp-fixture.js';

const executablePath=[process.env.JARVIS_CHROME,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome',chromium.executablePath()].find(p=>p&&existsSync(p));

// Real generated HTML and trusted CDP contacts. These reports measure inclusive
// synchronous runtime work and RAF callback gaps, never phone FPS/input latency.
test('Poweramp downloaded preview trusted mini motion and operation evidence',{timeout:120000},async t=>{
  assert.ok(executablePath,'Chromium is required: install it or set JARVIS_CHROME');
  const directory=await mkdtemp(join(tmpdir(),'poweramp-preview-motion-'));let browser;
  try{
    const built=await buildPreview(join(directory,'preview.html'));
    browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
    for(const count of [60,5000])await t.test(count+'-song first and repeated mini opens, held drag, and regrab',async()=>{
      const context=await browser.newContext(mobileContext),page=await context.newPage(),errors=[],reports=[];
      page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
      await context.addInitScript(installFixtureInputTrace);
      const diagnostics=()=>page.evaluate(()=>({screen:PA.Nav.cur,preview:powerampPreview.count,mini:{inert:document.querySelector('#mini').inert,hidden:document.querySelector('#mini').hidden},
        sharedPlane:!!document.querySelector('.player-scene-input'),history:{active:!!PA.LibraryPageMotion.state,pending:!!PA.LibraryPageMotion.finish},trace:window.fixtureInputTrace}));
      try{
        await context.route('**/*',route=>/^https?:/.test(route.request().url())?route.abort('blockedbyclient'):route.continue());
        await page.goto(pathToFileURL(built.output).href);await page.waitForFunction(()=>window.powerampPreview?.ready);
        if(count===5000){await page.locator('#preview-size').tap();await page.waitForFunction(()=>powerampPreview.ready&&powerampPreview.count===5000);}
        const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(done)));
        const settled=async screen=>{await page.waitForFunction(fixtureSceneSettled,screen);await frame();await frame();};
        const library=async()=>{await page.locator('[data-nav="library"]').tap();await settled('library');await page.getByRole('button',{name:'All Songs',exact:true}).tap();await settled('list');};
        const cdp=await context.newCDPSession(page),point=(x,y)=>({id:1,x,y,radiusX:1,radiusY:1,force:1});
        const start=(x,y)=>cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(x,y)]});
        const move=(x,y)=>cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point(x,y)]});
        const end=()=>cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        const target=async()=>{
          const result=await page.locator('#mini-title').evaluate(n=>{const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,hit:hit?.id||hit?.tagName,reachable:!!hit&&n.contains(hit),mini:!!hit?.closest('#mini')};});
          assert.equal(result.reachable,true,'mini-title geometry must hit its real title, got '+result.hit);assert.equal(result.mini,true);return result;
        };
        const measure=async(label,perform)=>{
          await page.locator('#preview-help').tap();await page.getByRole('button',{name:'Measure 30 seconds',exact:true}).tap();
          await page.waitForFunction(()=>document.getElementById('preview-help').textContent==='●');
          await page.evaluate(()=>{window.fixtureInputTrace=[];});await frame();
          await perform();await settled('player');
          // Read the shipped local report through its actual Help dialog. No
          // new production debug exports or private runtime access are needed.
          await page.locator('#preview-help').tap();await page.getByRole('button',{name:'Show diagnostics',exact:true}).tap();
          const report=JSON.parse(await page.locator('#preview-diagnostics-report').inputValue());
          await page.getByRole('button',{name:'Close',exact:true}).tap();
          assert.ok(report.operations?.some(operation=>operation.operation==='shared.create'&&operation.phase==='shared:setup:expand'),'report includes the real shared-player setup work');
          assert.equal(report.final.screen,'player');assert.equal(report.final.scene,null);
          const trace=await page.evaluate(()=>fixtureInputTrace);assert.ok(trace.some(event=>event.type==='pointerdown'&&event.target.includes('#mini-title')&&event.trusted));assert.ok(trace.every(event=>event.trusted));
          reports.push({label,...report});
        };
        const id=await page.evaluate(()=>PA.Engine.current.id);
        for(const label of ['first-mini-tap','repeated-mini-tap']){
          await library();const p=await target();await measure(label,async()=>{await start(p.x,p.y);await end();assert.equal(await page.evaluate(()=>PA.Nav.cur),'player');});
        }
        await library();let p=await target();
        await measure('held-mini-drag',async()=>{
          await start(p.x,p.y);for(const dy of [16,40,75,110]){await move(p.x,p.y-dy);await frame();}
          assert.ok(await page.locator('.player-scene-art').count(),'held real mini drag must create the shared painted layer');
          assert.equal(await page.evaluate(()=>PA.Nav.cur),'list');await end();assert.equal(await page.evaluate(()=>PA.Nav.cur),'player');
        });
        await library();p=await target();
        await measure('regrab-mini-settle',async()=>{
          await start(p.x,p.y);await move(p.x,p.y-110);await frame();await end();
          assert.equal(await page.evaluate(()=>PA.Nav.cur),'player');await start(3,100);
          const frozen=await page.locator('.player-scene-art').boundingBox();assert.ok(frozen);
          await page.waitForTimeout(280);const held=await page.locator('.player-scene-art').boundingBox();assert.ok(held);
          for(const key of ['x','y','width','height'])assert.ok(Math.abs(frozen[key]-held[key])<2,'regrab freezes '+key);
          const trace=await page.evaluate(()=>fixtureInputTrace);assert.ok(trace.some(event=>event.type==='pointerdown'&&event.target.includes('player-scene-input')&&event.trusted),'regrab hits the actual shared scene plane');await end();
        });
        assert.equal(await page.evaluate(()=>PA.Engine.current.id),id);assert.deepEqual(errors,[]);
        const evidence={source:built.sourceHash,tracks:count,metric:'Synchronous inclusive operation times and RAF callback gaps. Nested costs overlap; these are not phone FPS or touch latency.',reports};
        if(process.env.POWERAMP_EVIDENCE_DIR){const output=resolve(process.env.POWERAMP_EVIDENCE_DIR);await mkdir(output,{recursive:true});await writeFile(join(output,'preview-mini-motion-'+count+'.json'),JSON.stringify(evidence,null,2)+'\n');}
        t.diagnostic('POWERAMP_BROWSER_TIMINGS '+JSON.stringify({source:built.sourceHash,tracks:count,reports:reports.map(report=>({label:report.label,operations:report.operations,phase_gap_ms:report.phase_gap_ms,raf_gap_ms:report.raf_gap_ms}))}));
      }catch(error){await reportFixtureFailure({page,diagnostics},error,'preview-mini-motion-'+count);throw error;}
      finally{await context.close();}
    });
  }finally{await browser?.close();await rm(directory,{recursive:true,force:true});}
});
