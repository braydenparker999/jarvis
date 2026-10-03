import {API_ORIGIN} from '/assets/config.js';
import {STORAGE_KEY,AUDIO_CACHE,MAX_DOWNLOAD,categories,readState,keyOf,offlinePath,clock,minutes,size,resumePosition,nextQueued,shouldSleep,progressEntry,compactProgress,storedFeed,saveFeed} from './core.js';

const $ = id => document.getElementById(id);
const esc = s => String(s || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  back:'<path d="m12 5-7 7 7 7M5 12h15"/>',plus:'<path d="M12 4v16M4 12h16"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  play:'<path d="m9 5 11 7-11 7z"/>',pause:'<path d="M8 5v14M16 5v14"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  library:'<rect x="3" y="5" width="5" height="16" rx="1"/><path d="M12 5v16M16 4l5 16M3 9h5"/>',queue:'<path d="M3 6h18M3 12h12M3 18h9m5-3 5 3-5 3z"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',down:'<path d="m5 9 7 7 7-7"/>',
  rewind:'<path d="M3 10a9 9 0 1 1 1 8M3 4v6h6"/>',forward:'<path d="M21 10a9 9 0 1 0-1 8M21 4v6h-6"/>',moon:'<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/>',
  refresh:'<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  check:'<path d="m5 12 4 4L20 5"/>',trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  up:'<path d="m5 15 7-7 7 7"/>',link:'<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
  podcast:'<circle cx="12" cy="10" r="3"/><path d="M8 21v-4a4 4 0 0 1 8 0v4M6 14a8 8 0 1 1 12 0"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.podcast}</svg>`;
const placeholder = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 24 24"><rect width="24" height="24" fill="#25282b"/><g fill="none" stroke="#aaaeb2" stroke-width="1">${paths.podcast}</g></svg>`);
const safeURL = value => { try { const u=new URL(value);return ['http:','https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const art = (url, cls='artwork') => `<img class="${cls}" src="${esc(safeURL(url) || placeholder)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
document.addEventListener('error',e=>{if(e.target instanceof HTMLImageElement && e.target.src !== placeholder)e.target.src=placeholder;},true);

let state = readState(localStorage), view = 'discover', category = 'popular', feedData = null, renderToken = 0, requestController, lastSaved = 0;
let current = state.current, currentBlob, loadToken = 0, loadedKey = '', timer = null, toastTimer, seeking = false, wantPlay = false;
const audio = $('audio'), downloads = new Map(), feeds = new Map();
const episodeRefs = new Map(), showRefs = new Map();
const commit = () => {state.progress=compactProgress(state.progress);try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));return true;}catch{notify('Could not save listening data. Device storage may be full.');return false;}};
function notify(message) { $('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4000); }
function status(message='',error=false) { $('status').textContent=message;$('status').hidden=!message;$('status').classList.toggle('error',error); }
function playbackStatus(message='',error=false) { $('playback-status').textContent=message;$('playback-status').hidden=!message;$('playback-status').classList.toggle('error',error); }
function closeSheet() { $('sheet').close(); }
function sheet(title,actions) {
  const d=$('sheet');d.innerHTML=`<div class="dialog-heading"><h2 id="sheet-heading">${esc(title)}</h2><button class="close" aria-label="Close menu">×</button></div>${actions.map((a,i)=>`<button class="sheet-action" data-action="${i}">${icon(a.icon || 'podcast')}<span>${esc(a.label)}</span></button>`).join('')}`;
  d.querySelector('.close').onclick=closeSheet;
  d.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{closeSheet();Promise.resolve(actions[Number(b.dataset.action)].action()).catch(e=>notify(e.message || 'Please try again.'));});
  if(!d.open)d.showModal();
}
function formSheet(title,html,submit) {
  const d=$('sheet');d.innerHTML=`<div class="dialog-heading"><h2 id="sheet-heading">${esc(title)}</h2><button class="close" aria-label="Close menu">×</button></div><form class="sheet-form">${html}<button class="primary" type="submit">Save</button><p class="status" role="status" id="form-status"></p></form>`;
  d.querySelector('.close').onclick=closeSheet;
  d.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await submit(new FormData(e.target));}catch(err){$('form-status').textContent=err.message;}};
  if(!d.open)d.showModal();d.querySelector('input,select')?.focus();
}
for(const d of [$('sheet'),$('player')])d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});

