import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {MAX_R2_MANIFEST_BYTES, readR2Manifest, validateR2Manifest} from '../public/drawercast/r2-api.js';
import {catalogTrack} from '../public/drawercast/drive-catalog.js';

const root = 'musicFolder12345', url = 'https://music.example.test/catalog/drive-r2-map-v1.json';
const verification = 'r2-get-hash-v1';
function fixture() {
  const files = ['driveSong12345', 'driveSong67890'].map((driveId, i) => {
    const md5 = String(i + 1).repeat(32), sha256 = String(i + 3).repeat(64);
    const key = `audio/${driveId}/${md5}.opus`, size = (i + 1) * 320;
    return {driveId, size, md5, sourceMd5:md5, sha256, key, url:'https://music.example.test/' + key,
      mimeType:'audio/ogg', status:i ? 'skipped' : 'copied', verifiedBytes:size, verification};
  });
  const data = {version:1, mode:'full', complete:true, verification, driveRootId:root,
    generatedAt:'2026-10-01T00:00:00Z', publicBaseUrl:'https://music.example.test',
    inventoryCount:2, selectedCount:2, verifiedCount:2, inventoryBytes:960,
    failedCount:0, failures:[], copiedCount:1, skippedCount:1, files};
  const tracks = files.map(file => ({id:'gd_' + file.driveId, remoteId:file.driveId, driveFolder:root,
    source:'drive', remote:true, size:file.size, md5:file.md5, mimeType:file.mimeType, path:'Music/song.opus',
    title:'Prepared title', album:'Prepared album', rating:5, plays:17, artKey:'user-cover', customArt:true, coverURL:'/assets/cover.jpg'}));
  return {data, tracks, options:{root, manifestURL:url, tracks}};
}
const validate = f => validateR2Manifest(f.data, f.options);

test('complete content-verified R2 maps overlay playback without changing any track data', () => {
  const f = fixture(), before = structuredClone(f.tracks), map = validate(f);
  assert.equal(map.count, 2); assert.equal(map.mediaURL(f.tracks[0]), f.data.files[0].url);
  assert.deepEqual(f.tracks, before); assert.equal(Object.isFrozen(map), true);
  f.data.files[0].url = 'https://other.test/injected';
  assert.notEqual(map.mediaURL(f.tracks[0]), f.data.files[0].url, 'validated values are copied');
});

test('smoke, partial, failed, unverified and wrong-root manifests cannot activate R2', () => {
  for (const change of [
    d => {d.mode = 'smoke';}, d => {delete d.complete;}, d => {d.version = 2;},
    d => {d.driveRootId = 'anotherFolder123';}, d => {d.verification = 'head-only';},
    d => {d.inventoryCount++;}, d => {d.selectedCount--;}, d => {d.verifiedCount--;},
    d => {d.inventoryBytes--;}, d => {d.failedCount = 1;}, d => {d.failures = [{}];},
    d => {d.copiedCount++;}, d => {d.skippedCount--;}, d => {d.generatedAt = 'invalid';},
    d => {d.files.pop();}, d => {d.files[1] = {...d.files[0]};}
  ]) {
    const f = fixture(); change(f.data); assert.throws(() => validate(f), /complete, verified/);
  }
});

test('file identity, actual body hashes, byte counts and content-addressed keys are required', () => {
  for (const change of [
    f => {f.md5 = '';}, f => {f.sourceMd5 = '';}, f => {f.sourceMd5 = '9'.repeat(32);},
    f => {f.sha256 = '';}, f => {delete f.verifiedBytes;}, f => {f.verifiedBytes--;},
    f => {f.verification = 'head-only';}, f => {f.status = 'failed';},
    f => {f.size = '320';}, f => {f.size = 0;}, f => {f.mimeType = 'audio/ogg\r\nInjected: x';},
    f => {f.key = f.key.replace(f.md5, '9'.repeat(32));},
    f => {f.key = f.key.replace(f.driveId, 'otherSong12345');},
    f => {f.key = 'audio/../' + f.key;}
  ]) {
    const f = fixture(); change(f.data.files[0]); assert.throws(() => validate(f), /complete, verified/);
  }
  const f = fixture(); f.data.files[0].key = `audio/${f.data.files[0].driveId}/${f.data.files[0].sha256}.opus`;
  f.data.files[0].url = f.data.publicBaseUrl + '/' + f.data.files[0].key;
  assert.ok(validate(f).mediaURL(f.tracks[0]), 'actual SHA-256 content keys are supported');
});

