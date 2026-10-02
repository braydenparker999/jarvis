// Actual shipped player at the production origin, with source assets intercepted
// from disk. Original R2/Drive audio and catalogs remain live, read-only.
import {chromium} from 'playwright-core';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(process.env.AUDIO_PUBLIC_DIR||'public'),output=process.env.AUDIO_REPORT||'/workspace/scratch/audio-browser.json';
const origin='https://missionarytube.z13.web.core.windows.net';
const minutes=Number(process.env.AUDIO_ENDURANCE_MINUTES||0);
const report={startedAt:new Date().toISOString(),minutes,errors:[],checks:[],samples:[],passed:false};
const browser=await chromium.launch({headless:true,executablePath:process.env.AUDIO_CHROME||'/usr/bin/chromium',args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
report.browser=browser.version();
const context=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
if(process.env.AUDIO_FORCE_FALLBACK==='1')await context.addInitScript(()=>{window.AudioWorkletNode=undefined;});
await context.route(origin+'/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.startsWith('/drawercast/')){
    const file=resolve(root,'.'+(path==='/drawercast/'?path+'index.html':path));
    if(file.startsWith(root+'/')){try{await stat(file);return await route.fulfill({body:await readFile(file),contentType:({'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2'})[extname(file)]||'application/octet-stream'});}catch{}}
  }
  return route.continue();
});
const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
try{
  await page.goto(origin+'/drawercast/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.PA?.R2Source.mapping?.native,null,{timeout:60000});
  report.catalog=await page.evaluate(()=>({r2:[...PA.LIB.map.values()].filter(t=>t.source==='r2').length,drive:[...PA.LIB.map.values()].filter(t=>t.source==='drive').length,mode:PA.SET.audioMode}));
  assert.equal(report.catalog.mode,'transparent');
  await page.evaluate(()=>{for(const k of ['local','drive','server'])PA.MusicSources.setEnabled(k,false,false);PA.Engine.setQueue([PA.LIB.map.get('r2_1594bzGkaPidWVBMpAM5_QwpEX7AVG-t7')],0,true);});
  await page.waitForFunction(()=>PA.Engine.el().currentTime>1&&PA.Engine.el().readyState>=3,null,{timeout:30000,polling:100});
  if(process.env.AUDIO_FORCE_FALLBACK!=='1')await page.waitForFunction(()=>PA.Engine.nodes?.peakLimiter,null,{timeout:10000,polling:100});
  const snapshot=()=>page.evaluate(()=>({at:Date.now(),time:PA.Engine.time(),rate:PA.Engine.ctx.sampleRate,readyState:PA.Engine.el().readyState,mediaError:PA.Engine.el().error?.code||null,mode:PA.SET.audioMode,backend:PA.AudioQuality.limiter,ledger:PA.AudioQuality.ledger,recent:PA.AudioQuality.recent,heap:performance.memory?.usedJSHeapSize,playing:PA.Engine.playing}));
  report.initial=await snapshot();report.checks.push(process.env.AUDIO_FORCE_FALLBACK==='1'?'actual R2 decode and explicit degraded backend':'actual R2 HTMLMediaElement decode and worklet');
  await page.evaluate(()=>PA.Engine.seek(42));await page.waitForFunction(()=>PA.Engine.time()>43,null,{timeout:10000,polling:100});report.checks.push('seek continues actual audio');
  await page.evaluate(()=>PA.Engine.pause());await page.waitForFunction(()=>PA.Engine.el().paused,null,{polling:100});await page.evaluate(()=>PA.Engine.play());await page.waitForFunction(()=>PA.Engine.time()>44,null,{timeout:10000,polling:100});report.checks.push('pause/resume');
  await page.evaluate(()=>{PA.SET.eqGains[0]=5;PA.SET.preamp=-3;PA.setVal('audioMode','custom');});
  await page.waitForTimeout(250);report.custom=await snapshot();
  await page.evaluate(()=>PA.setVal('audioMode','transparent'));await page.waitForTimeout(250);
  assert.deepEqual(await page.evaluate(()=>[PA.SET.eqGains[0],PA.SET.preamp]),[5,-3]);report.checks.push('effects stored and restored across transparent mode');
  await page.screenshot({path:output.replace(/\.json$/,'.png')});
  const until=Date.now()+minutes*60000;let iteration=0;
  while(Date.now()<until){
    await page.waitForTimeout(10000);const s=await snapshot();report.samples.push(s);
    assert.equal(s.mediaError,null);assert.ok(s.playing);assert.ok(s.readyState>=2);
    if(++iteration%6===0){await page.evaluate(i=>{PA.setVal('volume',i%2?.5:.8);PA.Engine.seek(5+(i*17)%110);if(i%3===0)PA.setVal('audioMode',PA.SET.audioMode==='transparent'?'custom':'transparent');},iteration);
      // Exercise UI/network pressure without per-block work in the processor.
      await page.evaluate(()=>{PA.Views.refreshAll();PA.EQ.render();});
    }
  }
  report.final=await snapshot();
  if(process.env.AUDIO_TEST_PROCESSOR_ERROR==='1'){await page.evaluate(()=>PA.Engine.nodes.peakLimiter.dispatchEvent(new Event('processorerror')));await page.waitForTimeout(500);report.processorErrorRecovery=await snapshot();assert.match(report.processorErrorRecovery.backend,/Degraded/);assert.ok(report.processorErrorRecovery.playing);}
  assert.equal(report.errors.length,0);report.passed=true;
}catch(e){report.failure=e.stack;report.debug=await page.evaluate(()=>({track:PA?.Engine.current?.id,flags:PA?.SourceLibrary.flags,current:PA?.Engine.cur,ctx:PA?.Engine.ctx?.state,nodes:!!PA?.Engine.nodes,backend:PA?.AudioQuality.limiter,workletFailure:PA?.AudioQuality.workletFailure,playing:PA?.Engine.playing,audio:[...document.querySelectorAll('audio')].map(a=>({src:a.currentSrc,paused:a.paused,error:a.error?.code,readyState:a.readyState,time:a.currentTime})),text:document.body.innerText.slice(-1500)})).catch(()=>null);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n');await browser.close();console.log(JSON.stringify({passed:report.passed,output,failure:report.failure,checks:report.checks}));}
