import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import vm from 'node:vm';
import {folderId,createDriveApi,driveTrack} from '../public/drawercast/drive-api.js';
const root='folder123456789',file='song12345678901',child='child1234567890',key='AIza'+'x'.repeat(35);
const folder={id:root,name:'Music',mimeType:'application/vnd.google-apps.folder'};
const song={id:file,name:'01 - Example [abcdefghijk].webm',mimeType:'video/webm',size:'4000',modifiedTime:'2026-09-20T00:00:00Z',md5Checksum:'one'};
test('accepts only a folder ID or Google Drive folder URL',()=>{
  assert.equal(folderId('https://drive.google.com/drive/folders/'+root+'?usp=sharing'),root);
  assert.throws(()=>folderId('https://evil.test/drive/folders/'+root));
  assert.throws(()=>folderId("x' in parents"));
  assert.throws(()=>folderId('https://drive.google.com/file/d/'+file));
});
test('lists every page and subfolder, deduplicates songs, skips non-audio and follows no foreign URL',async()=>{
  const calls=[];const responses=[folder,{files:[song,{id:child,name:'Sub',mimeType:'application/vnd.google-apps.folder'}],nextPageToken:'next'},
    {files:[song,{id:'image123456789',name:'cover.jpg',mimeType:'image/jpeg'}]},
    {files:[{...song,id:'second123456789',name:'Two.m4a'}]}];
  const api=createDriveApi(key,async(url,options)=>{calls.push({url:new URL(url),options});return Response.json(responses.shift());});
  const result=await api.list(root);
  assert.equal(result.files.length,2);assert.equal(result.files[1].folder,'Music/Sub');
  assert.equal(calls[2].url.searchParams.get('pageToken'),'next');
  assert.ok(calls.every(c=>c.url.origin==='https://www.googleapis.com'&&c.options.credentials==='omit'));
});
test('a failure on a later page rejects the entire snapshot',async()=>{
  const responses=[Response.json(folder),Response.json({files:[song],nextPageToken:'next'}),Response.json({error:{}},{status:403})];
  const api=createDriveApi(key,async()=>responses.shift());
  await assert.rejects(api.list(root),/refused access/);
});
test('repeated pagination tokens stop rather than looping',async()=>{
  let call=0;const api=createDriveApi(key,async()=>Response.json(call++===0?folder:{files:[song],nextPageToken:'repeat'}));
  await assert.rejects(api.list(root),/pagination repeated/);
  assert.equal(call,3);
});
test('media descriptor streams from the API with no token embedded in stored track metadata',()=>{
  const api=createDriveApi(key);
  const url=new URL(api.mediaURL(song));
  assert.equal(url.searchParams.get('alt'),'media');assert.equal(url.searchParams.get('key'),key);
  const track=driveTrack(song,root,null,{rating:5,plays:9});
  assert.equal(track.title,'Example');assert.equal(track.source,'drive');assert.equal(track.rating,5);
  assert.equal(JSON.stringify(track).includes(key),false);assert.equal(track.waveformVersion,0);
  assert.throws(()=>api.mediaURL({id:'../private'}));
});
test('prepared metadata and waveform are accepted only for the matching file revision',()=>{
  const prepared={size:4000,md5:'one',dur:200,codec:'opus',waveform:true};
  const valid=driveTrack(song,root,prepared);
  assert.equal(valid.dur,200);assert.equal(valid.waveformVersion,1);
  const changed=driveTrack({...song,md5Checksum:'two'},root,prepared,valid);
  assert.equal(changed.waveformVersion,0);assert.equal(changed.dur,0);
});
const source=await readFile(new URL('../public/drawercast/player.js',import.meta.url),'utf8');
function integration({fail=false}={}){
  const tracks=new Map([['a15',{id:'a15',remote:true}],['local',{id:'local'}],['gd_old12345678',{id:'gd_old12345678',source:'drive'}]]);
  const removed=[];const component=source.slice(source.indexOf('const DriveSource={'),source.indexOf('\nconst Engine = {'));
  const context=vm.createContext({AbortController,setTimeout,clearTimeout,LIB:{map:tracks},
    allTracks:()=>[...tracks.values()],IDB:{async bulk(){}},libAdd:t=>tracks.set(t.id,t),
    async removeTracks(ids){removed.push(...ids);ids.forEach(id=>tracks.delete(id));},
    Engine:{queue:[],current:null,buildOrder(){this.order=this.queue.map((_,i)=>i);},saveState(){},stop(){}},
    Views:{refreshAll(){}},UI:{renderNowPlaying(){},renderPlayState(){}},localStorage:{setItem(){},removeItem(){}},
    toast(){},$:()=>null,Waveform:{load(){}}});
  const drive=vm.runInContext(component+'\nDriveSource;',context);
  drive.api={async list(){if(fail)throw Error('Network failure');return {id:root,name:'Music',files:[song]};}};
  drive.helper={driveTrack};return {drive,tracks,removed,engine:context.Engine};
}
test('Drive refresh removes only missing Drive tracks and preserves A15/local sources',async()=>{
  const {drive,tracks,removed}=integration();assert.equal(await drive.connect(root),true);
  assert.deepEqual(removed,['gd_old12345678']);assert.ok(tracks.has('a15'));assert.ok(tracks.has('local'));assert.ok(tracks.has('gd_'+file));
});
test('Drive read failure preserves the previous library',async()=>{
  const {drive,tracks,removed}=integration({fail:true});assert.equal(await drive.connect(root),false);
  assert.equal(tracks.size,3);assert.deepEqual(removed,[]);
});
test('every prepared waveform has the matching compact binary header and a bounded duration',async()=>{
  const directory=new URL('../public/drawercast/drive-waveforms/',import.meta.url);
  const catalog=JSON.parse(await readFile(new URL('../public/drawercast/drive-prepared.json',import.meta.url),'utf8'));
  const files=await readdir(directory);assert.ok(files.length>0);
  for(const name of files){
    const bytes=await readFile(new URL(name,directory));const ms=bytes.readUInt32BE(4),bins=bytes.readUInt32BE(8);
    assert.equal(bytes.readUInt32BE(0),0x44435731);assert.equal(bytes.length,16+bins);assert.equal(bins,Math.ceil(ms*16/1000));
    assert.equal(bytes.readUInt16BE(12),16);assert.ok(ms>0&&ms<=1800000);
    assert.ok(catalog.files[name.replace('.dcw','')].waveform);
  }
});

