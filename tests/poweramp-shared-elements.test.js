import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(process.env.POWERAMP_PLAYER_FILE||new URL('../public/drawercast/player.js',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)+start.length));
const plain=value=>JSON.parse(JSON.stringify(value));
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);
const transform=node=>{const parts=/translate\(([-\d.e+]+)px,([-\d.e+]+)px\) scale\(([-\d.e+]+),([-\d.e+]+)\)/.exec(node.style.transform);assert.ok(parts,node.style.transform);return parts.slice(1).map(Number);};
const revealBounds=reveal=>{const {mask,node}=reveal,[mx,my,sx,sy]=transform(mask),[nx,ny,ix,iy]=transform(node);return {
  mask:{left:parseFloat(mask.style.left)+mx,top:parseFloat(mask.style.top)+my,width:parseFloat(mask.style.width)*sx,height:parseFloat(mask.style.height)*sy},
  content:{left:parseFloat(mask.style.left)+mx+sx*(parseFloat(node.style.left)+nx),top:parseFloat(mask.style.top)+my+sy*(parseFloat(node.style.top)+ny),width:parseFloat(node.style.width)*sx*ix,height:parseFloat(node.style.height)*sy*iy}
};};
function harness({reduced=false,width=393,height=852,mutations=false}={}){
  let now=1000,sequence=0,draws=0;const cost={computedReads:0,rectReads:0,styleWrites:0,layoutWrites:0,clipWrites:0,attributeWrites:0,clones:0},pseudoReads=new Map();
  const countStyle=key=>{cost.styleWrites++;if(key==='clip-path')cost.clipWrites++;if(['left','top','width','height','min-width','min-height','max-width','max-height','margin','inset','position'].includes(key))cost.layoutWrites++;};const observers=[];const nodes=new Map(),frames=new Map(),timers=new Map(),fits=[];
  const dashed=key=>String(key).replace(/[A-Z]/g,char=>'-'+char.toLowerCase());
  function style(initial={}){
    const values=new Map(Object.entries(initial).map(([key,value])=>[dashed(key),String(value)])),priorities=new Map();
    return new Proxy({getPropertyValue:key=>values.get(key)||'',getPropertyPriority:key=>priorities.get(key)||'',setProperty(key,value,priority=''){countStyle(key);values.set(key,String(value));priorities.set(key,priority);},removeProperty(key){const previous=values.get(key);values.delete(key);priorities.delete(key);return previous;}},{
      get(target,key){if(key==='length')return values.size;if(/^\d+$/.test(String(key)))return [...values.keys()][+key];if(key==='cssText')return [...values].map(([a,b])=>`${a}:${b}`).join(';');return key in target?target[key]:values.get(dashed(key))||'';},
      set(target,key,value){countStyle(dashed(key));if(key==='cssText'){values.clear();for(const entry of String(value).split(';')){const at=entry.indexOf(':');if(at>0)values.set(entry.slice(0,at),entry.slice(at+1));}}else values.set(dashed(key),String(value));return true;}
    });
  }
  let body;
  function node(id='',rect={left:0,top:0,width,height},tag='DIV'){
    const classes=new Set(),events=new Map();let captured=null;
    const n={id,tagName:tag,rect:{...rect},children:[],parentElement:null,hidden:false,inert:false,dataset:{},attrs:new Map(),style:style(),textContent:'',computed:{display:'block',opacity:'1',transform:'none',transition:'none',content:'none','background-image':'none','background-size':'cover','background-color':'#201b16',background:'#201b16','will-change':'auto','border-top-left-radius':'0px','border-top-right-radius':'0px','border-bottom-right-radius':'0px','border-bottom-left-radius':'0px'},
      get clientHeight(){return this.rect.height;},get clientWidth(){return this.rect.width;},get isConnected(){let p=this;while(p){if(p===body)return true;p=p.parentElement;}return false;},
      classList:{add(...names){for(const name of names)classes.add(name);},remove(...names){for(const name of names)classes.delete(name);},contains:name=>classes.has(name),toggle(name,on){if(on??!classes.has(name))classes.add(name);else classes.delete(name);}},
      set className(value){classes.clear();for(const name of value.split(' '))if(name)classes.add(name);},get className(){return [...classes].join(' ');},
      setAttribute(key,value){cost.attributeWrites++;this.attrs.set(key,String(value));if(key==='id')this.id=String(value);},getAttribute(key){return this.attrs.get(key)??null;},removeAttribute(key){this.attrs.delete(key);if(key==='id')this.id='';},
      appendChild(child){child.remove();child.parentElement=this;this.children.push(child);return child;},remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;},
      querySelectorAll(){return this.children.flatMap(child=>[child,...child.querySelectorAll('*')]);},
      contains(target){let p=target;while(p){if(p===this)return true;p=p.parentElement;}return false;},
      closest(selector){let p=this;while(p){if(selector.split(',').some(part=>part==='#'+p.id))return p;if(selector==='.screen'&&p.classList.contains('screen'))return p;p=p.parentElement;}return null;},
      cloneNode(deep){cost.clones++;const copy=node('',this.rect,this.tagName);copy.id=this.id;copy.computed={...this.computed};copy.style.cssText=this.style.cssText;copy.attrs=new Map(this.attrs);copy.hidden=this.hidden;copy.inert=this.inert;copy.className=this.className;copy.textContent=this.textContent;copy.innerHTML=this.innerHTML;if(deep)for(const child of this.children)copy.appendChild(child.cloneNode(true));return copy;},
      getBoundingClientRect(){cost.rectReads++;let top=this.rect.top,left=this.rect.left,p=this;while(p){const transform=p.style.transform||computed(p).transform;top+=Number(/translateY\((-?[\d.]+)px\)/.exec(transform)?.[1])||0;left+=Number(/translateX\((-?[\d.]+)px\)/.exec(transform)?.[1])||0;p=p.parentElement;}return {left,top,width:this.rect.width,height:this.rect.height};},
      addEventListener(type,fn){if(!events.has(type))events.set(type,new Set());events.get(type).add(fn);},removeEventListener(type,fn){events.get(type)?.delete(fn);},
      getContext(){return {clearRect(){},drawImage(){draws++;}};},
      setPointerCapture(id){captured=id;},hasPointerCapture:id=>captured===id,releasePointerCapture(){captured=null;},
      fire(type,values={}){const e={type,target:this,pointerId:1,isPrimary:true,button:0,clientX:180,clientY:300,timeStamp:now,detail:1,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...values};for(const fn of [...events.get(type)||[]]){fn(e);if(e.stopped)break;}return e;}
    };if(id)nodes.set('#'+id,n);return n;
  }
  function computed(n,pseudo){
    cost.computedReads++;if(pseudo)pseudoReads.set(n,(pseudoReads.get(n)||0)+1);const values={...n.computed};if(pseudo){values.content=n.id==='mini-fill'&&pseudo==='::after'?'""':'none';}
    for(const key of Object.keys(values)){const inline=n.style.getPropertyValue(key);if(inline)values[key]=inline;}
    let ancestor=n;while(ancestor){if(ancestor.hidden){values.display='none';break;}ancestor=ancestor.parentElement;}
    if(!pseudo&&n.animatedOpacity!=null)values.opacity=String(n.animatedOpacity);
    if(n.id==='mini'&&n.classList.contains('down')&&!n.style.transform)values.transform=`translateY(${n.rect.height*1.4}px)`;
    if(n.id==='nav'&&!n.style.getPropertyValue('border-top-left-radius')){const radius=nodes.get('#mini')?.hidden?'29px':'0px';values['border-top-left-radius']=values['border-top-right-radius']=radius;}
    const keys=Object.keys(values);return new Proxy({length:keys.length,getPropertyValue:key=>values[key]||''},{get(target,key){if(key in target)return target[key];if(/^\d+$/.test(String(key)))return keys[Number(key)];return values[dashed(key)]||'';}});
  }
  body=node('body');const document=node(),window=node();document.body=body;document.createElement=tag=>node('',undefined,tag.toUpperCase());
  const add=(id,rect,parent=body,tag)=>parent.appendChild(node(id,rect,tag));
  const bg=add('bg',{left:0,top:0,width,height}),dim=add('bg-dim',bg.rect,bg);dim.computed.opacity='.66';
  const app=add('app',{left:0,top:0,width,height});
  for(const id of ['player','library','list','eq','search','settings']){const n=add('sc-'+id,app.rect,app);n.classList.add('screen');n.hidden=id!=='player';}
  const full=nodes.get('#sc-player'),wrap=add('wrap',app.rect,full),art=add('artstage',{left:14,top:13,width:width-28,height:width-28},wrap);
  add('artB',art.rect,art);const artA=add('artA',art.rect,art);artA.computed['background-image']='url(fixture-cover)';artA.computed['background-size']='contain';add('art-icon',art.rect,artA);
  add('p-title',{left:14,top:width-4,width:160,height:30},wrap).textContent='Open Windows';
  add('p-sub',{left:14,top:width+29,width:210,height:24},wrap).textContent='Mira Vale';
  const transport=add('transport',{left:14,top:height-300,width:width-28,height:150},wrap);
  const canvas=add('viz',transport.rect,transport,'CANVAS');canvas.getContext=()=>({drawImage(){}});
  add('btn-play',{left:width/2-48,top:height-285,width:96,height:96},transport,'BUTTON');
  const seekrow=add('seekrow',{left:14,top:height-140,width:width-28,height:26},wrap);add('t-cur',{left:14,top:height-140,width:44,height:26},seekrow);add('t-dur',{left:width-58,top:height-140,width:44,height:26},seekrow);add('seek',{left:68,top:height-138,width:width-136,height:22},seekrow);
  const mini=add('mini',{left:9,top:height-158,width:width-18,height:82});mini.hidden=true;mini.classList.add('down');mini.computed.background='#14110f';
  for(const key of ['border-top-left-radius','border-top-right-radius'])mini.computed[key]='29px';
  const miniArt=add('mini-art',{left:25,top:height-149,width:36,height:36},mini);miniArt.computed['background-image']='url(fixture-cover)';miniArt.computed['border-top-left-radius']='12px';
  add('mini-title',{left:74,top:height-149,width:190,height:16},mini).textContent='Open Windows';
  add('mini-sub',{left:74,top:height-131,width:190,height:14},mini).textContent='Mira Vale';
  add('mini-play',{left:width-61,top:height-149,width:36,height:36},mini,'BUTTON');const miniSeek=add('mini-seek',{left:25,top:height-108,width:width-50,height:12},mini);add('mini-fill',miniSeek.rect,miniSeek);
  const nav=add('nav',{left:9,top:height-76,width:width-18,height:66});
  const $=selector=>selector==='.seekrow'?seekrow:nodes.get(selector);
  const context=vm.createContext({$, $$:()=>[],document,window,innerHeight:height,SET:{animations:'normal',listBg:true,longPressMenu:false},Engine:{current:{id:'song'}},UI:{fitPlayer(){fits.push({hidden:full.hidden,transform:full.style.transform});},renderProgress(){},syncNav(){},drawCurve(){}},EQ:{render(){}},Selection:{mode:false},Sheets:{request:0},history:{pushState(){}},matchMedia:()=>({matches:reduced}),clamp:(n,a,b)=>Math.max(a,Math.min(b,n)),performance:{now:()=>now},getComputedStyle:computed,
    requestAnimationFrame(fn){frames.set(++sequence,fn);return sequence;},cancelAnimationFrame:id=>frames.delete(id),setTimeout(fn,ms=0){timers.set(++sequence,{fn,at:now+ms});return sequence;},clearTimeout:id=>timers.delete(id)});
  if(mutations)context.MutationObserver=class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}};
  vm.runInContext(section('const SCREENS=','window.addEventListener(\'popstate\'')+section('const GestureMotion=','const SwipeArt=')+section('const SharedPlayerMotion=','function libraryDestination()')+'\nglobalThis.shared=SharedPlayerMotion;globalThis.scene=ScreenDrag;globalThis.nav=Nav;globalThis.lifecycle=InputLifecycle;',context);
  const advance=ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}};
  const frame=ms=>{advance(ms);for(const [id,fn] of [...frames]){frames.delete(id);fn(now);}};
  const list=()=>{context.SET.animations='disabled';context.nav.go('list',false);context.SET.animations='normal';mini.classList.remove('down');};
  return {context,$,nodes,body,fits,frames,timers,observers,cost,pseudoReads,resetCost(){for(const key of Object.keys(cost))cost[key]=0;draws=0;pseudoReads.clear();},draws:()=>draws,advance,frame,list,shared:context.shared,scene:context.scene,nav:context.nav,lifecycle:context.lifecycle};
}

