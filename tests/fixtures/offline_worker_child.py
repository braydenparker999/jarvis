"""Locally authored subprocess fixture: fake server only, no HTTP/credentials."""
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.prototypes import upload_checkpoints as cp
from scripts.prototypes.worker_boundary import Claim, guarded_request, write_report

manifest, report, attempt, claim_json, audio_path, stop, log, mode = sys.argv[1:9]
value = Claim(**json.loads(claim_json))
with Path(audio_path).open('rb') as stream: body = stream.read(32*1024*1024+1)
if len(body) != value.size or cp.sha(body) != value.sha256: raise RuntimeError('fixture snapshot identity')
tags = {'title': 'First', 'audioAnalysis': {'version': 2}}
cover = None
if len(sys.argv) > 9:
    prepared = json.loads(Path(sys.argv[9]).read_bytes())
    if prepared['context'] != {'job': value.job, 'revision': value.generation, 'recipe': 'recipe1', 'destination': 'https://fixture.invalid'}:
        raise RuntimeError('fixture prepared context mismatch')
    metadata = Path(sys.argv[9]).with_name('prepared-metadata.json').read_bytes()
    if cp.sha(metadata) != prepared['metadataSha256']: raise RuntimeError('fixture metadata identity')
    tags = json.loads(metadata)
    if prepared['cover'] is not None:
        info = prepared['cover']
        cover = Path(sys.argv[9]).with_name(info['file']).read_bytes()
        if len(cover) != info['size'] or cp.sha(cover) != info['sha256']: raise RuntimeError('fixture cover identity')
if mode == 'timeout':
    print('partial output', flush=True); time.sleep(10)
if mode == 'no_report': sys.exit(0)
proof = {'etag': 'fixture_proof', 'size': len(body), 'lastModified': '2026-10-10T00:00:00.000Z'}
track = 'r2_native_' + cp.sha(body)

def raw(method, url, data, mime, public):
    with open(log, 'a') as stream: stream.write(url + '\n')
    if mode == 'auth':
        return {'status': 401, 'url': url, 'content_type': 'application/json', 'body': b'{}'}
    if '/audio/' in url:
        result = {'key': 'native/audio/' + cp.sha(body) + '.opus', 'sha256': cp.sha(body), 'size': len(body), 'r2Identity': proof}
        if mode == 'stop_between': Path(stop).touch()
        if len(sys.argv) > 10:
            barrier = Path(sys.argv[10])
            barrier.with_suffix('.ready').touch()
            deadline = time.monotonic()+3
            while not barrier.with_suffix('.release').exists():
                if time.monotonic() > deadline: raise RuntimeError('fixture barrier timeout')
                time.sleep(0.005)
    elif '/art/' in url:
        result = {'key': url.split('/music/uploads/')[1].replace('art/', 'native/art/'),
                  'sha256': cp.sha(data), 'size': len(data),
                  'r2Identity': {**proof, 'size': len(data)}}
    elif url.endswith('/register'):
        Path(str(report)+'.registration').write_bytes(data)
        result = {'registered': True, 'duplicate': mode == 'analysis', 'id': track, 'count': 1}
    elif url.endswith('/library.json'):
        result = {'tracks': [{'id': track, 'sha256': cp.sha(body), 'size': len(body), 'r2Identity': proof,
                              'metadata': {'audioAnalysis': {'version': 1, 'z': 2, 'a': 1}}}]}
    else:
        result = {'registered': True, 'analysisUpdated': True, 'id': track, 'count': 1}
    return {'status': 200, 'url': url, 'content_type': 'application/json', 'body': json.dumps(result).encode()}

def guarded(*args):
    return guarded_request(manifest, value, attempt, [stop], raw, *args)

journal = str(report) + '.journal'
with cp.session(journal, 'https://fixture.invalid', 'a'*64, create=True) as current:
    current.put('audio', body, 'opus', cp.ValidatedPutSender(guarded, 'https://fixture.invalid', 'a'*64))
    registration = {'sha256': cp.sha(body), 'size': len(body), 'metadata': tags}
    if cover is not None:
        ext = prepared['cover']['ext']
        current.put('art', cover, ext, cp.ValidatedPutSender(guarded, 'https://fixture.invalid', 'a'*64))
        registration['cover'] = {'sha256': cp.sha(cover), 'size': len(cover), 'ext': ext}
    result = current.register_with_analysis(cp.encode(registration), guarded)
if mode == 'bad_report': attempt = 'stale-attempt'
if mode == 'false_registered': result['registered'] = False
write_report(report, value, attempt, result)
if mode == 'mutate_audio': Path(audio_path).write_bytes(b'changed')
if mode == 'after_report_crash': os._exit(9)
