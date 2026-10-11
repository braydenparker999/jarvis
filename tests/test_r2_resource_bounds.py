"""Local process groups, tiny fake files and bounded synthetic output only."""
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest

from scripts.prototypes.process_guard import run, ProcessLimit
from scripts.prototypes.artifact_budget import ArtifactBudget, BudgetExceeded
from scripts.prototypes import worker_boundary as worker
from scripts.prototypes.upload_checkpoints import sha


class ResourceBounds(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def child(self, code): return [sys.executable, '-c', code]

    def assert_not_running(self, pid):
        status = Path('/proc')/str(pid)/'stat'
        # Group SIGKILL delivery is asynchronous; guard only reaps its leader.
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try: state = status.read_text().split(') ')[1][0]
            except FileNotFoundError: return
            if state == 'Z': return
            time.sleep(0.01)
        self.fail('descendant still running after bounded signal-delivery wait')

    def test_timeout_kills_cooperating_descendant_group(self):
        pidfile = self.root/'pid'
        code = ("import subprocess,sys,time;from pathlib import Path;"
                "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)']);"
                f"Path({str(pidfile)!r}).write_text(str(p.pid));time.sleep(10)")
        with self.assertRaisesRegex(ProcessLimit, 'timeout'):
            run(self.child(code), timeout=0.4)
        self.assert_not_running(int(pidfile.read_text()))

    def test_successful_leader_with_surviving_descendant_is_rejected(self):
        pidfile = self.root/'pid'
        code = ("import subprocess,sys;from pathlib import Path;"
                "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);"
                f"Path({str(pidfile)!r}).write_text(str(p.pid))")
        with self.assertRaisesRegex(ProcessLimit, 'Descendant'):
            run(self.child(code), timeout=2)
        self.assert_not_running(int(pidfile.read_text()))

    def test_output_flood_is_bounded_and_terminated(self):
        with self.assertRaisesRegex(ProcessLimit, 'output limit'):
            run(self.child("import os;os.write(1,b'x'*1000000)"), timeout=2, output_limit=128)

    def test_hard_per_file_limit_is_inherited(self):
        output = self.root/'large'
        code = f"from pathlib import Path;Path({str(output)!r}).write_bytes(b'x'*100000)"
        result, _ = run(self.child(code), timeout=2, file_limit=1024)
        self.assertNotEqual(result, 0)
        self.assertLessEqual(output.stat().st_size, 1024)

    def test_aggregate_runtime_budget_check_stops_child(self):
        directory = self.root/'offline-upload-attempt-one'; directory.mkdir()
        budget = ArtifactBudget(self.root, attempt_bytes=1024, total_bytes=2048)
        code = f"from pathlib import Path;import time;p=Path({str(directory)!r});[(p/str(n)).write_bytes(b'x'*600) for n in range(3)];time.sleep(10)"
        with self.assertRaises(BudgetExceeded):
            run(self.child(code), timeout=2, file_limit=1024, check=budget.check)
        self.assertTrue(directory.exists())  # Never erase evidence on overflow.
        with self.assertRaises(BudgetExceeded): budget.check(reserve=True)

    def test_retention_count_byte_file_and_symlink_rejections(self):
        directory = self.root/'offline-upload-attempt-one'; directory.mkdir()
        (directory/'journal').write_bytes(b'evidence')
        before = (directory/'journal').read_bytes()
        with self.assertRaises(BudgetExceeded): ArtifactBudget(self.root, max_attempts=1).check(reserve=True)
        with self.assertRaises(BudgetExceeded): ArtifactBudget(self.root, total_bytes=10, attempt_bytes=9).check(reserve=True)
        (directory/'other').touch()
        with self.assertRaises(BudgetExceeded): ArtifactBudget(self.root, max_files=1).check()
        (directory/'other').unlink(); (directory/'link').symlink_to(self.root/'missing')
        with self.assertRaises(BudgetExceeded): ArtifactBudget(self.root).check()
        self.assertEqual((directory/'journal').read_bytes(), before)

    def fixture(self):
        audio = b'offline'; manifest = self.root/'manifest.json'; token = self.root/'token'
        manifest.write_text(json.dumps({'entries': {'job': {'status': 'pending', 'sha256': sha(audio), 'size': len(audio)}}}))
        value = worker.claim(manifest, 'job')
        child = Path(__file__).parent/'fixtures/offline_worker_child.py'
        def command(report, attempt, claim, snapshot):
            from dataclasses import asdict
            return [sys.executable, str(child), str(manifest), str(report), attempt, json.dumps(asdict(claim)),
                    str(snapshot), str(self.root/'STOP'), str(self.root/'calls'), 'normal']
        return audio, manifest, token, value, command

    def test_decoder_timeout_preserves_registration_and_global_hold(self):
        audio, manifest, token, value, command = self.fixture()
        status = worker.run_attempt(manifest, value, token, [], command,
                    lambda path: self.child('import time;time.sleep(10)'), audio, decoder_timeout=0.15)
        state = json.loads(manifest.read_text())
        self.assertEqual(status, 'held_decode_failed')
        self.assertTrue(state['entries']['job']['registration_confirmed'])
        self.assertFalse(state['entries']['job']['local_decode_ok'])
        self.assertIsNotNone(state['upload_hold'])

    def test_decoder_diagnostics_are_failure_not_silent_success(self):
        audio, manifest, token, value, command = self.fixture()
        status = worker.run_attempt(manifest, value, token, [], command,
                    lambda path: self.child("print('decode error')"), audio)
        self.assertEqual(status, 'held_decode_failed')

    def test_quota_admission_preserves_state_and_retained_evidence(self):
        audio, manifest, token, value, command = self.fixture()
        existing = self.root/'offline-upload-attempt-preserved'; existing.mkdir()
        (existing/'journal').write_bytes(b'pending receipt')
        before = manifest.read_bytes()
        budget = ArtifactBudget(self.root, max_attempts=1)
        with self.assertRaises(BudgetExceeded):
            worker.run_attempt(manifest, value, token, [], command, lambda path: self.child('pass'), audio, budget=budget)
        self.assertEqual(manifest.read_bytes(), before)
        self.assertEqual((existing/'journal').read_bytes(), b'pending receipt')
        self.assertEqual(len(list(self.root.glob('offline-upload-attempt-*'))), 1)
        self.assertFalse((self.root/'calls').exists())

    def test_executable_without_arguments(self):
        self.assertEqual(run(['/bin/true'], timeout=2), (0, 0))


if __name__ == '__main__': unittest.main()
