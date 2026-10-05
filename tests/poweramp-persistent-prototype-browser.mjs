import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildPreview} from '../scripts/build-poweramp-preview.mjs';
import {chromium} from 'playwright-core';
import {compareScreenshotPNG} from './helpers/poweramp-png.js';
const profile={viewport:{width:519,height:988},deviceScaleFactor:2.0818214416503906,isMobile:true,hasTouch:true};
const executablePath=[process.env.JARVIS_CHROME,'/usr/bin/chromium','/usr/bin/google-chrome',chromium.executablePath()].find(p=>p&&existsSync(p));
const names=['index.html','audio-analysis.js','audio-core.js','player.js'];
const baselineRef=process.env.POWERAMP_BASELINE_REF||'HEAD';
const evidenceDir=resolve(process.env.POWERAMP_EVIDENCE_DIR||'/tmp/poweramp-persistent-evidence');
async function save(name,value){await mkdir(evidenceDir,{recursive:true});await writeFile(join(evidenceDir,name),Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n');}
async function build(directory,baseline){
  const inputs=baseline?names.map(name=>execFileSync('git',['show',baselineRef+':public/drawercast/'+name],{encoding:'utf8',maxBuffer:4_000_000})):await Promise.all(names.map(name=>readFile(new URL('../public/drawercast/'+name,import.meta.url),'utf8')));
  const output=join(directory,baseline?'v7.html':'persistent.html'),result=await buildPreview(output,{inputs});
  let html=await readFile(output,'utf8');html=html.replace('window.PA = {','window.fixtureMotion=SharedPlayerMotion;window.fixtureScene=ScreenDrag;window.fixtureLifecycle=InputLifecycle;window.PA = {');await writeFile(output,html);
  return result;
}
async function open(browser,built,theme){
  const context=await browser.newContext(profile),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
  await context.route('**/*',route=>/^https?:/.test(route.request().url())?route.abort('blockedbyclient'):route.continue());
  await page.goto(pathToFileURL(built.output).href);await page.waitForFunction(()=>window.powerampPreview?.ready);await page.locator('#preview-size').tap();await page.waitForFunction(()=>powerampPreview.ready&&powerampPreview.count===5000);
  await page.evaluate(theme=>{PA.SET.uiTheme=theme;PA.SET.playerLayout='classic';PA.SET.bgBlur=5;PA.SET.vizOnPlayer=false;PA.SET.animations='default';PA.NativeSettings.values.list_header_buttons=1;PA.applySettings();PA.Engine.seek(42);PA.UI.renderProgress();},theme);
  await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>!!document.querySelector('#bg-art').style.backgroundImage);await page.waitForTimeout(700);
  const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  const point=(x,y)=>({id:1,x,y,radiusX:1,radiusY:1,force:1}),start=(x,y)=>cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(x,y)]}),move=(x,y)=>cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point(x,y)]}),end=()=>cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(done)));
  const settled=async screen=>{await page.waitForFunction(screen=>PA.Nav.cur===screen&&!fixtureScene.state&&!fixtureScene.settling&&!PA.LibraryPageMotion.state&&!PA.LibraryPageMotion.finish&&!fixtureLifecycle.gesture&&!document.querySelector('.player-scene-input'),screen);await page.waitForFunction(screen=>{const root=document.querySelector('#sc-'+screen),mini=document.querySelector('#mini');return Number(getComputedStyle(root).opacity)>.9999&&(screen==='player'||Number(getComputedStyle(mini).opacity)>.9999);},screen);await frame();};
  const center=selector=>page.locator(selector).evaluate(n=>{const r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
  const library=async()=>{await page.locator('[data-nav="library"]').tap();await settled('library');await page.getByRole('button',{name:'All Songs',exact:true}).tap();await settled('list');};
  await page.evaluate(()=>{
    const probe=window.fixtureProbe={operations:[],active:0,clones:0,deepClones:0,styleEnumerations:0,propertyReads:0,cssRulesReads:0,creates:0};
    const clone=Node.prototype.cloneNode;Node.prototype.cloneNode=function(deep){if(probe.active){probe.clones++;if(deep)probe.deepClones++;}return clone.call(this,deep);};
    const computed=window.getComputedStyle;window.getComputedStyle=(...args)=>{const style=computed(...args);if(!probe.active)return style;return new Proxy(style,{get(target,key){if(key==='length')probe.styleEnumerations++;if(key==='getPropertyValue')return name=>{probe.propertyReads++;return target.getPropertyValue(name);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
    const cssRules=Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype,'cssRules');Object.defineProperty(CSSStyleSheet.prototype,'cssRules',{configurable:true,get(){if(probe.active)probe.cssRulesReads++;return cssRules.get.call(this);}});
    for(const key of ['create','paint','clean']){const original=fixtureMotion[key];fixtureMotion[key]=function(...args){const before={clones:probe.clones,deepClones:probe.deepClones,styleEnumerations:probe.styleEnumerations,propertyReads:probe.propertyReads,cssRulesReads:probe.cssRulesReads};probe.active++;const at=performance.now();try{return original.apply(this,args);}finally{const elapsed=performance.now()-at;probe.active--;probe.operations.push({operation:key,direction:args[0]?.target==='player'||args[0]?.opening?'expand':'collapse',ms:elapsed,...Object.fromEntries(Object.keys(before).map(k=>[k,probe[k]-before[k]]))});if(key==='create')probe.creates++;}};}
  });
  return {context,page,errors,cdp,start,move,end,frame,settled,center,library};
}
async function visible(h){
  const result=await h.page.evaluate(()=>{const n=document.querySelector('#sc-list'),s=getComputedStyle(n),r=n.getBoundingClientRect(),mini=document.querySelector('#mini'),m=getComputedStyle(mini);return {screen:PA.Nav.cur,hidden:n.hidden,inert:n.inert,visibility:s.visibility,opacity:s.opacity,transform:s.transform,covered:n.classList.contains('library-page-covered'),rows:[...document.querySelectorAll('#list-body .trow')].filter(n=>{const b=n.getBoundingClientRect();return b.width>0&&b.height>0&&b.bottom>0&&b.top<innerHeight;}).length,width:r.width,height:r.height,mini:{hidden:mini.hidden,opacity:m.opacity,visibility:m.visibility},plane:!!document.querySelector('.player-scene-input'),historyHost:document.querySelector('#library-page-motion').hidden};});
  assert.equal(result.screen,'list');assert.equal(result.hidden,false);assert.equal(result.inert,false);assert.equal(result.visibility,'visible');assert.equal(result.opacity,'1');assert.equal(result.covered,false);assert.ok(result.rows>0);assert.ok(result.width>0&&result.height>0);assert.equal(result.mini.hidden,false);assert.equal(result.mini.opacity,'1');assert.equal(result.mini.visibility,'visible');assert.equal(result.plane,false);assert.equal(result.historyHost,true);return result;
}
async function measure(h,label,perform){await h.page.evaluate(()=>{fixtureProbe.operations=[];fixtureMotion.clearAppearance();});await perform();return {label,...await h.page.evaluate(()=>({operations:fixtureProbe.operations,screen:PA.Nav.cur}))};}
async function timings(h,results=[]){
  await h.library();
  for(const label of ['first-tap','repeat-tap','repeat-playing']){
    if(label==='repeat-playing')await h.page.evaluate(()=>PA.Engine.play());
    const point=await h.center('#mini-title');results.push(await measure(h,label,async()=>{await h.start(point.x,point.y);await h.end();await h.settled('player');}));
    const art=await h.center('#artA');results.push(await measure(h,label+'-collapse',async()=>{await h.start(art.x,art.y);await h.move(art.x,art.y+169);await h.frame();await h.end();await h.settled('list');}));await visible(h);
  }
  await h.page.evaluate(()=>{PA.Engine.pause();PA.Engine.seek(42);PA.UI.renderProgress();});
  return results;
}
async function hold(h,p){await h.library();const origin=await h.center('#mini-title'),height=await h.page.locator('#sc-list').evaluate(n=>n.clientHeight);await h.start(origin.x,origin.y);await h.move(origin.x,origin.y-16);await h.frame();await h.move(origin.x,origin.y-height*p);await h.frame();return {origin,height};}
async function snapshot(h,label){
  const state=await h.page.evaluate(()=>{const m=(fixtureScene.state||fixtureScene.settling)?.morph;if(!m)throw Error('No shared morph');const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};};const geometry=m.captureMode?{}:{};
    for(const key of ['art','title','sub','play','seek']){if(m.mask){geometry[key+'-mini']=rect(m.pairs[key].mini);geometry[key+'-full']=rect(m.pairs[key].full);}else if(key==='art'){geometry['art-mini']=geometry['art-full']=rect(m.art);}else{geometry[key+'-mini']=rect(m.pairs[key].mini);geometry[key+'-full']=rect(m.pairs[key].full);}}
    geometry.surface=rect(m.mask||m.surface);return {p:m.p,endpoints:m.endpoints,geometry,track:PA.Engine.current.id,time:PA.Engine.time()};});
  return {label,state,png:await h.page.screenshot({fullPage:false,animations:'allow',scale:'device'})};
}
async function shots(h){
  const results=[],{origin,height}=await hold(h,.25);for(const p of [.25,.5,.75]){if(p!==.25){await h.move(origin.x,origin.y-height*p);await h.frame();}results.push(await snapshot(h,'held-'+p));}
  await h.end();await h.settled('player');await h.library();const contact=await hold(h,.25);await h.end();await h.start(3,500);
  const frozen=await h.page.evaluate(()=>(fixtureScene.state||fixtureScene.settling).morph.p);await h.move(3,500-(.5-frozen)*contact.height);await h.frame();results.push(await snapshot(h,'regrab-0.5'));const after=await snapshot(h,'regrab-held');await h.page.waitForTimeout(120);const later=await snapshot(h,'regrab-later');for(const key of ['left','top','width','height'])assert.ok(Math.abs(after.state.geometry['art-full'][key]-later.state.geometry['art-full'][key])<.05,'frozen regrab '+key);await h.end();await h.settled('player');return results;
}
test('persistent live-node prototype: exact-profile 4x CPU cold/repeat/collapse/regrab and paired pixels',{timeout:240000},async t=>{
  assert.ok(executablePath,'Chrome is mandatory');const directory=await mkdtemp(join(tmpdir(),'persistent-prototype-'));let browser;
  const failures=[];const report={profile,cpuThrottling:4,baselineRef,thresholds:{setupMaxMs:33,deepClones:0,styleEnumerations:0,cssRulesReads:0,geometryTolerance:.05,pixelChangedFraction:.0005,pixelMeanDelta:.05},results:[]};
  try{
    const baseline=await build(directory,true),candidate=await build(directory,false);report.sources={baseline:baseline.sourceHash,candidate:candidate.sourceHash};browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
    for(const theme of ['dark','light']){
      const a=await open(browser,baseline,theme),b=await open(browser,candidate,theme);const group={theme};report.results.push(group);
      try{group.baselineTimings=[];await timings(a,group.baselineTimings);group.candidateTimings=[];await timings(b,group.candidateTimings);t.diagnostic('POWERAMP_PERSISTENT_TIMINGS '+JSON.stringify({theme,sources:report.sources,baseline:group.baselineTimings,candidate:group.candidateTimings}));await save('persistent-prototype-report.json',report);
        await a.page.evaluate(()=>{fixtureProbe.operations=[];});await b.page.evaluate(()=>{fixtureProbe.operations=[];});const oldShots=await shots(a),newShots=await shots(b);group.heldRegrab={baseline:await a.page.evaluate(()=>fixtureProbe.operations),candidate:await b.page.evaluate(()=>fixtureProbe.operations)};group.pairs=[];
        for(let i=0;i<oldShots.length;i++){const old=oldShots[i],next=newShots[i],pixels=compareScreenshotPNG(old.png,next.png);const pair={label:old.label,baseline:old.state,candidate:next.state,pixels};group.pairs.push(pair);await save('persistent-'+theme+'-'+old.label+'-v7.png',old.png);await save('persistent-'+theme+'-'+old.label+'-live.png',next.png);await save('persistent-prototype-report.json',report);
          for(const key of Object.keys(old.state.geometry))for(const property of ['left','top','width','height'])if(Math.abs(old.state.geometry[key][property]-next.state.geometry[key][property])>.05)failures.push(theme+' '+old.label+' '+key+'.'+property+': '+old.state.geometry[key][property]+' vs '+next.state.geometry[key][property]);
          if(pixels.changedFraction>report.thresholds.pixelChangedFraction)failures.push(theme+' '+old.label+' changed fraction '+pixels.changedFraction);if(pixels.meanChannelDelta>report.thresholds.pixelMeanDelta)failures.push(theme+' '+old.label+' mean delta '+pixels.meanChannelDelta);
        }
        const setup=group.candidateTimings.flatMap(r=>r.operations).filter(r=>r.operation==='create');assert.equal(setup.length,6);for(const value of [...setup,...group.heldRegrab.candidate.filter(r=>r.operation==='create')]){assert.equal(value.deepClones,0);assert.equal(value.styleEnumerations,0);assert.equal(value.cssRulesReads,0);assert.ok(value.ms<=33,'absolute 4x setup budget: '+JSON.stringify(value));}
        assert.deepEqual(a.errors,[]);assert.deepEqual(b.errors,[]);
      }catch(error){group.error=String(error);await save('persistent-prototype-report.json',report);await save('persistent-'+theme+'-failure.png',await b.page.screenshot());throw error;}finally{await a.context.close();await b.context.close();}
    }
    report.failures=failures;await save('persistent-prototype-report.json',report);t.diagnostic('POWERAMP_PERSISTENT_PROTOTYPE '+JSON.stringify(report));assert.deepEqual(failures,[],'existing pixel/geometry gates remain unchanged');
  }finally{await save('persistent-prototype-report.json',report);await browser?.close();await rm(directory,{recursive:true,force:true});}
});