function installHistoryCounter(h){
  const list=h.$('#sc-list'),scroll=h.context.document.createElement('div');scroll.id='list-body';scroll.scrollTop=618;scroll.scrollLeft=37;list.appendChild(scroll);
  const select=h.context.$;h.context.$=selector=>selector==='#list-body'?scroll:select(selector);
  h.context.Views={currentSpec:{kind:'all'},stack:[{kind:'all'}],push(){},render(){},renderLibrary(){}};
  vm.runInContext(section('const LibraryPageHistory=','function bindLibraryPageGesture')+'\nLibraryPageMotion.install=()=>{};LibraryPageHistory.install();LibraryPageHistory.entries=[LibraryPageHistory.make("list",Views.currentSpec,Views.stack)];LibraryPageHistory.index=0;globalThis.pageHistory=LibraryPageHistory;globalThis.pageMotion=LibraryPageMotion;',h.context);
  const captures=[],capture=h.context.pageMotion.capture.bind(h.context.pageMotion);h.context.pageMotion.capture=(screen,...args)=>{captures.push(screen);return capture(screen,...args);};
  return {captures,scroll,entry:h.context.pageHistory.current()};
}

test('real shared-player drag release saves library scroll without cloning its mounted page',()=>{
  const h=harness();h.list();const {captures,scroll,entry}=installHistoryCounter(h);
  h.scene.begin('player',-1);h.scene.move(-100);assert.ok(h.scene.state.morph);assert.equal(captures.length,0);
  h.scene.end(true,-.7);assert.equal(h.nav.cur,'player');assert.ok(h.scene.settling.morph);assert.equal(captures.length,0,'release does not capture the outgoing list');
  assert.equal(entry.scrollTop,618);assert.equal(entry.scrollLeft,37);assert.equal(entry.snapshotDeferred,true);
  h.frame(1000);assert.equal(captures.length,0,'morph cleanup does not schedule an idle history clone');h.nav.go('list');h.frame(1000);assert.equal(captures.length,0,'same-page return does not need a snapshot');
  scroll.scrollTop=731;h.context.pageHistory.save();assert.equal(captures.length,1);assert.equal(entry.scrollTop,731);assert.equal(entry.snapshotDeferred,false);
});

