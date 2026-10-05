import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {buildPreview} from '../scripts/build-poweramp-preview.mjs';
import {fixtureSceneSettled,installFixtureInputTrace,reportFixtureFailure} from './helpers/poweramp-fixture.js';
import {median,setupImprovementLimit,setupOperations} from './helpers/poweramp-performance.js';

// Deliberately outside tests/*.test.js: run this required test in its own CI
// step after the aggregate suite, without competing Chromium test processes.
const profile={viewport:{width:519,height:988},deviceScaleFactor:2.0818214416503906,isMobile:true,hasTouch:true};
const executablePath=[process.env.JARVIS_CHROME,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome',chromium.executablePath()].find(path=>path&&existsSync(path));
const setupPhase='shared:setup:expand',requiredOperations=['shared.create','shared.clone','shared.copyCanvas','shared.appearance'];
const measuredOperations=[...setupOperations,'shared.appearance'];
const hash=value=>createHash('sha256').update(value).digest('hex');
async function saveEvidence(name,value){
  if(!process.env.POWERAMP_EVIDENCE_DIR)return;
  const directory=resolve(process.env.POWERAMP_EVIDENCE_DIR);await mkdir(directory,{recursive:true});await writeFile(join(directory,name+'.json'),JSON.stringify(value,null,2)+'\n');
}
function setupMetric(report,key){
  const values=report.operations.filter(operation=>operation.operation===key&&operation.phase===setupPhase);
  assert.ok(values.length<=1,'diagnostics aggregates a setup operation once');
  if(!values.length){
    assert.ok(!requiredOperations.includes(key),'missing real setup subphase '+key);
    // Preparation can call snapshotCSS in idle. Zero here means no call in the
    // expansion setup phase, never a fabricated zero for an observed call.
    return {calls:0,total_ms:0,self_ms:0,notCalledInSetup:true,otherPhases:report.operations.filter(operation=>operation.operation===key).map(operation=>({phase:operation.phase,calls:operation.calls,total_ms:operation.total_ms,self_ms:operation.self_ms}))};
  }
  const value=values[0];assert.ok(Number.isInteger(value.calls)&&value.calls>0,'observed setup calls '+key);
  for(const field of ['total_ms','self_ms'])assert.ok(Number.isFinite(value[field])&&value[field]>=0,'valid '+field+' for '+key);
  return {...value,notCalledInSetup:false};
}
function compareAppearanceModes(groups){
  const modes=Object.fromEntries(groups.map(group=>[group.mode,group]));
  assert.ok(modes.baseline&&modes.prepared,'both exhaustive baseline and prepared groups are required');
  const result={limit:setupImprovementLimit,scope:'Same candidate, exhaustive CSS in both modes and serial fresh browser contexts. Cold is forcibly invalidated immediately before input. Only the two paused prepared-repeat create samples are gated against the matching exhaustive-cold baseline repeats. Live-playing samples are reported separately. These synchronous times are not phone FPS or touch latency.',operations:{}};
  for(const key of measuredOperations){
    const summary=Object.fromEntries(['baseline','prepared'].map(mode=>{
      const taps=['first-mini-tap','warm-1-mini-tap','warm-2-mini-tap'].map(label=>{
        const values=modes[mode].reports.filter(report=>report.label===label);assert.equal(values.length,1,'one measured sample '+mode+' '+label);return setupMetric(values[0],key);
      });
      return [mode,{cold:taps[0],repeats:taps.slice(1),repeat_median_ms:median(taps.slice(1).map(value=>value.total_ms)),repeat_self_median_ms:median(taps.slice(1).map(value=>value.self_ms))}];
    }));
    result.operations[key]={...summary,coldRatio:summary.baseline.cold.total_ms?summary.prepared.cold.total_ms/summary.baseline.cold.total_ms:null,warmRatio:summary.baseline.repeat_median_ms?summary.prepared.repeat_median_ms/summary.baseline.repeat_median_ms:null};
  }
  result.materiallyImproved=result.operations['shared.create'].warmRatio!==null&&result.operations['shared.create'].warmRatio<=setupImprovementLimit;
  const playing=modes.prepared.reports.filter(report=>report.playing);
  result.livePlaying={scope:'One real simulated Engine.play()/pause() cold and one prepared held expansion, not a repeat median or a general performance guarantee.',samples:playing.map(report=>({label:report.label,cacheConsumedHits:report.cacheConsumedHits,cacheColdCaptures:report.cacheColdCaptures,preparation:report.preparation,create:setupMetric(report,'shared.create'),dynamic:report.scene?.dynamic}))};
  return result;
}
async function measureGroup(browser,built,count,mode,evidence){
  const baseline=mode==='baseline',context=await browser.newContext(profile),page=await context.newPage(),errors=[],reports=[];
  const group={mode,baseline,previewSha256:built.sha256,reports};evidence.groups.push(group);
  page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>/^https?:/.test(route.request().url())?route.abort('blockedbyclient'):route.continue());
  await context.addInitScript(installFixtureInputTrace);
  const diagnostics=()=>page.evaluate(()=>({screen:PA.Nav.cur,scene:!!document.querySelector('.player-scene-layer'),trace:fixtureInputTrace,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},sheet:{...window.fixtureSetupSheet,enabled:!document.styleSheets[0].disabled},appearance:window.powerampPreview?.appearanceStatus(),playing:PA.Engine.playing,wantsPlayback:PA.Engine.wantsPlayback()})).then(state=>({...state,mode,errors}));
  try{
    await page.goto(pathToFileURL(built.output).href);await page.waitForFunction(()=>window.powerampPreview?.ready);
    assert.equal(await page.locator('meta[name="poweramp-preview-source-sha256"]').getAttribute('content'),built.sourceHash);
    if(count===5000){await page.locator('#preview-size').tap();await page.waitForFunction(()=>powerampPreview.ready&&powerampPreview.count===5000);}
    await page.evaluate(()=>document.fonts.ready);
    const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(done)));
    const settled=async screen=>{await page.waitForFunction(fixtureSceneSettled,screen);await frame();await frame();};
    const quiet=async()=>{await page.waitForFunction(()=>document.getAnimations().every(animation=>animation.playState==='finished'||animation.playState==='idle'));await frame();await frame();};
    const library=async()=>{await page.locator('[data-nav="library"]').tap();await settled('library');await page.getByRole('button',{name:'All Songs',exact:true}).tap();await settled('list');await quiet();};
    // Navigation has already created a collapse scene. Cold here concerns the
    // one-use appearance cache, not browser code, font, artwork or raster caches.
    await settled('player');await library();
    group.stylesheetSha256=hash(await page.evaluate(baseline=>{
      const sheet=document.styleSheets[0],descriptor=Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype,'cssRules');
      if(!sheet||!descriptor?.get)throw Error('Expected a real readable preview stylesheet');
      const nativeCSS=()=>Array.from(descriptor.get.call(sheet),rule=>rule.cssText).join('\n');
      const rules=descriptor.get.call(sheet).length;window.fixtureSetupSheet={baseline,enabled:!sheet.disabled,rules,reads:0,blockedReads:0};
      window.fixtureSetupReadNativeCSS=nativeCSS;
      Object.defineProperty(sheet,'cssRules',{configurable:true,get(){fixtureSetupSheet.reads++;if(baseline){fixtureSetupSheet.blockedReads++;throw new DOMException('Test-only appearance preparation blocker','SecurityError');}return descriptor.get.call(this);}});
      // Invalidate any preparation from navigation, while leaving the actual
      // enabled stylesheet and every rendered declaration unchanged.
      document.querySelector('#mini-title').setAttribute('data-fixture-appearance-probe','armed');return nativeCSS();
    },baseline));
    if(baseline){
      await page.waitForFunction(()=>fixtureSetupSheet.blockedReads>0);
      group.preparationBlocked=await page.evaluate(()=>({...fixtureSetupSheet,appearance:powerampPreview.appearanceStatus()}));
      assert.equal(group.preparationBlocked.appearance.ready,false,'unreadable CSS prevents baseline preparation');
    }
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
      const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
      const nodes=[layer,...layer.querySelectorAll('*')],artAppearances=layer.querySelectorAll('.player-scene-art-appearance');
      const progress=Number(artAppearances[1]?.style.opacity);if(!Number.isFinite(progress)||progress<=0||progress>=1)throw Error('Expected a real intermediate painted expansion');
      const serialized=nodes.map((node,index)=>{
        // These exact properties are written by SharedPlayerMotion.paint.
        // Preserve all other serialized CSS; retain the removed values and
        // geometry so the exception is measured, limited and reviewable.
        const owned=new Set();
        if(node.matches('.player-scene-surface,.player-scene-reveal,.player-scene-art')){owned.add('transform');owned.add('border-radius');}
        if(node.matches('.player-scene-background,.player-scene-full,.player-scene-part')){owned.add('transform');owned.add('opacity');}
        if(node.matches('.player-scene-art-appearance')||node.parentElement?.matches('.player-scene-art')&&node.matches('.art-ov'))owned.add('opacity');
        const style=document.createElement('span').style;style.cssText=node.style.cssText;
        const progressOwned={};for(const key of owned){progressOwned[key]=style.getPropertyValue(key);style.removeProperty(key);}
        return {index,tag:node.tagName,classes:node.getAttribute('class')||'',css:node.style.cssText,invariantCSS:style.cssText,progressOwned,rect:rect(node)};
      });
      const miniSource=document.querySelector('#mini-fill'),miniCopy=layer.querySelector('.mini-seek.player-scene-part .fill');
      const currentSource=document.querySelector('#t-cur'),currentCopy=layer.querySelector('.player-scene-full .timepill');
      const dynamic={miniFill:{source:miniSource?.style.transform,copy:miniCopy?.style.transform,sourceComputed:miniSource?getComputedStyle(miniSource).transform:null,copyComputed:miniCopy?getComputedStyle(miniCopy).transform:null},currentTime:{source:currentSource?.textContent,copy:currentCopy?.textContent},engineTime:PA.Engine.time(),playing:PA.Engine.playing,wantsPlayback:PA.Engine.wantsPlayback()};
      return {cssCharacters:nodes.reduce((sum,node)=>sum+node.style.cssText.length,0),clonedNodes:nodes.length,progress,serialized,dynamic};
    });
    const measure=async(label,action,{warm=mode==='prepared'&&label!=='first-mini-tap',playing=false,cold=label==='first-mini-tap'}={})=>{
      const before=await page.evaluate(()=>({...fixtureSetupSheet}));
      await page.locator('#preview-help').tap();await page.getByRole('button',{name:'Measure 30 seconds',exact:true}).tap();await page.waitForFunction(()=>document.querySelector('#preview-help').textContent==='●'&&!PA.Sheets.open);
      if(playing){
        await page.evaluate(()=>PA.Engine.play());
        await page.waitForFunction(()=>PA.Engine.playing&&PA.Engine.wantsPlayback()&&!PA.Engine.el().paused);
      }
      let preparation=null;
      if(warm){
        const at=performance.now();group.waitingFor={label,appearance:await page.evaluate(()=>powerampPreview.appearanceStatus()),playing};await saveEvidence('preview-setup-paired-'+count,evidence);
        await page.waitForFunction(()=>powerampPreview.appearanceStatus().ready);
        preparation={wait_ms:Math.round(performance.now()-at),status:await page.evaluate(()=>powerampPreview.appearanceStatus()),playing:await page.evaluate(()=>PA.Engine.playing)};
        assert.ok(preparation.status.ready,'prepared sample waits for actual production readiness');
      }
      await page.evaluate(()=>{window.fixtureInputTrace=[];});await frame();
      // Readiness is requested only after diagnostics starts and Help closes.
      // Cold invalidation is the final page action before trusted touch input;
      // it never waits for preparation or calls a hidden runtime function.
      const appearanceBefore=await page.evaluate(cold=>{
        const status=powerampPreview.appearanceStatus();let invalidation=null;
        if(cold){const node=document.querySelector('#mini-title'),attribute='data-fixture-appearance-cold',value=String(Number(node.getAttribute(attribute)||0)+1);node.setAttribute(attribute,value);invalidation={target:'#mini-title',attribute,value};}
        return {...status,invalidation};
      },cold);
      if(warm)assert.equal(appearanceBefore.ready,true,'prepared appearance remains ready until input');
      if(baseline)assert.equal(appearanceBefore.ready,false,'baseline has no ready appearance cache');
      const detail=await action();await settled('player');
      const appearanceAfter=await page.evaluate(()=>powerampPreview.appearanceStatus());
      await page.locator('#preview-help').click();await page.getByRole('button',{name:'Show diagnostics',exact:true}).click();
      const result=JSON.parse(await page.locator('#preview-diagnostics-report').inputValue());await page.getByRole('button',{name:'Close',exact:true}).click();
      const state=await diagnostics(),appearanceEvents=result.events.filter(event=>event.type==='appearance-cache'),cacheConsumedHits=appearanceAfter.hits-appearanceBefore.hits,cacheColdCaptures=appearanceAfter.cold-appearanceBefore.cold;
      const report={label,...result,...detail,playing,intendedCache:warm?'prepared':'cold',preparation,appearanceBefore,appearanceAfter,appearanceEvents,cacheConsumedHits,cacheColdCaptures,sheetBefore:before,sheetAfter:state.sheet,trace:state.trace};reports.push(report);delete group.waitingFor;
      // Preserve completed samples before an assertion can reject the group.
      await saveEvidence('preview-setup-paired-'+count,evidence);
      assert.equal(result.source,built.sourceHash);assert.equal(result.tracks,count);assert.equal(result.final.screen,'player');assert.equal(result.final.scene,null);
      assert.ok(state.sheet.enabled,'the same real stylesheet stays enabled');
      assert.equal(hash(await page.evaluate(()=>fixtureSetupReadNativeCSS())),group.stylesheetSha256,'native serialized stylesheet is unchanged');
      assert.equal(appearanceEvents.length,1,'one actual appearance consumption is observed');assert.equal(appearanceEvents[0].mode,'exhaustive','cold and prepared both capture exhaustive CSS');
      assert.equal(appearanceEvents[0].hits,appearanceAfter.hits);assert.equal(appearanceEvents[0].cold,appearanceAfter.cold);
      assert.equal(cacheConsumedHits,warm?1:0,warm?'intended warm action consumes a prepared hit':'cold action must consume no prepared hit');assert.equal(cacheColdCaptures,warm?0:1,'actual cache consumption matches the requested path');
      if(warm)assert.ok(state.sheet.reads>before.reads,'prepared setup validates the same readable stylesheet');
      const plans=result.events.filter(event=>event.type==='snapshot-plan');assert.ok(plans.every(event=>event.active===false),'no compact plan is active');
      for(const operation of measuredOperations)setupMetric(report,operation);
      assert.equal(setupMetric(report,'shared.create').calls,1,'one real expansion creation');assert.equal(setupMetric(report,'shared.appearance').calls,1,'one real expansion appearance consumption');
      assert.ok(state.trace.some(event=>event.type==='pointerdown'&&event.target?.includes('#mini-title')&&event.trusted),'measurement starts on the real mini title');assert.ok(state.trace.every(event=>event.trusted),'all motion/readback input is trusted');
      assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>PA.Engine.wantsPlayback()),playing);
      return report;
    };
    const track=await page.evaluate(()=>PA.Engine.current.id);
    for(const [index,label] of ['first-mini-tap','warm-1-mini-tap','warm-2-mini-tap'].entries()){
      if(index)await library();const origin=await target();await measure(label,async()=>{await start(origin.x,origin.y);await end();assert.equal(await page.evaluate(()=>PA.Nav.cur),'player');return {};});
    }
    const heldDrag=async origin=>{
      await start(origin.x,origin.y);for(const displacement of [16,40,75,110]){await move(origin.x,origin.y-displacement);await frame();}
      const scene=await sceneEvidence();assert.equal(await page.evaluate(()=>PA.Nav.cur),'list');await end();assert.equal(await page.evaluate(()=>PA.Nav.cur),'player');return {scene};
    };
    await library();let origin=await target();await measure('held-mini-drag',()=>heldDrag(origin));
    await library();origin=await target();
    await measure('regrab-mini-settle',async()=>{
      await start(origin.x,origin.y);await move(origin.x,origin.y-110);await frame();await end();assert.equal(await page.evaluate(()=>PA.Nav.cur),'player');await start(3,100);
      const frozen=await page.locator('.player-scene-art').boundingBox();assert.ok(frozen);await page.waitForTimeout(280);const held=await page.locator('.player-scene-art').boundingBox();assert.ok(held);
      for(const key of ['x','y','width','height'])assert.ok(Math.abs(frozen[key]-held[key])<=.05,'real regrab holds '+key+' beyond settle');
      const scene=await sceneEvidence(),trace=await page.evaluate(()=>fixtureInputTrace);assert.ok(trace.some(event=>event.type==='pointerdown'&&event.target?.includes('player-scene-input')&&event.trusted),'real transient plane owns regrab');await end();return {scene,frozen,held};
    });
    if(!baseline)for(const warm of [false,true]){
      await library();origin=await target();
      try{
        const report=await measure('live-playing-'+(warm?'prepared':'cold')+'-mini-drag',()=>heldDrag(origin),{playing:true,warm,cold:!warm});
        const dynamic=report.scene.dynamic;assert.equal(dynamic.playing,true);assert.equal(dynamic.wantsPlayback,true);assert.ok(dynamic.engineTime>0,'real simulated playback advances');
        assert.equal(typeof dynamic.miniFill.source,'string');assert.ok(dynamic.miniFill.source,'live mini fill has actual progress');assert.equal(dynamic.miniFill.copyComputed,dynamic.miniFill.sourceComputed,'held cloned mini-fill transform matches live source');
        assert.equal(dynamic.currentTime.copy,dynamic.currentTime.source,'held cloned t-cur matches live source');assert.ok(dynamic.currentTime.source,'live current time is present');
      }finally{await page.evaluate(()=>PA.Engine.pause());await page.waitForFunction(()=>!PA.Engine.wantsPlayback()&&PA.Engine.el().paused);}
    }
    assert.equal(await page.evaluate(()=>PA.Engine.current.id),track);assert.equal(await page.evaluate(()=>PA.Engine.wantsPlayback()),false);group.errors=errors;return group;
  }catch(error){group.failure={error:String(error),state:await diagnostics().catch(()=>null)};await saveEvidence('preview-setup-paired-'+count,evidence);await reportFixtureFailure({page,diagnostics},error,'preview-setup-failure-'+count+'-'+mode);throw error;}
  finally{await context.close();}
}

