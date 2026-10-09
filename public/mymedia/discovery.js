import {dateProvenance, savedYouTubeDate, youtubeDate} from './metadata.js';
// Stable daily sampling with round-robin collection diversity.
export function hash(value){let n=2166136261;for(const c of String(value)){n^=c.charCodeAt(0);n=Math.imul(n,16777619);}return n>>>0;}
export function discover(videos,progress={},limit=12,seed=new Date().toISOString().slice(0,10)){
  const groups=new Map();
  for(const v of videos){if(progress[v.id]?.done)continue;const key=v.creator||v.folder||'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(v);}
  const queues=[...groups.entries()].sort(([a],[b])=>hash(seed+a)-hash(seed+b)).map(([,items])=>items.sort((a,b)=>hash(seed+a.id)-hash(seed+b.id)));
  const result=[];let index=0;while(result.length<limit&&queues.some(q=>q.length)){const q=queues[index++%queues.length];if(q.length)result.push(q.shift());}return result;
}
export function withinTime(videos,minutes){return minutes>0?videos.filter(v=>Number.isFinite(v.duration)&&v.duration>0&&v.duration<=minutes*60):videos;}
export function indexMetadata(rows){
  const index={id:new Map(),youtubeId:new Map(),name:new Map()};
  for(const row of rows){if(!row||typeof row!=='object'||Array.isArray(row))continue;
    for(const field of ['id','youtubeId','name'])if(typeof row[field]==='string'&&row[field]){
      const entries=index[field].get(row[field])||[];entries.push(row);index[field].set(row[field],entries);
    }
  }return index;
}
export function matchMetadata(video,index){
  for(const field of ['id','youtubeId','name']){
    const rows=index[field].get(video[field]);if(!rows)continue;
    if(rows.length!==1)return {status:'ambiguous'};
    const row=rows[0];
    if(row.id&&row.id!==video.id||row.youtubeId&&video.youtubeId&&row.youtubeId!==video.youtubeId)return {status:'identity_conflict'};
    return {status:'matched',row};
  }return {status:'missing'};
}
export function enrichVideos(videos,manifest){
  const index=indexMetadata(Array.isArray(manifest?.videos)?manifest.videos.slice(0,20000):[]);
  return videos.map(v=>{const {row}=matchMetadata(v,index);if(!row)return v;
    const incoming=youtubeDate(row),date=incoming.youtubeAt?incoming:savedYouTubeDate(v);
    const provenance=incoming.youtubeAt?dateProvenance({...row,youtubeId:v.youtubeId||row.youtubeId},date):dateProvenance(v,date);
    return {...v,
    ...(typeof row.creator==='string'?{creator:row.creator.slice(0,160)}:{}),
    ...(typeof row.description==='string'?{description:row.description.slice(0,2000)}:{}),
    ...(Array.isArray(row.topics)?{topics:row.topics.filter(x=>typeof x==='string').slice(0,12).map(x=>x.slice(0,80))}:{}),
    addedAt:Number.isFinite(row.addedAt)&&row.addedAt>0?row.addedAt:v.addedAt||0,
    ...(incoming.youtubeAt?(incoming.youtubeDateKind==='upload'
      ?{youtubeUploadDate:new Date(incoming.youtubeAt).toISOString().slice(0,10)}
      :{youtubePublishedAt:new Date(incoming.youtubeAt).toISOString()}):{}),
    ...date,youtubeDateProvenance:provenance||null};});
}
