import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {buildPreview} from '../scripts/build-poweramp-preview.mjs';
import {fixtureSceneSettled,installFixtureInputTrace,reportFixtureFailure} from './helpers/poweramp-fixture.js';
import {compareSetupModes,setupImprovementLimit,setupOperations} from './helpers/poweramp-performance.js';

// Deliberately outside tests/*.test.js: run this required test in its own CI
// step after the aggregate suite, without competing Chromium test processes.
const profile={viewport:{width:519,height:988},deviceScaleFactor:2.0818214416503906,isMobile:true,hasTouch:true};
const executablePath=[process.env.JARVIS_CHROME,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome',chromium.executablePath()].find(path=>path&&existsSync(path));
async function saveEvidence(name,value){
  if(!process.env.POWERAMP_EVIDENCE_DIR)return;
  const directory=resolve(process.env.POWERAMP_EVIDENCE_DIR);await mkdir(directory,{recursive:true});await writeFile(join(directory,name+'.json'),JSON.stringify(value,null,2)+'\n');
}
async function measureGroup(browser,built,count,mode,evidence){
  const baseline=mode==='baseline',context=await browser.newContext(profile),page=await context.newPage(),errors=[],reports=[];
  const group={mode,baseline,reports};evidence.groups.push(group);
  page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>/^https?:/.test(route.request().url())?route.abort('blockedbyclient'):route.continue());
  await context.addInitScript(installFixtureInputTrace);
  const diagnostics=()=>page.evaluate(()=>({screen:PA.Nav.cur,scene:!!document.querySelector('.player-scene-layer'),trace:fixtureInputTrace,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},sheet:window.fixtureSetupSheet})).then(state=>({...state,mode,errors}));
  try{
    await page.goto(pathToFileURL(built.output).href);await page.waitForFunction(()=>window.powerampPreview?.ready);
    if(count===5000){await page.locator('#preview-size').tap();await page.waitForFunction(()=>powerampPreview.ready&&powerampPreview.count===5000);}
    await page.evaluate(()=>document.fonts.ready);
    const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(done)));
    const settled=async screen=>{await page.waitForFunction(fixtureSceneSettled,screen);await frame();await frame();};
    const quiet=async()=>{await page.waitForFunction(()=>document.getAnimations().every(animation=>animation.playState==='finished'||animation.playState==='idle'));await frame();await frame();};
    const library=async()=>{await page.locator('[data-nav="library"]').tap();await settled('library');await page.getByRole('button',{name:'All Songs',exact:true}).tap();await settled('list');await quiet();};
    // Normal real navigation has already created a collapse scene. "First"
    // means the first measured mini expansion in a fresh context, not a claim
    // that no shared-player code or artwork has ever run before it.
    await settled('player');await library();
    await page.evaluate(baseline=>{
      const sheet=document.styleSheets[0],descriptor=Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype,'cssRules');
      if(!sheet||!descriptor?.get)throw Error('Expected a real readable preview stylesheet');
      const rules=descriptor.get.call(sheet).length;window.fixtureSetupSheet={baseline,enabled:!sheet.disabled,rules,reads:0};
      Object.defineProperty(sheet,'cssRules',{configurable:true,get(){fixtureSetupSheet.reads++;if(baseline)throw new DOMException('Test-only exhaustive snapshot selection','SecurityError');return descriptor.get.call(this);}});
    },baseline);
    const cdp=await context.newCDPSession(page),point=(x,y)=>({id:1,x,y,radiusX:1,radiusY:1,force:1});
    const start=(x,y)=>cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(x,y)]});
    const move=(x,y)=>cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point(x,y)]});
    const end=()=>cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const target=()=>page.locator('#mini-title').evaluate(node=>{
      const rect=node.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2,hit=document.elementFromPoint(x,y);
      if(!hit||!node.contains(hit)||!hit.closest('#mini'))throw Error('Real mini title is not the hit target');return {x,y};
    });
    const sceneEvidence=()=>page.evaluate(()=>{
      const layer=document.querySelector('.player-scene-layer');if(!layer)throw Error('Expected actual held painted scene');
      const nodes=[layer,...layer.querySelectorAll('*')];return {cssCharacters:nodes.reduce((sum,node)=>sum+node.style.cssText.length,0),clonedNodes:nodes.length};
    });
    const measure=async(label,action)=>{
      const before=await page.evaluate(()=>({...fixtureSetupSheet}));
      await page.locator('#preview-help').tap();await page.getByRole('button',{name:'Measure 30 seconds',exact:true}).tap();await page.waitForFunction(()=>document.querySelector('#preview-help').textContent==='●');
      await page.evaluate(()=>{window.fixtureInputTrace=[];});await frame();const detail=await action();await settled('player');
      await page.locator('#preview-help').click();await page.getByRole('button',{name:'Show diagnostics',exact:true}).click();
      const result=JSON.parse(await page.locator('#preview-diagnostics-report').inputValue());await page.getByRole('button',{name:'Close',exact:true}).click();
      const state=await diagnostics(),report={label,...result,...detail,sheetBefore:before,sheetAfter:state.sheet,trace:state.trace};reports.push(report);
      // Preserve completed samples before any assertion can reject this group.
      await saveEvidence('preview-setup-paired-'+count,evidence);
      assert.equal(result.source,built.sourceHash);assert.equal(result.tracks,count);assert.equal(result.final.screen,'player');assert.equal(result.final.scene,null);
      assert.ok(state.sheet.enabled&&state.sheet.reads>before.reads,'same enabled sheet is introspected during every setup');
      const plans=result.events.filter(event=>event.type==='snapshot-plan');assert.ok(plans.length,'actual production snapshot plan was observed');assert.ok(plans.every(event=>event.active===!baseline),'requested compact/exhaustive path must really be active');
      for(const operation of setupOperations)assert.ok(result.operations.some(value=>value.operation===operation&&value.phase==='shared:setup:expand'),'missing real setup subphase '+operation);
      assert.ok(state.trace.some(event=>event.type==='pointerdown'&&event.target?.includes('#mini-title')&&event.trusted),'measurement starts on the real mini title');assert.ok(state.trace.every(event=>event.trusted),'all motion/readback input is trusted');
      assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>PA.Engine.wantsPlayback()),false);
      return report;
    };
    const track=await page.evaluate(()=>PA.Engine.current.id);
    for(const [index,label] of ['first-mini-tap','warm-1-mini-tap','warm-2-mini-tap'].entries()){
      if(index)await library();const origin=await target();await measure(label,async()=>{await start(origin.x,origin.y);await end();assert.equal(await page.evaluate(()=>PA.Nav.cur),'player');return {};});
    }
    await library();let origin=await target();
    await measure('held-mini-drag',async()=>{
      await start(origin.x,origin.y);for(const displacement of [16,40,75,110]){await move(origin.x,origin.y-displacement);await frame();}
      const scene=await sceneEvidence();assert.equal(await page.evaluate(()=>PA.Nav.cur),'list');await end();assert.equal(await page.evaluate(()=>PA.Nav.cur),'player');return {scene};
    });
    await library();origin=await target();
    await measure('regrab-mini-settle',async()=>{
      await start(origin.x,origin.y);await move(origin.x,origin.y-110);await frame();await end();assert.equal(await page.evaluate(()=>PA.Nav.cur),'player');await start(3,100);
      const frozen=await page.locator('.player-scene-art').boundingBox();assert.ok(frozen);await page.waitForTimeout(280);const held=await page.locator('.player-scene-art').boundingBox();assert.ok(held);
      for(const key of ['x','y','width','height'])assert.ok(Math.abs(frozen[key]-held[key])<=.05,'real regrab holds '+key+' beyond settle');
      const scene=await sceneEvidence(),trace=await page.evaluate(()=>fixtureInputTrace);assert.ok(trace.some(event=>event.type==='pointerdown'&&event.target?.includes('player-scene-input')&&event.trusted),'real transient plane owns regrab');await end();return {scene,frozen,held};
    });
    assert.equal(await page.evaluate(()=>PA.Engine.current.id),track);group.errors=errors;return group;
  }catch(error){await reportFixtureFailure({page,diagnostics},error,'preview-setup-failure-'+count+'-'+mode);throw error;}
  finally{await context.close();}
}

