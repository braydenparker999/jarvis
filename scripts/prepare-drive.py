"""Prepare compact metadata/waveforms once, away from the listening phone.

Usage: python scripts/prepare-drive.py FOLDER_ID --key-file /private/path
Requires ffmpeg and ffprobe. No music files or API keys enter the output.
"""
import argparse, array, concurrent.futures, json, math, os, struct, subprocess, tempfile, time
import urllib.request, urllib.parse, urllib.error
from pathlib import Path

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('folder');parser.add_argument('--key-file',required=True)
    parser.add_argument('--output',default='public/drawercast')
    args=parser.parse_args();key=Path(args.key_file).read_text().strip()
    def request(path, params, destination=None):
        url='https://www.googleapis.com/drive/v3/files'+path+'?'+urllib.parse.urlencode({**params,'key':key})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url,timeout=60) as response:
                    if destination:
                        with open(destination,'wb') as output:
                            while chunk:=response.read(1024*1024):output.write(chunk)
                        return
                    return json.load(response)
            except Exception:
                if attempt==2:raise RuntimeError('Drive download failed; key and request URL omitted') from None
                time.sleep(attempt+1)
    files=[];token=''
    while True:
        page=request('',{'q':"'"+args.folder+"' in parents and trashed = false",'pageSize':1000,'fields':'nextPageToken,files(id,name,mimeType,size,md5Checksum)',**({'pageToken':token} if token else {})})
        files.extend(f for f in page['files'] if f.get('mimeType','').startswith(('audio/','video/')))
        token=page.get('nextPageToken');
        if not token:break
    output=Path(args.output);waves=output/'drive-waveforms';waves.mkdir(parents=True,exist_ok=True)
    def prepare(f):
        if int(f.get('size',0))>50*1024*1024:raise RuntimeError('Preparation capped at 50 MiB per file')
        with tempfile.TemporaryDirectory(prefix='jarvis-drive-') as directory:
            media=Path(directory)/'source';request('/'+f['id'],{'alt':'media'},media)
            probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(media)],timeout=30))
            stream=next(s for s in probe['streams'] if s['codec_type']=='audio')
            duration=float(probe['format'].get('duration') or stream.get('duration') or 0)
            if not 0<duration<=1800:raise RuntimeError('Preparation capped at 30 minutes per file')
            pcm=subprocess.check_output(['ffmpeg','-v','error','-i',str(media),'-map','0:a:0','-ac','1','-ar','8000','-f','f32le','pipe:1'],timeout=120)
            samples=array.array('f');samples.frombytes(pcm)
            if os.sys.byteorder!='little':samples.byteswap()
            ms=round(duration*1000);count=math.ceil(ms*16/1000);peaks=bytearray(count)
            for i in range(count):
                segment=samples[i*500:(i+1)*500]
                if segment:
                    rms=math.sqrt(sum(v*v for v in segment)/len(segment));peak=max(abs(v) for v in segment)
                    peaks[i]=round(min(1,max(rms*2,peak*.65))*255)
            (waves/(f['id']+'.dcw')).write_bytes(struct.pack('>IIIHH',0x44435731,ms,count,16,0)+peaks)
            tags={k.lower():v for source in [probe['format'].get('tags',{}),stream.get('tags',{})] for k,v in source.items()}
            return f['id'],{'size':int(f['size']),'md5':f['md5Checksum'],'dur':duration,'sr':int(stream.get('sample_rate',0)),'ch':stream.get('channels',0),'codec':stream['codec_name'],'title':tags.get('title',''),'artist':tags.get('artist',''),'album':tags.get('album',''),'albumArtist':tags.get('album_artist',''),'genre':tags.get('genre',''),'waveform':True}
    prepared={}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(prepare,f):f for f in files}
        for future in concurrent.futures.as_completed(futures):
            file_id,metadata=future.result();prepared[file_id]=metadata
            print('Prepared',len(prepared),'of',len(files),flush=True)
    (output/'drive-prepared.json').write_text(json.dumps({'version':1,'files':prepared},ensure_ascii=False,separators=(',',':'))+'\n')
    print('Compact waveform bytes:',sum(p.stat().st_size for p in waves.glob('*.dcw')))

if __name__=='__main__':main()
