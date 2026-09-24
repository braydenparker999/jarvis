import {createVideoApi, mediaURL, thumbnails, parseLibrary, parseProgress, recordProgress, resumeTime,
  continueWatching, searchVideos, sortVideos, groupByFolder, formatDuration, srtToVtt,
  PROGRESS_KEY, LIBRARY_KEY} from './library.js';
import {play} from './player.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } };
const SORT_KEY = 'mymedia.sort.v1', SPEED_KEY = 'mymedia.speed.v1';

let key = '', folder = '', api = null, loading = false;
let library = parseLibrary(read(LIBRARY_KEY));
let progress = parseProgress(read(PROGRESS_KEY));
let query = '', sort = read(SORT_KEY) || 'newest';
let current = null, libraryScroll = 0, depth = 0, ready = false;

function status(text, error = false, el = $('status')) {
  el.hidden = !text; el.textContent = text; el.classList.toggle('error', error);
}
function saveProgress() {
  if (!write(PROGRESS_KEY, JSON.stringify(progress))) status('This browser could not save your place in videos.', true);
}

/* ---- library ---------------------------------------------------------- */

function card(video) {
  const p = progress[video.id], duration = video.duration || p?.d || 0;
  const images = thumbnails(video, key);
  const percent = p && !p.done && duration ? Math.min(100, p.t / duration * 100) : 0;
  const left = resumeTime(p) && duration ? formatDuration(duration - p.t) + ' left' : '';
  const date = video.modified ? new Date(video.modified).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'}) : '';
  const detail = p?.done ? '<span class="watched-mark">✓ Watched</span>' : esc(left || date);
  return `<a class="video-card" href="#v=${esc(video.id)}"><div class="thumb">` +
    `<span class="placeholder" aria-hidden="true">▶</span>` +
    (images.length ? `<img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${esc(images[0])}" data-fallbacks="${esc(JSON.stringify(images.slice(1)))}">` : '') +
    (duration ? `<span class="length">${formatDuration(duration)}</span>` : '') +
    (percent ? `<span class="bar"><span data-progress="${percent.toFixed(1)}"></span></span>` : '') +
    `</div><span class="card-text"><strong>${esc(video.title)}</strong><small>${detail}</small></span></a>`;
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
  renderShelves();
  paintBars($('library-view'));
}
function renderShelves() {
  if (!library) { $('sections').innerHTML = ''; $('continue').hidden = true; return; }
  const videos = sortVideos(searchVideos(library.videos, query), sort);
  if (query) {
    $('continue').hidden = true;
    $('sections').innerHTML = videos.length
      ? `<section class="shelf"><h2 class="eyebrow">${videos.length} result${videos.length === 1 ? '' : 's'}</h2><div class="video-grid">${videos.map(v => card(v)).join('')}</div></section>`
      : `<p class="empty">No videos match “${esc(query)}”.</p>`;
    return;
  }
  const resume = continueWatching(library.videos, progress, 6);
  $('continue').hidden = !resume.length;
  $('continue-grid').innerHTML = resume.map(v => card(v)).join('');
  const groups = groupByFolder(videos, library.name);
  $('sections').innerHTML = groups.length
    ? groups.map(g => `<section class="shelf"><h2 class="eyebrow">${esc(g.label)} · ${g.items.length}</h2><div class="video-grid">${g.items.map(v => card(v)).join('')}</div></section>`).join('')
    : '<p class="empty">No videos in this folder yet. Add MP4 or WebM files in Google Drive, then refresh.</p>';
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
  $('library-view').hidden = true; $('player-view').hidden = false;
  $('back').textContent = '← Library'; $('back').href = '#'; $('back').setAttribute('aria-label', 'Back to library');
  $('refresh').hidden = true;
  document.title = item.title + ' · My Media';
  $('video-title').textContent = item.title;
  const bits = [item.folder, item.height ? item.height + 'p' : '', item.size ? (item.size / 1048576).toFixed(0) + ' MB' : ''];
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
    navigator.mediaSession.metadata = new MediaMetadata({title:item.title, artist:item.folder, album:'My Media',
      artwork:item.youtubeId ? [{src:'https://i.ytimg.com/vi/' + item.youtubeId + '/hqdefault.jpg', sizes:'480x360', type:'image/jpeg'}] : []});
  }
  window.scrollTo(0, 0);
}

function closeVideo() {
  if (!current) return;
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
  const siblings = sortVideos(library.videos.filter(v => v.folder === item.folder), sort);
  const at = siblings.findIndex(v => v.id === item.id);
  const next = [...siblings.slice(at + 1), ...siblings.slice(0, Math.max(0, at))].slice(0, 12);
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
$('pip').addEventListener('click', () => (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch(() => status('Picture in picture is not available for this video.', true, $('player-status'))));
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
function route() {
  const id = /^#v=([A-Za-z0-9_-]{10,200})$/.exec(location.hash)?.[1];
  const item = id && library?.videos.find(v => v.id === id);
  if (id && !ready) return; // opened once the Drive key has loaded
  if (item && api) { if (current?.video.id !== id) { if (!current) libraryScroll = scrollY; openVideo(item); } return; }
  if (id && api && (loading || !library)) return; // shown once the list arrives
  depth = 0;
  closeVideo();
  $('player-view').hidden = true; $('library-view').hidden = false;
  $('back').textContent = '← Jarvis'; $('back').href = '/'; $('back').setAttribute('aria-label', 'Back to Jarvis');
  $('refresh').hidden = false;
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

$('search').addEventListener('input', () => { query = $('search').value.trim(); renderLibrary(); });
$('sort').value = ['newest', 'title', 'longest'].includes(sort) ? sort : 'newest';
$('sort').addEventListener('change', () => { sort = $('sort').value; write(SORT_KEY, sort); renderLibrary(); });
$('refresh').addEventListener('click', refresh);

/* ---- start ------------------------------------------------------------ */

async function start() {
  if (library) status(summary());
  route();
  try {
    const response = await fetch('/assets/drive-config.json', {cache:'no-store', signal:AbortSignal.timeout(15000)});
    const config = await response.json();
    key = String(config.apiKey || '').trim(); folder = String(config.videoFolderId || '').trim();
    api = createVideoApi(key);
    if (!folder) throw Error('No video folder is configured.');
  } catch (error) {
    ready = true; route();
    status((error?.message || 'Drive settings could not be loaded.') + (library ? ' Showing the last saved list.' : ''), true);
    return;
  }
  ready = true;
  route(); // thumbnails that need the key, or a video link opened directly
  refresh();
}
start();