test('real shared-player tap avoids a history clone before and inside scene activation',()=>{
  const h=harness();h.list();const {captures,entry}=installHistoryCounter(h);h.nav.go('player');
  assert.equal(h.nav.cur,'player');assert.ok(h.scene.settling.morph);assert.equal(captures.length,0,'outer tap navigation and nested activation both stay cheap');assert.equal(entry.snapshotDeferred,true);
  h.frame(1000);assert.equal(captures.length,0);assert.equal(h.scene.phase,'idle');
});

test('actual canonical DOM bounds define all six shared paths, independent of screen transforms',()=>{
  for(const width of [320,393,744]){const h=harness({width});h.list();h.$('#sc-player').style.transform='translateY(237px)';h.scene.begin('player',-1);const m=h.scene.state.morph;
    assert.ok(m,'exercise the real clone/morph branch');assert.equal(h.fits.at(-1).transform,'none');assert.equal(h.fits.at(-1).hidden,false);
    assert.equal(m.endpoints.art.full.top,13);assert.equal(m.endpoints.art.full.width,width-28);assert.equal(m.endpoints.surface.mini.width,width-18);
    for(const p of [0,.25,.5,.75,1]){h.shared.paint(m,p);for(const [key,pair] of Object.entries(m.endpoints))for(const field of ['left','top','width','height'])near(m.geometry[key][field],pair.mini[field]+(pair.full[field]-pair.mini[field])*p);}
  }
});

test('the real branch paints one moving player shell and suppresses stationary originals',()=>{
  const h=harness();h.list();h.scene.begin('player',-1);const s=h.scene.state,m=s.morph;
  h.scene.move(-s.height*.5);near(m.p,.5);assert.equal(s.from.style.transform,'');assert.equal(s.to.style.transform,'none');
  assert.equal(h.$('#mini').style.opacity,'0');assert.equal(h.$('#sc-player').style.opacity,'0');assert.equal(m.layer.inert,true);assert.equal(m.layer.getAttribute('aria-hidden'),'true');
  assert.equal(m.artNodes.mini.style.opacity,'.5'.replace(/^\./,'0.'));assert.equal(m.artNodes.full.style.opacity,'0.5');
  assert.equal(m.artNodes.mini.style.backgroundSize,'cover');assert.equal(m.artNodes.full.style.backgroundSize,'contain','endpoint appearance keeps full-player artwork fit');
  assert.equal(m.fullClone._sceneNodes.get(h.$('#artA')).style.visibility,'hidden');assert.equal(m.fullClone._sceneNodes.get(h.$('#p-title')).style.visibility,'hidden');assert.equal(m.fullClone._sceneNodes.get(h.$('#p-title')).style.opacity,'0','computed visible descendants cannot escape canonical suppression');
  assert.equal(m.surface.style.opacity,'1','expanded player cannot reveal list text through its shell');near(Number(h.$('#bg-dim').style.opacity),.33);near(parseFloat(h.$('#nav').style.getPropertyValue('border-top-left-radius')),14.5);
  for(const n of [m.layer,...m.layer.querySelectorAll('*')])assert.equal(n.id,'','clones do not duplicate live IDs');
});

test('closing follows the exact same sampled geometry and endpoint appearance in reverse',()=>{
  const a=harness();a.list();a.scene.begin('player',-1);const opening=a.scene.state.morph;
  const b=harness();b.scene.begin('list',1);const closing=b.scene.state.morph;
  for(const p of [0,.25,.5,.75,1]){a.shared.paint(opening,p);b.shared.paint(closing,p);assert.deepEqual(plain(opening.geometry),plain(closing.geometry));assert.equal(opening.artNodes.mini.style.backgroundSize,closing.artNodes.mini.style.backgroundSize);assert.equal(opening.artNodes.full.style.backgroundSize,closing.artNodes.full.style.backgroundSize);}
});

test('RAF pause freezes the last painted rectangles; reverse movement rebases from that frame',()=>{
  const h=harness();h.list();h.scene.begin('player',-1);h.scene.move(-100);h.scene.end(true,-.7);const m=h.scene.settling.morph;
  h.frame(45);const p=m.p,rects=plain(m.geometry);h.scene.pause();h.advance(500);assert.equal(m.p,p);assert.deepEqual(plain(m.geometry),rects);assert.equal(h.scene.phase,'possible');
  h.scene.begin('list',1);h.scene.move(70);near(m.p,p-70/h.scene.state.height);h.scene.end(false);h.advance(1000);
  assert.equal(h.nav.cur,'list');assert.equal(h.scene.phase,'idle');assert.equal(m.layer.isConnected,false);assert.equal(h.$('#sc-player').hidden,true);
});

test('the contact plane interrupts and holds painted geometry, then reverses without touching a canonical button',()=>{
  const h=harness();h.list();h.nav.go('player');h.frame(45);const m=h.scene.settling.morph,p=m.p,rects=plain(m.geometry);
  m.input.fire('pointerdown');h.advance(500);assert.equal(m.p,p);assert.deepEqual(plain(m.geometry),rects);assert.equal(h.lifecycle.gesture.node,m.input);
  m.input.fire('pointermove',{clientY:410});h.frame(30);m.input.fire('pointerup',{clientY:410});h.advance(1000);assert.equal(h.nav.cur,'list');assert.equal(h.lifecycle.gesture,null);assert.equal(m.input.isConnected,false);
});

