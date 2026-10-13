// Run the existing actual-engine harness against a candidate source. Preserve
// its fake clock; add deterministic interval support for the proposed watchdog.
import {readFile} from 'node:fs/promises';

process.env.POWERAMP_PLAYER_SOURCE ||= new URL('../public/drawercast/player.js',import.meta.url).pathname;
let harness=await readFile(new URL('../tests/poweramp-native-reliability.test.js',import.meta.url),'utf8');
harness=harness.slice(0,harness.indexOf('async function offlineNextSourceError('));
harness=harness.replace('clearTimeout: clock.clearTimeout, debounce:',`clearTimeout: clock.clearTimeout,
    setInterval(fn,delay){const tick=()=>clock.setTimeout(()=>{fn();tick();},delay);return tick();}, debounce:`);
const {test,assert,make,flush,hide,show,addNext}=await import('data:text/javascript;base64,'+Buffer.from(harness+'\nexport {test,assert,harness as make,flush,hide,show,addNext};').toString('base64'));

for(const delivery of ['pause-event','missing-pause-event'])test(`hidden native interruption remains terminal (${delivery})`,async()=>{
  const h=make();await h.start();hide(h);const a=h.audio(),attempts=a.attempts.length;
  if(delivery==='pause-event')a.pause();else{a.paused=true;h.Engine.reconcilePlaybackLifecycle();}
  await h.clock.advance(2000);
  assert.equal(a.attempts.length,attempts,'hidden is not evidence that a pause was caused by freezing');
  assert.equal(h.Engine.wantsPlayback(),false);
});

for(const action of ['pause','stop','media-pause','screen-off','selection'])test(`freeze return preserves ${action}`,async()=>{
  const h=make();addNext(h);await h.start();hide(h);h.ctx.document.emit('freeze');
  if(action==='selection')await h.Engine.playIndex(1,false);
  else if(action==='media-pause')h.mediaHandlers.get('pause')();
  else if(action==='screen-off')h.Engine.pause('screen-off');
  else h.Engine[action]();
  h.ctx.document.emit('resume');show(h);const attempts=h.Engine.els.reduce((n,a)=>n+a.attempts.length,0);
  await h.clock.advance(60000);
  assert.equal(h.Engine.els.reduce((n,a)=>n+a.attempts.length,0),attempts);
  assert.equal(h.Engine.wantsPlayback(),false);
});

for(const state of ['suspended','interrupted','closed'])test(`freeze cannot override ${state} audio focus`,async()=>{
  const h=make('native-r2',{webAudio:true});await h.start();hide(h);h.ctx.document.emit('freeze');h.Engine.ctx.change(state);
  const attempts=h.audio().attempts.length,resumes=h.Engine.ctx.resumeCalls;
  h.ctx.document.emit('resume');show(h);await h.clock.advance(60000);
  assert.equal(h.audio().attempts.length,attempts);assert.equal(h.Engine.ctx.resumeCalls,resumes);
});

test('a freeze does not grant a ten-minute permission to restart a later native pause',async()=>{
  const h=make();await h.start();hide(h);h.ctx.document.emit('freeze');h.ctx.document.emit('resume');show(h);
  await h.clock.advance(30000);const a=h.audio(),attempts=a.attempts.length;a.pause();await h.clock.advance(2000);
  assert.equal(a.attempts.length,attempts);assert.equal(h.Engine.wantsPlayback(),false);
});

test('freeze capture and later source replacement cannot play an unrelated URL',async()=>{
  const h=make();await h.start();hide(h);h.ctx.document.emit('freeze');const a=h.audio();a.paused=true;
  h.ctx.document.emit('resume');const attempts=a.attempts.length;a.src='https://fixture.example.test/another-source.wav';
  await h.clock.advance(1000);assert.equal(a.attempts.length,attempts);
});

