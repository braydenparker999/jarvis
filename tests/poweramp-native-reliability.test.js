import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

// Run the real browser engine and installed transport wrappers without browser,
// network, wall-clock sleeps, or third-party test dependencies.
const source = await readFile(process.env.POWERAMP_PLAYER_SOURCE || new URL('../public/drawercast/player.js', import.meta.url), 'utf8');
function block(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Player source block exists: ${start}`);
  return source.slice(first, last);
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function eventTarget(extra = {}) {
  const events = new Map();
  return {...extra, addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    emit(name, detail = {}) { for (const fn of [...(events.get(name) || [])]) fn({type: name, ...detail}); }};
}

function fakeClock() {
  let now = 1_800_000_000_000, id = 0;
  const pending = new Map(), scheduled = [];
  return {
    now: () => now, pending, scheduled,
    setTimeout(fn, delay = 0) {
      const timer = {id: ++id, fn, delay: Math.max(0, Number(delay) || 0), at: now + Math.max(0, Number(delay) || 0)};
      pending.set(timer.id, timer); scheduled.push(timer); return timer.id;
    },
    clearTimeout(timer) { pending.delete(timer); },
    elapse(ms) { now += ms; },
    async advance(ms) {
      const end = now + ms; let calls = 0;
      while (true) {
        const next = [...pending.values()].filter(t => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        assert.ok(++calls < 500, 'timer scheduling is bounded');
        now = Math.max(now, next.at); pending.delete(next.id); next.fn(); await flush();
      }
      now = end; await flush();
    }
  };
}

class FakeAudio {
  constructor() {
    this._src = ''; this.sources = []; this.loads = 0; this.attempts = [];
    this.paused = true; this.ended = false; this.error = null; this.readyState = 0;
    this.networkState = 0; this.currentTime = 0; this.duration = NaN; this.volume = 1;
    this.events = new Map(); this.pauseTasks = new Set(); this.cancelPauseOnLoad = false;
  }
  get src() { return this._src; }
  set src(value) {
    this._src = String(value); this.sources.push(this._src);
    this.currentTime = 0; this.readyState = 0; this.duration = NaN; this.ended = false;
  }
  get currentSrc() { return this._src; }
  setAttribute() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  addEventListener(name, fn) {
    if (!this.events.has(name)) this.events.set(name, new Set());
    this.events.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.events.get(name)?.delete(fn); }
  emit(name) { for (const fn of [...(this.events.get(name) || [])]) fn({type: name, target: this}); }
  pause() {
    const changed = !this.paused; this.paused = true;
    if (changed) {
      let task; task = this.dispatch(() => { this.pauseTasks.delete(task); this.emit('pause'); });
      this.pauseTasks.add(task);
    }
  }
  load() {
    this.loads++; this.error = null; this.currentTime = 0; this.readyState = 0;
    if (this.cancelPauseOnLoad) { for (const task of this.pauseTasks) this.cancelDispatch(task); this.pauseTasks.clear(); }
  }
  play() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    this.attempts.push({resolve, reject, promise, source: this.src});
    // A play request is not evidence that data or Web Audio output is advancing.
    this.paused = false; return promise;
  }
  metadata(duration = 200) { this.readyState = 1; this.duration = duration; this.emit('loadedmetadata'); }
  playing() { this.paused = false; this.readyState = 4; this.emit('playing'); this.attempts.at(-1)?.resolve(); }
  progress(seconds) { this.currentTime = seconds; this.emit('timeupdate'); }
}

function fakeContextClass() {
  const param = () => ({value: 0, setTargetAtTime(){}, cancelScheduledValues(){}, setValueAtTime(){}, linearRampToValueAtTime(){}});
  const node = () => {
    const n = {connect(){}, disconnect(){}};
    for (const key of ['gain', 'frequency', 'Q', 'threshold', 'knee', 'ratio', 'attack', 'release', 'pan']) n[key] = param();
    return n;
  };
  return class FakeContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.events = new Map(); this.resumeCalls = 0; this.resumeFailure = null; }
    addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); }
    removeEventListener(name, fn) { this.events.get(name)?.delete(fn); }
    change(state) {
      this.state = state; const event = {type: 'statechange', target: this};
      for (const fn of [...(this.events.get('statechange') || [])]) fn(event);
      this.onstatechange?.(event);
    }
    resume() { this.resumeCalls++; return this.resumeFailure ? Promise.reject(this.resumeFailure) : Promise.resolve(); }
    createGain() { return node(); }
    createBiquadFilter() { return node(); }
    createStereoPanner() { return node(); }
    createDynamicsCompressor() { return node(); }
    createAnalyser() { return node(); }
    createConvolver() { return node(); }
    createDelay() { return node(); }
    createChannelSplitter() { return node(); }
    createChannelMerger() { return node(); }
    createMediaElementSource() { return node(); }
  };
}

const cleanR2URL = 'https://music.example.test/music/library/audio/private-native-track-id';
function track(kind = 'native-r2', extra = {}) {
  const defaults = {
    'native-r2': {source: 'r2', nativeR2: true, remote: false},
    'legacy-r2': {source: 'r2', remote: true},
    drive: {source: 'drive', remote: true},
    server: {source: 'server', remote: true},
    local: {source: 'local', remote: false}
  };
  return {id: `private-${kind}-track-id`, title: 'Private song title', dur: 200, ...defaults[kind], ...extra};
}

function harness(kind = 'native-r2', {webAudio = false, installed = true, extra = {}} = {}) {
  const clock = fakeClock(), messages = [], revoked = [], renderStates = [], mediaHandlers = new Map(), nodes = new Map();
  const selected = track(kind, extra), urls = new Map([[selected.id, kind.includes('r2') ? cleanR2URL : kind === 'local' ? 'blob:private-local-file' : `https://audio.example.test/${kind}/private-track?key=private-token-secret`]]);
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {setAttribute(){}, getAttribute(){}, remove(){}, append(){}});
    return nodes.get(selector);
  };
  const AudioContext = fakeContextClass();
  const ctx = vm.createContext({
    Audio: class extends FakeAudio { constructor() { super(); this.dispatch = fn => clock.setTimeout(fn, 0); this.cancelDispatch = clock.clearTimeout; } }, Date: class extends Date { static now() { return clock.now(); } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, debounce: fn => fn,
    clamp: (value, low, high) => Math.max(low, Math.min(high, value)),
    SET: {volume: 1, speed: 1, fadeOnPause: false, fadeLen: 100, gapless: true, crossfade: false, crossfadeLen: 0, audioMode: 'transparent', headsetButtons: true, keepQueue: true},
    SourceLibrary: {kind: t => t?.source || (t?.remote ? 'server' : 'local')},
    AudioQuality: {reset(){}, refreshGain(){}},
    URL: {revokeObjectURL: url => revoked.push(url)},
    document: eventTarget({visibilityState: 'visible', body: {appendChild(){}}}),
    window: eventTarget({AudioContext: webAudio ? AudioContext : undefined, MediaMetadata: class { constructor(data) { Object.assign(this, data); } }}),
    navigator: {onLine: true, mediaSession: {setActionHandler: (name, fn) => mediaHandlers.set(name, fn)}},
    UI: {
      renderPlayState(){renderStates.push({actual: ctx.Engine.playing, wanted: ctx.Engine.wantsPlayback()});},
      renderProgress(){}, renderMeta(){}, renderNowPlaying(){}, startLoop(){}, stopLoop(){}, renderToggles(){}, renderReconnect(){}
    },
    toast: message => messages.push(message),
    DriveSource: {api: {}, status: '', playbackRetry: new Map(), prioritize(){}, pumpTags(){}, scheduleManifestCheck(){}, retryFileFor: t => ({__remoteURL: urls.get(t.id) + '&retry=1'})},
    R2Source: {status: '', fileFor: t => ({__remoteURL: urls.get(t.id)}), connect: async () => true},
    DrawerCast: {canPlay: () => true, fileFor: t => ({__remoteURL: urls.get(t.id)}), markError(){}},
    sourceTrackEnabled: t => !!t && !t.disabled,
    getFileFor: async t => ({__remoteURL: urls.get(t.id)}), audioSource: file => file.__remoteURL,
    LIB: {map: new Map([[selected.id, selected]])}, IDB: {set: async () => {}, get: async () => null},
    localStorage: {getItem: () => null, setItem(){}}, persistTrack(){}, rootsNeedingPermission: () => [],
    getArtURL: async () => null, trackArtist: t => t?.artist || '', trackAlbum: t => t?.album || '',
    nativeValues: () => ({queue_no_shuffle: false, queue_start: 2, queue_end: 1, played_dur: 100}),
    Views: {buildItems(){}, counts: () => ({}), buildFabs(){}, refreshAll(){}, refreshQueueOrder(){}},
    ctxMenuList(){}, $: node, $$: () => [], icoHTML: () => '', saveSet(){},
    FREQ_SETS: {16: Array.from({length: 16}, (_, i) => 20 * (i + 1))}, shuffleArray: a => a.slice()
  });
  const diagnostics = source.includes('const PlaybackDiagnostics={') ? block('const PlaybackDiagnostics={', 'const Engine = {') : '';
  const Engine = vm.runInContext(diagnostics + block('const Engine = {', 'function SET_shuffleOn()') + '\nEngine', ctx);
  const diagnosticReport = () => vm.runInContext('typeof PlaybackDiagnostics === \"undefined\" ? null : PlaybackDiagnostics.report()', ctx);
  ctx.Engine = Engine;
  Engine._playRequest = 1;
  if (installed) vm.runInContext(
    block('const PlaybackQueue={', 'const PlaybackTransitions={') +
    block('const PlaybackTransitions={', 'function installPlaybackRework()') +
    block('function restoreTrackStepOrigin(', '/* Shared finger tracking:') +
    block('function installPlaybackRework(){', '/* Synced lyrics') + '\ninstallPlaybackRework();', ctx);
  Engine.init();
  Engine.queue = [selected]; Engine.order = [0]; Engine.pos = 0; Engine.current = selected; Engine.dur = selected.dur;
  Engine.el().src = urls.get(selected.id); Engine.el().metadata();
  // Effects are outside this transport regression; the actual context creation
  // and statechange handler are retained when webAudio is requested.
  Engine.applyEQ = Engine.applyVolume = Engine.applyReverb = () => {};
  const installedSetGain = Engine.setGain;
  Engine.setGain = () => {}; Engine.rgGain = () => 1; Engine.applySpeed = () => {}; Engine.saveState = () => {};
  const PlaybackTransitions = installed ? vm.runInContext('PlaybackTransitions', ctx) : null;
  const PlaybackQueue = installed ? vm.runInContext('PlaybackQueue', ctx) : null;
  vm.runInContext(block("  window.addEventListener('pagehide'", '  installPlaybackRework();'), ctx);
  return {Engine, PlaybackTransitions, PlaybackQueue, ctx, clock, messages, revoked, renderStates, mediaHandlers, urls, selected, diagnosticReport, installedSetGain,
    audio: () => Engine.el(),
    async start(at = 42) { Engine.play(); Engine.el().playing(); Engine.el().progress(at); await flush(); },
    add(t, url) { urls.set(t.id, url); ctx.LIB.map.set(t.id, t); Engine.queue.push(t); Engine.order.push(Engine.queue.length - 1); }
  };
}

