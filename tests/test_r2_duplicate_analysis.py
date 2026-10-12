"""Local synthetic responses only; no supplied Mast code is executed."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from scripts.prototypes import upload_checkpoints as cp

DEST = 'https://fixture.invalid'
PUBLIC = 'a' * 64
DIGEST = cp.sha(b'fixture audio')
TRACK = 'r2_native_' + DIGEST


class DuplicateSequence(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'state.json'
        self.registration = {'sha256': DIGEST, 'size': 13, 'metadata': {'title': 'First', 'audioAnalysis': {'version': 1}}}
        self.existing = {'id': TRACK, 'sha256': DIGEST, 'size': 13,
                         'r2Identity': {'etag': 'proof', 'size': 13, 'lastModified': '2026-10-10T00:00:00.000Z'},
                         'metadata': {'title': 'Original', 'audioAnalysis': {'version': 0, 'z': 2, 'a': 1}}}
        self.result = {'registered': True, 'duplicate': True, 'id': TRACK, 'count': 1}
        self.calls = []; self.mutate = None; self.failure = None

    def request(self, method, url, body, mime, public):
        self.assertEqual(public, PUBLIC)
        self.calls.append((method, url, body, mime))
        phase = url.rsplit('/', 1)[-1]
        pending = json.loads(self.path.read_bytes())['state']['pending']
        self.assertIsNotNone(pending)
        if self.failure == phase: raise TimeoutError('synthetic ambiguous outcome')
        if phase == 'register': value = self.result
        elif phase == 'library.json':
            self.assertEqual(pending['phase'], 'duplicate_catalog_pending')
            value = {'tracks': [self.existing]}
        else:
            self.assertEqual(pending['phase'], 'analysis')
            value = {'registered': True, 'analysisUpdated': True, 'id': TRACK, 'count': 1}
        response = {'status': 200, 'url': url, 'content_type': 'application/json', 'body': json.dumps(value, separators=(',', ':')).encode()}
        if self.mutate: self.mutate(phase, response)
        return response

    def run_sequence(self):
        with cp.session(self.path, DEST, PUBLIC, create=True) as session:
            return session.register_with_analysis(cp.encode(self.registration), self.request)

    def assert_held(self):
        before = self.path.read_bytes(); count = len(self.calls)
        with self.assertRaises(cp.CheckpointError):
            with cp.session(self.path, DEST, PUBLIC) as session:
                session.register_with_analysis(cp.encode(self.registration), self.request)
        self.assertEqual(len(self.calls), count)
        self.assertEqual(self.path.read_bytes(), before)

    def test_exact_sequence_preserves_prior_proof_metadata_and_inputs(self):
        before = copy.deepcopy((self.registration, self.existing, self.result))
        result = self.run_sequence()
        self.assertEqual([c[0] for c in self.calls], ['POST', 'GET', 'POST'])
        correction = json.loads(self.calls[-1][2])
        self.assertEqual(correction['previousAnalysis'], {'version': 0, 'z': 2, 'a': 1})
        self.assertEqual(list(correction['previousAnalysis']), ['version', 'z', 'a'])
        self.assertEqual(correction['r2Identity'], self.existing['r2Identity'])
        self.assertEqual(correction['audioAnalysis'], self.registration['metadata']['audioAnalysis'])
        self.assertEqual(before, (self.registration, self.existing, self.result))
        self.assertTrue(result['analysisCorrection']['analysisUpdated'])
        self.assert_held()

    def test_skip_conditions(self):
        for duplicate, analysis in ((False, True), (True, False)):
            with self.subTest(duplicate=duplicate, analysis=analysis):
                if self.path.exists(): self.path.unlink()
                self.calls.clear(); self.result['duplicate'] = duplicate
                if not analysis: self.registration['metadata'].pop('audioAnalysis')
                self.run_sequence(); self.assertEqual(len(self.calls), 1)
                self.assertIsNone(cp.read_state(self.path)['pending'])

    def test_missing_previous_analysis_preserved_as_null(self):
        self.existing['metadata'].pop('audioAnalysis')
        self.run_sequence()
        self.assertIsNone(json.loads(self.calls[-1][2])['previousAnalysis'])

    def test_catalog_identity_and_proof_fail_before_post(self):
        original = copy.deepcopy(self.existing)
        for field, value in [('sha256', 'b'*64), ('size', True), ('r2Identity', {}), ('metadata', None), ('id', 'r2_missing_123456')]:
            with self.subTest(field=field):
                if self.path.exists(): self.path.unlink()
                self.calls.clear(); self.existing = {**original, field: value}
                with self.assertRaises(cp.CheckpointError): self.run_sequence()
                self.assertEqual(len(self.calls), 2); self.assert_held()

    def test_raw_catalog_validation_and_duplicate_rows(self):
        raw_cases = [b'{', b'{"tracks":[],"tracks":[]}', b'{"tracks":[],"n":1e400}', cp.encode({'tracks': [self.existing, self.existing]}), b' '* (16*1024*1024+1)]
        for raw in raw_cases:
            if self.path.exists(): self.path.unlink()
            self.calls.clear()
            self.mutate = lambda phase, response: response.update(body=raw) if phase=='library.json' else None
            with self.assertRaises(cp.CheckpointError): self.run_sequence()
            self.assertEqual(len(self.calls), 2); self.assert_held()

    def test_timeout_at_each_phase_never_replays(self):
        for phase in ('register', 'library.json', 'analysis'):
            with self.subTest(phase=phase):
                if self.path.exists(): self.path.unlink()
                self.calls.clear(); self.failure = phase
                with self.assertRaises(TimeoutError): self.run_sequence()
                self.assert_held()

    def test_analysis_false_wrong_identity_and_http_failures_hold(self):
        for change in ({'registered': False}, {'id': 'r2_other_123456'}, {'analysisUpdated': 'yes'}):
            if self.path.exists(): self.path.unlink()
            self.calls.clear()
            def mutate(phase, response):
                if phase == 'analysis':
                    value = json.loads(response['body']); value.update(change); response['body'] = cp.encode(value)
            self.mutate = mutate
            with self.assertRaises(cp.CheckpointError): self.run_sequence()
            self.assert_held()
        for field, value in [('status', 401), ('status', 403), ('status', 503), ('url', DEST+'/wrong'), ('content_type', 'text/plain')]:
            if self.path.exists(): self.path.unlink()
            self.calls.clear()
            self.mutate = lambda phase, response: response.update({field: value}) if phase == 'analysis' else None
            with self.assertRaises(cp.CheckpointError): self.run_sequence()
            self.assert_held()

    def test_process_interruption_between_registration_and_analysis_stays_held(self):
        def interrupted(method, url, body, mime, public):
            if method == 'GET': raise SystemExit('offline process interruption')
            return self.request(method, url, body, mime, public)
        with self.assertRaises(SystemExit):
            with cp.session(self.path, DEST, PUBLIC, create=True) as session:
                session.register_with_analysis(cp.encode(self.registration), interrupted)
        self.assertEqual(json.loads(self.path.read_bytes())['state']['pending']['phase'], 'duplicate_catalog_pending')
        self.assert_held()

    def test_invalid_proof_blocks_same_session_without_clearing_durable_hold(self):
        self.existing['r2Identity'] = {}
        with cp.session(self.path, DEST, PUBLIC, create=True) as session:
            with self.assertRaises(cp.CheckpointError):
                session.register_with_analysis(cp.encode(self.registration), self.request)
            before = self.path.read_bytes()
            with self.assertRaises(cp.CheckpointError):
                session.register_with_analysis(cp.encode(self.registration), self.request)
            self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(len(self.calls), 2)


if __name__ == '__main__': unittest.main()
