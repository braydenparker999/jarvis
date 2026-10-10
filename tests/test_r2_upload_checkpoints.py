"""Offline fixtures: injected transports only; no network, credentials or media."""
import hashlib
import http.client
import contextlib
import stat
import importlib.util
import json
import io
from types import SimpleNamespace
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('checkpoints', Path(__file__).resolve().parents[1] / 'scripts/prototypes/upload_checkpoints.py')
cp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cp)
DEST = 'https://fixture.invalid'
PUBLIC = 'a' * 64
AUDIO = b'OggS' + b'OpusHead' + b'a' * 4096
ART = b'\x89PNG\r\n\x1a\nfixture'


class Server:
    def __init__(self):
        self.calls = []
        self.fail = None
        self.metadata = None

    def send(self, method, path, body, mime):
        self.calls.append((method, path, body, mime))
        phase = 'register' if method == 'POST' else path.split('/')[3]
        if self.fail and self.fail[0] == phase:
            raise self.fail[1]
        if method == 'POST':
            duplicate = self.metadata is not None
            if not duplicate:
                self.metadata = json.loads(body)['metadata']
            return {'registered': True, 'duplicate': duplicate, 'id': 'r2_native_' + json.loads(body)['sha256'], 'count': 1}
        return {'key': path.replace('/music/uploads/', 'native/'), 'sha256': hashlib.sha256(body).hexdigest(),
                'size': len(body), 'r2Identity': {'etag': 'fixture_etag', 'size': len(body), 'lastModified': '2026-10-10T00:00:00.000Z'}}


def registration(audio=AUDIO, art=ART, title='First'):
    result = {'name': 'Fixture.opus', 'sha256': cp.sha(audio), 'size': len(audio),
              'metadata': {'title': title, 'artist': 'Fixture', 'dur': 1}}
    if art is not None:
        result['cover'] = {'sha256': cp.sha(art), 'size': len(art), 'ext': 'png'}
    return cp.encode(result)


def chain(path, server, *, create=False, audio=AUDIO, art=ART, destination=DEST, public=PUBLIC, title='First'):
    # Proposed offline seam, not the unavailable Mast wrapper. Keep its outer flock.
    # Match reported extraction behavior: empty picture data is absent, not a PUT.
    if type(art) is bytes and not art:
        art = None
    # Preflight before audio or any network callback.
    cp.identity_for('audio', audio, 'opus', destination, public)
    if art is not None:
        cp.identity_for('art', art, 'png', destination, public)
    with cp.session(path, destination, public, create=create) as current:
        current.put('audio', audio, 'opus', server.send)
        if art is not None:
            current.put('art', art, 'png', server.send)
        return current.register(registration(audio, art, title), server.send)


def interrupted(path):
    with cp.session(path, DEST, PUBLIC, create=True) as current:
        current.put('audio', AUDIO, 'opus', lambda *args: os._exit(17))


def hold_session(path, acquired, release):
    with cp.session(path, DEST, PUBLIC):
        acquired.set()
        release.wait(5)


