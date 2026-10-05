import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(process.env.POWERAMP_PLAYER_FILE||new URL('../public/drawercast/player.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('const SharedPlayerMotion='),source.indexOf('const ScreenDrag='));
const shorthand={margin:['margin-top','margin-right','margin-bottom','margin-left'],mask:['mask-image','mask-size','mask-position'],font:['font-family','font-size','font-weight','line-height']};
function declaration(entries={}){
  const values=new Map(Object.entries(entries));
  return new Proxy({getPropertyValue:key=>values.get(key)||'',getPropertyPriority:()=>'',setProperty(key,value){for(const property of shorthand[key]||[key])values.set(property,value);}},{
    get(target,key){if(key==='length')return values.size;if(key==='cssText')return [...values].map(([k,v])=>k+':'+v).join(';');if(/^\d+$/.test(String(key)))return [...values.keys()][+key];return target[key];},
    set(target,key,value){if(key==='cssText'){values.clear();for(const pair of value.split(';')){const at=pair.indexOf(':');if(at>0)values.set(pair.slice(0,at),pair.slice(at+1));}}else target[key]=value;return true;}
  });
}
function harness(){
  const sheet={cssRules:[{selectorText:'.parent',style:declaration({font:'inherit',color:'red'})},{selectorText:'#source',style:declaration({margin:'0',mask:'var(--icon)'})},{selectorText:'#source::after',style:declaration({content:'""','box-shadow':'0 0 1px black'})},{selectorText:'.unrelated',style:declaration({'backdrop-filter':'blur(1px)'})}]};
  const document={styleSheets:[sheet],createElement:()=>({style:declaration()})};
  const context=vm.createContext({document});vm.runInContext(code+'\nglobalThis.motion=SharedPlayerMotion;',context);
  const values={'font-family':'Test Font','font-size':'19px','font-weight':'750','line-height':'23px',color:'rgb(1, 2, 3)','margin-top':'1px','margin-right':'2px','margin-bottom':'3px','margin-left':'4px','mask-image':'url(data:image/png;base64,ICON)','mask-size':'contain','mask-position':'50% 50%',content:'none','letter-spacing':'0px','filter':'none','outline-color':'rgb(1, 2, 3)','box-shadow':'0 0 1px rgb(0, 0, 0)','pointer-events':'auto','animation-duration':'1s','transition-property':'all','--icon':'url(data:image/png;base64,ICON)'};
  for(let i=0;i<400;i++)values['unused-browser-'+i]='initial';
  const style=declaration(values),parent={style:declaration(),parentElement:null,matches:s=>s==='.parent'},node={style:declaration({'letter-spacing':'2px','--icon':values['--icon']}),parentElement:parent,matches:s=>s==='#source'};
  return {motion:context.motion,document,sheet,node,style};
}

test('compact snapshot derives used properties and shorthand longhands without a paint whitelist',()=>{
  const h=harness(),plan=h.motion.snapshotPlan(h.style),keys=h.motion.snapshotKeys(h.node,plan),css=h.motion.snapshotCSS(h.style,keys);
  for(const key of ['font-family','font-size','font-weight','line-height','color','margin-top','margin-right','margin-bottom','margin-left','mask-image','mask-size','mask-position','box-shadow','content','letter-spacing'])assert.ok(keys.includes(key),key);
  assert.equal(keys.includes('backdrop-filter'),false,'unmatched rules do not enlarge every snapshot');
  assert.equal(keys.some(key=>key.startsWith('unused-browser-')),false);
  assert.equal(keys.includes('--icon'),false,'resolved mask keeps the URL without a second custom-variable copy');
  assert.equal((css.match(/data:image\/png/g)||[]).length,1);
  assert.ok(css.length<h.motion.snapshotCSS(h.style,null).length/5,'large browser-default lists are not serialized');
});

test('new scenes rebuild their plan after inline and CSSOM changes',()=>{
  const h=harness(),first=h.motion.snapshotPlan(h.style);assert.equal(h.motion.snapshotKeys(h.node,first).includes('outline-color'),false);
  h.sheet.cssRules.push({selectorText:'#source',style:declaration({'outline-color':'cyan'})});h.node.style.setProperty('filter','blur(1px)');
  const next=h.motion.snapshotPlan(h.style),keys=h.motion.snapshotKeys(h.node,next);assert.ok(keys.includes('outline-color'));assert.ok(keys.includes('filter'));assert.notEqual(next,first);
});

test('unreadable or absent stylesheets retain the exhaustive snapshot path',()=>{
  const h=harness();h.document.styleSheets=[{get cssRules(){throw Error('SecurityError');}}];assert.equal(h.motion.snapshotPlan(h.style),null);
  assert.equal(h.motion.snapshotKeys(h.node,null),null);assert.ok(h.motion.snapshotCSS(h.style,null).includes('unused-browser-399:initial;'));
  h.document.styleSheets=[];assert.equal(h.motion.snapshotPlan(h.style),null);
});

test('uncertain selector matching keeps the exhaustive snapshot path',()=>{
  const h=harness(),plan=h.motion.snapshotPlan(h.style);h.node.matches=()=>{throw Error('Invalid selector');};assert.equal(h.motion.snapshotKeys(h.node,plan),null);
});


test('live class pseudos and important rules retain only referenced local variables',()=>{
  const h=harness(),important=declaration({'mask-image':'var(--local-mask)','color':'var(--local-color)','width':'var(--missing, 4px)'});
  important.getPropertyPriority=()=> 'important';
  h.sheet.cssRules.push({selectorText:'#source::before',style:declaration({content:'""',background:'var(--local-pseudo)'})},{selectorText:'#source',style:important});
  h.node.style.setProperty('--local-mask','url(local-mask)');h.node.style.setProperty('--local-color','cyan');h.node.style.setProperty('--local-pseudo','gold');h.node.style.setProperty('--unused-schema','unused');
  for(const [key,value] of [['--local-mask','url(local-mask)'],['--local-color','cyan'],['--local-pseudo','gold']])h.style.setProperty(key,value);
  const keys=h.motion.snapshotKeys(h.node,h.motion.snapshotPlan(h.style)),css=h.motion.snapshotCSS(h.style,keys);
  for(const key of ['--local-mask','--local-color','--local-pseudo'])assert.ok(keys.includes(key),key);
  assert.equal(keys.includes('--unused-schema'),false);assert.equal(keys.includes('--icon'),false);
  assert.ok(css.includes('--local-mask:url(local-mask);'));assert.equal(css.includes('--missing:'),false,'an absent variable keeps the CSS fallback');
});