test('Poweramp isolated same-candidate exhaustive versus compact setup timings',{timeout:180000},async t=>{
  assert.ok(executablePath,'Chromium is required: install it or set JARVIS_CHROME');
  const directory=await mkdtemp(join(tmpdir(),'poweramp-setup-paired-'));let browser;
  try{
    const built=await buildPreview(join(directory,'preview.html'));browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
    for(const count of [60,5000])await t.test(count+' tracks, serial cold/warm taps and trusted held/regrab',async()=>{
      const order=count===60?['baseline','compact']:['compact','baseline'];
      const evidence={source:built.sourceHash,previewSha256:built.sha256,tracks:count,profile,order,metric:'Inclusive synchronous operations and instrumented-child-excluded self times. Nested totals overlap. RAF gaps are callback gaps, not phone FPS, GPU time or touch latency.',groups:[]};
      for(const mode of order)await measureGroup(browser,built,count,mode,evidence);
      evidence.comparison=compareSetupModes(evidence.groups);await saveEvidence('preview-setup-paired-'+count,evidence);
      const modes=Object.fromEntries(evidence.groups.map(group=>[group.mode,group]));
      for(const label of ['held-mini-drag','regrab-mini-settle']){
        const baseline=modes.baseline.reports.find(report=>report.label===label).scene,compact=modes.compact.reports.find(report=>report.label===label).scene;
        assert.equal(compact.clonedNodes,baseline.clonedNodes,label+' uses the same real clone topology');assert.ok(compact.cssCharacters<baseline.cssCharacters*.7,label+' compact CSS stays below unchanged visual reduction gate');
      }
      t.diagnostic('POWERAMP_PAIRED_SETUP '+JSON.stringify({source:built.sourceHash,tracks:count,comparison:evidence.comparison}));
      const create=evidence.comparison.operations['shared.create'];
      assert.ok(evidence.comparison.materiallyImproved,'actual create median and warm median must each be <= '+setupImprovementLimit+' of exhaustive baseline; got '+JSON.stringify({medianRatio:create.medianRatio,warmRatio:create.warmRatio}));
    });
  }finally{await browser?.close();await rm(directory,{recursive:true,force:true});}
});
