import { createRelayOwnerApi, OwnerApiError } from './relay-owner-api.js';
import { icon, autosize, copyText } from './ui.js';

// Private history, drafts and failed sends exist only in this closure. In particular,
// never pass them to conversation(), public submitMessage(), transfer or shared sync.
export function createRelayOwnerController({ api = createRelayOwnerApi(), uuid = () => crypto.randomUUID(), onModeChange = () => {} } = {}) {
  const listeners = new Set();
  let generation = 0, reading = null, failedSend = null, cursor = '0';
  let state = { mode: api.hasCredential ? 'owner' : 'public', status: api.hasCredential ? 'unknown' : 'none',
    messages: [], draft: '', devices: [], device: null, pairing: null, error: '', warning: '', busy: false, sending: false, query: '' };
  const emit = () => { for (const listener of listeners) listener(); };
  const mode = next => { if (next !== state.mode) { state.mode = next; onModeChange(next); } emit(); };
  function clearPrivate() { state.messages = []; state.draft = ''; state.devices = []; state.device = null; failedSend = null; cursor = '0'; }
  function failure(error) {
    const safe = error instanceof OwnerApiError ? error : new OwnerApiError('network');
    state.error = safe.message;
    if (['expired', 'revoked', 'unauthorized'].includes(safe.kind)) {
      // Invalidate every concurrent read/send, including a response which was
      // authenticated before another operation confirmed revocation.
      ++generation; reading = null; state.busy = false; state.sending = false;
      clearPrivate(); state.pairing = null;
      state.status = ['expired', 'revoked'].includes(safe.kind) ? safe.kind : 'unknown';
      emit();
    }
    return safe;
  }
  async function readMessages(epoch) {
    let after = cursor;
    const seen = new Set([after]);
    do {
      const data = await api.messages(after);
      if (epoch !== generation) return;
      const map = new Map(state.messages.map(m => [m.id, m]));
      for (const message of data.messages) map.set(message.id, { ...message, saved: true });
      state.messages = [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      // Every successful page is an authenticated use. Keep the last received
      // numeric position so later reads are incremental even when nextCursor=null.
      if (data.messages.length) {
        const final = data.messages.at(-1);
        if (/^\d{1,15}$/.test(String(final.sequence))) cursor = String(final.sequence);
      }
      if (data.nextCursor !== null) {
        const next = String(data.nextCursor);
        if (seen.has(next) || Number(next) <= Number(after)) throw new OwnerApiError('invalid');
        seen.add(next); cursor = next; after = next;
      } else after = null;
    } while (after !== null);
  }
  const controller = {
    get mode() { return state.mode; },
    get hasCredential() { return api.hasCredential; },
    get status() { return state.status; },
    snapshot() { return structuredClone(state); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setDraft(value) { state.draft = value.slice(0, 4000); },
    setQuery(value) { state.query = value.trim().toLowerCase(); emit(); },
    connect() {
      ++generation; reading = null; state.busy = false; state.sending = false;
      state.error = ''; state.pairing = null; state.status = 'none'; api.cancelPairing(); mode('pairing');
    },
    showPublic() { mode('public'); },
    showOwner() { mode(api.hasCredential ? 'owner' : 'pairing'); },
    async startPairing(label, remember = false) {
      if (state.busy) return;
      const epoch = ++generation;
      state.busy = true; state.error = ''; state.pairing = null; state.status = 'none'; emit();
      try {
        const pairing = await api.startPairing(label.trim().slice(0, 80) || 'This phone', { remember: remember === true });
        if (epoch !== generation) return;
        clearPrivate(); state.pairing = pairing; state.status = 'pending';
      } catch (error) { if (epoch === generation) failure(error); }
      finally { if (epoch === generation) { state.busy = false; emit(); } }
    },
    async checkPairing() {
      if (!state.pairing || state.status !== 'pending' || state.busy) return;
      const epoch = generation;
      state.busy = true; state.error = ''; emit();
      try {
        const data = await api.pairingStatus();
        if (epoch !== generation) return;
        state.status = data.status;
        if (data.status === 'approved') {
          state.device = data.device; state.pairing = null; state.warning = api.storageWarning;
          if (state.mode === 'pairing') mode('owner');
          await readMessages(epoch);
        }
      } catch (error) { if (epoch === generation) failure(error); }
      finally { if (epoch === generation) { state.busy = false; emit(); } }
    },
    async refresh() {
      if (!api.hasCredential || state.status === 'pending') return;
      if (reading) return reading;
      const epoch = generation;
      state.busy = true; state.error = ''; if (state.status === 'unknown') state.status = 'checking'; emit();
      const task = (async () => {
        try {
          const data = await api.session();
          if (epoch !== generation) return;
          state.status = 'approved'; state.device = data.device; state.warning = api.storageWarning;
          await readMessages(epoch);
        } catch (error) { if (epoch === generation) { failure(error); if (state.status === 'checking') state.status = 'unknown'; } }
        finally { if (epoch === generation) { state.busy = false; emit(); } }
      })();
      reading = task;
      try { await task; } finally { if (reading === task) reading = null; }
    },
    async send() {
      if (state.sending || state.status !== 'approved') return;
      const body = state.draft.trim(); if (!body) return;
      const epoch = generation;
      const item = failedSend?.body === body ? failedSend : { id: uuid(), body };
      failedSend = item; state.sending = true; state.error = ''; emit();
      try {
        await api.sendMessage(item.id, item.body);
        if (epoch !== generation) return;
        if (state.draft.trim() === body) state.draft = '';
        failedSend = null;
        await readMessages(epoch);
      } catch (error) { if (epoch === generation) failure(error); }
      finally { if (epoch === generation) { state.sending = false; emit(); } }
    },
    async showDevices() {
      if (!api.hasCredential) { controller.showOwner(); return; }
      if (state.status !== 'approved') await controller.refresh();
      if (state.status !== 'approved') { controller.showOwner(); return; }
      mode('devices');
      return controller.refreshDevices();
    },
    async refreshDevices() {
      if (state.busy) return;
      const epoch = generation;
      state.busy = true; state.error = ''; emit();
      try {
        const data = await api.devices();
        if (epoch !== generation) return;
        state.devices = data.devices;
      } catch (error) { if (epoch === generation) failure(error); }
      finally { if (epoch === generation) { state.busy = false; emit(); } }
    },
    async revoke(deviceId) {
      if (state.busy || state.sending) return;
      const epoch = generation, self = deviceId === api.deviceId;
      state.busy = true; state.error = ''; emit();
      try {
        await api.revoke(deviceId);
        if (epoch !== generation) return;
        if (self) { ++generation; clearPrivate(); state.status = 'revoked'; state.warning = api.storageWarning; state.busy = false; mode('owner'); }
        else { state.busy = false; await controller.refreshDevices(); }
      } catch (error) { if (epoch === generation) failure(error); }
      finally { if (epoch === generation) { state.busy = false; emit(); } }
    },
    disconnect() { if (api.deviceId) return controller.revoke(api.deviceId); },
    storedSessionChanged() {
      ++generation; reading = null; clearPrivate(); api.refreshStoredCredential();
      state.status = api.hasCredential ? 'unknown' : 'none'; state.error = ''; state.warning = ''; state.busy = false; state.sending = false; state.pairing = null;
      emit();
      if (state.mode !== 'public' && api.hasCredential) return controller.refresh();
    }
  };
  return controller;
}

const stamp = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Unknown';

export function createRelayOwnerUI({ controller = createRelayOwnerController(), document: doc = globalThis.document } = {}) {
  let root, timer, viewKey = '', chatNodes = null, pairLabel = '', pairRemember = false;
  const make = (tag, text = '', cls = '') => { const n = doc.createElement(tag); n.textContent = text; n.className = cls; return n; };
  function action(label, handler, cls = 'secondary') { const n = make('button', label, cls); n.type = 'button'; n.onclick = handler; return n; }
  function statusNodes(container, state) {
    const error = make('p', state.error, 'relay-owner-error'); error.setAttribute('role', 'status'); error.hidden = !state.error;
    const warning = make('p', state.warning, 'relay-owner-note'); warning.hidden = !state.warning;
    container.append(error, warning);
  }
  function renderMessages(state) {
    if (!chatNodes) return;
    const panel = chatNodes.messages, nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 70;
    const scroll = panel.scrollTop;
    panel.replaceChildren();
    const selected = state.messages.filter(m => !state.query || m.body.toLowerCase().includes(state.query));
    for (const m of selected) {
      const row = make('article', '', 'message-row ' + (m.role === 'user' ? 'outgoing' : 'incoming'));
      row.dataset.messageId = m.id;
      row.append(make('span', m.role === 'user' ? 'You · private' : 'dot · private', 'message-author'),
        // Text only: no auth link, external navigation, iframe or public quote path.
        make('p', m.body, 'bubble'), make('span', stamp(m.createdAt), 'message-time'));
      panel.append(row);
    }
    if (!selected.length) panel.append(make('p', state.query ? 'No matching private messages.' : 'Your private conversation with dot appears here.', 'chat-empty'));
    panel.scrollTop = nearBottom ? panel.scrollHeight : scroll;
    if (chatNodes.input.value !== state.draft) { chatNodes.input.value = state.draft; autosize(chatNodes.input); }
    chatNodes.send.disabled = state.sending || state.busy;
    chatNodes.send.setAttribute('aria-label', state.sending ? 'Sending private message' : 'Send private message');
    chatNodes.status.textContent = state.sending ? 'Sending privately…' : state.error ? 'Private sync unavailable · retry below' : state.busy ? 'Checking private inbox…' : 'Private owner chat · replies arrive after an inbox check';
    chatNodes.error.textContent = state.error; chatNodes.error.hidden = !state.error;
    chatNodes.warning.textContent = state.warning; chatNodes.warning.hidden = !state.warning;
    chatNodes.retry.hidden = !state.error; chatNodes.retry.disabled = state.busy || state.sending;
  }
  function render() {
    if (!root?.isConnected || controller.mode === 'public') return;
    const state = controller.snapshot();
    const key = state.mode === 'owner' && state.status === 'approved' ? 'chat' : state.mode + ':' + state.status;
    const searchToggle = doc.getElementById('chat-search-toggle'); if (searchToggle) searchToggle.hidden = key !== 'chat';
    if (key === 'chat' && viewKey === key) { renderMessages(state); return; }
    const active = doc.activeElement;
    // Preserve unsent setup choices when a status repaint follows network work.
    if (root.contains(active) && active?.id === 'relay-owner-label') pairLabel = active.value;
    root.classList.add('relay-owner-content'); root.replaceChildren(); viewKey = key; chatNodes = null;
    const section = make('section', '', 'relay-owner-panel'); root.append(section);
    if (key === 'chat') {
      section.classList.add('relay-owner-chat');
      const heading = make('div', '', 'relay-owner-heading'); heading.append(make('h2', 'Owner chat'), make('span', 'Private', 'relay-owner-badge')); section.append(heading);
      const search = make('div', '', 'conversation-search'); search.id = 'relay-owner-search-bar'; search.hidden = true;
      const searchLabel = make('label', 'Search private messages', 'sr-only'); searchLabel.htmlFor = 'relay-owner-search';
      const searchInput = make('input'); searchInput.id = 'relay-owner-search'; searchInput.type = 'search'; searchInput.placeholder = 'Search private messages'; searchInput.autocomplete = 'off'; searchInput.oninput = () => controller.setQuery(searchInput.value); search.append(searchLabel, searchInput); section.append(search);
      const messages = make('div', '', 'messages'); messages.setAttribute('aria-label', 'Private owner conversation'); messages.setAttribute('aria-live', 'polite'); section.append(messages);
      const form = make('form', '', 'composer'); form.id = 'relay-owner-message-form';
      const label = make('label', 'Message dot privately', 'sr-only'); label.htmlFor = 'relay-owner-message-text';
      const input = make('textarea'); input.id = 'relay-owner-message-text'; input.rows = 1; input.maxLength = 4000; input.placeholder = 'Message dot privately…'; input.autocomplete = 'off'; input.required = true; input.value = state.draft;
      input.oninput = () => { controller.setDraft(input.value); autosize(input); };
      input.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } };
      const bottom = make('div', '', 'composer-bottom'), status = make('span'); status.setAttribute('role', 'status');
      const send = action('', () => {}, 'primary send-icon'); send.type = 'submit'; send.innerHTML = icon('send'); bottom.append(status, send); form.append(label, input, bottom);
      form.onsubmit = event => { event.preventDefault(); controller.setDraft(input.value); controller.send(); };
      section.append(form);
      const error = make('p', '', 'relay-owner-error'); error.setAttribute('role', 'status');
      const warning = make('p', '', 'relay-owner-note');
      const retry = action('Retry private sync', () => controller.refresh()); section.append(error, warning, retry);
      chatNodes = { messages, input, status, send, error, warning, retry }; renderMessages(state); autosize(input);
      return;
    }
    if (state.mode === 'pairing') {
      section.append(make('h2', 'Connect this phone'));
      if (state.status === 'pending') {
        section.append(make('p', 'On your unrestricted phone, open your existing private chat with dot and ask it to approve this Relay pairing code. Keep this page open.', 'relay-owner-note'));
        const code = make('p', state.pairing.code, 'relay-owner-code'); code.setAttribute('aria-label', 'Pairing code ' + state.pairing.code); section.append(code);
        const copy = action('Copy approval request', async () => { copy.textContent = await copyText('Please approve this Relay phone pairing code: ' + state.pairing.code) ? 'Approval request copied' : 'Select the displayed code to copy it'; }); section.append(copy);
        section.append(make('p', 'Approval code expires ' + stamp(state.pairing.expires_at) + '. This phone has no owner access until you approve it.', 'relay-owner-note'));
        const check = action(state.busy ? 'Checking approval…' : 'Check approval', () => controller.checkPairing(), 'primary'); check.disabled = state.busy; section.append(check);
        section.append(action('Cancel pairing', () => { controller.connect(); render(); }));
      } else {
        if (['expired', 'revoked'].includes(state.status)) section.append(make('p', state.status === 'expired' ? 'This pairing request has expired. Create a new code.' : 'This pairing request was revoked. Create a new code.', 'relay-owner-error'));
        section.append(make('p', 'Approve a one-time code from your existing private dot chat on your unrestricted phone. Pair each phone separately so either can be revoked.', 'relay-owner-note'));
        const form = make('form'); form.id = 'relay-owner-pair-form';
        const label = make('label', 'Device name'); label.htmlFor = 'relay-owner-label';
        const input = make('input'); input.id = 'relay-owner-label'; input.maxLength = 80; input.placeholder = 'For example, my restricted phone'; input.value = pairLabel; input.autocomplete = 'off'; input.oninput = () => { pairLabel = input.value; };
        const remember = make('label', '', 'relay-owner-remember');
        const checkbox = make('input'); checkbox.type = 'checkbox'; checkbox.id = 'relay-owner-remember'; checkbox.checked = pairRemember; checkbox.onchange = () => { pairRemember = checkbox.checked; };
        remember.append(checkbox, make('span', 'Remember owner access on this browser'));
        const consent = make('p', 'If checked, this browser saves only a device token and device ID. Access expires after exactly 365 days of inactivity and renews on authenticated use. Scripts on this shared website origin can read the token. Anyone using this browser can use this access. Clearing browser data requires pairing again. Private messages and drafts are never saved in public browser storage.', 'relay-owner-note'); consent.id = 'relay-owner-storage-notice'; checkbox.setAttribute('aria-describedby', consent.id);
        const start = action(state.busy ? 'Creating code…' : 'Create pairing code', () => {}, 'primary'); start.type = 'submit'; start.disabled = state.busy;
        form.append(label, input, remember, consent, start); form.onsubmit = event => { event.preventDefault(); pairLabel = input.value; pairRemember = checkbox.checked; controller.startPairing(pairLabel, pairRemember); }; section.append(form);
      }
      statusNodes(section, state); section.append(action('Public chat', () => controller.showPublic())); return;
    }
    if (state.mode === 'devices' && state.status === 'approved') {
      section.append(make('h2', 'Owner devices'), make('p', 'Each phone has its own revocable session. Successful authenticated use renews that session’s 365-day inactivity expiry.', 'relay-owner-note'));
      if (!state.devices.length) section.append(make('p', state.busy ? 'Checking devices…' : 'No device list is available yet.', 'relay-owner-note'));
      for (const device of state.devices) {
        const row = make('div', '', 'relay-owner-device');
        row.append(make('h3', device.label + (device.id === state.device?.id ? ' · this phone' : '')),
          make('p', device.revokedAt ? 'Revoked' : 'Last used ' + stamp(device.lastSeenAt) + ' · expires ' + stamp(device.expiresAt), 'relay-owner-note'));
        const revoke = action('Revoke ' + device.label, () => controller.revoke(device.id)); revoke.disabled = state.busy || !!device.revokedAt; row.append(revoke); section.append(row);
      }
      statusNodes(section, state); const refresh = action('Refresh devices', () => controller.refreshDevices()); refresh.disabled = state.busy; section.append(refresh, action('Owner chat', () => controller.showOwner())); return;
    }
    section.append(make('h2', 'Owner chat'));
    const text = state.status === 'checking' ? 'Verifying owner access for this phone…' : state.status === 'expired' ? 'This phone’s owner session has expired.' : state.status === 'revoked' ? 'This phone’s owner access has been revoked.' : 'Owner access has not been verified.';
    section.append(make('p', text, 'relay-owner-note')); statusNodes(section, state);
    if (controller.hasCredential) { const retry = action('Retry owner connection', () => controller.refresh(), 'primary'); retry.disabled = state.busy; section.append(retry); }
    else section.append(action('Connect this phone', () => controller.connect(), 'primary'));
    section.append(action('Public chat', () => controller.showPublic()));
  }
  const unsubscribe = controller.subscribe(render);
  return {
    controller,
    get mode() { return controller.mode; },
    mount(node) {
      root = node; viewKey = ''; render(); clearInterval(timer);
      if (controller.mode === 'owner' && controller.hasCredential && ['unknown', 'checking'].includes(controller.status)) controller.refresh();
      if (controller.mode === 'pairing' && controller.status === 'pending') controller.checkPairing();
      timer = setInterval(() => {
        if (!root?.isConnected || doc.hidden) return;
        if (controller.status === 'pending' && controller.mode === 'pairing') controller.checkPairing();
        else if (controller.mode === 'owner' && controller.hasCredential) controller.refresh();
      }, controller.status === 'pending' || controller.mode === 'pairing' ? 5000 : 30000);
    },
    unmount() { root = null; chatNodes = null; viewKey = ''; clearInterval(timer); },
    toggleSearch() { const bar = doc.getElementById('relay-owner-search-bar'); if (!bar) return; bar.hidden = !bar.hidden; if (!bar.hidden) doc.getElementById('relay-owner-search').focus(); else { doc.getElementById('relay-owner-search').value = ''; controller.setQuery(''); } },
    latest() { if (chatNodes) chatNodes.messages.scrollTop = chatNodes.messages.scrollHeight; },
    refresh() { return controller.status === 'pending' ? controller.checkPairing() : controller.mode === 'devices' ? controller.refreshDevices() : controller.refresh(); },
    dispose() { this.unmount(); unsubscribe(); }
  };
}
