import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/drawercast/player.js',import.meta.url),'utf8');
const block=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
function harness(){
  const revoked=[];let renders=0;
  const context=vm.createContext({setTimeout,clearTimeout,debounce:fn=>fn,URL:{revokeObjectURL:u=>revoked.push(u)},
    SET:{fadeOnPause:false},UI:{renderPlayState(){renders++;},startLoop(){}},toast(){}});
  const {Engine,PlaybackTransitions}=vm.runInContext(block('const Engine = {','function SET_shuffleOn()')+
    block('const PlaybackTransitions={','function installPlaybackRework()')+'\n({Engine,PlaybackTransitions})',context);
  const audio=src=>({src,preload:'auto',paused:false,loads:0,events:{},pause(){this.paused=true;},removeAttribute(){this.src='';},load(){this.loads++;},addEventListener(name,fn){this.events[name]=fn;},removeEventListener(name){delete this.events[name];},play(){return {catch:fn=>{this.reject=fn;}};}});
  Engine.els=[audio('http://music.example.test/audio/current'),audio('http://music.example.test/audio/next')];
  Engine.cur=0;Engine.setGain=()=>{};Engine.ensureCtx=()=>{};Engine.updateMediaSession=()=>{};Engine._playRequest=1;
  return {Engine,PlaybackTransitions,ctx:context,revoked,renders:()=>renders};
}
test('cancelled transition releases spare streaming request',()=>{
  const {Engine,PlaybackTransitions}=harness();Engine.preloadId='unused';PlaybackTransitions.cancel();
  assert.equal(Engine.els[1].src,'');assert.equal(Engine.els[1].loads,1);assert.equal(Engine.preloadId,null);
  assert.match(Engine.els[0].src,/current$/);
});
test('gapless handoff retains the matching preloaded song',()=>{
  const {Engine,PlaybackTransitions}=harness();Engine.preloadId='next';PlaybackTransitions.cancel(true,'next');
  assert.match(Engine.els[1].src,/next$/);assert.equal(Engine.els[1].loads,0);assert.equal(Engine.preloadId,'next');
  PlaybackTransitions.cancel(true,'different');assert.equal(Engine.els[1].src,'');
});
test('released local object URLs are revoked',()=>{
  const {Engine,revoked}=harness();Engine.els[1].src='blob:local-track';Engine.releaseSlot(1);
  assert.deepEqual(revoked,['blob:local-track']);assert.equal(Engine.els[1].preload,'metadata');
});
test('late failure of an abandoned play attempt cannot pause the new track',()=>{
  const {Engine,renders}=harness();Engine.play();const reject=Engine.els[0].reject;const before=renders();
  Engine._playRequest++;Engine.els[0].src='http://music.example.test/audio/new';reject({name:'NotSupportedError'});
  assert.equal(Engine.playing,true);assert.equal(renders(),before);
});

test('rapid manual Drive skips select immediately without awaiting cloud crossfade readiness',async()=>{
  const calls=[],fades=[];
  const Engine={queue:[{id:'one',source:'drive'},{id:'two',source:'drive'},{id:'three',source:'drive'}],current:{id:'one',source:'drive'},playing:true,
    el:()=>({ended:false}),async playIndex(index){this.current=this.queue[index];calls.push(index);}};
  const ctx=vm.createContext({sourceTrackEnabled:t=>!!t,Engine,PlaybackTransitions:{cancel(){},to(index){fades.push(index);return new Promise(()=>{});}},
    nativeValues:()=>({fade_manual_advance:1}),clearTimeout,SET:{crossfadeLen:2}});
  const wrapper=source.slice(source.indexOf('  const playIndex=Engine.playIndex;'),source.indexOf('  Engine.setGain=function(i,value,ms)'));
  vm.runInContext(wrapper,ctx);
  const second=Engine.playIndex(1,true),third=Engine.playIndex(2,true);
  assert.equal(Engine.current.id,'three');assert.deepEqual(calls,[1,2]);assert.deepEqual(fades,[]);await Promise.all([second,third]);
  Engine.current={id:'local-old'};Engine.queue=[{id:'local-new'}];Engine.playIndex(0,true);assert.deepEqual(fades,[0],'local manual fades are unchanged');
});

