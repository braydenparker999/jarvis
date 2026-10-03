import test from 'node:test';
import assert from 'node:assert/strict';
import {publicURL,parseFeed,episodeID,durationSeconds,getFeed,directory,podcasts,upstream} from '../backend/podcasts.js';
import {emptyState,keyOf,nextQueued,resumePosition,shouldSleep,compactProgress,clock,readState} from '../public/podcasts/core.js';
import worker from '../backend/worker.js';
const feedURL='https://feeds.example.org/podcast.xml';
const rss=`<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>History &amp; Sound</title><itunes:author>Somebody</itunes:author><description><![CDATA[<p>A good <b>show</b></p>]]></description><itunes:image href="https://images.example.org/show.jpg"/><item><title>Episode &amp; one</title><guid isPermaLink="false">episode-1</guid><description><![CDATA[<p>Notes with &amp; characters and &lt;item&gt; text.</p>]]></description><pubDate>Fri, 02 Oct 2026 12:00:00 GMT</pubDate><itunes:duration>01:02:03</itunes:duration><enclosure url="https://media.example.org/audio.mp3?a=1&amp;b=2" type="audio/mpeg" length="12000"/></item><item><title>Episode two</title><guid>episode-2</guid><itunes:duration>120</itunes:duration><enclosure url="https://media.example.org/two.mp3" type="audio/mpeg"/></item><item><title>Duplicate</title><guid>episode-1</guid><enclosure url="https://media.example.org/audio.mp3" type="audio/mpeg"/></item><item><title>Private</title><enclosure url="http://127.0.0.1/audio.mp3" type="audio/mpeg"/></item><item><title>Video</title><enclosure url="https://media.example.org/video.mp4" type="video/mp4"/></item></channel></rss>`;
const reply=(data,status=200)=>Response.json(data,{status});
test('public URLs reject credentials, local addresses, numeric tricks and unsafe protocols',()=>{
  for(const url of ['file:///etc/passwd','https://localhost/feed','http://127.0.0.1/','http://2130706433/','http://0x7f000001/','http://[::1]/','https://a.internal/feed','https://127.0.0.1.nip.io/','https://name:pass@feeds.example.org/','https://feeds.example.org:8443/','https://metadata.google.internal/'])assert.throws(()=>publicURL(url));
  assert.equal(publicURL(feedURL+'#test'),feedURL);
});
test('RSS uses stable GUIDs, text-only notes, valid dates, publisher audio and deduplicated episodes',()=>{
  const data=parseFeed(rss,feedURL);assert.equal(data.show.title,'History & Sound');assert.equal(data.show.description,'A good show');assert.equal(data.episodes.length,2);
  assert.equal(data.episodes[0].duration,3723);assert.equal(data.episodes[0].audioUrl,'https://media.example.org/audio.mp3?a=1&b=2');assert.equal(data.episodes[0].id,episodeID('episode-1'));
  assert.ok(!data.episodes[0].description.includes('<p>'));assert.equal(data.episodes[0].publishedAt,'2026-10-02T12:00:00.000Z');
  assert.throws(()=>parseFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+rss,feedURL));assert.throws(()=>parseFeed('<html>Not a feed</html>',feedURL));
  assert.equal(durationSeconds('4:30'),270);assert.equal(durationSeconds('invalid'),0);
});
test('all redirects are revalidated before fetching; private redirects are refused',async()=>{
  const calls=[];await assert.rejects(upstream(feedURL,{fetcher:async u=>{calls.push(u);return new Response(null,{status:302,headers:{Location:'http://169.254.169.254/metadata'}});}}));assert.equal(calls.length,1);
});
test('streamed feed byte cap is enforced even without Content-Length',async()=>{
  await assert.rejects(getFeed(feedURL,{fetcher:async()=>new Response('x'.repeat(4*1024*1024+1))}),/too large/);
});
test('large archives retain complete playable episodes within the feed budget',async()=>{
  const body=rss.replace('</channel></rss>','<item><description>'+('x'.repeat(5*1024*1024))+'</description></item></channel></rss>');
  const chunks=new ReadableStream({start(c){for(let i=0;i<body.length;i+=32000)c.enqueue(new TextEncoder().encode(body.slice(i,i+32000)));c.close();}});
  const data=await getFeed(feedURL,{fetcher:async()=>new Response(chunks,{headers:{'Content-Length':String(body.length)}})});assert.equal(data.episodes.length,2);
});
test('directory search returns playable shows and uses bounded podcast-specific queries',async()=>{
  const result=await directory('History','ar',{fetcher:async url=>{const u=new URL(url);assert.equal(u.searchParams.get('country'),'ar');assert.equal(u.searchParams.get('media'),'podcast');assert.equal(u.searchParams.get('limit'),'36');return Response.json({results:[{collectionId:1,collectionName:'History',feedUrl:feedURL},{collectionId:2,collectionName:'No RSS'}]});}});
  assert.equal(result.shows.length,1);await assert.rejects(directory('x','us'),/two characters/);
});
test('audio is resolved from an RSS enclosure, preserves range headers and rejects non-audio bodies',async()=>{
  const calls=[],fetcher=async(url,opts)=>{calls.push(url);if(url===feedURL)return new Response(rss);assert.equal(opts.headers.Range,'bytes=10-19');return new Response('0123456789',{status:206,headers:{'Content-Type':'audio/mpeg','Content-Range':'bytes 10-19/100','Content-Length':'10','Accept-Ranges':'bytes'}});};
  const request=new Request(`https://api.example.org/podcasts/audio?feed=${encodeURIComponent(feedURL)}&id=${episodeID('episode-1')}`,{headers:{Range:'bytes=10-19',Origin:'https://missionarytube.z13.web.core.windows.net'}});
  const r=await podcasts(request,reply,{fetcher});assert.equal(r.status,206);assert.equal(r.headers.get('Content-Range'),'bytes 10-19/100');assert.equal(await r.text(),'0123456789');assert.equal(calls.length,2);
  const bad=await podcasts(new Request(request.url),reply,{fetcher:async url=>url===feedURL?new Response(rss):new Response('<html>error</html>',{headers:{'Content-Type':'text/html'}})});assert.equal(bad.status,415);
});
test('missing episodes cannot turn the audio route into an arbitrary URL proxy',async()=>{
  const r=await podcasts(new Request(`https://api.example.org/podcasts/audio?feed=${encodeURIComponent(feedURL)}&id=missing`),reply,{fetcher:async()=>new Response(rss)});assert.equal(r.status,404);
});
test('existing Worker routes retain origin enforcement and expose podcast health',async()=>{
  const r=await worker.fetch(new Request('https://api.example.org/podcasts/health'),{});assert.deepEqual(await r.json(),{ok:true,version:1});
  const rejected=await worker.fetch(new Request('https://api.example.org/podcasts/health',{headers:{Origin:'https://untrusted.example.org'}}),{});assert.equal(rejected.status,403);
});
test('resume, ordered queue, progress bounds and timer transitions preserve listening semantics',()=>{
  const e={id:'one',show:{feedUrl:feedURL}},two={...e,id:'two'};
  assert.equal(resumePosition({position:900},500),499);assert.equal(resumePosition({position:900,played:true},500),0);
  assert.deepEqual(nextQueued([e,two],e),[two]);assert.equal(keyOf(e),feedURL+'#one');
  assert.equal(shouldSleep({deadline:2000},1999),false);assert.equal(shouldSleep({deadline:2000},2000),true);
  assert.equal(shouldSleep({endOfEpisode:true},2000),false);assert.equal(shouldSleep({endOfEpisode:true},2000,true),true);
  assert.equal(Object.keys(compactProgress(Object.fromEntries(Array.from({length:400},(_,i)=>[i,{updatedAt:i}])))).length,300);
  assert.equal(clock(3723),'1:02:03');assert.deepEqual(readState({getItem:()=>'{broken'}),emptyState());
});
