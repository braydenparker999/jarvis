import {icon, sheet, readLocal, writeLocal, el, copyText} from '../assets/ui.js';
import '../assets/pip-diagnostics.js?v=0.37.1';
import {discover, withinTime} from './discovery.js';
import {createVideoApi, folderId, mediaURL, thumbnails, parseLibrary, parseProgress, recordProgress, resumeTime,
  continueWatching, searchVideos, groupByFolder, formatDuration, srtToVtt,
  PROGRESS_KEY, LIBRARY_KEY} from './library.js';
import {play} from './player.js';
import {knownCreators, videoPresentation, sortDisplayedVideos} from './presentation.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } };
const SORT_KEY = 'mymedia.sort.v1', SPEED_KEY = 'mymedia.speed.v1', OPEN_FOLDERS_KEY = 'mymedia.open-folders.v1';

let key = '', folder = '', api = null, loading = false;
let library = parseLibrary(read(LIBRARY_KEY));
let creatorNames = knownCreators(library);
let progress = parseProgress(read(PROGRESS_KEY));
let query = '', sort = read(SORT_KEY) || 'newest';
let current = null, libraryScroll = 0, depth = 0, ready = false;
let view='explore', collection='', browseKind='', minutes=0, onlyUnwatched=false, pageLimit=60;
const savedRaw=readLocal('mymedia.saved.v1',[]),queueRaw=readLocal('mymedia.queue.v1',[]);
let saved=new Set(Array.isArray(savedRaw)?savedRaw:[]), queue=Array.isArray(queueRaw)?queueRaw:[];
document.querySelectorAll('[data-icon]').forEach(n=>n.innerHTML=icon(n.dataset.icon));
let openFolders = (() => {
  try {
    const paths = JSON.parse(read(OPEN_FOLDERS_KEY) || '[]');
    return new Set(Array.isArray(paths) ? paths.filter(path => typeof path === 'string') : []);
  } catch { return new Set(); }
})();

function status(text, error = false, el = $('status')) {
  el.hidden = !text; el.textContent = text; el.classList.toggle('error', error);
}
function saveProgress() {
  if (!write(PROGRESS_KEY, JSON.stringify(progress))) status('This browser could not save your place in videos.', true);
}

/* ---- library ---------------------------------------------------------- */

function card(video) {
  const display = videoPresentation(video, creatorNames);
  const p = progress[video.id], duration = video.duration || p?.d || 0;
  const images = thumbnails(video, key);
  const percent = p && !p.done && duration ? Math.min(100, p.t / duration * 100) : 0;
  const left = resumeTime(p) && duration ? formatDuration(duration - p.t) + ' left' : '';
  const added = video.addedAt || video.modified;
  const date = added ? (video.addedAt ? 'Added ' : 'Updated ') + new Date(added).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'}) : '';
  const detail = p?.done ? '<span class="watched-mark">✓ Watched</span>' : esc(left || date);
  const creator = display.creator || (display.collection ? display.collection + ' collection' : '');
  return `<div class="video-tile"><a class="video-card" href="#v=${esc(video.id)}"><div class="thumb">` +
    `<span class="placeholder" aria-hidden="true">▶</span>` +
    (images.length ? `<img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${esc(images[0])}" data-fallbacks="${esc(JSON.stringify(images.slice(1)))}">` : '') +
    (duration ? `<span class="length">${formatDuration(duration)}</span>` : '') +
    (percent ? `<span class="bar"><span data-progress="${percent.toFixed(1)}"></span></span>` : '') +
    `</div><span class="card-text"><strong>${esc(display.title)}</strong>${creator ? `<small class="card-creator">${esc(creator)}</small>` : ''}${detail ? `<small class="card-status">${detail}</small>` : ''}</span></a><button class="video-menu" type="button" data-video-menu="${esc(video.id)}" aria-label="Actions for ${esc(video.title)}">${icon('more')}</button></div>`;
}

// Thumbnail candidates fall through in order; the placeholder shows if all fail.
document.addEventListener('error', event => {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallbacks) return;
  const rest = JSON.parse(img.dataset.fallbacks);
  if (rest.length) { img.dataset.fallbacks = JSON.stringify(rest.slice(1)); img.src = rest[0]; }
  else img.remove();
}, true);

