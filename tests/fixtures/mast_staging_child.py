"""Authored CLI fixture for exact staging subprocess arguments; no network."""
import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.staging import mast_runtime as mast
from scripts.staging import prepared_handoff as prep
from scripts.prototypes import upload_checkpoints as cp
from scripts.prototypes.manifest_transaction import Transaction

p=argparse.ArgumentParser()
p.add_argument('file',type=Path)
for name in ('key','prepare-dir','prepare-report','expected-sha','report','prepared-dir','prepared-pin','manifest','claim','attempt','checkpoint','stop','auth-stop'):
    p.add_argument('--'+name)
a=p.parse_args(); root=a.file.parent; mode=(root/'mode').read_text()
origin='https://fixture.invalid';public='a'*64
if a.prepare_dir:
    snapshot=prep.snapshot(a.file,a.prepare_dir,a.expected_sha)
    tags={'title':'Original','artist':'Fixture'}
    if mode=='analysis': tags['audioAnalysis']={'version':2}
    pin=prep.seal(a.prepare_dir,name=a.file.stem+'.opus',origin=origin,tags=tags,
                  cover=None if mode=='empty-cover' else (b'fixture art','jpg'),analysis_status='measured' if mode=='analysis' else 'not-requested')
    prep.write(a.prepare_report,cp.encode({'preparedPin':pin}));sys.exit(0)
if mode=='corrupt-journal': Path(a.checkpoint).write_bytes(b'corrupt')
claim=json.loads(a.claim)
track='r2_native_'+a.expected_sha
proof={'etag':'fixture_proof','size':claim['size'],'lastModified':'2026-10-10T00:00:00.000Z'}
def request(method,url,body,mime,signer):
    with (root/'calls').open('a') as log: log.write(url+'\n')
    if mode=='auth': return {'status':401,'url':url,'content_type':'application/json','body':b'{}'}
    if mode=='ambiguous' and '/art/' in url: raise TimeoutError('synthetic unknown outcome')
    if mode=='interrupt' and '/art/' in url: os._exit(17)
    if mode=='malformed': return {'status':200,'url':url,'content_type':'text/html','body':b'{}'}
    if '/audio/' in url or '/art/' in url:
        role='audio' if '/audio/' in url else 'art'; ext='opus' if role=='audio' else 'jpg'
        result={'key':f'native/{role}/{cp.sha(body)}.{ext}','sha256':cp.sha(body),'size':len(body),'r2Identity':{**proof,'size':len(body)}}
    elif url.endswith('/register'):
        marker=root/'conflicted'
        if mode=='conflict' and not marker.exists():
            marker.touch();return {'status':409,'url':url,'content_type':'application/json','body':cp.encode({'error':mast.CONFLICT})}
        result={'registered':True,'duplicate':mode=='analysis','id':track,'count':1}
    elif url.endswith('/library.json'):
        result={'tracks':[{'id':track,'sha256':a.expected_sha,'size':claim['size'],'r2Identity':proof,
                          'metadata':{'audioAnalysis':{'version':1,'z':2,'a':1}}}]}
    else:
        result={'registered':True,'analysisUpdated':True,'id':track,'count':1}
    return {'status':200,'url':url,'content_type':'application/json','body':json.dumps(result).encode()}
code=mast.upload_prepared(manifest=a.manifest,claim=claim,attempt=a.attempt,slot=a.prepared_dir,
     pin=a.prepared_pin,journal=a.checkpoint,report=a.report,origin=origin,public=public,name=a.file.stem+'.opus',
     request_once=request,stop_paths=[a.stop,a.auth_stop],auth_stop=a.auth_stop)
if mode=='stale':
    with Transaction(a.manifest) as tx:
        tx.value['entries'][a.expected_sha]['generation']='superseded';tx.commit(tx.value)
if mode=='changed-bytes':
    path=Path(a.prepared_dir)/'audio.opus';path.chmod(0o600);path.write_bytes(b'changed')
sys.exit(code)
