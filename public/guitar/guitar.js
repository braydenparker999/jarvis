import { API_ORIGIN } from '/assets/config.js';
import { filename, withDeadline, renderInWorker } from './runtime.js';
const $ = id => document.getElementById(id);
let busy = false, current = null, results = [];
const text = (tag, value, className) => { const e = document.createElement(tag); e.textContent = value; if (className) e.className = className; return e; };
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function lock(value) {
  busy = value;
  for (const e of document.querySelectorAll('main button, main input')) e.disabled = value;
  $('content').setAttribute('aria-busy', String(value));
}
async function api(path, signal) {
  try {
    const r = await fetch(API_ORIGIN + '/guitar/' + path, { signal, cache: 'no-store' });
    const data = await r.json();
    if (!r.ok) throw Error(data.error || 'Songsterr is unavailable. Please try again.');
    return data;
  } catch (e) {
    if (signal.aborted) throw Error('Songsterr took too long. Please try again.');
    if (e instanceof TypeError || e instanceof SyntaxError) throw Error("Couldn't reach Songsterr. Check your connection and try again.");
    throw e;
  }
}
function showResults() {
  $('results').replaceChildren(); $('results').hidden = false;
  const duplicates = new Map();
  for (const r of results) { const key = r.title.toLowerCase() + '|' + r.artist.toLowerCase(); duplicates.set(key, (duplicates.get(key) || 0) + 1); }
  for (const r of results) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'song-result';
    const label = document.createElement('span'); label.append(text('strong', r.title), text('small', r.artist));
    const counts = new Map(); for (const t of r.tracks) counts.set(t.kind, (counts.get(t.kind) || 0) + 1);
    let instruments = [...counts].map(([kind, n]) => `${n} ${kind === 'other' ? 'other' : kind}`).join(' · ');
    if (duplicates.get(r.title.toLowerCase() + '|' + r.artist.toLowerCase()) > 1) instruments += ` · Version ${r.songId}`;
    if (instruments) label.append(text('small', instruments, 'instruments'));
    button.append(label, text('span', '›')); button.onclick = () => choose(r.songId); $('results').append(button);
  }
}
$('search-form').onsubmit = async e => {
  e.preventDefault(); if (busy) return;
  const q = $('song-query').value.trim(); if (q.length < 2) { status('Enter at least two characters.', true); return; }
  lock(true); status('Searching…'); current = null; $('song').hidden = true; $('results').replaceChildren();
  try {
    const data = await withDeadline(signal => api(`search?q=${encodeURIComponent(q)}`, signal), 20000);
    if (!Array.isArray(data.results)) throw Error('Songsterr returned invalid search results.');
    results = data.results; showResults(); status(results.length ? '' : 'No songs found. Try another title or artist.');
  } catch (e) { status(e.message, true); } finally { lock(false); }
};
async function choose(id) {
  if (busy) return;
  lock(true); status('Loading tracks…');
  try {
    const data = await withDeadline(signal => api(`songs/${id}`, signal), 20000);
    if (!data.song?.tracks?.length) throw Error('No usable tracks in this Songsterr version.');
    current = data.song; showSong(); status('');
  } catch (e) { status(e.message, true); } finally { lock(false); }
}
function showSong() {
  const root = $('song'); root.replaceChildren(); root.hidden = false; $('results').hidden = true;
  const back = text('button', '‹ Results', 'text-button change-song'); back.type = 'button';
  back.onclick = () => { if (busy) return; root.hidden = true; current = null; $('results').hidden = false; status(''); };
  root.append(back, text('h2', current.title), text('p', current.artist, 'song-artist'));
  const guitars = current.tracks.filter(t => t.kind === 'guitar');
  const preferred = guitars.length ? guitars : current.tracks;
  const chosen = preferred[0];
  const select = document.createElement('fieldset'); select.className = 'track-list';
  function option(value, name, instrument, checked = false) {
    const label = document.createElement('label'); label.className = 'track-option';
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'part'; radio.value = value; radio.checked = checked;
    const title = text('span', name); if (instrument) title.append(text('small', instrument));
    label.append(radio, title); return label;
  }
  if (preferred.length === 1) root.append(text('p', `${chosen.name}${chosen.instrument && chosen.name !== chosen.instrument ? ' · ' + chosen.instrument : ''}`, 'single-track'));
  else {
    select.append(text('legend', 'Track'));
    for (const t of preferred) select.append(option(String(t.partId), t.name, t.instrument || t.kind, t === chosen));
    if (guitars.length > 1 && guitars.length <= 12) select.append(option(guitars.map(t => t.partId).join(','), 'All guitar tracks', ''));
    const others = current.tracks.filter(t => !preferred.includes(t));
    if (others.length) {
      const details = document.createElement('details'); details.append(text('summary', 'Other instruments'));
      for (const t of others) details.append(option(String(t.partId), t.name, `${t.kind} · ${t.instrument}`));
      select.append(details);
    }
    root.append(select);
  }
  const download = text('button', 'Download PDF', 'primary guitar-download'); download.type = 'button'; download.id = 'download-pdf';
  download.onclick = () => generate(preferred.length === 1 ? String(chosen.partId) : select.querySelector('input:checked')?.value);
  root.append(download);
}
async function generate(parts) {
  if (busy || !current || !parts) return;
  lock(true); status('Preparing tab…'); const song = current;
  const selected = parts.split(',').map(Number).map(id => song.tracks.find(t => t.partId === id));
  const label = selected.length === 1 ? selected[0].name : 'All guitar tracks';
  try {
    await withDeadline(async signal => {
      const data = await api(`songs/${song.songId}/score?revision=${song.revisionId}&parts=${parts}`, signal);
      status('Laying out notation…');
      const [score, pdf] = await Promise.all([renderInWorker(data, signal), import('./pdf.js')]);
      signal.throwIfAborted();
      const blob = await pdf.createPdf(score, data.meta, label, signal, (i, total) => status(`Creating PDF… ${Math.round(i / total * 100)}%`));
      signal.throwIfAborted();
      if (!(blob instanceof Blob) || blob.size < 100) throw Error('Empty PDF');
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = filename(song.title, label); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      status(score.warnings.length ? 'PDF downloaded. Some notation could not be converted exactly.' : 'PDF downloaded.');
    }, 120000);
  } catch (e) { status(e.message?.includes('Songsterr') || e.message?.includes('connection') ? e.message : "Couldn't generate this tab. Try another Songsterr version.", true); }
  finally { lock(false); }
}