// Widths are set through CSSOM: the page's CSP does not allow inline style attributes.
function paintBars(root) {
  root.querySelectorAll('[data-progress]').forEach(el => { el.style.width = el.dataset.progress + '%'; });
}

function renderLibrary() {
  creatorNames = knownCreators(library);
  renderShelves();
  paintBars($('library-view'));
}
function filteredVideos(){let videos=library?.videos||[];if(view==='saved')videos=videos.filter(v=>saved.has(v.id));if(collection)videos=videos.filter(v=>v.folder===collection||videoPresentation(v,creatorNames).creator===collection);if(onlyUnwatched||browseKind==='unwatched')videos=videos.filter(v=>!progress[v.id]?.done);videos=withinTime(videos,minutes|| (browseKind==='quick'?20:0));return sortDisplayedVideos(searchVideos(videos,query),sort,creatorNames);}
function renderShelves(){
  $('continue').hidden=true;$('folder-actions').hidden=true;$('load-more').hidden=true;
  $('media-nav').hidden=!!current;
  for(const tab of document.querySelectorAll('[data-view]')){if(tab.dataset.view===view)tab.setAttribute('aria-current','page');else tab.removeAttribute('aria-current');}
  $('view-title').textContent=collection?collection.split('/').at(-1):browseKind==='fresh'?'Fresh additions':browseKind==='quick'?'Quick watches':browseKind==='unwatched'?'Worth exploring':view==='explore'?'Explore':view==='saved'?'Saved':'Library';
  $('browse-all').hidden=!collection&&!browseKind;
  $('all-videos').setAttribute('aria-pressed',String(!collection&&!browseKind&&!minutes&&!onlyUnwatched));
  const presentCreators=new Set((library?.videos||[]).map(v=>videoPresentation(v,creatorNames).creator).filter(Boolean));
  const names=creatorNames.filter(name=>presentCreators.has(name));
  const chips=names.length?names.map(name=>({label:name,value:name})):groupByFolder(library?.videos||[],library?.name||'').filter(g=>g.path!==library?.name).map(g=>({label:g.label,value:g.path}));
  $('creator-filters').innerHTML=chips.map(c=>`<button type="button" data-collection-filter="${esc(c.value)}" aria-pressed="${collection===c.value}">${esc(c.label)}</button>`).join('');
  $('time-filter').textContent=minutes?'Under '+minutes+' min':'Any length';$('time-filter').setAttribute('aria-pressed',String(minutes>0));$('unwatched-filter').setAttribute('aria-pressed',String(onlyUnwatched));
  if(!library){$('sections').innerHTML='<div class="media-empty"><h2>Your library is loading</h2><p>Your collections will appear here.</p></div>';return;}
  const videos=filteredVideos(),focused=query||collection||browseKind||minutes||onlyUnwatched||view==='saved';
  if(focused){
    const items=browseKind==='unwatched'?discover(videos,progress,videos.length):videos;
    $('sections').innerHTML=items.length?`<p class="browse-count">${items.length} video${items.length===1?'':'s'}</p><div class="video-grid">${items.slice(0,pageLimit).map(card).join('')}</div>`:`<div class="media-empty"><h2>${view==='saved'?'Save something for later':'No matching videos'}</h2><p>${view==='saved'?'Use a video’s menu to add it here.':'Try a different filter or search.'}</p></div>`;
    $('load-more').hidden=items.length<=pageLimit;return;
  }
  const groups=groupByFolder(videos,library.name);
  if(view==='library'){
    $('folder-actions').hidden=!groups.length;$('folder-count').textContent=groups.length+' collections';
    $('sections').innerHTML=groups.map(g=>`<details class="folder-shelf" data-folder="${esc(g.path)}"${openFolders.has(g.path)?' open':''}><summary class="folder-summary"><span class="folder-icon">${icon('library')}</span><span class="folder-name">${esc(g.label)}</span><span class="folder-total">${g.items.length}</span><span class="folder-chevron">⌄</span></summary><div class="video-grid folder-grid">${openFolders.has(g.path)?g.items.slice(0,60).map(card).join(''):''}</div><a class="text-button" href="#collection=${encodeURIComponent(g.path)}">Browse collection</a></details>`).join('');updateFolderToggle(groups);return;
  }
  if(!videos.length){$('sections').innerHTML='<div class="media-empty"><h2>Your collection starts here</h2><p>Add videos to your shared folder, then refresh.</p></div>';return;}
  $('sections').innerHTML=`<section class="shelf feed-shelf" aria-label="Your videos"><div class="video-grid feed-grid">${videos.slice(0,pageLimit).map(card).join('')}</div></section>`;
  $('load-more').hidden=videos.length<=pageLimit;
  const resume=continueWatching(library.videos,progress,3);$('continue').hidden=!resume.length;$('continue-grid').innerHTML=resume.map(card).join('');
}
function persistSaved(){if(!writeLocal('mymedia.saved.v1',[...saved]))status('Could not save your list on this device.',true);}
function persistQueue(){if(!writeLocal('mymedia.queue.v1',queue))status('Could not save your queue on this device.',true);if(current)renderNext(current.video);}
function videoMenu(id){const item=library?.videos.find(v=>v.id===id);if(!item)return;sheet(item.title,[
  {label:resumeTime(progress[id])?'Resume video':'Play video',icon:'play',action:()=>{location.hash='v='+id;}},
  {label:saved.has(id)?'Remove from Saved':'Save for later',icon:'bookmark',action:()=>{saved.has(id)?saved.delete(id):saved.add(id);persistSaved();if(current?.video.id===id)$('save-video').textContent=saved.has(id)?'Saved':'Save for later';renderLibrary();}},
  {label:queue.includes(id)?'Remove from queue':'Add to queue',icon:'plus',action:()=>{queue.includes(id)?queue=queue.filter(x=>x!==id):queue.push(id);persistQueue();}},
  {label:progress[id]?.done?'Mark unwatched':'Mark watched',icon:'check',action:()=>{progress[id]={...(progress[id]||{}),done:!progress[id]?.done,at:Date.now()};saveProgress();renderLibrary();if(current?.video.id===id)paintWatched();}},
  {label:'Browse this collection',icon:'library',action:()=>{location.hash='collection='+encodeURIComponent(item.folder);}},
  {label:'Video details',icon:'info',action:()=>{const d=sheet(item.title,[]);d.append(el('p',[item.creator||item.folder,item.duration?formatDuration(item.duration):'Duration unavailable',item.height?item.height+'p':''].filter(Boolean).join(' · ')));if(item.description)d.append(el('p',item.description));}}
]);}
function saveOpenFolders() {
  write(OPEN_FOLDERS_KEY, JSON.stringify([...openFolders]));
}
function updateFolderToggle(groups = groupByFolder(sortDisplayedVideos(library?.videos || [], sort,creatorNames), library?.name || '')) {
  const allOpen = groups.length > 0 && groups.every(group => openFolders.has(group.path));
  $('toggle-folders').textContent = allOpen ? 'Close all folders' : 'Open all folders';
  $('toggle-folders').setAttribute('aria-expanded', String(allOpen));
}