async function api(path,params={},signal) {
  const url=new URL('/podcasts/'+path,API_ORIGIN);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
  const r=await fetch(url,{signal:signal || AbortSignal.timeout(25000)});
  let data;try{data=await r.json();}catch{throw Error('The podcast service returned an unreadable response.');}
  if(!r.ok)throw Error(data.error || 'The podcast service is unavailable.');return data;
}
function clientDirectory(query,signal) {
  // Apple's documented JSONP API uses the listener's network, independent of
  // a server region that is rate-limited. Its results are still escaped data.
  return new Promise((resolve,reject)=>{
    const name='__jarvis_podcast_'+crypto.randomUUID().replaceAll('-',''),script=document.createElement('script');
    const url=new URL('https://itunes.apple.com/search');
    for(const [k,v] of Object.entries({term:query,media:'podcast',entity:'podcast',limit:'36',country:state.country,callback:name}))url.searchParams.set(k,v);
    let settled=false;
    const cleanup=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);script.remove();window[name]=()=>{};setTimeout(()=>delete window[name],30000);};
    const finish=(error,data)=>{if(settled)return;settled=true;cleanup();error?reject(error):resolve(data);};
    const abort=()=>finish(new DOMException('Cancelled','AbortError'));
    const timeout=setTimeout(()=>finish(Error('The podcast directory took too long.')),10000);
    window[name]=data=>{if(!Array.isArray(data?.results)){finish(Error('Invalid directory results.'));return;}
      finish(null,{shows:data.results.filter(s=>s.feedUrl&&s.collectionName).slice(0,36).map(s=>({id:String(s.collectionId),title:s.collectionName,author:s.artistName || '',feedUrl:safeURL(s.feedUrl),artwork:safeURL(s.artworkUrl600 || s.artworkUrl100),directoryUrl:safeURL(s.collectionViewUrl),genres:s.genres || []})).filter(s=>s.feedUrl)});};
    script.onerror=()=>finish(Error('Could not reach the podcast directory.'));script.src=url.href;script.referrerPolicy='no-referrer';
    if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});document.head.append(script);
  });
}
async function searchDirectory(path,params,signal) {
  const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
  const query=path==='search'?params.q:categories.find(c=>c[0]===params.category)?.[2] || 'podcast';
  try{return await Promise.any([api(path,params,combined),clientDirectory(query,combined)]);}
  catch{if(signal.aborted)throw new DOMException('Cancelled','AbortError');throw Error('Podcast search is unavailable. Please try again.');}
  finally{controller.abort();}
}
async function feed(url,{refresh=false,signal}={}) {
  if(!refresh && feeds.has(url))return feeds.get(url);
  try { const data=await api('feed',{url},signal);feeds.set(url,data);saveFeed(data).catch(()=>{});return data; }
  catch(e) { if(e.name==='AbortError')throw e;const cached=await storedFeed(url).catch(()=>null);if(cached){feeds.set(url,cached);return {...cached,stale:true};}throw e; }
}
const normalizedShow = show => ({...show,feedUrl:safeURL(show.feedUrl),artwork:safeURL(show.artwork)});
const episode = (e,show) => ({...e,show:normalizedShow(show)});
const date = value => value ? new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}) : '';
function showTiles(shows) {
  return `<div class="show-grid">${shows.map(s=>{showRefs.set(s.feedUrl,s);return `<button class="show-tile" data-feed="${esc(s.feedUrl)}">${art(s.artwork)}<strong>${esc(s.title)}</strong><small>${esc(s.author || s.genres?.[0] || 'Podcast')}</small></button>`;}).join('')}</div>`;
}
function rows(list,{thumbs=false,queue=false}={}) {
  return `<div class="episode-list">${list.map(e=>{
    const key=keyOf(e), p=state.progress[key], stored=state.downloads[key];episodeRefs.set(key,e);
    const detail=[thumbs?e.show.title:date(e.publishedAt),minutes(e.duration),p?.played?'Played':p?.position>0?'Resume '+clock(p.position):'',stored?'Downloaded':'',downloads.has(key)?'Downloading…':''].filter(Boolean).join(' · ');
    return `<article class="episode-row${current && keyOf(current)===key?' playing':''}${p?.played?' played':''}" data-episode="${esc(key)}">${thumbs?art(e.artwork || e.show.artwork,'episode-thumb'):''}<button class="episode-copy" data-details="${esc(key)}"><strong>${esc(e.title)}</strong><small>${esc(detail)}</small>${!thumbs&&e.description?`<span class="episode-description">${esc(e.description)}</span>`:''}</button><button class="episode-play" data-play="${esc(key)}" aria-label="Play ${esc(e.title)}">${icon(current && keyOf(current)===key && !audio.paused ? 'pause':'play')}</button><button class="icon-button" data-options="${esc(key)}" aria-label="Options for ${esc(e.title)}">${icon('more')}</button></article>`;
  }).join('')}</div>`;
}
const empty = (title,body) => `<div class="empty-state"><h2>${esc(title)}</h2><p>${esc(body)}</p></div>`;
function setNav() { document.querySelectorAll('[data-view]').forEach(a=>{const active=a.dataset.view===view||(view==='show'&&a.dataset.view==='library'&&state.follows.some(s=>s.feedUrl===feedData?.show.feedUrl));if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}); }
function setRoute(hash) { if(location.hash===hash)renderRoute();else location.hash=hash; }
async function renderRoute() {
  requestController?.abort();requestController=new AbortController();const token=++renderToken;const signal=requestController.signal;
  const params=new URLSearchParams(location.hash.slice(1)), raw=location.hash.slice(1), showURL=params.get('show'), query=params.get('search');
  view=showURL?'show':query!==null?'search':['library','downloads','queue'].includes(raw)?raw:'discover';
  $('heading').textContent=({discover:'Discover',search:'Search',show:'Episodes',library:'Your library',downloads:'Downloads',queue:'Up next'})[view];
  $('search-form').hidden=!['discover','search'].includes(view);$('query').value=query || '';status();setNav();
  const root=$('results');root.innerHTML='';
  try {
    if(view==='discover' || view==='search') {
      const topics=view==='discover'?`<div class="browse-topics" aria-label="Browse topics">${categories.map(([id,name])=>`<button data-category="${id}" aria-pressed="${category===id}">${name}</button>`).join('')}</div>`:'';
      root.innerHTML=topics;status('Finding shows…');
      const result=await searchDirectory(view==='search'?'search':'browse',view==='search'?{q:query,country:state.country}:{category,country:state.country},signal);
      if(token!==renderToken)return;status();root.innerHTML=topics+(result.shows.length?showTiles(result.shows):empty('No shows found','Try a show title, host, or a broader topic. You can also add an RSS feed with the + button.'));return;
    }
    if(view==='show') {
      status('Opening the podcast…');feedData=await feed(showURL,{signal});if(token!==renderToken)return;
      const directory=showRefs.get(showURL) || state.follows.find(s=>s.feedUrl===showURL);feedData.show={...directory,...feedData.show};
      status(feedData.stale?'Showing saved episodes. Refresh when you’re online.':'');renderShow();setNav();return;
    }
    renderLocal();
  } catch(e) {if(token!==renderToken || e.name==='AbortError')return;status(e.message,true);root.innerHTML=empty('Couldn’t load podcasts',navigator.onLine?'Try again, or open one of your downloaded episodes.':'You’re offline. Your downloaded episodes are ready in Downloads.')+'<button class="secondary" data-retry>Try again</button>';}
}
function renderShow() {
  const {show,episodes}=feedData;const followed=state.follows.some(s=>s.feedUrl===show.feedUrl);
  $('results').innerHTML=`<button class="show-back" id="show-back">${icon('back')}Back to browsing</button><section class="show-header">${art(show.artwork)}<div><h2>${esc(show.title)}</h2><p>${esc(show.author)}</p><button id="follow-show" class="${followed?'secondary':'primary'}" aria-pressed="${followed}">${followed?'Following':'Follow show'}</button></div></section>${show.description?`<details class="show-description"><summary>About this show</summary>${esc(show.description)}</details>`:''}<div class="show-links">${safeURL(show.directoryUrl)?`<a href="${esc(show.directoryUrl)}" target="_blank" rel="noopener">Apple Podcasts</a>`:''}${safeURL(show.website)?`<a href="${esc(show.website)}" target="_blank" rel="noopener">Show website</a>`:''}</div><div class="section-title"><h2>Episodes</h2><span id="episode-count">${episodes.length}${feedData.nextOffset!=null?'+':''}</span></div><div class="episode-filter"><label class="sr-only" for="episode-query">Search this show’s episodes</label><input id="episode-query" type="search" placeholder="Search loaded episodes"><label class="sr-only" for="episode-sort">Episode order</label><select id="episode-sort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="unplayed">Unplayed</option></select></div><div id="episodes"></div><button id="more-episodes" class="secondary" hidden>Show more episodes</button>`;
  $('show-back').onclick=()=>setRoute('#discover');$('follow-show').onclick=()=>{toggleFollow(show);$('follow-show').textContent=state.follows.some(s=>s.feedUrl===show.feedUrl)?'Following':'Follow show';$('follow-show').setAttribute('aria-pressed',String(state.follows.some(s=>s.feedUrl===show.feedUrl)));};
  let count=40;
  const paint=()=>{let list=episodes.map(e=>episode(e,show)).filter(e=>(e.title+' '+e.description).toLowerCase().includes($('episode-query').value.toLowerCase()));
    const sort=$('episode-sort').value;if(sort==='unplayed')list=list.filter(e=>!state.progress[keyOf(e)]?.played);
    list.sort((a,b)=>(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0));if(sort==='oldest')list.reverse();
    $('episodes').innerHTML=list.length?rows(list.slice(0,count)):empty('No episodes here',episodes.length?'Try another filter.':'The publisher’s feed has no playable audio episodes.');$('more-episodes').hidden=list.length<=count&&feedData.nextOffset==null;};
  $('episode-query').oninput=()=>{count=40;paint();};$('episode-sort').onchange=()=>{count=40;paint();};
  $('more-episodes').onclick=async()=>{const button=$('more-episodes'),token=renderToken;
    if(feedData.nextOffset!=null){button.disabled=true;button.textContent='Loading more episodes…';try{const page=await api('feed',{url:show.feedUrl,offset:feedData.nextOffset});if(token!==renderToken)return;const ids=new Set(episodes.map(e=>e.id));episodes.push(...page.episodes.filter(e=>!ids.has(e.id)));feedData.nextOffset=page.nextOffset;feeds.set(show.feedUrl,feedData);saveFeed(feedData).catch(()=>{});$('episode-count').textContent=episodes.length+(feedData.nextOffset!=null?'+':'');}catch(e){notify(e.message);}finally{if(token===renderToken){button.disabled=false;button.textContent='Show more episodes';}}}
    if(token!==renderToken)return;count+=40;paint();};paint();
}
function renderLocal() {
  const root=$('results');
  if(view==='library') {
    const recent=Object.values(state.progress).filter(p=>!p.played&&p.position>0).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,3).map(p=>p.episode);
    root.innerHTML=(recent.length?`<div class="section-title"><h2>Keep listening</h2></div>${rows(recent,{thumbs:true})}`:'')+'<div class="section-title"><h2>Followed shows</h2><span>'+state.follows.length+'</span></div>'+(state.follows.length?showTiles(state.follows):empty('Make this your library','Follow a show to keep it here. Your progress, queue, and follows are saved on this device.'));
    if(state.follows.length)root.innerHTML+='<button class="secondary" id="latest-episodes">Latest from your shows</button><div id="latest-results"></div>';
    $('latest-episodes')?.addEventListener('click',loadLatest);
  } else if(view==='downloads') {
    const records=Object.values(state.downloads).sort((a,b)=>b.downloadedAt-a.downloadedAt), pending=[...downloads.values()].map(d=>d.episode);
    root.innerHTML=`<p class="download-meta">${records.length} episodes · ${size(records.reduce((n,d)=>n+d.bytes,0))} on this device</p>`+(pending.length?rows(pending,{thumbs:true}):'')+(records.length?rows(records.map(d=>d.episode),{thumbs:true}):pending.length?'':empty('Take an episode with you','Open an episode’s menu and choose Download. Finished downloads play here without internet, including seeking.'));
  } else {
    root.innerHTML=(state.queue.length?`<p class="download-meta">${state.queue.length} episodes · ${state.autoplay?'Plays automatically':'Autoplay off'}</p>${rows(state.queue,{thumbs:true,queue:true})}`:empty('Your next listen','Add episodes to the queue from their menu. They play in order when the current episode finishes.'));
  }
}
async function loadLatest(e) {
  const b=e.target;b.disabled=true;b.textContent='Checking your shows…';const token=renderToken,list=[];let failed=0;
  // Sequential feeds avoid a large fan-out on mobile and the free Worker.
  for(const show of state.follows.slice(0,20)) {
    if(token!==renderToken)return;
    try{const data=await feed(show.feedUrl);list.push(...data.episodes.slice(0,3).map(ep=>episode(ep,{...show,...data.show})));}catch{failed++;}
  }
  if(token!==renderToken)return;list.sort((a,b)=>(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0));
  $('latest-results').innerHTML=rows(list.slice(0,40),{thumbs:true});b.disabled=false;b.textContent='Refresh latest episodes';if(failed)notify(failed+' shows could not refresh.');
}
function toggleFollow(show) {const i=state.follows.findIndex(s=>s.feedUrl===show.feedUrl);if(i<0){if(state.follows.length>=100){notify('Your library has reached 100 shows. Unfollow one first.');return;}state.follows.push(normalizedShow(show));notify('Added to your library');}else{state.follows.splice(i,1);notify('Show unfollowed');}commit();setNav();}

