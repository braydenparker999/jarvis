// Plays a Drive file in a <video>. The browser's own decoder handles MP4 and
// WebM. When it refuses a file (MKV, AC-3/DTS audio, codecs without hardware
// support), Astra's compatibility remuxer and software decoder take over.
const ASTRA = '/media/assets/js/playback/';
// Order matters: the software decoder needs request policy, and the
// compatibility player hands off to the software decoder when present.
const FALLBACK_SCRIPTS = ['request-policy.js', 'software-player.js', 'compatibility.js'];
let fallbackLoad = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => { script.remove(); reject(Error('The compatibility player could not load.')); };
    document.head.append(script);
  });
}

function loadFallback() {
  if (globalThis.AstraCompatibility) return Promise.resolve();
  fallbackLoad ??= FALLBACK_SCRIPTS.reduce((chain, name) => chain.then(() => loadScript(ASTRA + name)), Promise.resolve())
    .catch(error => { fallbackLoad = null; throw error; });
  return fallbackLoad;
}

// MEDIA_ERR_DECODE (3) and MEDIA_ERR_SRC_NOT_SUPPORTED (4) mean the format,
// not the network, is the problem.
const formatProblem = media => [3, 4].includes(media.error?.code);

// A refused Drive request (sharing, quota, key) also surfaces as "not
// supported". Ask for one byte to tell the two apart before switching decoders.
export async function driveProblem(url, fetcher = fetch) {
  try {
    const response = await fetcher(url, {headers:{Range:'bytes=0-0'}, credentials:'omit', referrerPolicy:'no-referrer', cache:'no-store'});
    await response.body?.cancel();
    if (response.ok) return '';
    if (response.status === 404) return 'This video is no longer in Drive. Refresh the library.';
    if (response.status === 403 || response.status === 429) return 'Drive refused this video right now. If it was played a lot today, Drive may limit it for up to a day; otherwise check the folder is shared as Anyone with the link.';
    return 'Drive could not send this video (HTTP ' + response.status + ').';
  } catch {
    return 'The video could not be reached. Check your connection, then try again.';
  }
}

export function play(media, url, {startTime = 0, onError = () => {}, onMode = () => {}} = {}) {
  let adapter = null, closed = false, fellBack = false;
  const cleanup = [];
  const listen = (type, fn) => { media.addEventListener(type, fn); cleanup.push(() => media.removeEventListener(type, fn)); };

  async function fallback() {
    if (fellBack || closed) return;
    fellBack = true;
    const at = media.currentTime || startTime;
    onMode('compatibility');
    try {
      await loadFallback();
      if (closed) return;
      media.removeAttribute('src'); media.load();
      adapter = globalThis.AstraCompatibility.createAdapter({media, url, startTime:at, autoplay:true,
        onError:e => !closed && onError(e?.detail || 'This video could not be played on this device.')});
      await adapter.attach();
    } catch (error) {
      if (!closed && error?.name !== 'AbortError') onError(error?.message || 'This video could not be played on this device.');
    }
  }

  listen('error', async () => {
    if (closed || fellBack) return;
    if (!formatProblem(media)) return onError('The video stopped loading. Check your connection, then try again.');
    const problem = await driveProblem(url);
    if (closed) return;
    if (problem) onError(problem); else fallback();
  });
  // Chrome sometimes plays the audio of an unsupported video track with no picture.
  listen('loadedmetadata', () => {
    if (!fellBack && media.videoWidth === 0 && media.duration > 0 && !media.error) fallback();
    else if (startTime > 0 && !fellBack) media.currentTime = startTime;
  });
  onMode('native');
  media.src = url;
  media.play().catch(() => {});

  return {
    get mode() { return fellBack ? 'compatibility' : 'native'; },
    close() {
      if (closed) return;
      closed = true;
      cleanup.forEach(fn => fn());
      adapter?.destroy();
      media.pause(); media.removeAttribute('src'); media.load();
    },
    seek(seconds) {
      const target = Math.max(0, Math.min(media.duration || Infinity, seconds));
      if (adapter?.seekTo) adapter.seekTo(target); else media.currentTime = target;
    }
  };
}
