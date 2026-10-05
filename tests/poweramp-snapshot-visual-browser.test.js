import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {fixtureCover,fixtureSceneSettled,installFixtureInputTrace,installPowerampFixture,reportFixtureFailure,servePowerampFixture,sourceFlags} from './helpers/poweramp-fixture.js';
import {compareScreenshotPNG} from './helpers/poweramp-png.js';

const executablePath=[process.env.JARVIS_CHROME,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome',chromium.executablePath()].find(p=>p&&existsSync(p));
const ownerViewport={viewport:{width:519,height:988},deviceScaleFactor:2.0818214416503906,isMobile:true,hasTouch:true};
const geometryTolerance=.05;
// A small rasterization allowance is explicitly bounded; every exact change is
// still reported. Geometry must independently agree within .05 CSS pixels.
const pixelLimits={channelTolerance:2,changedFraction:.0005,meanChannelDelta:.05,regionChangedFraction:.003};
const rectKeys=['left','top','width','height'];
const near=(a,b,label,tolerance=geometryTolerance)=>assert.ok(Math.abs(a-b)<=tolerance,`${label}: ${a} vs ${b} (limit ${tolerance})`);
const rectNear=(a,b,label)=>{for(const key of rectKeys)near(a[key],b[key],label+'.'+key);};

async function openVisualPage(browser,fixture,{theme,baseline=false,art=true}){
  // This suite owns its context so the owner's exact viewport/DPR does not
  // silently change existing gesture/browser helpers' mobile defaults.
  const context=await browser.newContext(ownerViewport),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===fixture.origin?route.continue():route.abort('blockedbyclient'));
  await context.addInitScript(flags=>localStorage.setItem('drawercast.sources.v1',JSON.stringify(flags)),sourceFlags);
  await context.addInitScript(installFixtureInputTrace);
  await page.goto(fixture.origin+'/drawercast/');await page.waitForFunction(()=>window.PA?.R2Source.manifestURL==='fixture-disabled');
  await page.evaluate(installPowerampFixture,{origin:fixture.origin,count:60,art});
  await page.evaluate(async theme=>{
    PA.SET.uiTheme=theme;PA.applySettings('uiTheme');PA.UI.renderPlayState();
    // Paused, generated fixture peaks go through the real waveform renderer.
    // No audio plays and neither the DOM nor canvas rendering is replaced.
    // accept({duration,peaks}) only converts peaks and paints. These remote R2
    // tracks have no waveformVersion, so the scheduled run returns before
    // getFileFor or audio fetching; no sampling/playback override is needed.
    PA.Engine.seek(42);PA.Waveform.accept({duration:180,peaks:Array.from({length:2880},(_,i)=>40+(i*37+i%17*13)%205)});
    PA.UI.renderProgress();PA.UI.drawViz();await document.fonts.ready;
  },theme);
  assert.equal(await page.evaluate(()=>document.body.classList.contains('theme-light')),theme==='light','requested theme is active');
  const cdp=await context.newCDPSession(page),point=(x,y)=>({id:1,x,y,radiusX:1,radiusY:1,force:1});
  const start=(x,y)=>cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(x,y)]});
  const move=(x,y)=>cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point(x,y)]});
  const end=()=>cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(done)));
  const settled=async screen=>{await page.waitForFunction(fixtureSceneSettled,screen);await frame();await frame();};
  const center=async selector=>{const r=await page.locator(selector).boundingBox();assert.ok(r,'visible '+selector);return {x:r.x+r.width/2,y:r.y+r.height/2};};
  const quiet=async()=>{
    if(art)await page.waitForFunction(()=>!!document.querySelector('#bg-art').style.backgroundImage);
    await page.waitForFunction(()=>document.getAnimations().every(animation=>animation.playState==='finished'||animation.playState==='idle'));
    await frame();await frame();
  };
  const library=async()=>{await page.locator('[data-nav="library"]').tap();await settled('library');await page.getByRole('button',{name:'All Songs',exact:true}).tap();await settled('list');await quiet();};
  const diagnostics=()=>page.evaluate(()=>({theme:PA.SET.uiTheme,screen:PA.Nav.cur,time:PA.Engine.time(),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
    cssRulesReads:window.fixtureCSSRulesReads||0,scene:{plane:!!document.querySelector('.player-scene-input'),layer:!!document.querySelector('.player-scene-layer'),miniOpacity:document.querySelector('#mini').style.opacity,fullOpacity:document.querySelector('#sc-player').style.opacity},trace:window.fixtureInputTrace})).then(result=>({...result,errors}));
  const mode=async()=>{
    await page.evaluate(baseline=>{
      // Only introspection of one real sheet is made unreadable after boot.
      // The same sheet remains enabled and continues painting the original UI.
      // Production snapshotPlan catches this and selects the old exhaustive CSS.
      const sheet=document.styleSheets[0],descriptor=Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype,'cssRules');
      if(!sheet||!descriptor?.get)throw Error('Expected a real readable stylesheet');
      const length=descriptor.get.call(sheet).length;window.fixtureCSSRulesReads=0;
      Object.defineProperty(sheet,'cssRules',{configurable:true,get(){fixtureCSSRulesReads++;if(baseline)throw new DOMException('Test-only unreadable stylesheet view','SecurityError');return descriptor.get.call(this);}});
      window.fixtureSheet={enabled:!sheet.disabled,rules:length,baseline};
    },baseline);
  };
  await settled('player');await quiet();await mode();
  return {context,page,errors,start,move,end,frame,settled,center,library,quiet,diagnostics,close:()=>context.close()};
}

