"""Build a pinned staging tree using text/AST only; never import supplied source.

Input files are operator-provided canonical Mast sources. Output is outside the
repository. Missing writer implementations remain an explicit activation gate.
"""
import argparse
import ast
import difflib
import hashlib
import json
from pathlib import Path
import shutil

PINS = {
    'relay-worker.py': '75b00f687efba00e8c14db33694cb524c6301b05ac5ec52f9ee516790ea9377f',
    'upload-music-r2.py': '7cb0a7b9015dc1a536a3365f7e1a4d0c1c9b305cda4a2e9c02e5eb3ccd135c4c',
    'manifest_lib.py': '97e0be0448ee20b379fe64970af25b63b5ae91b29a5f657c8e01efb22be6a303',
    'relay-uploader.py': '7e25140df4f072ef7c1b9a7c03008483827fa90cae3144479b2f97be9033d6b6',
}


def function(source, name, replacement):
    node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == name)
    lines = source.splitlines(True)
    return ''.join(lines[:node.lineno-1]) + replacement.rstrip()+'\n' + ''.join(lines[node.end_lineno:])


def once(source, old, new):
    if source.count(old) != 1:
        raise ValueError('Call-site context drift')
    return source.replace(old, new)


def worker(source, origin):
    source = once(source, 'import json\n', 'import json\nimport scripts.staging.mast_runtime as mast\n')
    source = once(source, 'MAX_ATTEMPTS = 5', f'ORIGIN = {origin!r}\nMAX_ATTEMPTS = 5')
    for name, replacement in {
        '_locked_json': 'def _locked_json(path):\n    return mast.transaction(path)',
        '_read_locked': 'def _read_locked(f):\n    return f.value',
        '_write_locked': 'def _write_locked(f, obj):\n    f.commit(obj)',
        'claim_next': 'def claim_next():\n    return mast.claim_next(sys.modules[__name__])',
        'set_status': 'def set_status(*args, **kwargs):\n    raise RuntimeError("Unfenced status mutation disabled")',
        'heartbeat': 'def heartbeat(*args, **kwargs):\n    raise RuntimeError("Use generation-fenced runtime heartbeat")',
        'run_attempt': 'def run_attempt(*args, **kwargs):\n    raise RuntimeError("Unfenced uploader invocation disabled")',
        'process': 'def process(sha, entry):\n    return mast.process(sys.modules[__name__], sha, entry)',
    }.items():
        source = function(source, name, replacement)
    source = once(source, '    WID = args.worker\n', '    WID = args.worker\n    mast.require_qualification(R2DIR)\n')
    source = once(source, '        rest = pacing_wait()\n', '''        if os.path.lexists(os.path.join(R2DIR, "DRAIN")):
            return 0
        rest = pacing_wait()
        if any(os.path.lexists(p) for p in (STOP, AUTH_STOP, os.path.join(R2DIR, "DRAIN"))):
            return 0
''')
    return source


def manifest(source):
    source = once(source, 'import json\n', 'import json\nimport scripts.staging.mast_runtime as mast\n')
    source = function(source, 'load', '''def load():
    with mast.Transaction(MANIFEST) as tx:
        return tx.value
''')
    source = function(source, 'save', '''def save(manifest):
    raise RuntimeError("Whole-snapshot save disabled; use a current-state transaction")
''')
    source = function(source, 'update', '''def update(fn):
    return mast.append_only(MANIFEST, fn, _recompute_stats)
''')
    return source


def launcher(source):
    source = once(source, 'import os\n', 'import os\nimport fcntl\nimport scripts.staging.mast_runtime as mast\n')
    source = once(source, 'POLL_S = 15', 'POLL_S = 15\nDRAIN = os.path.join(R2DIR, "DRAIN")')
    source = function(source, 'stop_workers', '''def stop_workers(procs, reason):
    log(reason)
    return mast.drain_workers(procs, log)
''')
    source = once(source, 'def main():\n', '''def main():
    mast.require_qualification(R2DIR)
    # Stable singleton, not the upload token. Never unlink or replace this file.
    lease = open(os.path.join(R2DIR, "launcher.lock"), "a+b")
    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    mast.launch_ready(os.path.join(R2DIR, "queue-manifest.json"), [STOP, AUTH_STOP, DRAIN])
''')
    source = once(source, '        if os.path.exists(AUTH_STOP):\n', '''        if os.path.lexists(DRAIN):
            return 0 if stop_workers(procs, "DRAIN seen") else 2
        if os.path.exists(AUTH_STOP):
''')
    source = once(source, '            stop_workers(procs, "STOP seen")\n            return 0', '            return 0 if stop_workers(procs, "STOP seen") else 2')
    source = once(source, '            log("%s exited rc=%d; respawning" % (wid, rc))\n            procs[wid] = spawn(wid)', '''            # Unexpected worker death may orphan a request; never auto-respawn.
            with open(DRAIN, "ab") as marker:
                marker.write(b"Unexpected worker exit; reconcile before restart\\n")
                marker.flush(); os.fsync(marker.fileno())
            stop_workers(procs, "worker exit; admission closed")
            return 2''')
    return source