@contextlib.contextmanager
def storage_fault(boundary):
    """Inject inside the real persistence function, not in place of it."""
    if boundary == 'partial_temp_write':
        original = cp.tempfile.NamedTemporaryFile
        class PartialFile:
            def __init__(self, *args, **kwargs):
                self.handle = original(*args, **kwargs)
            def __getattr__(self, name):
                return getattr(self.handle, name)
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return self.handle.__exit__(*args)
            def write(self, data):
                self.handle.write(data[:len(data) // 2])
                self.handle.flush()
                raise OSError('synthetic partial write')
        with patch.object(cp.tempfile, 'NamedTemporaryFile', PartialFile):
            yield
    elif boundary == 'replace':
        with patch.object(cp.os, 'replace', side_effect=OSError('synthetic replace failure')):
            yield
    else:
        original = cp.os.fsync
        def fsync(fd):
            is_directory = stat.S_ISDIR(os.fstat(fd).st_mode)
            if is_directory == (boundary == 'directory_fsync'):
                raise OSError('synthetic fsync failure')
            return original(fd)
        with patch.object(cp.os, 'fsync', side_effect=fsync):
            yield


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'track.json'
        self.server = Server()

    def test_audio_ack_art_validation_failure_retains_audio_but_stops(self):
        self.server.fail = ('art', cp.Rejected(415, 'artwork_format'))
        with self.assertRaises(cp.Rejected):
            chain(self.path, self.server, create=True)
        self.server.fail = None
        with self.assertRaises(cp.CheckpointError):
            chain(self.path, self.server, art=ART + b'corrected')
        state = json.loads(self.path.read_bytes())['state']
        self.assertEqual(state['blobs']['audio']['receipt']['sha256'], cp.sha(AUDIO))
        self.assertEqual(state['pending']['phase'], 'art')
        self.assertEqual([c[1].split('/')[3] for c in self.server.calls], ['audio', 'art'])
        self.assertIs(self.server.calls[0][2], AUDIO)
        self.assertEqual(cp.sha(self.server.calls[0][2]), self.server.calls[0][1].split('/')[-1].split('.')[0])

    def test_register_conflict_retries_only_register_and_synthetic_savings(self):
        self.server.fail = ('register', cp.Rejected(409, 'registration_library_changed'))
        with self.assertRaises(cp.Rejected):
            chain(self.path, self.server, create=True)
        self.server.fail = None
        chain(self.path, self.server)
        self.assertEqual([c[0] for c in self.server.calls], ['PUT', 'PUT', 'POST', 'POST'])
        actual = sum(len(c[2]) for c in self.server.calls if c[0] == 'PUT')
        baseline = 2 * (len(AUDIO) + len(ART))
        self.assertEqual(baseline - actual, len(AUDIO) + len(ART))
        self.assertEqual(actual * 2, baseline)  # 50% blob-byte reduction in THIS fixture only.

    def test_changed_bytes_destination_signer_or_extension_never_reuses_receipt(self):
        for change in [{'audio': AUDIO + b'changed'}, {'destination': 'https://other.invalid'}, {'public': 'b' * 64}]:
            with self.subTest(change=change):
                path = self.path.with_name(str(len(list(Path(self.tmp.name).glob('*.json')))) + '.json')
                server = Server()
                chain(path, server, create=True)
                chain(path, server, **change)
                self.assertEqual(sum(c[0] == 'PUT' and '/audio/' in c[1] for c in server.calls), 2)
        with cp.session(self.path, DEST, PUBLIC, create=True) as current:
            current.put('art', ART, 'png', self.server.send)
            current.put('art', ART, 'jpg', self.server.send)
        self.assertEqual(len(self.server.calls), 2)

    def test_mutable_cover_fails_before_transport_and_no_cover_skips_art(self):
        for art in [bytearray(ART)]:
            with self.assertRaises(cp.CheckpointError):
                chain(self.path, self.server, create=True, art=art)
            self.assertEqual(self.server.calls, [])
            self.assertFalse(self.path.exists())
        chain(self.path, self.server, create=True, art=None)
        self.assertEqual([c[0] for c in self.server.calls], ['PUT', 'POST'])

    def test_timeout_in_any_phase_blocks_next_attempt_including_changed_bytes(self):
        for phase in ['audio', 'art', 'register']:
            with self.subTest(phase=phase):
                path = self.path.with_name(phase + '.json')
                server = Server(); server.fail = (phase, TimeoutError())
                with self.assertRaises(TimeoutError):
                    chain(path, server, create=True)
                before = len(server.calls); server.fail = None
                with self.assertRaisesRegex(cp.CheckpointError, 'Unresolved'):
                    chain(path, server, audio=AUDIO + b'changed')
                self.assertEqual(len(server.calls), before)

    def test_authentication_unknown_http_and_wrong_phase_rejections_stop_persistently(self):
        for phase, status, code in [('audio', 401, 'signature_required'), ('art', 403, 'origin_not_allowed'),
                                    ('register', 503, 'temporary'), ('audio', 409, 'registration_library_changed')]:
            with self.subTest(phase=phase, status=status):
                path = self.path.with_name(str(status) + '.json')
                server = Server(); server.fail = (phase, cp.Rejected(status, code))
                with self.assertRaises(cp.Rejected):
                    chain(path, server, create=True)
                before = len(server.calls)
                with self.assertRaises(cp.CheckpointError):
                    chain(path, server)
                self.assertEqual(len(server.calls), before)

    def test_malformed_receipts_never_complete_or_retry(self):
        good = self.server.send('PUT', '/music/uploads/audio/' + cp.sha(AUDIO) + '.opus', AUDIO, 'audio/ogg')
        variants = [{}, {**good, 'size': True}, {**good, 'sha256': 'b' * 64}, {**good, 'key': 'other'},
                    {**good, 'r2Identity': {'etag': '', 'size': len(AUDIO), 'lastModified': 'bad'}},
                    {**good, 'r2Identity': {**good['r2Identity'], 'size': 1}},
                    {**good, 'r2Identity': {**good['r2Identity'], 'lastModified': '2026-99-10T00:00:00.000Z'}}]
        for i, receipt in enumerate(variants):
            path = self.path.with_name(str(i) + '.json')
            with cp.session(path, DEST, PUBLIC, create=True) as current:
                with self.assertRaises(cp.CheckpointError):
                    current.put('audio', AUDIO, 'opus', lambda *args: receipt)
                with self.assertRaises(cp.CheckpointError):
                    current.put('audio', AUDIO, 'opus', self.server.send)
            with self.assertRaises(cp.CheckpointError), cp.session(path, DEST, PUBLIC):
                pass

    def test_corrupt_truncated_duplicate_missing_and_invalid_state_fail_closed(self):
        variants = [b'{', b'{}', b'x' * 16385, b'{"state":{},"state":{},"checksum":"x"}']
        for raw in variants:
            self.path.write_bytes(raw)
            with self.assertRaises(cp.CheckpointError):
                chain(self.path, self.server)
        cp.write_state(self.path, {'version': 1, 'pending': None, 'blobs': {'audio': {'receipt': {}}}})
        with self.assertRaises(cp.CheckpointError):
            chain(self.path, self.server)
        self.path.unlink()
        with self.assertRaises(cp.CheckpointError):
            chain(self.path, self.server)
        self.assertEqual(self.server.calls, [])

    def test_process_interruption_leaves_durable_pending_and_blocks_replay(self):
        process = multiprocessing.get_context('fork').Process(target=interrupted, args=(self.path,))
        process.start(); process.join(5)
        self.assertEqual(process.exitcode, 17)
        with self.assertRaisesRegex(cp.CheckpointError, 'Unresolved'):
            chain(self.path, self.server)
        self.assertEqual(self.server.calls, [])

    def test_crash_after_server_ack_before_checkpoint_save_is_ambiguous(self):
        original = cp.write_state
        def save(path, state):
            if state['pending'] is None and state['blobs']:
                raise OSError('disk full')
            original(path, state)
        with patch.object(cp, 'write_state', side_effect=save):
            with self.assertRaises(OSError):
                chain(self.path, self.server, create=True)
        self.assertEqual(len(self.server.calls), 1)
        with self.assertRaises(cp.CheckpointError):
            chain(self.path, self.server)
        self.assertEqual(len(self.server.calls), 1)

    def test_intent_write_failure_prevents_transport(self):
        with cp.session(self.path, DEST, PUBLIC, create=True) as current:
            with patch.object(cp, 'write_state', side_effect=OSError('disk full')):
                with self.assertRaises(OSError):
                    current.put('audio', AUDIO, 'opus', self.server.send)
            with self.assertRaises(cp.CheckpointError):
                current.put('audio', AUDIO, 'opus', self.server.send)
        self.assertEqual(self.server.calls, [])

    def test_journal_lock_serializes_processes_and_session_cannot_escape_context(self):
        with cp.session(self.path, DEST, PUBLIC, create=True) as current:
            pass
        with self.assertRaises(cp.CheckpointError):
            current.put('audio', AUDIO, 'opus', self.server.send)
        ctx = multiprocessing.get_context('fork')
        acquired1, acquired2, release = ctx.Event(), ctx.Event(), ctx.Event()
        first = ctx.Process(target=hold_session, args=(self.path, acquired1, release))
        second = ctx.Process(target=hold_session, args=(self.path, acquired2, release))
        first.start(); self.assertTrue(acquired1.wait(3)); second.start()
        try:
            self.assertFalse(acquired2.wait(0.1))
        finally:
            release.set(); first.join(5); second.join(5)
        self.assertTrue(acquired2.is_set())
        self.assertEqual((first.exitcode, second.exitcode), (0, 0))

    def test_registration_is_not_cached_and_first_wins_metadata_is_unmodified(self):
        chain(self.path, self.server, create=True)
        result = chain(self.path, self.server, title='Later')
        self.assertTrue(result['duplicate'])
        self.assertEqual(self.server.metadata['title'], 'First')
        posts = [c for c in self.server.calls if c[0] == 'POST']
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[1][2], registration(title='Later'))
        self.assertEqual(sum(c[0] == 'PUT' for c in self.server.calls), 2)

    def test_false_registration_acknowledgement_does_not_clear_pending(self):
        with cp.session(self.path, DEST, PUBLIC, create=True) as current:
            with self.assertRaises(cp.CheckpointError):
                current.register(registration(), lambda *args: {'registered': True})
        with self.assertRaises(cp.CheckpointError):
            chain(self.path, self.server)

    def test_existing_transport_hashes_same_bytes_and_signs_each_actual_request_freshly(self):
        spec = importlib.util.spec_from_file_location('uploader', Path(__file__).resolve().parents[1] / 'scripts/upload-music-r2.py')
        uploader = importlib.util.module_from_spec(spec); spec.loader.exec_module(uploader)
        requests, signed = [], []
        def signing(args, **kwargs):
            signed.append(Path(args[-1]).read_bytes())
            return SimpleNamespace(stdout=b'x' * 64)
        def opened(request, **kwargs):
            requests.append(request)
            body = request.data
            self.assertEqual(request.get_header('X-music-sha256'), cp.sha(body))
            self.assertEqual(request.get_header('X-music-size'), str(len(body)))
            result = self.server.send(request.get_method(), request.selector, body, request.get_header('Content-type'))
            return io.BytesIO(cp.encode(result))
        def send(method, path, body, mime):
            return uploader.upload_request(method, path, body, mime, '/fixture/nonexistent.pem', PUBLIC)
        with patch.object(uploader.subprocess, 'run', side_effect=signing), \
             patch.object(uploader.urllib.request, 'build_opener', return_value=SimpleNamespace(open=opened)), \
             patch.object(uploader.time, 'time', side_effect=[100, 101, 102, 103]):
            with cp.session(self.path, uploader.ORIGIN, PUBLIC, create=True) as current:
                current.put('audio', AUDIO, 'opus', send)
                current.put('art', ART, 'png', send)
                current.register(registration(), send)
            with cp.session(self.path, uploader.ORIGIN, PUBLIC) as current:
                current.put('audio', AUDIO, 'opus', send)
                current.put('art', ART, 'png', send)
                current.register(registration(), send)
        self.assertIs(requests[0].data, AUDIO)
        self.assertIs(requests[1].data, ART)
        self.assertEqual([r.get_header('X-music-timestamp') for r in requests], ['100', '101', '102', '103'])
        self.assertEqual(len(set(signed)), 4)
        self.assertEqual([r.get_method() for r in requests], ['PUT', 'PUT', 'POST', 'POST'])

    def test_etag_must_match_server_schema_and_remain_bounded(self):
        identity = cp.identity_for('audio', AUDIO, 'opus', DEST, PUBLIC)
        receipt = self.server.send('PUT', identity['path'], AUDIO, identity['mime'])
        for etag in ['a' * 32, 'abc_123', 'abc123-5']:
            receipt['r2Identity']['etag'] = etag
            self.assertTrue(cp.receipt_ok(receipt, identity))
        for i, etag in enumerate(['"quoted"', 'token=value', 'fixture-etag', 'é', 'a' * 129, '']):
            receipt['r2Identity']['etag'] = etag
            self.assertFalse(cp.receipt_ok(receipt, identity))
            path = self.path.with_name(f'etag-{i}.json')
            with cp.session(path, DEST, PUBLIC, create=True) as current:
                with self.assertRaises(cp.CheckpointError):
                    current.put('audio', AUDIO, 'opus', lambda *args: receipt)
            with self.assertRaises(cp.CheckpointError), cp.session(path, DEST, PUBLIC):
                pass

    def test_registration_ack_binds_native_id_and_enforces_server_schema(self):
        good = {'registered': True, 'duplicate': False, 'id': 'r2_native_' + cp.sha(AUDIO), 'count': 1}
        variants = [{**good, 'id': 'r2_x'}, {**good, 'count': 50001}, {**good, 'count': True},
                    {**good, 'id': 'r2_native_' + 'b' * 64},
                    {**good, 'duplicate': True, 'id': 'r2_native_' + 'b' * 64},
                    {**good, 'id': 'r2_legacy_fixture_01'}, {**good, 'unexpected': 'not retained'}]
        for i, result in enumerate(variants):
            path = self.path.with_name(f'register-{i}.json')
            with cp.session(path, DEST, PUBLIC, create=True) as current:
                with self.assertRaises(cp.CheckpointError):
                    current.register(registration(), lambda *args: result)
            with self.assertRaises(cp.CheckpointError), cp.session(path, DEST, PUBLIC):
                pass
        with cp.session(self.path, DEST, PUBLIC, create=True) as current:
            legacy = {**good, 'duplicate': True, 'id': 'r2_legacy_fixture_01'}
            self.assertEqual(current.register(registration(), lambda *args: legacy), legacy)

    def test_invalid_registration_identity_never_sends(self):
        with cp.session(self.path, DEST, PUBLIC, create=True) as current:
            for body in [b'{}', b'[]', b'{', cp.encode({'sha256': 'b' * 64, 'size': True}),
                         cp.encode({'sha256': 'invalid', 'size': 1}),
                         cp.encode({'sha256': 'b' * 64, 'size': 32 * 1024 * 1024 + 1})]:
                with self.assertRaises(cp.CheckpointError):
                    current.register(body, self.server.send)
        self.assertEqual(self.server.calls, [])

    def test_real_intent_persistence_boundaries_never_start_request_on_failure(self):
        for boundary in ['partial_temp_write', 'file_fsync', 'replace', 'directory_fsync']:
            with self.subTest(boundary=boundary):
                path = self.path.with_name(boundary + '.json')
                with cp.session(path, DEST, PUBLIC, create=True) as current:
                    with storage_fault(boundary), self.assertRaises(OSError):
                        current.put('audio', AUDIO, 'opus', self.server.send)
                    with self.assertRaises(cp.CheckpointError):
                        current.put('audio', AUDIO, 'opus', self.server.send)
                if boundary == 'directory_fsync':
                    with self.assertRaises(cp.CheckpointError):
                        cp.read_state(path)
                else:
                    self.assertIsNone(cp.read_state(path)['pending'])
        self.assertEqual(self.server.calls, [])
        self.assertTrue(all(p.suffix in ('.json', '.lock') for p in Path(self.tmp.name).iterdir()))

    def test_real_ack_persistence_boundaries_allow_only_valid_ack_or_pending(self):
        original = cp.write_state
        for boundary in ['partial_temp_write', 'file_fsync', 'replace', 'directory_fsync']:
            with self.subTest(boundary=boundary):
                path = self.path.with_name(boundary + '.json')
                server = Server()
                def save(path, state):
                    if state['pending'] is None and state['blobs']:
                        with storage_fault(boundary):
                            return original(path, state)
                    return original(path, state)
                with cp.session(path, DEST, PUBLIC, create=True) as current:
                    with patch.object(cp, 'write_state', side_effect=save), self.assertRaises(OSError):
                        current.put('audio', AUDIO, 'opus', server.send)
                    with self.assertRaises(cp.CheckpointError):
                        current.put('audio', AUDIO, 'opus', server.send)
                if boundary == 'directory_fsync':
                    # Replace already exposed the validated acknowledgement. A
                    # power loss could instead restore pending; neither resends.
                    with cp.session(path, DEST, PUBLIC) as current:
                        current.put('audio', AUDIO, 'opus', server.send)
                else:
                    with self.assertRaises(cp.CheckpointError), cp.session(path, DEST, PUBLIC):
                        pass
                self.assertEqual(len(server.calls), 1)
        self.assertTrue(all(p.suffix in ('.json', '.lock') for p in Path(self.tmp.name).iterdir()))

    def test_state_excludes_request_body_key_paths_signatures_and_exception_text(self):
        body = cp.encode({'sha256': cp.sha(AUDIO), 'size': len(AUDIO),
                          'metadata': {'title': 'PRIVATE_METADATA_SENTINEL'}})
        with cp.session(self.path, DEST, PUBLIC, create=True) as current:
            current.put('audio', AUDIO, 'opus', self.server.send)
            with self.assertRaises(RuntimeError):
                current.register(body, lambda *args: (_ for _ in ()).throw(RuntimeError('PRIVATE_EXCEPTION_SENTINEL')))
        raw = self.path.read_text()
        for value in ['PRIVATE_METADATA_SENTINEL', 'PRIVATE_EXCEPTION_SENTINEL', '/fixture/nonexistent.pem', 'signature', 'OpusHead']:
            self.assertNotIn(value, raw)
        self.assertEqual(set(json.loads(raw)['state']), {'version', 'pending', 'blobs'})

    def test_reported_empty_cover_skips_put_and_registration_reference(self):
        result = chain(self.path, self.server, create=True, art=b'')
        self.assertTrue(result['registered'])
        self.assertEqual([call[0] for call in self.server.calls], ['PUT', 'POST'])
        self.assertNotIn('cover', json.loads(self.server.calls[-1][2]))
        with cp.session(self.path, DEST, PUBLIC) as current:
            with self.assertRaises(cp.CheckpointError):
                current.put('art', b'', 'jpg', self.server.send)
        self.assertEqual(len(self.server.calls), 2)

    def test_five_outer_attempts_cannot_bypass_pending_on_same_job(self):
        # Models an unsafe outer retry loop against the proposed single-request
        # seam. This is not a claim that Mast calls the helper today.
        failures = [TimeoutError(), http.client.RemoteDisconnected(),
                    cp.Rejected(503, 'unattributed_http_error'), cp.Rejected(429, 'unattributed_http_error')]
        for phase in ['audio', 'art', 'register']:
            for i, failure in enumerate(failures):
                path = self.path.with_name(f'{phase}-{i}.json')
                server = Server(); server.fail = (phase, failure)
                for attempt in range(5):
                    with self.assertRaises((TimeoutError, http.client.RemoteDisconnected, cp.Rejected, cp.CheckpointError)):
                        chain(path, server, create=(attempt == 0))
                self.assertEqual(sum(call[1].split('/')[3] == phase for call in server.calls), 1)

    def test_ten_minute_claim_expiry_does_not_reconcile_journal(self):
        for phase in ['audio', 'art', 'register']:
            path = self.path.with_name(phase + '.json')
            server = Server(); server.fail = (phase, TimeoutError())
            with self.assertRaises(TimeoutError):
                chain(path, server, create=True)
            before = len(server.calls)
            # Even arbitrarily old on-disk state remains pending after a new
            # process/session opens it. Manifest reclaim is not implemented here.
            os.utime(path, (0, 0))
            with patch.object(cp, 'read_state', wraps=cp.read_state) as read:
                with self.assertRaises(cp.CheckpointError):
                    chain(path, server)
                read.assert_called_once()
            self.assertEqual(len(server.calls), before)

    def test_internal_transport_retries_are_outside_checkpoint_protection(self):
        # Negative contract fixture: a retrying callback really CAN send five
        # times before the helper sees an exception. It must never be adapted as
        # the single-request callback. Helper installation alone is insufficient.
        attempts = []
        def unsafe_send(*args):
            for _ in range(5):
                attempts.append(args)
            raise http.client.RemoteDisconnected()
        with cp.session(self.path, DEST, PUBLIC, create=True) as current:
            with self.assertRaises(http.client.RemoteDisconnected):
                current.put('audio', AUDIO, 'opus', unsafe_send)
        self.assertEqual(len(attempts), 5)
        with self.assertRaises(cp.CheckpointError), cp.session(self.path, DEST, PUBLIC):
            pass

    def test_create_cannot_overwrite_existing_job(self):
        chain(self.path, self.server, create=True)
        with self.assertRaises(FileExistsError):
            chain(self.path, self.server, create=True)


if __name__ == '__main__':
    unittest.main()