function recoveryLoads(audio, before) { return audio.loads > before.loads || audio.sources.length > before.sources; }
function loadSnapshot(audio) { return {loads: audio.loads, sources: audio.sources.length, attempts: audio.attempts.length}; }
function assertNoNewAudio(audio, before) {
  assert.equal(audio.attempts.length, before.attempts, 'cancelled recovery must not start audio');
  assert.equal(recoveryLoads(audio, before), false, 'cancelled recovery must not reload audio');
}


const addNext = (h, suffix = 'next') => {
  const t = track('native-r2', {id: 'private-native-' + suffix});
  h.add(t, 'https://music.example.test/music/library/audio/' + suffix); return t;
};
const endWithoutEvent = a => {a.currentTime = a.duration; a.ended = true; a.paused = true;};
const online = h => {h.ctx.navigator.onLine = true; h.ctx.window.emit('online');};
const hide = h => {h.ctx.document.visibilityState = 'hidden'; h.ctx.document.emit('visibilitychange');};
const show = h => {h.ctx.document.visibilityState = 'visible'; h.ctx.document.emit('visibilitychange');};

for (const webAudio of [false, true]) {
  test(`native R2 ${webAudio ? 'Web Audio' : 'element'} startup preserves a checkpoint before mapping is installed`, async () => {
    const h = harness('native-r2', {webAudio}), a = h.audio();
    h.Engine.releaseSlot(h.Engine.cur); let reads = 0;
    h.ctx.getFileFor = async () => {reads++; return null;};
    h.ctx.IDB.get = async () => ({ids: [h.selected.id], order: [0], pos: 0, curId: h.selected.id, time: 67, savedAt: h.clock.now()});
    assert.equal(await h.Engine.restoreState(), true);
    assert.equal(h.Engine.time(), 67, 'native R2 retains its playhead without requiring the startup mapping');
    assert.equal(reads, 0, 'network restoration waits for explicit Play');
    assert.equal(h.Engine.wantsPlayback(), false); assert.equal(a.attempts.length, 0);
    h.ctx.getFileFor = async () => ({__remoteURL: cleanR2URL});
    h.Engine.play(); await flush(); a.metadata(200);
    assert.equal(a.currentTime, 67); a.playing(); await flush();
    assert.equal(h.Engine.playing, true);
  });
}