test('numbered Muse filenames provide immediate artist/title while embedded tags load',()=>{
  const t=driveTrack({...song,name:'10 - Alice In Chains - Nutshell (Unplugged).opus'},root);
  assert.equal(t.title,'Nutshell (Unplugged)');assert.equal(t.artist,'Alice In Chains');
});
test('cached embedded tags and art survive refresh only for identical bytes',()=>{
  const old={size:4000,md5:'one',driveTagVersion:1,title:'Tagged title',artist:'Tagged artist',album:'Album',track:10,year:2000,artKey:'cover',dur:200,rating:5};
  const same=driveTrack(song,root,null,old);assert.equal(same.album,'Album');assert.equal(same.artKey,'cover');assert.equal(same.driveTagVersion,1);assert.equal(same.track,10);
  const changed=driveTrack({...song,md5Checksum:'new'},root,null,old);assert.equal(changed.artKey,null);assert.equal(changed.driveTagVersion,0);assert.equal(changed.album,'');assert.equal(changed.rating,5);
});
function rangeMock(bytes,calls){return async(url,options)=>{
  const [,start,end]=options.headers.Range.match(/bytes=(\d+)-(\d+)/).map(Number);calls.push({start,end});
  return new Response(bytes.subarray(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${bytes.length}`}});
};}
test('metadata ranges reuse fetched bytes without reading the full song',async()=>{
  const bytes=new Uint8Array(500000),calls=[];bytes[40000]=123;
  const f=createDriveApi(key,rangeMock(bytes,calls)).metadataFile({remoteId:file,size:bytes.length});
  await f.slice(0,32000).arrayBuffer();const part=new Uint8Array(await f.slice(32000,65536).arrayBuffer());
  assert.equal(part[8000],123);assert.equal(calls.length,1);assert.equal(calls[0].end,131071);
});
test('range refusal cancels the response instead of downloading a complete song',async()=>{
  let cancelled=false;const response=new Response(new ReadableStream({cancel(){cancelled=true;}}));
  const f=createDriveApi(key,async()=>response).metadataFile({remoteId:file,size:500000});
  await assert.rejects(f.slice(0,32768).arrayBuffer(),/requested metadata range/);assert.ok(cancelled);
});
test('wrong revision ranges, oversized reads and aborted jobs fail without retries',async()=>{
  let calls=0;const api=createDriveApi(key,async()=>{calls++;return new Response(new Uint8Array(32),{status:206,headers:{'content-range':'bytes 0-31/32'}});});
  await assert.rejects(api.metadataFile({remoteId:file,size:500000}).slice(0,32).arrayBuffer(),/range/);
  await assert.rejects(api.metadataFile({remoteId:file,size:5000000}).slice(0,3000000).arrayBuffer(),/budget/);assert.equal(calls,1);
  const c=new AbortController();c.abort();await assert.rejects(api.metadataFile({remoteId:file,size:1000},c.signal).slice(0,32).arrayBuffer(),/Aborted/);assert.equal(calls,1);
});
const tagCode=source.slice(source.indexOf("const TD=new TextDecoder"),source.indexOf('function buildTagWorkerURL'));
function oggPage(packet,seq=0){
  const lengths=[];let left=packet.length;while(left>=255){lengths.push(255);left-=255;}lengths.push(left);
  const b=Buffer.alloc(27+lengths.length+packet.length);b.write('OggS');b[26]=lengths.length;b.set(lengths,27);b.set(packet,27+lengths.length);return b;
}
function opusFixture(){
  const head=Buffer.alloc(19);head.write('OpusHead');head[8]=1;head[9]=2;
  const jpeg=Buffer.alloc(200,7),mime=Buffer.from('image/jpeg');
  const picture=Buffer.alloc(4+4+mime.length+4+16+4+jpeg.length);let at=4;picture.writeUInt32BE(mime.length,at);at+=4;picture.set(mime,at);at+=mime.length+4+16;picture.writeUInt32BE(jpeg.length,at);picture.set(jpeg,at+4);
  const comments=['TITLE=懸想','ARTIST=Miraidempa','ALBUM=Test Album','ALBUMARTIST=Album Artist','TRACKNUMBER=4/10','DISCNUMBER=2','DATE=2024','METADATA_BLOCK_PICTURE='+picture.toString('base64')].map(s=>Buffer.from(s));
  const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
  const tags=Buffer.concat([Buffer.from('OpusTags'),u32(0),u32(comments.length),...comments.flatMap(b=>[u32(b.length),b])]);
  return Buffer.concat([oggPage(head),oggPage(tags),Buffer.alloc(500000)]);
}
test('actual embedded Opus parser reads tags and artwork from a bounded head, with no tail or waveform decode',async()=>{
  const bytes=opusFixture(),calls=[];
  const ctx=vm.createContext({TextDecoder,Uint8Array,atob,performance});const read=vm.runInContext(tagCode+'\nreadTags',ctx);
  const f=createDriveApi(key,rangeMock(bytes,calls)).metadataFile({remoteId:file,size:bytes.length});
  const tags=await read(f,{remote:true,headerOnly:true,throwErrors:true});
  assert.equal(tags.title,'懸想');assert.equal(tags.artist,'Miraidempa');assert.equal(tags.album,'Test Album');assert.equal(tags.track,4);assert.equal(tags.disc,2);assert.equal(tags.year,2024);
  assert.equal(tags.pic.mime,'image/jpeg');assert.equal(tags.pic.data.length,200);assert.equal(tags.sampleRate,48000);assert.equal(tags.bits,undefined);assert.equal(tags.tagDur,undefined);
  assert.equal(calls.length,1);assert.equal(calls[0].start,0);assert.equal(calls[0].end,131071);
});
test('metadata scheduler deduplicates covers and caches completed jobs',async()=>{
  const {drive,tracks}=integration();let release;const order=[];
  const t1={id:'gd_one',source:'drive',md5:'one',size:1000},t2={id:'gd_two',source:'drive',md5:'two',size:1000};tracks.set(t1.id,t1);tracks.set(t2.id,t2);
  drive.readMetadata=async t=>{order.push(t.id);if(t===t1)await new Promise(r=>release=r);t.driveTagVersion=1;};
  const first=drive.ensureMetadata(t1);assert.equal(first,drive.ensureMetadata(t1));const second=drive.ensureMetadata(t2);
  assert.deepEqual(order,['gd_one']);release();await first;await second;clearTimeout(drive.tagTimer);assert.deepEqual(order,['gd_one','gd_two']);
  await drive.ensureMetadata(t1);assert.equal(order.length,2);
});


test('metadata waits during audio buffering and promotes the selected song',async()=>{
  const {drive,tracks,engine}=integration();const order=[];
  engine.playing=true;engine.el=()=>({readyState:0});
  const a={id:'first',source:'drive',md5:'a'},b={id:'selected',source:'drive',md5:'b'};
  tracks.set(a.id,a);tracks.set(b.id,b);engine.current=b;
  drive.readMetadata=async t=>{order.push(t.id);};
  const first=drive.ensureMetadata(a),second=drive.ensureMetadata(b);
  assert.deepEqual(order,[]);engine.el=()=>({readyState:3});drive.pumpTags();await Promise.all([first,second]);
  clearTimeout(drive.tagTimer);assert.deepEqual(order,['selected','first']);
});
test('rapid track changes abort abandoned artwork reads',()=>{
  const {drive}=integration();const controller=new AbortController();
  drive.tagActive={t:{id:'old'},controller};drive.prioritize({id:'new'});assert.ok(controller.signal.aborted);
});


test('Drive CORS may hide Content-Range; an exact bounded 206 body is still readable',async()=>{
  const api=createDriveApi(key,async()=>new Response(new Uint8Array(131072),{status:206,headers:{'content-length':'131072'}}));
  const f=api.metadataFile({remoteId:file,size:500000});assert.equal((await f.slice(0,32768).arrayBuffer()).byteLength,32768);
  const bad=createDriveApi(key,async()=>new Response(new Uint8Array(131073),{status:206}));
  await assert.rejects(bad.metadataFile({remoteId:file,size:500000}).slice(0,32768).arrayBuffer(),/exceeded/);
});
