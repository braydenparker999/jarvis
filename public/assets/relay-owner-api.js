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
      rejected: 'The owner service could not complete this action. Retry later.'
    };
    super(messages[kind] || messages.rejected);
    this.name = 'OwnerApiError';
    this.kind = kind;
    this.status = status;
  }
}

export function createRelayOwnerApi({ fetcher = globalThis.fetch, origin = API_ORIGIN, storage } = {}) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
  let credential = null, pending = null, remember = false, storageWarning = '';
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
      const unauthenticated = response.status === 401 || (response.status === 403 && ['session_expired', 'session_revoked', 'invalid_session'].includes(reported));
      if (unauthenticated && token) clearCredential(token);
      const kind = unauthenticated
        ? reported === 'session_expired' ? 'expired' : reported === 'session_revoked' ? 'revoked' : 'unauthorized'
        : reported === 'owner_not_enabled' ? 'disabled' : response.status >= 500 ? 'unavailable' : response.status === 409 ? 'conflict' : 'rejected';
      throw new OwnerApiError(kind, response.status);
    }
    if (!data || typeof data !== 'object') throw new OwnerApiError('invalid');
    return data;
  }
  const authenticated = (path, body) => {
    if (!credential) throw new OwnerApiError('unauthorized');
    return call(path, { body, token: credential.device_token });
  };
  return {
    get hasCredential() { return !!credential; },
    get deviceId() { return credential?.device_id || null; },
    get storageWarning() { return storageWarning; },
    refreshStoredCredential() { pending = null; credential = readStored(); return !!credential; },
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
        || m.visibility !== 'private' || m.author_authenticated !== true)
        || !(data.nextCursor === null || /^\d{1,15}$/.test(String(data.nextCursor)))) throw new OwnerApiError('invalid');
      return data;
    },
    sendMessage(id, body) { return authenticated('/relay/owner/messages', { id, body }); },
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
