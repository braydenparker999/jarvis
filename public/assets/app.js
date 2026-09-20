import { API_ORIGIN } from './config.js';
import { STORAGE_KEY, readState, mergeState } from './store.js';
import { PREVIOUS_WORKSPACE, linkedState, saveLinkedState } from './devices.js';

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
let route = location.pathname.startsWith('/daily-board') ? 'board' : location.pathname.startsWith('/jarvis') ? 'chat' : 'home';
const paths = { home: '/', chat: '/jarvis/', board: '/daily-board/' };
const labels = { home: 'Home', chat: 'Jarvis', board: 'Daily Board' };
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
  if (!navigator.onLine || syncError) return 'Offline · drafts saved';
  return state.syncedAt ? 'Connected' : 'Connecting';
}
function drawShell() {
  $('app').innerHTML = `<aside class="sidebar"><a class="brand" href="/" data-route="home"><span class="brand-mark">J</span><span>JARVIS<small>PERSONAL HUB</small></span></a><nav aria-label="Main navigation">${Object.entries(labels).map(([key,label])=>`<a href="${paths[key]}" data-route="${key}" ${key===route?'aria-current="page"':''}>${svg(key==='chat'?'chat':key==='board'?'board':'home')}<span>${label}</span></a>`).join('')}</nav><div class="sidebar-foot"><span class="status-dot"></span> Your space. One place.<small>VERSION 0.3</small></div></aside><div class="workspace"><header class="topbar"><span class="breadcrumb">PERSONAL / <strong>${labels[route].toUpperCase()}</strong></span><button class="connection" id="connection-button" aria-label="Connection details"><span class="status-dot ${API_ORIGIN && state?.syncedAt && !syncError?'':'pending'}"></span><span>${connection()}</span></button></header><main id="content"></main><footer class="footnote">JARVIS <span>Built one useful thing at a time.</span></footer></div>`;
  $('connection-button').onclick = showConnection;
  drawPage();
}
function drawPage() {
  if (storageError) { $('content').innerHTML = `<div class="empty"><h1>Unable to save on this device</h1><p>${escape(storageError)}</p><p>Existing data has not been changed. Allow browser storage, then reload.</p></div>`; return; }
  if (route === 'home') drawHome();
  if (route === 'chat') drawChat();
  if (route === 'board') drawBoard();
}
function drawHome() {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const latest = [...state.posts].reverse()[0];
  $('content').innerHTML = `<section class="greeting"><p class="eyebrow">${escape(date)}</p><h1>${greeting}, Brayden<span class="mint">.</span></h1><p class="subheading">A space for your thoughts, updates, and everyday life.</p></section><div class="home-grid"><section class="card feature"><div class="card-top"><span class="eyebrow">JARVIS</span><span class="pill">${API_ORIGIN?'INBOX':'DRAFT MODE'}</span></div><div class="orb" aria-hidden="true"><span></span></div><h2>What's on your mind?</h2><p>Keep a thought. Start a conversation.</p><a class="primary" href="/jarvis/" data-route="chat">Open Jarvis ${svg('arrow')}</a><small>${API_ORIGIN?'Messages save to your inbox. Scheduled replies are not enabled yet.':'Drafts save here while cloud messaging is being connected.'}</small></section><section class="card board-preview"><div class="card-top"><span class="eyebrow">DAILY BOARD</span>${svg('board')}</div><h2>${latest?escape(latest.title):'Your daily briefing.'}</h2><p class="preview-body">${latest?escape(latest.body):'Daily updates from Jarvis will appear here once scheduled briefings are connected.'}</p>${latest?`<span class="entry-meta">${time(latest.createdAt)} · ${latest.saved?'Cloud saved':'On this device'}</span>`:''}<a class="text-link" href="/daily-board/" data-route="board">${latest?'Read your briefing':'Open Daily Board'} ${svg('arrow')}</a></section><section class="card activity"><div><span class="eyebrow">AT A GLANCE</span><h2>Your hub, so far.</h2></div><div class="stats"><div><strong>${state.posts.length}</strong><span>Board entries</span></div><div><strong>${state.messages.filter(m=>m.role==='user').length}</strong><span>Messages</span></div><div><strong>${state.outbox.length}</strong><span>Awaiting sync</span></div></div></section></div>`;
}
function drawChat() {
  $('content').innerHTML = `<section class="page-heading"><div><p class="eyebrow">YOUR CONVERSATION SPACE</p><h1>Jarvis<span class="mint">.</span></h1></div><span class="pill">${API_ORIGIN?'INBOX':'DRAFT MODE'}</span></section><section class="chat-panel"><div class="chat-notice">${API_ORIGIN?'Messages are saved for Jarvis. Hourly replies are not enabled yet.':'Cloud messaging is not connected yet. Your drafts stay on this device and have not been sent.'}</div><div class="messages" id="messages" aria-label="Conversation">${state.messages.length?state.messages.map(messageMarkup).join(''):`<div class="chat-empty"><div class="orb small" aria-hidden="true"><span></span></div><h2>A place to pick up your thoughts.</h2><p>Write a message below. ${API_ORIGIN?'Jarvis will confirm when it is saved.':'It will wait here until cloud messaging is ready.'}</p></div>`}</div><form class="composer" id="message-form"><label class="sr-only" for="message-text">Message Jarvis</label><textarea id="message-text" rows="2" maxlength="4000" placeholder="Write something…" required>${escape(state.composer || '')}</textarea><div class="composer-bottom"><span>${API_ORIGIN?'Enter to send · Shift + Enter for a new line':'Saved on this device · not sent'}</span><button class="primary" type="submit" id="send-message">${API_ORIGIN?'Send':'Save draft'} ${svg('send')}</button></div></form></section>`;
  $('message-text').oninput = e => { try { commit({ ...state, composer: e.target.value }); } catch { notify('Could not save your draft. Keep this page open and copy your text.'); } };
  $('message-text').onkeydown = e => { if (e.key==='Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('message-form').requestSubmit(); } };
  $('message-form').onsubmit = e => { e.preventDefault(); submitMessage(); };
  const messages = $('messages'); messages.scrollTop = messages.scrollHeight;
}
function messageMarkup(m) {
  return `<article class="message-row ${m.role==='user'?'outgoing':'incoming'}"><span class="message-author">${m.role==='user'?'YOU':m.kind==='reply'?'JARVIS':'JARVIS · AUTOMATIC RECEIPT'}</span><p class="bubble">${escape(m.body)}</p><span class="message-time">${time(m.createdAt)} · ${m.saved?'Cloud saved':'Not sent · on this device'}</span></article>`;
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
  $('content').innerHTML = `<section class="page-heading"><div><p class="eyebrow">YOUR DAILY BRIEFING</p><h1>Daily Board<span class="mint">.</span></h1><p class="subheading">Your briefing from Jarvis.</p></div><button class="primary" id="new-entry" hidden>${svg('plus')} New entry</button></section><div class="board-list">${state.posts.length?[...state.posts].reverse().map(p=>`<article class="card board-entry"><div class="card-top"><span class="eyebrow">${time(p.createdAt)}</span><span class="pill">${p.saved?'CLOUD SAVED':'ON THIS DEVICE'}</span></div><h2>${escape(p.title)}</h2><p>${escape(p.body)}</p></article>`).join(''):`<section class="card empty-board"><span class="empty-icon">${svg('board')}</span><h2>Your briefing will appear here.</h2><p>Jarvis will publish your daily briefing here once the scheduled responder is connected.</p></section>`}</div><p class="board-note">${API_ORIGIN?'Briefings sync with your connected workspace.':'Entries are saved on this device. Cloud sync and scheduled updates are not connected yet.'}</p>`;
  $('new-entry').onclick = showEntry;
  if ($('first-entry')) $('first-entry').onclick = showEntry;
}
function showEntry() {
  $('entry-title').value = state.boardTitle || '';
  $('entry-body').value = state.boardBody || '';
  $('entry-save').textContent = API_ORIGIN ? 'Save entry' : 'Save on this device';
  $('entry-dialog').showModal(); $('entry-title').focus();
}
function showConnection() {
  $('connection-state').textContent = connection();
  $('connection-detail').textContent = !API_ORIGIN ? 'Your hub is live. Cloud storage is awaiting connection. Messages and board entries currently save only in this browser; clearing browser data will remove them.' : syncError || (state.syncedAt ? `Last synced ${time(state.syncedAt)}. Your messages and entries are stored outside Azure.` : 'Ready to connect to your workspace.');
  $('sync-now').hidden = !API_ORIGIN || !!storageError;
  $('sync-now').disabled = busy;
  $('connection-dialog').showModal();
}
async function request(path, body) {
  const response = await fetch(API_ORIGIN + path, { method: body?'POST':'GET', headers: { Authorization: `Bearer ${state.key}`, ...(body?{'Content-Type':'application/json'}:{}) }, body:body?JSON.stringify(body):undefined, signal:AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(response.status===429?'Daily or request limit reached. Your drafts are safe; try again later.':`Cloud connection failed (${response.status}). Your drafts are safe.`);
  return response.json();
}
async function sync() {
  if (!API_ORIGIN || busy || storageError) return;
  busy = true; syncError = '';
  $('connection-button').lastElementChild.textContent = connection();
  try {
    for (const item of [...state.outbox]) {
      const remote = await request(item.type==='message'?'/v1/messages':'/v1/board',item);
      commit(mergeState({...state,outbox:state.outbox.filter(x=>x.id!==item.id)},remote));
    }
    commit(mergeState(state,await request('/v1/state')));
  } catch (e) { syncError = e.message || 'Cloud unavailable. Your drafts are safe.'; notify(syncError); }
  finally {
    busy = false;
    // Composer values persist on input, so redraws do not discard unsent text.
    const active = document.activeElement?.id;
    const start = document.activeElement?.selectionStart;
    drawShell();
    if (active && $(active)) { $(active).focus(); if (typeof start==='number') $(active).setSelectionRange(start,start); }
    if ($('connection-dialog').open) { $('connection-state').textContent = connection(); $('sync-now').disabled=false; }
  }
}
document.addEventListener('click', e => {
  const link = e.target.closest('[data-route]');
  if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault(); route = link.dataset.route; history.pushState({},'',paths[route]); drawShell(); window.scrollTo(0,0);
});
window.addEventListener('popstate',()=>{ route=location.pathname.startsWith('/daily-board')?'board':location.pathname.startsWith('/jarvis')?'chat':'home'; drawShell(); });
window.addEventListener('online',sync);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden && API_ORIGIN && !busy && (!state.syncedAt || Date.now()-Date.parse(state.syncedAt)>60000)) sync(); });
for (const id of ['entry-title','entry-body']) $(id).oninput = () => { try { commit({...state,boardTitle:$('entry-title').value,boardBody:$('entry-body').value}); } catch { notify('Could not save this draft. Copy your text before leaving.'); } };
$('entry-form').onsubmit = e => {
  e.preventDefault();
  const title=$('entry-title').value.trim(),body=$('entry-body').value.trim();
  if(!title || !body) return;
  const item={id:crypto.randomUUID(),title,body,createdAt:new Date().toISOString(),saved:false};
  try { commit({...state,boardTitle:'',boardBody:'',posts:[...state.posts,item],outbox:[...state.outbox,{...item,type:'board'}]}); $('entry-dialog').close(); drawShell(); if(API_ORIGIN)sync();else notify('Entry saved on this device.'); } catch { notify('Could not save. Your entry is still in the form.'); }
};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
$('sync-now').onclick = sync;
drawShell();
if (API_ORIGIN) sync();

$('connect-responder').onclick = async () => {
  $('connect-responder').disabled=true;
  try {
    const access=await request('/v1/responder/connect',{});
    $('responder-code').value=access.token;
    $('responder-access').hidden=false;
    $('responder-info').textContent='This code grants inbox reading and replies until you disconnect it. Enter it only in the responder connection form, never in a chat or public repository. Connecting again replaces the previous connection.';
  } catch(e) { notify(e.message); }
  finally { $('connect-responder').disabled=false; }
};
$('copy-responder').onclick=async()=>{
  try {await navigator.clipboard.writeText($('responder-code').value);notify('Connection code copied.');}
  catch { $('responder-code').select(); notify('Select and copy the connection code.'); }
};
$('revoke-responder').onclick=async()=>{
  try {await request('/v1/responder/revoke',{});$('responder-code').value='';$('responder-access').hidden=true;notify('Responder access disconnected.');}
  catch(e){notify(e.message);}
};

$('link-device').onclick = () => {
  if (storageError) { notify(storageError); return; }
  $('device-code').value = state.key;
  $('incoming-device-code').value = '';
  $('device-status').textContent = '';
  $('restore-device').hidden = !localStorage.getItem(PREVIOUS_WORKSPACE);
  $('connection-dialog').close();
  $('device-dialog').showModal();
};
$('device-dialog').addEventListener('close', () => {
  $('device-code').value = '';
  $('incoming-device-code').value = '';
});
$('copy-device-code').onclick = async () => {
  try { await navigator.clipboard.writeText($('device-code').value); $('device-status').textContent = 'Copied. Paste it into Jarvis on your other phone.'; }
  catch { $('device-code').type='text'; $('device-code').select(); $('device-status').textContent='Select and copy the code, then close this window.'; }
};
$('device-dialog').addEventListener('close', () => { $('device-code').type='password'; });
async function useDeviceKey(key) {
  if (!API_ORIGIN || storageError) { $('device-status').textContent = 'Cloud access and browser storage are required.'; return; }
  if (busy) { $('device-status').textContent = 'Please wait for the current sync to finish, then try again.'; return; }
  if (key === state.key) { $('device-status').textContent = 'This device already uses that inbox.'; return; }
  if (!/^[a-f0-9]{64}$/.test(key)) { $('device-status').textContent = 'Paste the complete device code from your original phone.'; return; }
  busy=true;
  $('use-device-code').disabled=true;
  $('restore-device').disabled=true;
  $('device-status').textContent='Opening your saved inbox…';
  try {
    const response=await fetch(API_ORIGIN+'/v1/state', {headers:{Authorization:`Bearer ${key}`},cache:'no-store',signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error('Could not open that inbox. Nothing was changed. Try again when connected.');
    const next=linkedState(key,await response.json());
    state=saveLinkedState(localStorage,state,next);
    syncError='';
    $('responder-code').value='';
    $('responder-access').hidden=true;
    $('device-dialog').close();
    notify('Device linked. Your messages and Daily Board are ready.');
  } catch(e) { $('device-status').textContent=e.message || 'Could not link this device. Nothing was changed.'; }
  finally { busy=false; $('use-device-code').disabled=false; $('restore-device').disabled=false; drawShell(); }
}
$('device-link-form').onsubmit=e=>{ e.preventDefault(); useDeviceKey($('incoming-device-code').value.trim()); };
$('restore-device').onclick=()=>{
  try { const previous=readState({getItem:()=>localStorage.getItem(PREVIOUS_WORKSPACE)}); useDeviceKey(previous.key); }
  catch { $('device-status').textContent='The previous inbox could not be read. Use its saved device code.'; }
};
window.addEventListener('storage',e=>{
  if(e.key!==STORAGE_KEY || !e.newValue) return;
  try { if(JSON.parse(e.newValue).key!==state.key) location.reload(); } catch {}
});
