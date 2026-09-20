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
  const audio=src=>({src,preload:'auto',paused:false,loads:0,pause(){this.paused=true;},removeAttribute(){this.src='';},load(){this.loads++;},play(){return {catch:fn=>{this.reject=fn;}};}});
  Engine.els=[audio('http://music.example.test/audio/current'),audio('http://music.example.test/audio/next')];
  Engine.cur=0;Engine.setGain=()=>{};Engine.ensureCtx=()=>{};Engine.updateMediaSession=()=>{};Engine._playRequest=1;
  return {Engine,PlaybackTransitions,revoked,renders:()=>renders};
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