def uploader(source):
    source = once(source, 'import argparse\n', 'import argparse\nimport scripts.staging.mast_runtime as mast\nfrom scripts.staging import prepared_handoff as handoff\n')
    # Preserve the signer, timestamp, request headers and no-redirect transport.
    node = next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='upload_request')
    raw = ''.join(source.splitlines(True)[node.lineno-1:node.end_lineno])
    raw = once(raw, 'def upload_request(method, path, body, mime, key, public):', 'def upload_request_raw(method, path, body, mime, key, public):')
    raw = once(raw, '            return json.loads(response.read(65537))', '''            return {'status': response.status, 'url': response.geturl(),
                    'content_type': response.headers.get('Content-Type', ''), 'body': response.read(65537)}''')
    first = raw.index('        receipt = _http_error_receipt')
    raw = raw[:first]+'''        try:
            return {'status': error.code, 'url': error.geturl(),
                    'content_type': error.headers.get('Content-Type', ''), 'body': error.read(65537)}
        finally:
            error.close()
'''
    cut = len(''.join(source.splitlines(True)[:node.end_lineno]))
    source = source[:cut]+'\n\n'+raw+source[cut:]
    source = once(source, '    args = parser.parse_args()\n', '''    parser.add_argument('--prepare-dir', type=Path)
    parser.add_argument('--prepare-report', type=Path)
    parser.add_argument('--prepared-dir', type=Path)
    parser.add_argument('--prepared-pin')
    parser.add_argument('--expected-sha')
    parser.add_argument('--manifest')
    parser.add_argument('--claim')
    parser.add_argument('--attempt')
    parser.add_argument('--checkpoint')
    parser.add_argument('--stop')
    parser.add_argument('--auth-stop')
    args = parser.parse_args()
    if bool(args.prepare_dir) == bool(args.prepared_dir) or not args.expected_sha:
        parser.error('Require one prepared mode and claimed SHA256')
    if args.prepare_dir and not args.prepare_report:
        parser.error('Local preparation requires a fresh report path')
    if args.prepared_dir and (args.analyze or not all((args.prepared_pin, args.manifest, args.claim,
            args.attempt, args.checkpoint, args.stop, args.auth_stop, args.report))):
        parser.error('Sending requires the fenced worker contract; no re-analysis')
''')
    start=source.index('    key_stat = args.key.stat()'); end=source.index('    tags, cover = prepared(args.file)', start)
    key=source[start:end]
    source=source[:start]+'    if args.prepared_dir:\n'+''.join('    '+l+'\n' for l in key.splitlines())+source[end:]
    start=source.index('    tags, cover = prepared(args.file)'); end=source.index('\n\ndef cli():',start)
    block=source[start:source.index('    data = args.file.read_bytes()', start)]
    block=block.replace('prepared(args.file)','prepared(snapshot)').replace('module.analyze(args.file)','module.analyze(snapshot)')
    replacement='''    if args.prepare_dir:
        snapshot = handoff.snapshot(args.file, args.prepare_dir, args.expected_sha)
'''+''.join('    '+l+'\n' for l in block.splitlines())+'''        pin = handoff.seal(args.prepare_dir, name=args.file.stem+'.opus', origin=ORIGIN,
                           tags=tags, cover=cover, analysis_status=analysis_status)
        handoff.write(args.prepare_report, json.dumps({'preparedPin': pin}).encode())
        return
    def raw(method, url, data, mime, signer):
        if not url.startswith(ORIGIN + '/') or signer != public:
            raise RuntimeError('Transport origin/signer changed')
        if method == 'GET':
            request = urllib.request.Request(url, headers={'User-Agent': 'JarvisMusicUploader/1.0', 'Accept':'application/json'})
            try:
                with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
                    return {'status':response.status, 'url':response.geturl(),
                            'content_type':response.headers.get('Content-Type',''), 'body':response.read(16*1024*1024+1)}
            except urllib.error.HTTPError as error:
                try:
                    return {'status':error.code, 'url':error.geturl(),
                            'content_type':error.headers.get('Content-Type',''), 'body':error.read(65537)}
                finally:
                    error.close()
        return upload_request_raw(method, url[len(ORIGIN):], data, mime, args.key, public)
    raise SystemExit(mast.upload_prepared(manifest=args.manifest, claim=json.loads(args.claim),
        attempt=args.attempt, slot=args.prepared_dir, pin=args.prepared_pin, journal=args.checkpoint,
        report=args.report, origin=ORIGIN, public=public, name=args.file.stem+'.opus', request_once=raw,
        stop_paths=[args.stop,args.auth_stop], auth_stop=args.auth_stop))
'''
    return source[:start]+replacement+source[end:]