test('cleanup restores borrowed styles and transient input registrations at the canonical endpoint',()=>{
  const h=harness();h.list();const mini=h.$('#mini'),full=h.$('#sc-player'),nav=h.$('#nav'),dim=h.$('#bg-dim');mini.style.opacity='.9';full.style.opacity='.8';nav.style.setProperty('border-top-right-radius','7px','important');dim.style.transition='opacity 10ms linear';
  const registered=h.lifecycle.resets.size;h.nav.go('player');const m=h.scene.settling.morph;h.frame(1000);
  assert.equal(h.scene.finish,null);assert.equal(h.scene.settling,null);assert.equal(h.lifecycle.resets.size,registered);assert.equal(h.frames.size,0);assert.equal(h.timers.size,0);
  assert.equal(mini.style.opacity,'.9');assert.equal(full.style.opacity,'.8');assert.equal(nav.style.getPropertyValue('border-top-right-radius'),'7px');assert.equal(nav.style.getPropertyPriority('border-top-right-radius'),'important');assert.equal(dim.style.transition,'opacity 10ms linear');
  assert.equal(mini.hidden,true);assert.equal(full.hidden,false);assert.equal(full.inert,false);assert.equal(full.getAttribute('aria-hidden'),'false');assert.equal(mini.getAttribute('aria-hidden'),null);assert.equal(mini.dataset.sharedPlayer,undefined);assert.equal(m.layer.isConnected,false);
});

test('abort on blur and resize retires layer, capture, callbacks and inactive scene ownership',()=>{
  for(const type of ['blur','resize']){const h=harness();h.list();h.nav.go('player');h.frame(25);const m=h.scene.settling.morph;m.input.fire('pointerdown');h.context.window.fire(type);h.advance(1000);
    assert.equal(h.scene.phase,'idle');assert.equal(m.layer.isConnected,false);assert.equal(m.input.isConnected,false);assert.equal(h.frames.size,0);assert.equal(h.lifecycle.gesture,null);assert.equal(h.$('#sc-player').hidden,false);assert.equal(h.$('#sc-list').hidden,true);}
});

test('reduced motion settles synchronously without constructing a shared scene or a live timer',()=>{
  const h=harness({reduced:true});h.nav.go('list');assert.equal(h.nav.cur,'list');assert.equal(h.scene.phase,'idle');assert.equal(h.scene.finish,null);assert.equal(h.frames.size,0);assert.equal(h.timers.size,0);assert.equal(h.body.children.some(n=>n.className==='player-scene-layer'),false);
});


test('captured mini/art owners remain event-capable while all canonical tab stops are suppressed',()=>{
  for(const origin of ['mini','artstage']){const h=harness();if(origin==='mini')h.list();const owner=h.$('#'+origin),mini=h.$('#mini'),button=h.$('#btn-play');mini.setAttribute('tabindex','0');button.setAttribute('tabindex','2');
    h.lifecycle.claim(owner,9);owner.setPointerCapture(9);h.scene.begin(origin==='mini'?'player':'list',origin==='mini'?-1:1);const m=h.scene.state.morph;
    assert.equal((origin==='mini'?mini:h.$('#sc-player')).inert,false,'captured ancestor stays event-capable');assert.equal(mini.getAttribute('tabindex'),'-1');assert.equal(button.getAttribute('tabindex'),'-1');
    h.lifecycle.release(owner,9);owner.releasePointerCapture(9);h.shared.paint(m,m.p);assert.equal(mini.inert,true);assert.equal(h.$('#sc-player').inert,true);
    h.scene.end(true);h.frame(1000);assert.equal(mini.getAttribute('tabindex'),'0');assert.equal(button.getAttribute('tabindex'),'2');assert.equal(h.$('#sc-player').inert,h.nav.cur!=='player');
  }
});

test('third-screen navigation from an opening player preserves the same painted layer before collapsing',()=>{
  const h=harness();h.list();h.nav.go('player');h.frame(45);const m=h.scene.settling.morph,p=m.p,rects=plain(m.geometry);h.nav.go('eq');
  assert.equal(h.scene.settling.morph,m);assert.equal(m.p,p);assert.deepEqual(plain(m.geometry),rects);assert.equal(m.opening,false);assert.equal(h.nav.cur,'eq');h.frame(1000);
  assert.equal(h.$('#sc-eq').hidden,false);assert.equal(h.$('#sc-eq').inert,false);assert.equal(h.$('#sc-player').hidden,true);assert.equal(h.$('#sc-list').hidden,true);assert.equal(m.layer.isConnected,false);
});

test('a new current track retires held clones without changing audio or playback intent',()=>{
  const h=harness({mutations:true});h.list();h.nav.go('player');h.frame(40);const m=h.scene.settling.morph;h.scene.pause();h.context.Engine.current={id:'new-song'};h.observers.at(-1).callback();
  assert.equal(h.context.Engine.current.id,'new-song');assert.equal(h.scene.phase,'idle');assert.equal(m.layer.isConnected,false);assert.equal(m.input.isConnected,false);assert.equal(h.observers.at(-1).disconnected,true);
});


test('late art decoding removes cloned placeholders and refreshes the painted background palette',()=>{
  const h=harness({mutations:true});h.list();h.scene.begin('player',-1);const m=h.scene.state.morph,placeholder=h.$('#art-icon');placeholder.style.display='none';h.$('#bg').computed.background='#447788';
  h.observers.at(-1).callback();assert.equal(m.artNodes.full._sceneNodes.get(placeholder).style.display,'none');assert.equal(m.background.style.background,'#447788');
});


test('held scene progress pixels, seek thumb and play icon refresh without moving the owned geometry',()=>{
  const h=harness({mutations:true});h.list();h.nav.go('player');h.frame(40);const m=h.scene.settling.morph;h.scene.pause();const p=m.p,rects=plain(m.geometry),old=m.pairs.play.mini,draws=h.draws();
  h.$('#mini-fill').style.transform='translateX(73px)';h.$('#t-cur').textContent='0:42';h.$('#mini-play').innerHTML='pause-icon';h.observers.at(-1).callback();
  assert.equal(m.p,p);assert.deepEqual(plain(m.geometry),rects);assert.equal(m.pairs.seek.mini._sceneNodes.get(h.$('#mini-fill')).style.transform,'translateX(73px)');assert.equal(m.fullClone._sceneNodes.get(h.$('#t-cur')).textContent,'0:42');
  assert.ok(h.draws()>draws,'existing playback canvas pixels are refreshed');assert.notEqual(m.pairs.play.mini,old);assert.equal(m.pairs.play.mini.innerHTML,'pause-icon');assert.equal(old.isConnected,false);assert.equal(m.pairs.play.mini.style.opacity,String(1-p));
});


