"""Bounded scan and exact request attachment checks, no network."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
from lib.mast_work_hook import MastWorkHook


class Checks(unittest.TestCase):
    def test_paginated_cyclic_scan_does_not_dispatch(self):
        calls = []
        def request(method, path, payload):
            self.assertEqual(method, 'GET')
            calls.append(payload['after'])
            page = int(payload['after'])
            return {'jobs': [{'id': str(uuid.uuid4()), 'destination': 'mast', 'visibility': 'private', 'stage': 'queued', 'cancelRequested': False}], 'nextCursor': str(page+1) if page < 41 else None}
        with tempfile.TemporaryDirectory() as directory:
            h = MastWorkHook(Path(directory)/'db', request, 'synthetic')
            self.assertFalse(h.scan()['scanComplete'])
            h.close()
            h = MastWorkHook(Path(directory)/'db', request, 'synthetic')
            self.assertTrue(h.scan()['scanComplete'])
            self.assertEqual(calls, [str(i) for i in range(42)])
            self.assertFalse(h.scan()['wake'])
            h.close()

    def test_files_are_exact_request_bound_and_byte_verified(self):
        job, attachment = str(uuid.uuid4()), str(uuid.uuid4())
        calls = []
        def request(method, path, payload):
            calls.append(payload)
            return b'synthetic file'
        with tempfile.TemporaryDirectory() as directory:
            h = MastWorkHook(Path(directory)/'db', request, 'synthetic')
            value = {'job': job, 'request': {'attachments': [{'id': attachment, 'messageId': job, 'sizeBytes': 14, 'sha256': hashlib.sha256(b'synthetic file').hexdigest()}]}}
            h.save(value)
            self.assertEqual(h.file(job, attachment), b'synthetic file')
            with self.assertRaises(ValueError): h.file(job, str(uuid.uuid4()))
            self.assertEqual(len(calls), 1)
            value['request']['attachments'][0]['sha256'] = '0'*64
            h.save(value)
            with self.assertRaises(ValueError): h.file(job, attachment)
            h.close()
            with self.assertRaises(ValueError): MastWorkHook(Path(directory)/'db', request, 'other-destination')


unittest.main()