test('a missing pause task during a freeze remains ambiguous and yields to native Pause',async()=>{
  const h=make();await h.start();hide(h);h.ctx.document.emit('freeze');const a=h.audio(),attempts=a.attempts.length;
  // Both CDP freeze and browser/OS Pause can leave this exact observable state.
  // No page API identifies the native cause. Prefer explicit Play to guessing.
  a.paused=true;h.ctx.document.emit('resume');await h.clock.advance(2000);
  assert.equal(a.attempts.length,attempts);assert.equal(h.Engine.wantsPlayback(),false);
});

test('duplicate freeze returns consume a native ended queue once',async()=>{
  const h=make();addNext(h);await h.start();hide(h);h.ctx.document.emit('freeze');
  const a=h.audio();a.currentTime=a.duration;a.ended=true;a.paused=true;
  h.ctx.document.emit('resume');await flush();
  h.ctx.document.emit('resume');h.ctx.window.emit('pageshow');show(h);await flush();
  assert.equal(h.Engine.pos,1);assert.equal(h.Engine.current.id,h.Engine.queue[1].id);
});

test('completed final queue remains stopped across repeated freeze returns',async()=>{
  const h=make();await h.start();const a=h.audio();a.currentTime=a.duration;a.ended=true;a.paused=true;
  hide(h);h.ctx.document.emit('freeze');h.ctx.document.emit('resume');await flush();
  const attempts=a.attempts.length;
  h.ctx.document.emit('freeze');h.ctx.document.emit('resume');show(h);await h.clock.advance(60000);
  assert.equal(a.attempts.length,attempts);assert.equal(h.Engine.wantsPlayback(),false);
});

for(const error of ['NotAllowedError','AbortError'])test(`${error} from explicit Play remains terminal after freeze`,async()=>{
  const h=make();await h.start();h.Engine.pause();await h.clock.advance(0);
  hide(h);h.ctx.document.emit('freeze');h.ctx.document.emit('resume');h.Engine.play();
  const a=h.audio();a.attempts.at(-1).reject({name:error});await flush();const attempts=a.attempts.length;
  h.ctx.document.emit('resume');show(h);await h.clock.advance(60000);
  assert.equal(a.attempts.length,attempts);assert.equal(h.Engine.wantsPlayback(),false);
});

test('spare-element Pause cannot stop or restart the current track across freeze',async()=>{
  const h=make();await h.start();hide(h);h.ctx.document.emit('freeze');const a=h.audio(),attempts=a.attempts.length;
  h.Engine.els[1-h.Engine.cur].emit('pause');h.ctx.document.emit('resume');await h.clock.advance(2000);
  assert.equal(a.attempts.length,attempts);assert.equal(h.Engine.wantsPlayback(),true);
});

test('same-slot track replacement cancels a scheduled lifecycle resume',async()=>{
  const h=make();await h.start();hide(h);h.ctx.document.emit('freeze');const a=h.audio();a.paused=true;h.ctx.document.emit('resume');
  h.Engine._playRequest++;h.Engine.current={...h.Engine.current,id:'replacement-selection'};a.src='https://fixture.example.test/replacement.wav';
  const attempts=a.attempts.length;await h.clock.advance(1000);assert.equal(a.attempts.length,attempts);
});

test('media ending before a scheduled callback cannot be replayed by lifecycle recovery',async()=>{
  const h=make();await h.start();hide(h);h.ctx.document.emit('freeze');const a=h.audio();a.paused=true;h.ctx.document.emit('resume');
  const attempts=a.attempts.length;a.currentTime=a.duration;a.ended=true;
  await h.clock.advance(1000);assert.equal(a.attempts.length,attempts);
});

test('repeated freeze returns after an adopted interruption never restart native audio',async()=>{
  const h=make();await h.start();hide(h);const a=h.audio(),attempts=a.attempts.length;
  for(let i=0;i<4;i++){
    h.ctx.document.emit('freeze');a.paused=true;h.ctx.document.emit('resume');await h.clock.advance(6500);
    if(!a.paused)a.playing();
  }
  assert.equal(a.attempts.length,attempts);assert.equal(h.Engine.wantsPlayback(),false);
});