test('a nonzero app toolbar/safe-area origin never translates or rescales the global backdrop',()=>{
  for(const offset of [28,47]){const h=harness();h.list();const full=h.$('#sc-player'),bg=h.$('#bg');full.rect={...full.rect,top:offset,height:full.rect.height-offset};
    for(const node of full.querySelectorAll('*'))node.rect.top+=offset;
    const miniRect=plain(h.shared.rect(h.$('#mini'))),backgroundRect=plain(h.shared.rect(bg)),fullRect=plain(h.shared.rect(full));h.scene.begin('player',-1);const m=h.scene.state.morph;
    assert.deepEqual(plain(m.backgroundBounds),backgroundRect);assert.deepEqual(plain(m.endpoints.surface.full),fullRect);
    for(const p of [0,.25,.5,.75,1]){h.shared.paint(m,p);assert.equal(parseFloat(m.background.style.top),backgroundRect.top);assert.equal(parseFloat(m.background.style.left),backgroundRect.left);assert.equal(parseFloat(m.background.style.height),backgroundRect.height);assert.equal(parseFloat(m.background.style.width),backgroundRect.width);
      for(const reveal of [m.backgroundReveal,m.fullReveal]){const painted=revealBounds(reveal);for(const key of ['left','top','width','height']){near(painted.mask[key],m.geometry.surface[key]);near(painted.content[key],reveal.bounds[key]);}assert.equal(reveal.node.style.clipPath,'none');}
    }
    h.shared.paint(m,0);assert.deepEqual(plain(m.geometry.surface),miniRect);assert.equal(m.background.style.opacity,'0');
    h.shared.paint(m,1);assert.equal(m.background.style.opacity,'1');assert.equal(parseFloat(m.fullClone.style.top),offset);near(revealBounds(m.backgroundReveal).content.top,backgroundRect.top);near(revealBounds(m.fullReveal).content.top,offset);
    h.scene.end(true);h.frame(1000);assert.equal(h.shared.rect(bg).top,backgroundRect.top);assert.equal(h.shared.rect(bg).height,backgroundRect.height);assert.equal(full.hidden,false);assert.equal(m.layer.isConnected,false);
  }
});


// Work counters describe production DOM/CSS/canvas calls in this deterministic
// fixture. They are not milliseconds, dropped frames, raster cost or A15 QA.
test('steady shared morph frames make no computed-style/layout reads or endpoint-box writes',t=>{
  const h=harness();h.list();h.scene.begin('player',-1);const m=h.scene.state.morph;h.resetCost();
  for(const p of [.25,.5,.75,1,.75,.5,.25,0])h.shared.paint(m,p);
  t.diagnostic('eight frame work counts: '+JSON.stringify({...h.cost,canvasCopies:h.draws()}));
  assert.equal(h.cost.computedReads,0);assert.equal(h.cost.rectReads,0);assert.equal(h.cost.layoutWrites,0);assert.equal(h.cost.clipWrites,0);assert.ok(h.cost.styleWrites<=264,'bounded transform/mask-only frame work');
  assert.equal(h.draws(),0,'a geometry-only frame must not copy unchanged canvas pixels');assert.equal(h.cost.clones,0);assert.equal(h.cost.attributeWrites,0);
  const writes=h.cost.styleWrites;h.shared.paint(m,0);assert.equal(h.cost.styleWrites,writes,'repeated clamped progress does not repaint the same geometry');
});

test('inline playback updates use delta copies without computed style reads or unrelated backdrop work',()=>{
  const h=harness({mutations:true});h.list();h.scene.begin('player',-1);const m=h.scene.state.morph,p=m.p,rects=plain(m.geometry),fill=h.$('#mini-fill');fill.style.transform='translateX(48%)';h.resetCost();
  h.observers.at(-1).callback([{target:fill,type:'attributes',attributeName:'style'}]);
  assert.equal(m.p,p);assert.deepEqual(plain(m.geometry),rects);assert.equal(m.pairs.seek.mini._sceneNodes.get(fill).style.transform,'translateX(48%)');
  assert.equal(h.cost.computedReads,0);assert.equal(h.cost.rectReads,0);assert.equal(h.cost.layoutWrites,0);assert.equal(h.draws(),0);assert.equal(h.cost.styleWrites,1);
  h.resetCost();h.observers.at(-1).callback([{target:fill,type:'attributes',attributeName:'style'}]);assert.equal(h.cost.styleWrites,0,'duplicate progress notifications make no writes');
});

test('a fresh source canvas stamp copies pixels once and later geometry frames reuse them',()=>{
  const h=harness();h.list();h.scene.begin('player',-1);const m=h.scene.state.morph;h.resetCost();h.context.UI.vizPaintVersion=1;
  h.shared.paint(m,.25);assert.equal(h.draws(),1);assert.equal(h.cost.computedReads,0);
  h.shared.paint(m,.5);h.shared.paint(m,.75);assert.equal(h.draws(),1);
  h.context.UI.vizPaintVersion=2;h.shared.paint(m,.75);assert.equal(h.draws(),2,'new pixels can refresh even at unchanged scene progress');
});

test('live backdrop transitions keep sampling only their owner, then release their RAF',()=>{
  const h=harness({mutations:true});h.list();h.scene.begin('player',-1);const m=h.scene.state.morph,bg=h.$('#bg'),animation={playState:'running'};
  bg.getAnimations=()=>[animation];bg.computed.background='#334455';h.observers.at(-1).callback([{target:bg,type:'attributes',attributeName:'style'}]);
  assert.ok(m.appearanceFrame);h.resetCost();bg.computed.background='#446677';h.frame(16);
  assert.equal(m.background.style.background,'#446677');assert.equal(h.cost.computedReads,1);assert.equal(h.cost.layoutWrites,0);assert.equal(h.cost.clones,0);
  animation.playState='finished';bg.computed.background='#778899';h.frame(16);assert.equal(m.background.style.background,'#778899');assert.equal(m.appearanceFrame,0);assert.equal(m.backgroundAnimations.length,0);
  animation.playState='running';h.observers.at(-1).callback([{target:bg,type:'attributes',attributeName:'style'}]);assert.ok(m.appearanceFrame);h.scene.abort();assert.equal(m.appearanceFrame,0);assert.equal(h.frames.size,0);
});