for (const visibility of ['visible', 'hidden']) {
  test(`initial R2 seek metadata cannot cancel ${visibility} no-output recovery`, async () => {
    const h = harness(), a = h.audio(); h.ctx.document.visibilityState = visibility;
    await h.Engine.playIndex(0, true, 87); const before = loadSnapshot(a);
    a.metadata(200); a.emit('timeupdate');
    assert.equal(a.currentTime, 87); assert.equal(h.Engine.playing, false);
    await h.clock.advance(13000);
    assert.ok(recoveryLoads(a, before), 'a seek is not evidence of flowing audio');
    a.metadata(200); assert.equal(a.currentTime, 87);
  });
  test(`manual seek during ${visibility} buffering retains a bounded deadline at the requested position`, async () => {
    const h = harness(); h.ctx.document.visibilityState = visibility; await h.start(42);
    const a = h.audio(), before = loadSnapshot(a); a.emit('waiting');
    await h.clock.advance(4000); h.Engine.seek(90); a.emit('timeupdate');
    await h.clock.advance(13000);
    assert.ok(recoveryLoads(a, before), 'seeking does not indefinitely clear a still-stalled stream');
    a.metadata(200); assert.equal(a.currentTime, 90);
  });
}

for (const lifecycle of ['pageshow', 'resume', 'visibilitychange']) {
  test(`${lifecycle} consumes a missed native R2 end exactly once`, async () => {
    const h = harness(), next = addNext(h); addNext(h, 'after'); await h.start(198); hide(h);
    const a = h.audio(); endWithoutEvent(a);
    const emit = () => lifecycle === 'pageshow' ? h.ctx.window.emit(lifecycle, {persisted: true}) : lifecycle === 'resume' ? h.ctx.document.emit(lifecycle) : show(h);
    emit(); emit(); await flush();
    assert.equal(h.Engine.current.id, next.id); assert.equal(h.Engine.pos, 1);
    const active = h.audio(), attempts = active.attempts.length; active.metadata(200); active.playing(); active.progress(1); await flush();
    a.emit('ended'); emit(); await flush();
    assert.equal(h.Engine.current.id, next.id); assert.equal(active.attempts.length, attempts);
    assert.equal(h.Engine.playing, true);
  });
}