function summary() {
  if (!library) return '';
  const count = library.videos.length, when = new Date(library.fetched);
  return `${count} video${count === 1 ? '' : 's'} · updated ${when.toLocaleString(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'})}`;
}

async function refresh() {
  if (!api || loading) return;
  loading = true; $('refresh').disabled = true;
  status(library ? 'Checking Drive for new videos…' : 'Loading your videos…');
  try {
    library = await api.list(folder, AbortSignal.timeout(60000));
    if (!write(LIBRARY_KEY, JSON.stringify(library))) console.warn('My Media: library cache not saved');
    status(summary());
    if(!current)libraryScroll=scrollY;
    renderLibrary();
    route();
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'Drive took too long to answer.' : error?.message || 'Drive could not be read.';
    status(library ? reason + ' Showing the last saved list.' : reason, true);
  } finally {
    loading = false; $('refresh').disabled = false;
  }
}

/* ---- player ----------------------------------------------------------- */

const video = $('video');
const pipDiagnostics = globalThis.JarvisPiPDiagnostics.observe(video);
const pipReport = () => pipDiagnostics.report({app:'mymedia', release:document.querySelector('meta[name="mymedia-release"]')?.content});
let lastSave = 0;

function remember(ended = false) {
  // Some files report an infinite duration; Drive's metadata covers those.
  const duration = Number.isFinite(video.duration) ? video.duration : current?.video.duration;
  if (!current || !duration) return;
  progress[current.video.id] = recordProgress(progress[current.video.id], video.currentTime, duration, ended);
  lastSave = Date.now();
  saveProgress();
  paintWatched();
}
function paintWatched() {
  const done = !!(current && progress[current.video.id]?.done);
  $('watched').setAttribute('aria-pressed', String(done));
  $('watched').textContent = done ? 'Watched ✓' : 'Mark watched';
}