function episodeMenu(e) {
  const key=keyOf(e), queued=state.queue.some(x=>keyOf(x)===key), downloaded=!!state.downloads[key], downloading=downloads.has(key);
  const actions=[{label:'Play episode',icon:'play',action:()=>playEpisode(e)},
    {label:queued?'Remove from queue':'Add to queue',icon:'queue',action:()=>{if(queued)state.queue=nextQueued(state.queue,e);else if(state.queue.length<100)state.queue.push(e);else{notify('Queue is full. Remove an episode first.');return;}commit();notify(queued?'Removed from queue':'Added to queue');repaintLocal();}},
    {label:downloading?'Cancel download':downloaded?'Remove download':'Download for offline listening',icon:downloaded?'trash':'download',action:()=>downloading?downloads.get(key).controller.abort():downloaded?removeDownload(e):downloadEpisode(e)},
    {label:state.progress[key]?.played?'Mark unplayed':'Mark played',icon:'check',action:()=>{const played=!state.progress[key]?.played;state.progress[key]=progressEntry(e,0,e.duration,played);commit();notify(played?'Marked played':'Marked unplayed');repaintLocal();}}];
  if(view==='queue' && queued)actions.push({label:'Move to top of queue',icon:'up',action:()=>{state.queue=[e,...nextQueued(state.queue,e)];commit();renderLocal();}});
  if(view!=='show')actions.push({label:'Open show',icon:'podcast',action:()=>{showRefs.set(e.show.feedUrl,e.show);setRoute('#show='+encodeURIComponent(e.show.feedUrl));}});
  if(safeURL(e.audioUrl))actions.push({label:'Open original audio',icon:'link',action:()=>window.open(safeURL(e.audioUrl),'_blank','noopener')});
  sheet(e.title,actions);
}
function repaintLocal() {if(['library','downloads','queue'].includes(view))renderLocal();else if(view==='show')document.querySelectorAll('[data-episode]').forEach(row=>{const key=row.dataset.episode;row.classList.toggle('played',!!state.progress[key]?.played);const small=row.querySelector('small');if(state.downloads[key]&&!small.textContent.includes('Downloaded'))small.textContent+=' · Downloaded';});}
function episodeDetails(e) {current===e?openPlayer():formDetails(e);}
function formDetails(e) {
  const d=$('sheet');d.innerHTML=`<div class="dialog-heading"><h2 id="sheet-heading">Episode</h2><button class="close" aria-label="Close episode">×</button></div><h3>${esc(e.title)}</h3><p>${esc(e.show.title)} · ${esc(minutes(e.duration))}</p><button class="primary" id="details-play">${icon('play')}Play episode</button><button class="text-button" id="details-options">More options</button><div class="episode-notes">${esc(e.description || 'No episode notes provided.')}</div>`;
  d.querySelector('.close').onclick=closeSheet;$('details-play').onclick=()=>{closeSheet();playEpisode(e);};$('details-options').onclick=()=>episodeMenu(e);if(!d.open)d.showModal();
}
document.addEventListener('click',e=>{
  const node=e.target.closest('[data-feed],[data-play],[data-options],[data-details],[data-category],[data-retry]');if(!node)return;
  if(node.dataset.feed)setRoute('#show='+encodeURIComponent(node.dataset.feed));
  else if(node.dataset.play){const ep=episodeRefs.get(node.dataset.play);if(ep)playEpisode(ep);}
  else if(node.dataset.options){const ep=episodeRefs.get(node.dataset.options);if(ep)episodeMenu(ep);}
  else if(node.dataset.details){const ep=episodeRefs.get(node.dataset.details);if(ep)episodeDetails(ep);}
  else if(node.dataset.category){category=node.dataset.category;renderRoute();}
  else if(node.hasAttribute('data-retry'))renderRoute();
});
$('search-form').onsubmit=e=>{e.preventDefault();const q=$('query').value.trim();if(q.length<2){notify('Enter at least two characters to search.');return;}setRoute('#search='+encodeURIComponent(q));};
$('refresh').onclick=()=>{if(view==='show'&&feedData){feeds.delete(feedData.show.feedUrl);}renderRoute();};
$('add-feed').onclick=()=>formSheet('Add RSS feed','<label for="feed-url">Podcast RSS address</label><input id="feed-url" name="url" type="url" placeholder="https://…" required><p>Paste the show’s public RSS feed. Private feeds with passwords are not supported.</p>',data=>{const url=safeURL(data.get('url'));if(!url)throw Error('Enter an http or https RSS feed URL.');closeSheet();setRoute('#show='+encodeURIComponent(url));});
$('settings').onclick=async()=>{
  const estimate=await navigator.storage?.estimate().catch(()=>null);
  formSheet('Podcast settings',`<label for="country">Podcast directory</label><select id="country" name="country"><option value="us" ${state.country==='us'?'selected':''}>United States</option><option value="ar" ${state.country==='ar'?'selected':''}>Argentina</option><option value="gb" ${state.country==='gb'?'selected':''}>United Kingdom</option><option value="es" ${state.country==='es'?'selected':''}>Spain</option></select><label class="check-row"><input type="checkbox" name="autoplay" ${state.autoplay?'checked':''}>Play the next queued episode</label><p>Follows, progress, queue, and downloads stay on this device. Downloads use browser storage; keep this page open until they finish.</p>${estimate?`<p class="storage-info">${size(estimate.usage)} used of ${size(estimate.quota)} browser storage.</p>`:''}`,data=>{state.country=data.get('country');state.autoplay=data.has('autoplay');commit();closeSheet();renderRoute();});
};

