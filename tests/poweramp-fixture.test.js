import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {fixtureSceneSettled,installFixtureInputTrace} from './helpers/poweramp-fixture.js';

test('browser fixture readiness requires the physical endpoint, not just navigation ownership',()=>{
  const current={hidden:false,inert:false,dataset:{}},motion={state:null,finish:null};let plane=null;
  const context=vm.createContext({PA:{Nav:{cur:'list'},LibraryPageMotion:motion},document:{querySelector:selector=>selector==='#sc-list'?current:plane}});
  const ready=()=>vm.runInContext('('+fixtureSceneSettled.toString()+')("list")',context);
  assert.equal(ready(),true);
  current.dataset.scene='1';assert.equal(ready(),false,'active generic vertical arrival must retire first');delete current.dataset.scene;
  plane={};assert.equal(ready(),false,'shared player contact plane must retire first');plane=null;
  motion.state={};assert.equal(ready(),false);motion.state=null;motion.finish={pending:true};assert.equal(ready(),false);motion.finish=null;
  current.inert=true;assert.equal(ready(),false);current.inert=false;current.hidden=true;assert.equal(ready(),false);current.hidden=false;
  context.PA.Nav.cur='library';assert.equal(ready(),false);context.PA.Nav.cur='list';assert.equal(ready(),true);
});

test('browser input evidence stays bounded, preserves trusted capture targets, and is read-only',()=>{
  const listeners=new Map(),pending=[],title={tagName:'DIV',id:'mini-title',classList:['t1'],dataset:{},textContent:'should never be collected'};
  const mini={tagName:'DIV',id:'mini',classList:[],dataset:{}},lifecycle={gesture:{node:mini},contacts:new Set([1])};
  const context=vm.createContext({window:{PA:{Nav:{cur:'list'},LibraryPageMotion:{state:null},UI:{seekDragging:false}}},InputLifecycle:lifecycle,ScreenDrag:{phase:'drag'},queueMicrotask:fn=>pending.push(fn),
    document:{querySelector:()=>null,addEventListener(type,fn,options){assert.equal(options.capture,true);assert.equal(options.passive,true);listeners.set(type,fn);}}});
  vm.runInContext('('+installFixtureInputTrace.toString()+')()',context);context.fixtureInputTrace=context.window.fixtureInputTrace;
  for(let i=0;i<100;i++)listeners.get('lostpointercapture')({type:'lostpointercapture',target:title,isTrusted:true,pointerId:1,clientX:100,clientY:720,defaultPrevented:false});
  pending.forEach(fn=>fn());
  const trace=context.window.fixtureInputTrace;assert.equal(trace.length,80);
  assert.equal(trace.at(-1).target,'div#mini-title.t1');assert.equal(trace.at(-1).trusted,true);
  assert.equal(trace.at(-1).before.gesture,'div#mini');assert.equal(trace.at(-1).after.gesture,'div#mini');
  assert.equal(lifecycle.gesture.node,mini);assert.equal(lifecycle.contacts.size,1);
  assert.doesNotMatch(JSON.stringify(trace),/should never be collected/);
});
