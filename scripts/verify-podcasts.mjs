import assert from 'node:assert/strict';
const origin='https://jarvis-hub-api.braydenparker999.workers.dev';
const frontend='https://missionarytube.z13.web.core.windows.net';
async function read(path){const r=await fetch(origin+path,{headers:{Origin:frontend},signal:AbortSignal.timeout(30000)});assert.equal(r.status,200,path);assert.equal(r.headers.get('Access-Control-Allow-Origin'),frontend);return r.json();}
assert.equal((await read('/podcasts/health')).version,1);
const search=await read('/podcasts/search?q=history&country=us');assert.ok(search.shows.length,'Real podcast search must return shows');
let audioVerified=false;
for(const show of search.shows.slice(0,4)){
 try{
  const feed=await read('/podcasts/feed?url='+encodeURIComponent(show.feedUrl));assert.ok(feed.episodes.length,'Real RSS must return playable episodes');
  const e=feed.episodes[0],url=origin+'/podcasts/audio?feed='+encodeURIComponent(show.feedUrl)+'&id='+e.id;
  const r=await fetch(url,{headers:{Origin:frontend,Range:'bytes=0-4095'},signal:AbortSignal.timeout(30000)});
  assert.ok([200,206].includes(r.status),'Real publisher audio must load');assert.ok(r.headers.get('Content-Type')?.startsWith('audio/'));
  if(r.status===206){assert.match(r.headers.get('Content-Range'),/^bytes 0-4095\//);assert.equal((await r.arrayBuffer()).byteLength,4096);}else{const reader=r.body.getReader();const first=await reader.read();assert.ok(first.value?.length);await reader.cancel();}
  assert.equal(r.headers.get('Access-Control-Allow-Origin'),frontend);audioVerified=true;console.log('Verified real directory search, RSS and audio delivery:',show.title);break;
 }catch(e){console.log('Trying another publisher:',e.message);}
}
assert.ok(audioVerified,'At least one real RSS enclosure must serve audio');
