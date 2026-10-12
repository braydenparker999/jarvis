"""Mast staging call sites. No activation; all manifest writers must migrate.

Reuse the existing transaction, checkpoint, process and report boundaries.
No wall-clock lease takeover, diagnostic-text retry or remote-timeout recovery.
"""
from contextlib import contextmanager
from dataclasses import asdict
import fcntl
import json
import os
from pathlib import Path
import re
import time
import uuid

from scripts.prototypes import upload_checkpoints as cp
from scripts.prototypes import worker_boundary as boundary
from scripts.prototypes.manifest_transaction import Transaction
from scripts.prototypes.process_guard import run, ProcessLimit
from scripts.prototypes.artifact_budget import ArtifactBudget
from scripts.staging import prepared_handoff as prepared

RETRY_EXIT = 75
CONFLICT = 'Library changed concurrently; retry this registration'


def stops(host, *, admission=False):
    values = [host.STOP, host.AUTH_STOP]
    if admission:
        values.append(str(Path(host.R2DIR) / 'DRAIN'))
    return values


def transaction(path):
    # Pacing uses the same durable implementation with its own JSON-object schema.
    return Transaction(path, manifest=Path(path).name != 'relay-pacing.json')


def update_manifest(path, mutate, stats=lambda value: value):
    with Transaction(path) as tx:
        boundary.check_stops([str(Path(path).parent/name) for name in ('STOP','AUTH-STOP','DRAIN')])
        result = mutate(tx.value)
        result['updated'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
        result = stats(result)
        boundary.check_stops([str(Path(path).parent/name) for name in ('STOP','AUTH-STOP','DRAIN')])
        tx.commit(result)
        return result


def append_only(path, mutate, stats):
    """Current queue-append seam; stale save and legacy status writers fail closed."""
    def checked(value):
        previous = json.loads(cp.encode(value))
        result = mutate(value)
        if any(result.get('entries', {}).get(k) != v for k, v in previous['entries'].items()):
            raise boundary.BoundaryError('Unfenced existing-entry mutation forbidden')
        for k, v in result['entries'].items():
            if k not in previous['entries'] and (v.get('status') != 'pending' or v.get('sha256') != k):
                raise boundary.BoundaryError('Append requires a new pending immutable identity')
        for key in ('upload_hold', 'admission'):
            if result.get(key) != previous.get(key):
                raise boundary.BoundaryError('Append cannot change admission or holds')
        return result
    return update_manifest(path, checked, stats)


def reconcile_scan(path, candidate, stats):
    """Add discovered entries to current state; never replace generations/holds.

    Historical plain reports are not fenced registration proofs. Preserve them
    as review-only entries rather than silently scheduling another upload.
    """
    if type(candidate) is not dict or type(candidate.get('entries')) is not dict:
        raise boundary.BoundaryError('Invalid scan candidate')
    def merge(current):
        for job, scanned in candidate['entries'].items():
            if job in current['entries']:
                continue  # First-wins metadata and all current status/fencing survive.
            if (type(scanned) is not dict or not re.fullmatch('[a-f0-9]{64}', job)
                    or scanned.get('sha256') != job or type(scanned.get('size')) is not int
                    or scanned['size'] <= 0 or type(scanned.get('path')) is not str
                    or scanned.get('status') not in ('pending','failed','registered')):
                raise boundary.BoundaryError('Invalid scanned entry')
            entry = json.loads(cp.encode(scanned))
            # Never import ownership, attempts or receipts from a filesystem scan.
            for field in ('generation','claimed_by','claimed_at','attempt','checkpoint','prepared_directory'):
                entry.pop(field, None)
            entry['attempts'] = 0
            if entry['status'] == 'registered':
                entry.update(status='held_import_review',
                    last_error='Historical report requires reconciliation; no fenced completion proof')
            elif entry['status'] == 'pending' and entry['size'] > prepared.AUDIO:
                raise boundary.BoundaryError('Pending scanned audio exceeds limit')
            current['entries'][job] = entry
        current['last_scan'] = candidate.get('built')
        for key in ('report_files','orphan_reports'):
            value = candidate.get('stats', {}).get(key)
            if type(value) is int and value >= 0:
                current.setdefault('stats', {})[key] = value
        return current
    return update_manifest(path, merge, stats)


def claim_next(host):
    boundary.check_stops(stops(host, admission=True))
    with Transaction(host.MANIFEST) as tx:
        if tx.value.get('upload_hold') is not None:
            return None, None
        def priority(item):
            job, entry = item
            scope = entry.get('scope', '')
            rank = host.SCOPE_ORDER.index(scope) if scope in host.SCOPE_ORDER else len(host.SCOPE_ORDER)
            return rank, entry.get('added', ''), job
        candidates = sorted(((k, v) for k, v in tx.value['entries'].items()
                             if v.get('status') == 'pending' and v.get('attempts', 0) < host.MAX_ATTEMPTS), key=priority)
        if not candidates:
            return None, None
        boundary.check_stops(stops(host, admission=True))
        job, entry = candidates[0]
        digest, size = entry.get('sha256'), entry.get('size')
        if job != digest or not re.fullmatch('[a-f0-9]{64}', digest or '') or type(size) is not int or not 0 < size <= prepared.AUDIO:
            raise boundary.BoundaryError('Invalid queue identity')
        entry.update(status='claimed', generation=uuid.uuid4().hex,
                     claimed_by=host.WID, claimed_at=time.time())
        tx.commit(host._recompute_stats(tx.value))
        return job, dict(entry)


def owned(host, value, change, statuses=('claimed', 'held'), attempt=None):
    with Transaction(host.MANIFEST) as tx:
        entry = boundary._entry(tx, value, set(statuses), attempt)
        if entry.get('claimed_by') != host.WID:
            raise boundary.BoundaryError('Owner changed')
        change(entry, tx.value)
        tx.commit(host._recompute_stats(tx.value))


def heartbeat(host, value):
    owned(host, value, lambda e, m: e.update(claimed_at=time.time()))


@contextmanager
def network_token(host, value):
    # Existing token identity is retained; never replace it or create another mutex.
    with open(host.TOKEN, 'r+b') as token:
        while True:
            boundary.check_stops(stops(host, admission=True))
            heartbeat(host, value)
            try:
                fcntl.flock(token, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(1)
        boundary.check_stops(stops(host, admission=True))
        yield


def response_or_rejection(response, method, url, auth_stop):
    """Only this exact terminal registration CAS rejection permits retry."""
    if type(response) is not dict:
        raise cp.CheckpointError('Missing raw response')
    status = response.get('status')
    if status in (401, 403):
        # Stop even unattributed authentication errors; do not infer noncommit.
        marker = Path(auth_stop)
        with marker.open('ab') as f:
            f.write(b'Authentication response; held for review\n'); f.flush(); os.fsync(f.fileno())
    if status == 409 and method == 'POST' and url.endswith('/music/uploads/register'):
        checked = cp.validated_json({**response, 'status': 200}, url, 65536)
        if checked == {'error': CONFLICT}:
            raise cp.Rejected(409, 'registration_library_changed')
    return response


def upload_prepared(*, manifest, claim, attempt, slot, pin, journal, report,
                    origin, public, name, request_once, stop_paths, auth_stop):
    """Actual staged uploader tail: fresh signing stays in supplied raw transport."""
    value = boundary.Claim(**claim)
    audio, tags, cover, analysis = prepared.load(slot, pin, value.sha256, name, origin)
    if len(audio) != value.size:
        raise boundary.BoundaryError('Claimed size differs from prepared buffer')
    def guarded(method, url, data, mime, signer):
        def once():
            response = request_once(method, url, data, mime, signer)
            return response_or_rejection(response, method, url, auth_stop)
        return boundary.guarded_request(manifest, value, attempt, stop_paths, once)
    try:
        with cp.session(journal, origin, public) as session:
            sender = cp.ValidatedPutSender(guarded, origin, public)
            session.put('audio', audio, 'opus', sender)
            registration = {'name': name, 'sha256': cp.sha(audio), 'size': len(audio), 'metadata': tags}
            if cover:
                image, ext = cover
                session.put('art', image, ext, sender)
                registration['cover'] = {'sha256': cp.sha(image), 'size': len(image), 'ext': ext}
            body = json.dumps(registration, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
            result = session.register_with_analysis(body, guarded)
    except cp.Rejected as error:
        if (error.status, error.code) != (409, 'registration_library_changed'):
            raise
        # cp only clears its pending marker for that one terminal noncommit.
        cp.read_state(Path(journal))
        boundary.write_report(report, value, attempt, {'retry': 'registration_library_changed'})
        return RETRY_EXIT
    result.update(analysisStatus=analysis, audioSha256=cp.sha(audio), audioBytes=len(audio),
                  coverUploaded=bool(cover), coverSha256=cp.sha(cover[0]) if cover else None,
                  playbackVerified=False)
    boundary.write_report(report, value, attempt, result)
    return 0


def retry_report(report, value, attempt, journal):
    raw = prepared.read(report, 65536)
    found = json.loads(raw, object_pairs_hook=cp.unique)
    expected = {'version': 1, 'claim': asdict(value), 'attempt': attempt,
                'result': {'retry': 'registration_library_changed'}}
    if cp.encode(found) != cp.encode(expected):
        raise boundary.BoundaryError('Noncommit report not fenced')
    cp.read_state(Path(journal))  # Missing, corrupt or pending is never retryable.


def retry_transition(host, value, attempt):
    def change(entry, manifest):
        if manifest.get('upload_hold') != boundary._hold(value, attempt):
            raise boundary.BoundaryError('Retry hold changed')
        entry.update(status='claimed', last_error='verified registration CAS conflict')
        del manifest['upload_hold']
    owned(host, value, change, statuses=('held',), attempt=attempt)


def finish(host, value, attempt, result, decode_ok, before_commit=lambda: None):
    def change(entry, manifest):
        if manifest.get('upload_hold') != boundary._hold(value, attempt):
            raise boundary.BoundaryError('Completion hold changed')
        before_commit()  # Publish required evidence/pacing while generation and hold stay fenced.
        entry.update(registration_confirmed=True, playback_decode_ok=decode_ok,
                     audioSha256=value.sha256, r2_id=result['id'],
                     status='registered' if decode_ok else 'held_decode_failed')
        if decode_ok:
            entry.update(registered_at=time.strftime('%Y-%m-%dT%H:%M:%S%z'))
            del manifest['upload_hold']
    owned(host, value, change, statuses=('held',), attempt=attempt)


def retry_delay(host, count):
    return min(60 * (2 ** (count - 1)), 900) + host.random.uniform(0, 30)


def process(host, job, entry):
    value = boundary.Claim(job, entry['generation'], entry['sha256'], entry['size'])
    source = Path(entry['path'])
    if not source.is_absolute(): source = Path(host.WS) / source
    root = Path(host.R2DIR)
    state = root / 'checkpoint-jobs'
    state.mkdir(mode=0o700, exist_ok=True)
    budget = ArtifactBudget(state, max_attempts=50000, total_bytes=256*1024*1024,
                            attempt_bytes=512*1024, max_files=24)
    directory = state / ('offline-upload-attempt-' + job)
    # Nonblocking lifetime lease: no overlapping same-job owner even through backoff.
    with open(state / ('lease-' + job), 'a+b') as lease:
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        heartbeat(host, value)
        budget.check(reserve=True)
        directory.mkdir(mode=0o700)  # Existing logical job requires reconciliation, never recreation.
        journal = directory / 'checkpoint.json'
        cp.write_state(journal, {'version': 1, 'pending': None, 'blobs': {}})
        owned(host, value, lambda e, m: e.update(checkpoint=str(journal)))
        slot = None
        while slot is None:
            boundary.check_stops(stops(host, admission=True)); heartbeat(host, value)
            slot = prepared.reserve(root / 'prepared-current')
            if slot is None: time.sleep(5)
        owned(host, value, lambda e, m: e.update(prepared_directory=str(slot)))
        # Staged uploader local-only branch: no transport/key operation.
        prepare_report = directory / 'prepared-pin.json'
        argv = [host.sys.executable, host.SCRIPT, str(source), '--key', host.KEY,
                '--prepare-dir', str(slot), '--expected-sha', job, '--prepare-report', str(prepare_report)]
        code, _ = run(argv, timeout=60, file_limit=35*1024*1024, check=budget.check)
        if code != 0: raise boundary.BoundaryError('Preparation failed; artifacts retained')
        pin = json.loads(prepared.read(prepare_report, 1024))['preparedPin']
        if not re.fullmatch('[a-f0-9]{64}', pin): raise boundary.BoundaryError('Invalid preparation pin')
        audio, tags, _, _ = prepared.load(slot, pin, job, source.stem+'.opus', host.ORIGIN)
        while True:
            with network_token(host, value):
                attempt = uuid.uuid4().hex
                def admit(current, manifest):
                    boundary.check_stops(stops(host, admission=True))
                    if manifest.get('upload_hold') is not None:
                        raise boundary.BoundaryError('Unresolved global upload hold')
                    if current.get('attempts', 0) >= host.MAX_ATTEMPTS:
                        raise boundary.BoundaryError('Attempt limit reached')
                    manifest['upload_hold'] = boundary._hold(value, attempt)
                    current.update(status='held', attempt=attempt, attempts=current.get('attempts', 0)+1)
                owned(host, value, admit, statuses=('claimed',))
                report = directory / ('report-' + attempt + '.json')
                command = [host.sys.executable, host.SCRIPT, str(source), '--key', host.KEY,
                           '--report', str(report), '--prepared-dir', str(slot), '--prepared-pin', pin,
                           '--expected-sha', job, '--manifest', host.MANIFEST, '--claim', json.dumps(asdict(value)),
                           '--attempt', attempt, '--checkpoint', str(journal), '--stop', host.STOP,
                           '--auth-stop', host.AUTH_STOP]
                last_beat = time.monotonic()
                def check():
                    nonlocal last_beat
                    budget.check()
                    if time.monotonic() - last_beat >= 30:
                        heartbeat(host, value); last_beat = time.monotonic()
                code, _ = run(command, timeout=900, file_limit=512*1024, check=check)
                if code == RETRY_EXIT:
                    retry_report(report, value, attempt, journal)
                    retry_transition(host, value, attempt)
                elif code == 0:
                    result = boundary._report(report, value, attempt, 'audioAnalysis' in tags)
                    boundary._snapshot_matches(slot/'audio.opus', audio)
                    try:
                        status, diagnostics = run(['ffmpeg', '-v', 'error', '-i', str(slot/'audio.opus'), '-f', 'null', '-'],
                                                   timeout=300, file_limit=512*1024, check=check)
                        decoded = status == 0 and diagnostics == 0
                    except ProcessLimit:
                        decoded = False
                    boundary._snapshot_matches(slot/'audio.opus', audio)
                    def publish():
                        if decoded:
                            # Existing report consumers retain their plain result schema.
                            output = Path(host.report_path_for(entry))
                            boundary.write_report(directory/'completion.json', value, attempt, result)
                            temporary = output.with_name(output.name+'.'+attempt+'.tmp')
                            prepared.write(temporary, cp.encode(result))
                            os.replace(temporary, output)
                            fd = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
                            try: os.fsync(fd)
                            finally: os.close(fd)
                        host.pacing_note_completion()
                    finish(host, value, attempt, result, decoded, publish)
                    if decoded:
                        prepared.remove_verified(slot)
                    return 'registered' if decoded else 'held'
                else:
                    raise boundary.BoundaryError('Child/request outcome held; no retry')
            # Only verified register CAS conflicts reach existing retry pacing.
            with Transaction(host.MANIFEST) as tx:
                count = boundary._entry(tx, value, {'claimed'})['attempts']
            if count >= host.MAX_ATTEMPTS:
                owned(host, value, lambda e,m:e.update(status='failed', last_error='verified conflict attempt limit'))
                host.pacing_note_completion(); return 'failed'
            host.pacing_note_temp('verified registration CAS conflict')
            delay = retry_delay(host, count)
            end = time.monotonic() + delay
            while time.monotonic() < end:
                boundary.check_stops(stops(host, admission=True)); heartbeat(host, value)
                time.sleep(min(5, max(0, end-time.monotonic())))


def drain_workers(procs, log, timeout=1260):
    """No SIGTERM fallback. Timeout is failure to prove drain, never permission."""
    deadline = time.monotonic() + timeout
    while any(p.poll() is None for p in procs.values()):
        if time.monotonic() >= deadline:
            log('Drain incomplete; preserve markers and processes; reconcile before restart')
            return False
        time.sleep(1)
    return True


def launch_ready(manifest, stop_paths):
    boundary.check_stops(stop_paths)
    with Transaction(manifest) as tx:
        if tx.value.get('upload_hold') is not None or any(e.get('status') in
                ('claimed','held','held_decode_failed') for e in tx.value['entries'].values()):
            raise boundary.BoundaryError('Active or unresolved work; launcher cannot restart')


def require_qualification(root):
    """Generated stage is deliberately non-activatable until writer qualification."""
    document = json.loads(prepared.read(Path(root)/'qualification.json', 65536))
    if document.get('activation') != 'qualified-for-controlled-transition':
        raise boundary.BoundaryError('Staging package incomplete; no worker/launcher admission')


def check_writer_binding(configured, shared):
    if Path(configured).resolve() != Path(shared).resolve():
        raise boundary.BoundaryError('Writer configuration targets a different manifest')


def request_drain(manifest):
    """Qualified-stage drain marker, serialized with claim/write/admission checks.

    Not a bridge for old writers that do not yet use this sidecar.
    """
    marker = Path(manifest).parent/'DRAIN'
    with Transaction(manifest):
        with marker.open('ab') as stream:
            stream.write(b'Admission closed for reviewed drain\n'); stream.flush(); os.fsync(stream.fileno())
        directory = os.open(marker.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