test('mapping must match every catalog track by stable ID, Drive root, size and MD5', () => {
  for (const change of [
    t => {t.id = 'new_id';}, t => {t.remoteId = 'otherSong12345';}, t => {t.size++;},
    t => {t.md5 = '9'.repeat(32);}, t => {t.md5 = '';}, t => {t.driveFolder = 'otherFolder123';},
    t => {t.source = 'server';}
  ]) {
    const f = fixture(); change(f.tracks[0]); assert.throws(() => validate(f), /complete, verified/);
  }
  const f = fixture(); f.tracks[1] = {...f.tracks[0]}; assert.throws(() => validate(f), /complete, verified/);
});

test('new and changed songs fail closed, without retaining stale revision URLs', () => {
  const f = fixture(), map = validate(f);
  assert.equal(map.matches(f.tracks), true);
  assert.equal(map.matches([...f.tracks, {...f.tracks[0], remoteId:'newSong12345'}]), false);
  assert.equal(map.matches(f.tracks.slice(0, 1)), false);
  f.tracks[0].md5 = 'a'.repeat(32);
  assert.equal(map.mediaURL(f.tracks[0]), null); assert.equal(map.matches(f.tracks), false);
});

test('only explicit credential-free HTTPS URLs on the configured map origin are accepted', () => {
  const bad = [
    'http://music.example.test/catalog/map.json', '/catalog/map.json', 'javascript:alert(1)',
    'https://user:secret@music.example.test/catalog/map.json',
    'https://music.example.test/catalog/map.json?token=secret', 'https://music.example.test/catalog/map.json#secret',
    ' https://music.example.test/catalog/map.json', 'https://music.example.test\\evil/catalog/map.json'
  ];
  for (const candidate of bad) {
    const f = fixture(); f.options.manifestURL = candidate; assert.throws(() => validate(f));
  }
  for (const candidate of ['', 'http://music.example.test', 'https://other.example.test',
    'https://user:secret@music.example.test', 'https://music.example.test?token=secret']) {
    const f = fixture(); f.data.publicBaseUrl = candidate; assert.throws(() => validate(f));
  }
  for (const change of [
    f => {f.url = f.url.replace('https:', 'http:');}, f => {f.url += '?token=secret';},
    f => {f.url += '#fragment';}, f => {f.url = f.url.replace('music.example.test', 'other.example.test');},
    f => {f.url = f.url.replace('/audio/', '/other/');}, f => {f.url = f.url.replace('https://', 'https://user:pass@');}
  ]) {
    const f = fixture(); change(f.data.files[0]); assert.throws(() => validate(f));
  }
});

test('a same-origin HTTPS Worker path prefix can supply the playback endpoint', () => {
  const f = fixture(); f.data.publicBaseUrl += '/music/';
  for (const file of f.data.files) file.url = f.data.publicBaseUrl + file.key;
  assert.equal(validate(f).mediaURL(f.tracks[0]), f.data.files[0].url);
});

test('manifest reads omit credentials and referrers, refuse redirects and use a bounded JSON stream', async () => {
  const f = fixture(), controller = new AbortController(); let call;
  const map = await readR2Manifest({url, root, tracks:f.tracks, signal:controller.signal,
    fetcher:async (endpoint, options) => {call = {endpoint, options}; return Response.json(f.data);}});
  assert.equal(map.count, 2); assert.equal(call.endpoint, url);
  assert.deepEqual(call.options, {signal:controller.signal, credentials:'omit', cache:'no-store', mode:'cors', redirect:'error', referrerPolicy:'no-referrer'});
});

test('invalid URLs never reach fetch; redirects, non-JSON, errors and corrupt responses reject', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(readR2Manifest({url:'http://music.example.test/map', root, tracks:f.tracks, fetcher:async () => {calls++;}}));
  assert.equal(calls, 0);
  for (const response of [
    new Response('denied', {status:403}), new Response('<html>login</html>', {headers:{'content-type':'text/html'}}),
    new Response('{', {headers:{'content-type':'application/json'}}),
    new Response(new Uint8Array([0xff]), {headers:{'content-type':'application/json'}}),
    Object.defineProperty(Response.json(f.data), 'redirected', {value:true})
  ]) await assert.rejects(readR2Manifest({url, root, tracks:f.tracks, fetcher:async () => response}));
});

test('compressed or chunked manifests are bounded by decoded bytes, not a hidden wire encoding', async () => {
  const f = fixture();
  const map = await readR2Manifest({url, root, tracks:f.tracks, fetcher:async () =>
    Response.json(f.data, {headers:{'content-length':'100'}})});
  assert.equal(map.count, 2);
});

