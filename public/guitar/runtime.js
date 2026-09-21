export function filename(title, track) {
  const clean = s => String(s).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim();
  const name = `${clean(title).slice(0, 110)} - ${clean(track).slice(0, 60)}`.trim();
  return `${name || 'Guitar tab'}.pdf`;
}
export async function withDeadline(work, ms) {
  const controller = new AbortController(); let timer;
  try { return await Promise.race([work(controller.signal), new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(Error("Couldn't generate this tab. Try another Songsterr version.")); }, ms);
  })]); } finally { clearTimeout(timer); controller.abort(); }
}
export function renderInWorker(data, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(Error('Rendering timed out')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    worker.onmessage = ({ data }) => { cleanup(); data.ok ? resolve(data) : reject(Error('Rendering failed')); };
    worker.onerror = () => { cleanup(); reject(Error('Rendering failed')); };
    worker.postMessage(data);
  });
}
