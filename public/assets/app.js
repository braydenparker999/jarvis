import { apps, icon, loadPreferences, savePreferences, renderUtility } from './hub.js';
import { API_ORIGIN } from './config.js';
import { request } from './shared-api.js';
import { STORAGE_KEY, LEGACY_KEY, readState, mergeState } from './shared-store.js';

const $ = id => document.getElementById(id);
const icons = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/><path d="M7 10h9M7 14h5"/>',
  board: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sync: '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
  send: '<path d="m3 3 18 9-18 9 3-9-3-9Zm3 9h15"/>'
};
const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
let state, storageError = '', syncError = '', busy = false, toastTimer;
try { state = readState(localStorage); localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
catch (e) { storageError = e.message || 'Device storage is unavailable.'; }
let route = getRoute();
const paths = { home: '/', chat: '/jarvis/', board: '/daily-board/', favorites: '/favorites/', settings: '/settings/', notes: '/notes/', tools: '/tools/', server: '/server/' };
const labels = { home: 'Home', chat: 'Jarvis', board: 'Daily Board', favorites: 'Favorites', settings: 'Settings', notes: 'Notes', tools: 'Tools', server: 'Server' };
function getRoute() { return ({jarvis:'chat','daily-board':'board',favorites:'favorites',settings:'settings',notes:'notes',tools:'tools',server:'server'})[location.pathname.split('/')[1]] || 'home'; }
let preferences = loadPreferences();
let searchQuery = '', searchOpen = false;
const time = stamp => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(stamp));
const date = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
const escape = text => String(text).replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
function commit(next) {
  if (storageError) throw new Error(storageError);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  state = next;
}
function notify(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function connection() {
  if (storageError) return 'Device storage unavailable';
  if (!API_ORIGIN) return 'Cloud setup pending';
  if (busy) return 'Syncing';
  if (!navigator.onLine || syncError) return navigator.onLine ? 'Sync unavailable' : 'Offline · drafts saved';
  if (state.mode === 'github-publications' && state.publisher?.ok === false) return 'Replies delayed';
  return state.syncedAt ? 'Connected' : 'Connecting';
}
function drawShell() {
  const hub = ['home','favorites','settings'].includes(route);
  document.title = `${labels[route]} · Jarvis`;
  $('app').innerHTML = `<div class="workspace"><header class="topbar">${hub?`<button class="icon-button" id="menu-button" aria-label="Open navigation">${icon('menu')}</button>`:`<a class="icon-button" href="/" data-route="home" aria-label="Back to Home">${icon('back')}</a>`}<a class="brand" href="/" data-route="home">Jarvis</a><div class="toolbar-actions">${hub?`<button class="icon-button" id="search-button" aria-label="Search apps">${icon('search')}</button>`:''}<button class="icon-button" id="connection-button" aria-label="Connection details">${icon('more')}<span class="sr-only">${connection()}</span></button></div></header><main id="content" tabindex="-1"></main>${hub?`<nav class="bottom-nav" aria-label="Hub navigation">${['home','favorites','settings'].map(key=>`<a href="${paths[key]}" data-route="${key}" ${key===route?'aria-current="page"':''}>${icon(key)}<span>${labels[key]}</span></a>`).join('')}</nav>`:''}</div>`;
  $('connection-button').onclick = showConnection;
  if ($('menu-button')) $('menu-button').onclick = showNavigation;
  if ($('search-button')) $('search-button').onclick = () => { searchOpen=!searchOpen; route='home'; history.pushState({},'',paths.home); drawShell(); $('app-search')?.focus(); };
  drawPage();
}
function drawPage() {
  if (route === 'home' || route === 'favorites') { drawHome(); return; }
  if (route === 'settings') { drawSettings(); return; }
  if (['notes','tools','server'].includes(route)) { renderUtility(route,$('content'),{notify,connection,showConnection,state,storageError,sync}); return; }
  if (storageError) { $('content').innerHTML = `<div class="empty"><h1>Unable to save on this device</h1><p>${escape(storageError)}</p><p>Existing data has not been changed. Allow browser storage, then reload.</p></div>`; return; }
  if (route === 'chat') drawChat();
  if (route === 'board') drawBoard();
}
function appRow(app) {
  return `<a class="app-row" href="${app.href}">${icon(app.icon)}<span><strong>${app.name}</strong><small>${app.description}</small></span>${icon('chevron')}</a>`;
}
function drawHome() {
  const favorites = route==='favorites';
  const selected = apps.filter(a=>preferences.favorites.includes(a.id));
  $('content').innerHTML = `<section class="page-heading"><h1>${favorites?'Favorites':'Home'}</h1><button class="text-button" id="edit-favorites">Edit</button></section>${searchOpen&&!favorites?`<div class="search-field"><label class="sr-only" for="app-search">Find an app</label><input id="app-search" type="search" placeholder="Find an app" value="${escape(searchQuery)}" autocomplete="off"></div>`:''}${!favorites&&selected.length?`<div class="shortcuts" aria-label="Favorite apps">${selected.slice(0,2).map(a=>`<a href="${a.href}">${icon(a.icon)}<span>${a.name}</span></a>`).join('')}</div>`:''}<div id="app-directory"></div>`;
  const render=()=>{
    const filtered=(favorites?selected:apps).filter(a=>(a.name+' '+a.description).toLowerCase().includes(searchQuery.toLowerCase()));
    $('app-directory').innerHTML = filtered.length?['Conversation','Library','Utilities'].map(group=>{const rows=filtered.filter(a=>a.group===group);return rows.length?`<section class="app-group"><h2 class="eyebrow">${group}</h2>${rows.map(appRow).join('')}</section>`:'';}).join(''):`<p class="empty-note">${favorites?'Choose your favorite apps with Edit.':'No apps match your search.'}</p>`;
  };
  if(favorites)searchQuery='';
  render();
  if($('app-search'))$('app-search').oninput=e=>{searchQuery=e.target.value;render();};
  $('edit-favorites').onclick=editFavorites;
}
function editFavorites() {
  const dialog=$('hub-dialog');
  dialog.innerHTML=`<div class="dialog-heading"><h2 id="hub-dialog-heading">Favorites</h2><button class="close" aria-label="Close favorites">×</button></div><p>Choose shortcuts for this browser. Your first two appear on Home.</p><form id="favorites-form">${apps.map(a=>`<label class="check-row"><input type="checkbox" name="favorite" value="${a.id}" ${preferences.favorites.includes(a.id)?'checked':''}>${a.name}</label>`).join('')}<button class="primary" type="submit">Save favorites</button></form>`;
  dialog.querySelector('.close').onclick=()=>dialog.close();
  $('favorites-form').onsubmit=e=>{e.preventDefault();try{const next={...preferences,favorites:new FormData(e.target).getAll('favorite')};savePreferences(next);preferences=next;dialog.close();drawShell();}catch{notify('Favorites could not be saved. Browser storage is unavailable.');}};
  dialog.showModal();
}
function showNavigation() {
  const dialog=$('hub-dialog');
  dialog.innerHTML=`<div class="dialog-heading"><h2 id="hub-dialog-heading">Your apps</h2><button class="close" aria-label="Close navigation">×</button></div>${apps.map(appRow).join('')}`;
  dialog.querySelector('.close').onclick=()=>dialog.close();dialog.showModal();
}
function drawSettings() {
  $('content').innerHTML=`<section class="page-heading"><h1>Settings</h1></section><section class="app-group"><h2 class="eyebrow">Your hub</h2><button class="app-row" id="settings-favorites">${icon('favorites')}<span><strong>Favorites</strong><small>Choose your Home shortcuts</small></span>${icon('chevron')}</button><a class="app-row" href="/server/">${icon('server')}<span><strong>Connection & status</strong><small>Message sync and service details</small></span>${icon('chevron')}</a></section><section class="reading"><h2>One shared conversation</h2><p>Jarvis messages and Daily Board are shared across phones. Favorites and notes are saved in this browser.</p><h2>Your player</h2><p>DrawerCast has its own full player and settings. Music stays on your phone or server.</p><h2>About</h2><p>Jarvis · version 1.1<br>Dark interface inspired by your Poweramp player.</p></section>`;
  $('settings-favorites').onclick=editFavorites;
}
function drawChat() {
  $('content').innerHTML = `<section class="page-heading"><div><p class="eyebrow">MESSAGES</p><h1>Jarvis</h1></div><span class="pill">${API_ORIGIN?'INBOX':'DRAFT MODE'}</span></section><section class="chat-panel"><div class="chat-notice">${API_ORIGIN?'Messages and replies, shared across your phones. Replies are asynchronous.':'Cloud messaging is not connected yet. Your drafts stay on this device and have not been sent.'}</div><div class="messages" id="messages" aria-label="Conversation">${state.messages.length?state.messages.map(messageMarkup).join(''):`<div class="chat-empty"><h2>A place to pick up your thoughts.</h2><p>Write a message below. ${API_ORIGIN?'Messages appear here when saved.':'It will wait here until cloud messaging is ready.'}</p></div>`}</div><form class="composer" id="message-form"><label class="sr-only" for="message-text">Message Jarvis</label><textarea id="message-text" rows="2" maxlength="4000" placeholder="Write something…" required>${escape(state.composer || '')}</textarea><div class="composer-bottom"><span>${API_ORIGIN?'Enter to send · Shift + Enter for a new line':'Saved on this device · not sent'}</span><button class="primary" type="submit" id="send-message">${API_ORIGIN?'Send':'Save draft'} ${svg('send')}</button></div></form></section>`;
  $('message-text').oninput = e => { try { commit({ ...state, composer: e.target.value }); } catch { notify('Could not save your draft. Keep this page open and copy your text.'); } };
  $('message-text').onkeydown = e => { if (e.key==='Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('message-form').requestSubmit(); } };
  $('message-form').onsubmit = e => { e.preventDefault(); submitMessage(); };
  const messages = $('messages'); messages.scrollTop = messages.scrollHeight;
}
function messageMarkup(m) {
  return `<article data-message-id="${escape(m.id)}" class="message-row ${m.role==='user'?'outgoing':'incoming'}"><span class="message-author">${m.role==='user'?'YOU':m.kind==='reply'?'JARVIS':'JARVIS · AUTOMATIC RECEIPT'}</span><p class="bubble">${escape(m.body)}</p><span class="message-time">${time(m.createdAt)} · ${m.saved?'Cloud saved':'Not sent · on this device'}</span></article>`;
}
function submitMessage() {
  const body = $('message-text').value.trim();
  if (!body) return;
  const item = { id: crypto.randomUUID(), body, role: 'user', createdAt: new Date().toISOString(), saved: false };
  try {
    commit({ ...state, composer: '', messages: [...state.messages,item], outbox: [...state.outbox,{...item,type:'message'}] });
    drawShell(); if (API_ORIGIN) sync(); else notify('Draft saved on this device. It has not been sent.');
  } catch { notify('Could not save. Your text is still in the message box.'); }
}
function drawBoard() {
  $('content').innerHTML = `<section class="page-heading"><div><p class="eyebrow">YOUR DAILY BRIEFING</p><h1>Daily Board</h1><p class="subheading">Your briefing from Jarvis.</p></div></section><div class="board-list">${state.posts.length?[...state.posts].reverse().map(p=>`<article class="card board-entry"><div class="card-top"><span class="eyebrow">${time(p.createdAt)}</span><span class="pill">${p.saved?'CLOUD SAVED':'ON THIS DEVICE'}</span></div><h2>${escape(p.title)}</h2><p>${escape(p.body)}</p></article>`).join(''):`<section class="card empty-board"><span class="empty-icon">${svg('board')}</span><h2>Your briefing will appear here.</h2><p>Briefings published by Jarvis appear here on all your devices.</p></section>`}</div><p class="board-note">${API_ORIGIN?'The same Daily Board on every device.':'Entries are saved on this device. Cloud sync and scheduled updates are not connected yet.'}</p>`;

}
function showConnection() {
  $('connection-state').textContent = connection();
  $('connection-detail').textContent = storageError ? storageError : !API_ORIGIN ? 'Your hub is live. Cloud storage is awaiting connection. Messages and board entries currently save only in this browser; clearing browser data will remove them.' : syncError || (state.syncedAt ? `Last synced ${time(state.syncedAt)}. One shared inbox. Messages are stored in Cloudflare.${state.mode === 'github-publications' ? (state.publisher?.ok ? ' Replies and briefings are connected.' : ' Your messages remain saved. Reply delivery is temporarily delayed: ' + (state.publisher?.error || 'waiting for publication sync')) : ' Publication upgrade pending.'}` : 'Opening the shared inbox.');
  $('sync-now').hidden = !API_ORIGIN || !!storageError;
  $('sync-now').disabled = busy;
  $('connection-dialog').showModal();
}
async function sync() {
  if (!API_ORIGIN || busy || storageError) return;
  busy = true; syncError = '';
  $('connection-button').lastElementChild.textContent = connection();
  try {
    if(state.legacyPending){
      const old=JSON.parse(localStorage.getItem(LEGACY_KEY)||'null');
      if(!old?.key)throw Error('Previous inbox is unavailable. Existing drafts have been preserved.');
      const remote=await request('/shared/migrate',{}, {Authorization:'Bearer '+old.key});
      commit(mergeState({...state,legacyPending:false},remote));
    }
    for (const item of [...state.outbox]) {
      const remote = await request('/shared/messages',{id:item.id,body:item.body});
      commit(mergeState({...state,outbox:state.outbox.filter(x=>x.id!==item.id)},remote));
    }
    commit(mergeState(state,await request('/shared/state')));
  } catch (e) { syncError = e.message || 'Cloud unavailable. Your drafts are safe.'; notify(syncError); }
  finally {
    busy = false;
    // Composer values persist on input, so redraws do not discard unsent text.
    const active = document.activeElement?.id;
    const oldScroll=$('messages')?.scrollTop;
    const wasAtBottom=$('messages') ? $('messages').scrollHeight-$('messages').clientHeight-oldScroll<40 : true;
    const start = document.activeElement?.selectionStart;
    if (['chat','board'].includes(route)) drawShell();
    else if ($('connection-button')) $('connection-button').lastElementChild.textContent=connection();
    if ($('messages') && !wasAtBottom) $('messages').scrollTop=oldScroll;
    if (active && $(active)) { $(active).focus(); if (typeof start==='number' && typeof $(active).setSelectionRange==='function') $(active).setSelectionRange(start,start); }
    if ($('connection-dialog').open) { $('connection-state').textContent = connection(); $('sync-now').disabled=false; }
  }
}
document.addEventListener('click', e => {
  const link = e.target.closest('[data-route]');
  if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault(); $('hub-dialog')?.close(); route = link.dataset.route; history.pushState({},'',paths[route]); drawShell(); window.scrollTo(0,0);
});
window.addEventListener('popstate',()=>{ route=getRoute(); drawShell(); });
window.addEventListener('online',sync);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden && API_ORIGIN && !busy && (!state.syncedAt || Date.now()-Date.parse(state.syncedAt)>60000)) sync(); });
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
$('sync-now').onclick = sync;
drawShell();
if (API_ORIGIN) sync();


setInterval(()=>{if(!document.hidden)sync();},30000);
window.addEventListener('storage',e=>{if(e.key===STORAGE_KEY&&!busy){try{state=readState(localStorage);if(['chat','board'].includes(route))drawShell();}catch{}}});
