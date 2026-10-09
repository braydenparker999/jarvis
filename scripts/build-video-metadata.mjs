// Usage: node scripts/build-video-metadata.mjs /path/to/downloaded-videos
// Reconcile local yt-dlp sidecars additively; no network, upload or media reads.
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {collectInfoMetadata,mergePreparedMetadata} from './video-date-backfill.mjs';
const root=resolve(process.argv[2]||'.'),path=join(root,'jarvis-video-metadata.json');
let previous=null,existing={version:2,videos:[]};
try{previous=await readFile(path,'utf8');existing=JSON.parse(previous);}catch(error){if(error.code!=='ENOENT')throw Error('Existing metadata is unreadable or invalid; left unchanged.');}
const {rows,diagnostics}=await collectInfoMetadata(root),{manifest,conflicts}=mergePreparedMetadata(existing,rows);
// Once enrolled, emit a candidate instead of replacing active metadata.
const output=previous===null?path:join(root,'jarvis-video-metadata.candidate.json');
await writeFile(output,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({prepared:manifest.videos.length,skipped:diagnostics.length,conflicts:conflicts.length,candidate:previous!==null}));