def inspect_stage(originals, changed):
    def find(source, name):
        return next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name==name)
    for name in ('prepared', 'signature_message'):
        assert ast.dump(find(originals['upload-music-r2.py'],name)) == ast.dump(find(changed['upload-music-r2.py'],name))
    assert 'mast.process' in ast.unparse(find(changed['relay-worker.py'],'process'))
    assert 'mast.claim_next' in ast.unparse(find(changed['relay-worker.py'],'claim_next'))
    assert 'mast.append_only' in ast.unparse(find(changed['manifest_lib.py'],'update'))
    assert isinstance(find(changed['manifest_lib.py'],'save').body[0], ast.Raise)
    assert 'mast.drain_workers' in ast.unparse(find(changed['relay-uploader.py'],'stop_workers'))
    assert '.terminate(' not in changed['relay-uploader.py']
    assert 'mast.upload_prepared' in ast.unparse(find(changed['upload-music-r2.py'],'main'))
    assert 'response.read(65537)' in ast.unparse(find(changed['upload-music-r2.py'],'upload_request_raw'))
    return ['extraction and signature canonicalization unchanged', 'worker process/claim bound to fenced runtime',
            'manifest updates append-only; stale save disabled', 'launcher drain never terminates',
            'uploader bound to receipt checkpoint runtime; raw responses bounded']


def build(inputs, output):
    originals={}
    for name,pin in PINS.items():
        raw=(inputs/name).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=pin: raise ValueError('Source pin mismatch: '+name)
        originals[name]=raw.decode()
    origin=next(n.value.value for n in ast.parse(originals['upload-music-r2.py']).body
                if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='ORIGIN' for t in n.targets))
    changed={'relay-worker.py':worker(originals['relay-worker.py'],origin),
             'upload-music-r2.py':uploader(originals['upload-music-r2.py']),
             'manifest_lib.py':manifest(originals['manifest_lib.py']),
             'relay-uploader.py':launcher(originals['relay-uploader.py'])}
    output.mkdir(mode=0o700)  # Never overwrite an existing stage or install in place.
    repo=Path(__file__).resolve().parents[2]
    for name,source in changed.items():
        ast.parse(source)  # Syntax inspection, not compilation/execution.
        (output/name).write_text(source)
    for sub in ('scripts/prototypes','scripts/staging'):
        target=output/sub; target.mkdir(parents=True,exist_ok=True)
        (target/'__init__.py').touch()
        (output/'scripts'/'__init__.py').touch()
        names=('upload_checkpoints.py','worker_boundary.py','manifest_transaction.py','process_guard.py','artifact_budget.py') if sub.endswith('prototypes') else ('mast_runtime.py','prepared_handoff.py')
        for name in names: shutil.copyfile(repo/sub/name,target/name)
    (output/'source-call-sites.patch').write_text(''.join(
        ''.join(difflib.unified_diff(originals[name].splitlines(True), source.splitlines(True),
                fromfile='a/'+name, tofile='b/'+name, n=0)) for name,source in changed.items()))
    checks = inspect_stage(originals, changed)
    pins={str(p.relative_to(output)):hashlib.sha256(p.read_bytes()).hexdigest()
          for p in output.rglob('*.py')}
    (output/'qualification.json').write_text(json.dumps({'source':PINS,'staged':pins,'static_call_sites':checks,
        'activation':'BLOCKED: remaining writer bodies/compatible migration and approved transition',
        'missing':['complete queue-append.py','queue-runner.py','build-queue-manifest.py'],
        'external_source_executed':False},indent=2)+'\n')
    return changed

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('inputs',type=Path); parser.add_argument('output',type=Path)
    args=parser.parse_args(); build(args.inputs,args.output)
