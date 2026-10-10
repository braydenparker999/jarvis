"""Offline admission and scheduling fixtures; no provider, FFmpeg or HTTP calls."""
import dataclasses
import hashlib
import importlib.util
from pathlib import Path
import sys
import threading
import unittest

spec = importlib.util.spec_from_file_location('preparation_ahead', Path(__file__).resolve().parents[1] / 'scripts/prototypes/preparation_ahead.py')
prep = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = prep
spec.loader.exec_module(prep)
AUDIO = b'OggSOpusHead fixture'
SHA = hashlib.sha256(AUDIO).hexdigest()
CTX = prep.Context('job1', 'revision1', 'recipe1', 'https://fixture.invalid')


def ready(pool, context=CTX, audio=AUDIO, cover=None):
    token = pool.reserve(context)
    assert token is not None
    pool.prepare(token, lambda limit: audio, lambda data: (b'{"title":"Fixture"}', cover, 'jpg'))
    return token


class PreparationTests(unittest.TestCase):
    def test_only_one_next_and_two_global_artifacts_for_three_producers(self):
        pool = prep.Pool()
        ready(pool)
        first, result = pool.take(CTX, SHA)
        barrier = threading.Barrier(4)
        admitted = []
        def producer():
            barrier.wait()
            token = pool.reserve(CTX)
            if token is not None:
                admitted.append(token)
                pool.prepare(token, lambda limit: AUDIO, lambda b: (b'{}', None, None))
        workers = [threading.Thread(target=producer) for _ in range(3)]
        for worker in workers: worker.start()
        barrier.wait()
        for worker in workers: worker.join(2); self.assertFalse(worker.is_alive())
        self.assertEqual(len(admitted), 1)
        self.assertEqual((pool.usage()['active'], pool.usage()['next']), (1, 1))
        self.assertLessEqual(pool.usage()['reserved_byte_ceiling'], 2 * prep.ARTIFACT_LIMIT)
        self.assertIsNone(pool.take(CTX, SHA))
        pool.release(first)
        self.assertIsNotNone(pool.take(CTX, SHA))

    def test_immutable_same_buffer_and_empty_cover_guard(self):
        pool = prep.Pool(); seen = []
        token = pool.reserve(CTX)
        pool.prepare(token, lambda limit: AUDIO, lambda data: (seen.append(data) or b'{}', b'', 'jpg'))
        lease, item = pool.take(CTX, SHA)
        self.assertIs(item.audio, AUDIO); self.assertIs(seen[0], AUDIO)
        self.assertEqual(item.sha256, SHA)
        self.assertIsNone(item.cover); self.assertIsNone(item.cover_ext)
        with self.assertRaises(dataclasses.FrozenInstanceError): item.audio = b'changed'
        pool.release(lease)

    def test_changed_revision_recipe_destination_job_or_source_invalidates(self):
        for context, digest in [(dataclasses.replace(CTX, revision='2'), SHA),
                                (dataclasses.replace(CTX, recipe='2'), SHA),
                                (dataclasses.replace(CTX, destination='https://other.invalid'), SHA),
                                (dataclasses.replace(CTX, job='other'), SHA), (CTX, '0' * 64)]:
            pool = prep.Pool(); ready(pool)
            self.assertIsNone(pool.take(context, digest))
            self.assertEqual(pool.usage()['next'], 0)

    def test_ttl_covers_preparation_time_and_waiting_time(self):
        now = [0]; pool = prep.Pool(ttl=10, clock=lambda: now[0])
        token = pool.reserve(CTX)
        now[0] = 10
        self.assertFalse(pool.prepare(token, lambda limit: AUDIO, lambda b: (b'{}', None, None)))
        ready(pool); now[0] = 20
        self.assertIsNone(pool.take(CTX, SHA))

    def test_cancelled_running_preparation_retains_slot_until_exit(self):
        pool = prep.Pool(); entered = threading.Event(); finish = threading.Event(); outcome = []
        token = pool.reserve(CTX)
        def read(limit):
            entered.set(); finish.wait(3); return AUDIO
        worker = threading.Thread(target=lambda: outcome.append(pool.prepare(token, read, lambda b: (b'{}', None, None))))
        worker.start(); self.assertTrue(entered.wait(2))
        try:
            pool.cancel_next()
            self.assertIsNone(pool.reserve(CTX))
            self.assertEqual(pool.usage()['next'], 1)
        finally:
            finish.set(); worker.join(2)
        self.assertFalse(worker.is_alive()); self.assertEqual(outcome, [False])
        self.assertIsNotNone(pool.reserve(CTX))

    def test_cancelled_old_token_cannot_publish_into_replacement(self):
        pool = prep.Pool(); old = pool.reserve(CTX); pool.cancel_next(); new = pool.reserve(CTX)
        with self.assertRaises(prep.QueueError):
            pool.prepare(old, lambda limit: self.fail('stale token read'), lambda b: None)
        self.assertTrue(pool.prepare(new, lambda limit: AUDIO, lambda b: (b'{}', None, None)))

    def test_failures_and_interruptions_release_preparation_reservation(self):
        for error in [RuntimeError('fixture'), KeyboardInterrupt()]:
            pool = prep.Pool(); token = pool.reserve(CTX)
            def extract(data): raise error
            with self.assertRaises(type(error)):
                pool.prepare(token, lambda limit: AUDIO, extract)
            self.assertEqual(pool.usage()['next'], 0)
            self.assertIsNotNone(pool.reserve(CTX))

    def test_size_bounds_are_checked_before_extract_and_publish(self):
        pool = prep.Pool(); token = pool.reserve(CTX)
        seen = []
        with self.assertRaises(prep.QueueError):
            pool.prepare(token, lambda limit: (seen.append(limit) or b'a' * limit), lambda b: self.fail('must not extract oversize'))
        self.assertEqual(seen, [prep.AUDIO_LIMIT + 1])
        for audio, metadata, cover, ext in [(bytearray(AUDIO), b'{}', None, None),
                                           (AUDIO, bytearray(b'{}'), None, None),
                                           (AUDIO, b'{}', bytearray(b'x'), 'jpg'),
                                           (AUDIO, b'x' * (prep.METADATA_LIMIT + 1), None, None),
                                           (AUDIO, b'{}', b'x' * (prep.COVER_LIMIT + 1), 'jpg'),
                                           (AUDIO, b'{}', b'x', 'gif')]:
            with self.assertRaises(prep.QueueError):
                prep.artifact(CTX, audio, metadata, cover, ext, now=0)

    def test_close_keeps_active_lease_and_blocks_new_admission(self):
        pool = prep.Pool(); ready(pool); lease, item = pool.take(CTX, SHA); ready(pool)
        pool.close()
        self.assertEqual(pool.usage()['active'], 1); self.assertEqual(pool.usage()['next'], 0)
        self.assertIsNone(pool.reserve(CTX)); self.assertIsNone(pool.take(CTX, SHA))
        with self.assertRaises(prep.QueueError): pool.release(object())
        pool.release(lease)
        self.assertEqual(pool.usage()['retained_bytes'], 0)
        with self.assertRaises(prep.QueueError): pool.release(lease)

    def test_duplicate_preparation_for_same_token_is_refused(self):
        pool = prep.Pool(); token = ready(pool)
        with self.assertRaises(prep.QueueError):
            pool.prepare(token, lambda limit: self.fail('duplicate preparation'), lambda b: None)

    def test_preparation_cannot_start_without_admission(self):
        pool = prep.Pool()
        with self.assertRaises(prep.QueueError):
            pool.prepare(object(), lambda limit: self.fail('unreserved read'), lambda b: None)

    def test_retained_failure_traceback_does_not_keep_abandoned_payloads(self):
        pool = prep.Pool(); ready(pool); lease, active = pool.take(CTX, SHA)
        token = pool.reserve(CTX)
        # read callback allocates its result locally, without an external owner.
        retained = None
        try:
            pool.prepare(token, lambda limit: b'failed-media-' * 4096,
                         lambda data: (b'{}', b'cover', b'extension-payload' * 1024))
        except prep.QueueError as error:
            retained = error
        self.assertIsNotNone(retained)
        self.assertIsNone(retained.__context__)
        frame = retained.__traceback__
        while frame:
            if frame.tb_frame.f_code.co_filename == str(Path(prep.__file__)):
                values = frame.tb_frame.f_locals
                for name in ['audio', 'metadata', 'cover', 'ext', 'result']:
                    self.assertIsNone(values.get(name))
            frame = frame.tb_next
        ready(pool)
        self.assertEqual((pool.usage()['active'], pool.usage()['next']), (1, 1))
        pool.release(lease)

    def test_artifact_budget_exact_upper_bound(self):
        item = prep.artifact(CTX, b'a' * prep.AUDIO_LIMIT, b'm' * prep.METADATA_LIMIT,
                             b'c' * prep.COVER_LIMIT, 'png', now=0)
        self.assertEqual(item.size, prep.ARTIFACT_LIMIT)
        self.assertEqual(2 * item.size, 71335936)