async function loadCaptions(item, signal) {
  const select = $('captions');
  select.hidden = !item.subtitles.length;
  select.innerHTML = '<option value="">Subtitles off</option>' + item.subtitles.map((s, i) => `<option value="${i}">${esc(s.lang)}</option>`).join('');
  for (const [i, sub] of item.subtitles.entries()) {
    try {
      const response = await fetch(mediaURL(sub.id, key), {signal, credentials:'omit', referrerPolicy:'no-referrer'});
      if (!response.ok) continue;
      const text = srtToVtt(await response.text());
      if (signal.aborted) return;
      const url = URL.createObjectURL(new Blob([text], {type:'text/vtt'}));
      current.urls.push(url);
      const track = Object.assign(document.createElement('track'), {kind:'subtitles', label:sub.lang, srclang:sub.lang.slice(0, 2), src:url});
      track.dataset.index = i;
      video.append(track);
    } catch {}
  }
}

function openVideo(item) {
  closeVideo();
  const controller = new AbortController();
  current = {video:item, controller, urls:[], handle:null};
  if(queue.includes(item.id)){queue=queue.filter(id=>id!==item.id);writeLocal('mymedia.queue.v1',queue);}
  $('library-view').hidden = true; $('player-view').hidden = false;
  $('back').innerHTML=icon('back'); $('back').href = '#'; $('back').setAttribute('aria-label', 'Back to library');
  $('refresh').hidden = true;$('search-toggle').hidden=true;$('media-nav').hidden=true;
  $('save-video').textContent=saved.has(item.id)?'Saved':'Save for later';
  document.title = item.title + ' · My Media';
  const display = videoPresentation(item, creatorNames);
  $('video-title').textContent = display.title;
  $('video-creator').textContent = display.creator || (display.collection ? display.collection + ' collection' : '');
  $('video-creator').hidden = !$('video-creator').textContent;
  $('video-description').textContent = item.description || '';
  $('video-details').hidden = !item.description;
  $('video-details').open = false;
  const bits = [item.duration ? formatDuration(item.duration) : '', item.folder, item.height ? item.height + 'p' : '', item.size ? (item.size / 1048576).toFixed(0) + ' MB' : ''];
  $('video-meta').textContent = bits.filter(Boolean).join(' · ');
  status('', false, $('player-status'));
  paintWatched();
  const images = thumbnails(item, key);
  if (images.length) video.poster = images.find(u => u.includes('ytimg')) || '';
  // A new source resets playbackRate to defaultPlaybackRate, so set both.
  video.defaultPlaybackRate = video.playbackRate = Number($('speed').value) || 1;
  current.handle = play(video, mediaURL(item.id, key), {
    startTime:resumeTime(progress[item.id]),
    onError:message => status(message, true, $('player-status')),
    onMode:mode => {
      if (mode === 'compatibility') status('Preparing this file for your browser…', false, $('player-status'));
      else if (mode === 'retrying') status('Drive paused. Retrying this video once…', false, $('player-status'));
      else status('', false, $('player-status'));
    }
  });
  loadCaptions(item, controller.signal);
  renderNext(item);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({title:item.title, artist:display.creator || item.folder, album:'My Media',
      artwork:item.youtubeId ? [{src:'https://i.ytimg.com/vi/' + item.youtubeId + '/hqdefault.jpg', sizes:'480x360', type:'image/jpeg'}] : []});
  }
  window.scrollTo(0, 0);
}

