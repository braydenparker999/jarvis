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
  drive.helper={driveTrack};return {drive,tracks,removed};
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