test('shell transforms retain exact circular painted corners through non-uniform expansion',()=>{
  const h=harness();h.list();h.scene.begin('player',-1);const m=h.scene.state.morph;
  for(const p of [0,.25,.5,.75,1]){h.shared.paint(m,p);const [x,y]=m.surface.style.borderRadius.split(' / ').map(part=>part.split(' ').map(parseFloat)),g=m.geometry.surface,base=m.endpoints.surface.mini;
    for(let i=0;i<4;i++){near(x[i]*g.width/base.width,m.miniRadius[i]*(1-p));near(y[i]*g.height/base.height,m.miniRadius[i]*(1-p));}}
});

test('render-cost reduction preserves the existing settle timing instead of hiding work with shorter duration',()=>{
  const h=harness();h.list();h.nav.go('player');const m=h.scene.settling.morph;h.frame(110);near(m.p,.875);assert.ok(h.scene.finish.pending);
  h.frame(110);assert.equal(m.p,1);assert.equal(h.scene.phase,'idle');assert.equal(h.frames.size,0);assert.equal(h.timers.size,0);
});


test('scene construction freezes shared source appearance once while retaining invisible root layout',t=>{
  const h=harness();h.list();h.$('#p-title').computed.width='250px';h.$('#p-title').computed.height='28px';h.resetCost();h.scene.begin('player',-1);const m=h.scene.state.morph;
  t.diagnostic('scene setup work counts: '+JSON.stringify({...h.cost,canvasCopies:h.draws()}));
  assert.equal(h.pseudoReads.get(h.$('#p-title')),2,'one before/after appearance read, reused by the standalone label clone');
  assert.equal(m.fullClone._sceneNodes.get(h.$('#p-title')).style.width,'250px');assert.equal(m.fullClone._sceneNodes.get(h.$('#p-title')).style.height,'28px','suppressed shared roots must retain their original flow contribution');
  assert.equal(m.fullClone._sceneNodes.get(h.$('#art-icon')).style.background,'','invisible duplicate descendants need no computed-style snapshot');
  assert.equal(m.artNodes.full._sceneNodes.get(h.$('#art-icon')).style.background,'#201b16','the actual painted artwork still freezes complete appearance');
});

test('direct waveform, seek, theme and layout canvas paints refresh a held scene after drawing',()=>{
  const h=harness();h.list();h.nav.go('player');h.frame(40);h.scene.pause();const m=h.scene.settling.morph,p=m.p,rects=plain(m.geometry),canvas=h.$('#viz'),copy=m.fullClone._sceneNodes.get(canvas),pixels=[];
  canvas.paint=0;canvas.getContext=()=>({clearRect(){canvas.paint++;}});copy.getContext=()=>({clearRect(){},drawImage(source){pixels.push(source.paint);}});
  h.context.root=h.$('#mini');h.context.UI.fitCanvas=()=>1;h.context.UI.drawWaveSeek=()=>{canvas.paint++;};h.context.UI.vizFull=false;
  vm.runInContext('UI.drawViz=({'+section('  drawViz:function(){','  drawCurve:function(){')+'}).drawViz;',h.context);
  const accept=/  accept\(result\)\{[\s\S]*?\n  \},/.exec(source.slice(source.indexOf('const Waveform={')))[0];
  vm.runInContext('globalThis.waveform=({'+accept+'});',h.context);
  const lastLoopStamp=h.context.UI.lastViz;
  h.context.waveform.accept({duration:10,peaks:[128,255]});assert.deepEqual(pixels,[2],'asynchronous waveform paint is copied after pixels are written');
  for(const reason of ['seek','theme','layout']){h.context.UI.drawViz();assert.equal(pixels.at(-1),canvas.paint,reason+' direct paint keeps the held snapshot fresh');}
  assert.equal(h.context.UI.vizPaintVersion,4);assert.equal(h.context.UI.lastViz,lastLoopStamp,'direct paints do not alter animation-loop scheduling');
  assert.equal(m.p,p);assert.deepEqual(plain(m.geometry),rects);assert.equal(h.frames.size,0,'fresh pixels require no additional idle RAF');
  const copies=pixels.length;h.shared.paint(m,p);assert.equal(pixels.length,copies,'a later unchanged geometry paint does not recopy the same version');
  h.context.$=selector=>selector==='#vizc'?canvas:h.$(selector);h.context.UI.vizFull=true;h.context.UI.vizT=1;h.context.SET.force30=true;h.context.UI.drawViz();
  assert.equal(h.context.UI.vizPaintVersion,4,'force30 skipped draws do not stamp or copy');assert.equal(pixels.length,copies);
});


test('canvas snapshot replacement clears transparent old pixels and follows source bitmap resizing',()=>{
  const h=harness();h.list();h.scene.begin('player',-1);const m=h.scene.state.morph,source=h.$('#viz'),copy=m.fullClone._sceneNodes.get(source),calls=[];
  source.width=600;source.height=80;copy.width=240;copy.height=40;let buffer=['old bar'];
  copy.getContext=()=>({clearRect(...rect){calls.push(['clear',...rect]);buffer=[];},drawImage(canvas,x,y){calls.push(['copy',canvas.width,canvas.height,x,y]);buffer.push(...canvas.pixels);}});
  source.pixels=['new bar'];h.context.UI.vizPaintVersion=1;h.shared.canvasPainted();
  assert.equal(copy.width,600);assert.equal(copy.height,80);assert.deepEqual(buffer,['new bar']);assert.deepEqual(calls,[['clear',0,0,600,80],['copy',600,80,0,0]]);
  source.width=300;source.height=50;source.pixels=[];h.context.UI.vizPaintVersion=2;h.shared.canvasPainted();
  assert.equal(copy.width,300);assert.equal(copy.height,50);assert.deepEqual(buffer,[],'transparent source fully replaces a previous waveform');
  assert.deepEqual(calls.slice(-2),[['clear',0,0,300,50],['copy',300,50,0,0]]);
});


test('backdrop artwork opacity advances during held and settling scenes without style/class mutations',()=>{
  const h=harness({mutations:true}),art=h.context.document.createElement('div'),animation={playState:'running'};art.id='bg-art-next';art.style.opacity='1';art.animatedOpacity=0;art.getAnimations=()=>[animation];h.$('#bg').appendChild(art);
  h.list();h.scene.begin('player',-1);const m=h.scene.state.morph,copy=m.background._sceneNodes.get(art);h.shared.paint(m,.5);
  const p=m.p,rects=plain(m.geometry);h.resetCost();
  for(const opacity of [.25,.5,.75]){art.animatedOpacity=opacity;h.frame(16);assert.equal(copy.style.opacity,String(opacity));assert.equal(art.style.opacity,'1','native transition target remains unchanged');assert.equal(m.p,p);assert.deepEqual(plain(m.geometry),rects);}
  assert.equal(h.cost.computedReads,3,'only the active artwork layer is sampled');assert.equal(h.cost.layoutWrites,0);
  h.scene.end(true);const settlingP=m.p;art.animatedOpacity=.9;h.frame(16);assert.equal(copy.style.opacity,'0.9');assert.ok(m.p>settlingP,'geometry and artwork crossfade continue independently');
  animation.playState='finished';art.animatedOpacity=1;h.frame(16);assert.equal(copy.style.opacity,'1');assert.equal(m.appearanceFrame,0,'the exact final opacity is sampled before retiring the crossfade RAF');
  h.frame(1000);assert.equal(m.layer.isConnected,false);assert.equal(h.frames.size,0);assert.equal(h.timers.size,0);
});