test('appearance timing summary separates forced cold and prepared repeats without inventing setup calls',()=>{
  const group=(mode,times)=>({mode,reports:times.map((time,index)=>({label:['first-mini-tap','warm-1-mini-tap','warm-2-mini-tap'][index],operations:requiredOperations.map(operation=>({operation,phase:setupPhase,calls:1,total_ms:time,self_ms:time/2}))}))});
  const summary=compareAppearanceModes([group('baseline',[10,100,100]),group('prepared',[300,70,70])]);
  assert.equal(summary.materiallyImproved,true);assert.equal(summary.operations['shared.create'].coldRatio,30);assert.equal(summary.operations['shared.create'].warmRatio,.7);
  assert.equal(summary.operations['shared.snapshotPlan'].prepared.cold.notCalledInSetup,true);assert.equal(summary.operations['shared.snapshotCSS'].prepared.repeat_median_ms,0);
  assert.equal(compareAppearanceModes([group('baseline',[300,100,100]),group('prepared',[10,90,90])]).materiallyImproved,false,'cold-only benefit cannot hide slow prepared repeats');
  const measured={operations:[{operation:'shared.snapshotCSS',phase:setupPhase,calls:3,total_ms:9,self_ms:8}]};assert.equal(setupMetric(measured,'shared.snapshotCSS').total_ms,9,'an actual setup call is never replaced with zero');
  const idle={operations:[{operation:'shared.snapshotCSS',phase:'idle',calls:3,total_ms:9,self_ms:8}]};assert.equal(setupMetric(idle,'shared.snapshotCSS').total_ms,0);assert.equal(setupMetric(idle,'shared.snapshotCSS').otherPhases[0].total_ms,9,'idle preparation remains separately visible');
  assert.throws(()=>setupMetric({operations:[]},'shared.create'),/missing real setup/);
});

