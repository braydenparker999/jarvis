"""Bounded scan and exact request attachment checks, no network."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
import json
import time
import os
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
from lib.mast_work_hook import MastWorkHook
from lib.mast_cli_transport import MastCliTransport, CONTRACT
from lib.project_hook import RemoteError


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

    def test_text_transport_refuses_attached_work_before_claim(self):
        job=str(uuid.uuid4())
        def request(method,path,payload):
            self.assertEqual(method,'GET','no claim or send may happen')
            if path=='work':
                return {'job':{'id':job,'destination':'mast','visibility':'private','stage':'queued','body':'Read attachment','cancelRequested':False}}
            return {'messages':[{'id':job,'role':'owner','destination':'mast','visibility':'private','body':'Read attachment','attachments':[{'id':str(uuid.uuid4())}]}],'nextCursor':None}
        request.binary_supported=False
        with tempfile.TemporaryDirectory() as directory:
            h=MastWorkHook(Path(directory)/'db',request,'synthetic')
            with self.assertRaisesRegex(ValueError,'qualified_binary_transport'): h.reserve(job)
            self.assertEqual(h.db.execute('SELECT COUNT(*) FROM operations').fetchone()[0],0)
            h.close()


class CliChecks(unittest.TestCase):
    def helper(self, directory, contract=None):
        filename = Path(directory)/'synthetic_helper.py'
        # Self-authored fixture only; never runs supplied Mast source or auth.
        source = "import sys,json,os,time\nCONTRACT="+repr(CONTRACT if contract is None else contract)+"\n"+r"""
assert sys.argv[1:3]==['--provider','mast'], 'must select Mast for every invocation'
sys.argv=sys.argv[:1]+sys.argv[3:]
if sys.argv[1]=='describe':
 print(json.dumps({**CONTRACT,'draft':'synthetic descriptive metadata'})); sys.exit(0)
path=sys.argv[2]
if 'slow' in path: time.sleep(10)
if 'redirect' in path:
 print('HTTP 302'); print('{}'); sys.exit(0)
if 'truncated' in path:
 print('HTTP 200'); print('{"private":'); sys.exit(0)
if 'mismatch' in path:
 print('HTTP 200'); print('{}'); sys.exit(1)
if 'denied' in path:
 print('HTTP 401'); print('{"error":"PRIVATE diagnostic"}'); sys.exit(1)
print('HTTP 200')
if sys.argv[1]=='post':
 print(json.dumps({'payload':json.load(open(sys.argv[3])), 'mode':os.stat(sys.argv[3]).st_mode & 511}))
else: print(json.dumps({'value':'x'*15000,'path':path}))
"""
        filename.write_text(source)
        filename.chmod(0o600)
        return filename, hashlib.sha256(filename.read_bytes()).hexdigest()

    def test_corrected_cli_json_private_payload_and_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            helper, digest = self.helper(directory)
            transport = MastCliTransport(helper,digest,directory,time.monotonic()+45)
            out=transport('GET','work',{'after':'0'})
            self.assertEqual(len(out['value']),15000)  # Old 12k truncation is not accepted.
            self.assertEqual(out['path'],'/relay/mast/work?after=0')
            payload={'body':'Synthetic UTF-8 🦉', 'id':str(uuid.uuid4())}
            out=transport('POST','reply',payload)
            self.assertEqual(out,{'payload':payload,'mode':0o600})
            self.assertEqual(list(Path(directory).glob('mast-payload-*')),[])
            for mode in ['truncated','mismatch']:
                with self.assertRaises(ValueError): transport('GET','work',{'after':mode})
            for mode in ['redirect','denied']:
                with self.assertRaises(RemoteError) as error: transport('GET','work',{'after':mode})
                self.assertNotIn('PRIVATE',str(error.exception))
            with self.assertRaises(ValueError): transport('GET','files/content',{})
            with self.assertRaises(ValueError): transport('POST','../../agents/messages',{})
            from unittest.mock import patch
            with patch('lib.mast_cli_transport.MAX_OUTPUT',1000):
                with self.assertRaises(ValueError): transport('GET','work',{})
            helper.write_text(helper.read_text()+'\n# changed bytes\n')
            with self.assertRaises(ValueError): transport('GET','work',{})

    def test_wrong_provider_and_timeout_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            helper,digest=self.helper(directory,{**CONTRACT,'credential_name':'custom.jarvis-lucy-muse-muse'})
            with self.assertRaises(ValueError): MastCliTransport(helper,digest,directory,time.monotonic()+45)
            helper,digest=self.helper(directory)
            transport=MastCliTransport(helper,digest,directory,time.monotonic()+45)
            transport.deadline=time.monotonic()+0.05
            with self.assertRaises(RemoteError): transport('GET','work',{'after':'slow'})


unittest.main()
