import {STORAGE_KEY, parseHistory, streamReply} from './quick-ai-core.js';

const $ = id => document.getElementById(id);
let state, storageOK = true, key = '', run = null;
try { state = parseHistory(localStorage.getItem(STORAGE_KEY)); }
catch { state = parseHistory(null); storageOK = false; warn('Saved chats could not be read. This session will not overwrite them. Copy anything you want to keep.'); }
function warn(message) { $('storage-status').hidden = false; $('storage-status').textContent = message; }
function save() {
  if (!storageOK) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { warn('This browser could not save your latest changes. Copy anything you want to keep before leaving.'); }
}
const current = () => state.chats.find(c => c.id === state.active);
function createChat() {
  const chat = {id: crypto.randomUUID(), title: 'New chat', draft: '', messages: []};
  state.chats.unshift(chat); state.active = chat.id; return chat;
}
if (!current()) { if (state.chats.length) state.active = state.chats[0].id; else createChat(); }

function renderHistory() {
  $('history').replaceChildren(...state.chats.map(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.title; return o; }));
  $('history').value = state.active;
}
function messageElement(m) {
  const article = document.createElement('article'); article.className = 'ai-message ' + m.role;
  const heading = document.createElement('h2'); heading.textContent = m.role === 'user' ? 'You' : 'Quick AI';
  const body = document.createElement('div'); body.className = 'body'; body.textContent = m.content || (m.status === 'streaming' ? 'Thinking…' : 'No reply received.');
  article.append(heading, body);
  if (m.role === 'assistant' && m.status !== 'streaming') {
    if (m.status !== 'complete' || m.truncated) { const note = document.createElement('p'); note.className = 'message-note'; note.textContent = m.truncated ? 'Reply reached its length limit. Ask to continue.' : 'Reply interrupted. You can retry.'; article.append(note); }
    if (m.content) { const copy = document.createElement('button'); copy.className = 'text-button copy'; copy.textContent = 'Copy'; copy.onclick = async () => { try { await navigator.clipboard.writeText(m.content); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select text to copy'; } }; article.append(copy); }
  }
  return article;
}
function render() {
  renderHistory(); $('prompt').value = current().draft;
  $('messages').replaceChildren(...current().messages.map(messageElement));
  if (!current().messages.length) {
    const empty = document.createElement('div'); empty.className = 'empty-chat';
    const h = document.createElement('h1'); h.textContent = 'What’s on your mind?';
    const p = document.createElement('p'); p.textContent = 'Fast answers, writing help, and ideas. Start a conversation here. Quick AI has no live web access.';
    empty.append(h, p); $('messages').append(empty);
  }
  controls();
}
function controls() {
  const busy = !!run, last = current().messages.at(-1);
  $('send').disabled = busy || !key || !$('prompt').value.trim(); $('send').hidden = busy;
  $('stop').hidden = !busy; $('prompt').disabled = busy; $('messages').setAttribute('aria-busy', String(busy));
  $('retry').hidden = busy || !key || !(last?.role === 'user' || last?.status === 'interrupted');
  $('new-chat').disabled = busy; $('history').disabled = busy; $('delete-chat').disabled = busy;
}
function restoreStatus() { $('status').textContent = key ? 'Ready · Free usage limits apply' : 'Connecting…'; }
$('prompt').addEventListener('input', () => { current().draft = $('prompt').value; save(); controls(); });
$('prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('composer').requestSubmit(); } });
$('new-chat').onclick = () => {
  if (run) return;
  if (!current().messages.length) { $('prompt').focus(); return; }
  if (state.chats.length >= 50) { $('status').textContent = 'You have 50 saved chats. Delete an old chat to start another.'; return; }
  createChat(); save(); render(); restoreStatus(); $('prompt').focus();
};
$('history').onchange = () => { if (run) return; state.active = $('history').value; save(); render(); restoreStatus(); };
$('delete-chat').onclick = () => {
  if (run || !confirm('Delete this chat from this device?')) return;
  state.chats = state.chats.filter(c => c.id !== state.active);
  if (state.chats.length) state.active = state.chats[0].id; else createChat();
  save(); render(); restoreStatus();
};
$('stop').onclick = () => run?.controller.abort();
$('retry').onclick = () => send(true);
$('composer').onsubmit = e => { e.preventDefault(); send(false); };
async function send(retry) {
  if (run || !key) return;
  const chat = current();
  if (retry) {
    if (chat.messages.at(-1)?.status === 'interrupted') chat.messages.pop();
    if (chat.messages.at(-1)?.role !== 'user') return;
  } else {
    const text = $('prompt').value.trim(); if (!text) return;
    chat.messages.push({role: 'user', content: text}); chat.draft = '';
    if (chat.messages.length === 1) chat.title = text.slice(0, 60);
  }
  const reply = {role: 'assistant', content: '', status: 'streaming'}; chat.messages.push(reply);
  const controller = new AbortController(); run = {controller}; let timeout = false;
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, 120000);
  save(); render(); $('status').textContent = 'Thinking…';
  const body = $('messages').lastElementChild.querySelector('.body');
  let lastSave = Date.now();
  try {
    const result = await streamReply({key, messages: chat.messages, signal: controller.signal, onText: text => {
      const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
      reply.content = text; body.textContent = text; $('status').textContent = 'Replying…';
      if (Date.now() - lastSave > 1000) { save(); lastSave = Date.now(); }
      if (nearBottom) window.scrollTo(0, document.documentElement.scrollHeight);
    }});
    reply.status = 'complete'; reply.truncated = result.truncated;
    $('status').textContent = result.truncated ? 'Ask to continue for more.' : 'Ready · Free usage limits apply';
  } catch (error) {
    reply.status = 'interrupted';
    $('status').textContent = controller.signal.aborted ? (timeout ? 'The reply timed out. Tap Retry.' : 'Stopped. Tap Retry to try again.') : (error instanceof TypeError ? 'Could not connect to Groq. Check your connection and tap Retry.' : error.message);
  } finally {
    clearTimeout(timer); run = null; save(); render();
  }
}
window.addEventListener('pagehide', () => { run?.controller.abort(); save(); });
render();
try {
  const response = await fetch('/assets/quick-ai-config.json', {cache: 'no-store'});
  if (!response.ok) throw new Error('Quick AI configuration is unavailable. Reload to try again.');
  key = (await response.json()).apiKey;
  if (typeof key !== 'string' || !key) throw new Error('Quick AI has not been configured yet.');
  restoreStatus(); controls();
} catch (error) { key = ''; $('status').textContent = error.message; }
