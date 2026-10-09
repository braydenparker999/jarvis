import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {collectInfoMetadata,inventoryFingerprint,metadataFromInfo,mergePreparedMetadata,planDateBackfill,rowsFromArchive} from '../scripts/video-date-backfill.mjs';
import {enrichVideos} from '../public/mymedia/discovery.js';
import {createVideoApi,parseLibrary} from '../public/mymedia/library.js';
import {dateProvenance,savedYouTubeDate,youtubeDate} from '../public/mymedia/metadata.js';

const video=(id='video123456789',youtubeId='abcdefghijk')=>({id,youtubeId,name:`Video [${youtubeId}].mp4`,title:'Video',folder:'Videos',size:100,modified:1790000000000,addedAt:1790000001000});
const inventory=(videos=[video()])=>({id:'folder123456789',name:'Videos',metadataStatus:'missing',videos});
const source=(id='abcdefghijk',date='20100506')=>metadataFromInfo({id,upload_date:date,epoch:1790000000},'a'.repeat(64));

test('backfill adds only date/provenance fields and preserves metadata and all media identities',()=>{
  const inv=inventory(),existing={version:2,custom:'keep',videos:[{id:inv.videos[0].id,youtubeId:'abcdefghijk',creator:'Reviewed creator',description:'Newer notes',addedAt:99,custom:'keep'}]};
  const before=structuredClone({inv,existing});
  const {plan,candidate}=planDateBackfill(inv,existing,[source()]);
  assert.deepEqual(plan.counts,{would_add_upload_date:1});
  assert.equal(candidate.videos[0].youtubeUploadDate,'2010-05-06');
  assert.deepEqual(candidate.videos[0].youtubeDateProvenance,{source:'yt-dlp.upload_date',kind:'upload',youtubeId:'abcdefghijk',evidenceSha256:'a'.repeat(64),observedAt:new Date(1790000000000).toISOString()});
  const {youtubeUploadDate,youtubeDateProvenance,...unchanged}=candidate.videos[0];
  assert.deepEqual(unchanged,existing.videos[0]);
  assert.deepEqual({inv,existing},before);
  assert.deepEqual(enrichVideos(inv.videos,candidate).map(v=>[v.id,v.size,v.addedAt]),[[inv.videos[0].id,100,99]]);
  assert.equal(planDateBackfill(inv,candidate,[source()]).plan.counts.already_dated,1,'rerunning preserves an already dated row');
});

test('dates never derive from extraction, Drive timestamps, filename dates, or an unproven archive publication',()=>{
  const inv=inventory([video(),{...video('video223456789',''),name:'2010-05-06 - no ID.mp4'}]);
  const rows=[metadataFromInfo({id:'abcdefghijk',epoch:1790000000,createdTime:'2010-05-06'})];
  const state={version:1,videos:{abcdefghijk:{video_id:'abcdefghijk',published_at:'2010-05-06'}}};
  assert.deepEqual(rowsFromArchive(state),[]);
  const {plan,candidate}=planDateBackfill(inv,undefined,rows);
  assert.deepEqual(plan.counts,{needs_upload_date_source:1,no_youtube_id:1});
  assert.deepEqual(candidate.videos,[]);
  assert.equal(planDateBackfill(inventory(),undefined,[metadataFromInfo({id:'abcdefghijk',timestamp:1700000000})]).plan.counts.needs_upload_date_source,1);
});

test('explicit archive upload-date provenance is supported, invalid calendars are excluded',()=>{
  const archive={version:1,videos:{abcdefghijk:{video_id:'abcdefghijk',youtube_upload_date:'2010-05-06',youtube_date_source:'yt-dlp.upload_date'}}};
  const rows=rowsFromArchive(archive);
  const {candidate}=planDateBackfill(inventory(),undefined,rows);
  assert.equal(candidate.videos[0].youtubeDateProvenance.source,'archive.yt-dlp.upload_date');
  archive.videos.abcdefghijk.youtube_upload_date='2026-02-30';assert.deepEqual(rowsFromArchive(archive),[]);
});

