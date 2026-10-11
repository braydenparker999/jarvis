"""Bounded current-item handoff; no queue, transport, retry or recovery policy.

Uses the immutable bytes/bounds contract of preparation_ahead.artifact.
A slot remains occupied on any failure; only verified success may remove it.
"""
import hashlib
import json
import os
from pathlib import Path
import stat

AUDIO = 32 * 1024 * 1024
COVER = 2 * 1024 * 1024
META = 16 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise RuntimeError('Prepared input must be a regular file')
        data = f.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError('Prepared input exceeds bound')
    return data


def write(path, data):
    with open(path, 'xb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(path, 0o400)


def reserve(root):
    root = Path(root)
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('Prepared root must be an owner-only directory')
    for name in ('0', '1'):
        slot = root / name
        try:
            slot.mkdir(mode=0o700)
            return slot
        except FileExistsError:
            pass
    return None  # Backpressure; no deletion or new claim.


def snapshot(source, slot, expected_sha):
    data = read(source, AUDIO)
    if not data or sha(data) != expected_sha:
        raise RuntimeError('Claimed audio identity changed')
    write(Path(slot) / 'audio.opus', data)
    return Path(slot) / 'audio.opus'


def seal(slot, *, name, origin, tags, cover, analysis_status):
    slot = Path(slot)
    audio = read(slot / 'audio.opus', AUDIO)
    image, ext = cover if cover else (None, None)
    if image == b'':
        image, ext = None, None  # Retain Mast's zero-byte cover guard.
    if image is not None:
        if type(image) is not bytes or len(image) > COVER or ext not in ('jpg', 'png'):
            raise RuntimeError('Invalid prepared cover')
        write(slot / 'cover', image)
    descriptor = {'version': 1, 'name': name, 'origin': origin,
                  'sha256': sha(audio), 'size': len(audio), 'metadata': tags,
                  'analysisStatus': analysis_status,
                  'cover': None if image is None else {'sha256': sha(image), 'size': len(image), 'ext': ext}}
    raw = json.dumps(descriptor, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    if len(raw) > META:
        raise RuntimeError('Prepared metadata exceeds bound')
    write(slot / 'prepared.json', raw)
    fd = os.open(slot, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return sha(raw)


def load(slot, pin, expected_sha, name, origin):
    slot = Path(slot)
    raw = read(slot / 'prepared.json', META)
    if sha(raw) != pin:
        raise RuntimeError('Prepared descriptor changed')
    d = json.loads(raw)
    data = read(slot / 'audio.opus', AUDIO)
    if (d['version'] != 1 or d['name'] != name or d['origin'] != origin
            or not data or sha(data) != d['sha256'] or d['sha256'] != expected_sha
            or len(data) != d['size']):
        raise RuntimeError('Prepared audio/context changed')
    cover = None
    if d['cover'] is not None:
        c = d['cover']
        image = read(slot / 'cover', COVER)
        if not image or sha(image) != c['sha256'] or len(image) != c['size'] or c['ext'] not in ('jpg', 'png'):
            raise RuntimeError('Prepared cover changed')
        cover = image, c['ext']
    return data, d['metadata'], cover, d['analysisStatus']


def remove_verified(slot):
    # Never traverse paths supplied by metadata or delete source/report files.
    slot = Path(slot)
    for name in ('audio.opus', 'cover', 'prepared.json'):
        (slot / name).unlink(missing_ok=True)
    slot.rmdir()