const audioURL = e => {const u=new URL('/podcasts/audio',API_ORIGIN);u.searchParams.set('feed',e.show.feedUrl);u.searchParams.set('id',e.id);return u.href;};
async function cachedAudio(e) { if(!('caches' in window))return null;return (await caches.open(AUDIO_CACHE)).match(new URL(offlinePath(e),location.origin).href); }
async function downloadEpisode(e) {
  const key=keyOf(e);if(downloads.has(key))return;
  if(!('caches' in window) || !('serviceWorker' in navigator)){notify('Offline downloads require a browser that supports offline storage.');return;}
  if(state.downloads[key]){notify('Episode is already downloaded.');return;}
  if(e.bytes>MAX_DOWNLOAD){notify('This episode exceeds the 250 MB download limit. You can still stream it.');return;}
  const controller=new AbortController();downloads.set(key,{controller,episode:e});notify('Downloading '+e.title);repaintLocal();
  let saved=false;
  try {
    await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Offline storage could not start. Reload this page and try again.')),10000))]);await navigator.storage?.persist?.().catch(()=>false);
    const r=await fetch(audioURL(e),{signal:controller.signal});
    if(!r.ok){let data;try{data=await r.json();}catch{}throw Error(data?.error || 'The episode could not download.');}
    if(Number(r.headers.get('Content-Length'))>MAX_DOWNLOAD){await r.body?.cancel();throw Error('This episode exceeds the 250 MB download limit.');}
    const estimate=await navigator.storage?.estimate().catch(()=>null),expected=Number(r.headers.get('Content-Length'))||e.bytes;
    if(estimate && expected>0 && estimate.quota-estimate.usage<expected+8*1024*1024){await r.body?.cancel();throw Error('Not enough device storage. Remove a download first.');}
    let bytes=0;
    const stream=r.body.pipeThrough(new TransformStream({transform(chunk,ctrl){bytes+=chunk.length;if(bytes>MAX_DOWNLOAD){ctrl.error(Error('This episode exceeds the 250 MB download limit.'));controller.abort();return;}ctrl.enqueue(chunk);}}));
    const cache=await caches.open(AUDIO_CACHE),url=new URL(offlinePath(e),location.origin).href;
    await cache.put(url,new Response(stream,{headers:{'Content-Type':r.headers.get('Content-Type')||e.type||'audio/mpeg','Accept-Ranges':'bytes'}}));
    if(controller.signal.aborted){await cache.delete(url);throw new DOMException('Cancelled','AbortError');}
    state.downloads[key]={episode:e,bytes,downloadedAt:Date.now()};saved=commit();
    if(!saved){delete state.downloads[key];await cache.delete(url);throw Error('Could not save the download. Free up some browser storage.');}
    notify('Downloaded · '+size(bytes));
  } catch(err) {notify(controller.signal.aborted?'Download cancelled':err.name==='QuotaExceededError'?'Device storage is full. Remove a download first.':err.message || 'Download failed. Please try again.');}
  finally{downloads.delete(key);repaintLocal();updateDownloadButton();}
}
async function removeDownload(e) {await (await caches.open(AUDIO_CACHE)).delete(new URL(offlinePath(e),location.origin).href);delete state.downloads[keyOf(e)];commit();notify('Download removed');repaintLocal();updateDownloadButton();}
async function reconcileDownloads() {
  if(!('caches' in window))return;
  const cache=await caches.open(AUDIO_CACHE);let changed=false;
  for(const [key,d] of Object.entries(state.downloads))if(!await cache.match(new URL(offlinePath(d.episode),location.origin).href)){delete state.downloads[key];changed=true;}
  if(changed){commit();repaintLocal();notify('Some downloads were cleared by the browser. Download them again when online.');}
}

