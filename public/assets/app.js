import {icon as uiIcon, sheet, appViewport, autosize} from './ui.js';
import {conversation} from './conversation.js';
import { apps, icon, loadPreferences, savePreferences, renderUtility } from './hub.js';
import { API_ORIGIN } from './config.js';
import { request } from './shared-api.js';
import { STORAGE_KEY, LEGACY_KEY, readState, mergeState } from './shared-store.js';
import { channelMessages } from './channels.js';
import { OWNER_SESSION_KEY } from './relay-owner-api.js';
import { createRelayOwnerController, createRelayOwnerUI } from './relay-owner-ui.js';

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
let route = getRoute(), chatUI;
const ownerController = createRelayOwnerController({onModeChange:()=>{if(route==='chat')drawShell();}});
const ownerUI = createRelayOwnerUI({controller:ownerController});
ownerController.subscribe(updateConversationIdentity);
appViewport();
addEventListener('pagehide',()=>chatUI?.savePosition());
const paths = { home: '/', chat: '/jarvis/', board: '/daily-board/', favorites: '/favorites/', settings: '/settings/', notes: '/notes/', tools: '/tools/', server: '/server/' };
const labels = { home: 'Home', chat: 'Relay', board: 'Daily Board', favorites: 'Favorites', settings: 'Settings', notes: 'Notes', tools: 'Tools', server: 'Server' };
function getRoute() { return ({jarvis:'chat','daily-board':'board',favorites:'favorites',settings:'settings',notes:'notes',tools:'tools',server:'server'})[location.pathname.split('/')[1]] || 'home'; }
let preferences = loadPreferences();
let searchQuery = '', searchOpen = false;
const time = stamp => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(stamp));
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
let clockTimer;
const escape = text => String(text).replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
function updateClock() {
  clearTimeout(clockTimer);
  const clock = $('launcher-time'), date = $('launcher-date');
  if (!clock || !date || document.hidden) return;
  const now = new Date();
  clock.innerHTML = clockFormat.formatToParts(now).map(part => part.type === 'dayPeriod' ? `<span class="clock-period">${escape(part.value)}</span>` : escape(part.value)).join('');
  clock.dateTime = now.toISOString();
  date.textContent = dateFormat.format(now);
  date.dateTime = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  // Stay aligned to the device's minute, and only update the two clock nodes.
  clockTimer = setTimeout(updateClock, 60000 - Date.now() % 60000);
}
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
  ownerUI.unmount();
  chatUI?.savePosition(); chatUI=null;
  for(const cls of ['module-page','conversation-page','relay-page'])document.body.classList.toggle(cls,route==='chat');
  if(route==='chat'&&!document.querySelector('link[href^="/assets/conversation.css"]')){const css=document.createElement('link');css.rel='stylesheet';css.href='/assets/conversation.css?v=20261008';document.head.append(css);}
  document.body.dataset.conversationMode=route==='chat'&&ownerUI.mode!=='public'?'owner':'public';
  const hub = ['home','favorites','settings'].includes(route);
  const launcher = ['home','favorites'].includes(route);
  clearTimeout(clockTimer);
  document.body.classList.toggle('launcher-page', launcher);
  document.querySelector('meta[name="theme-color"]').content = launcher ? '#090a0c' : '#121212';
  document.title = `${labels[route]} · Jarvis`;
  const header = launcher
    ? `<header class="topbar launcher-topbar"><a class="brand" href="/" data-route="home">Jarvis</a><nav class="toolbar-actions" aria-label="Launcher tools"><button class="icon-button" id="search-button" aria-label="Search apps" aria-expanded="${route==='home'&&searchOpen}" ${route==='home'?'aria-controls="launcher-search"':''}>${icon('search')}</button><a class="icon-button" href="/favorites/" data-route="favorites" aria-label="Favorites" ${route==='favorites'?'aria-current="page"':''}>${icon('favorites')}</a><button class="icon-button" id="connection-button" aria-label="Connection details">${icon('more')}<span class="sr-only">${connection()}</span></button></nav></header>`
    : `<header class="topbar">${hub?`<button class="icon-button" id="menu-button" aria-label="Open navigation">${icon('menu')}</button>`:`<a class="icon-button" href="/" data-route="home" aria-label="Back to Home">${icon('back')}</a>`}${route==='chat'?`<div class="conversation-identity"><span class="brand" role="heading" aria-level="1">Relay</span><span class="conversation-visibility" id="conversation-visibility"></span></div>`:`<span class="brand">Jarvis</span>`}<div class="toolbar-actions">${route==='chat'?`<button class="icon-button" id="chat-search-toggle" aria-label="Search messages" hidden>${uiIcon('search')}</button><button class="icon-button" id="chat-menu" aria-label="Conversation menu">${uiIcon('more')}</button>`:''}${hub?`<button class="icon-button" id="search-button" aria-label="Search apps">${icon('search')}</button>`:''}<button class="icon-button" id="connection-button" aria-label="Connection details">${icon('more')}<span class="sr-only">${connection()}</span></button></div></header>`;
  $('app').innerHTML = `<div class="workspace${launcher?' launcher':''}">${header}<main id="content" tabindex="-1"></main>${hub&&!launcher?`<nav class="bottom-nav" aria-label="Hub navigation">${['home','favorites','settings'].map(key=>`<a href="${paths[key]}" data-route="${key}" ${key===route?'aria-current="page"':''}>${icon(key)}<span>${labels[key]}</span></a>`).join('')}</nav>`:''}</div>`;
  $('connection-button').onclick = showConnection;
  if ($('menu-button')) $('menu-button').onclick = showNavigation;
  if ($('search-button')) $('search-button').onclick = () => {
    if (route !== 'home') { route='home'; searchOpen=true; history.pushState({},'',paths.home); }
    else searchOpen=!searchOpen;
    if (!searchOpen) searchQuery='';
    drawShell();
    (searchOpen ? $('app-search') : $('search-button'))?.focus();
  };
  drawPage();
  if(route==='chat') {
    updateConversationIdentity();
    $('connection-button').hidden=true;
    $('chat-search-toggle').onclick=()=>{
      if(ownerUI.mode!=='public'){ownerUI.toggleSearch();return;}
      const bar=$('chat-search-bar');if(!bar)return;bar.hidden=!bar.hidden;if(!bar.hidden)$('conversation-search').focus();else{ $('conversation-search').value='';chatUI?.search('');}
    };
    $('chat-menu').onclick=()=>{
      const privateView=ownerUI.mode!=='public';
      const ownerActions=[
        {label:'Public chat',icon:'chat',action:()=>ownerController.showPublic(),section:'Conversation'},
        {label:ownerController.hasCredential?'Owner chat':ownerController.status==='pending'?'Pairing status':'Connect this phone',icon:'chat',action:()=>ownerController.showOwner()},
        {label:'Muse · public',icon:'chat',href:'/muse/',action:()=>{}},
      ];
      const conversationActions=privateView
        ? [...(ownerController.status==='approved'?[{label:'Search private messages',icon:'search',action:()=>ownerUI.toggleSearch(),section:'This conversation'},...(ownerController.snapshot().jobsEnabled?[{label:'Requests',icon:'clock',action:()=>ownerUI.requests()}]:[]),{label:'Latest private messages',icon:'chat',action:()=>ownerUI.latest()}]:[]),{label:'Refresh private inbox',icon:'refresh',action:()=>ownerUI.refresh(),disabled:!ownerController.hasCredential&&ownerController.status!=='pending',...(ownerController.status==='approved'?{}:{section:'This conversation'})},{label:'Connection details',icon:'info',action:()=>ownerUI.connection()}]
        : [{label:'Search messages',icon:'search',action:()=>$('chat-search-toggle').click(),section:'This conversation'},{label:'Bookmarks',icon:'bookmark',action:()=>chatUI?.bookmarks()},{label:'Latest messages',icon:'chat',action:()=>chatUI?.latest()},{label:'Refresh inbox',icon:'refresh',action:sync},{label:'Connection details',icon:'info',action:showConnection}];
      const accountActions=ownerController.hasCredential?[{label:'Account sign-in',icon:'info',action:()=>ownerController.showAccount(),section:'Owner access'},{label:'Devices',icon:'info',action:()=>ownerController.showDevices()},{label:'Disconnect this phone',icon:'close',action:()=>ownerController.disconnect()}]:[];
      const entries=[...ownerActions,...conversationActions,...accountActions];
      const dialog=sheet(privateView?'Private owner Relay':'Public Relay',entries);dialog.classList.add('conversation-sheet');
      const context=document.createElement('p');context.className='sheet-context';context.textContent=privateView?'Your owner conversation stays private. Public Relay and Muse are separate inboxes.':'Anyone with this website address can read and post to this shared inbox.';dialog.querySelector('.dialog-heading').after(context);
      const actions=[...dialog.querySelectorAll('.sheet-action')];
      entries.forEach((entry,i)=>{if(entry.section){const label=document.createElement('p');label.className='sheet-section';label.textContent=entry.section;actions[i].before(label);}if((entry.label==='Public chat'&&!privateView)||(entry.label==='Owner chat'&&ownerUI.mode==='owner'))actions[i].classList.add('is-current');if(entry.href){const link=document.createElement('a');link.href=entry.href;link.className=actions[i].className;link.innerHTML=actions[i].innerHTML;actions[i].replaceWith(link);}});
    };
  }
}
function updateConversationIdentity(){
  const node=$('conversation-visibility');if(!node||route!=='chat')return;
  const privateView=ownerUI.mode!=='public';document.body.dataset.conversationMode=privateView?'owner':'public';
  node.textContent=privateView?ownerController.status==='approved'?'Private owner · this phone':ownerController.status==='checking'?'Private owner · verifying access':ownerController.status==='expired'?'Private owner · session expired':ownerController.status==='revoked'?'Private owner · access revoked':'Private owner · sign-in required':'Public · shared conversation';
}
function drawPage() {
  if (route === 'home' || route === 'favorites') { drawHome(); return; }
  if (route === 'settings') { drawSettings(); return; }
  if (['notes','tools','server'].includes(route)) { renderUtility(route,$('content'),{notify,connection,showConnection,state,storageError,sync}); return; }
  // A damaged public store must not route private data through its recovery path.
  if (route === 'chat' && ownerUI.mode !== 'public') { ownerUI.mount($('content')); return; }
  if (storageError) { $('content').innerHTML = `<div class="empty"><h1>Unable to save on this device</h1><p>${escape(storageError)}</p><p>Existing data has not been changed. Allow browser storage, then reload.</p></div>`; return; }
  if (route === 'chat') drawChat();
  if (route === 'board') drawBoard();
}
function appRow(app) {
  return `<a class="app-row" href="${app.href}">${icon(app.icon)}<span><strong>${app.name}</strong><small>${app.description}</small></span>${icon('chevron')}</a>`;
}
function launcherRow(app) {
  const favorite = preferences.favorites.includes(app.id);
  return `<a class="launcher-link${app.id==='jarvis'?' launcher-relay':''}" href="${app.href}">${icon(app.icon)}<span class="launcher-name">${app.name}</span>${favorite?`<span class="favorite-mark">${icon('favorites')}<span class="sr-only">Favorite</span></span>`:''}</a>`;
}
function drawHome() {
  const favorites = route==='favorites';
  const selected = apps.filter(a=>preferences.favorites.includes(a.id));
  $('content').innerHTML = `${favorites?`<section class="page-heading launcher-heading"><h1>Favorites</h1><button class="text-button" id="edit-favorites" aria-label="Edit favorites">Edit</button></section>`:`<section class="launcher-clock" aria-label="Local time and date"><h1 class="sr-only">Home</h1><time id="launcher-time" class="launcher-time"></time><time id="launcher-date" class="launcher-date"></time></section><div class="search-field" id="launcher-search" ${searchOpen?'':'hidden'}><label class="sr-only" for="app-search">Find an app</label><input id="app-search" type="search" placeholder="Find an app" value="${escape(searchQuery)}" autocomplete="off"></div>`}<div id="app-directory"></div>`;
  const render=()=>{
    const filtered=(favorites?selected:apps).filter(a=>(a.name+' '+a.description+' '+a.id).toLowerCase().includes(searchQuery.trim().toLowerCase()));
    const utilityIds = ['tools','server','settings'];
    const primary = filtered.filter(a=>!utilityIds.includes(a.id));
    const utilities = filtered.filter(a=>utilityIds.includes(a.id));
    $('app-directory').innerHTML = filtered.length?`<nav class="launcher-list" aria-label="${favorites?'Favorite apps':'Apps'}">${primary.map(launcherRow).join('')}${utilities.length?`<div class="launcher-utilities${primary.length?' separated':''}">${utilities.map(launcherRow).join('')}</div>`:''}</nav>`:`<p class="empty-note" role="status">${favorites?'Choose your favorite apps with Edit.':'No apps match your search.'}</p>`;
  };
  if(favorites)searchQuery='';
  render();
  if($('app-search'))$('app-search').oninput=e=>{searchQuery=e.target.value;render();};
  if ($('edit-favorites')) $('edit-favorites').onclick=editFavorites;
  if (!favorites) updateClock();
}
function editFavorites() {
  const dialog=$('hub-dialog');
  dialog.innerHTML=`<div class="dialog-heading"><h2 id="hub-dialog-heading">Favorites</h2><button class="close" aria-label="Close favorites">×</button></div><p>Choose favorites for this browser. They are marked on Home and collected in Favorites.</p><form id="favorites-form">${apps.map(a=>`<label class="check-row"><input type="checkbox" name="favorite" value="${a.id}" ${preferences.favorites.includes(a.id)?'checked':''}>${a.name}</label>`).join('')}<button class="primary" type="submit">Save favorites</button></form>`;
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
  $('content').innerHTML=`<section class="page-heading"><h1>Settings</h1></section><section class="app-group"><h2 class="eyebrow">Your hub</h2><button class="app-row" id="settings-favorites">${icon('favorites')}<span><strong>Favorites</strong><small>Choose your favorite apps</small></span>${icon('chevron')}</button><a class="app-row" href="/server/">${icon('server')}<span><strong>Connection & status</strong><small>Message sync and service details</small></span>${icon('chevron')}</a></section><section class="reading"><h2>One shared conversation</h2><p>Relay messages and Daily Board are shared across phones. Favorites and notes are saved in this browser.</p><h2>Your player</h2><p>DrawerCast has its own full player and settings. Music stays on your phone or server.</p><h2>About</h2><p>Jarvis · version 1.1<br>Dark interface inspired by your Poweramp player.</p></section>`;
  $('settings-favorites').onclick=editFavorites;
}
function drawChat() {
  $('content').innerHTML = `<div class="conversation-search" id="chat-search-bar" hidden><label class="sr-only" for="conversation-search">Search messages</label><input id="conversation-search" type="search" placeholder="Search this conversation" autocomplete="off"><button class="icon-button" id="chat-search-close" type="button" aria-label="Close search">${uiIcon('close')}</button></div><section class="chat-panel"><div class="messages" id="messages" aria-label="Public Relay conversation"></div><div class="conversation-notice" id="relay-sync-notice" hidden><p id="relay-sync-error" role="status"></p><button class="text-button" type="button" id="relay-retry">Retry sync</button></div><form class="composer" id="message-form"><div class="composer-input"><label class="sr-only" for="message-text">Message Relay publicly</label><textarea id="message-text" rows="1" maxlength="4000" placeholder="Message Relay publicly…" required>${escape(state.composer || '')}</textarea><button class="primary send-icon" type="submit" id="send-message" aria-label="Send message">${uiIcon('send')}</button></div><div class="composer-bottom"><span id="relay-status" role="status">${API_ORIGIN?'Opening public inbox…':'Draft mode · saved on this device'}</span></div></form></section>`;
  const input=$('message-text');
  const saveDraft=value=>{try{commit({...state,composer:value});}catch{notify('Could not save your draft. Copy your text before leaving.');}};
  input.oninput=()=>{saveDraft(input.value);autosize(input);};
  input.onkeydown=e=>{if(e.key==='Enter' && (e.ctrlKey||e.metaKey) && !e.isComposing){e.preventDefault();$('message-form').requestSubmit();}};
  $('message-form').onsubmit=e=>{e.preventDefault();submitMessage();};
  chatUI=conversation({panel:$('messages'),composer:input,channel:'relay',author:'Jarvis',notify,draftChanged:saveDraft,emptyTitle:'A little room to think.',emptyDescription:'Ask Jarvis a question or leave a thought. Replies arrive after the next inbox check.',scope:'Public conversation'});
  chatUI.update(channelMessages(state.messages));
  $('conversation-search').oninput=e=>chatUI.search(e.target.value);
  $('chat-search-close').onclick=()=>$('chat-search-toggle').click();
  $('relay-retry').onclick=sync;
  const transferred=sessionStorage.getItem('jarvis.relay.transfer.v1');
  if(transferred){input.value=(input.value?input.value+'\n\n':'')+transferred;input.value=input.value.slice(0,4000);saveDraft(input.value);sessionStorage.removeItem('jarvis.relay.transfer.v1');}
  autosize(input);
  renderPublicStatus();
}
function renderPublicStatus(){
  if(!chatUI||!$('relay-status'))return;
  $('relay-status').textContent=syncError?state.outbox.length?'Send unconfirmed · queued safely on this device':'Inbox unavailable · draft saved':busy?state.outbox.length?'Sending to public inbox…':'Refreshing public inbox…':state.outbox.length?'Queued on this device':state.publisher?.ok===false?'Messages saved · replies delayed':'Public inbox · replies arrive after a check';
  $('relay-sync-notice').hidden=!syncError;$('relay-sync-error').textContent=syncError?'Could not confirm the latest sync. Your draft and queued messages are saved.':'';$('relay-retry').disabled=busy;
  chatUI.setDelivery?.({busy,error:!!syncError});
}
function messageMarkup(m) {
  return `<article data-message-id="${escape(m.id)}" class="message-row ${m.role==='user'?'outgoing':'incoming'}"><span class="message-author">${m.role==='user'?'YOU':m.kind==='reply'?'JARVIS':'JARVIS · AUTOMATIC RECEIPT'}</span><p class="bubble">${escape(m.body)}</p><span class="message-time">${time(m.createdAt)} · ${m.saved?'Cloud saved':'Not sent · on this device'}</span></article>`;
}
function submitMessage() {
  // A stale public form/event must never submit an owner draft to the shared inbox.
  if (ownerUI.mode !== 'public') return;
  const body = $('message-text').value.trim();
  if (!body) return;
  const item = { id: crypto.randomUUID(), body, role: 'user', createdAt: new Date().toISOString(), saved: false };
  try {
    commit({ ...state, composer: '', messages: [...state.messages,item], outbox: [...state.outbox,{...item,type:'message'}] });
    $('message-text').value='';autosize($('message-text'));chatUI.update(channelMessages(state.messages));chatUI.latest(); if (API_ORIGIN) sync(); else notify('Draft saved on this device. It has not been sent.');
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
  renderPublicStatus();
  $('connection-button').lastElementChild.textContent = connection();
  try {
    if(state.legacyPending){
      const old=JSON.parse(localStorage.getItem(LEGACY_KEY)||'null');
      if(!old?.key)throw Error('Previous inbox is unavailable. Existing drafts have been preserved.');
      const remote=await request('/shared/migrate',{}, {Authorization:'Bearer '+old.key});
      commit(mergeState({...state,legacyPending:false},remote));
    }
    // A lost POST response may already have saved the UUID. Confirm first so a
    // retry sends only entries still missing from the complete public history.
    if(state.outbox.length)commit(mergeState(state,await request('/shared/state')));
    for (const item of [...state.outbox]) {
      const remote = await request('/shared/messages',{id:item.id,body:item.body});
      commit(mergeState({...state,outbox:state.outbox.filter(x=>x.id!==item.id)},remote));
    }
    commit(mergeState(state,await request('/shared/state')));
  } catch (e) { syncError = e.message || 'Cloud unavailable. Your drafts are safe.'; notify(syncError); }
  finally {
    busy = false;
    if(route==='chat' && chatUI){
      chatUI.update(channelMessages(state.messages));
      renderPublicStatus();
    } else if(route==='board') drawShell();
    if ($('connection-button')) $('connection-button').lastElementChild.textContent=connection();
    if ($('connection-dialog').open) { $('connection-state').textContent = connection(); $('sync-now').disabled=false; }
  }
}
document.addEventListener('click', e => {
  const link = e.target.closest('[data-route]');
  if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault(); $('hub-dialog')?.close();
  if (route !== link.dataset.route) { route = link.dataset.route; history.pushState({},'',paths[route]); }
  drawShell(); window.scrollTo(0,0);
});
window.addEventListener('popstate',()=>{ route=getRoute(); drawShell(); });
window.addEventListener('online',sync);
window.addEventListener('pageshow',updateClock);
document.addEventListener('visibilitychange',updateClock);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden && API_ORIGIN && !busy && (!state.syncedAt || Date.now()-Date.parse(state.syncedAt)>60000)) sync(); });
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
$('sync-now').onclick = sync;
drawShell();
if (API_ORIGIN) sync();


setInterval(()=>{if(!document.hidden)sync();},30000);
window.addEventListener('storage',e=>{if(e.key===STORAGE_KEY&&!busy){try{state=readState(localStorage);if(route==='chat'&&chatUI)chatUI.update(channelMessages(state.messages));else if(route==='board')drawShell();}catch{}}});
window.addEventListener('storage',e=>{if(e.key===OWNER_SESSION_KEY)ownerController.storedSessionChanged();});