test('Poweramp isolated same-candidate exhaustive cold versus prepared appearance setup timings',{timeout:180000},async t=>{
  assert.ok(executablePath,'Chromium is required: install it or set JARVIS_CHROME');
  const directory=await mkdtemp(join(tmpdir(),'poweramp-setup-paired-'));let browser;
  try{
    const built=await buildPreview(join(directory,'preview.html'));assert.equal(hash(await readFile(built.output)),built.sha256,'measured HTML exactly matches the generated hash');browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
    for(const count of [60,5000])await t.test(count+' tracks, forced cold/prepared taps, trusted held/regrab and live playback',async()=>{
      const order=count===60?['baseline','prepared']:['prepared','baseline'];
      const evidence={source:built.sourceHash,previewSha256:built.sha256,tracks:count,profile,order,metric:'Inclusive synchronous operations and instrumented-child-excluded self times. Nested totals overlap. RAF gaps are callback gaps, not phone FPS, GPU time or touch latency. Idle preparation and forced cold are separate from prepared repeat setup.',groups:[]};
      for(const mode of order)await measureGroup(browser,built,count,mode,evidence);
      evidence.comparison=compareAppearanceModes(evidence.groups);await saveEvidence('preview-setup-paired-'+count,evidence);
      const modes=Object.fromEntries(evidence.groups.map(group=>[group.mode,group]));assert.equal(modes.prepared.stylesheetSha256,modes.baseline.stylesheetSha256,'both modes paint the identical enabled stylesheet');
      for(const label of ['held-mini-drag','regrab-mini-settle']){
        const baseline=modes.baseline.reports.find(report=>report.label===label).scene,prepared=modes.prepared.reports.find(report=>report.label===label).scene;
        assert.equal(prepared.clonedNodes,baseline.clonedNodes,label+' uses the same real clone topology');
        assert.deepEqual(prepared.serialized.map(({tag,classes})=>({tag,classes})),baseline.serialized.map(({tag,classes})=>({tag,classes})),label+' preserves every clone tag and class');
        assert.deepEqual(prepared.serialized.map(node=>node.invariantCSS),baseline.serialized.map(node=>node.invariantCSS),label+' preserves identical serialized CSS except the explicitly measured motion-progress properties');
      }
      t.diagnostic('POWERAMP_PAIRED_SETUP '+JSON.stringify({source:built.sourceHash,previewSha256:built.sha256,tracks:count,comparison:evidence.comparison}));
      const create=evidence.comparison.operations['shared.create'];assert.ok(evidence.comparison.materiallyImproved,'actual paused prepared-repeat create median must be <= '+setupImprovementLimit+' of exhaustive baseline repeats; cold is reported separately; got '+JSON.stringify({coldRatio:create.coldRatio,warmRatio:create.warmRatio}));
      assert.equal(hash(await readFile(built.output)),built.sha256,'HTML remains exact after both contexts');
    });
  }finally{await browser?.close();await rm(directory,{recursive:true,force:true});}
});
