"""Offline subprocess and fault fixtures; never execute external worker source."""
from dataclasses import asdict, replace
import fcntl
import json
import multiprocessing as mp
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

from scripts.prototypes import worker_boundary as worker
from scripts.prototypes.upload_checkpoints import sha
from scripts.prototypes.manifest_transaction import Transaction

AUDIO = b'OggS local synthetic audio'
CHILD = Path(__file__).parent / 'fixtures/offline_worker_child.py'


def waiting_worker(manifest, claim_dict, token, stop, ready, result):
    value = worker.Claim(**claim_dict)
    def command(*args):
        Path(result).write_text('child-started')
        return [sys.executable, '-c', 'raise RuntimeError()']
    real_flock = worker.fcntl.flock
    def observed_flock(fd, operation):
        ready.set()  # run_attempt already passed its pre-token stop check.
        return real_flock(fd, operation)
    worker.fcntl.flock = observed_flock
    try:
        worker.run_attempt(manifest, value, token, [stop], command, lambda path: True, AUDIO)
    except worker.BoundaryError:
        Path(result).write_text('blocked')


class WorkerBoundaries(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name); self.manifest = self.root/'manifest.json'
        self.manifest.write_text(json.dumps({'entries': {'job': {'status': 'pending', 'sha256': sha(AUDIO), 'size': len(AUDIO), 'metadata': {'title': 'Original'}}}}))
        self.value = worker.claim(self.manifest, 'job')
        self.token = self.root/'token'; self.stop = self.root/'STOP'; self.log = self.root/'calls'

    def entry(self): return json.loads(self.manifest.read_text())['entries']['job']

    def command(self, mode):
        def argv(report, attempt, value, audio):
            self.assertFalse(report.exists())
            return [sys.executable, str(CHILD), str(self.manifest), str(report), attempt,
                    json.dumps(asdict(value)), str(audio), str(self.stop), str(self.log), mode]
        return argv

    def run_fixture(self, mode='normal', decode=None, **kwargs):
        return worker.run_attempt(self.manifest, self.value, self.token, [self.stop], self.command(mode),
                                  decode or (lambda path: [sys.executable, '-c', 'pass']), AUDIO, **kwargs)

    def test_end_to_end_registration_and_duplicate_analysis(self):
        self.assertEqual(self.run_fixture('analysis', require_analysis=True), 'completed')
        entry = self.entry()
        self.assertTrue(entry['registration_confirmed']); self.assertTrue(entry['local_decode_ok'])
        self.assertEqual(entry['metadata'], {'title': 'Original'})
        self.assertEqual(len(self.log.read_text().splitlines()), 4)
        directory = Path(entry['attempt_directory'])
        self.assertTrue((directory/'report.json').exists())
        journal = json.loads((directory/'report.json.journal').read_text())['state']
        self.assertEqual(journal['pending']['phase'], 'analysis_acknowledged_completion_pending')
        with self.assertRaises(worker.BoundaryError): worker.claim(self.manifest, 'job')

    def test_decode_false_and_exception_are_held_not_completed(self):
        self.assertEqual(self.run_fixture(decode=lambda path: [sys.executable, '-c', 'raise SystemExit(1)']), 'held_decode_failed')
        self.assertFalse(self.entry()['local_decode_ok'])
        self.assertTrue(self.entry()['registration_confirmed'])
        with self.assertRaises(worker.BoundaryError): self.run_fixture()

    def test_decode_exception_is_false(self):
        def decode(path): raise RuntimeError('fixture decode')
        self.assertEqual(self.run_fixture(decode=decode), 'held_decode_failed')

    def test_missing_report_cannot_reuse_old_report(self):
        (self.root/'report.json').write_text('{"registered":true}')
        with self.assertRaises(FileNotFoundError): self.run_fixture('no_report')
        self.assertEqual(self.entry()['status'], 'held')
        with self.assertRaises(worker.BoundaryError): self.run_fixture()

    def test_invalid_report_and_post_report_crash_hold(self):
        for mode in ('bad_report', 'false_registered', 'after_report_crash', 'mutate_audio'):
            with self.subTest(mode=mode):
                # New independent logical job fixture, not a retry reset.
                path = self.root/(mode+'.json')
                path.write_text(json.dumps({'entries': {'job': {'status': 'pending', 'sha256': sha(AUDIO), 'size': len(AUDIO)}}}))
                old_manifest, old_claim = self.manifest, self.value
                self.manifest, self.value = path, worker.claim(path, 'job')
                try:
                    with self.assertRaises(worker.BoundaryError): self.run_fixture(mode)
                    self.assertEqual(self.entry()['status'], 'held')
                finally: self.manifest, self.value = old_manifest, old_claim

    def test_timeout_with_partial_stdout_holds_without_replay(self):
        with self.assertRaisesRegex(worker.BoundaryError, 'timeout'):
            self.run_fixture('timeout', timeout=0.15)
        self.assertEqual(self.entry()['status'], 'held')
        with self.assertRaises(worker.BoundaryError): self.run_fixture()

    def test_stop_between_requests_prevents_next_network_call(self):
        with self.assertRaises(worker.BoundaryError): self.run_fixture('stop_between')
        self.assertEqual(len(self.log.read_text().splitlines()), 1)
        self.assertEqual(self.entry()['status'], 'held')
        self.assertTrue(self.stop.exists())

    def test_stop_after_token_wait_prevents_child(self):
        context = mp.get_context('spawn'); ready = context.Event(); result = self.root/'result'
        with self.token.open('a+b') as token:
            fcntl.flock(token, fcntl.LOCK_EX)
            process = context.Process(target=waiting_worker, args=(self.manifest, asdict(self.value), self.token, self.stop, ready, result))
            process.start(); self.assertTrue(ready.wait(5))
            self.stop.touch()
        process.join(5)
        if process.is_alive(): process.kill(); process.join(); self.fail('waiter stuck')
        self.assertEqual(process.exitcode, 0); self.assertEqual(result.read_text(), 'blocked')
        self.assertEqual(self.entry()['status'], 'claimed')

    def test_stale_generation_rejects_completion_and_request(self):
        with Transaction(self.manifest) as tx:
            tx.value['entries']['job'].update(status='held', attempt='attempt', generation='new-generation')
            tx.commit(tx.value)
        before = self.manifest.read_bytes(); calls = []
        with self.assertRaises(worker.BoundaryError):
            worker._finish(self.manifest, self.value, 'attempt', {'id': 'old'}, True)
        with self.assertRaises(worker.BoundaryError):
            worker.guarded_request(self.manifest, self.value, 'attempt', [], lambda: calls.append('sent'))
        self.assertEqual(calls, []); self.assertEqual(self.manifest.read_bytes(), before)

    def test_changed_audio_rejected_before_child_or_state_change(self):
        before = self.manifest.read_bytes()
        with self.assertRaises(worker.BoundaryError):
            worker.run_attempt(self.manifest, self.value, self.token, [], self.command('normal'), lambda path: True, b'changed')
        self.assertEqual(self.manifest.read_bytes(), before); self.assertFalse(self.log.exists())

    def test_ambiguous_attempt_blocks_other_jobs_globally(self):
        with self.assertRaises(FileNotFoundError): self.run_fixture('no_report')
        with Transaction(self.manifest) as tx:
            tx.value['entries']['other'] = {'status': 'pending', 'sha256': sha(AUDIO), 'size': len(AUDIO)}
            tx.commit(tx.value)
        other = worker.claim(self.manifest, 'other')
        with self.assertRaisesRegex(worker.BoundaryError, 'global'):
            worker.run_attempt(self.manifest, other, self.token, [], self.command('normal'), lambda path: True, AUDIO)
        self.assertFalse(self.log.exists())
        self.assertIsNotNone(json.loads(self.manifest.read_text())['upload_hold'])

    def test_generation_changes_during_decode_reject_late_completion(self):
        def decode(path):
            with Transaction(self.manifest) as tx:
                tx.value['entries']['job']['generation'] = 'new-owner'
                tx.commit(tx.value)
            return True
        with self.assertRaisesRegex(worker.BoundaryError, 'Stale'):
            self.run_fixture(decode=decode)
        self.assertEqual(self.entry()['generation'], 'new-owner')
        self.assertEqual(self.entry()['status'], 'held')
        self.assertNotIn('registration_confirmed', self.entry())

    def test_post_decode_mutation_never_completes(self):
        def decode(path):
            path.write_bytes(b'mutated by fixture')
            return True
        with self.assertRaisesRegex(worker.BoundaryError, 'snapshot changed'):
            self.run_fixture(decode=decode)
        self.assertEqual(self.entry()['status'], 'held')

    def test_auth_response_holds_globally_without_retry(self):
        with self.assertRaises(worker.BoundaryError): self.run_fixture('auth')
        before = self.log.read_bytes()
        self.assertEqual(self.entry()['status'], 'held')
        self.assertIsNotNone(json.loads(self.manifest.read_text())['upload_hold'])
        with self.assertRaises(worker.BoundaryError): self.run_fixture()
        self.assertEqual(self.log.read_bytes(), before)

    def test_snapshot_fifo_symlink_and_sparse_growth_fail_closed(self):
        path = self.root/'snapshot'
        os.mkfifo(path)
        with self.assertRaises(worker.BoundaryError): worker._snapshot_matches(path, AUDIO)
        path.unlink(); path.symlink_to(self.manifest)
        with self.assertRaises(OSError): worker._snapshot_matches(path, AUDIO)
        path.unlink()
        with path.open('wb') as stream:
            stream.write(AUDIO); stream.truncate(1024*1024*1024)
        with self.assertRaises(worker.BoundaryError): worker._snapshot_matches(path, AUDIO)

    def test_report_boolean_size_is_not_integer_identity(self):
        value = replace(self.value, size=1)
        report = self.root/'malformed.json'
        worker.write_report(report, value, 'attempt', {'registered': True, 'duplicate': False,
                            'id': 'r2_native_'+value.sha256, 'count': 1})
        contents = json.loads(report.read_text()); contents['claim']['size'] = True
        report.write_text(json.dumps(contents))
        with self.assertRaises(worker.BoundaryError): worker._report(report, value, 'attempt', False)

    def test_parent_process_death_after_hold_prevents_replay(self):
        code = """import json,os,sys
from scripts.prototypes.worker_boundary import Claim,run_attempt
value=Claim(**json.loads(sys.argv[2]))
def command(*args): os._exit(23)
run_attempt(sys.argv[1],value,sys.argv[3],[],command,lambda path:True,bytes.fromhex(sys.argv[4]))
"""
        result = subprocess.run([sys.executable, '-c', code, str(self.manifest), json.dumps(asdict(self.value)), str(self.token), AUDIO.hex()], timeout=5)
        self.assertEqual(result.returncode, 23)
        self.assertEqual(self.entry()['status'], 'held')
        before = set(self.root.glob('offline-upload-attempt-*'))
        with self.assertRaises(worker.BoundaryError): self.run_fixture()
        self.assertEqual(set(self.root.glob('offline-upload-attempt-*')), before)
        self.assertFalse(self.log.exists())


if __name__ == '__main__': unittest.main()
