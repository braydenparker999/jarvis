#!/usr/bin/env python3
"""Upload an already prepared Opus file. Private signing key stays on the caller.

Requires Python 3, mutagen and openssl. Does not download, transcode, use Drive,
retrieve R2 keys, or follow HTTP redirects. Safe to repeat after interruption.
"""
import argparse
import base64
import hashlib
import json
import os
import math
import importlib.util
import re
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ORIGIN = 'https://jarvis-hub-api.braydenparker999.workers.dev'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def signature_message(method, path, mime, digest, size, timestamp, public):
    return '\n'.join(['jarvis-r2-upload-v1', method, ORIGIN, path, mime,
                      digest, str(size), str(timestamp), public]).encode()


def upload_request(method, path, body, mime, key, public):
    digest = hashlib.sha256(body).hexdigest()
    timestamp = int(time.time())
    message = signature_message(method, path, mime, digest, len(body), timestamp, public)
    with tempfile.NamedTemporaryFile() as signed_input:
        signed_input.write(message)
        signed_input.flush()
        # Never interpolate paths into shell commands or print the private key.
        signature = subprocess.run(['openssl', 'pkeyutl', '-sign', '-rawin',
                                    '-inkey', str(key), '-in', signed_input.name],
                                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.hex()
    headers = {'User-Agent': 'JarvisMusicUploader/1.0', 'Accept': 'application/json',
               'Content-Type': mime, 'X-Music-Public-Key': public,
               'X-Music-Timestamp': str(timestamp), 'X-Music-Size': str(len(body)),
               'X-Music-Sha256': digest, 'X-Music-Signature': signature}
    request = urllib.request.Request(ORIGIN + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=120) as response:
            return json.loads(response.read(65537))
    except urllib.error.HTTPError as error:
        # Do not print request headers, credential values or SDK exception strings.
        raise RuntimeError(f'Upload HTTP {error.code}; retry only after diagnosing the response.') from None


def prepared(file):
    from mutagen.oggopus import OggOpus
    from mutagen.flac import Picture
    song = OggOpus(file)
    def tag(name, default=''):
        return (song.tags.get(name, [default]) or [default])[0]
    def number(name):
        try:
            return int(str(tag(name, '0')).split('/')[0].split('-')[0])
        except ValueError:
            return 0
    tags = {'title': tag('title'), 'artist': tag('artist'), 'album': tag('album'),
            'albumArtist': tag('albumartist'), 'genre': tag('genre'),
            'composer': tag('composer'), 'year': number('date'),
            'track': number('tracknumber'), 'disc': number('discnumber'),
            'dur': song.info.length, 'sr': 48000, 'ch': song.info.channels, 'codec': 'Opus'}
    if not tags['title'].strip() or not tags['artist'].strip() or tags['dur'] <= 0:
        raise RuntimeError('Prepared title, artist and positive duration are required.')
    # Reject malformed/duplicate gain tags rather than choosing a random value.
    for name, field in [('replaygain_track_gain','rgTrack'),('replaygain_album_gain','rgAlbum'),('replaygain_track_peak','rgTrackPeak'),('replaygain_album_peak','rgAlbumPeak'),('r128_track_gain','r128TrackGain'),('r128_album_gain','r128AlbumGain')]:
        values=song.tags.get(name,[])
        if len(values)!=1:continue
        raw=values[0];r128=name.startswith('r128_');peak=name.endswith('_peak')
        pattern=r'[+-]?\d{1,6}' if r128 else r'(?:\d+(?:\.\d*)?|\.\d+)' if peak else r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*dB)?'
        if not re.fullmatch(pattern,raw,re.I):continue
        value=float(re.sub(r'\s*dB$','',raw,flags=re.I))
        if math.isfinite(value) and (len(raw)<=6 and -32768<=value<=32767 if r128 else 0<value<=1000 if peak else abs(value)<=60):tags[field]=int(value) if r128 else value
    with Path(file).open('rb') as f:
        header=f.read(65536);at=header.find(b'OpusHead')
        if at>=0:tags['opusHeadGainDb']=int.from_bytes(header[at+16:at+18],'little',signed=True)/256
    cover = None
    for value in song.tags.get('metadata_block_picture', []):
        picture = Picture(base64.b64decode(value, validate=True))
        if picture.mime in ('image/jpeg', 'image/png'):
            cover = (picture.data, 'jpg' if picture.mime == 'image/jpeg' else 'png')
            if picture.type == 3:
                break
    return tags, cover


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--key', type=Path, required=True, help='Private Ed25519 PKCS8 PEM; never uploaded')
    parser.add_argument('--report', type=Path)
    parser.add_argument('--analyze', action='store_true', help='Optional bounded FFmpeg analysis; failure keeps upload working')
    args = parser.parse_args()
    key_stat = args.key.stat()
    if key_stat.st_mode & 0o077 or key_stat.st_uid != os.getuid():
        raise RuntimeError('Signing key must belong to this user and have mode 0600 or 0400.')
    if args.file.stat().st_size > 32 * 1024 * 1024:
        raise RuntimeError('This upload endpoint accepts files up to 32 MiB.')
    der = subprocess.run(['openssl', 'pkey', '-in', str(args.key), '-pubout', '-outform', 'DER'],
                         check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
    if len(der) != 44 or der[:12] != bytes.fromhex('302a300506032b6570032100'):
        raise RuntimeError('A dedicated Ed25519 PKCS8 PEM key is required.')
    public = der[12:].hex()
    tags, cover = prepared(args.file)
    analysis_status='not-requested'
    if args.analyze:
        try:
            spec=importlib.util.spec_from_file_location('jarvis_audio_analyzer',Path(__file__).parent/'audio'/'analyze.py')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            tags['audioAnalysis']=module.analyze(args.file);analysis_status='measured'
        except Exception:
            # Optional tool failure cannot block a byte-preserving upload.
            analysis_status='unavailable'
    data = args.file.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    upload_request('PUT', '/music/uploads/audio/' + digest + '.opus', data, 'audio/ogg', args.key, public)
    registration = {'name': args.file.stem + '.opus', 'sha256': digest, 'size': len(data), 'metadata': tags}
    if cover:
        image, ext = cover
        if len(image) > 2 * 1024 * 1024:
            raise RuntimeError('Embedded cover exceeds 2 MiB; prepare a smaller cover before uploading.')
        sha = hashlib.sha256(image).hexdigest()
        upload_request('PUT', '/music/uploads/art/' + sha + '.' + ext, image,
                       'image/jpeg' if ext == 'jpg' else 'image/png', args.key, public)
        registration['cover'] = {'sha256': sha, 'size': len(image), 'ext': ext}
    result = upload_request('POST', '/music/uploads/register',
                            json.dumps(registration, ensure_ascii=False, separators=(',', ':')).encode(),
                            'application/json', args.key, public)
    if result.get('duplicate') is True and 'audioAnalysis' in tags:
        # A separate signed metadata-only upgrade preserves the existing ID.
        # No private key leaves this caller; expected prior analysis prevents races.
        request=urllib.request.Request(ORIGIN+'/music/library.json',headers={'User-Agent':'JarvisMusicUploader/1.0','Accept':'application/json'})
        with urllib.request.build_opener(NoRedirect).open(request,timeout=30) as response:
            raw=response.read(16*1024*1024+1)
        if len(raw)>16*1024*1024:raise RuntimeError('The independent catalog exceeds its bounded limit.')
        catalog=json.loads(raw);existing=next((t for t in catalog.get('tracks',[]) if t['id']==result['id']),None)
        if not existing or existing['sha256']!=digest or existing['size']!=len(data):raise RuntimeError('Duplicate registration identity changed; review before analysis upgrade.')
        correction={'id':existing['id'],'sha256':digest,'size':len(data),'r2Identity':existing['r2Identity'],
                    'previousAnalysis':existing['metadata'].get('audioAnalysis'),'audioAnalysis':tags['audioAnalysis']}
        result['analysisCorrection']=upload_request('POST','/music/uploads/analysis',json.dumps(correction,ensure_ascii=False,separators=(',',':')).encode(),'application/json',args.key,public)
    if result.get('registered') is not True:
        raise RuntimeError('The server did not confirm library registration.')
    result.update({'analysisStatus':analysis_status,'audioSha256': digest, 'audioBytes': len(data), 'coverUploaded': bool(cover),
                   'coverSha256': registration.get('cover', {}).get('sha256'),
                   'playbackVerified': False})
    if args.report:
        args.report.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Exceptions from subprocess/HTTP never disclose signing material.
        print('Upload stopped: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__))
        raise SystemExit(1)
