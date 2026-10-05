import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {previewHooks} from '../scripts/build-poweramp-preview.mjs';

function harness(){
  let now=100,next=0;const frames=new Map(),events=new Map(),toasts=[],dialogs=[];
  const help={textContent:'?',title:''};
  const document={hidden:false,getElementById:id=>id==='preview-help'?help:null,querySelector:()=>({content:'fixture-source-hash'}),
    addEventListener(type,fn,capture=false){if(!events.has(type))events.set(type,[]);events.get(type).push({fn,capture:!!capture});},
    removeEventListener(type,fn,capture=false){events.set(type,(events.get(type)||[]).filter(e=>e.fn!==fn||e.capture!==!!capture));}};
  const context=vm.createContext({document,performance:{now:()=>now},requestAnimationFrame:fn=>{frames.set(++next,fn);return next;},cancelAnimationFrame:id=>frames.delete(id),
    innerWidth:393,innerHeight:852,devicePixelRatio:2.75,Preview:{count:60,ready:true},SET:{animations:'normal',playerLayout:'classic',bgBlur:10,vizOnPlayer:false,listZoom:{files:1}},
    NativeSettings:{values:{list_header_buttons:1}},InputLifecycle:{gesture:null,version:1},LibraryPageMotion:{state:null,finish:null},LibraryPageHistory:{index:1,entries:[{},{}]},ScreenDrag:{state:null,settling:null},Nav:{cur:'list'},
    toast:(...args)=>toasts.push(args),dialog:(...args)=>dialogs.push(args),esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')});
  vm.runInContext(previewHooks.slice(previewHooks.indexOf('const PreviewDiagnostics='),previewHooks.indexOf('Preview.prepare();'))+'\nglobalThis.diagnostics=PreviewDiagnostics;',context);
  const h={context,diagnostics:context.diagnostics,frames,events,help,toasts,dialogs,
    tick(ms=16){now+=ms;const first=frames.entries().next().value;if(first){frames.delete(first[0]);first[1](now);}},
    fire(type,target={id:'sc-list',tagName:'SECTION'}){for(const {fn} of events.get(type)||[])fn({type,target,pointerType:'touch'});},
    listenerCount(){return [...events.values()].reduce((n,v)=>n+v.length,0);}};return h;
}

test('preview diagnostics are off by default with no listeners or scheduled callbacks',()=>{
  const h=harness();assert.equal(h.diagnostics.active,false);assert.equal(h.frames.size,0);assert.equal(h.listenerCount(),0);assert.equal(h.help.textContent,'?');
  h.diagnostics.show();assert.equal(h.dialogs.length,0);assert.match(h.toasts[0][0],/No diagnostics/);
});

test('an optional measurement stops after 30 seconds and keeps bounded samples/events',()=>{
  const h=harness();h.diagnostics.start();assert.equal(h.diagnostics.active,true);assert.equal(h.help.textContent,'●');
  for(let i=0;i<100;i++)h.fire('pointerdown');
  for(let i=0;i<1900;i++)h.tick();
  assert.equal(h.diagnostics.active,false);assert.equal(h.frames.size,0);assert.equal(h.listenerCount(),0);assert.equal(h.help.textContent,'?');
  const report=h.diagnostics.result;assert.equal(report.stop,'30 seconds elapsed');assert.equal(report.tracks,60);assert.ok(report.raf_gap_ms.samples>1000);assert.equal(report.raf_gap_ms.recent_samples,600);assert.equal(report.raf_gap_ms.p95_recent,16);assert.ok(report.events.length<=80);
  assert.match(report.metric,/not display frames or input latency/);assert.equal(report.source,'fixture-source-hash');assert.equal(report.settings.headerButtons,1);
});

test('report records owner/commit outcomes and callback gaps without collecting input text',async()=>{
  const h=harness();h.diagnostics.start();h.tick();h.tick(80);h.fire('keydown',{id:'q',tagName:'INPUT',value:'private typed content'});
  h.context.InputLifecycle.gesture={node:{id:'sc-list'},phase:'drag'};h.diagnostics.observe();
  h.context.InputLifecycle.gesture=null;h.context.LibraryPageMotion.finish={pending:true};h.context.Nav.cur='library';h.context.LibraryPageHistory.index=0;h.diagnostics.observe();
  h.diagnostics.show();await Promise.resolve();
  const report=h.diagnostics.result;assert.equal(report.raf_gap_ms.over_50ms,1);assert.equal(report.final.screen,'library');assert.equal(report.final.historyIndex,0);
  assert.ok(report.events.some(e=>e.owner==='sc-list'&&e.phase==='drag'));assert.ok(report.events.some(e=>e.phase==='settle'&&e.screen==='library'));
  assert.doesNotMatch(JSON.stringify(report),/private typed content/);assert.equal(h.dialogs.length,1);assert.match(h.dialogs[0][1],/<textarea[^>]*readonly/);assert.match(h.dialogs[0][1],/Nothing is sent automatically/);assert.equal(h.listenerCount(),0);
});

test('hiding the page stops all work and restarting does not accumulate listeners',()=>{
  const h=harness();h.diagnostics.start();h.context.document.hidden=true;h.fire('visibilitychange');
  assert.equal(h.diagnostics.result.stop,'page hidden');assert.equal(h.frames.size,0);assert.equal(h.listenerCount(),0);
  h.context.document.hidden=false;h.context.Preview.count=5000;h.diagnostics.start();assert.equal(h.listenerCount(),6);h.diagnostics.stop('fixture reset');
  assert.equal(h.diagnostics.result.tracks,5000);assert.equal(h.diagnostics.result.stop,'fixture reset');assert.equal(h.listenerCount(),0);
});