for (const action of ['pause', 'stop', 'focus']) {
  test(`lifecycle return preserves intentional ${action} even with an ended flag`, async () => {
    const h = harness(); addNext(h); await h.start(198);
    if (action === 'focus') h.mediaHandlers.get('pause')(); else h.Engine[action]();
    endWithoutEvent(h.audio()); const before = h.Engine.els.map(loadSnapshot), selected = h.Engine.current;
    hide(h); show(h); h.ctx.window.emit('pageshow', {persisted: true}); h.ctx.document.emit('resume'); online(h);
    await h.clock.advance(60000);
    assert.equal(h.Engine.current, selected); assert.equal(h.Engine.wantsPlayback(), false);
    h.Engine.els.forEach((a, i) => assertNoNewAudio(a, before[i]));
  });
}

test('lifecycle observation of an unreported native focus pause yields intent without autoplay', async () => {
  const h = harness(); await h.start(42); const a = h.audio(); a.paused = true;
  const before = loadSnapshot(a); show(h); h.ctx.document.emit('resume'); online(h); await h.clock.advance(60000);
  assert.equal(h.Engine.wantsPlayback(), false); assert.equal(h.Engine.playing, false);
  assertNoNewAudio(a, before);
});

test('offline R2 recovery waits for online, reloads once at its saved position and keeps its retry bound', async () => {
  const h = harness(); await h.start(42); const a = h.audio(), before = loadSnapshot(a);
  h.ctx.navigator.onLine = false; h.ctx.window.emit('offline'); a.error = {code: 2}; a.emit('error');
  await h.clock.advance(16000);
  assertNoNewAudio(a, before); assert.equal(h.Engine.wantsPlayback(), true); assert.equal(h.Engine.playing, false);
  a.emit('error'); await flush(); online(h); online(h); await flush(); await h.clock.advance(1000);
  assert.equal(a.sources.slice(before.sources).filter(Boolean).length, 1, 'one clean-URL recovery is allocated');
  assert.equal(a.src, cleanR2URL); a.metadata(200); assert.equal(a.currentTime, 42); a.playing(); await flush();
  a.error = {code: 2}; a.emit('error'); await h.clock.advance(60000); online(h); await flush();
  assert.equal(h.Engine.wantsPlayback(), false); assert.equal(h.Engine.playing, false);
  assert.equal(a.sources.slice(before.sources).filter(Boolean).length, 1, 'later network events cannot replenish the retry budget');
});