function closeVideo() {
  if (!current) return;
  pipDiagnostics.markOutcome('player-dispose');
  remember();
  current.controller.abort();
  current.handle?.close();
  video.querySelectorAll('track').forEach(t => t.remove());
  current.urls.forEach(u => URL.revokeObjectURL(u));
  video.removeAttribute('poster');
  if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
  current = null;
}

function renderNext(item) {
  const siblings = sortDisplayedVideos(library.videos.filter(v => v.folder === item.folder), sort,creatorNames);
  const at = siblings.findIndex(v => v.id === item.id);
  const next = [...queue.map(id=>library.videos.find(v=>v.id===id)).filter(v=>v&&v.id!==item.id), ...siblings.slice(at + 1), ...siblings.slice(0, Math.max(0, at))].filter((v,i,all)=>v.id!==item.id&&all.findIndex(x=>x.id===v.id)===i).slice(0,12);
  $('queue-video').textContent='Queue'+(queue.length?' ('+queue.length+')':'');
  $('next-list').innerHTML = next.length ? next.map(v => card(v)).join('') : '<p class="status">Nothing else in this folder.</p>';
  paintBars($('next-list'));
}

video.addEventListener('timeupdate', () => { if (Date.now() - lastSave > 5000) remember(); });
video.addEventListener('pause', () => remember());
video.addEventListener('ended', () => remember(true));
video.addEventListener('playing', () => {
  status('', false, $('player-status'));
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
video.addEventListener('pause', () => {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});
addEventListener('pagehide', () => remember());
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && remember());

const skip = seconds => current?.handle?.seek((video.currentTime || 0) + seconds);
$('back-10').addEventListener('click', () => skip(-10));
$('forward-10').addEventListener('click', () => skip(10));
$('speed').value = read(SPEED_KEY) || '1';
if (![...$('speed').options].some(o => o.value === $('speed').value)) $('speed').value = '1';
$('speed').addEventListener('change', () => { video.defaultPlaybackRate = video.playbackRate = Number($('speed').value); write(SPEED_KEY, $('speed').value); });
video.addEventListener('ratechange', () => { if (String(video.playbackRate) !== $('speed').value && [...$('speed').options].some(o => o.value === String(video.playbackRate))) $('speed').value = String(video.playbackRate); });
$('captions').addEventListener('change', () => {
  for (const track of video.textTracks) track.mode = 'disabled';
  const index = $('captions').value;
  const el = [...video.querySelectorAll('track')].find(t => t.dataset.index === index);
  if (el) el.track.mode = 'showing';
});
$('pip').hidden = !document.pictureInPictureEnabled;
$('pip').addEventListener('click', () => {
  const exiting = !!document.pictureInPictureElement;
  pipDiagnostics.markIntent(exiting ? 'app-exit' : 'app-enter');
  (exiting ? document.exitPictureInPicture() : video.requestPictureInPicture()).then(
    () => pipDiagnostics.markOutcome(exiting ? 'exit-resolved' : 'enter-resolved'),
    () => { pipDiagnostics.markOutcome(exiting ? 'exit-rejected' : 'enter-rejected'); status('Picture in picture is not available for this video.', true, $('player-status')); }
  );
});
$('pip-report').addEventListener('click', () => {
  const report = pipReport(), dialog = sheet('Picture-in-picture details', []);
  dialog.append(el('p', 'Chrome controls the system window. This report records window and playback changes, but cannot identify which native exit control was used.'));
  const output = el('textarea', report); output.readOnly = true; output.rows = 12;
  output.setAttribute('aria-label', 'Picture-in-picture report'); output.style.width = '100%'; output.style.boxSizing = 'border-box';
  const copy = el('button', 'Copy PiP report', 'sheet-action'); copy.type = 'button';
  copy.onclick = async () => { copy.textContent = await copyText(report) ? 'Report copied' : 'Copy blocked. Select the report above.'; };
  dialog.append(output, copy);
});
video.addEventListener('enterpictureinpicture', () => {
  document.body.classList.add('pip-active');
  $('pip').textContent = 'Close pop-out';
});
video.addEventListener('leavepictureinpicture', () => {
  document.body.classList.remove('pip-active');
  $('pip').textContent = 'Picture in picture';
  // Android Chrome owns the system PiP window. Releasing playback while the
  // page is still backgrounded prevents a closed pop-out from leaving a live
  // tab or audio session behind.
  if (document.visibilityState === 'hidden') {
    video.pause();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }
});
$('watched').addEventListener('click', () => {
  if (!current) return;
  const id = current.video.id, entry = progress[id];
  progress[id] = entry?.done ? {...entry, done:false, at:Date.now()} : {...recordProgress(entry, 0, video.duration || entry?.d || 0, true), done:true};
  saveProgress(); paintWatched();
});
// Landscape videos rotate the phone's fullscreen view when Android allows it.
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement === video && video.videoWidth > video.videoHeight) screen.orientation?.lock?.('landscape').catch(() => {});
  else if (!document.fullscreenElement) screen.orientation?.unlock?.();
});
if ('mediaSession' in navigator) {
  const stopPlayback = () => {
    pipDiagnostics.markIntent('media-stop');
    video.pause();
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
    if (current) location.hash = '';
  };
  const handlers = {
    play:() => video.play().catch(() => {}),
    pause:() => video.pause(),
    stop:stopPlayback,
    seekbackward:d => skip(-(d.seekOffset || 10)),
    seekforward:d => skip(d.seekOffset || 10),
    seekto:d => current?.handle?.seek(d.seekTime)
  };
  for (const [action, fn] of Object.entries(handlers)) { try { navigator.mediaSession.setActionHandler(action, fn); } catch {} }
}
document.addEventListener('keydown', event => {
  if (!current || event.ctrlKey || event.metaKey || event.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
  const actions = {j:() => skip(-10), l:() => skip(10), k:() => (video.paused ? video.play() : video.pause()),
    f:() => (document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen()).catch(() => {})};
  const action = actions[event.key.toLowerCase()];
  if (action) { event.preventDefault(); action(); }
});

/* ---- routing ---------------------------------------------------------- */

// #v=<Drive file ID> is the player; anything else is the library. Real links
// keep Android Back working.
function route(event) {
  const id = /^#v=([A-Za-z0-9_-]{10,200})$/.exec(location.hash)?.[1];
  const item = id && library?.videos.find(v => v.id === id);
  if (id && !ready) return; // opened once the Drive key has loaded
  if (item && api) { if (current?.video.id !== id) { if (!current) libraryScroll = scrollY; openVideo(item); } return; }
  if (id && api && (loading || !library)) return; // shown once the list arrives
  const returning=!!current;
  if(current){closeVideo();}
  if(!returning&&event?.type==='hashchange'){libraryScroll=0;pageLimit=60;}
  depth = 0;
  const hash=location.hash.slice(1);
  collection='';browseKind='';
  if(hash.startsWith('collection=')){try{collection=decodeURIComponent(hash.slice(11));}catch{collection='';}}
  else if(hash.startsWith('browse='))browseKind=hash.slice(7);
  else if(['explore','library','saved'].includes(hash))view=hash;
  writeLocal('mymedia.view.v1',view);
  $('player-view').hidden = true; $('library-view').hidden = false;
  $('back').innerHTML=icon('back'); $('back').href = '/'; $('back').setAttribute('aria-label', 'Back to Jarvis');
  $('refresh').hidden = false;$('search-toggle').hidden=false;$('media-nav').hidden=false;
  document.title = 'My Media · Jarvis';
  if (id) status(api ? 'That video is no longer in the folder.' : 'Videos cannot play until the Drive settings load.', true);
  renderLibrary();
  requestAnimationFrame(() => window.scrollTo(0, libraryScroll));
}
addEventListener('hashchange', route);
document.addEventListener('click', event => {
  const link = event.target.closest?.('a[href^="#"]');
  if (!link) return;
  // Back to the list in one step, however many Up next videos were opened.
  if (link.getAttribute('href').startsWith('#v=')) depth++;
  else if (link.id === 'back' && depth) { event.preventDefault(); history.go(-depth); }
});

$('search').addEventListener('input', () => { query = $('search').value.trim(); pageLimit=60; renderLibrary(); });
$('sort').value = ['newest', 'title', 'longest'].includes(sort) ? sort : 'newest';
$('sort').addEventListener('change', () => { sort = $('sort').value; write(SORT_KEY, sort); renderLibrary(); });
$('refresh').addEventListener('click', refresh);
$('sections').addEventListener('toggle', event => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.dataset.folder) return;
  if(details.open){openFolders.add(details.dataset.folder);const items=filteredVideos().filter(v=>v.folder===details.dataset.folder);const grid=details.querySelector('.folder-grid');if(!grid.children.length){grid.innerHTML=items.slice(0,60).map(card).join('');paintBars(grid);}}
  else openFolders.delete(details.dataset.folder);
  saveOpenFolders();
  updateFolderToggle();
}, true);
$('toggle-folders').addEventListener('click', () => {
  const folders = [...$('sections').querySelectorAll('.folder-shelf')];
  const shouldOpen = folders.some(details => !details.open);
  openFolders = new Set(shouldOpen ? folders.map(details => details.dataset.folder) : []);
  for (const details of folders) details.open = shouldOpen;
  saveOpenFolders();
  updateFolderToggle();
});

