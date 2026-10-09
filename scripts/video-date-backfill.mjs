// Pure metadata planning. No network, media reads, uploads or apply operation.
import {createHash} from 'node:crypto';
import {readFile,readdir,stat} from 'node:fs/promises';
import {basename,join,relative} from 'node:path';
import {indexMetadata,matchMetadata} from '../public/mymedia/discovery.js';
import {dateProvenance,savedYouTubeDate,youtubeDate,youtubeUploadDate} from '../public/mymedia/metadata.js';

const YOUTUBE=/^[A-Za-z0-9_-]{11}$/,DRIVE=/^[A-Za-z0-9_-]{10,200}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
export function validateManifest(manifest){
  if(!manifest||!Array.isArray(manifest.videos)||manifest.videos.length>20000||
     manifest.videos.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw Error('Existing metadata manifest is invalid; preserve and review it.');
  return manifest;
}
export function validateInventory(inventory){
  if(!inventory||!DRIVE.test(inventory.id||'')||!Array.isArray(inventory.videos)||inventory.videos.length>20000)throw Error('Expected a complete My Media inventory snapshot.');
  const ids=new Set();
  for(const v of inventory.videos){
    if(!v||!DRIVE.test(v.id||'')||ids.has(v.id)||typeof v.name!=='string'||
       !Number.isFinite(v.size)||v.size<0||!Number.isFinite(v.modified)||v.modified<0)throw Error('Inventory has invalid or duplicate media identities.');
    ids.add(v.id);
  }return inventory;
}
export function inventoryFingerprint(inventory){
  validateInventory(inventory);
  return digest(JSON.stringify({folderId:inventory.id,videos:inventory.videos.map(v=>({id:v.id,youtubeId:v.youtubeId||'',
    name:v.name,size:v.size,modified:v.modified,md5Checksum:v.md5Checksum||''})).sort((a,b)=>a.id.localeCompare(b.id))}));
}
export function metadataFromInfo(info,evidenceSha256){
  if(!info||!YOUTUBE.test(info.id||''))return null;
  const date=youtubeDate(info),row={youtubeId:info.id,
    ...(typeof info._filename==='string'?{name:basename(info._filename)}:{}),
    ...(typeof (info.channel||info.uploader)==='string'?{creator:(info.channel||info.uploader).slice(0,160)}:{}),
    ...(typeof info.description==='string'?{description:info.description.slice(0,2000)}:{}),
    ...(Array.isArray(info.categories)?{topics:info.categories.filter(t=>typeof t==='string').slice(0,12).map(t=>t.slice(0,80))}:{}),
    ...(Number.isFinite(info.epoch)&&info.epoch>0?{addedAt:info.epoch*1000}:{})};
  if(date.youtubeAt){
    if(date.youtubeDateKind==='upload')row.youtubeUploadDate=new Date(date.youtubeAt).toISOString().slice(0,10);
    else row.youtubePublishedAt=new Date(date.youtubeAt).toISOString();
    row.youtubeDateProvenance={source:date.youtubeDateKind==='upload'?'yt-dlp.upload_date':'yt-dlp.timestamp',
      kind:date.youtubeDateKind,youtubeId:info.id,...(evidenceSha256?{evidenceSha256}:{}),
      ...(Number.isFinite(info.epoch)&&info.epoch>=Date.UTC(2005,0,1)/1000&&info.epoch<Date.UTC(2200,0,1)/1000
        ?{observedAt:new Date(info.epoch*1000).toISOString()}:{})};
  }return row;
}
export async function collectInfoMetadata(root){
  const rows=[],diagnostics=[];
  async function walk(dir){
    const entries=await readdir(dir,{withFileTypes:true});entries.sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries){
      const path=join(dir,entry.name);
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory()){await walk(path);continue;}
      if(!entry.isFile()||!entry.name.endsWith('.info.json'))continue;
      let raw;
      try{if((await stat(path)).size>2000000)throw Error();raw=await readFile(path);if(raw.length>2000000)throw Error();const row=metadataFromInfo(JSON.parse(raw),digest(raw));
        if(row)rows.push(row);else diagnostics.push({file:relative(root,path),code:'invalid_youtube_id'});
      }catch{diagnostics.push({file:relative(root,path),code:'unreadable_or_invalid_info_json'});}
    }
  }await walk(root);return {rows,diagnostics};
}
export function rowsFromArchive(state){
  if(state?.version!==1||!state.videos||typeof state.videos!=='object'||Array.isArray(state.videos))throw Error('Archive state is invalid.');
  return Object.values(state.videos).filter(v=>YOUTUBE.test(v?.video_id||'')&&
    v.youtube_date_source==='yt-dlp.upload_date'&&youtubeUploadDate(v.youtube_upload_date)).map(v=>({youtubeId:v.video_id,
      youtubeUploadDate:v.youtube_upload_date,youtubeDateProvenance:{source:'archive.yt-dlp.upload_date',kind:'upload',youtubeId:v.video_id}}));
}
const dateFields=['upload_date','youtubeUploadDate','youtubePublishedAt','timestamp','youtubeAt','youtubeDateProvenance'];
export function planDateBackfill(inventory,existing={version:2,videos:[]},sources=[]){
  validateInventory(inventory);validateManifest(existing);
  const candidate=structuredClone(existing),index=indexMetadata(existing.videos),sourceIndex=new Map();
  for(const row of sources){if(!row||!YOUTUBE.test(row.youtubeId||''))continue;
    const entries=sourceIndex.get(row.youtubeId)||[];entries.push(row);sourceIndex.set(row.youtubeId,entries);
  }
  const uniqueYouTube=new Map(),uniqueName=new Map();
  for(const v of inventory.videos){for(const [map,key] of [[uniqueYouTube,v.youtubeId],[uniqueName,v.name]])if(key)map.set(key,(map.get(key)||0)+1);}
  const items=[];
  for(const video of [...inventory.videos].sort((a,b)=>a.id.localeCompare(b.id))){
    const item={driveId:video.id,youtubeId:video.youtubeId||'',status:''};
    const match=matchMetadata(video,index),row=match.row;
    if(['ambiguous','identity_conflict'].includes(match.status)){item.status='existing_identity_conflict';items.push(item);continue;}
    if(row&&!row.id&&(row.youtubeId?uniqueYouTube.get(row.youtubeId)>1:uniqueName.get(row.name)>1)){
      item.status='existing_identity_conflict';items.push(item);continue;
    }
    if(youtubeDate(row||{}).youtubeAt||savedYouTubeDate(video).youtubeAt){item.status='already_dated';items.push(item);continue;}
    if(row&&dateFields.some(field=>row[field]!==undefined&&row[field]!==null&&row[field]!==''&&row[field]!==0)){
      item.status='invalid_existing_date';items.push(item);continue;
    }
    if(!YOUTUBE.test(video.youtubeId||'')){item.status='no_youtube_id';items.push(item);continue;}
    const evidence=(sourceIndex.get(video.youtubeId)||[]).filter(r=>youtubeDate(r).youtubeDateKind==='upload');
    const dates=new Set(evidence.map(r=>youtubeDate(r).youtubeAt));
    if(dates.size>1){item.status='source_date_conflict';items.push(item);continue;}
    if(!evidence.length){item.status='needs_upload_date_source';items.push(item);continue;}
    const source=evidence[0],date=youtubeDate(source),provenance=dateProvenance(source,date);
    const patch={youtubeUploadDate:new Date(date.youtubeAt).toISOString().slice(0,10),youtubeDateProvenance:provenance};
    if(row){const position=existing.videos.indexOf(row);candidate.videos[position]={...candidate.videos[position],...patch};}
    else candidate.videos.push({id:video.id,youtubeId:video.youtubeId,...patch});
    items.push({...item,status:'would_add_upload_date',patch});
  }
  const counts={};for(const item of items)counts[item.status]=(counts[item.status]||0)+1;
  return {plan:{version:1,mode:'dry_run',folderId:inventory.id,inventoryFingerprint:inventoryFingerprint(inventory),
    existingManifestSha256:digest(JSON.stringify(existing)),candidateSha256:digest(JSON.stringify(candidate)),
    videos:inventory.videos.length,sourceRows:sources.length,counts,items,
    ownerActions:['Review this exact inventory fingerprint, date evidence, and candidate before any separate metadata publication.',
      'Re-read the inventory and current manifest before publishing; stop on changed fingerprints or newer metadata.']},candidate};
}

