// Optional playback-only overlay. The Drive catalog remains the authority for
// identity, user data, tags and artwork. Nothing from this map is persisted.
export const MAX_R2_MANIFEST_BYTES = 32 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{10,200}$/;
const MD5 = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERIFICATION = 'r2-get-hash-v1';
const fail = () => { throw Error('R2 playback requires a complete, verified mapping of the current Drive library.'); };
const count = n => Number.isSafeInteger(n) && n >= 0;

function httpsURL(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\\]/.test(value)) fail();
  let url; try { url = new URL(value); } catch { fail(); }
  // Playback credentials belong in a separately approved endpoint design,
  // never in catalog URLs. Redirects are also refused when reading the map.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail();
  return url;
}

function trackMatches(track, file, root) {
  return track?.source === 'drive' && track.id === 'gd_' + file.driveId &&
    track.remoteId === file.driveId && track.driveFolder === root &&
    track.size === file.size && MD5.test(track.md5) && track.md5 === file.md5;
}

export function validateR2Manifest(data, {root, manifestURL, tracks}) {
  const endpoint = httpsURL(manifestURL);
  if (typeof root !== 'string' || !ID.test(root) || data?.version !== 1 || data.mode !== 'full' || data.complete !== true ||
      data.verification !== VERIFICATION || data.driveRootId !== root ||
      typeof data.generatedAt !== 'string' || !Number.isFinite(Date.parse(data.generatedAt)) ||
      !Array.isArray(data.files) || !data.files.length || data.files.length > 50000 ||
      !Array.isArray(tracks) || tracks.length !== data.files.length ||
      !count(data.inventoryBytes) || data.failedCount !== 0 || !Array.isArray(data.failures) || data.failures.length ||
      ![data.inventoryCount, data.selectedCount, data.verifiedCount].every(n => n === data.files.length) ||
      !count(data.copiedCount) || !count(data.skippedCount)) fail();
  const base = httpsURL(data.publicBaseUrl);
  // One explicitly configured endpoint is the trust boundary. Supporting a
  // different media origin or cookie/token authentication needs separate setup.
  if (base.origin !== endpoint.origin || !/^\/[A-Za-z0-9_/-]*$/.test(base.pathname)) fail();
  const baseURL = base.href.replace(/\/+$/, '');
  const files = new Map(); let bytes = 0, copied = 0, skipped = 0;
  for (const file of data.files) {
    if (!file || typeof file.driveId !== 'string' || !ID.test(file.driveId) || files.has(file.driveId) ||
        !Number.isSafeInteger(file.size) || file.size <= 0 || !MD5.test(file.md5) ||
        file.sourceMd5 !== file.md5 || !SHA256.test(file.sha256) ||
        file.verification !== VERIFICATION || file.verifiedBytes !== file.size ||
        !['copied', 'skipped'].includes(file.status) ||
        typeof file.mimeType !== 'string' || file.mimeType.length > 128 ||
        !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.mimeType)) fail();
    const key = typeof file.key === 'string' && /^audio\/([A-Za-z0-9_-]{10,200})\/([a-f0-9]{32}|[a-f0-9]{64})\.([a-z0-9]{1,8})$/.exec(file.key);
    if (!key || key[1] !== file.driveId || key[2] !== (key[2].length === 32 ? file.md5 : file.sha256)) fail();
    const media = httpsURL(file.url);
    if (media.href !== baseURL + '/' + file.key) fail();
    // Copy only the validated playback identity, so later caller mutations of
    // parsed JSON cannot replace a URL or weaken its revision binding.
    files.set(file.driveId, Object.freeze({driveId:file.driveId, size:file.size, md5:file.md5, url:media.href}));
    bytes += file.size; if (!Number.isSafeInteger(bytes)) fail();
    if (file.status === 'copied') copied++; else skipped++;
  }
  if (bytes !== data.inventoryBytes || copied !== data.copiedCount || skipped !== data.skippedCount) fail();
  function matches(library) {
    if (!Array.isArray(library) || library.length !== files.size) return false;
    const seen = new Set();
    return library.every(track => {
      const file = files.get(track?.remoteId);
      if (!file || seen.has(track.remoteId) || !trackMatches(track, file, root)) return false;
      seen.add(track.remoteId); return true;
    });
  }
  if (!matches(tracks)) fail();
  return Object.freeze({
    count:files.size,
    matches,
    mediaURL(track) {
      const file = files.get(track?.remoteId);
      return file && trackMatches(track, file, root) ? file.url : null;
    }
  });
}

export async function readR2Manifest({url, root, tracks, signal, fetcher = fetch}) {
  const endpoint = httpsURL(url);
  const response = await fetcher(endpoint.href, {
    signal, credentials:'omit', cache:'no-store', mode:'cors',
    redirect:'error', referrerPolicy:'no-referrer'
  });
  const size = response.headers.get('content-length');
  if (response.status !== 200 || response.redirected ||
      (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_R2_MANIFEST_BYTES)) ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel(); fail();
  }
  const reader = response.body?.getReader(); if (!reader) fail();
  const chunks = []; let total = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      total += value.byteLength; if (total > MAX_R2_MANIFEST_BYTES) fail();
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  // Content-Length may describe compressed wire bytes; CORS can hide
  // Content-Encoding. Bound the decoded body rather than comparing the two.
  const bytes = new Uint8Array(total); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  const data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
  return validateR2Manifest(data, {root, manifestURL:endpoint.href, tracks});
}