function saveProgress(played=audio.ended) {if(!current)return;const key=keyOf(current);state.progress[key]=progressEntry(current,audio.currentTime,audio.duration,played);state.current=current;commit();lastSaved=Date.now();}
function setPlayIcons() {
  const playing=!audio.paused&&!audio.ended,name=playing?'pause':'play';for(const id of ['play','mini-play']){$(id).innerHTML=icon(name);$(id).setAttribute('aria-label',playing?'Pause episode':'Play episode');}
  document.querySelectorAll('[data-play]').forEach(b=>{b.innerHTML=icon(playing&&current&&b.dataset.play===keyOf(current)?'pause':'play');});
}
function updateDownloadButton() {if(!current)return;const key=keyOf(current);$('player-download').innerHTML=icon(state.downloads[key]?'check':'download');$('player-download').setAttribute('aria-label',state.downloads[key]?'Episode downloaded':'Download episode');}
function updateCurrent() {
  if(!current)return;$('mini-player').hidden=false;document.title=current.title+' · Podcasts';
  for(const id of ['mini-art','player-art'])$(id).src=safeURL(current.artwork||current.show.artwork)||placeholder;
  $('mini-title').textContent=current.title;$('player-title').textContent=current.title;$('mini-show').textContent=current.show.title;$('player-show').textContent=current.show.title;$('player-notes').textContent=current.description || 'No episode notes provided.';
  $('speed').textContent=state.speed+'× speed';updateDownloadButton();setPlayIcons();
}
function updatePosition() {
  const duration=Number.isFinite(audio.duration)&&audio.duration>0?audio.duration:current?.duration || 0, pos=loadedKey?audio.currentTime:resumePosition(state.progress[current?keyOf(current):''],duration);
  if(!seeking)for(const id of ['seek','mini-seek']){$(id).max=String(duration || 100);$(id).value=String(pos);$(id).disabled=!loadedKey || !duration;}
  $('elapsed').textContent=clock(pos);$('remaining').textContent='−'+clock(Math.max(0,duration-pos));
  if(timer){$('sleep-label').textContent=timer.endOfEpisode?'End of episode':clock(Math.max(0,(timer.deadline-Date.now())/1000));if(shouldSleep(timer,Date.now()))stopForSleep();}
}
async function playEpisode(e) {
  if(current&&keyOf(current)===keyOf(e)&&loadedKey===keyOf(e)){togglePlay();return;}
  const token=++loadToken;if(current&&loadedKey)saveProgress();audio.pause();audio.removeAttribute('src');audio.load();loadedKey='';wantPlay=true;
  current=e;state.current=e;state.queue=nextQueued(state.queue,e);commit();updateCurrent();playbackStatus('Opening audio…');
  if(currentBlob){URL.revokeObjectURL(currentBlob);currentBlob=null;}
  try {
    const cached=await cachedAudio(e);if(token!==loadToken)return;
    let url=audioURL(e);
    if(cached) {if(navigator.serviceWorker.controller)url=offlinePath(e);else{currentBlob=URL.createObjectURL(await cached.blob());url=currentBlob;}}
    else if(!navigator.onLine)throw Error('This episode isn’t downloaded. Connect to the internet to play it.');
    if(token!==loadToken)return;loadedKey=keyOf(e);audio.src=url;audio.playbackRate=state.speed;audio.load();
    const start=resumePosition(state.progress[keyOf(e)],e.duration);if(start>0)audio.currentTime=start;
    await audio.play();if(token!==loadToken)return;playbackStatus();repaintLocal();
  } catch(err) {if(token!==loadToken)return;wantPlay=false;playbackStatus(err.name==='NotAllowedError'?'Tap Play to start audio.':err.message || 'Could not play this episode.',true);notify($('playback-status').textContent);setPlayIcons();}
}
async function togglePlay() {
  if(!current)return;
  if(!loadedKey){await playEpisode(current);return;}
  if(audio.paused){wantPlay=true;try{await audio.play();}catch{playbackStatus('Audio could not start. Try opening this episode again.',true);}}else{wantPlay=false;audio.pause();saveProgress();}setPlayIcons();
}
function openPlayer() {if(!current)return;updateCurrent();updatePosition();if(!$('player').open)$('player').showModal();}
const skip = n => {if(!loadedKey)return;audio.currentTime=Math.max(0,Math.min(Number.isFinite(audio.duration)?audio.duration:Infinity,audio.currentTime+n));updatePosition();saveProgress();};
$('open-player').onclick=openPlayer;$('close-player').onclick=()=>$('player').close();
for(const id of ['play','mini-play'])$(id).onclick=togglePlay;
$('mini-back').onclick=$('back-15').onclick=()=>skip(-15);$('forward-30').onclick=()=>skip(30);
for(const id of ['seek','mini-seek']) {
  const input=$(id);input.addEventListener('pointerdown',()=>seeking=true);
  input.oninput=()=>{seeking=true;$('elapsed').textContent=clock(Number(input.value));};
  input.onchange=()=>{if(loadedKey)audio.currentTime=Number(input.value);seeking=false;updatePosition();saveProgress();};
  input.addEventListener('pointercancel',()=>{seeking=false;updatePosition();});input.addEventListener('blur',()=>seeking=false);
}
$('speed').onclick=()=>sheet('Playback speed',[0.75,1,1.25,1.5,1.75,2,2.5].map(speed=>({label:speed+'×'+(state.speed===speed?' · Selected':''),icon:state.speed===speed?'check':'play',action:()=>{state.speed=speed;audio.playbackRate=speed;audio.preservesPitch=true;commit();$('speed').textContent=speed+'× speed';}})));
function stopForSleep() {timer=null;wantPlay=false;audio.pause();$('sleep-label').textContent='Sleep timer';saveProgress(audio.ended);notify('Sleep timer finished');}
$('sleep').onclick=()=>sheet('Sleep timer',[
  ...[15,30,45,60,90].map(n=>({label:n+' minutes',icon:'moon',action:()=>{timer={deadline:Date.now()+n*60000};updatePosition();notify('Playback stops in '+n+' minutes');}})),
  {label:'End of this episode',icon:'moon',action:()=>{timer={endOfEpisode:true};updatePosition();notify('Playback stops at the end of this episode');}},
  {label:'Set a custom time',icon:'moon',action:()=>formSheet('Custom sleep timer','<label for="sleep-minutes">Minutes</label><input id="sleep-minutes" name="minutes" type="number" min="1" max="720" value="20" required>',data=>{const n=Number(data.get('minutes'));if(!Number.isFinite(n)||n<1||n>720)throw Error('Choose 1–720 minutes.');timer={deadline:Date.now()+n*60000};closeSheet();updatePosition();})},
  {label:'Turn off timer',icon:'trash',action:()=>{timer=null;$('sleep-label').textContent='Sleep timer';notify('Sleep timer off');}}
]);
$('player-download').onclick=()=>current&&downloadEpisode(current);$('player-menu').onclick=()=>current&&episodeMenu(current);
audio.addEventListener('loadedmetadata',()=>{audio.playbackRate=state.speed;const start=resumePosition(state.progress[current?keyOf(current):''],audio.duration);if(start>0&&audio.currentTime<1)audio.currentTime=start;updatePosition();updateMediaSession();});
audio.addEventListener('timeupdate',()=>{updatePosition();updateMediaPosition();if(Date.now()-lastSaved>10000)saveProgress();});
audio.addEventListener('play',()=>{wantPlay=true;setPlayIcons();updateMediaSession();});
audio.addEventListener('playing',()=>playbackStatus());
audio.addEventListener('pause',()=>{setPlayIcons();if(loadedKey)saveProgress(audio.ended);updateMediaSession();});
audio.addEventListener('waiting',()=>{if(wantPlay)playbackStatus('Buffering…');});
audio.addEventListener('error',()=>{if(!loadedKey)return;wantPlay=false;playbackStatus('This episode could not load. Try again or use Open original audio in its menu.',true);notify('Episode unavailable. Open its menu to retry or use the original audio.');loadedKey='';setPlayIcons();});
audio.addEventListener('ended',()=>{
  saveProgress(true);const sleep=shouldSleep(timer,Date.now(),true);if(sleep){stopForSleep();return;}
  if(state.autoplay&&state.queue.length)playEpisode(state.queue[0]);else{wantPlay=false;setPlayIcons();repaintLocal();}
});
function updateMediaPosition() {if(!navigator.mediaSession || !Number.isFinite(audio.duration) || !audio.duration)return;try{navigator.mediaSession.setPositionState({duration:audio.duration,playbackRate:audio.playbackRate,position:Math.min(audio.currentTime,audio.duration)});}catch{}}
function updateMediaSession() {
  if(!navigator.mediaSession||!current)return;
  const artwork=safeURL(current.artwork||current.show.artwork);
  navigator.mediaSession.metadata=new MediaMetadata({title:current.title,artist:current.show.title,album:'Podcasts',artwork:artwork?[{src:artwork}]:[]});
  navigator.mediaSession.playbackState=audio.paused?'paused':'playing';updateMediaPosition();
}
if(navigator.mediaSession)for(const [action,fn] of Object.entries({play:()=>audio.paused&&togglePlay(),pause:()=>!audio.paused&&togglePlay(),seekbackward:d=>skip(-(d.seekOffset||15)),seekforward:d=>skip(d.seekOffset||30),seekto:d=>{audio.currentTime=d.seekTime;updatePosition();saveProgress();},nexttrack:()=>state.queue.length&&playEpisode(state.queue[0])}))try{navigator.mediaSession.setActionHandler(action,fn);}catch{}
setInterval(()=>{if(timer)updatePosition();},1000);
addEventListener('visibilitychange',()=>{if(document.hidden&&loadedKey)saveProgress();if(!document.hidden)updatePosition();});
addEventListener('pagehide',()=>{if(loadedKey)saveProgress();});
addEventListener('hashchange',renderRoute);
addEventListener('offline',()=>notify('You’re offline. Downloaded episodes still play.'));
if('serviceWorker' in navigator)navigator.serviceWorker.register('/podcasts/sw.js',{scope:'/podcasts/',type:'module'}).catch(()=>notify('Offline mode could not start. Streaming still works.'));
if(current){updateCurrent();updatePosition();}
renderRoute();reconcileDownloads().catch(()=>{});
