import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Execute the actual waveform component without booting the monolithic player UI.
const source=await readFile(new URL('../public/drawercast/player.js',import.meta.url),'utf8');
const start=source.indexOf('const Waveform={');
const end=source.indexOf('\nfunction installLyricsRework()',start);
assert.ok(start>=0&&end>start);
function harness({cached,remoteFile=true,cacheRead}={}){
  const calls={files:0,fetch:0,decode:0,reads:0,writes:0,draw:0};
  const context=vm.createContext({
    Float32Array,Uint8Array,Map,AbortController,Blob,setTimeout,clearTimeout,
    UI:{drawViz(){calls.draw++;}},
    clamp:(x,min,max)=>Math.max(min,Math.min(max,x)),
    IDB:{async get(){return cacheRead?cacheRead():cached;},async set(){calls.writes++;}},
    async getFileFor(){calls.files++;return remoteFile?
      {__remoteURL:'http://music.example.test/audio/track',size:32}:
      {size:32,async arrayBuffer(){calls.reads++;return new ArrayBuffer(32);}};},
    async fetch(){calls.fetch++;throw new Error('Waveform must not download streamed audio');},
    window:{OfflineAudioContext:class{async decodeAudioData(){calls.decode++;return {
      duration:1,sampleRate:16,length:16,numberOfChannels:1,
      getChannelData(){return new Float32Array(16).fill(.5);}
    };}}}
  });
  const waveform=vm.runInContext(source.slice(start,end)+'\nWaveform;',context);
  function select(track){waveform.load(track);clearTimeout(waveform.timer);}
  return {waveform,calls,select};
}

test('uncached A15 waveform never opens or downloads a second audio stream',async()=>{
  const {waveform,calls,select}=harness();
  select({id:'remote',remote:true,dur:180});await waveform.run();
  assert.equal(calls.files,0);assert.equal(calls.fetch,0);assert.equal(calls.decode,0);
  assert.equal(waveform.ready,false);
  waveform.sample(Uint8Array.of(128,192,64),12,180);
  assert.equal(waveform.level(12,12.0625),.5);
  assert.equal(waveform.level(15,16),null);
});

test('cached remote waveform remains available without opening media',async()=>{
  const {waveform,calls,select}=harness({cached:{duration:2,peaks:Uint8Array.of(255,128)}});
  select({id:'cached-remote',remote:true,dur:2});await waveform.run();
  assert.equal(waveform.ready,true);assert.equal(waveform.level(0,.0625),1);
  assert.equal(calls.files,0);assert.equal(calls.fetch,0);assert.equal(calls.decode,0);
});

test('a remote media descriptor cannot trigger a download even without the track flag',async()=>{
  const {waveform,calls,select}=harness();
  select({id:'descriptor-only',dur:180});await waveform.run();
  assert.equal(calls.fetch,0);assert.equal(calls.decode,0);
});

test('local files still receive a complete decoded and cached waveform',async()=>{
  const {waveform,calls,select}=harness({remoteFile:false});
  select({id:'local',dur:1});await waveform.run();
  assert.equal(calls.fetch,0);assert.equal(calls.decode,1);assert.equal(calls.reads,1);
  assert.equal(calls.writes,1);assert.equal(waveform.ready,true);
  assert.equal(waveform.peaks.length,16);assert.equal(waveform.level(0,1),1);
});

test('changing tracks while cache loads cannot apply the previous waveform',async()=>{
  let resolveCache;
  const {waveform,calls,select}=harness({cacheRead:()=>new Promise(resolve=>{resolveCache=resolve;})});
  select({id:'old',remote:true,dur:1});const pending=waveform.run();
  select(null);resolveCache({duration:1,peaks:Uint8Array.of(255)});await pending;
  assert.equal(waveform.id,null);assert.equal(waveform.ready,false);
  assert.equal(calls.files,0);assert.equal(calls.fetch,0);assert.equal(calls.draw,0);
});