/* ---- start ------------------------------------------------------------ */

async function start() {
  if (library) status(summary());
  route();
  try {
    const response = await fetch('/assets/drive-config.json', {cache:'no-store', signal:AbortSignal.timeout(15000)});
    const config = await response.json();
    key = String(config.apiKey || '').trim();
    if (!config.videoFolderId) throw Error('No video folder is configured.');
    folder = folderId(config.videoFolderId);
    api = createVideoApi(key);
    if (library && library.id !== folder) library = null;
  } catch (error) {
    ready = true; route();
    status((error?.message || 'Drive settings could not be loaded.') + (library ? ' Showing the last saved list.' : ''), true);
    return;
  }
  ready = true;
  route(); // thumbnails that need the key, or a video link opened directly
  refresh();
}
$('search-toggle').onclick=()=>{ $('search').focus(); $('library-search').scrollIntoView({block:'nearest'}); };
$('all-videos').onclick=()=>{minutes=0;onlyUnwatched=false;collection='';browseKind='';pageLimit=60;location.hash=view;renderLibrary();};
$('creator-filters').onclick=e=>{const chip=e.target.closest('[data-collection-filter]');if(chip){pageLimit=60;location.hash='collection='+encodeURIComponent(chip.dataset.collectionFilter);}};
$('time-filter').onclick=()=>sheet('How much time do you have?',[0,10,20,40].map(n=>({label:n?'Under '+n+' minutes':'Any length',icon:'clock',action:()=>{minutes=n;pageLimit=60;renderLibrary();}})));
$('unwatched-filter').onclick=()=>{onlyUnwatched=!onlyUnwatched;pageLimit=60;renderLibrary();};
$('browse-all').onclick=()=>{location.hash=view;};
$('load-more').onclick=()=>{pageLimit+=60;renderLibrary();};
$('surprise').onclick=()=>{const picks=discover(filteredVideos(),progress,100,new Date().toISOString().slice(0,10)+Math.random());if(!picks.length){status('No unwatched videos match these filters.');return;}videoMenu(picks[0].id);};
document.addEventListener('click',e=>{const b=e.target.closest('[data-video-menu]');if(b)videoMenu(b.dataset.videoMenu);});
$('save-video').onclick=()=>{if(!current)return;const id=current.video.id;saved.has(id)?saved.delete(id):saved.add(id);persistSaved();$('save-video').textContent=saved.has(id)?'Saved':'Save for later';};
$('queue-video').onclick=()=>sheet('Viewing queue',[{label:queue.includes(current.video.id)?'Remove current video':'Add current video',icon:'plus',action:()=>{const id=current.video.id;queue.includes(id)?queue=queue.filter(x=>x!==id):queue.push(id);persistQueue();}},...queue.map(id=>({label:library.videos.find(v=>v.id===id)?.title||'Unavailable video',icon:'play',action:()=>sheet('Queue item',[{label:'Play next',action:()=>{queue=[id,...queue.filter(x=>x!==id)];persistQueue();}},{label:'Remove from queue',action:()=>{queue=queue.filter(x=>x!==id);persistQueue();}}])}))]);
view=readLocal('mymedia.view.v1','explore');if(!['explore','library','saved'].includes(view))view='explore';
start();
