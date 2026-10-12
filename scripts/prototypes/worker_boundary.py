"""Offline worker boundary; trusted local filesystem and cooperating participants.

Not imported by production. No automatic reclaim/retry/reset. Every uploader
request must use guarded_request and the parent must hold the whole-chain token.
"""
from dataclasses import dataclass, asdict
from contextlib import nullcontext
import fcntl
import json
import os
from pathlib import Path
import re
import hashlib
import stat
import tempfile
import uuid

from scripts.prototypes.manifest_transaction import Transaction
from scripts.prototypes.artifact_budget import ArtifactBudget
from scripts.prototypes.process_guard import run as run_process, ProcessLimit
from scripts.prototypes.upload_checkpoints import encode, unique


class BoundaryError(RuntimeError):
    pass


@dataclass(frozen=True)
class Claim:
    job: str
    generation: str
    sha256: str
    size: int


def claim(manifest, job):
    """Only pending jobs are eligible; no time-based or same-worker reclaim."""
    with Transaction(manifest) as tx:
        entry = tx.value['entries'].get(job)
        if not entry or entry.get('status') != 'pending':
            raise BoundaryError('Job not pending; no automatic retry')
        digest, size = entry.get('sha256'), entry.get('size')
        if (type(digest) is not str or not re.fullmatch('[a-f0-9]{64}', digest)
                or type(size) is not int or not 0 < size <= 32 * 1024 * 1024):
            raise BoundaryError('Invalid immutable job identity')
        value = Claim(job, uuid.uuid4().hex, digest, size)
        entry.update(status='claimed', generation=value.generation)
        tx.commit(tx.value)
        return value


def _entry(tx, value, statuses, attempt=None):
    entry = tx.value['entries'].get(value.job)
    if (not entry or entry.get('generation') != value.generation
            or entry.get('sha256') != value.sha256 or type(entry.get('size')) is not int
            or entry.get('size') != value.size or entry.get('status') not in statuses
            or attempt is not None and entry.get('attempt') != attempt):
        raise BoundaryError('Stale claim or attempt; no mutation/request allowed')
    return entry


def _hold(value, attempt):
    return {'job': value.job, 'generation': value.generation, 'attempt': attempt}


def check_stops(paths):
    # lexists detects broken symlinks too; markers are never removed here.
    if any(os.path.lexists(path) for path in paths):
        raise BoundaryError('Durable stop present')


def guarded_request(manifest, value, attempt, stops, request_once, *args):
    """Check after all caller waits, directly before one actual network attempt.

    Keep manifest lock through callback so cooperating ownership changes cannot
    race this request. Callback must not acquire this lock or retry internally.
    Parent's whole-chain token remains held across child lifetime and completion.
    """
    with Transaction(manifest) as tx:
        _entry(tx, value, {'held'}, attempt)
        if tx.value.get('upload_hold') != _hold(value, attempt):
            raise BoundaryError('Global upload hold does not belong to this attempt')
        check_stops(stops)
        return request_once(*args)


def write_report(path, value, attempt, result):
    """Child-side proposed contract: fresh identity-bound atomic report only."""
    report = {'version': 1, 'claim': asdict(value), 'attempt': attempt, 'result': result}
    raw = encode(report)
    if len(raw) > 65536:
        raise BoundaryError('Report too large')
    path = Path(path)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='report.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass


def _report(path, value, attempt, require_analysis):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise BoundaryError('Report must be regular file')
        raw = stream.read(65537)
    if not 0 < len(raw) <= 65536:
        raise BoundaryError('Invalid report size')
    try:
        report = json.loads(raw.decode('utf-8'), object_pairs_hook=unique)
        encode(report)
        if (set(report) != {'version', 'claim', 'attempt', 'result'} or type(report['version']) is not int
                or report['version'] != 1 or type(report['claim']) is not dict
                or set(report['claim']) != {'job', 'generation', 'sha256', 'size'}
                or type(report['claim']['size']) is not int
                or any(type(report['claim'][key]) is not str for key in ('job', 'generation', 'sha256'))
                or report['claim'] != asdict(value) or report['attempt'] != attempt):
            raise ValueError('Report identity')
        result = report['result']
        if (type(result) is not dict or result.get('registered') is not True
                or type(result.get('duplicate')) is not bool
                or type(result.get('count')) is not int or not 0 < result['count'] <= 50000
                or type(result.get('id')) is not str or not re.fullmatch(r'r2_[A-Za-z0-9_-]{10,200}', result['id'])
                or (not result['duplicate'] or result['id'].startswith('r2_native_'))
                   and result['id'] != 'r2_native_' + value.sha256):
            raise ValueError('Registration acknowledgement')
        if require_analysis and result['duplicate']:
            correction = result.get('analysisCorrection')
            if (type(correction) is not dict or set(correction) != {'registered', 'analysisUpdated', 'id', 'count'}
                    or correction['registered'] is not True or type(correction['analysisUpdated']) is not bool
                    or correction['id'] != result['id'] or type(correction['count']) is not int
                    or not 0 < correction['count'] <= 50000):
                raise ValueError('Analysis acknowledgement')
        return result
    except Exception:
        raise BoundaryError('Unvalidated attempt report') from None