class ScheduleTests(unittest.TestCase):
    def test_synthetic_schedule_preserves_provider_times_one_next_and_network_serialization(self):
        spec = importlib.util.spec_from_file_location('preparation_model', Path(__file__).resolve().parents[1] / 'scripts/prototypes/preparation_model.py')
        model = importlib.util.module_from_spec(spec); spec.loader.exec_module(model)
        for preparation, upload, interval in [(10, 20, 0), (20, 10, 0), (.2, 20, 40)]:
            baseline = model.schedule(10, preparation, upload, interval)
            ahead = model.schedule(10, preparation, upload, interval, ahead=True)
            self.assertEqual([r['provider_ready'] for r in baseline], [r['provider_ready'] for r in ahead])
            for previous, current in zip(ahead, ahead[1:]):
                self.assertGreaterEqual(current['upload_start'], previous['upload_end'])
                self.assertGreaterEqual(current['prepare_start'], previous['upload_start'])
            events = [(r['prepare_start'], 1) for r in ahead] + [(r['upload_end'], -1) for r in ahead]
            retained = 0
            for _, change in sorted(events):
                retained += change
                self.assertLessEqual(retained, 2)
        cases = {r['scenario']: r for r in model.scenarios()}
        self.assertEqual(cases['large_preparation']['synthetic_saved_seconds'], 90)
        self.assertEqual(cases['provider_pacing_dominates']['synthetic_saved_seconds'], 0)
        self.assertLess(cases['overhead_can_erase_gain']['synthetic_saved_seconds'], 0)


if __name__ == '__main__': unittest.main()