test('a streamed Ogg duration arriving after loadedmetadata updates the track and its saved duration',()=>{
  const saved=[];
  class Audio {constructor(){this.events={};this.duration=Infinity;}setAttribute(){}addEventListener(name,fn){this.events[name]=fn;}}
  const ctx=vm.createContext({Audio,debounce:fn=>fn,document:{body:{appendChild(){}}},UI:{renderProgress(){},renderMeta(){}},persistTrack:t=>saved.push({...t})});
  const Engine=vm.runInContext(block('const Engine = {','function SET_shuffleOn()')+'\nEngine',ctx);Engine.init();Engine.current={id:'stream',dur:0};
  Engine.els[0].events.loadedmetadata();assert.equal(saved.length,0);
  Engine.els[0].duration=210;Engine.els[0].events.durationchange();assert.equal(Engine.current.dur,210);assert.equal(saved[0].dur,210);
  Engine.els[1].duration=999;Engine.els[1].events.durationchange();assert.equal(Engine.current.dur,210);
});

test('Drive metadata cannot reset the retry budget and an old timer cannot restart playback',()=>{
  const {Engine,ctx}=harness(),timers=[],messages=[];let retries=0,plays=0;
  ctx.setTimeout=fn=>{timers.push(fn);return timers.length};
  ctx.toast=message=>messages.push(message);
  ctx.UI.renderProgress=()=>{};ctx.UI.renderMeta=()=>{};
  ctx.DriveSource={retryFileFor:()=>({__remoteURL:'https://drive.test/audio?retry='+ ++retries}),playbackRetry:new Map()};
  ctx.audioSource=file=>file.__remoteURL;
  Engine.current={id:'gd_song',source:'drive',dur:100};
  Engine.els[0].duration=100;
  Engine.els[0].play=()=>{plays++;return Promise.resolve()};
  Engine.onError(0);
  Engine.onMeta(0); // Drive can report metadata before the stream fails again.
  Engine.onError(0);
  assert.equal(retries,1,'one retry per selection, even if metadata arrived');
  assert.equal(messages.filter(message=>message.includes('still could not play')).length,1);
  Engine._playRequest++; // The user selected this same song again before the old timer fired.
  timers[0]();
  assert.equal(plays,0,'a stale retry must not start the new selection');
});

test('a new selection stops the previous stream while its file is loading',async()=>{
  const {Engine,ctx}=harness();let resolveFile,advances=0,starts=0;
  ctx.sourceTrackEnabled=()=>true;
  ctx.DriveSource={prioritize(){},playbackRetry:new Map()};
  ctx.DrawerCast={canPlay:()=>true};
  ctx.getFileFor=()=>new Promise(resolve=>{resolveFile=resolve});
  ctx.audioSource=f=>f.__remoteURL;
  ctx.UI.renderNowPlaying=()=>{};
  Engine.queue=[{id:'old'},{id:'new'}];Engine.order=[0,1];Engine.current=Engine.queue[0];Engine.playing=true;
  Engine.applySpeed=()=>{};Engine.rgGain=()=>1;Engine.saveState=()=>{};
  Engine.next=()=>{advances++};Engine.play=()=>{starts++;Engine.playing=true};
  const pending=Engine.playIndex(1,true);
  assert.equal(Engine.els[0].paused,true);assert.equal(Engine.els[0].src,'');
  assert.equal(Engine.playing,false);
  Engine.onEnded(0);Engine.onError(0);
  assert.equal(advances,0,'late events from the abandoned stream do not advance the new selection');
  resolveFile({__remoteURL:'https://music.example.test/new'});await pending;
  assert.equal(Engine.els[0].src,'https://music.example.test/new');assert.equal(starts,1);
});