def _finish(manifest, value, attempt, result, decode_ok):
    """Fence even late completion. Decode failure never becomes completed."""
    with Transaction(manifest) as tx:
        entry = _entry(tx, value, {'held'}, attempt)
        if tx.value.get('upload_hold') != _hold(value, attempt):
            raise BoundaryError('Global hold changed; completion rejected')
        entry.update(registration_confirmed=True, registered_id=result['id'],
                     local_decode_ok=decode_ok is True,
                     status='completed' if decode_ok is True else 'held_decode_failed')
        if decode_ok is True:
            del tx.value['upload_hold']
        tx.commit(tx.value)
    return 'completed' if decode_ok is True else 'held_decode_failed'


def _snapshot_matches(path, audio):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise BoundaryError('Audio snapshot must be regular file')
        if stream.read(len(audio) + 1) != audio:
            raise BoundaryError('Audio snapshot changed')


def run_attempt(manifest, value, token, stops, command, decode, audio, *, require_analysis=False, timeout=900, decoder_timeout=300,
                output_limit=65536, budget=None, prepared_admission=None, prepared_completion=None):
    """command(report_path, attempt_id, Claim, immutable_audio_path) returns trusted local child argv.

    Actual child must adopt guarded_request + write_report. The existing Mast
    CLI has NOT been changed to support this protocol. decode(audio_path) is a
    nonblocking argv factory, not the decoder itself. Both subprocess groups have
    execution/output limits. Never parse diagnostics into retry policy.
    """
    def validate_audio(data):
        if (type(data) is not bytes or len(data) != value.size
                or hashlib.sha256(data).hexdigest() != value.sha256):
            raise BoundaryError('Audio bytes changed')
    if prepared_admission is None:
        validate_audio(audio)
    elif audio is not None:
        raise BoundaryError('Deferred preparation admission requires no separate audio')
    budget = budget or ArtifactBudget(Path(manifest).resolve().parent)
    if budget.root.resolve() != Path(manifest).resolve().parent:
        raise BoundaryError('Budget must account for the actual retained artifact root')
    if budget.attempt_bytes < value.size + 131072:
        raise BoundaryError('Attempt budget cannot hold audio plus report/journal allowance')
    check_stops(stops)
    with open(token, 'a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        check_stops(stops)  # Required after token wait, before child admission.
        attempt = uuid.uuid4().hex
        with Transaction(manifest) as tx:
            entry = _entry(tx, value, {'claimed'})
            if tx.value.get('upload_hold') is not None:
                raise BoundaryError('Unresolved global upload hold; no new attempt')
            budget.check(reserve=True)
            if prepared_admission is not None:
                # Pure local Pool.take only; ownership/token are already checked.
                audio, require_analysis = prepared_admission()
                if type(require_analysis) is not bool:
                    raise BoundaryError('Invalid prepared analysis requirement')
                validate_audio(audio)
            directory = tempfile.mkdtemp(prefix='offline-upload-attempt-', dir=Path(manifest).resolve().parent)
            tx.value['upload_hold'] = _hold(value, attempt)
            entry.update(status='held', attempt=attempt, attempt_directory=directory)
            tx.commit(tx.value)  # Durable hold before any child/request can exist.
        # Retain reports, immutable snapshot and child journals on every outcome.
        # No automatic cleanup/recovery: deleting a pending journal would erase holds.
        with nullcontext(directory):
            report = Path(directory) / 'report.json'  # Does not exist yet.
            audio_path = Path(directory) / 'audio.opus'
            audio_path.write_bytes(audio)
            try:
                code, _ = run_process(command(report, attempt, value, audio_path), timeout=timeout,
                                      output_limit=output_limit, file_limit=budget.attempt_bytes,
                                      check=budget.check)
            except ProcessLimit as error:
                raise BoundaryError(str(error)) from None
            if code != 0:
                raise BoundaryError('Child failed; held for reconciliation')
            result = _report(report, value, attempt, require_analysis)
            _snapshot_matches(audio_path, audio)
            try:
                code, diagnostic_bytes = run_process(decode(audio_path), timeout=decoder_timeout,
                    output_limit=output_limit, file_limit=budget.attempt_bytes, check=budget.check)
                decode_ok = code == 0 and diagnostic_bytes == 0
            except Exception:
                decode_ok = False
            _snapshot_matches(audio_path, audio)
            budget.check()
            outcome = _finish(manifest, value, attempt, result, decode_ok)
            if outcome == 'completed' and prepared_completion is not None:
                audio = None  # Drop worker payload before reopening preparation slot.
                prepared_completion()  # Still under the whole-chain token.
            return outcome
