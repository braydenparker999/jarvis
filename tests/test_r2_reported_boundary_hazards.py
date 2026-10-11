"""Negative offline reproductions, not Mast runtime code or proposed semantics."""
import fcntl
import os
from pathlib import Path
import tempfile
import unittest


class ReportedBoundaryHazards(unittest.TestCase):
    def test_reported_worker_branch_marks_registered_even_when_decode_returns_false(self):
        # Literal control-flow shape in public comment 6102590119, with local
        # stubs only. This demonstrates the excerpt, not the unprovided worker.
        statuses = []
        def reported_branch(result, decode_check):
            registered = result.get('registered') is True
            if registered:
                decode_ok = decode_check()
                statuses.append('registered')
                return 'registered', decode_ok
        self.assertEqual(reported_branch({'registered': True}, lambda: False), ('registered', False))
        self.assertEqual(statuses, ['registered'])

    def test_atomic_replace_does_not_preserve_a_lock_on_manifest_inode(self):
        # Supplied manifest excerpt 6102682701 now shows this lock shape.
        # This still does not establish the running worker implementation.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'manifest.json'
            path.write_bytes(b'{}')
            with path.open('rb') as old:
                fcntl.flock(old, fcntl.LOCK_EX | fcntl.LOCK_NB)
                replacement = path.with_suffix('.tmp'); replacement.write_bytes(b'{}'); replacement.replace(path)
                with path.open('rb') as new:
                    self.assertNotEqual(os.fstat(old.fileno()).st_ino,
                                        os.fstat(new.fileno()).st_ino)
                    # A different claimant can lock the new inode while the old
                    # claimant believes it still owns the manifest lock.
                    fcntl.flock(new, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_stable_sidecar_lock_stays_exclusive_across_manifest_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'manifest.json'
            lock = Path(directory) / 'manifest.lock'
            path.write_bytes(b'{}')
            with lock.open('a+b') as first:
                fcntl.flock(first, fcntl.LOCK_EX | fcntl.LOCK_NB)
                replacement = path.with_suffix('.tmp'); replacement.write_bytes(b'{}'); replacement.replace(path)
                with lock.open('a+b') as second:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(second, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_timeout_diagnostic_bytes_cannot_be_concatenated_with_string(self):
        import subprocess
        error = subprocess.TimeoutExpired('offline-fixture', 900, output=b'partial')
        with self.assertRaises(TypeError):
            (error.stdout or '') + '\nTIMEOUT after 900s'

    def test_hold_created_during_backoff_needs_new_check_before_retry(self):
        # Local negative model of the shown retry branch, not runtime execution.
        holds = {'stop': False}
        attempts = []
        if not holds['stop']:  # main-loop admission
            for attempt in range(2):
                attempts.append(attempt)
                holds['stop'] = True  # hold arrives during first backoff
        self.assertEqual(attempts, [0, 1])

    def test_stale_snapshot_save_loses_append_even_with_stable_lock(self):
        # Locally authored model of manifest_lib.save's caller-snapshot contract.
        # No package code is imported/executed. A sidecar alone cannot repair it.
        import json
        from scripts.prototypes.manifest_transaction import Transaction
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'manifest.json'
            path.write_text('{"entries":{"original":{"status":"pending"}}}')
            stale = json.loads(path.read_text())
            with Transaction(path) as tx:
                tx.value['entries']['new'] = {'status': 'pending'}
                tx.commit(tx.value)
            with Transaction(path) as tx:
                tx.commit(stale)  # Serialized replacement of an obsolete snapshot.
            self.assertEqual(set(json.loads(path.read_text())['entries']), {'original'})


if __name__ == '__main__': unittest.main()
