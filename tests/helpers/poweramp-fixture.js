import {readFile, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const defaultRoot=fileURLToPath(new URL('../../public/',import.meta.url));
const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2'};
export const sourceFlags={local:false,drive:false,r2:false,server:false};
export const mobileContext={viewport:{width:393,height:852},isMobile:true,hasTouch:true};

// All names, covers, and audio in this fixture are generated test material.
export function fixtureWav(index=0){
  const rate=8000,seconds=180,samples=rate*seconds,b=Buffer.alloc(44+samples*2);
  b.write('RIFF');b.writeUInt32LE(36+samples*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++){const envelope=Math.min(1,(i%rate)/400,(rate-i%rate)/400);b.writeInt16LE(Math.round(Math.sin(i/rate*2*Math.PI*(220+index%8*27.5))*650*envelope),44+i*2);}
  return b;
}
export function fixtureCover(index=0){
  const colors=['#cb6434','#298b9d','#7850ab','#638646','#b13d68','#4b71ab'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="${colors[index%colors.length]}"/><circle cx="${100+index%3*70}" cy="175" r="120" fill="#fff" opacity=".15"/><path d="M0 270 L150 170 L400 300 V400 H0" fill="#111" opacity=".25"/><text x="30" y="325" fill="#fff" font-size="28" font-family="sans-serif">NIGHT SIGNAL ${index+1}</text><text x="30" y="365" fill="#fff" font-size="15" font-family="sans-serif">ISOLATED PLAYABLE FIXTURE</text></svg>`;
}

// This function is serializable through Playwright evaluate and the preview server.
export async function installPowerampFixture({origin,count=24,art=true,preview=false}){
  const {LIB,SET,SourceLibrary,Engine,R2Source,UI,Views,NativeSettings,Playlists,PlaybackQueue}=window.PA;
  R2Source.suspend();SourceLibrary.flags={local:false,drive:false,r2:true,server:false};
  const artists=['Mira Vale','The Lantern District','Juniper Static','Noah Ember','Glass Harbour','Selene North'];
  const albums=['Night Signals','Paper Satellites','Soft Geometry','After the Rain','Blue Hour Maps','Quiet Radiance'];
  const titles=['Open Windows','Signal Bloom','Streetlight Waltz','Silver Current','Midnight Orchard','Letters in Motion','Northern Air','Warm Glass'];
  const tracks=Array.from({length:count},(_,i)=>({id:'r2_fixture_'+i,source:'r2',remote:true,remoteId:'fixture_'+i,
    title:count>100?String.fromCharCode(65+Math.floor(i*26/count))+' '+titles[i%titles.length]+' '+String(i).padStart(5,'0'):titles[i%titles.length]+(i>=8?' '+(Math.floor(i/8)+1):''),
    artist:artists[Math.floor(i/4)%artists.length],album:albums[Math.floor(i/4)%albums.length],albumArtist:artists[Math.floor(i/4)%artists.length],genre:i%2?'Indie electronic':'Ambient pop',year:2024+i%3,
    path:'Fixture/'+albums[Math.floor(i/4)%albums.length]+'/'+i+'.wav',ext:'wav',dur:180,size:2880044,track:i%4+1,rating:0,added:i,plays:0,
    ...(art?{coverURL:origin+'/__fixture__/cover/'+i%6+'.svg'}:{})}));
  LIB.ids=tracks.map(t=>t.id);LIB.map=new Map(tracks.map(t=>[t.id,t]));
  R2Source.fileFor=t=>({__remoteURL:origin+'/__fixture__/audio/'+(Number(t.remoteId.split('_').at(-1))%8)+'.wav',name:'fixture.wav',size:2880044,type:'audio/wav'});
  Engine.els.forEach(a=>{a.pause();a.removeAttribute('src');a.load();});
  Engine.queue=tracks;Engine.order=tracks.map((_,i)=>i);Engine.pos=0;Engine.current=tracks[0];Engine.dur=180;Engine.playing=false;
  Engine._playRequest=(Engine._playRequest||0)+1;Engine._loadingRequest=null;Engine._pendingSeek=null;Engine._resumePosition=null;
  SET.animations='normal';SET.listZoom={files:3};SET.keepQueue=true;SET.seekStyle='wave';SET.previousRestarts=true;SET.swipeToChange=true;SET.playerButtons=['viz','queue','lyrics','repeat','shuffle'];
  PlaybackQueue.pending=preview?tracks.slice(8,11).map(t=>t.id):[];PlaybackQueue.active=false;PlaybackQueue.resume=null;PlaybackQueue.forced=false;
  Playlists.data=[{id:'fixture-evening',name:'Evening Walk',ids:tracks.slice(0,8).map(t=>t.id)},{id:'fixture-focus',name:'Late-Night Focus',ids:tracks.slice(8,16).map(t=>t.id)}];
  NativeSettings.apply();await UI.renderNowPlaying(Engine.current);UI.renderPlayState();Views.renderLibrary();UI.renderProgress();
  window.powerampFixture={count,tracks,ready:true};
}

export async function servePowerampFixture({root=process.env.POWERAMP_PUBLIC_ROOT||defaultRoot}={}){
  root=resolve(root);const audio=new Map(),requests={audio:0,covers:0,paths:[]};
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost'),pathname=url.pathname;requests.paths.push(pathname);
      if(pathname==='/assets/r2-config.json'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({manifestURL:'fixture-disabled',rootId:''}));}
      const wav=/^\/__fixture__\/audio\/(\d+)\.wav$/.exec(pathname);
      if(wav){
        requests.audio++;const index=Number(wav[1]);if(!audio.has(index))audio.set(index,fixtureWav(index));const bytes=audio.get(index);
        const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||''),start=range?+range[1]:0,end=range&&range[2]?Math.min(+range[2],bytes.length-1):bytes.length-1;
        res.writeHead(range?206:200,{'Content-Type':'audio/wav','Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}:{})});return res.end(bytes.subarray(start,end+1));
      }
      const cover=/^\/__fixture__\/cover\/(\d+)\.svg$/.exec(pathname);
      if(cover){requests.covers++;res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store'});return res.end(fixtureCover(Number(cover[1])));}
      let path=resolve(root,'.'+decodeURIComponent(pathname));
      if(!path.startsWith(root+sep))throw Error('Invalid path');if((await stat(path)).isDirectory())path=join(path,'index.html');
      let body=await readFile(path);
      res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(body);
    }catch{res.writeHead(404);res.end('Not found');}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const origin=`http://127.0.0.1:${server.address().port}`;
  return {server,origin,requests,close:()=>new Promise(done=>server.close(done))};
}

export async function openFixturePage(browser,fixture,options={}){
  const context=await browser.newContext(mobileContext);
  await context.route('**/*',route=>new URL(route.request().url()).origin===fixture.origin?route.continue():route.abort('blockedbyclient'));
  await context.addInitScript(flags=>localStorage.setItem('drawercast.sources.v1',JSON.stringify(flags)),sourceFlags);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(fixture.origin+'/drawercast/');await page.waitForFunction(()=>window.PA?.R2Source.manifestURL==='fixture-disabled');
  await page.evaluate(installPowerampFixture,{origin:fixture.origin,...options});
  const cdp=await context.newCDPSession(page),point=(x,y,id=1)=>({id,x,y,radiusX:1,radiusY:1,force:1});
  const send=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points});
  const frame=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>r())));
  const start=(x,y)=>send('touchStart',[point(x,y)]),move=(x,y)=>send('touchMove',[point(x,y)]),end=()=>send('touchEnd',[]);
  const tap=async(x,y)=>{await start(x,y);await end();};
  const center=async selector=>{const box=await page.locator(selector).boundingBox();if(!box)throw Error('Missing visible fixture target '+selector);return {x:box.x+box.width/2,y:box.y+box.height/2,box};};
  const swipe=async(selector,dx,dy)=>{const p=await center(selector);await start(p.x,p.y);for(let i=1;i<=5;i++){await move(p.x+dx*i/5,p.y+dy*i/5);await frame();}await end();return p;};
  const library=async()=>{await page.locator('[data-nav="library"]').tap();await page.getByRole('button',{name:'All Songs',exact:true}).tap();await page.waitForFunction(()=>PA.Nav.cur==='list'&&!document.querySelector('#sc-list').inert);await frame();};
  return {context,page,cdp,errors,point,send,start,move,end,tap,frame,center,swipe,library,close:()=>context.close()};
}