test('frozen will-change:auto cannot disable the transient transform/opacity hints',()=>{
  const h=harness({mutations:true});h.list();h.scene.begin('player',-1);const m=h.scene.state.morph;
  for(const n of [m.background,m.fullClone,...Object.values(m.artNodes),...Object.values(m.pairs).flatMap(pair=>Object.values(pair))])assert.equal(n.style.willChange,'transform,opacity');
  h.$('#btn-play').innerHTML='<svg>pause</svg>';h.observers.at(-1).callback([{target:h.$('#btn-play'),type:'childList'}]);
  assert.equal(m.pairs.play.full.style.willChange,'transform,opacity','a dynamic play/pause clone retains its explicit promotion');
});

test('both masks retain every exact corner and their viewport-space content through an offset scene',()=>{
  const h=harness();h.list();h.$('#bg').rect={left:-7,top:-12,width:407,height:876};h.$('#sc-player').rect={left:5,top:28,width:383,height:824};h.scene.begin('player',-1);const m=h.scene.state.morph;
  for(const p of [0,.001,.25,.5,.75,.999,1,.5,0]){h.shared.paint(m,p);
    for(const reveal of [m.backgroundReveal,m.fullReveal]){const result=revealBounds(reveal),[,,sx,sy]=transform(reveal.mask),[horizontal,vertical]=reveal.mask.style.borderRadius.split(' / ').map(value=>value.split(' ').map(parseFloat));
      for(const key of ['left','top','width','height']){near(result.mask[key],m.geometry.surface[key]);near(result.content[key],reveal.bounds[key]);}
      for(let i=0;i<4;i++){near(horizontal[i]*sx,m.miniRadius[i]*(1-p));near(vertical[i]*sy,m.miniRadius[i]*(1-p));}
      assert.equal(reveal.node.style.clipPath,'none');
    }
  }
  assert.equal(m.backgroundReveal.mask.style.zIndex,'0');assert.equal(m.fullReveal.mask.style.zIndex,'2','the backdrop cannot cover artwork above it');
});

function installDockFixture(h){
  vm.runInContext(section('const DockLayout=','UI.fitPlayer=function()')+'\nglobalThis.dock=DockLayout;',h.context);
  const calls={measure:0,fit:0,viz:0};h.context.dock.measure=()=>calls.measure++;h.context.UI.fitPlayer=()=>calls.fit++;h.context.UI.drawViz=()=>calls.viz++;return calls;
}

test('tap settling without contacts defers repeated endpoint/dock fits and repaints once on cleanup',t=>{
  const h=harness(),calls=installDockFixture(h);h.list();h.nav.go('player');const m=h.scene.settling.morph;
  assert.equal(h.lifecycle.contacts.size,0);assert.equal(calls.fit,1,'synchronous canonical endpoint fit is required');
  h.context.dock.schedule();h.context.dock.schedule();h.frame(16);t.diagnostic('tap first-frame work counts: '+JSON.stringify(calls));assert.equal(m.layoutDeferred,true,'Nav does not enqueue another endpoint fit');assert.deepEqual(calls,{measure:0,fit:1,viz:0});assert.equal(h.context.dock.frame,0);
  h.frame(1000);assert.equal(m.layer.isConnected,false);h.frame(16);assert.deepEqual(calls,{measure:1,fit:2,viz:1});assert.equal(h.frames.size,0,'deferred work is one-shot');
});

test('cleanup after cancellation and retargeting releases deferred work to the current endpoint',()=>{
  for(const target of ['player','settings']){const h=harness(),calls=installDockFixture(h);h.list();h.nav.go('player');const m=h.scene.settling.morph;h.context.dock.schedule();h.frame(16);
    if(target==='player')h.scene.abort();else h.nav.go(target);h.frame(1000);h.frame(16);
    assert.equal(m.layer.isConnected,false);assert.equal(h.nav.cur,target);assert.equal(calls.measure,1);assert.equal(calls.fit,2);assert.equal(calls.viz,target==='player'?1:0);assert.equal(h.frames.size,0);
  }
});

test('playback RAF keeps progress live but makes no periodic canvas draw/copy in a contact-free shared settle',t=>{
  const h=harness(),calls=installDockFixture(h);h.list();h.context.Engine.playing=true;h.context.Engine.time=()=>20;h.context.Engine.duration=()=>100;
  h.context.paintMiniProgress=()=>{};h.context.paintSeekFraction=()=>{};let progress=0;h.context.UI.renderProgress=()=>progress++;
  vm.runInContext('Object.assign(UI,{'+section('  lastProg:0,','  /* ------- waveform')+'});',h.context);
  h.context.UI.loopId=0;h.context.UI.loopToken=0;h.nav.go('player');const m=h.scene.settling.morph;h.context.UI.startLoop();
  for(let i=0;i<5;i++)h.frame(30);
  t.diagnostic('first 150 ms tap settle periodic work: '+JSON.stringify({...calls,progress}));assert.equal(h.lifecycle.contacts.size,0);assert.equal(calls.viz,0);assert.ok(progress>0);assert.equal(m.vizDeferred,true);assert.equal(h.context.UI.loopId>0,true,'audio UI chain remains live');
  h.scene.pause();const p=m.p;h.frame(30);assert.equal(m.p,p);assert.equal(calls.viz,0,'a regrab/held scene retains display ownership');
  h.scene.abort();h.frame(30);assert.ok(calls.viz>=1,'periodic visualization resumes after scene cleanup');assert.equal(h.scene.state,null);assert.equal(h.scene.settling,null);h.context.UI.stopLoop();
});

