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
        if isinstance(send, ValidatedPutSender) and (send.destination != self.destination or send.public != self.public):
            raise CheckpointError('PUT adapter destination or signing identity mismatch')
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
        return self._register(body, send, hold_analysis=False)

    def _register(self, body, send, *, hold_analysis):
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
        needs_analysis = (hold_analysis and result['duplicate']
                          and 'audioAnalysis' in registration.get('metadata', {}))
        self.state['pending'] = ({'phase': 'duplicate_catalog_pending', 'identity': identity}
                                 if needs_analysis else None)
        write_state(self.path, self.state)
        self.poisoned = needs_analysis
        return result

    def register_with_analysis(self, body, request_once):
        """Offline exact duplicate sequence; no completion/reset API.

        request_once has the same trusted provenance/sign-once/no-retry contract
        as ValidatedPutSender. GET uses body=None and mime=None; authenticate TLS
        and reject redirects. POST signs these exact bytes afresh.
        """
        def send(method, path, payload, mime):
            url = self.destination + path
            response = request_once(method, url, payload, mime, self.public)
            return validated_json(response, url, 65536)
        result = self._register(body, send, hold_analysis=True)
        registration = json.loads(body, object_pairs_hook=unique)
        tags = registration.get('metadata', {})
        if not result['duplicate'] or 'audioAnalysis' not in tags:
            return result
        # Registration acknowledgement is already durably held before GET.
        # Any GET/validation/crash failure leaves the original journal held.
        url = self.destination + '/music/library.json'
        catalog = validated_json(request_once('GET', url, None, None, self.public), url, 16 * 1024 * 1024)
        tracks = catalog.get('tracks') if type(catalog) is dict else None
        if type(tracks) is not list or any(type(t) is not dict for t in tracks):
            raise CheckpointError('Invalid catalog tracks')
        matches = [t for t in tracks if t.get('id') == result['id']]
        if len(matches) != 1:
            raise CheckpointError('Duplicate catalog identity missing or ambiguous')
        existing = matches[0]
        if (existing.get('sha256') != registration['sha256']
                or type(existing.get('size')) is not int or existing['size'] != registration['size']
                or type(existing.get('metadata')) is not dict):
            raise CheckpointError('Duplicate catalog audio identity changed')
        correction = {'id': existing['id'], 'sha256': registration['sha256'],
                      'size': registration['size'], 'r2Identity': existing.get('r2Identity'),
                      'previousAnalysis': existing['metadata'].get('audioAnalysis'),
                      'audioAnalysis': tags['audioAnalysis']}
        # Server CAS hashes JSON.stringify(previousAnalysis): preserve catalog
        # property order; the journal's sorted encoder must not build this body.
        correction_body = json.dumps(correction, ensure_ascii=False,
                                     separators=(',', ':'), allow_nan=False).encode('utf-8')
        # Only this in-flight sequence may advance the held phase. Do not persist
        # a clear state: analysis writes its new intent before its network call.
        held = self.state['pending']
        self.state['pending'] = None
        self.poisoned = False
        try:
            acknowledgement = self.analysis(correction_body, send)
        except BaseException:
            if self.state['pending'] is None:
                self.state['pending'] = held
            self.poisoned = True
            raise
        return {**result, 'analysisCorrection': acknowledgement}

    def analysis(self, body, send):
        """Offline tail guard: a validated acknowledgement STILL holds the job.

        The actual report/decode/manifest completion boundary is unavailable.
        There is deliberately no automatic finish/reset/reconciliation API. Do
        not install this as a complete worker adapter: even success requires a
        separately reviewed completion transition before another attempt.
        """
        if type(body) is not bytes or not 0 < len(body) <= 16384:
            raise CheckpointError('Require bounded immutable analysis bytes')
        try:
            request = json.loads(body, object_pairs_hook=unique)
            track = request['id']
            audio_sha, size = request['sha256'], request['size']
            if (type(track) is not str or not re.fullmatch(r'r2_[A-Za-z0-9_-]{10,200}', track)
                    or type(audio_sha) is not str or not re.fullmatch(r'[a-f0-9]{64}', audio_sha)
                    or type(size) is not int or not 0 < size <= 32 * 1024 * 1024
                    or track.startswith('r2_native_') and track != 'r2_native_' + audio_sha
                    or 'audioAnalysis' not in request
                    or not ('previousAnalysis' in request or 'previousAnalysisSha256' in request)):
                raise ValueError('Analysis identity')
            # Preserve the existing R2 identity and prior-analysis CAS proof in
            # the exact body. The server remains responsible for analysis schema.
            key = 'native/audio/' + audio_sha + '.opus'
            if not receipt_ok({'key': key, 'sha256': audio_sha, 'size': size,
                               'r2Identity': request['r2Identity']},
                              {'key': key, 'sha256': audio_sha, 'size': size}):
                raise ValueError('Object proof')
        except Exception:
            raise CheckpointError('Require analysis identity and existing CAS proof') from None
        identity = {'destination': self.destination, 'public': self.public,
                    'sha256': sha(body), 'size': len(body), 'track': track}
        def valid(result):
            return (type(result) is dict and set(result) == {'registered', 'analysisUpdated', 'id', 'count'}
                    and result['registered'] is True and type(result['analysisUpdated']) is bool
                    and result['id'] == track and type(result['count']) is int and 0 < result['count'] <= 50000)
        result = self._request('analysis', identity,
            lambda: send('POST', '/music/uploads/analysis', body, 'application/json'), valid)
        self.state['pending'] = {'phase': 'analysis_acknowledged_completion_pending',
                                 'identity': identity, 'receipt': json.loads(encode(result))}
        write_state(self.path, self.state)
        # Keep poisoned=True. Neither library observation nor successful POST
        # implies report/decode/manifest completion or authorizes replay.
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


