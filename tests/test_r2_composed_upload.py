"""Deterministic four-component composition; local fake child, no HTTP/provider."""
from dataclasses import asdict, replace
import json
import fcntl
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import weakref

from scripts.prototypes import preparation_ahead as prep
from scripts.prototypes import worker_boundary as worker
from scripts.prototypes.composed_upload import run_prepared
from scripts.prototypes.upload_checkpoints import sha

DEST = 'https://fixture.invalid'
AUDIO = b'OggS immutable prepared fixture'
COVER = b'PNG synthetic'
CHILD = Path(__file__).parent/'fixtures/offline_worker_child.py'


class ComposedUpload(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.manifest = self.root/'manifest.json'
        self.manifest.write_text(json.dumps({'entries': {job: {'status': 'pending', 'sha256': sha(AUDIO), 'size': len(AUDIO)} for job in ('one', 'two')}}))
        self.first = worker.claim(self.manifest, 'one'); self.second = worker.claim(self.manifest, 'two')
        self.pool = prep.Pool()
        self.context = prep.Context('one', self.first.generation, 'recipe1', DEST)
        self.next_context = prep.Context('two', self.second.generation, 'recipe1', DEST)
        self.metadata = b'{"title":"Prepared title","artist":"Prepared artist","audioAnalysis":{"version":2}}'
        self.reads = []

    def prepare(self, context, cover=COVER, metadata=None):
        reservation = self.pool.reserve(context)
        self.assertIsNotNone(reservation)
        def read(limit): self.reads.append(context.job); return AUDIO
        self.assertTrue(self.pool.prepare(reservation, read, lambda audio: (metadata or self.metadata, cover, 'png')))

    def command(self, mode='analysis', gate=None):
        def build(report, attempt, value, audio, prepared):
            if gate: gate()
            return [sys.executable, str(CHILD), str(self.manifest), str(report), attempt, json.dumps(asdict(value)),
                    str(audio), str(self.root/'STOP'), str(self.root/'calls'), mode, str(prepared)]
        return build

    def run_one(self, claim=None, context=None, command=None, **kwargs):
        return run_prepared(self.pool, context or self.context, self.manifest, claim or self.first,
                  self.root/'token', [self.root/'STOP'], command or self.command(),
                  lambda path: [sys.executable, '-c', 'pass'], destination=DEST, recipe='recipe1', **kwargs)

    def test_all_four_components_with_one_next_track_and_exact_prepared_payload(self):
        self.prepare(self.context)
        barrier = self.root/'barrier'; outcomes = []
        def command(*args): return self.command()(*args)+[str(barrier)]
        def consume():
            try: outcomes.append(self.run_one(command=command))
            except BaseException as error: outcomes.append(error)
        consumer = threading.Thread(target=consume); consumer.start()
        deadline = time.monotonic()+3
        while not barrier.with_suffix('.ready').exists() and time.monotonic()<deadline:
            time.sleep(0.005)
        self.assertTrue(barrier.with_suffix('.ready').exists())
        # First synthetic PUT is now blocked in the child callback under token.
        self.prepare(self.next_context, cover=b'')
        self.assertEqual((self.pool.usage()['active'], self.pool.usage()['next']), (1, 1))
        self.assertIsNone(self.pool.reserve(self.next_context))
        barrier.with_suffix('.release').touch(); consumer.join(5); self.assertFalse(consumer.is_alive())
        self.assertEqual(outcomes, ['completed'])
        self.assertEqual(self.pool.usage()['active'], 0)
        self.assertEqual(self.run_one(self.second, self.next_context), 'completed')
        state = json.loads(self.manifest.read_text())
        self.assertNotIn('upload_hold', state)
        self.assertEqual(self.reads, ['one', 'two'])
        for job in ('one', 'two'):
            entry = state['entries'][job]; self.assertEqual(entry['status'], 'completed')
            directory = Path(entry['attempt_directory'])
            registration = json.loads((directory/'report.json.registration').read_bytes())
            self.assertEqual(registration['metadata'], json.loads(self.metadata))
            self.assertEqual((directory/'audio.opus').read_bytes(), AUDIO)
            self.assertEqual((directory/'prepared-metadata.json').read_bytes(), self.metadata)
            journal = json.loads((directory/'report.json.journal').read_text())['state']
            self.assertEqual(journal['pending']['phase'], 'analysis_acknowledged_completion_pending')
            self.assertEqual(set(journal['blobs']), {'audio','art'} if job=='one' else {'audio'})
        calls = (self.root/'calls').read_text().splitlines()
        self.assertEqual(sum('/art/' in call for call in calls), 1)
        self.assertEqual(self.pool.usage()['retained_bytes'], 0)

    def test_stale_recipe_or_generation_never_sends(self):
        self.prepare(self.context)
        with self.assertRaises(worker.BoundaryError): self.run_one(context=replace(self.context, recipe='changed'))
        self.assertFalse((self.root/'calls').exists())
        self.assertEqual(json.loads(self.manifest.read_text())['entries']['one']['status'], 'claimed')

    def test_wrong_prepared_source_is_discarded_before_admission(self):
        reservation = self.pool.reserve(self.context)
        self.pool.prepare(reservation, lambda limit:b'changed', lambda audio:(self.metadata,None,None))
        with self.assertRaises(worker.BoundaryError): self.run_one()
        self.assertFalse((self.root/'calls').exists()); self.assertEqual(self.pool.usage()['active'],0)

    def test_ambiguous_child_closes_next_slot_and_retains_active(self):
        self.prepare(self.context)
        def gate(): self.prepare(self.next_context)
        with self.assertRaises(worker.BoundaryError): self.run_one(command=self.command('timeout', gate=gate), timeout=0.15)
        self.assertEqual((self.pool.usage()['active'], self.pool.usage()['next']), (1,0))
        state = json.loads(self.manifest.read_text()); self.assertIsNotNone(state['upload_hold'])
        with self.assertRaises(worker.BoundaryError): self.run_one(self.second, self.next_context)
        self.assertFalse((self.root/'calls').exists())

    def test_duplicate_without_analysis_and_empty_cover_skips_both(self):
        self.prepare(self.context, cover=b'', metadata=b'{"title":"No analysis"}')
        self.assertEqual(self.run_one(), 'completed')
        calls = (self.root/'calls').read_text().splitlines()
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0].endswith('.opus')); self.assertTrue(calls[1].endswith('/register'))

    def test_success_drops_consumer_artifact_before_releasing_pool_slot(self):
        class InspectPool(prep.Pool):
            def take(self, *args):
                taken = super().take(*args)
                if taken: self.reference = weakref.ref(taken[1])
                return taken
            def release(self, lease):
                super().release(lease)
                self.payload_still_alive = self.reference() is not None
        self.pool = InspectPool()
        self.prepare(self.context)
        self.assertEqual(self.run_one(), 'completed')
        self.assertFalse(self.pool.payload_still_alive)

    def test_invalid_prepared_metadata_makes_no_request_or_durable_attempt(self):
        self.prepare(self.context, metadata=b'{"title":1,"title":2}')
        before = self.manifest.read_bytes()
        with self.assertRaises(worker.BoundaryError): self.run_one()
        self.assertEqual(self.manifest.read_bytes(), before)
        self.assertFalse((self.root/'calls').exists())
        self.assertEqual(self.pool.usage()['active'], 1)

    def test_active_lease_released_before_token_handoff_to_second_consumer(self):
        entering_release = threading.Event(); continue_release = threading.Event()
        class HandoffPool(prep.Pool):
            first = True
            def release(self, lease):
                if self.first:
                    self.first = False; entering_release.set()
                    if not continue_release.wait(3): raise RuntimeError('fixture release barrier')
                super().release(lease)
        self.pool = HandoffPool(); self.prepare(self.context); outcomes = []
        def consume(claim, context):
            try: outcomes.append(self.run_one(claim, context))
            except BaseException as error: outcomes.append(error)
        first = threading.Thread(target=consume, args=(self.first,self.context)); first.start()
        self.assertTrue(entering_release.wait(3)); self.prepare(self.next_context)
        with (self.root/'token').open('a+b') as token:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(token, fcntl.LOCK_EX|fcntl.LOCK_NB)
        second = threading.Thread(target=consume,args=(self.second,self.next_context)); second.start()
        continue_release.set(); first.join(5); second.join(5)
        self.assertFalse(first.is_alive()); self.assertFalse(second.is_alive())
        self.assertEqual(outcomes, ['completed','completed'])
        self.assertEqual((self.pool.usage()['active'],self.pool.usage()['next']), (0,0))

    def test_child_rejects_changed_prepared_destination_before_any_put(self):
        self.prepare(self.context)
        def changed(report, attempt, claim, audio, prepared):
            payload = json.loads(prepared.read_bytes())
            payload['context']['destination'] = 'https://wrong.invalid'
            prepared.write_text(json.dumps(payload))
            return self.command()(report,attempt,claim,audio,prepared)
        with self.assertRaises(worker.BoundaryError): self.run_one(command=changed)
        self.assertFalse((self.root/'calls').exists())
        self.assertEqual(json.loads(self.manifest.read_text())['entries']['one']['status'], 'held')


if __name__ == '__main__': unittest.main()
