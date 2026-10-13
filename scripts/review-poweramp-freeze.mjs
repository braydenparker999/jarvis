// Desktop Chromium only. Install puppeteer-core separately, then set
// PUPPETEER_MODULE to its index.js. No live catalog or security bypass.
import {readFile,writeFile,mkdtemp,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {servePowerampFixture,installPowerampFixture,sourceFlags} from '../tests/helpers/poweramp-fixture.js';
const moduleName=process.env.PUPPETEER_MODULE;
const {default:puppeteer}=await import(moduleName?pathToFileURL(moduleName).href:'puppeteer-core');
const headless=process.env.HEADLESS==='1';
const browser=await puppeteer.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless,args:['--no-sandbox']});
const results={browser:await browser.version(),headless,generatedAudio:true,securityBypass:false,runs:[]};
try{
  for(const [label,path] of [['control',process.env.CONTROL_SOURCE],['proposal',process.env.PROPOSAL_SOURCE]]){
    if(label==='proposal'&&!path)continue;
    const root=await mkdtemp(join(tmpdir(),'poweramp-freeze-fixture-'));
    await cp(new URL('../public/',import.meta.url),root,{recursive:true});
    if(path)await writeFile(join(root,'drawercast/player.js'),await readFile(path));
    const fixture=await servePowerampFixture({root}),context=await browser.createBrowserContext();
    try{
      const page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
      await page.setViewport({width:412,height:915,isMobile:true,hasTouch:true});
      await page.evaluateOnNewDocument(flags=>localStorage.setItem('drawercast.sources.v1',JSON.stringify(flags)),sourceFlags);
      await page.goto(fixture.origin+'/drawercast/');await page.evaluate(()=>window.__powerampBootPromise);
      await page.evaluate(installPowerampFixture,{origin:fixture.origin,count:3,art:false});
      await page.evaluate(()=>{
        Object.assign(PA.SET,{audioMode:'transparent',gapless:false,crossfade:false,fadeOnPause:false});PA.NativeSettings.values.pause_on_screen_off=false;
        for(const t of PA.LIB.map.values()){t.remote=false;t.nativeR2=true;}
        window.reviewEvents=[];
        const record=(type,e)=>reviewEvents.push({type,trusted:e?.isTrusted,at:Date.now(),time:PA.Engine.el().currentTime,paused:PA.Engine.el().paused,intent:PA.Engine.wantsPlayback(),playing:PA.Engine.playing,visibility:document.visibilityState});
        for(const name of ['freeze','resume','visibilitychange'])document.addEventListener(name,e=>record(name,e),true);
        for(const a of PA.Engine.els)for(const name of ['pause','playing','ended'])a.addEventListener(name,e=>record(name,e),true);
      });
      await page.tap('#btn-play');await page.waitForFunction(()=>PA.Engine.playing&&PA.Engine.el().currentTime>.5);
      const cover=await context.newPage();await cover.goto('about:blank');await cover.bringToFront();
      const cdp=await page.createCDPSession();await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:false});
      await page.waitForFunction(()=>document.visibilityState==='hidden',{polling:500});
      const snapshot=()=>page.evaluate(()=>({time:PA.Engine.el().currentTime,paused:PA.Engine.el().paused,intent:PA.Engine.wantsPlayback(),playing:PA.Engine.playing,visibility:document.visibilityState,events:reviewEvents,trace:PA.PlaybackDiagnostics.report()}));
      const hiddenStart=await snapshot();await new Promise(resolve=>setTimeout(resolve,3000));
      const before=await snapshot();
      if(before.time-hiddenStart.time<1)throw Error('Hidden control did not advance before freeze; reproduction environment is inconclusive');
      await cdp.send('Page.setWebLifecycleState',{state:'frozen'});
      // Node timer is outside the frozen renderer. No injected lifecycle events.
      await new Promise(resolve=>setTimeout(resolve,Number(process.env.FREEZE_MS||30000)));
      await cdp.send('Page.setWebLifecycleState',{state:'active'});
      await new Promise(resolve=>setTimeout(resolve,8000));
      const after=await snapshot();
      if(!after.events.some(e=>e.type==='freeze'&&e.trusted)||!after.events.some(e=>e.type==='resume'&&e.trusted))throw Error('No native freeze/resume; run is not a valid reproduction');
      await new Promise(resolve=>setTimeout(resolve,8000));const later=await snapshot();
      await page.bringToFront();await new Promise(resolve=>setTimeout(resolve,3000));const foreground=await snapshot();
      results.runs.push({label,freezeMs:Number(process.env.FREEZE_MS||30000),hiddenStart,before,after,later,foreground,errors});
      console.log(JSON.stringify({label,hiddenAdvance:before.time-hiddenStart.time,before:{time:before.time,paused:before.paused,visibility:before.visibility},after:{time:after.time,paused:after.paused,intent:after.intent,playing:after.playing},later:{time:later.time,paused:later.paused},foreground:{time:foreground.time,paused:foreground.paused},events:after.events,errors}));
    }finally{await context.close();await fixture.close();await rm(root,{recursive:true,force:true});}
  }
}finally{await browser.close();}
if(process.env.EVIDENCE_OUT)await writeFile(process.env.EVIDENCE_OUT,JSON.stringify(results,null,2)+'\n');
