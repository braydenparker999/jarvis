"""Pinned, owner-Muse-only CLI transport. No credential/socket implementation."""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
from lib.project_hook import RemoteError

HOST = 'jarvis-hub-api.braydenparker999.workers.dev'
CONTRACT = {'protocol': 'jarvis-mast-cli-v1', 'provider': 'custom.jarvis-mast',
            'host': HOST, 'redirects': 'reject', 'response': 'complete-json', 'binary': False}
MAX_OUTPUT = 16_000_000


class MastCliTransport:
    binary_supported = False
    def __init__(self, helper, digest, directory, deadline):
        self.helper, self.digest = Path(helper), digest
        self.directory, self.deadline = directory, deadline
        self.verify_source()
        # Local, no-network contract inspection before any private payload.
        if self.invoke(['describe']) != CONTRACT:
            raise ValueError('owner_mast_helper_contract_required')

    def verify_source(self):
        mode = self.helper.lstat()
        if not self.helper.is_absolute() or not stat.S_ISREG(mode.st_mode) or mode.st_mode & 0o022 or mode.st_uid != os.getuid():
            raise ValueError('private_reviewed_helper_required')
        if not re.fullmatch(r'[a-f0-9]{64}', self.digest) or hashlib.sha256(self.helper.read_bytes()).hexdigest() != self.digest:
            raise ValueError('helper_source_pin_mismatch')

    def invoke(self, arguments):
        self.verify_source()
        end = min(self.deadline, time.monotonic()+20)
        if end <= time.monotonic():
            raise RemoteError(503, 'helper_deadline')
        output = bytearray()
        # No shell, no token/headers in arguments, no stderr forwarding. Kill on
        # timeout/overflow; an uncertain accepted write stays in the caller journal.
        with subprocess.Popen([sys.executable, str(self.helper), *arguments], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True) as process:
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while selector.get_map():
                        remaining = end-time.monotonic()
                        if remaining <= 0: raise RemoteError(503, 'helper_timeout')
                        for key, _ in selector.select(remaining):
                            part = os.read(key.fd, 65536)
                            if not part: selector.unregister(key.fileobj)
                            else: output.extend(part)
                            if len(output) > MAX_OUTPUT: raise ValueError('helper_output_too_large')
                code = process.wait(timeout=max(0.001,end-time.monotonic()))
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        line, separator, body = bytes(output).partition(b'\n')
        if not separator or not re.fullmatch(rb'HTTP [1-5][0-9]{2}', line):
            raise ValueError('invalid_helper_status')
        status = int(line[5:])
        if code != (0 if status < 400 else 1): raise ValueError('helper_exit_status_mismatch')
        if 300 <= status < 400: raise RemoteError(status, 'helper_redirect_rejected')
        data = json.loads(body)  # Reject truncation, trailing logs and invalid UTF-8.
        if not isinstance(data, dict): raise ValueError('invalid_helper_json')
        if status >= 400: raise RemoteError(status, 'http_'+str(status))
        if not 200 <= status < 300: raise ValueError('unexpected_helper_status')
        return data

    def __call__(self, method, path, payload):
        allowed = {'GET': {'work', 'messages'}, 'POST': {'work/claim', 'work/update', 'reply'}}
        if path == 'files/content':
            raise ValueError('helper_binary_transport_unqualified')
        if path not in allowed.get(method, set()): raise ValueError('unsupported_private_route')
        target = '/relay/mast/'+path
        if method == 'GET':
            return self.invoke(['get', target+'?'+urllib.parse.urlencode(payload)])
        raw = json.dumps(payload, ensure_ascii=False).encode()
        if len(raw) > 16000: raise ValueError('request_body_too_large')
        with tempfile.TemporaryDirectory(prefix='mast-payload-', dir=self.directory) as directory:
            filename = Path(directory)/'body.json'
            fd = os.open(filename, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as output:
                output.write(raw)
            return self.invoke(['post', target, str(filename)])
