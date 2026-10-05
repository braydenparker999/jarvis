import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {buildPreview} from '../scripts/build-poweramp-preview.mjs';

const sourceHash='a6d0fb71df79ca8cc3d80627fb911e5894bb9fff465818ada78feb81b2688759';
const profile={viewport:{width:519,height:988},deviceScaleFactor:2.0818214416503906,isMobile:true,hasTouch:true};
const executablePath=[process.env.JARVIS_CHROME,'/usr/bin/chromium','/usr/bin/google-chrome',chromium.executablePath()].find(p=>p&&existsSync(p));
const output=resolve(process.env.POWERAMP_EVIDENCE_DIR||'/tmp/poweramp-render-trace');
const categories='devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,cc,disabled-by-default-cc.debug,gpu,toplevel,benchmark';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function save(name,value){await mkdir(output,{recursive:true});await writeFile(join(output,name),Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n');}
const stats=values=>({samples:values.length,mean_ms:values.length?values.reduce((a,b)=>a+b,0)/values.length:0,max_ms:values.length?Math.max(...values):0,over_33ms:values.filter(v=>v>33).length,over_50ms:values.filter(v=>v>50).length});
function installProbe(){
  const motion=fixtureTraceMotion,scene=fixtureTraceScene;
  const probe=window.fixtureTraceProbe={label:null,operations:[],settles:[],gaps:[],actions:[],anchor:0};
  const paint=motion.paint;motion.paint=function(m,p){const at=performance.now(),phase=scene.phase;try{return paint.call(this,m,p);}finally{probe.operations.push({operation:'paint',label:probe.label,phase,opening:m.opening,at,ms:performance.now()-at,p:m.p});}};
  const create=scene.create;scene.create=function(...args){const at=performance.now();try{return create.apply(this,args);}finally{probe.operations.push({operation:'scene.create',label:probe.label,phase:'setup',at,ms:performance.now()-at,target:args[0]});}};
  const settle=motion.settle;motion.settle=function(m,target,ms,done){const sample={label:probe.label,opening:m.opening,at:performance.now(),requested_ms:ms,start_p:m.p,target_p:target,completed:null};probe.settles.push(sample);performance.mark('poweramp-settle-'+probe.settles.length);return settle.call(this,m,target,ms,()=>{try{done?.();}finally{sample.completed=performance.now();sample.elapsed_ms=sample.completed-sample.at;}});};
  const clean=scene.clean;window.fixtureTraceIdle=[];
  scene.clean=function(...args){try{return clean.apply(this,args);}finally{queueMicrotask(()=>{for(const done of fixtureTraceIdle.splice(0))done();});}};
  let previous=null;
  const tick=at=>{const active=!!(scene.state||scene.settling),phase=scene.phase,label=probe.label;if(previous&&active&&previous.active&&phase===previous.phase&&label===previous.label)probe.gaps.push({label,phase,at,gap:at-previous.at});previous={active,phase,label,at};requestAnimationFrame(tick);};requestAnimationFrame(tick);
}
async function readTrace(cdp,complete){
  await cdp.send('Tracing.end');const event=await complete;assert.ok(event.stream,'Chrome trace stream is required');
  const chunks=[];let bytes=0;
  try{for(;;){const part=await cdp.send('IO.read',{handle:event.stream,size:1_048_576});const data=part.base64Encoded?Buffer.from(part.data,'base64'):Buffer.from(part.data);chunks.push(data);bytes+=data.length;assert.ok(bytes<80_000_000,'bounded isolated trace size');if(part.eof)break;}}
  finally{await cdp.send('IO.close',{handle:event.stream});}
  return Buffer.concat(chunks);
}
function unionMs(events,start,end){
  const spans=events.map(e=>[Math.max(start,e.ts/1000),Math.min(end,(e.ts+(e.dur||0))/1000)]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);let total=0,a=null,b=null;
  for(const [lo,hi] of spans){if(a===null){a=lo;b=hi;}else if(lo>b){total+=b-a;a=lo;b=hi;}else b=Math.max(b,hi);}return total+(a===null?0:b-a);
}
function summarizeTrace(trace,probe){
  const events=trace.traceEvents||[],anchor=events.find(e=>e.name==='poweramp-trace-anchor'&&e.ts!=null);assert.ok(anchor,'trace must include exact renderer time anchor');
  const offset=anchor.ts/1000-probe.anchor,threadNames=events.filter(e=>e.ph==='M'&&e.name==='thread_name').map(e=>({pid:e.pid,tid:e.tid,name:e.args?.name}));
  const main=threadNames.find(e=>e.pid===anchor.pid&&/CrRendererMain|RendererMain/.test(e.name||''));assert.ok(main,'recorded renderer main thread is required');
  const durations=events.filter(e=>e.ph==='X'&&Number.isFinite(e.dur)&&e.dur>0),stacks=new Map();
  for(const e of events){const key=e.pid+':'+e.tid;if(e.ph==='B'){if(!stacks.has(key))stacks.set(key,[]);stacks.get(key).push(e);}else if(e.ph==='E'){const start=stacks.get(key)?.pop();if(start&&e.ts>start.ts)durations.push({...start,ph:'X',dur:e.ts-start.ts});}}
  const mainEvents=durations.filter(e=>e.pid===main.pid&&e.tid===main.tid);
  const groups={style:['UpdateLayoutTree','RecalculateStyles'],layout:['Layout'],paint:['Paint','PrePaint','PaintImage'],raster:['RasterTask','RasterizerTask','RasterBufferProvider::Playback'],composite:['CompositeLayers','Commit','DrawFrame','Display::DrawAndSwap','LayerTreeHostImpl::DrawLayers','LayerTreeHostImpl::PrepareToDraw']};
  const selected=events.filter(e=>e.ph==='M'||e.name==='poweramp-trace-anchor'||e.name?.startsWith('poweramp-settle-')||Object.values(groups).flat().includes(e.name)||/BeginFrame|PipelineReporter|RenderingStats|FramePresented|SwapBuffers|SubmitCompositorFrame/.test(e.name||''));
  const names=Object.entries(durations.reduce((counts,e)=>(counts[e.name]=(counts[e.name]||0)+1,counts),{})).sort((a,b)=>b[1]-a[1]).slice(0,45);
  const phases=probe.settles.map(sample=>{
    assert.ok(sample.completed!=null,'every real settle completes');const start=sample.at+offset,end=sample.completed+offset;
    const work=Object.fromEntries(Object.entries(groups).map(([name,names])=>{const pool=['style','layout','paint'].includes(name)?mainEvents:durations;const found=pool.filter(e=>names.includes(e.name)&&e.ts/1000<end&&(e.ts+(e.dur||0))/1000>start);return [name,{events:found.length,wall_busy_ms:unionMs(found,start,end),summed_event_ms:found.reduce((a,e)=>a+e.dur/1000,0),max_event_ms:found.length?Math.max(...found.map(e=>e.dur/1000)):0}];}));
    const gaps=probe.gaps.filter(e=>e.label===sample.label&&e.phase==='settle'&&e.at>=sample.at&&e.at<=sample.completed).map(e=>e.gap),paints=probe.operations.filter(e=>e.operation==='paint'&&e.label===sample.label&&e.phase==='settle'&&e.at>=sample.at&&e.at<=sample.completed).map(e=>e.ms);
    return {...sample,elapsed_over_requested_ms:sample.elapsed_ms-sample.requested_ms,raf_gap:stats(gaps),js_paint:stats(paints),main_thread_busy_ms:unionMs(mainEvents,start,end),work};
  });
  return {anchor:{performance_ms:probe.anchor,trace_ms:anchor.ts/1000,offset_ms:offset,main},threadNames,traceEvents:events.length,observedDurationNames:names,phases,selected};
}
async function runCase(browser,built,{name,cpu,variant},environment){
  const context=await browser.newContext(profile),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
  await context.route('**/*',route=>/^https?:/.test(route.request().url())?route.abort('blockedbyclient'):route.continue());
  const result={name,cpu,variant,source:built.sourceHash,profile,environment,meaning:'Isolated browser trace of unchanged v8. Diagnostic variants are not production candidates; timings are not Android FPS or display latency.'};
  let cdp,complete,traceStarted=false;
  try{
    await page.goto(pathToFileURL(built.output).href);await page.waitForFunction(()=>powerampPreview?.ready);await page.locator('#preview-size').tap();await page.waitForFunction(()=>powerampPreview.ready&&powerampPreview.count===5000);
    await page.evaluate(()=>{PA.SET.uiTheme='dark';PA.SET.playerLayout='classic';PA.SET.bgBlur=5;PA.SET.vizOnPlayer=false;PA.SET.animations='default';PA.NativeSettings.values.list_header_buttons=1;PA.applySettings();});await page.evaluate(()=>document.fonts.ready);
    await page.evaluate(installProbe);cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});
    const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(done)));
    const idle=async screen=>{await page.evaluate(screen=>new Promise((resolve,reject)=>{const finish=()=>{const root=document.querySelector('#sc-'+screen);if(PA.Nav.cur!==screen||fixtureTraceScene.state||fixtureTraceScene.settling||root.hidden||root.inert||document.querySelector('.player-scene-input'))reject(Error('Expected canonical '+screen));else resolve();};if(fixtureTraceScene.state||fixtureTraceScene.settling)fixtureTraceIdle.push(finish);else finish();}),screen);await frame();await frame();};
    await page.locator('[data-nav="library"]').tap();await idle('library');await page.getByRole('button',{name:'All Songs',exact:true}).tap();await idle('list');
    if(variant==='blur-off')await page.addStyleTag({content:'#player-live-background .player-live-bg-art,#player-live-background .player-live-bg-art-next{filter:none!important}'});
    if(variant==='backdrop-hidden')await page.addStyleTag({content:'#player-live-backdrop-mask{opacity:0!important}'});
    const nodes=await page.evaluate(()=>{window.fixtureTraceNodes=Object.fromEntries(['mini-art','mini-title','mini-sub','mini-play','mini-seek','sc-player','player-live-mask','player-live-backdrop-mask','player-live-input'].map(id=>[id,document.getElementById(id)]));return {track:PA.Engine.current.id,animations:PA.SET.animations,bgBlur:PA.SET.bgBlur,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}};});result.settings=nodes;
    await page.evaluate(()=>{Object.assign(fixtureTraceProbe,{label:null,operations:[],settles:[],gaps:[],actions:[]});});
    complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.start',{categories,transferMode:'ReturnAsStream',options:'record-as-much-as-possible'});traceStarted=true;
    await page.evaluate(()=>{fixtureTraceProbe.anchor=performance.mark('poweramp-trace-anchor').startTime;});
    const point=(x,y)=>({id:1,x,y,radiusX:1,radiusY:1,force:1}),start=(x,y)=>cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(x,y)]}),move=(x,y)=>cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point(x,y)]}),end=()=>cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const center=selector=>page.locator(selector).evaluate(node=>{const r=node.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
    const action=async(label,screen,perform)=>{
      await page.evaluate(label=>{fixtureTraceProbe.label=label;performance.mark('poweramp-action-'+label);},label);await perform();await idle(screen);
      const state=await page.evaluate(screen=>{const root=document.querySelector('#sc-'+screen),r=root.getBoundingClientRect();return {at:performance.now(),screen:PA.Nav.cur,root:{hidden:root.hidden,inert:root.inert,opacity:getComputedStyle(root).opacity,width:r.width,height:r.height},track:PA.Engine.current.id,sameNodes:Object.entries(fixtureTraceNodes).every(([id,n])=>n===document.getElementById(id)&&n.isConnected),orphanMasks:document.querySelectorAll('#player-live-mask[data-active],#player-live-backdrop-mask[data-active],.player-scene-input').length};},screen);
      assert.equal(state.track,nodes.track);assert.equal(state.sameNodes,true);assert.equal(state.orphanMasks,0);assert.equal(state.root.hidden,false);assert.equal(state.root.inert,false);assert.equal(state.root.opacity,'1');assert.ok(state.root.width>0&&state.root.height>0);result.actions??=[];result.actions.push({label,...state});
    };
    for(const playing of [false,true]){
      if(playing)await page.evaluate(()=>PA.Engine.play());const suffix=playing?'playing':'paused';
      await action('tap-open-'+suffix,'player',async()=>{const p=await center('#mini-title');await start(p.x,p.y);await end();});
      await action('swipe-close-'+suffix,'list',async()=>{const p=await center('#artA');await start(p.x,p.y);for(let i=1;i<=5;i++){await move(p.x,p.y+169*i/5);await frame();}await end();});
      await action('held-open-'+suffix,'player',async()=>{const p=await center('#mini-title'),height=await page.locator('#sc-list').evaluate(n=>n.clientHeight);await start(p.x,p.y);for(let i=1;i<=6;i++){await move(p.x,p.y-height*.5*i/6);await frame();}await page.waitForTimeout(150);await end();});
      await action('held-close-'+suffix,'list',async()=>{const p=await center('#artA'),height=await page.locator('#sc-player').evaluate(n=>n.clientHeight);await start(p.x,p.y);for(let i=1;i<=6;i++){await move(p.x,p.y+height*.5*i/6);await frame();}await page.waitForTimeout(150);await end();});
    }
    await page.evaluate(()=>{PA.Engine.pause();fixtureTraceProbe.label=null;});const bytes=await readTrace(cdp,complete);traceStarted=false;
    const probe=await page.evaluate(()=>fixtureTraceProbe),summary=summarizeTrace(JSON.parse(bytes.toString()),probe);result.probe=probe;result.summary={...summary,selected:undefined};result.errors=errors;assert.deepEqual(errors,[]);
    await save('render-trace-'+name+'.json.gz',gzipSync(bytes));await save('render-trace-'+name+'-events.json.gz',gzipSync(Buffer.from(JSON.stringify({traceEvents:summary.selected}))));await save('render-trace-'+name+'-report.json',result);
    await page.screenshot({path:join(output,'render-trace-'+name+'-endpoint.png'),fullPage:false});
    return result;
  }catch(error){result.error=String(error);if(traceStarted){try{const bytes=await readTrace(cdp,complete);await save('render-trace-'+name+'-failure.json.gz',gzipSync(bytes));}catch(e){result.traceError=String(e);}}await save('render-trace-'+name+'-report.json',result);throw error;}
  finally{await context.close();}
}
test('isolated unchanged v8 render/compositor attribution and diagnostic backdrop variants',{timeout:240000},async t=>{
  assert.ok(executablePath,'Chrome is mandatory');const directory=await mkdtemp(join(tmpdir(),'poweramp-render-trace-'));let browser;
  const report={source:sourceHash,cases:[],scope:'Read-only v8 attribution. No frame gate or candidate optimization is inferred from these diagnostic variants.'};
  try{
    const built=await buildPreview(join(directory,'v8.html'));assert.equal(built.sourceHash,sourceHash,'production v8 must remain byte-identical');report.previewSHA256=built.sha256;
    let html=await readFile(built.output,'utf8');assert.equal(html.split('window.PA = {').length,2);html=html.replace('window.PA = {','window.fixtureTraceMotion=SharedPlayerMotion;window.fixtureTraceScene=ScreenDrag;window.PA = {');await writeFile(built.output,html);report.measuredSHA256=hash(await readFile(built.output));
    browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});const info=await browser.newBrowserCDPSession(),environment={version:await info.send('Browser.getVersion'),system:await info.send('SystemInfo.getInfo')};report.environment=environment;
    for(const config of [{name:'baseline-1x',cpu:1,variant:'baseline'},{name:'baseline-4x',cpu:4,variant:'baseline'},{name:'blur-off-1x',cpu:1,variant:'blur-off'},{name:'backdrop-hidden-1x',cpu:1,variant:'backdrop-hidden'}]){
      const result=await runCase(browser,built,config,environment);report.cases.push(result);await save('render-trace-summary.json',report);t.diagnostic('POWERAMP_RENDER_TRACE '+JSON.stringify({name:config.name,source:sourceHash,cpu:config.cpu,variant:config.variant,phases:result.summary.phases,rendererMain:result.summary.anchor.main,traceEvents:result.summary.traceEvents}));
    }
    assert.equal(hash(await readFile(built.output)),report.measuredSHA256,'instrumented HTML unchanged throughout tracing');await save('render-trace-summary.json',report);
  }finally{await save('render-trace-summary.json',report);await browser?.close();await rm(directory,{recursive:true,force:true});}
});