test('offline recovery expires visibly and a later online event requires explicit Play', async () => {
  const h = harness(); await h.start(51); const a = h.audio(); h.ctx.navigator.onLine = false;
  a.error = {code: 2}; a.emit('error'); await h.clock.advance(60000);
  assert.equal(h.Engine.wantsPlayback(), false); assert.equal(h.Engine.playing, false);
  const before = loadSnapshot(a); online(h); show(h); await h.clock.advance(60000); assertNoNewAudio(a, before);
  h.Engine.play(); await flush(); a.metadata(200); assert.equal(a.currentTime, 51);
});

for (const action of ['pause', 'stop', 'focus', 'selection']) {
  test(`offline retry completion cannot cross a newer ${action}`, async () => {
    const h = harness(), next = addNext(h); await h.start(42); const a = h.audio(); h.ctx.navigator.onLine = false;
    a.error = {code: 2}; a.emit('error'); await h.clock.advance(1000);
    if (action === 'focus') h.mediaHandlers.get('pause')(); else if (action === 'selection') await h.Engine.playIndex(1, false); else h.Engine[action]();
    const selected = h.Engine.current, before = h.Engine.els.map(loadSnapshot);
    online(h); show(h); h.ctx.window.emit('pageshow'); await h.clock.advance(60000);
    assert.equal(h.Engine.current, selected); if (action === 'selection') assert.equal(selected.id, next.id);
    assert.equal(h.Engine.wantsPlayback(), false); assert.equal(h.Engine.playing, false);
    h.Engine.els.forEach((a, i) => assertNoNewAudio(a, before[i]));
  });
}

test('throttled recovery timer rechecks Pause, source ownership and queued ended events', async () => {
  const h = harness(), next = addNext(h); await h.start(42); const a = h.audio();
  a.emit('waiting'); h.clock.elapse(90000); h.Engine.pause();
  const before = h.Engine.els.map(loadSnapshot); a.emit('ended'); online(h); show(h); await h.clock.advance(0);
  assert.equal(h.Engine.current.id, h.selected.id); assert.notEqual(h.Engine.current.id, next.id);
  assert.equal(h.Engine.wantsPlayback(), false); h.Engine.els.forEach((a, i) => assertNoNewAudio(a, before[i]));
});

test('throttled watchdog checks real playhead progress before spending a retry', async () => {
  const h = harness(); await h.start(42); const a = h.audio(), before = loadSnapshot(a); a.emit('waiting');
  h.clock.elapse(90000); a.currentTime = 132; await h.clock.advance(0);
  assertNoNewAudio(a, before); assert.equal(h.Engine.wantsPlayback(), true);
});

for (const repeat of ['off', 'one', 'all']) {
  test(`missed ended recovery preserves ${repeat} repeat and reordered queue occurrences`, async () => {
    const h = harness(), second = addNext(h, 'second'); h.add(h.selected, cleanR2URL);
    h.ctx.SET.repeatMode = repeat; h.Engine.order = [1, 0, 2]; h.Engine.pos = 2; await h.start(198);
    endWithoutEvent(h.audio()); h.ctx.document.emit('resume'); await flush();
    if (repeat === 'off') assert.equal(h.Engine.wantsPlayback(), false);
    else if (repeat === 'one') {assert.equal(h.Engine.current.id, h.selected.id); assert.equal(h.Engine.pos, 2); assert.equal(h.audio().attempts.length, 2);}
    else {assert.equal(h.Engine.current.id, second.id); assert.equal(h.Engine.pos, 0);}
  });
}

