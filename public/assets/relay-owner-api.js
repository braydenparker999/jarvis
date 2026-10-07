import { API_ORIGIN } from './config.js';

// This key is deliberately unrelated to public inbox, drafts, transfers or module state.
export const OWNER_SESSION_KEY = 'jarvis.relay.owner-session.v1';
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,512}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const deviceFrom = data => {
  const device = data?.device;
  if (!device || !identifier(device.id) || typeof device.label !== 'string') throw new OwnerApiError('invalid');
  return device;
};

const deliveryStates=['saved','queued','callback_accepted','delivery_failed','reply_saved'];
function validDelivery(value){
  return value&&deliveryStates.includes(value.state)&&Number.isSafeInteger(value.pending)&&value.pending>=0&&value.pending<=8
    &&Number.isSafeInteger(value.failed)&&value.failed>=0&&value.failed<=8&&typeof value.retryable==='boolean'
    &&(value.callbackAcceptedAt===null||typeof value.callbackAcceptedAt==='string'&&Number.isFinite(Date.parse(value.callbackAcceptedAt)))
    &&(value.retryAfter===null||typeof value.retryAfter==='string'&&Number.isFinite(Date.parse(value.retryAfter)))
    &&!(value.retryable&&value.state!=='delivery_failed');
}

export class OwnerApiError extends Error {
  constructor(kind = 'network', status = 0) {
    const messages = {
      network: 'Owner connection unavailable. Check your connection and retry.',
      invalid: 'The owner service returned an unreadable response. Retry later.',
      expired: 'This owner session has expired. Connect this phone again.',
      revoked: 'This phone’s owner access was revoked. Connect this phone again.',
      unauthorized: 'Owner access could not be verified. Connect this phone again.',
      unavailable: 'The owner service is temporarily unavailable. Retry later.',
      disabled: 'Owner pairing is not enabled on this Relay service yet. Public chat remains available.',
      conflict: 'This message could not be accepted. Your text is still here.',
      rejected: 'The owner service could not complete this action. Retry later.',
      login_failed: 'The username or password could not be verified. Check them and try again.',
      rate_limited: 'Too many attempts. Wait a while before trying again.',
      credential_conflict: 'Account sign-in changed while this form was open. Open a fresh form and retry.',
      consent_required: 'This account sign-in form has expired. Open a fresh form and confirm again.',
      cancelled: 'This sign-in attempt was closed.',
      device_unavailable: 'The selected device session is no longer available. Sign in again to refresh the choices.',
      device_limit: 'Ten device sessions are already active. Re-enter your account credentials and explicitly choose one session to replace.'
    };
    super(messages[kind] || messages.rejected);
    this.name = 'OwnerApiError';
    this.kind = kind;
    this.status = status;
  }
}

