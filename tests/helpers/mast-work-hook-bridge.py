"""Synthetic pipe transport into the actual Worker; never uses credentials."""
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
from lib.mast_work_hook import MastWorkHook
from lib.project_hook import RemoteError


def request(method, path, payload):
    print(json.dumps({'request': {'method': method, 'path': path, 'payload': payload}}), flush=True)
    r = json.loads(sys.stdin.readline())
    if r['status'] >= 400:
        raise RemoteError(r['status'], 'synthetic_failure')
    return r['data']


def reopen():
    return MastWorkHook(sys.argv[1], request, 'https://synthetic.invalid/relay/mast')


def fails(fn, error):
    try:
        fn()
    except error:
        return
    raise AssertionError('expected failure')


job, mode = sys.argv[2:4]
h = reopen()
try:
    if mode == 'crash':
        assert h.reserve(job)['wake']
        os._exit(9)  # Persisted reservation, no wake output/receipt reaches host.
    elif mode == 'held':
        assert h.reserve(job)['wake'] is False
        assert h.status(job)['localState'] == 'held'
    else:
        fails(lambda: h.reserve(job), RemoteError)  # Claim committed; response lost.
        h.close(); h = reopen()
        reserved = h.reserve(job)
        assert reserved['wake']
        run = reserved['payload']['runId']
        h.close(); h = reopen()
        assert h.reserve(job)['wake'] is False
        h.started(job, run, reserved['payloadDigest'], 'synthetic-host-run')
        import uuid
        fails(lambda: h.report(job, run, str(uuid.uuid4()), 'running', 'Running'), ValueError)
        h.report(job, run, str(uuid.uuid4()), 'running', 'Running', active=True)
        if mode == 'cancel':
            print(json.dumps({'control': 'cancel'}), flush=True)
            assert json.loads(sys.stdin.readline())['ok']
            assert h.status(job)['stopRequested']
            fails(lambda: h.report(job, run, str(uuid.uuid4()), 'running', 'Running', active=True), ValueError)
            h.report(job, run, str(uuid.uuid4()), 'cancelled', 'Stopped with no effect', 'not_started')
        else:
            fails(lambda: h.complete(job, run, 'Synthetic draft', 'Prepared a draft'), RemoteError)
            h.close(); h = reopen()
            if mode == 'correction':
                print(json.dumps({'control': 'correct'}), flush=True)
                assert json.loads(sys.stdin.readline())['ok']
                fails(lambda: h.complete(job, run, 'Synthetic draft', 'Prepared a draft'), ValueError)
                print(json.dumps({'result': {'ok': True}}), flush=True)
                sys.exit(0)
            fails(lambda: h.complete(job, run, 'Changed body', 'Prepared a draft'), ValueError)
            fails(lambda: h.complete(job, run, 'Synthetic draft', 'Prepared a draft'), RemoteError)
            h.close(); h = reopen()
            out = h.complete(job, run, 'Synthetic draft', 'Prepared a draft')
            assert out['completion']['resultVersion'] == 1
            assert h.complete(job, run, 'Synthetic draft', 'Prepared a draft') == out
    print(json.dumps({'result': {'ok': True}}), flush=True)
finally:
    h.close()