// Local builder reconciliation: keep every existing row and nonempty field.
export function mergePreparedMetadata(existing,incoming){
  validateManifest(existing);
  const result=structuredClone(existing),conflicts=[],groups=new Map();
  for(const row of incoming){if(!row?.youtubeId)continue;const group=groups.get(row.youtubeId)||[];group.push(row);groups.set(row.youtubeId,group);}
  for(const [youtubeId,group] of groups){
    const known=result.videos.filter(row=>row.youtubeId===youtubeId);
    const uploads=group.filter(row=>youtubeDate(row).youtubeDateKind==='upload');
    const eligible=uploads.length?uploads:group;
    const dates=new Set(eligible.map(row=>youtubeDate(row).youtubeAt).filter(Boolean));
    if(known.length>1||dates.size>1){conflicts.push({youtubeId,code:'duplicate_or_conflicting_metadata'});continue;}
    const row=group.find(r=>youtubeDate(r).youtubeDateKind==='upload')||group[0];
    if(!known.length){result.videos.push(structuredClone(row));continue;}
    const target=known[0],hasDate=youtubeDate(target).youtubeAt||dateFields.some(k=>target[k]);
    for(const [key,value] of Object.entries(row)){
      if(dateFields.includes(key)&&hasDate)continue;
      if(target[key]===undefined||target[key]===null||target[key]===''||target[key]===0||Array.isArray(target[key])&&!target[key].length)target[key]=structuredClone(value);
    }
  }return {manifest:result,conflicts};
}
