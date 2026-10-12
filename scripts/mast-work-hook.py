#!/usr/bin/env python3
"""One explicit Muse Work invocation. Inert until a host supplies approved auth."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import stat
import sys
import time
from lib.mast_work_hook import MastWorkHook
from lib.mast_cli_transport import MastCliTransport
from lib.project_hook import RemoteError

BASE = 'https://jarvis-hub-api.braydenparker999.workers.dev/relay/mast'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['scan', 'reserve', 'started', 'status', 'report', 'complete', 'inspect', 'file'])
    p.add_argument('--job-id')
    p.add_argument('--attachment-id')
    p.add_argument('--output-file')
    p.add_argument('--run-id')
    p.add_argument('--payload-digest')
    p.add_argument('--host-run-id')
    p.add_argument('--event-id')
    p.add_argument('--stage', choices=['running', 'waiting_for_owner', 'failed', 'cancelled'])
    p.add_argument('--outcome', choices=['known', 'unknown', 'not_started'])
    p.add_argument('--active', action='store_true', help='Executing host attests the run is genuinely active; never use from a poll')
    p.add_argument('--body-file')
    p.add_argument('--summary-file')
    a = p.parse_args()
    os.umask(0o077)
    directory = Path(os.environ['JARVIS_MAST_WORK_STATE_DIRECTORY'])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    mode = directory.lstat()
    if not stat.S_ISDIR(mode.st_mode) or stat.S_IMODE(mode.st_mode) & 0o077 or mode.st_uid != os.getuid():
        raise ValueError('private_state_directory_required')
    # This separate directory must never point at a project hook journal.
    with (directory / 'hook.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 75
        deadline = time.monotonic() + 45
        def timeout(_signum, _frame):
            raise RemoteError(503, 'invocation_budget_exhausted')
        signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, 45)
        request = None
        if a.command != 'inspect':
            request = MastCliTransport(os.environ['JARVIS_MAST_RELAY_HELPER'],
                os.environ['JARVIS_MAST_RELAY_SHA256'], directory, deadline)
        hook = MastWorkHook(directory / 'mast-work.sqlite', request, BASE)
        def content(path):
            if not path:
                raise ValueError('content_file_required')
            with open(path, encoding='utf-8') as source:
                value = source.read(16001)
            if len(value) > 16000:
                raise ValueError('content_file_too_large')
            return value
        try:
            if a.command == 'scan': result = hook.scan()
            elif a.command == 'inspect': result = hook.inspect()
            elif a.command == 'reserve': result = hook.reserve(a.job_id)
            elif a.command == 'status': result = hook.status(a.job_id)
            elif a.command == 'file':
                data = hook.file(a.job_id, a.attachment_id)
                if not a.output_file:
                    raise ValueError('output_file_required')
                with open(a.output_file, 'xb') as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                result = {'saved': True, 'sizeBytes': len(data)}
            elif a.command == 'started': result = hook.started(a.job_id, a.run_id, a.payload_digest, a.host_run_id)
            elif a.command == 'report': result = hook.report(a.job_id, a.run_id, a.event_id, a.stage, content(a.summary_file), a.outcome, a.active)
            else: result = hook.complete(a.job_id, a.run_id, content(a.body_file), content(a.summary_file))
            print(json.dumps(result, separators=(',', ':')), flush=True)
        finally:
            hook.close()
            signal.setitimer(signal.ITIMER_REAL, 0)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except RemoteError as error:
        print(json.dumps({'wake': False, 'error': error.code}), file=sys.stderr)
        sys.exit(2 if error.status in (401, 403) else 1)
    except Exception:
        # No private request content, server bodies or credentials in diagnostics.
        print(json.dumps({'wake': False, 'error': 'mast_work_hook_unavailable'}), file=sys.stderr)
        sys.exit(1)