test('conflicting evidence and ambiguous or contradictory identities are left for review',()=>{
  assert.equal(planDateBackfill(inventory(),undefined,[source(),source('abcdefghijk','20100507')]).plan.counts.source_date_conflict,1);
  const a={id:'video123456789',youtubeId:'abcdefghijk'},b={...a};
  assert.equal(planDateBackfill(inventory(),{videos:[a,b]},[source()]).plan.counts.existing_identity_conflict,1);
  assert.equal(planDateBackfill(inventory(),{videos:[{id:a.id,youtubeId:'lmnopqrstuv'}]},[source()]).plan.counts.existing_identity_conflict,1);
  const twins=inventory([video(),video('video223456789')]);
  assert.equal(planDateBackfill(twins,{videos:[{youtubeId:'abcdefghijk'}]},[source()]).plan.counts.existing_identity_conflict,2);
  assert.equal(planDateBackfill(inventory(),{videos:[{...a,youtubeUploadDate:'2026-02-30'}]},[source()]).plan.counts.invalid_existing_date,1);
});

test('valid upload, publication and cached dates are never replaced by a backfill',()=>{
  for(const fields of [{youtubeUploadDate:'2020-01-02'},{youtubePublishedAt:'2020-01-02T03:04:05Z'}]){
    const existing={version:2,videos:[{id:'video123456789',...fields}]};
    const {plan,candidate}=planDateBackfill(inventory(),existing,[source()]);
    assert.equal(plan.counts.already_dated,1);assert.deepEqual(candidate,existing);
  }
  assert.equal(planDateBackfill(inventory([{...video(),youtubeAt:Date.UTC(2020,0,2),youtubeDateKind:'upload'}]),undefined,[source()]).plan.counts.already_dated,1);
});

test('inventory fingerprint changes on media edits and additions, but is independent of listing order',()=>{
  const inv=inventory([video(),video('video223456789','lmnopqrstuv')]);
  assert.equal(inventoryFingerprint(inv),inventoryFingerprint({...inv,videos:[...inv.videos].reverse()}));
  for(const fields of [{size:101},{modified:1790000000001},{youtubeId:'zbcdefghijk'},{md5Checksum:'b'.repeat(32)},{name:'Renamed.mp4'}])
    assert.notEqual(inventoryFingerprint(inv),inventoryFingerprint({...inv,videos:[{...inv.videos[0],...fields},inv.videos[1]]}));
  assert.throws(()=>inventoryFingerprint(inventory([video(),video()])),/duplicate/);
});

test('builder keeps newer and orphaned metadata; it prefers upload evidence over a published timestamp',()=>{
  const existing={version:2,videos:[{youtubeId:'abcdefghijk',creator:'Newer creator',youtubeUploadDate:'2020-01-02',addedAt:99},{youtubeId:'lmnopqrstuv',description:'Orphan keep'}]};
  const {manifest}=mergePreparedMetadata(existing,[{...source(),creator:'Older creator',addedAt:100}]);
  assert.deepEqual(manifest,existing);
  const published=metadataFromInfo({id:'abcdefghijk',timestamp:1700000000});
  assert.equal(mergePreparedMetadata({version:2,videos:[]},[published,source()]).manifest.videos[0].youtubeUploadDate,'2010-05-06');
});