class ValidatedPutSender:
    """Proposed raw-response adapter, NOT an installed Mast transport.

    request_once(method, absolute_url, SAME bytes, mime, public_identity) must
    sign once with current time, authenticate HTTPS, reject redirects, perform
    exactly one request and return the actual status/url/content_type/body.
    Read through EOF or 65537 response bytes (one sentinel); never silently
    truncate or pass already-parsed JSON. Actual TLS/HTTP provenance is trusted
    transport input, not authenticated by this helper.
    No credentials, private key or response body are written to the journal.
    """
    def __init__(self, request_once, destination, public):
        self.request_once = request_once
        self.destination, self.public = destination, public

    def __call__(self, method, path, body, mime):
        match = re.fullmatch(r'/music/uploads/(audio|art)/([a-f0-9]{64})\.(opus|jpg|png)', path)
        if method != 'PUT' or match is None:
            raise CheckpointError('PUT adapter only accepts content-addressed PUTs')
        role, digest, ext = match.groups()
        identity = identity_for(role, body, ext, self.destination, self.public)
        if path != identity['path'] or digest != identity['sha256'] or mime != identity['mime']:
            raise CheckpointError('PUT identity does not match immutable bytes')
        url = self.destination + path
        response = self.request_once(method, url, body, mime, self.public)
        # The transport, not this JSON schema, establishes TLS/server provenance.
        if (type(response) is not dict or set(response) != {'status', 'url', 'content_type', 'body'}
                or type(response['status']) is not int or response['status'] != 200
                or type(response['url']) is not str or response['url'] != url
                or type(response['content_type']) is not str
                or not re.fullmatch(r'[ \t]*application/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*',
                                    response['content_type'], re.I)
                or type(response['body']) is not bytes or not 0 < len(response['body']) <= 65536):
            raise CheckpointError('Unvalidated PUT response; reconcile before retry')
        try:
            receipt = json.loads(response['body'].decode('utf-8'), object_pairs_hook=unique)
        except Exception:
            raise CheckpointError('Unvalidated PUT response; reconcile before retry') from None
        if not receipt_ok(receipt, identity):
            raise CheckpointError('Unvalidated PUT acknowledgement; reconcile before retry')
        return receipt


def validated_json(response, url, limit):
    """Validate actual raw response envelope, without inventing provenance."""
    if (type(response) is not dict or set(response) != {'status', 'url', 'content_type', 'body'}
            or type(response['status']) is not int or response['status'] != 200
            or response['url'] != url or type(response['content_type']) is not str
            or not re.fullmatch(r'[ \t]*application/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*', response['content_type'], re.I)
            or type(response['body']) is not bytes or not 0 < len(response['body']) <= limit):
        raise CheckpointError('Unvalidated JSON response; reconcile before retry')
    try:
        value = json.loads(response['body'].decode('utf-8'), object_pairs_hook=unique)
        encode(value)  # Reject NaN, infinities, including exponent overflow.
        return value
    except Exception:
        raise CheckpointError('Invalid JSON response; reconcile before retry') from None