async function snapshot(h,{label,expectedProgress}){
  const state=await h.page.evaluate(()=>{
    const layer=document.querySelector('.player-scene-layer'),plane=document.querySelector('.player-scene-input');
    if(!layer||!plane)throw Error('Expected actual owned shared scene and contact plane');
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};};
    const style=node=>{const s=getComputedStyle(node);return {opacity:s.opacity,display:s.display,visibility:s.visibility,backgroundImage:s.backgroundImage==='none'?'none':'image',borderRadius:s.borderRadius,maskImage:s.maskImage==='none'?'none':'image'};};
    const art=layer.querySelector('.player-scene-art'),surface=layer.querySelector('.player-scene-surface'),background=layer.querySelector('.player-scene-background'),fullClone=layer.querySelector('.player-scene-full');
    const mini=document.querySelector('#mini'),full=document.querySelector('#sc-player');
    const canonical={surface:{mini:rect(mini),full:rect(full)}};
    const p=(rect(surface).height-canonical.surface.mini.height)/(canonical.surface.full.height-canonical.surface.mini.height);
    const geometry={art:rect(art),surface:rect(surface),background:rect(background),fullControls:rect(fullClone)};
    const appearance={art:style(art),surface:style(surface),background:style(background),fullControls:style(fullClone)};
    const parts=[...layer.querySelectorAll('.player-scene-part')];
    for(const [key,a,b] of [['art','#mini-art','#artstage'],['title','#mini-title','#p-title'],['sub','#mini-sub','#p-sub'],['play','#mini-play','#btn-play'],['seek','#mini-seek','#seek']]){
      const sourceMini=document.querySelector(a),sourceFull=document.querySelector(b),fullRect=rect(sourceFull);
      canonical[key]={mini:rect(sourceMini),full:fullRect.width&&fullRect.height?fullRect:rect(document.querySelector('.seekrow'))};
      if(key==='art')continue;
      for(const [end,source] of [['mini',sourceMini],['full',sourceFull]]){
        // Existing DOM clone maps identify the real shared roots without
        // exposing or replacing the private production scene controller.
        const node=parts.find(n=>n._sceneNodes?.get(source)===n);if(!node)throw Error('Missing real shared '+key+' '+end);
        geometry[key+'-'+end]=rect(node);appearance[key+'-'+end]=style(node);
      }
    }
    const elements=[layer,...layer.querySelectorAll('*')],canvases=[...fullClone._sceneNodes].filter(([source])=>source.tagName==='CANVAS'&&!fullClone._sceneSuppressed?.has(source)).map(([source,copy])=>({sourceWidth:source.width,sourceHeight:source.height,copyWidth:copy.width,copyHeight:copy.height}));
    return {p,geometry,appearance,canonical,canvases,cssCharacters:elements.reduce((n,e)=>n+e.style.cssText.length,0),clonedNodes:elements.length,
      theme:PA.SET.uiTheme,time:PA.Engine.time(),playing:PA.Engine.wantsPlayback(),track:PA.Engine.current.id,miniOpacity:mini.style.opacity,fullOpacity:full.style.opacity,
      cssRulesReads:fixtureCSSRulesReads,sheet:{...fixtureSheet,stillEnabled:!document.styleSheets[0].disabled},viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},trace:fixtureInputTrace.slice(-24)};
  });
  near(state.p,expectedProgress,label+' held progress',.00001);assert.equal(state.time,42);assert.equal(state.playing,false);
  assert.equal(state.miniOpacity,'0');assert.equal(state.fullOpacity,'0');assert.ok(state.cssRulesReads>0,'candidate used the stylesheet-plan/fallback path');
  assert.ok(state.sheet.enabled&&state.sheet.stillEnabled,'baseline never disables application CSS');
  assert.ok(state.trace.some(event=>event.type==='pointerdown'&&event.trusted));assert.ok(state.trace.every(event=>event.trusted),'all input is genuine CDP/browser input');
  for(const [key,pair] of Object.entries(state.canonical)){
    const expected=Object.fromEntries(rectKeys.map(prop=>[prop,pair.mini[prop]+(pair.full[prop]-pair.mini[prop])*expectedProgress]));
    rectNear(state.geometry[key==='art'||key==='surface'?key:key+'-mini'],expected,label+' '+key+' lerp');
  }
  for(const canvas of state.canvases){assert.equal(canvas.copyWidth,canvas.sourceWidth);assert.equal(canvas.copyHeight,canvas.sourceHeight);}
  const before=state.geometry.art;await h.frame();await h.frame();rectNear(await h.page.locator('.player-scene-art').evaluate(n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};}),before,label+' held freeze');
  return {label,state,png:await h.page.screenshot({fullPage:false,animations:'allow',scale:'device',timeout:8000})};
}

