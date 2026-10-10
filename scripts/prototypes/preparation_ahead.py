"""Local-only, in-memory preparation admission prototype; no workers or HTTP.

Exactly ONE coordinator must own this pool for the whole uploader. Three pools
in three worker processes would NOT implement the global bound. Producers must
reserve before reading/preparing. A reservation occupies the one next-track slot.
"""
from dataclasses import dataclass
import hashlib
import threading
import time

AUDIO_LIMIT = 32 * 1024 * 1024
COVER_LIMIT = 2 * 1024 * 1024
METADATA_LIMIT = 16 * 1024
ARTIFACT_LIMIT = AUDIO_LIMIT + COVER_LIMIT + METADATA_LIMIT


class QueueError(RuntimeError):
    pass


@dataclass(frozen=True)
class Context:
    job: str
    revision: str
    recipe: str
    destination: str


@dataclass(frozen=True)
class Artifact:
    context: Context
    audio: bytes
    metadata: bytes
    cover: bytes | None
    cover_ext: str | None
    sha256: str
    created: float

    @property
    def size(self):
        return len(self.audio) + len(self.metadata) + len(self.cover or b'')


def artifact(context, audio, metadata, cover=None, cover_ext=None, *, now):
    # No copying from mutable buffers: the producer must supply immutable output.
    if type(audio) is not bytes or not 0 < len(audio) <= AUDIO_LIMIT:
        raise QueueError('Require bounded immutable audio')
    if type(metadata) is not bytes or not 0 < len(metadata) <= METADATA_LIMIT:
        raise QueueError('Require bounded immutable metadata serialization')
    if cover is not None and type(cover) is not bytes:
        raise QueueError('Require immutable cover bytes')
    if cover == b'':
        cover = None
    if cover is None:
        cover_ext = None
    elif len(cover) > COVER_LIMIT or cover_ext not in ('jpg', 'png'):
        raise QueueError('Invalid cover size or format')
    return Artifact(context, audio, metadata, cover, cover_ext,
                    hashlib.sha256(audio).hexdigest(), now)


class Pool:
    """One active lease + one next reservation/artifact, globally by ownership.

    Nonblocking admission: caller keeps existing pacing when no slot is free.
    No provider fetch, network request, retries or signatures are performed here.
    Lease tokens are opaque identities, never job IDs; late producers cannot
    publish into a replacement reservation after cancellation.
    """
    def __init__(self, *, ttl=300, clock=time.monotonic):
        if not 0 < ttl <= 3600:
            raise ValueError('Require finite bounded TTL')
        self._clock, self._ttl = clock, ttl
        self._lock = threading.Lock()
        self._next = None
        self._active = None
        self._closed = False

    def reserve(self, context):
        if type(context) is not Context or any(type(v) is not str or not v or len(v) > 512
                                              for v in (context.job, context.revision, context.recipe, context.destination)):
            raise QueueError('Require bounded current job and preparation identity')
        with self._lock:
            if self._closed or self._next is not None:
                return None
            token = object()
            self._next = (token, context, self._clock(), None)
            return token

    def prepare(self, token, read_local, extract):
        """Callbacks must be pure bounded LOCAL work, never provider downloads.

        read_local(limit) must return <=limit bytes from an already downloaded
        source snapshot; extract receives that exact immutable bytes object and
        returns serialized metadata, optional cover bytes and extension. Optional
        FFmpeg needs separate reviewed resource limits; it is not invoked here.
        """
        with self._lock:
            if self._next is None or self._next[0] is not token or self._next[3] is not None:
                raise QueueError('Reservation unavailable')
            _, context, started, _ = self._next
            # Mark preparation started so the same reservation cannot run twice.
            self._next = (token, context, started, 'preparing')
        audio = metadata = cover = ext = result = None
        failed = interrupted = False
        try:
            audio = read_local(AUDIO_LIMIT + 1)
            if type(audio) is not bytes or not 0 < len(audio) <= AUDIO_LIMIT:
                raise QueueError('Local snapshot exceeds audio bound or is mutable')
            metadata, cover, ext = extract(audio)
            result = artifact(context, audio, metadata, cover, ext, now=started)
        except BaseException as error:
            # Never propagate a traceback that retains failed media buffers.
            # Raise a sanitized error AFTER leaving this except/context.
            failed = True
            interrupted = isinstance(error, (KeyboardInterrupt, SystemExit))
        if failed:
            audio = metadata = cover = ext = result = None
            with self._lock:
                if self._next is not None and self._next[0] is token:
                    self._next = None
            if interrupted:
                raise KeyboardInterrupt('Preparation interrupted')
            raise QueueError('Local preparation failed')
        with self._lock:
            if self._next is None or self._next[0] is not token:
                audio = metadata = cover = ext = result = None
                raise QueueError('Reservation unavailable')
            if self._closed or self._next[3] == 'cancelled' or self._clock() - started >= self._ttl:
                # Drop payload references BEFORE admitting another producer.
                audio = metadata = cover = ext = result = None
                self._next = None
                return False
            self._next = (token, context, started, result)
            return True

    def cancel_next(self):
        with self._lock:
            if self._next is not None:
                if self._next[3] in ('preparing', 'cancelled'):
                    self._next = (*self._next[:3], 'cancelled')
                else:
                    self._next = None

    def take(self, context, source_sha256):
        """Consumer must revalidate revision/recipe/destination AND local source
        hash before taking, under its existing job ownership/global upload token.
        No signature is cached. Stale results are discarded, not silently reused.
        """
        with self._lock:
            if self._closed or self._active is not None or self._next is None:
                return None
            token, expected, started, result = self._next
            if type(result) is not Artifact:
                return None
            if expected != context or result.sha256 != source_sha256 or self._clock() - started >= self._ttl:
                result = None
                self._next = None
                return None
            self._next = None
            self._active = (token, result)
            return token, result

    def release(self, token):
        # Release only AFTER transport/whole-chain completion or acknowledged
        # local termination. Timeout is not permission to start another chain.
        with self._lock:
            if self._active is None or self._active[0] is not token:
                raise QueueError('Active lease mismatch')
            self._active = None

    def close(self):
        with self._lock:
            self._closed = True
            if self._next is not None:
                if self._next[3] in ('preparing', 'cancelled'):
                    self._next = (*self._next[:3], 'cancelled')
                else:
                    self._next = None
            # Active bytes remain leased until the consumer releases them.

    def usage(self):
        with self._lock:
            ready = self._next[3] if self._next else None
            return {'active': int(self._active is not None), 'next': int(self._next is not None),
                    'retained_bytes': (self._active[1].size if self._active else 0) +
                                      (ready.size if type(ready) is Artifact else 0),
                    'reserved_byte_ceiling': ARTIFACT_LIMIT * (int(self._active is not None) + int(self._next is not None))}