test('play waits for a missing source to load before asking the audio element to play',()=>{
  const {Engine}=harness();let selections=0,starts=0;
  Engine.els[0].src='';Engine.els[0].play=()=>{starts++};
  Engine.queue=[{id:'song'}];Engine.order=[0];Engine.pos=0;Engine.playIndex=()=>{selections++};
  Engine.play();assert.equal(selections,1);assert.equal(starts,0);
});

test('A15 network failure retries once and then reports a durable error',()=>{
  const {Engine,ctx}=harness(),timers=[],messages=[];let starts=0,errors=0;
  ctx.setTimeout=fn=>{timers.push(fn);return timers.length};
  ctx.toast=message=>messages.push(message);
  ctx.DrawerCast={fileFor:()=>({__remoteURL:'http://192.168.4.1:8765/audio/song?k=key'}),markError:()=>{errors++}};
  ctx.audioSource=file=>file.__remoteURL;
  Engine.current={id:'dc_song',remote:true,source:'server'};Engine.playing=true;
  Engine.els[0].currentTime=42;Engine.els[0].error={code:2};
  Engine.els[0].play=()=>{starts++;return Promise.resolve()};
  Engine.onError(0);
  assert.equal(starts,0);assert.match(Engine.els[0].src,/retry=/);
  Engine.els[0].duration=90;Engine.els[0].events.loadedmetadata();
  assert.equal(Engine.els[0].currentTime,42,'the retry keeps the playhead when metadata arrives');
  timers[0]();assert.equal(starts,1);
  Engine.onError(0);Engine.onError(0);
  assert.equal(errors,1);assert.equal(Engine.playing,false);
  assert.equal(messages.filter(message=>message.includes('retrying once')).length,1);
});

test('A15 silent stall invokes the same bounded retry and a stale timer cannot play a new song',()=>{
  const {Engine,ctx}=harness(),timers=[];let starts=0;
  ctx.setTimeout=fn=>{timers.push(fn);return timers.length};
  ctx.DrawerCast={fileFor:()=>({__remoteURL:'http://192.168.4.1:8765/audio/song?k=key'}),markError(){}};
  ctx.audioSource=file=>file.__remoteURL;
  Engine.current={id:'dc_song',remote:true,source:'server'};Engine.playing=true;Engine.els[0].currentTime=12;
  Engine.els[0].play=()=>{starts++;return Promise.resolve()};
  Engine.onBuffering(0);timers[0]();
  assert.match(Engine.els[0].src,/retry=/);
  Engine._playRequest++;timers[1]();assert.equal(starts,0);
});

test('saved queue rejects a damaged order rather than indexing outside the library',async()=>{
  const {Engine,ctx}=harness();
  const tracks=[{id:'one',remote:true},{id:'two',remote:true}];
  ctx.SET.keepQueue=true;ctx.LIB={map:new Map(tracks.map(t=>[t.id,t]))};
  ctx.sourceTrackEnabled=t=>!!t;
  ctx.IDB={get:async()=>({ids:['one','two'],order:[99,99],curId:'one'})};
  ctx.UI.renderNowPlaying=()=>{};ctx.UI.renderProgress=()=>{};
  assert.equal(await Engine.restoreState(),true);
  assert.deepEqual(Array.from(Engine.order),[0,1]);assert.equal(Engine.current.id,'one');
});

test('the installed end-of-track handler ignores old and delayed endings',()=>{
  const {Engine,ctx}=harness(),timers=[];let advances=0;
  ctx.setTimeout=fn=>{timers.push(fn);return timers.length};
  ctx.nativeValues=()=>({track_end_silence_ms:50});ctx.persistTrack=()=>{};
  vm.runInContext(block('  Engine.onEnded=function(i){','  Engine.startCrossfade=function()'),ctx);
  Engine.current={id:'new'};Engine.countPlayed=()=>{};Engine.next=()=>{advances++};
  Engine._loadingRequest=Engine._playRequest;
  Engine.onEnded(0);assert.equal(timers.length,0);
  Engine._loadingRequest=null;Engine.onEnded(0);assert.equal(timers.length,1);
  Engine._playRequest++;timers[0]();assert.equal(advances,0);
});
