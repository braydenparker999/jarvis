"""Authored writer tests: temporary manifests only, no supplied module execution."""
import json
from pathlib import Path
import tempfile
import unittest
from scripts.prototypes import upload_checkpoints as cp
from scripts.prototypes.manifest_transaction import Transaction
from scripts.staging import mast_runtime as mast
from scripts.staging.build_mast_package import writer_shape

class WriterIntegration(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.path=self.root/'queue-manifest.json'
        self.job=cp.sha(b'existing')
        self.entry={'sha256':self.job,'size':8,'path':'original.opus','status':'held',
                    'generation':'g1','claimed_by':'W1','attempt':'a1','attempts':2,
                    'checkpoint':'retained-journal','metadata':{'title':'First'}}
        self.value={'version':2,'entries':{self.job:self.entry},
                    'upload_hold':{'job':self.job,'generation':'g1','attempt':'a1'},'unknown':'preserve'}
        self.path.write_bytes(cp.encode(self.value))

    def read(self):return json.loads(self.path.read_bytes())
    def candidate(self,body,status='pending'):
        job=cp.sha(body)
        return job,{'sha256':job,'size':len(body),'path':'new.opus','status':status,'attempts':0}

    def test_scan_preserves_concurrent_claim_append_hold_and_first_wins(self):
        new,entry=self.candidate(b'new');historical,report=self.candidate(b'previous-upload','registered')
        stale={'version':2,'built':'scan-start','entries':{self.job:{**self.entry,'status':'pending','generation':'old'},
                new:entry,historical:{**report,'r2_id':'historical-id','generation':'forged'}},'stats':{'report_files':1}}
        appended,extra=self.candidate(b'concurrent-append')
        def add(m):m['entries'][appended]=extra;return m
        mast.append_only(self.path,add,lambda m:m)
        with Transaction(self.path) as tx:
            tx.value['entries'][self.job]['claimed_at']=123;tx.commit(tx.value)
        before=self.read()
        mast.reconcile_scan(self.path,stale,lambda m:m)
        actual=self.read()
        self.assertEqual(actual['entries'][self.job],before['entries'][self.job])
        self.assertEqual(actual['entries'][appended],extra)
        self.assertEqual(actual['upload_hold'],before['upload_hold'])
        self.assertEqual(actual['unknown'],'preserve')
        self.assertEqual(actual['entries'][new]['status'],'pending')
        imported=actual['entries'][historical]
        self.assertEqual(imported['status'],'held_import_review')
        self.assertNotIn('generation',imported)
        self.assertEqual(imported['r2_id'],'historical-id')

    def test_duplicate_append_preserves_existing_fence(self):
        before=self.read()['entries'][self.job]
        def duplicate(m):
            m['_append_outcome']={'appended':False,'reason':'already in manifest'}
            return m
        mast.append_only(self.path,duplicate,lambda m:m)
        self.assertEqual(self.read()['entries'][self.job],before)
        with self.assertRaises(mast.boundary.BoundaryError):
            mast.append_only(self.path,lambda m:{**m,'entries':{}},lambda m:m)

    def test_drain_blocks_both_writer_commits_and_bad_scan_is_atomic(self):
        new,entry=self.candidate(b'new')
        candidate={'entries':{new:entry},'stats':{}}
        original=self.path.read_bytes();(self.root/'DRAIN').touch()
        with self.assertRaises(mast.boundary.BoundaryError):
            mast.reconcile_scan(self.path,candidate,lambda m:m)
        with self.assertRaises(mast.boundary.BoundaryError):
            mast.append_only(self.path,lambda m:m,lambda m:m)
        self.assertEqual(self.path.read_bytes(),original)
        (self.root/'DRAIN').unlink()
        candidate['entries']['invalid']={'status':'pending'}
        with self.assertRaises(mast.boundary.BoundaryError):
            mast.reconcile_scan(self.path,candidate,lambda m:m)
        self.assertEqual(self.path.read_bytes(),original)

    def test_configuration_binding_and_late_drain(self):
        mast.check_writer_binding(self.path,self.root/'queue-manifest.json')
        with self.assertRaises(mast.boundary.BoundaryError):
            mast.check_writer_binding(self.path,self.root/'different.json')
        original=self.path.read_bytes()
        def create_drain_during_mutation(m):
            (self.root/'DRAIN').touch()
            m['late']='must not commit'
            return m
        with self.assertRaises(mast.boundary.BoundaryError):
            mast.append_only(self.path,create_drain_during_mutation,lambda m:m)
        self.assertEqual(self.path.read_bytes(),original)
        (self.root/'DRAIN').unlink()
        mast.request_drain(self.path)
        self.assertTrue((self.root/'DRAIN').exists())
        self.assertEqual(self.path.read_bytes(),original)

    def test_redaction_equivalence_excludes_only_declared_configuration(self):
        source='WS="[WS]"\nKEY="[KEY_PATH]"\nREPORT_DIRS={"...":"[REPORT_DIR]"}\ndef main():\n    return 1\n'
        restored='WS="private-root"\nKEY="private-key-path"\nREPORT_DIRS={"a":"one","b":"two"}\ndef main():\n    return 1\n'
        self.assertEqual(writer_shape(source),writer_shape(restored))
        self.assertNotEqual(writer_shape(source),writer_shape(restored.replace('return 1','return 2')))

if __name__=='__main__':unittest.main()