test('sidecar collection is deterministic, ignores symlinks and extracts only safe metadata fields',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'video-source-'));
  try{
    await writeFile(join(dir,'b.info.json'),JSON.stringify({id:'lmnopqrstuv',epoch:1790000000,cookies:'private-canary'}));
    await writeFile(join(dir,'a.info.json'),JSON.stringify({id:'abcdefghijk',upload_date:'20100506',url:'https://private-canary.test/token'}));
    await writeFile(join(dir,'bad.info.json'),'not JSON');
    await symlink(join(dir,'a.info.json'),join(dir,'linked.info.json'));
    const result=await collectInfoMetadata(dir);
    assert.deepEqual(result.rows.map(row=>row.youtubeId),['abcdefghijk','lmnopqrstuv']);
    assert.equal(result.diagnostics.length,1);assert.ok(!JSON.stringify(result).includes('private-canary'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('existing local manifests are never overwritten; builder emits a separate candidate',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'video-builder-'));
  try{
    const original=JSON.stringify({version:2,videos:[{youtubeId:'abcdefghijk',creator:'Newer creator'}]});
    await writeFile(join(dir,'jarvis-video-metadata.json'),original);
    await writeFile(join(dir,'one.info.json'),JSON.stringify({id:'abcdefghijk',upload_date:'20100506',channel:'Old creator'}));
    execFileSync(process.execPath,['scripts/build-video-metadata.mjs',dir]);
    assert.equal(await readFile(join(dir,'jarvis-video-metadata.json'),'utf8'),original);
    const candidate=JSON.parse(await readFile(join(dir,'jarvis-video-metadata.candidate.json'),'utf8'));
    assert.equal(candidate.videos[0].creator,'Newer creator');assert.equal(candidate.videos[0].youtubeUploadDate,'2010-05-06');
    assert.notEqual(spawnSync(process.execPath,['scripts/build-video-metadata.mjs',dir]).status,0,'cannot overwrite a reviewed candidate');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('dry-run CLI creates exclusive artifacts and refuses an unreadable live-manifest baseline',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'video-plan-'));
  try{
    const path=join(dir,'inventory.json');await writeFile(path,JSON.stringify(inventory()));
    const out=join(dir,'review');
    const args=['scripts/backfill-video-dates.mjs','--inventory',path,'--out',out];
    execFileSync(process.execPath,args);
    assert.equal(JSON.parse(await readFile(join(out,'video-date-backfill-plan.json'),'utf8')).mode,'dry_run');
    assert.notEqual(spawnSync(process.execPath,args).status,0);
    await writeFile(path,JSON.stringify({...inventory(),metadataStatus:'unavailable'}));
    const blocked=spawnSync(process.execPath,[...args.slice(0,-1),join(dir,'blocked')]);
    assert.notEqual(blocked.status,0);assert.match(String(blocked.stderr),/reviewed existing manifest/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('ingestion keeps known metadata on sparse rows, and refuses ambiguous identities',()=>{
  const dated={...video(),creator:'Keep',description:'Keep notes',topics:['Keep'],youtubeAt:Date.UTC(2020,0,2),youtubeDateKind:'upload'};
  const [result]=enrichVideos([dated],{videos:[{id:dated.id}]});
  assert.equal(result.youtubeAt,dated.youtubeAt);assert.equal(result.creator,'Keep');assert.deepEqual(result.topics,['Keep']);
  assert.deepEqual(enrichVideos([dated],{videos:[{id:dated.id,...source()},{id:dated.id,youtubeUploadDate:'2010-05-07'}]}),[dated]);
  assert.deepEqual(enrichVideos([dated],{videos:[{id:dated.id,youtubeId:'lmnopqrstuv',youtubeUploadDate:'2010-05-06'}]}),[dated]);
  const [enriched]=enrichVideos([video()],{videos:[{id:dated.id,...source()}]});
  assert.equal(enriched.youtubeDateProvenance.kind,'upload');
  const cache=parseLibrary(JSON.stringify(inventory([enriched])));
  assert.deepEqual(cache.videos[0].youtubeDateProvenance,enriched.youtubeDateProvenance);
  assert.equal(dateProvenance({youtubeAt:Date.UTC(2020,0,2),youtubeDateKind:'upload',youtubeDateProvenance:{source:'drive.createdTime',kind:'upload',youtubeId:'abcdefghijk'}},youtubeDate({})),null);
});

test('optional missing, invalid, duplicate and inaccessible manifests never hide the media',async()=>{
  const key='AIza'+'x'.repeat(35),root=inventory().id,info={id:root,name:'Videos',mimeType:'application/vnd.google-apps.folder'};
  const media={id:video().id,name:video().name,size:'100',mimeType:'video/mp4'};
  const metadata={id:'metadata123456',name:'jarvis-video-metadata.json',size:'200',mimeType:'application/json'};
  for(const scenario of [{extra:[],status:'missing'}, {extra:[metadata,metadata],status:'ambiguous'},
    {extra:[metadata],body:{invalid:true},status:'invalid'}, {extra:[metadata],http:403,status:'unavailable'}]){
    const responses=[new Response(JSON.stringify(info)),new Response(JSON.stringify({files:[media,...scenario.extra]})),
      new Response(JSON.stringify(scenario.body||{}),{status:scenario.http||200})];
    const list=await createVideoApi(key,async()=>responses.shift()).list(root);
    assert.equal(list.videos.length,1);assert.equal(list.metadataStatus,scenario.status);
  }
});

test('legacy cached dates survive without inventing provenance from missing source fields',()=>{
  for(const kind of ['upload','published']){
    const cached={...video(),youtubeAt:Date.UTC(2020,0,2),youtubeDateKind:kind};
    const parsed=parseLibrary(JSON.stringify(inventory([cached]))).videos[0];
    assert.equal(parsed.youtubeAt,cached.youtubeAt);
    assert.equal(parsed.youtubeDateKind,kind);
    assert.equal(parsed.youtubeDateProvenance,null);
    assert.equal(dateProvenance(cached,savedYouTubeDate(cached)),null);
  }
});

test('invalid, absent or disagreeing source evidence keeps a known date but leaves provenance unknown',()=>{
  const cached={...video(),youtubeAt:Date.UTC(2020,0,2),youtubeDateKind:'upload'};
  const valid={source:'manifest.youtubeUploadDate',kind:'upload',youtubeId:cached.youtubeId};
  const cases=[
    {youtubeDateProvenance:valid},
    {youtubeUploadDate:'2020-01-03',youtubeDateProvenance:valid},
    {youtubeUploadDate:'2020-02-30',youtubeDateProvenance:valid},
    {youtubeUploadDate:'2020-01-02',youtubeDateProvenance:{...valid,source:'drive.createdTime'}},
    {youtubeUploadDate:'2020-01-02',youtubeDateProvenance:{...valid,kind:'published'}},
    {youtubeUploadDate:'2020-01-02',youtubeDateProvenance:{...valid,youtubeId:'lmnopqrstuv'}},
    {upload_date:'20200102',youtubeDateProvenance:valid},
    {upload_date:'bad',youtubeUploadDate:'2020-01-02',youtubeDateProvenance:{...valid,source:'yt-dlp.upload_date'}},
    {youtubeUploadDate:'2020-01-02',youtubeDateProvenance:null},
    {youtubePublishedAt:'2020-01-02T00:00:00Z'}
  ];
  for(const fields of cases){
    const row={...cached,...fields},parsed=parseLibrary(JSON.stringify(inventory([row]))).videos[0];
    assert.equal(parsed.youtubeAt,cached.youtubeAt);
    assert.equal(parsed.youtubeDateKind,'upload');
    assert.equal(parsed.youtubeDateProvenance,null);
    assert.equal(dateProvenance(row,savedYouTubeDate(row)),null);
  }
  const published={...cached,youtubeDateKind:'published',youtubePublishedAt:'bad',timestamp:cached.youtubeAt/1000};
  assert.equal(dateProvenance(published,savedYouTubeDate(published)).source,'yt-dlp.timestamp','an invalid publication field cannot claim the valid timestamp');
  for(const fields of [
    {youtubePublishedAt:'2020-01-02T00:00:00Z',timestamp:cached.youtubeAt/1000-1,youtubeDateProvenance:{source:'yt-dlp.timestamp',kind:'published',youtubeId:cached.youtubeId}},
    {youtubePublishedAt:'2020-01-02T00:00:00Z',youtubeDateProvenance:{source:'drive.createdTime',kind:'published',youtubeId:cached.youtubeId}}
  ]){
    const row={...cached,youtubeDateKind:'published',...fields};
    const parsed=parseLibrary(JSON.stringify(inventory([row]))).videos[0];
    assert.equal(parsed.youtubeAt,cached.youtubeAt);assert.equal(parsed.youtubeDateProvenance,null);
  }
});

test('validated source dates and provenance remain supported through enrichment and cache reload',()=>{
  for(const fields of [
    {upload_date:'20100506'},
    {youtubeUploadDate:'2010-05-06'},
    {timestamp:1700000000},
    {youtubePublishedAt:'2023-11-14T22:13:20Z'},
    source()
  ]){
    const original={...fields,youtubeId:video().youtubeId};
    const [enriched]=enrichVideos([video()],{videos:[original]});
    const cached=parseLibrary(JSON.stringify(inventory([enriched]))).videos[0];
    assert.deepEqual(cached.youtubeDateProvenance,dateProvenance(original));
    assert.equal(cached.youtubeAt,youtubeDate(original).youtubeAt);
  }
});

test('non-downloadable root manifests remain visible and prevent an empty backfill baseline',async t=>{
  const key='AIza'+'x'.repeat(35),root=inventory().id;
  const info={id:root,name:'Videos',mimeType:'application/vnd.google-apps.folder'};
  const media={id:video().id,name:video().name,size:'100',mimeType:'video/mp4'};
  const readable={id:'metadata123456',name:'jarvis-video-metadata.json',size:'200',mimeType:'application/json'};
  const unreadable={...readable,id:'metadata223456',capabilities:{canDownload:false}};
  const scenarios=[
    {name:'single unreadable manifest',pages:[[unreadable]],status:'unavailable'},
    {name:'unreadable manifest before a readable duplicate',pages:[[unreadable,readable]],status:'ambiguous'},
    {name:'unreadable duplicate on a later page',pages:[[readable],[unreadable]],status:'ambiguous'},
    {name:'two unreadable manifests',pages:[[unreadable,{...unreadable,id:'metadata323456'}]],status:'ambiguous'}
  ];
  for(const scenario of scenarios)await t.test(scenario.name,async()=>{
    const requests=[],pages=scenario.pages.map((files,index)=>({
      files:index===0?[media,{...media,id:'video223456789',capabilities:{canDownload:false}},...files]:files,
      ...(index<scenario.pages.length-1?{nextPageToken:'page-'+(index+1)}:{})
    }));
    const api=createVideoApi(key,async url=>{
      const request=new URL(url);requests.push(request);
      assert.notEqual(request.searchParams.get('alt'),'media','an unreadable or ambiguous manifest must not be fetched');
      return new Response(JSON.stringify(request.pathname.endsWith('/'+root)?info:pages.shift()));
    });
    const listed=await api.list(root);
    assert.equal(listed.metadataStatus,scenario.status);
    assert.deepEqual(listed.videos.map(v=>v.id),[media.id],'metadata access does not hide downloadable media or expose blocked media');
    assert.equal(listed.videos[0].youtubeAt,undefined,'ambiguous metadata is never applied');
    assert.equal(requests.length,scenario.pages.length+1);

    const dir=await mkdtemp(join(tmpdir(),'video-manifest-guard-'));
    try{
      const path=join(dir,'inventory.json'),out=join(dir,'review'),sources=join(dir,'sources');
      await writeFile(path,JSON.stringify(listed));
      // A known source date would otherwise produce an additive candidate over an empty baseline.
      await mkdir(sources);
      await writeFile(join(sources,'video.info.json'),JSON.stringify({id:'abcdefghijk',upload_date:'20100506'}));
      const blocked=spawnSync(process.execPath,['scripts/backfill-video-dates.mjs','--inventory',path,'--sources',sources,'--out',out]);
      assert.notEqual(blocked.status,0);
      assert.match(String(blocked.stderr),/reviewed existing manifest/);
      await assert.rejects(readFile(join(out,'video-date-backfill-plan.json')),{code:'ENOENT'});
      await assert.rejects(readFile(join(out,'jarvis-video-metadata.candidate.json')),{code:'ENOENT'});
    }finally{await rm(dir,{recursive:true,force:true});}
  });
});
