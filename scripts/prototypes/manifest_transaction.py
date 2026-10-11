"""Offline prototype: all writers must migrate together to a stable sidecar.

Trusted local paths only. Never unlink/replace the sidecar. No claim policy,
initialization, recovery, upload retry, or automatic commit is provided here.
"""
import fcntl
import json
import math
import os
from pathlib import Path
import tempfile

MAX_BYTES = 16 * 1024 * 1024


class ManifestError(Exception):
    pass


class CommitUncertain(ManifestError):
    """Rename was attempted; commit or directory durability is uncertain."""


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ManifestError('duplicate JSON key')
        result[key] = value
    return result


def _invalid_constant(value):
    raise ManifestError('nonfinite JSON value')


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ManifestError('nonfinite JSON number')
    return number


def _decode(raw, manifest=True):
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=_pairs,
                           parse_constant=_invalid_constant, parse_float=_finite_float)
        if not isinstance(value, dict) or manifest and not isinstance(value.get('entries'), dict):
            raise ManifestError('expected manifest object with entries object')
        if manifest and not all(isinstance(entry, dict) for entry in value['entries'].values()):
            raise ManifestError('expected entry objects')
        return value
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ManifestError('invalid manifest') from exc


class Transaction:
    """Read current path only after acquiring lock; one explicit commit per scope."""
    def __init__(self, path, *, manifest=True):
        self.manifest = manifest
        self.path = Path(path)
        self.lock = None
        self.value = None
        self.used = False

    def __enter__(self):
        if self.lock is not None or self.used:
            raise ManifestError('transaction cannot be reused')
        self.lock = open(str(self.path) + '.lock', 'a+b')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX)
            with self.path.open('rb') as stream:
                raw = stream.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ManifestError('manifest too large')
            self.value = _decode(raw, self.manifest)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def commit(self, value):
        if self.lock is None or self.used:
            raise ManifestError('inactive or already committed transaction')
        self.used = True  # Any failed commit requires a fresh, explicit decision.
        raw = (json.dumps(value, ensure_ascii=False, allow_nan=False, indent=1) + '\n').encode('utf-8')
        if len(raw) > MAX_BYTES:
            raise ManifestError('manifest too large')
        _decode(raw, self.manifest)
        temporary = None
        rename_attempted = False
        try:
            fd, temporary = tempfile.mkstemp(prefix=self.path.name + '.', suffix='.tmp', dir=self.path.parent)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            rename_attempted = True
            os.replace(temporary, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except BaseException as exc:
            if rename_attempted:
                raise CommitUncertain('manifest rename attempted; commit/durability unknown') from exc
            raise
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def __exit__(self, *ignored):
        if self.lock is not None:
            self.lock.close()
            self.lock = None
        self.value = None
        self.used = True
