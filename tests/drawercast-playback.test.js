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