test('missed end enters and finishes an explicit queue using its existing resume order', async () => {
  const h = harness(), next = addNext(h), queued = addNext(h, 'queued'); await h.start(198);
  h.PlaybackQueue.pending = [queued.id]; h.PlaybackQueue.forced = true;
  endWithoutEvent(h.audio()); h.ctx.document.emit('resume'); await flush();
  assert.equal(h.PlaybackQueue.active, true); assert.equal(h.Engine.current.id, queued.id);
  h.audio().metadata(200); h.audio().playing(); await flush(); endWithoutEvent(h.audio()); show(h); await flush();
  assert.equal(h.PlaybackQueue.active, false); assert.equal(h.Engine.current.id, next.id);
});

for (const state of ['suspended', 'interrupted', 'closed']) {
  test(`lifecycle and online never override an AudioContext ${state} interruption`, async () => {
    const h = harness('native-r2', {webAudio: true}); await h.start(42); h.Engine.ctx.change(state);
    const before = h.Engine.els.map(loadSnapshot), resumes = h.Engine.ctx.resumeCalls;
    show(h); h.ctx.document.emit('resume'); h.ctx.window.emit('pageshow'); online(h); await h.clock.advance(60000);
    assert.equal(h.Engine.wantsPlayback(), false); assert.equal(h.Engine.playing, false); assert.equal(h.Engine.ctx.resumeCalls, resumes);
    h.Engine.els.forEach((a, i) => assertNoNewAudio(a, before[i]));
  });
}

test('background diagnostics explain mode, online recovery and missed ends without private media identifiers', async () => {
  const h = harness(); await h.start(42); h.ctx.navigator.onLine = false; hide(h); h.audio().error = {code: 2}; h.audio().emit('error');
  await h.clock.advance(1000); const report = h.diagnosticReport(), entry = report.events.at(-1);
  assert.equal(entry.online, false); assert.equal(entry.mode, 'transparent'); assert.equal(entry.gapless, true); assert.equal(entry.crossfade, false);
  assert.ok(report.events.some(e => e.event === 'r2-retry-waits-online'));
  const text = JSON.stringify(report);
  for (const privateValue of [cleanR2URL, h.selected.id, h.selected.title, 'private-token-secret']) assert.equal(text.includes(privateValue), false);
  report.events[0].online = 'tampered'; assert.notEqual(h.diagnosticReport().events[0].online, 'tampered');
});

for (const action of ['pause', 'stop', 'selection']) {
  test(`late normal gapless preload after ${action} cannot claim or overwrite an audio slot`, async () => {
    const h = harness(), next = addNext(h); let complete;
    const original = h.ctx.getFileFor;
    h.ctx.getFileFor = async () => new Promise(resolve => {complete = resolve;});
    await h.start(190); assert.equal(typeof complete, 'function');
    h.ctx.getFileFor = original;
    if (action === 'selection') await h.Engine.playIndex(1, false); else h.Engine[action]();
    const selected = h.Engine.current, before = h.Engine.els.map(loadSnapshot);
    complete({__remoteURL: h.urls.get(next.id)}); await flush(); await h.clock.advance(60000);
    assert.equal(h.Engine.current, selected); assert.equal(h.Engine._preloading, false);
    h.Engine.els.forEach((a, i) => assertNoNewAudio(a, before[i]));
    assert.equal(h.Engine.preloadId, null);
  });
}

test('ordinary gapless promotion reloads an errored spare and retains a fresh bounded retry', async () => {
  const h = harness(), next = addNext(h); await h.start(198); await flush();
  const outgoing = h.audio(), spare = h.Engine.other(); assert.equal(h.Engine.preloadId, next.id);
  spare.error = {code: 2}; spare.emit('error'); endWithoutEvent(outgoing); outgoing.emit('ended'); await flush();
  assert.equal(h.Engine.current.id, next.id); assert.equal(h.Engine.wantsPlayback(), true);
  const a = h.audio(); assert.equal(a.error, null); a.metadata(200); a.playing(); await flush();
  const before = loadSnapshot(a); a.error = {code: 2}; a.emit('error'); await h.clock.advance(1000);
  assert.ok(recoveryLoads(a, before)); assert.equal(h.Engine.wantsPlayback(), true);
});

