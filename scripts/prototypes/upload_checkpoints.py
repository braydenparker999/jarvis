"""Offline call-site prototype. No HTTP transport or production imports.

Call Session inside the existing whole-chain flock. Its extra journal lock only
protects retries sharing this journal; it is NOT a replacement for that flock.
A journal belongs to one logical track job, including all retries. Never delete
or recreate a blocked journal to retry an uncertain request.
"""
from contextlib import contextmanager
from datetime import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile


class CheckpointError(RuntimeError):
    pass


class Rejected(RuntimeError):
    """Trusted adapter saw this exact Worker status/error before any commit.

    Only the explicitly supported registration conflict below is retryable.
    Validation rejections remain stops even when known not to have committed.
    Do not construct from a timeout, arbitrary response text or status alone.
    """
    def __init__(self, status, code):
        super().__init__('Upload rejected; caller policy applies')
        self.status, self.code = status, code


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate field')
        result[key] = value
    return result


def receipt_ok(receipt, identity):
    if type(receipt) is not dict or set(receipt) != {'key', 'sha256', 'size', 'r2Identity'}:
        return False
    if any(receipt[k] != identity[k] for k in ('key', 'sha256', 'size')) or type(receipt['size']) is not int:
        return False
    proof = receipt['r2Identity']
    if type(proof) is not dict or set(proof) != {'etag', 'size', 'lastModified'}:
        return False
    if type(proof['size']) is not int or proof['size'] != identity['size']:
        return False
    if not isinstance(proof['etag'], str) or (len(proof['etag']) > 128 or not re.fullmatch(r'[A-Za-z0-9_]+(?:-[0-9]+)?', proof['etag'])):
        return False
    stamp = proof['lastModified']
    if not isinstance(stamp, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', stamp):
        return False
    try:
        datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    except ValueError:
        return False
    return True


def identity_for(role, body, ext, destination, public):
    if type(body) is not bytes or not body:
        raise CheckpointError('Require nonempty immutable bytes before any request')
    if role == 'audio' and ext == 'opus' and len(body) <= 32 * 1024 * 1024:
        mime = 'audio/ogg'
    elif role == 'art' and ext in ('jpg', 'png') and len(body) <= 2 * 1024 * 1024:
        mime = 'image/jpeg' if ext == 'jpg' else 'image/png'
    else:
        raise CheckpointError('Unsupported artifact or size')
    digest = sha(body)
    return {'destination': destination, 'public': public, 'key': f'native/{role}/{digest}.{ext}',
            'path': f'/music/uploads/{role}/{digest}.{ext}', 'mime': mime,
            'sha256': digest, 'size': len(body)}


def validate_state(state):
    if type(state) is not dict or set(state) != {'version', 'pending', 'blobs'} or type(state['version']) is not int or state['version'] != 1:
        raise ValueError('Schema')
    if state['pending'] is not None:
        # Any pending marker blocks all requests, even if its contents are corrupt.
        raise CheckpointError('Unresolved request; reconcile before retry')
    if type(state['blobs']) is not dict or not set(state['blobs']) <= {'audio', 'art'}:
        raise ValueError('Blobs')
    for role, entry in state['blobs'].items():
        if type(entry) is not dict or set(entry) != {'identity', 'receipt'}:
            raise ValueError('Entry')
        identity = entry['identity']
        if type(identity) is not dict or set(identity) != {'destination', 'public', 'key', 'path', 'mime', 'sha256', 'size'}:
            raise ValueError('Identity')
        if not receipt_ok(entry['receipt'], identity):
            raise ValueError('Receipt')


def read_state(path):
    try:
        with path.open('rb') as handle:
            raw = handle.read(16385)
        if len(raw) > 16384:
            raise ValueError('Oversize')
        envelope = json.loads(raw, object_pairs_hook=unique)
        if set(envelope) != {'state', 'checksum'} or sha(encode(envelope['state'])) != envelope['checksum']:
            raise ValueError('Checksum')
        validate_state(envelope['state'])
        return envelope['state']
    except CheckpointError:
        raise
    except Exception:
        raise CheckpointError('Missing or corrupt journal; reconcile before retry') from None


def write_state(path, state):
    data = encode({'state': state, 'checksum': sha(encode(state))})
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class Session:
    def __init__(self, path, state, destination, public):
        self.path, self.state = path, state
        self.destination, self.public = destination, public
        self.active = True
        self.poisoned = False

    def _request(self, phase, identity, send, validate):
        if not self.active or self.poisoned or self.state['pending'] is not None:
            raise CheckpointError('Session closed or unresolved; reconcile before retry')
        # Durable intent precedes the transport. Any exception, including process
        # interruption or acknowledgement-save failure, leaves this session blocked.
        self.poisoned = True
        self.state['pending'] = {'phase': phase, 'identity': identity}
        write_state(self.path, self.state)
        try:
            result = send()
        except Rejected as error:
            allowed = (phase == 'register' and
                       (error.status, error.code) == (409, 'registration_library_changed'))
            if allowed:
                self.state['pending'] = None
                write_state(self.path, self.state)
                self.poisoned = False
            raise
        if not validate(result):
            raise CheckpointError('Unvalidated acknowledgement; reconcile before retry')
        return result

    def put(self, role, body, ext, send):
        """send(method, path, SAME bytes, mime) must sign freshly, once, no retry."""
        if not self.active or self.poisoned:
            raise CheckpointError('Session closed or unresolved; reconcile before retry')
        identity = identity_for(role, body, ext, self.destination, self.public)
        old = self.state['blobs'].get(role)
        if old and old['identity'] == identity and receipt_ok(old['receipt'], identity):
            return json.loads(encode(old['receipt']))
        result = self._request(role, identity,
            lambda: send('PUT', identity['path'], body, identity['mime']),
            lambda r: receipt_ok(r, identity))
        self.state['blobs'][role] = {'identity': identity, 'receipt': json.loads(encode(result))}
        self.state['pending'] = None
        write_state(self.path, self.state)
        self.poisoned = False
        return result

    def register(self, body, send):
        """Preserve the caller's registration bytes; server still checks proofs.

        Registration is never skipped. Analysis correction remains with the caller.
        """
        if type(body) is not bytes or not 0 < len(body) <= 16384:
            raise CheckpointError('Require bounded immutable registration bytes')
        try:
            registration = json.loads(body, object_pairs_hook=unique)
            audio_sha = registration['sha256']
            if (type(audio_sha) is not str or not re.fullmatch(r'[a-f0-9]{64}', audio_sha)
                    or type(registration['size']) is not int or not 0 < registration['size'] <= 32 * 1024 * 1024):
                raise ValueError('Audio identity')
        except Exception:
            raise CheckpointError('Require valid registration audio identity') from None
        identity = {'destination': self.destination, 'public': self.public, 'sha256': sha(body), 'size': len(body)}
        def valid(r):
            if (type(r) is not dict or set(r) != {'registered', 'duplicate', 'id', 'count'}
                    or r['registered'] is not True or type(r['duplicate']) is not bool
                    or type(r['id']) is not str or not re.fullmatch(r'r2_[A-Za-z0-9_-]{10,200}', r['id'])
                    or type(r['count']) is not int or not 0 < r['count'] <= 50000):
                return False
            # New tracks always use their native content address. A duplicate may
            # keep a migrated legacy ID, but a native ID must match these bytes.
            return (r['id'] == 'r2_native_' + audio_sha
                    if not r['duplicate'] or r['id'].startswith('r2_native_') else True)
        result = self._request('register', identity,
            lambda: send('POST', '/music/uploads/register', body, 'application/json'), valid)
        self.state['pending'] = None
        write_state(self.path, self.state)
        self.poisoned = False
        return result


@contextmanager
def session(path, destination, public, *, create=False):
    """Existing whole-chain flock MUST surround this context and all other phases.

    create=True is only for the first attempt of a new logical job, never a retry.
    Each retry must use the same journal, even if prepared bytes have changed.
    Storage is a trusted local durable filesystem, not a network filesystem.
    """
    if not re.fullmatch(r'https://[a-z0-9.-]+(?::[0-9]+)?', destination) or not re.fullmatch(r'[a-f0-9]{64}', public):
        raise CheckpointError('Require exact HTTPS destination and public signing identity')
    path = Path(path)
    with open(str(path) + '.lock', 'a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if create:
            # A crash during creation leaves a corrupt journal and blocks, safely.
            with path.open('xb'):
                pass
            write_state(path, {'version': 1, 'pending': None, 'blobs': {}})
        current = Session(path, read_state(path), destination, public)
        try:
            yield current
        finally:
            current.active = False
