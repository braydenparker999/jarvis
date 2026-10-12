"""One focused matrix through staged process/upload call sites, fake I/O only.

Supplied modules are AST-inspected by the builder, never executed here.
"""
import ast
import json
from pathlib import Path
import random
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from scripts.staging import mast_runtime as mast
from scripts.prototypes import upload_checkpoints as cp
from scripts.prototypes.manifest_transaction import Transaction
from scripts.prototypes import worker_boundary as wb

CHILD=Path(__file__).parent/'fixtures/mast_staging_child.py'
AUDIO=b'OggS authored fixture only'

class StagingCallSites(unittest.TestCase):
    def fixture(self,root,mode):
        source=root/'fixture.opus';source.write_bytes(AUDIO);(root/'mode').write_text(mode)
        manifest=root/'queue-manifest.json'
        manifest.write_bytes(cp.encode({'entries':{cp.sha(AUDIO):{'path':str(source),'sha256':cp.sha(AUDIO),
            'size':len(AUDIO),'status':'pending','attempts':0}}}))
        (root/'token').touch()
        return SimpleNamespace(R2DIR=str(root),WS=str(root),MANIFEST=str(manifest),WID='W1',
             SCOPE_ORDER=[],MAX_ATTEMPTS=5,STOP=str(root/'STOP'),AUTH_STOP=str(root/'AUTH-STOP'),
             TOKEN=str(root/'token'),SCRIPT=str(CHILD),KEY='unused-fixture-key',sys=sys,random=random,
             ORIGIN='https://fixture.invalid',_recompute_stats=lambda m:m,
             pacing_note_completion=lambda:None,pacing_note_temp=lambda msg:None,
             report_path_for=lambda e:str(root/'published-report.json'))

    def test_real_staging_call_site_matrix(self):
        real_run=mast.run
        for mode in ('normal','empty-cover','analysis','conflict','auth','ambiguous','interrupt','malformed','stale','changed-bytes','decode-failed','report-failure','corrupt-journal'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as d:
                root=Path(d);host=self.fixture(root,mode)
                job,entry=mast.claim_next(host)
                if mode=='report-failure':
                    host.report_path_for=lambda e: str(root/'missing-parent'/'report.json')
                def runner(argv,**options):
                    if argv[0]=='ffmpeg': return (1,0) if mode=='decode-failed' else (0,0)
                    return real_run(argv,**options)
                with patch.object(mast,'run',runner),patch.object(mast,'retry_delay',return_value=0):
                    if mode in ('normal','empty-cover','analysis','conflict','decode-failed'):
                        outcome=mast.process(host,job,entry)
                        self.assertEqual(outcome,'held' if mode=='decode-failed' else 'registered')
                    else:
                        with self.assertRaises((wb.BoundaryError,RuntimeError,OSError)):
                            mast.process(host,job,entry)
                state=json.loads(Path(host.MANIFEST).read_bytes());current=state['entries'][job]
                calls=(root/'calls').read_text().splitlines() if (root/'calls').exists() else []
                success=mode in ('normal','empty-cover','analysis','conflict')
                self.assertEqual('upload_hold' not in state,success)
                self.assertEqual(current['status']=='registered',success)
                if mode=='conflict':
                    self.assertEqual(sum('/audio/' in c for c in calls),1)
                    self.assertEqual(sum('/art/' in c for c in calls),1)
                    self.assertEqual(sum(c.endswith('/register') for c in calls),2)
                    self.assertEqual(current['attempts'],2)
                if mode=='empty-cover': self.assertFalse(any('/art/' in c for c in calls))
                if mode=='analysis': self.assertTrue(calls[-1].endswith('/analysis'))
                if mode=='auth': self.assertTrue(Path(host.AUTH_STOP).exists())
                if success:
                    self.assertEqual(json.loads((root/'published-report.json').read_bytes())['audioSha256'],job)
                    self.assertFalse(Path(current['prepared_directory']).exists())
                else:
                    self.assertTrue(Path(current['prepared_directory']).exists())
                    with self.assertRaises((wb.BoundaryError,FileExistsError)):
                        # Same claimed job cannot be silently recreated after failure.
                        mast.process(host,job,entry)
                self.assertEqual((root/'fixture.opus').read_bytes(),AUDIO)
        print('13 rows: exact transport sequence, receipt reuse, holds, auth, interruption, stale generation, immutable decode and cleanup')

    def test_admission_writers_and_drain(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);host=self.fixture(root,'normal');job,entry=mast.claim_next(host)
            (root/'qualification.json').write_text('{"activation":"blocked"}')
            with self.assertRaises(wb.BoundaryError): mast.require_qualification(root)
            with Transaction(host.MANIFEST) as tx:
                tx.value['entries'][job]['claimed_at']=0;tx.commit(tx.value)
            self.assertEqual(mast.claim_next(host),(None,None)) # No time-based takeover.
            with self.assertRaises(wb.BoundaryError):
                mast.append_only(host.MANIFEST,lambda m:{**m,'entries':{}},lambda m:m)
            other=cp.sha(b'other')
            def append(m):m['entries'][other]={'status':'pending','sha256':other,'size':5};return m
            mast.append_only(host.MANIFEST,append,lambda m:m)
            value=wb.Claim(job,entry['generation'],job,len(AUDIO))
            mast.heartbeat(host,value)
            self.assertIn(other,json.loads(Path(host.MANIFEST).read_bytes())['entries'])
            with self.assertRaises(wb.BoundaryError):mast.launch_ready(host.MANIFEST,[])
            (root/'DRAIN').touch()
            with self.assertRaises(wb.BoundaryError):mast.claim_next(host)
            class Alive:
                def poll(self):return None
                def terminate(self):raise AssertionError('Must never terminate to manufacture drain')
            self.assertFalse(mast.drain_workers({'W1':Alive()},lambda m:None,timeout=0))
            class Done:
                def poll(self):return 0
            self.assertTrue(mast.drain_workers({'W1':Done()},lambda m:None,timeout=0))

if __name__=='__main__':unittest.main()