test('offline retry keeps a later seek and cannot allocate extra reloads from duplicate notifications', async () => {
  const h = harness(); await h.start(42); const a = h.audio(), before = loadSnapshot(a); h.ctx.navigator.onLine = false;
  a.error = {code: 2}; a.emit('error'); await h.clock.advance(1000); h.Engine.seek(93); a.emit('timeupdate');
  for (let i = 0; i < 20; i++) {a.emit('error'); a.emit('waiting'); h.ctx.window.emit('offline');}
  online(h); online(h); await h.clock.advance(1000); a.metadata(200);
  assert.equal(a.currentTime, 93); assert.equal(a.sources.slice(before.sources).filter(Boolean).length, 1);
  a.playing(); await flush(); h.Engine.pause(); await h.clock.advance(0);
  assert.equal(h.Engine._r2Recovery, null); assert.equal(h.Engine._r2RetryTimer, null);
  assert.equal(h.Engine._stallTimer, null); assert.equal(h.Engine._pendingSeek, null);
});

test('a brief offline hint without media trouble never pauses or reloads healthy native R2', async () => {
  const h = harness(); await h.start(42); const a = h.audio(), before = loadSnapshot(a);
  h.ctx.navigator.onLine = false; h.ctx.window.emit('offline'); online(h); show(h); await h.clock.advance(16000);
  assert.equal(h.Engine.playing, true); assert.equal(h.Engine.wantsPlayback(), true); assertNoNewAudio(a, before);
});

for (const code of [3, 4]) {
  test(`offline codec error ${code} stops visibly and does not enter connectivity recovery`, async () => {
    const h = harness(); await h.start(42); const a = h.audio(), before = loadSnapshot(a); h.ctx.navigator.onLine = false;
    a.error = {code}; a.emit('error'); online(h); show(h); await h.clock.advance(60000);
    assertNoNewAudio(a, before); assert.equal(h.Engine.wantsPlayback(), false); assert.equal(h.Engine.playing, false);
  });
}

test('duplicate lifecycle returns honor configured end silence and Pause cancels its sole advance', async () => {
  const h = harness(); addNext(h); await h.start(198); h.ctx.nativeValues = () => ({track_end_silence_ms: 500});
  endWithoutEvent(h.audio()); show(h); h.ctx.document.emit('resume'); h.ctx.window.emit('pageshow');
  assert.equal([...h.clock.pending.values()].filter(t => t.delay === 500).length, 1);
  assert.equal(h.Engine.playing, false); assert.equal(h.Engine.wantsPlayback(), true);
  h.Engine.pause(); const before = h.Engine.els.map(loadSnapshot); await h.clock.advance(60000);
  assert.equal(h.Engine.current.id, h.selected.id); h.Engine.els.forEach((a, i) => assertNoNewAudio(a, before[i]));
});

test('configured Pause on Screen Off cancels the normal native R2 path', async () => {
  const h = harness(); addNext(h); await h.start(42); h.ctx.nativeValues = () => ({pause_on_screen_off: true});
  hide(h); const before = h.Engine.els.map(loadSnapshot); show(h); h.ctx.document.emit('resume'); online(h); await h.clock.advance(60000);
  assert.equal(h.Engine.wantsPlayback(), false); assert.equal(h.Engine.playing, false);
  h.Engine.els.forEach((a, i) => assertNoNewAudio(a, before[i]));
});

test('returning to the page leaves an explicit pending context resume owned by its original Play', async () => {
  const h = harness('native-r2', {webAudio: true}); const c = h.Engine.ensureCtx(); c.change('suspended');
  let complete; c.resume = () => {c.resumeCalls++; return new Promise(resolve => {complete = resolve;});};
  h.Engine.play(); h.audio().playing(); const attempts = h.audio().attempts.length;
  show(h); h.ctx.document.emit('resume'); h.ctx.window.emit('pageshow');
  assert.equal(h.Engine.wantsPlayback(), true); assert.equal(h.Engine.playing, false); assert.equal(c.resumeCalls, 1);
  c.state = 'running'; complete(); await flush();
  assert.equal(h.Engine.playing, true); assert.equal(h.audio().attempts.length, attempts);
});