function appearanceHarness(){
  const h=harness(),idle=new Map();let serial=0;
  h.list();Object.assign(h.context,{innerWidth:393,devicePixelRatio:1,LibraryPageMotion:{state:null,finish:null},requestIdleCallback:fn=>{idle.set(++serial,fn);return serial;},cancelIdleCallback:id=>idle.delete(id)});
  h.context.document.styleSheets=[{cssRules:[{cssText:'body { color: red; }'}],disabled:false}];h.context.document.activeElement=h.body;h.context.document.fonts={status:'loaded'};
  h.context.MutationObserver=class{constructor(callback){this.callback=callback;this.records=[];h.observers.push(this);}observe(){}disconnect(){}takeRecords(){const records=this.records;this.records=[];return records;}};
  h.prepare=()=>{h.shared.scheduleAppearance();assert.equal(h.shared.preparedAppearance,null,'preparation never runs on the requesting/input stack');h.advance(200);for(let i=0;i<100&&idle.size;i++)for(const [id,fn] of [...idle]){idle.delete(id);fn({timeRemaining:()=>50});}assert.ok(h.shared.preparedAppearance,'idle preparation completed');};return h;
}
test('idle exhaustive appearance is consumed once and the cold path stays explicit',()=>{
  const h=appearanceHarness();h.prepare();h.resetCost();h.scene.begin('player',-1);assert.equal(h.shared.appearanceStats.hits,1);assert.equal(h.shared.preparedAppearance,null);assert.equal(h.shared.appearanceStats.cold,0);const preparedReads=h.cost.computedReads;
  h.scene.abort();h.shared.clearAppearance();h.resetCost();h.scene.begin('player',-1);assert.equal(h.shared.appearanceStats.cold,1,'no synchronous warming replaces the unprepared contact');assert.ok(preparedReads<h.cost.computedReads,'prepared invariant CSS reduces reads while progress/time remain live');
});
test('pending mutations and CSSOM edits reject prepared appearance without stale reuse',()=>{
  for(const reason of ['mutation','cssom','inline','resize','track','focus']){const h=appearanceHarness();h.prepare();const job=h.shared.preparedAppearance;
    if(reason==='mutation')job.observer.records.push({target:h.$('#mini-title')});if(reason==='cssom')h.context.document.styleSheets[0].cssRules[0].cssText='body { color: blue; }';if(reason==='inline')h.$('#p-title').style.color='blue';if(reason==='resize')h.context.innerWidth++;if(reason==='track')h.context.Engine.current={id:'changed'};if(reason==='focus')h.context.document.activeElement=h.$('#btn-play');
    h.scene.begin('player',-1);assert.equal(h.shared.appearanceStats.hits,0,reason);assert.equal(h.shared.appearanceStats.cold,1,reason);
  }
});

test('live progress transforms do not invalidate invariant siblings and remain freshly captured',()=>{
  const h=appearanceHarness();h.context.Engine.playing=true;h.prepare();const job=h.shared.preparedAppearance,fill=h.$('#mini-fill'),oldValue=fill.style.cssText;fill.style.transform='translateX(77%)';
  const progress={type:'attributes',attributeName:'style',target:fill,oldValue};assert.equal(h.shared.appearanceChanges([progress]).length,0);job.observer.records.push(progress);h.scene.begin('player',-1);assert.equal(h.shared.appearanceStats.hits,1);assert.equal(h.scene.state.morph.pairs.seek.mini._sceneNodes.get(fill).style.transform,'translateX(77%)','progress CSS is read live on activation');
  h.scene.abort();h.prepare();const before=fill.style.cssText;fill.style.color='blue';assert.equal(h.shared.appearanceChanges([{...progress,oldValue:before}]).length,1,'other styling on a progress node still invalidates');
});

test('a mini contact restamp cannot invalidate prepared invariant child CSS',()=>{
  const h=appearanceHarness(),slide=h.context.document.createElement('div');slide.classList.add('mini-swipe-content');slide.style.transform='';slide.style.transition='none';h.prepare();const oldValue=slide.style.cssText;slide.style.transition='none';
  const same={type:'attributes',attributeName:'style',target:slide,oldValue};assert.equal(h.shared.appearanceChanges([same]).length,0,'motion-owned restamp does not change cached child appearance');h.shared.preparedAppearance.observer.records.push(same);h.scene.begin('player',-1);assert.equal(h.shared.appearanceStats.hits,1);
  const before=slide.style.cssText;slide.style.color='blue';assert.equal(h.shared.appearanceChanges([{...same,oldValue:before}]).length,1,'inherited style changes still invalidate');
});

test('the actual mini gesture start retains and consumes prepared appearance',()=>{
  const h=appearanceHarness(),mini=h.$('#mini');Object.defineProperty(mini,'firstChild',{get:()=>mini.children[0]||null});
  h.context.el=(tag,classes)=>{const node=h.context.document.createElement(tag);node.className=classes;return node;};
  vm.runInContext(section('function setupMiniGestures(){','function setupPlayerSwipeDown(){')+'\nsetupMiniGestures();',h.context);
  h.prepare();const job=h.shared.preparedAppearance,slide=mini.children[0],style=slide.style;assert.equal(slide.className,'mini-swipe-content');assert.equal(slide.id,'','actual wrapper is class-based');
  slide.style=new Proxy(style,{set(target,key,value){const oldValue=target.cssText;target[key]=value;job.observer.records.push({type:'attributes',attributeName:'style',target:slide,oldValue});return true;}});
  mini.fire('pointerdown',{pointerType:'touch',target:h.$('#mini-title')});mini.fire('pointerup',{pointerType:'touch',target:h.$('#mini-title')});
  assert.equal(h.shared.appearanceStats.hits,1,'real start/end consume the same one-use entry');assert.equal(h.shared.appearanceStats.cold,0);assert.equal(h.nav.cur,'player');
});

test('mini and outside-toolbar focus remain live while prepared player focus stays guarded',()=>{
  const h=appearanceHarness();h.prepare();assert.equal(h.shared.preparedAppearance.cache.has(h.$('#mini-title')),false,'mini appearance is never warmed');h.context.document.activeElement=h.$('#mini');h.scene.begin('player',-1);assert.equal(h.shared.appearanceStats.hits,1,'unrelated/mini focus cannot change prepared full-player CSS');
});

test('live progress retains unrounded writer transforms and precise mini-fill width',()=>{
  const h=harness();h.list();const source=h.$('#mini-fill');source.rect.width=343.203125;source.style.transform='translateX(1.59246%)';source._sceneRawTransform='translateX(1.592457341%)';source._sceneSerializedTransform=source.style.transform;
  h.scene.begin('player',-1);const m=h.scene.state.morph,copy=m.pairs.seek.mini._sceneNodes.get(source);assert.equal(copy.style.width,'343.203125px');assert.equal(copy.style.transform,source._sceneRawTransform);
  source.style.transform='translateX(40%)';h.shared.refreshDynamic(m);assert.equal(copy.style.transform,'translateX(40%)','a direct inline override cannot reuse a stale writer stamp');
});
