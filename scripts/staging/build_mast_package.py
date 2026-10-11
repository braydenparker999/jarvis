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


WRITER_PINS = {'queue-append.py': '3ce62e43da2b85e361ac7385e14278a7b7cc35a4a5149e64650734744f83a49d', 'queue-runner.py': '47bacb1651dc3a826822c79736968c4e9a8d917b4e1f9adc8d1e37d1370f5d18', 'build-queue-manifest.py': 'a56a29dbb8dac08b95c9cd5218251daebe1f395112d2b46570fb68923f349951'}
REDACTED_PINS = {'queue-append.py': '74e9f864e6008447191340fc6af17315134406cbac04942d86ea8f0b86f2304f', 'queue-runner.py': '5e2ec27106724efdb16e69cfa0442f594339681abbf862451b76e9b69f5501da', 'build-queue-manifest.py': 'c6b0c7137c6b0c2ea6f230710d96803b17d80316ec1ea02b11de14aa5d04a488'}
WRITER_SHAPES = {'queue-append.py': '980c0d6d2a984cf70b163580775d1b0064a177c2d0c9318af71725d2aa88ca8a', 'queue-runner.py': 'fb3e1249868e1b0e6c03809ed1fbb885af26c1ae6612216e83306da99af50e6f', 'build-queue-manifest.py': '76869471f488d8116f9fbe4e3657f025ce6122b415b34e4e8b736d0d4493d2a2'}

def writer_shape(source):
    tree = ast.parse(source)
    # Only declared top-level configuration redactions may differ. No functions,
    # executable branches or other statements are elided from comparison.
    tree.body = [n for n in tree.body if not isinstance(n,ast.Assign) or not any(
        isinstance(v,ast.Name) and v.id in {'WS','KEY','REPORT_DIRS'} for v in n.targets)]
    return hashlib.sha256(ast.dump(tree,include_attributes=False).encode()).hexdigest()


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
    mast.require_qualification(os.path.dirname(MANIFEST))
    return mast.append_only(MANIFEST, fn, _recompute_stats)
''')
    source += '''

def reconcile_scan(candidate):
    mast.require_qualification(os.path.dirname(MANIFEST))
    return mast.reconcile_scan(MANIFEST, candidate, _recompute_stats)
'''
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
            mast.request_drain(os.path.join(R2DIR, "queue-manifest.json"))
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


def queue_append(source):
    # Existing add(m) callback already only inserts missing hashes; keep it intact.
    return once(source, 'def main():\n', 'def main():\n    manifest_lib.mast.check_writer_binding(os.path.join(WS, "r2-upload", "queue-manifest.json"), manifest_lib.MANIFEST)\n    manifest_lib.mast.require_qualification(os.path.dirname(manifest_lib.MANIFEST))\n')


def legacy_runner(source):
    source = once(source, '_logf = open(LOG, "a", buffering=1)', '_logf = None  # Retired entrypoint must not open runtime files.')
    for name, signature in [('process','entry'),('set_status','sha, **fields'),('next_pending','')]:
        source = function(source, name, f'def {name}({signature}):\n    raise RuntimeError("Legacy tokenless runner retired; use the fenced relay")')
    return function(source, 'main', 'def main():\n    print("Legacy tokenless runner retired; use the existing relay launcher")\n    return 2')


def queue_builder(source):
    source = once(source, 'import json\n', 'import json\nimport manifest_lib\n')
    source = once(source, 'def main():\n', 'def main():\n    manifest_lib.mast.check_writer_binding(MANIFEST, manifest_lib.MANIFEST)\n    manifest_lib.mast.require_qualification(os.path.dirname(MANIFEST))\n')
    start = source.index('    tmp = "%s.tmp.%d.%d" % (MANIFEST, os.getpid(), next(_tmp_seq))')
    end = source.index('    print(json.dumps(stats, indent=2))', start)+len('    print(json.dumps(stats, indent=2))')
    return source[:start]+"""    current = manifest_lib.reconcile_scan(manifest)
    print(json.dumps(current["stats"], indent=2))"""+source[end:]


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
    assert 'manifest_lib.update' in ast.unparse(find(changed['queue-append.py'],'main'))
    assert 'manifest_lib.reconcile_scan' in ast.unparse(find(changed['build-queue-manifest.py'],'main'))
    assert 'os.replace' not in ast.unparse(find(changed['build-queue-manifest.py'],'main'))
    assert isinstance(find(changed['queue-runner.py'],'process').body[0],ast.Raise)
    assert 'process' not in ast.unparse(find(changed['queue-runner.py'],'main'))
    return ['all three queue writer call sites integrated; legacy uploader retired', 'extraction and signature canonicalization unchanged', 'worker process/claim bound to fenced runtime',
            'manifest updates append-only; stale save disabled', 'launcher drain never terminates',
            'uploader bound to receipt checkpoint runtime; raw responses bounded']


def build(inputs, output, *, redacted_writers=False):
    originals={}
    for name,pin in PINS.items():
        raw=(inputs/name).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=pin: raise ValueError('Source pin mismatch: '+name)
        originals[name]=raw.decode()
    for name,pin in WRITER_PINS.items():
        raw=(inputs/name).read_bytes()
        expected=REDACTED_PINS[name] if redacted_writers else pin
        if hashlib.sha256(raw).hexdigest()!=expected: raise ValueError('Writer source pin mismatch: '+name)
        if writer_shape(raw)!=WRITER_SHAPES[name]: raise ValueError('Writer control-flow/config-boundary mismatch: '+name)
        originals[name]=raw.decode()
    origin=next(n.value.value for n in ast.parse(originals['upload-music-r2.py']).body
                if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='ORIGIN' for t in n.targets))
    changed={'relay-worker.py':worker(originals['relay-worker.py'],origin),
             'upload-music-r2.py':uploader(originals['upload-music-r2.py']),
             'manifest_lib.py':manifest(originals['manifest_lib.py']),
             'relay-uploader.py':launcher(originals['relay-uploader.py']),
             'queue-append.py':queue_append(originals['queue-append.py']),
             'queue-runner.py':legacy_runner(originals['queue-runner.py']),
             'build-queue-manifest.py':queue_builder(originals['build-queue-manifest.py'])}
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
    (output/'qualification.json').write_text(json.dumps({'source':{**PINS,**(REDACTED_PINS if redacted_writers else WRITER_PINS)},
        'reported_unredacted_writer_hashes':WRITER_PINS,'reviewed_redacted_writer_hashes':REDACTED_PINS,
        'writer_control_flow_hashes':WRITER_SHAPES,'redacted_review_only':redacted_writers,
        'staged':pins,'static_call_sites':checks,
        'activation':'BLOCKED: host source/config qualification, drain/reconciliation and approved transition',
        'missing':[],
        'external_source_executed':False},indent=2)+'\n')
    return changed

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('inputs',type=Path); parser.add_argument('output',type=Path)
    parser.add_argument('--redacted-writers',action='store_true',help='Review-only output; never install redacted configuration')
    args=parser.parse_args(); build(args.inputs,args.output,redacted_writers=args.redacted_writers)