function catalogHarness(h) {
  h.ctx.LIB.ids=[...h.ctx.LIB.map.keys()];
  Object.assign(h.ctx, {AbortController, FILES:new Map(), MusicSources:{refresh(){}}, allTracks:()=>[...h.ctx.LIB.map.values()],
    libAdd:t=>h.ctx.LIB.map.set(t.id,t)});
  h.ctx.SourceLibrary.enabled = () => true;
  const R2 = vm.runInContext(block('const R2Source={', '// RAM-only, bounded playback evidence.') + '\nR2Source', h.ctx);
  R2.native = true; R2.manifestURL = 'https://music.example.test/music/library.json';
  R2.helper = {readLibrary:async()=>({tracks:[...h.ctx.LIB.map.values()],mapping:{mediaURL:t=>h.urls.get(t.id)}})};
  h.ctx.IDB.r2Catalog = async (_helper,_mapping,tracks) => ({fresh:tracks,gone:[]});
  return R2;
}

test('native R2 refresh defers library scans while an ordinary Play is still waiting for output', async () => {
  const h = harness(), R2 = catalogHarness(h); let reads = 0;
  R2.helper.readLibrary = async()=>{reads++; throw Error('No scan is needed while playback is wanted');};
  h.Engine.play(); assert.equal(h.Engine.playing, false); assert.equal(h.Engine.wantsPlayback(), true);
  assert.equal(await R2.connect(true), false); assert.equal(reads, 0);
});

test('R2 catalog refresh preserves duplicate occurrences and the selected shuffled occurrence', async () => {
  const h = harness(); addNext(h); h.add(h.selected, cleanR2URL); addNext(h,'last');
  h.Engine.order = [2, 1, 0, 3]; h.Engine.pos = 0; const R2 = catalogHarness(h);
  assert.equal(await R2.connect(true), true);
  assert.deepEqual(Array.from(h.Engine.order), [2, 1, 0, 3]); assert.equal(h.Engine.pos, 0);
  assert.equal(h.Engine.order[h.Engine.pos], 2, 'refresh keeps the second occurrence of A selected');
});

test('catalog commit completing after a new R2 Play defers in-memory queue and source changes', async () => {
  const h = harness(), next = addNext(h), R2 = catalogHarness(h); let complete;
  h.ctx.IDB.r2Catalog = async()=>new Promise(resolve=>{complete=resolve;});
  const refresh = R2.connect(true); await flush(); assert.equal(typeof complete, 'function');
  h.Engine.play(); const queue = h.Engine.queue, current = h.Engine.current;
  complete({fresh:[next],gone:[h.selected.id]}); await refresh; await flush();
  assert.equal(h.Engine.current, current); assert.equal(h.Engine.queue, queue);
  assert.equal(h.Engine.wantsPlayback(), true, 'a stale catalog commit must not stop the new Play');
});

test('online R2 retry delay remains cancellable before spending its sole network reload', async () => {
  const h = harness(); await h.start(42); const a = h.audio(), before = loadSnapshot(a);
  a.error = {code: 2}; a.emit('error'); h.Engine.pause(); await h.clock.advance(60000);
  assertNoNewAudio(a, before); assert.equal(h.Engine._r2Recovery, null);
});

test('throttled buffering and spare errors expose timing and slot evidence without consuming the active retry', async () => {
  const h = harness(); await h.start(42); const retry = h.Engine._r2RetryId; h.audio().emit('waiting'); h.clock.elapse(90000);
  h.Engine.tracePlayback('visibility'); const waiting = h.diagnosticReport().events.at(-1);
  assert.equal(waiting.bufferingMs, 90000); assert.equal(waiting.screenOffPause, false);
  h.Engine.other().error = {code: 2}; h.Engine.other().emit('error');
  const spare = h.diagnosticReport().events.at(-1);
  assert.equal(spare.event, 'preload-media-error'); assert.equal(spare.eventSlot, 1-h.Engine.cur); assert.equal(spare.eventMediaError, 2);
  assert.equal(h.Engine._r2RetryId, retry); assert.equal(h.Engine.wantsPlayback(), true);
  for(let i=0;i<160;i++)h.Engine.tracePlayback('preload-media-error',{slot:1-h.Engine.cur,reason:'NotSupportedError',error:'NotSupportedError'});
  assert.ok(JSON.stringify(h.diagnosticReport()).length<32000,'even dense timing and spare-state rows retain the report size bound');
});