async function hold(h,progress){
  const origin=await h.center('#mini-title');await h.start(origin.x,origin.y);await h.move(origin.x,origin.y-16);await h.frame();
  const height=await h.page.locator('#sc-list').evaluate(n=>n.clientHeight);
  assert.ok(await h.page.locator('.player-scene-input').count(),'trusted mini drag created the actual shared plane');
  await h.move(origin.x,origin.y-height*progress);await h.frame();await h.frame();return {origin,height};
}

async function standardSnapshots(h){
  const shots=[];await h.library();const {origin,height}=await hold(h,.25);
  for(const p of [.25,.5,.75]){
    if(p!==.25){await h.move(origin.x,origin.y-height*p);await h.frame();await h.frame();}
    shots.push(await snapshot(h,{label:'held-'+String(p).replace('.',''),expectedProgress:p}));
  }
  await h.end();await h.settled('player');await h.library();await hold(h,.25);
  // Release and immediately regrab the genuine contact plane. Then use trusted
  // displacement from its captured painted progress to reach the same .5 point.
  // Read progress from the production-written full clone opacity. Inferring it
  // from float-rounded transformed bounds can perturb exact corner-radius CSS
  // by 0.00001px despite paired geometry/pixels satisfying unchanged gates.
  await h.end();await h.start(3,500);
  const frozen=await h.page.evaluate(()=>{
    const surface=document.querySelector('.player-scene-surface'),mini=document.querySelector('#mini'),full=document.querySelector('#sc-player');
    if(!surface||!document.querySelector('.player-scene-input'))throw Error('Regrab did not reach a live shared scene');
    const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};},a=rect(mini),b=rect(full);
    const geometryP=(rect(surface).height-a.height)/(b.height-a.height),p=Number(document.querySelector('.player-scene-full').style.opacity);
    if(!Number.isFinite(p)||Math.abs(p-geometryP)>.00001)throw Error('Painted DOM opacity disagrees with held geometry');
    return {p,geometryP,height:document.querySelector('#sc-list').clientHeight,art:rect(document.querySelector('.player-scene-art'))};
  });
  assert.ok(Number.isFinite(frozen.p),'regrab reached a live scene');
  await h.page.waitForTimeout(280);
  rectNear(await h.page.locator('.player-scene-art').evaluate(n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};}),frozen.art,'trusted regrab holds the painted cover beyond original settle duration');
  await h.move(3,520);await h.frame();await h.move(3,500+(frozen.p-.5)*frozen.height);await h.frame();await h.frame();
  const regrab=await snapshot(h,{label:'regrab-held-05',expectedProgress:.5});
  assert.ok(regrab.state.trace.some(e=>e.type==='pointerdown'&&e.target?.includes('player-scene-input')&&e.trusted),'genuine regrab hit the transient contact plane');
  shots.push(regrab);await h.end();await h.page.waitForFunction(()=>!document.querySelector('.player-scene-layer'));return shots;
}

