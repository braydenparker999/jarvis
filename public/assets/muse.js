import {createDirectApi} from './direct-api.js';
import {museBody} from './channels.js';
import {MUSE_STORAGE_KEY, MAX_MESSAGE, readMuse, queueMuse, mergeMuse} from './muse-store.js';

const $ = id => document.getElementById(id);
const request = createDirectApi();
let state, busy = false, storageError = '', syncError = '', rendered = '';
const time = value => new Intl.DateTimeFormat(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}).format(new Date(value));
try { state = readMuse(localStorage); localStorage.setItem(MUSE_STORAGE_KEY, JSON.stringify(state)); }
catch (e) { storageError = e.message || 'Browser storage is unavailable. Keep your text here or copy it before leaving.'; }
function commit(next) {
  localStorage.setItem(MUSE_STORAGE_KEY, JSON.stringify(next));
  state = next;
}
function render() {
  $('send').disabled = !!storageError;
  $('refresh').disabled = busy || !!storageError;
  $('error').hidden = !storageError && !syncError;
  $('error').textContent = storageError || syncError;
  $('status').textContent = storageError ? 'Cannot save on this device' : busy ? 'Syncing…' : state.outbox.length ? 'Queued on this device · retrying on refresh' : !state.syncedAt ? 'Not connected yet' : state.publisher?.ok === false ? 'Messages saved · reply import delayed' : 'Inbox synced · ' + time(state.syncedAt);
  if (!state) return;
  const serialized = JSON.stringify(state.messages);
  if (serialized === rendered) return;
  rendered = serialized;
  const panel = $('messages');
  const bottom = panel.scrollHeight - panel.clientHeight - panel.scrollTop < 60;
  const oldScroll = panel.scrollTop;
  const answered = new Set(state.messages.filter(m => m.kind === 'reply').map(m => m.replyTo));
  panel.replaceChildren();
  if (!state.messages.length) {
    const empty = document.createElement('p'); empty.className = 'chat-empty';
    empty.textContent = 'A conversation with your Muse agent. Send a message, then activate automatic checks in Setup.'; panel.append(empty);
  }
  for (const message of state.messages) {
    const user = message.role === 'user';
    const article = document.createElement('article'); article.className = 'message-row ' + (user ? 'outgoing' : 'incoming'); article.dataset.messageId = message.id;
    const author = document.createElement('span'); author.className = 'message-author'; author.textContent = user ? 'YOU' : 'MUSE';
    const body = document.createElement('p'); body.className = 'bubble';
    // Render only text and explicit HTTP(S) links; never execute agent markup.
    const text = user ? museBody(message.body) : message.body;
    for (const part of text.split(/(https?:\/\/[^\s<>]+)/g)) {
      if (/^https?:\/\//.test(part)) {
        const link = document.createElement('a'); link.href = part; link.textContent = part; link.target = '_blank'; link.rel = 'noopener noreferrer'; body.append(link);
      } else body.append(document.createTextNode(part));
    }
    const stamp = document.createElement('span'); stamp.className = 'message-time';
    stamp.textContent = time(message.createdAt) + ' · ' + (!message.saved ? 'Not sent · saved on this device' : user && !answered.has(message.id) ? 'Cloud saved · awaiting Muse' : 'Cloud saved');
    article.append(author, body, stamp); panel.append(article);
  }
  const last = state.messages.filter(m => m.kind === 'reply').at(-1);
  $('last-reply').textContent = last ? 'Last reply: ' + time(last.createdAt) + '.' : '';
  panel.scrollTop = bottom ? panel.scrollHeight : oldScroll;
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
  try { commit({...state, composer: $('prompt').value}); }
  catch { storageError = 'Could not save your draft. Copy your text before leaving this page.'; render(); }
};
$('composer').onsubmit = e => {
  e.preventDefault(); if (storageError || !$('prompt').value.trim()) return;
  try {
    commit(queueMuse(state, $('prompt').value, crypto.randomUUID(), new Date().toISOString()));
    $('prompt').value = ''; render(); $('messages').scrollTop = $('messages').scrollHeight; sync();
  } catch (e) { syncError = e.message; render(); }
};
$('prompt').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
};
$('refresh').onclick = sync;
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