test('an aborted manifest request never installs a map', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(readR2Manifest({url, root, tracks:f.tracks, signal:controller.signal,
    fetcher:async (_, {signal}) => {signal.throwIfAborted();}}), {name:'AbortError'});
});

test('oversized headers and chunked streams are cancelled before parsing', async () => {
  const f = fixture(); let cancelled = 0, reads = 0;
  const response = {status:200, headers:new Headers({'content-type':'application/json', 'content-length':String(MAX_R2_MANIFEST_BYTES + 1)}),
    body:{async cancel(){cancelled++;}, getReader(){throw Error('must not read');}}};
  await assert.rejects(readR2Manifest({url, root, tracks:f.tracks, fetcher:async () => response}));
  assert.equal(cancelled, 1);
  response.headers.delete('content-length');
  const chunk = new Uint8Array(1024 * 1024);
  response.body.getReader = () => ({async read(){reads++; return {done:false, value:chunk};}, async cancel(){cancelled++;}});
  await assert.rejects(readR2Manifest({url, root, tracks:f.tracks, fetcher:async () => response}));
  assert.equal(cancelled, 2); assert.equal(reads, MAX_R2_MANIFEST_BYTES / chunk.length + 1);
});

const source = await readFile(new URL('../public/drawercast/player.js', import.meta.url), 'utf8');
const block = (a,b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
function integration() {
  const f = fixture(), tracks = f.tracks, timers = [], messages = [];
  const ctx = vm.createContext({AbortSignal, setTimeout:fn => {timers.push(fn); return timers.length;}, clearTimeout(){},
    debounce:fn => fn, baseName:s => s.split('/').at(-1), MusicSources:{refresh(){}}, SourceLibrary:{enabled:() => true},
    allTracks:() => tracks, toast:s => messages.push(s), audioSource:f => f.__remoteURL,
    UI:{renderPlayState(){}, renderProgress(){}, renderMeta(){}, renderNowPlaying(){}, startLoop(){}},
    URL:{revokeObjectURL(){}}, sourceTrackEnabled:() => true});
  const {drive, engine} = vm.runInContext(block('const DriveSource={', 'function SET_repeat()') + '\n({drive:DriveSource,engine:Engine})', ctx);
  drive.folder = root; drive.r2ManifestURL = url; drive.r2Helper = {readR2Manifest:async () => validate(f)};
  drive.api = {mediaURL:({id}) => 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media&key=test'};
  const audio = src => ({src, currentTime:42, duration:100, events:{}, paused:false, plays:0,
    pause(){this.paused=true;}, play(){this.plays++; return Promise.resolve();}, load(){}, removeAttribute(){this.src='';},
    addEventListener(n,fn){this.events[n]=fn;}, removeEventListener(n){delete this.events[n];}});
  engine.els = [audio(f.data.files[0].url), audio('')]; engine.cur = 0; engine.current = tracks[0]; engine._playRequest = 1;
  engine.queue = tracks.slice(); engine.order = [0,1]; engine.pos = 0;
  engine.ensureCtx = engine.setGain = engine.updateMediaSession = engine.applySpeed = engine.seekWhenReady = engine.saveState = () => {};
  engine.rgGain = () => 1;
  ctx.getFileFor = async t => drive.fileFor(t);
  return {...f, drive, engine, ctx, timers, messages};
}

test('optional R2 remains off without configuration and all legacy Drive fields are unchanged', async () => {
  const h = integration(), before = structuredClone(h.tracks); h.drive.r2ManifestURL = '';
  h.drive.r2Helper.readR2Manifest = () => {throw Error('should not fetch');};
  assert.equal(await h.drive.refreshR2(), false);
  assert.match(h.drive.fileFor(h.tracks[0]).__remoteURL, /^https:\/\/www.googleapis.com/);
  assert.deepEqual(h.tracks, before);
  const config = JSON.parse(await readFile(new URL('../public/assets/drive-config.json', import.meta.url), 'utf8'));
  assert.equal(config.r2ManifestURL, '');
});

test('R2 read/schema failure retains Drive playback and all ratings, artwork and playlist IDs', async () => {
  const h = integration(), before = structuredClone(h.tracks), playlist = h.tracks.map(t => t.id);
  assert.equal(await h.drive.refreshR2(), true); assert.equal(h.drive.fileFor(h.tracks[0]).__remoteURL, h.data.files[0].url);
  h.drive.r2Helper.readR2Manifest = async () => {throw Error('invalid or unavailable map');};
  assert.equal(await h.drive.refreshR2(), false); assert.equal(h.drive.r2, null);
  assert.match(h.drive.fileFor(h.tracks[0]).__remoteURL, /^https:\/\/www.googleapis.com/);
  assert.deepEqual(h.tracks, before); assert.deepEqual(h.tracks.map(t => t.id), playlist);
});

test('a catalog revision arriving during map download prevents stale activation', async () => {
  const h = integration(), map = validate(h); let resolve;
  h.drive.r2Helper.readR2Manifest = () => new Promise(r => {resolve=r;});
  const pending = h.drive.refreshR2(); h.tracks[0].md5 = 'a'.repeat(32); resolve(map);
  assert.equal(await pending, false); assert.equal(h.drive.r2, null);
  assert.match(h.drive.fileFor(h.tracks[0]).__remoteURL, /^https:\/\/www.googleapis.com/);
});

test('R2 checks yield to active playback and do not switch a newly started selection', async () => {
  const h = integration(); let calls = 0, resolve;
  h.drive.r2Helper.readR2Manifest = () => {calls++; return new Promise(r => {resolve=r;});};
  h.engine.playing = true; assert.equal(await h.drive.refreshR2(), false); assert.equal(calls, 0);
  h.engine.playing = false; const pending = h.drive.refreshR2();
  h.engine.playing = true; resolve(validate(h)); assert.equal(await pending, false); assert.equal(h.drive.r2, null);
});

test('R2 error retries Drive once at the interrupted position and suppresses the failed revision', async () => {
  const h = integration(); await h.drive.refreshR2(); h.engine.playing = true;
  const selected = h.engine.current, before = structuredClone(selected);
  h.engine.onError(0);
  assert.match(h.engine.el().src, /^https:\/\/www.googleapis.com/); assert.match(h.messages[0], /R2 stream unavailable/);
  h.engine.el().currentTime = 0; h.engine.el().events.loadedmetadata(); assert.equal(h.engine.el().currentTime, 42);
  h.timers[0](); assert.equal(h.engine.el().plays, 1);
  h.engine.onError(0); h.engine.onError(0);
  assert.equal(h.messages.filter(s => s.includes('still could not play')).length, 1);
  assert.equal(h.engine.current, selected); assert.deepEqual(selected, before);
  h.drive.playbackRetry.delete(selected.id);
  assert.match(h.drive.fileFor(selected).__remoteURL, /^https:\/\/www.googleapis.com/, 'a new selection does not repeat a known-bad R2 revision');
  assert.equal(h.drive.fileFor(h.tracks[1]).__remoteURL, h.data.files[1].url, 'other verified songs remain usable');
});

test('late R2 fallback timers cannot restart playback after selecting another song', async () => {
  const h = integration(); await h.drive.refreshR2(); h.engine.onError(0);
  h.engine._playRequest++; h.engine.current = h.tracks[1]; h.timers[0]();
  assert.equal(h.engine.el().plays, 0);
});

test('a stale preloaded R2 URL cannot override a new Drive-only selection', async () => {
  const h = integration(); await h.drive.refreshR2();
  h.drive.r2Failures.add(h.drive.r2Revision(h.tracks[0]));
  h.engine.preloadId = h.tracks[0].id; h.engine.els[1].src = h.data.files[0].url;
  await h.engine.playIndex(0, false);
  assert.match(h.engine.el().src, /^https:\/\/www.googleapis.com/);
  assert.equal(h.engine.els[1].src, ''); assert.equal(h.engine.preloadId, null);
});

test('catalog refresh still preserves stable IDs, prepared artwork and user state independently of R2', () => {
  const f = fixture(), old = f.tracks[0], file = f.data.files[0];
  const record = {id:file.driveId, name:'song.opus', folder:'Music', size:file.size, md5Checksum:file.md5,
    mimeType:'audio/ogg', modifiedTime:'2026-10-01T00:00:00Z', availability:'ready', cover:'c'.repeat(64),
    prepared:{size:file.size, md5:file.md5, title:'Prepared title', album:'Prepared album'}};
  const updated = catalogTrack(record, root, old);
  assert.equal(updated.id, old.id); assert.equal(updated.rating, old.rating); assert.equal(updated.plays, old.plays);
  assert.equal(updated.artKey, old.artKey); assert.equal(updated.customArt, true); assert.match(updated.coverURL, /covers\/c+\.jpg$/);
  assert.equal(updated.title, 'Prepared title'); assert.equal(updated.album, 'Prepared album');
  assert.doesNotMatch(JSON.stringify(updated), /music\.example\.test|r2-get-hash-v1/);
});