export function createRelayOwnerApi({ fetcher = globalThis.fetch, origin = API_ORIGIN, storage } = {}) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
  let credential = null, pending = null, remember = false, storageWarning = '', authenticationEpoch = 0;
  function readStored() {
    try {
      const saved = JSON.parse(storage?.getItem(OWNER_SESSION_KEY) || 'null');
      return saved && opaque(saved.device_token) && identifier(saved.device_id)
        ? { device_token: saved.device_token, device_id: saved.device_id } : null;
    } catch { return null; }
  }
  credential = readStored();
  function clearCredential(token) {
    if (credential?.device_token !== token) return;
    credential = null;
    try {
      // Do not remove a replacement session written by another tab.
      if (readStored()?.device_token === token) storage?.removeItem(OWNER_SESSION_KEY);
    } catch { storageWarning = 'Browser storage could not be cleared. Clear browser data before sharing this phone.'; }
  }
  function persist() {
    if (!remember || !credential) return;
    try {
      if (!storage) throw Error();
      // No approval code, principal, expiry, history or draft is persisted.
      storage.setItem(OWNER_SESSION_KEY, JSON.stringify(credential));
      storageWarning = '';
    } catch { storageWarning = 'This phone is connected for this page only. Browser storage could not remember it.'; }
  }
  async function call(path, { body, token } = {}) {
    let response;
    try {
      response = await fetcher(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
    } catch { throw new OwnerApiError('network'); }
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      // Never surface raw server error text, response bodies, URLs or credentials.
      const reported = data?.code || data?.error;
      if (reported === 'device_limit' && response.status === 429 && path === '/relay/owner/login') {
        if (!Array.isArray(data.devices) || data.devices.length < 1 || data.devices.length > 10
          || data.devices.some(d => !identifier(d.id) || typeof d.label !== 'string' || d.label.length > 80
            || !Number.isFinite(Date.parse(d.lastSeenAt)) || !Number.isFinite(Date.parse(d.expiresAt)))
          || new Set(data.devices.map(d => d.id)).size !== data.devices.length) throw new OwnerApiError('invalid');
        const error = new OwnerApiError('device_limit', response.status);
        error.devices = data.devices.map(d => ({ id: d.id, label: d.label, lastSeenAt: d.lastSeenAt, expiresAt: d.expiresAt }));
        throw error;
      }
      const unauthenticated = (response.status === 401 && reported !== 'invalid_credentials') || (response.status === 403 && ['session_expired', 'session_revoked', 'invalid_session'].includes(reported));
      if (unauthenticated && token) clearCredential(token);
      const kind = reported === 'invalid_credentials' ? 'login_failed'
        : response.status === 429 ? 'rate_limited'
        : reported === 'device_unavailable' ? 'device_unavailable'
        : reported === 'credential_conflict' ? 'credential_conflict'
        : reported === 'consent_required' ? 'consent_required'
        : unauthenticated
        ? reported === 'session_expired' ? 'expired' : reported === 'session_revoked' ? 'revoked' : 'unauthorized'
        : reported === 'owner_not_enabled' ? 'disabled' : response.status >= 500 ? 'unavailable' : response.status === 409 ? 'conflict' : 'rejected';
      throw new OwnerApiError(kind, response.status);
    }
    if (!data || typeof data !== 'object') throw new OwnerApiError('invalid');
    return data;
  }
  function validateAccountPolicy(data) {
    if (data.access_days !== 365 || data.preserve_existing_sessions !== true
      || data.policy?.min_password_length !== 16 || data.policy?.max_password_length !== 128
      || data.policy?.max_password_bytes !== 256 || data.policy?.username_pattern !== '[a-z0-9][a-z0-9._-]{2,31}') throw new OwnerApiError('invalid');
  }
  function validateAccountStatus(data) {
    validateAccountPolicy(data);
    if (typeof data.configured !== 'boolean' || (data.configured && (typeof data.username !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(data.username)))) throw new OwnerApiError('invalid');
  }
  const authenticated = (path, body) => {
    if (!credential) throw new OwnerApiError('unauthorized');
    return call(path, { body, token: credential.device_token });
  };
  return {
    get hasCredential() { return !!credential; },
    get deviceId() { return credential?.device_id || null; },
    get storageWarning() { return storageWarning; },
    refreshStoredCredential() { ++authenticationEpoch; pending = null; credential = readStored(); return !!credential; },
    cancelAuthentication() { ++authenticationEpoch; },
    async login(username, password, label, { remember: approvedPersistence = false, replaceDeviceId, confirmReplacement } = {}) {
      const epoch = ++authenticationEpoch;
      if ((replaceDeviceId !== undefined || confirmReplacement !== undefined) && (!identifier(replaceDeviceId) || confirmReplacement !== true)) throw new OwnerApiError('invalid');
      const data = await call('/relay/owner/login', { body: { username, password, label,
        ...(replaceDeviceId === undefined ? {} : { replace_device_id: replaceDeviceId, confirm_replacement: true }) } });
      if (epoch !== authenticationEpoch) throw new OwnerApiError('cancelled');
      const device = deviceFrom(data);
      if (data.status !== 'approved' || !opaque(data.device_token) || data.access_days !== 365) throw new OwnerApiError('invalid');
      pending = null; remember = approvedPersistence === true; storageWarning = '';
      const previousToken = credential?.device_token;
      if (previousToken) clearCredential(previousToken);
      credential = { device_token: data.device_token, device_id: device.id };
      persist();
      return { status: data.status, device, access_days: data.access_days };
    },
    async credentials() {
      const data = await authenticated('/relay/owner/credentials');
      validateAccountStatus(data);
      return data;
    },
    async prepareCredentials(purpose) {
      if (!['setup', 'change'].includes(purpose)) throw new OwnerApiError('invalid');
      const data = await authenticated('/relay/owner/credentials/prepare', { purpose });
      if (!opaque(data.consent_token) || data.purpose !== purpose || !Number.isFinite(Date.parse(data.expires_at))) throw new OwnerApiError('invalid');
      validateAccountPolicy(data);
      return data;
    },
    async saveCredentials({ username, password, password_confirmation, consent_token, current_password }) {
      const data = await authenticated('/relay/owner/credentials', { username, password, password_confirmation, consent_token,
        confirm: true, access_days: 365, preserve_existing_sessions: true,
        ...(current_password === undefined ? {} : { current_password }) });
      validateAccountStatus(data);
      return data;
    },
    async startPairing(label, { remember: approvedPersistence = false } = {}) {
      const data = await call('/relay/owner/pair/start', { body: { label } });
      if (!identifier(data.request_id) || !opaque(data.device_token) || typeof data.code !== 'string'
        || !/^[A-Z0-9 -]{4,40}$/.test(data.code) || !Number.isFinite(Date.parse(data.expires_at))) throw new OwnerApiError('invalid');
      pending = { request_id: data.request_id, device_token: data.device_token };
      remember = approvedPersistence === true;
      storageWarning = '';
      // The pending verifier is memory-only and grants no owner identity.
      return { request_id: data.request_id, code: data.code, expires_at: data.expires_at };
    },
    async pairingStatus() {
      if (!pending) throw new OwnerApiError('unauthorized');
      const pairing = pending;
      const data = await call('/relay/owner/pair/status', { token: pairing.device_token, body: { request_id: pairing.request_id } });
      if (!['pending', 'approved', 'expired', 'revoked'].includes(data.status)) throw new OwnerApiError('invalid');
      if (pending !== pairing) throw new OwnerApiError('unauthorized');
      if (data.status === 'approved') {
        const device = deviceFrom(data);
        credential = { device_token: pairing.device_token, device_id: device.id };
        pending = null;
        persist();
      } else if (data.status !== 'pending') pending = null;
      return data;
    },
    cancelPairing() { pending = null; },
    async session() {
      const data = await authenticated('/relay/owner/session');
      deviceFrom(data);
      if (data.status !== 'approved') throw new OwnerApiError('invalid');
      if (data.device.id !== credential?.device_id) throw new OwnerApiError('invalid');
      return data;
    },
    async messages(after = '0') {
      if (!/^\d{1,15}$/.test(String(after))) throw new OwnerApiError('invalid');
      const data = await authenticated('/relay/owner/messages?after=' + encodeURIComponent(after));
      if (!Array.isArray(data.messages) || data.messages.some(m => !identifier(m.id) || typeof m.body !== 'string'
        || !['user', 'assistant'].includes(m.role) || !Number.isFinite(Date.parse(m.createdAt))
        || m.visibility !== 'private' || m.author_authenticated !== true
        || m.delivery!==undefined&&!validDelivery(m.delivery))
        || !(data.nextCursor === null || /^\d{1,15}$/.test(String(data.nextCursor)))) throw new OwnerApiError('invalid');
      return data;
    },
    async deliveries(messageIds){
      if(!Array.isArray(messageIds)||messageIds.length>50||messageIds.some(id=>!identifier(id))||new Set(messageIds).size!==messageIds.length)throw new OwnerApiError('invalid');
      const data=await authenticated('/relay/owner/delivery',{message_ids:messageIds});
      if(!Array.isArray(data.deliveries)||data.deliveries.length!==messageIds.length||data.deliveries.some((d,i)=>d.message_id!==messageIds[i]||!validDelivery(d)))throw new OwnerApiError('invalid');
      // Project only the owner-safe evidence fields. Ignore unexpected server data.
      return {deliveries:data.deliveries.map(d=>({message_id:d.message_id,state:d.state,pending:d.pending,failed:d.failed,
        callbackAcceptedAt:d.callbackAcceptedAt,retryable:d.retryable,retryAfter:d.retryAfter}))};
    },
    async retryDelivery(messageId){
      if(!identifier(messageId))throw new OwnerApiError('invalid');
      const data=await authenticated('/relay/owner/delivery/retry',{message_id:messageId});
      if(!Number.isSafeInteger(data.retried)||data.retried<0||data.retried>8)throw new OwnerApiError('invalid');
      return {retried:data.retried};
    },
    async sendMessage(id, body) {
      if(!identifier(id)||typeof body!=='string'||!body.trim()||body.length>4000)throw new OwnerApiError('invalid');
      const data=await authenticated('/relay/owner/messages', { id, body });
      const entry=data.entry;
      if(!entry||entry.id!==id||entry.body!==body.trim()||entry.role!=='user'||entry.visibility!=='private'
        ||entry.author_authenticated!==true||!Number.isFinite(Date.parse(entry.createdAt))||typeof data.newWrite!=='boolean'
        ||entry.delivery!==undefined&&!validDelivery(entry.delivery))throw new OwnerApiError('invalid');
      return data;
    },
    async devices() {
      const data = await authenticated('/relay/owner/devices');
      if (!Array.isArray(data.devices) || data.devices.some(d => !identifier(d.id) || typeof d.label !== 'string')) throw new OwnerApiError('invalid');
      return data;
    },
    async revoke(deviceId) {
      if (!identifier(deviceId)) throw new OwnerApiError('invalid');
      const token = credential?.device_token;
      const data = await authenticated('/relay/owner/devices/revoke', { device_id: deviceId });
      if (deviceId === credential?.device_id) clearCredential(token);
      return data;
    }
  };
}
