import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,stat,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join,extname} from 'node:path';
import {chromium} from 'playwright-core';
const chrome=process.env.JARVIS_CHROME;
const publicRoot=resolve('public'),policy=JSON.parse(await readFile(join(publicRoot,'staticwebapp.config.json'),'utf8'));
const show={id:'fixture-show',title:'The Sound of History',author:'A thoughtful host',feedUrl:'https://feeds.example.org/history.xml',description:'Stories from the past, told with care.',artwork:'',website:'https://example.org'};
const episodes=Array.from({length:5},(_,i)=>({id:'episode-'+i,title:['A remarkable beginning','The music of a city','An overlooked story','Across the mountains','A new chapter'][i],description:'Episode notes with <script>untrusted text</script> and useful details.',duration:60,publishedAt:new Date(Date.UTC(2026,9,3-i)).toISOString(),audioUrl:'https://audio.example.org/'+i+'.wav',type:'audio/wav',bytes:960044}));
function wav() {const rate=8000,samples=rate*60,b=Buffer.alloc(44+samples*2);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);return b;}
test('podcast mobile flows, real offline audio, seeking, timers and queue',{skip:!chrome||!existsSync(chrome),timeout:120000},async t=>{
 const audioBytes=wav();
 const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://local');
  const json=data=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  if(url.pathname==='/assets/config.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end('export const API_ORIGIN=location.origin;');return;}
  if(['/podcasts/search','/podcasts/browse'].includes(url.pathname)){if(url.searchParams.get('q')==='fallback'){res.writeHead(502,{'Content-Type':'application/json'});res.end('{"error":"Directory blocked in this region"}');return;}json({shows:url.searchParams.get('q')==='empty'?[]:[show,{...show,id:'two',title:'Science in motion',feedUrl:'https://feeds.example.org/science.xml'}]});return;}
  if(url.pathname==='/podcasts/feed'){
   const archive=url.searchParams.get('url')?.includes('archive'),offset=Number(url.searchParams.get('offset') || 0);
   const items=archive?Array.from({length:95},(_,i)=>({...episodes[0],id:'archive-'+i,title:'Archive episode '+i})):episodes;
   json({show:{...show,feedUrl:url.searchParams.get('url')},episodes:items.slice(offset,offset+40),nextOffset:items.length>offset+40?offset+40:null});return;
  }
  if(url.pathname==='/podcasts/audio'){
   const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range || ''),start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),audioBytes.length-1):audioBytes.length-1;
   res.writeHead(range?206:200,{'Content-Type':'audio/wav','Content-Length':end-start+1,'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${audioBytes.length}`}:{})});res.end(audioBytes.subarray(start,end+1));return;
  }
  let p=resolve(publicRoot,'.'+url.pathname);if(!p.startsWith(publicRoot+'/'))throw Error();if((await stat(p)).isDirectory())p=join(p,'index.html');
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
  let content=await readFile(p);if(extname(p)==='.html'){const path='/'+p.slice(publicRoot.length+1),csp=(policy.routes.find(r=>path.startsWith(r.route.replace('*','')))?.headers?.['Content-Security-Policy'] || policy.globalHeaders['Content-Security-Policy']).replace(/frame-ancestors[^;]*(;|$)/g,'');content=content.toString().replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);}
  res.writeHead(200,{'Content-Type':mime[extname(p)] || 'application/octet-stream'});res.end(content);
 }catch{res.writeHead(404);res.end();}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage(),errors=[];
 await page.clock.install();
 await context.route('https://itunes.apple.com/search?**',async route=>{const u=new URL(route.request().url()),term=u.searchParams.get('term');const shows=term==='empty'?[]:[show,{...show,id:'two',title:'Science in motion',feedUrl:'https://feeds.example.org/science.xml'}];await route.fulfill({contentType:'text/javascript',body:u.searchParams.get('callback')+'('+JSON.stringify({results:shows.map(s=>({collectionId:s.id,collectionName:s.title,artistName:s.author,feedUrl:s.feedUrl}))})+');'});});
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&m.text().includes('Content Security Policy'))errors.push(m.text());});
 const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('jarvis.podcasts.v1')));
 const shot=async name=>{if(process.env.JARVIS_SCREENSHOT_DIR){await mkdir(process.env.JARVIS_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.JARVIS_SCREENSHOT_DIR,'podcasts-'+name+'.png')});}};
 try {
  await t.test('browse, search, follow and episode filtering',async()=>{
   await page.goto(origin+'/podcasts/');await page.locator('.show-tile').first().waitFor();await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
   await shot('discover');await page.locator('#query').fill('history');await page.locator('#search-form button').click();await page.waitForURL('**/#search=history');await page.locator('.show-tile').first().click();await page.locator('#follow-show').click();assert.equal((await stored()).follows.length,1);
   await page.locator('#episode-query').fill('music');assert.equal(await page.locator('.episode-row').count(),1);await page.locator('#episode-query').fill('');assert.equal(await page.locator('.episode-row').count(),5);await shot('show');
   assert.equal(await page.locator('#results script').count(),0);
  });
  await t.test('download, real playback, speed and mini-player seeking',async()=>{
   await page.locator('[data-options]').first().click();await page.getByRole('button',{name:'Download for offline listening',exact:true}).click();await page.waitForFunction(()=>Object.keys(JSON.parse(localStorage.getItem('jarvis.podcasts.v1')).downloads).length===1);
   await page.locator('[data-play]').first().click();await page.waitForFunction(()=>!document.querySelector('#audio').paused&&document.querySelector('#audio').duration===60);
   await page.locator('#mini-seek').evaluate(input=>{input.value=25;input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('change'));});await page.waitForFunction(()=>document.querySelector('#audio').currentTime>=25);
   await page.locator('#open-player').click();await page.locator('#speed').click();await page.getByRole('button',{name:'1.5×',exact:true}).click();assert.equal(await page.locator('#audio').evaluate(a=>a.playbackRate),1.5);await shot('player');
   await page.locator('#play').click();assert.equal(await page.locator('#audio').evaluate(a=>a.paused),true);assert.ok(Object.values((await stored()).progress)[0].position>=25);await page.locator('#close-player').click();
  });
  await t.test('offline reload, resume and byte-range seeking use the actual downloaded file',async()=>{
   await page.locator('[data-view=downloads]').click();await context.setOffline(true);await page.reload();await page.locator('.episode-row').first().waitFor();await page.locator('[data-play]').first().click();await page.waitForFunction(()=>!document.querySelector('#audio').paused);
   assert.ok(await page.locator('#audio').evaluate(a=>a.currentTime>=25));
   await page.locator('#mini-seek').evaluate(input=>{input.value=40;input.dispatchEvent(new Event('change'));});await page.waitForFunction(()=>document.querySelector('#audio').currentTime>=40);
   const range=await page.evaluate(async()=>{const a=document.querySelector('#audio'),r=await fetch(a.src,{headers:{Range:'bytes=10-19'}});return {status:r.status,range:r.headers.get('Content-Range'),length:(await r.arrayBuffer()).byteLength};});assert.deepEqual(range,{status:206,range:'bytes 10-19/960044',length:10});
   await page.locator('#mini-play').click();await context.setOffline(false);
  });
  await t.test('end-of-episode timer stops queue autoplay; disabling it advances the queue',async()=>{
   await page.locator('[data-view=library]').click();await page.locator('.show-tile').first().click();await page.locator('[data-options]').nth(1).click();await page.getByRole('button',{name:'Add to queue',exact:true}).click();
   await page.locator('#open-player').click();await page.locator('#sleep').click();await page.getByRole('button',{name:'End of this episode',exact:true}).click();await page.locator('#play').click();
   await page.locator('#audio').evaluate(a=>a.currentTime=a.duration-.05);await page.waitForFunction(()=>document.querySelector('#audio').ended);
   assert.equal((await stored()).queue.length,1);assert.equal(await page.locator('#sleep-label').textContent(),'Sleep timer');assert.equal(Object.values((await stored()).progress).find(p=>p.episode.id==='episode-0').played,true);
   await page.locator('#play').click();await page.waitForFunction(()=>!document.querySelector('#audio').paused);await page.locator('#audio').evaluate(a=>a.currentTime=a.duration-.05);
   await page.waitForFunction(()=>document.querySelector('#mini-title').textContent==='The music of a city'&&!document.querySelector('#audio').paused);assert.equal((await stored()).queue.length,0);assert.equal(Object.values((await stored()).progress).find(p=>p.episode.id==='episode-0').played,true);
   await page.locator('#play').click();await page.locator('#close-player').click();
  });
  await t.test('timed sleep uses elapsed wall time and pauses playback',async()=>{
   await page.locator('#open-player').click();await page.locator('#sleep').click();await page.getByRole('button',{name:'15 minutes',exact:true}).click();await page.locator('#play').click();await page.waitForFunction(()=>!document.querySelector('#audio').paused);
   await page.clock.fastForward(15*60000+10);assert.equal(await page.locator('#audio').evaluate(a=>a.paused),true);assert.equal(await page.locator('#sleep-label').textContent(),'Sleep timer');await page.locator('#close-player').click();
  });
  await t.test('empty search and mobile/desktop layouts remain usable',async()=>{
   await page.locator('[data-view=discover]').click();await page.locator('#query').fill('empty');await page.locator('#search-form button').click();await page.getByRole('heading',{name:'No shows found'}).waitFor();
   for(const width of [360,390,1200]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
   assert.deepEqual(errors,[]);
  });
  await t.test('large shows load more pages without rebuilding or losing episode filters',async()=>{
   await page.setViewportSize({width:390,height:844});await page.goto(origin+'/podcasts/#show='+encodeURIComponent('https://feeds.example.org/archive.xml'));
   await page.locator('.episode-row').first().waitFor();assert.equal(await page.locator('.episode-row').count(),40);
   await page.locator('#more-episodes').click();await page.waitForFunction(()=>document.querySelectorAll('.episode-row').length===80);
   await page.locator('#episode-query').fill('episode 79');assert.equal(await page.locator('.episode-row').count(),1);
   await page.locator('#more-episodes').click();await page.waitForFunction(()=>document.querySelector('#episode-count').textContent==='95');assert.equal(await page.locator('#episode-query').inputValue(),'episode 79');assert.equal(await page.locator('.episode-row').count(),1);
   assert.deepEqual(errors,[]);
  });
  await t.test('discovery still works when a server region rejects directory requests',async()=>{
   await page.goto(origin+'/podcasts/#search=fallback');await page.locator('.show-tile').first().waitFor();assert.equal(await page.locator('.show-tile').count(),2);assert.equal(await page.locator('#status').isVisible(),false);assert.deepEqual(errors,[]);
  });
 } finally {await browser.close();await new Promise(done=>server.close(done));}
});