async function lateArtworkSnapshot(h,fixture){
  await h.library();
  const art=fixtureCover(4);
  await h.page.evaluate(svg=>{
    const track=PA.Engine.current;track.artKey='snapshot-late-fixture';
    const original=PA.IDB.get,resolvers=[];window.fixtureLateArtRequested=false;
    PA.IDB.get=function(store,key){if(store==='art'&&String(key).startsWith(track.artKey)){fixtureLateArtRequested=true;return new Promise(resolve=>resolvers.push(resolve));}return original.call(this,store,key);};
    window.fixtureReleaseLateArt=()=>{const blob=new Blob([svg],{type:'image/svg+xml'});for(const resolve of resolvers)resolve(blob);PA.IDB.get=original;};
    window.fixtureLateRender=PA.UI.renderNowPlaying(track);
  },art);
  await h.page.waitForFunction(()=>fixtureLateArtRequested);await hold(h,.5);
  const before=await h.page.locator('.player-scene-art').boundingBox();
  await h.page.evaluate(async()=>{fixtureReleaseLateArt();await fixtureLateRender;});
  await h.page.waitForFunction(()=>document.querySelector('#artA').classList.contains('has')&&document.querySelector('#mini-art').classList.contains('has')&&!!document.querySelector('#bg-art').style.backgroundImage);
  await h.page.waitForFunction(()=>document.getAnimations().every(a=>a.playState==='finished'||a.playState==='idle'));await h.frame();await h.frame();
  const after=await h.page.locator('.player-scene-art').boundingBox();for(const key of ['x','y','width','height'])near(after[key],before[key],'late art keeps held '+key);
  const result=await snapshot(h,{label:'late-art-held-05',expectedProgress:.5});
  assert.equal(await h.page.evaluate(()=>{
    const nodes=[...document.querySelectorAll('.player-scene-art-appearance')];
    return nodes.length===2&&nodes.every(n=>getComputedStyle(n).backgroundImage!=='none'&&[...n.querySelectorAll('.ph')].every(ph=>getComputedStyle(ph).display==='none'));
  }),true,'late decoded art replaces both cloned placeholders');
  await h.end();await h.settled('player');return result;
}

