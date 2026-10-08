import {icon, sheet, appViewport, autosize} from './ui.js';
import {conversation} from './conversation.js';
import {createDirectApi} from './direct-api.js';
import {museBody} from './channels.js';
import {MUSE_STORAGE_KEY, MAX_MESSAGE, readMuse, queueMuse, mergeMuse} from './muse-store.js';

const $ = id => document.getElementById(id);
const request = createDirectApi();
let state, busy = false, storageError = '', syncError = '', chatUI, toastTimer;
appViewport();
document.querySelectorAll('[data-icon]').forEach(n=>n.innerHTML=icon(n.dataset.icon));
function notify(value){$('toast').textContent=value;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3500);}
const time = value => new Intl.DateTimeFormat(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}).format(new Date(value));
try { state = readMuse(localStorage); localStorage.setItem(MUSE_STORAGE_KEY, JSON.stringify(state)); }
catch (e) { storageError = e.message || 'Browser storage is unavailable. Keep your text here or copy it before leaving.'; }
function commit(next) {
  localStorage.setItem(MUSE_STORAGE_KEY, JSON.stringify(next));
  state = next;
}
function render() {
  $('send').disabled=!!storageError;
  $('refresh').disabled=busy||!!storageError;
  $('error').hidden=!storageError&&!syncError;
  $('error').textContent=storageError||syncError;
  $('muse-sync-notice').hidden=!storageError&&!syncError;
  $('muse-retry').hidden=!!storageError;$('muse-retry').disabled=busy;
  $('status').textContent=storageError?'Cannot save on this device':syncError?state?.outbox.length?'Send unconfirmed · queued on this device':'Inbox unavailable · draft saved':busy?state?.outbox.length?'Sending to public Muse inbox…':'Refreshing public inbox…':state?.outbox.length?'Queued on this device':state?.publisher?.ok===false?'Messages saved · replies delayed':'Public inbox · replies arrive after a check';
  if(!state)return;
  if(!chatUI)chatUI=conversation({panel:$('messages'),composer:$('prompt'),channel:'muse',author:'Muse',body:m=>m.role==='user'?museBody(m.body):m.body,notify,draftChanged:value=>{try{commit({...state,composer:value});}catch{notify('Draft could not be saved');}},emptyTitle:'Follow a thought.',emptyDescription:'Write to Muse when you have an idea to explore. Replies appear here after Muse checks this public inbox.',scope:'Public Muse conversation'});
  chatUI.update(state.messages);
  chatUI.setDelivery({busy,error:!!syncError});
}
async function sync() {
  if (busy || storageError) return;
  busy = true; syncError = ''; render();
  try {
    // Read first: a previous POST may have succeeded before its response was lost.
    commit(mergeMuse(state, await request('/shared/state')));
    while (state.outbox.length) {
      const message = state.outbox[0];
      const remote = await request('/shared/messages', {id: message.id, body: message.body});
      commit(mergeMuse(state, remote));
      if (state.outbox.some(m => m.id === message.id)) throw Error('Message acceptance could not be confirmed. Refresh to retry the same message.');
    }
  } catch (e) { syncError = e.message || 'Sync failed. Queued messages remain on this device.'; }
  finally { busy = false; render(); }
}
$('prompt').maxLength = MAX_MESSAGE;
$('prompt').value = state?.composer || '';
$('prompt').oninput = () => {
  if (storageError) return;
  autosize($('prompt'));
  try { commit({...state, composer: $('prompt').value}); }
  catch { storageError = 'Could not save your draft. Copy your text before leaving this page.'; render(); }
};
$('composer').onsubmit = e => {
  e.preventDefault(); if (storageError || !$('prompt').value.trim()) return;
  try {
    commit(queueMuse(state, $('prompt').value, crypto.randomUUID(), new Date().toISOString()));
    $('prompt').value = ''; autosize($('prompt'));render();chatUI.latest();sync();
  } catch (e) { syncError = e.message; render(); }
};
$('prompt').onkeydown = e => {
  if (e.key === 'Enter' && (e.ctrlKey||e.metaKey) && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
};
$('refresh').onclick = sync;
$('muse-retry').onclick=sync;
$('setup').onclick = async () => {
  $('setup-dialog').showModal(); $('copy-status').textContent = 'Loading instructions…'; $('copy-setup').disabled = true;
  try {
    const response = await fetch('/muse/setup.txt', {cache:'no-store'});
    if (!response.ok) throw Error('Instructions could not be loaded. Use the full instructions link.');
    $('setup-text').value = await response.text(); $('copy-status').textContent = ''; $('copy-setup').disabled = false;
  } catch(e) { $('copy-status').textContent = e.message; }
};
$('close-setup').onclick = () => $('setup-dialog').close();
$('copy-setup').onclick = async () => {
  try { await navigator.clipboard.writeText($('setup-text').value); $('copy-status').textContent = 'Copied. Paste into your existing Muse chat.'; }
  catch { $('setup-text').focus(); $('setup-text').select(); $('copy-status').textContent = 'Select and copy the instructions above, then paste into Muse.'; }
};
window.addEventListener('online', sync);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
setInterval(() => { if (!document.hidden) sync(); }, 30000);
render(); sync();

$('search-toggle').onclick=()=>{const bar=$('search-bar');bar.hidden=!bar.hidden;if(!bar.hidden)$('conversation-search').focus();else{$('conversation-search').value='';chatUI?.search('');}};
$('search-close').onclick=()=>$('search-toggle').click();
$('conversation-search').oninput=e=>chatUI?.search(e.target.value);
$('muse-menu').onclick=()=>{
  const d=sheet('Public Muse',[{label:'Search messages',icon:'search',action:()=>$('search-toggle').click()},{label:'Bookmarks',icon:'bookmark',action:()=>chatUI?.bookmarks()},{label:'Latest messages',icon:'chat',action:()=>chatUI?.latest()},{label:'Refresh inbox',icon:'refresh',action:sync},{label:'Connection details',icon:'info',action:()=>{const detail=sheet('Muse connection',[]);detail.classList.add('conversation-sheet');const p=document.createElement('p');p.className='sheet-context';p.textContent=storageError||syncError||(state?.syncedAt?'Public inbox refreshed '+time(state.syncedAt)+'. Messages are stored separately from the assistant’s reply delivery.':'The public inbox has not been refreshed yet.');detail.append(p);const note=document.createElement('p');note.className='sheet-note';note.textContent='This page checks for saved replies. It cannot confirm that Muse has an active schedule or is currently working.';detail.append(note);}},{label:'Reply setup instructions',icon:'clock',action:()=>$('setup').click()}]);
  d.classList.add('conversation-sheet');const p=document.createElement('p');p.className='sheet-context';p.textContent='Anyone with this website address can read and post here. Muse has its own public inbox; private owner Relay stays separate.';d.querySelector('.dialog-heading').after(p);const note=document.createElement('p');note.className='sheet-note';note.textContent='Replies arrive after Muse checks the inbox. Publication may take another five minutes. No active schedule is confirmed by this page.';d.append(note);
  const relay=document.createElement('a');relay.href='/jarvis/';relay.className='sheet-action';relay.innerHTML=icon('chat');relay.append(document.createTextNode('Relay conversations'));note.before(relay);
};
addEventListener('pagehide',()=>chatUI?.savePosition());
autosize($('prompt'));
