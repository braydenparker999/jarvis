"""Locally authored offline fixtures; never execute reported Mast source."""
import fcntl
import json
import multiprocessing as mp
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from scripts.prototypes.manifest_transaction import Transaction, ManifestError, CommitUncertain


def increment(path, count, started=None):
    if started: started.set()
    for _ in range(count):
        with Transaction(path) as tx:
            tx.value['n'] += 1
            tx.commit(tx.value)


def crash(path, after_replace):
    real_replace = os.replace
    def replacement(source, target):
        if after_replace: real_replace(source, target)
        os._exit(17)
    with patch('scripts.prototypes.manifest_transaction.os.replace', replacement):
        increment(path, 1)


class ManifestTransactions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'manifest.json'
        self.path.write_text('{"entries":{},"n":0,"unknown":"preserve"}')
        self.ctx = mp.get_context('spawn')

    def join(self, process, code=0):
        process.join(10)
        if process.is_alive():
            process.kill(); process.join(); self.fail('child did not finish')
        self.assertEqual(process.exitcode, code)

    def test_four_parallel_writers_preserve_all_updates(self):
        children = [self.ctx.Process(target=increment, args=(self.path, 20)) for _ in range(4)]
        for child in children: child.start()
        for child in children: self.join(child)
        value = json.loads(self.path.read_text())
        self.assertEqual(value['n'], 80)
        self.assertEqual(value['unknown'], 'preserve')

    def test_waiter_reads_new_path_only_after_sidecar_release(self):
        started = self.ctx.Event()
        with Transaction(self.path) as tx:
            child = self.ctx.Process(target=increment, args=(self.path, 1, started)); child.start()
            self.assertTrue(started.wait(5))
            tx.value['n'] = 10; tx.commit(tx.value)
            self.assertIsNone(child.exitcode)
        self.join(child)
        self.assertEqual(json.loads(self.path.read_text())['n'], 11)

    def test_waiter_on_old_data_inode_can_read_stale_state(self):
        # Deterministic local counterexample: descriptor opened before replacement.
        with self.path.open('rb') as owner, self.path.open('rb') as waiter:
            fcntl.flock(owner, fcntl.LOCK_EX)
            with self.assertRaises(BlockingIOError):
                fcntl.flock(waiter, fcntl.LOCK_EX | fcntl.LOCK_NB)
            newer = self.path.with_suffix('.new'); newer.write_text('{"entries":{},"n":10}'); newer.replace(self.path)
            fcntl.flock(owner, fcntl.LOCK_UN)
            fcntl.flock(waiter, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(json.load(waiter)['n'], 0)
            self.assertEqual(json.loads(self.path.read_text())['n'], 10)

    def test_crash_before_and_after_replace_releases_lock_and_preserves_valid_document(self):
        for after, expected in ((False, 0), (True, 1)):
            with self.subTest(after=after):
                child = self.ctx.Process(target=crash, args=(self.path, after)); child.start(); self.join(child, 17)
                with Transaction(self.path) as tx: self.assertEqual(tx.value['n'], expected)
        # Pre-rename process death may leave an orphan; never auto-promote it.
        self.assertTrue(list(self.path.parent.glob('*.tmp')))

    def test_corrupt_documents_preserved_byte_for_byte(self):
        for raw in (b'{', b'{}', b'{"entries":{},"entries":{}}', b'{"entries":[],"n":0}', b'{"entries":{},"n":NaN}', b'{"entries":{},"n":1e400}', b'{"entries":{},"n":-1e400}', b'\xff'):
            with self.subTest(raw=raw):
                self.path.write_bytes(raw)
                with self.assertRaises(ManifestError):
                    with Transaction(self.path): self.fail('invalid accepted')
                self.assertEqual(self.path.read_bytes(), raw)

    def test_missing_document_not_initialized(self):
        self.path.unlink()
        with self.assertRaises(FileNotFoundError):
            with Transaction(self.path): pass
        self.assertFalse(self.path.exists())

    def test_pre_replace_fsync_failure_preserves_old_bytes(self):
        original = self.path.read_bytes()
        with Transaction(self.path) as tx:
            with patch('scripts.prototypes.manifest_transaction.os.fsync', side_effect=OSError('fixture')):
                with self.assertRaises(OSError): tx.commit({'entries': {}, 'n': 1})
            with self.assertRaises(ManifestError): tx.commit(tx.value)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertFalse(list(self.path.parent.glob('*.tmp')))

    def test_post_replace_fsync_failure_is_uncertain_without_retry(self):
        with Transaction(self.path) as tx:
            with patch('scripts.prototypes.manifest_transaction.os.fsync', side_effect=[None, OSError('fixture')]):
                with self.assertRaises(CommitUncertain): tx.commit({'entries': {}, 'n': 1})
            with self.assertRaises(ManifestError): tx.commit(tx.value)
        self.assertEqual(json.loads(self.path.read_text())['n'], 1)

    def test_no_implicit_commit_and_invalid_write_preserves_original(self):
        original = self.path.read_bytes()
        with Transaction(self.path) as tx: tx.value['n'] = 50
        self.assertEqual(self.path.read_bytes(), original)
        with Transaction(self.path) as tx:
            with self.assertRaises(ManifestError): tx.commit({})
        self.assertEqual(self.path.read_bytes(), original)

    def test_interrupt_after_replace_is_uncertain(self):
        real_replace = os.replace
        def interrupted(source, target):
            real_replace(source, target)
            raise KeyboardInterrupt('fixture')
        with Transaction(self.path) as tx:
            with patch('scripts.prototypes.manifest_transaction.os.replace', interrupted):
                with self.assertRaises(CommitUncertain): tx.commit({'entries': {}, 'n': 1})
        self.assertEqual(json.loads(self.path.read_text())['n'], 1)


if __name__ == '__main__': unittest.main()