async function compareAndRecord(baseline,compact,theme,t){
  const name='snapshot-visual-'+theme+'-'+baseline.label;assert.equal(compact.label,baseline.label);
  const geometryDeltas=Object.fromEntries(Object.entries(baseline.state.geometry).map(([name,rect])=>[name,Object.fromEntries(rectKeys.map(key=>[key,compact.state.geometry[name][key]-rect[key]]))]));
  const regions=Object.fromEntries(Object.entries(baseline.state.geometry).map(([name,r])=>[name,Object.fromEntries(rectKeys.map(key=>[key,r[key]*ownerViewport.deviceScaleFactor]))]));
  const pixels=compareScreenshotPNG(baseline.png,compact.png,{channelTolerance:pixelLimits.channelTolerance,regions});
  const report={name,scope:'Same candidate, exhaustive fallback vs compact snapshots. Generated paused tracks/art/waveforms and trusted input; no live network or audio-fidelity claim.',limits:{geometryTolerance,pixelLimits},baseline:baseline.state,compact:compact.state,geometryDeltas,pixels};
  if(process.env.POWERAMP_EVIDENCE_DIR){
    const directory=resolve(process.env.POWERAMP_EVIDENCE_DIR);await mkdir(directory,{recursive:true});
    await Promise.all([writeFile(join(directory,name+'-baseline.png'),baseline.png),writeFile(join(directory,name+'-compact.png'),compact.png),writeFile(join(directory,name+'.json'),JSON.stringify(report,null,2)+'\n')]);
  }
  t.diagnostic('POWERAMP_SNAPSHOT_VISUAL '+JSON.stringify({name,viewport:baseline.state.viewport,baselineCSS:baseline.state.cssCharacters,compactCSS:compact.state.cssCharacters,pixels}));
  for(const [key,rect] of Object.entries(baseline.state.geometry))rectNear(compact.state.geometry[key],rect,name+' '+key);
  assert.deepEqual(compact.state.appearance,baseline.state.appearance,name+' opacity, corners, masks, and visibility');
  assert.deepEqual(compact.state.canvases,baseline.state.canvases,name+' canvas bitmap dimensions');
  assert.equal(compact.state.clonedNodes,baseline.state.clonedNodes,name+' identical source/clone topology');
  assert.ok(compact.state.cssCharacters<baseline.state.cssCharacters*.7,name+' proves the compact path actually reduced inline CSS');
  assert.ok(pixels.changedFraction<=pixelLimits.changedFraction,name+' bounded changed pixels: '+pixels.changedFraction);
  assert.ok(pixels.meanChannelDelta<=pixelLimits.meanChannelDelta,name+' bounded mean channel delta: '+pixels.meanChannelDelta);
  for(const [region,result] of Object.entries(pixels.regions))assert.ok(result.changedFraction<=pixelLimits.regionChangedFraction,name+' '+region+' bounded changed pixels: '+result.changedFraction);
}

// Required runtime evidence. Chromium missing/broken is a failure, never a skip.
test('Poweramp mandatory Chromium snapshot screenshot and geometry parity at owner viewport',{timeout:180000},async t=>{
  assert.ok(executablePath,'Chromium is required: install it or set JARVIS_CHROME');
  const fixture=await servePowerampFixture();let browser;
  try{
    browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
    for(const theme of ['dark','light'])await t.test(theme+' held checkpoints, trusted settle regrab, and late decoded art',async()=>{
      const paired={baseline:[],compact:[]};
      for(const baseline of [true,false]){
        const mode=baseline?'baseline':'compact';
        for(const art of [true,false]){
          const h=await openVisualPage(browser,fixture,{theme,baseline,art});
          try{
            paired[mode].push(...(art?await standardSnapshots(h):[await lateArtworkSnapshot(h,fixture)]));
            assert.deepEqual(h.errors,[]);assert.equal(await h.page.evaluate(()=>PA.Engine.wantsPlayback()),false);
          }catch(error){await reportFixtureFailure(h,error,'snapshot-visual-'+theme+'-'+mode+'-'+(art?'standard':'late-art'));throw error;}
          finally{await h.close();}
        }
      }
      assert.equal(paired.baseline.length,5);assert.equal(paired.compact.length,5);
      // All five pairs are already captured. Keep their bounded evidence even
      // if an early pair fails, then fail the unchanged acceptance gates.
      const failures=[];
      for(let i=0;i<paired.baseline.length;i++){
        try{await compareAndRecord(paired.baseline[i],paired.compact[i],theme,t);}
        catch(error){failures.push({case:paired.baseline[i].label,error:String(error)});}
      }
      assert.deepEqual(failures,[],theme+' all snapshot visual acceptance gates');
    });
    assert.equal(fixture.requests.audio,0,'visual QA never fetches or plays audio');
  }finally{await browser?.close();await fixture.close();}
});
