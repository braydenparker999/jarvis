// Usage: node scripts/build-video-metadata.mjs /path/to/downloaded-videos
// Run alongside yt-dlp --write-info-json; upload the resulting file with videos.
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
const root=resolve(process.argv[2]||'.'),videos=[];
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory()){await walk(path);continue;}if(!entry.name.endsWith('.info.json'))continue;try{const m=JSON.parse(await readFile(path,'utf8'));if(!/^[A-Za-z0-9_-]{11}$/.test(m.id||''))continue;videos.push({youtubeId:m.id,name:m._filename?basename(m._filename):undefined,creator:m.channel||m.uploader||'',description:(m.description||'').slice(0,2000),topics:(m.categories||[]).slice(0,12),addedAt:m.epoch?m.epoch*1000:0});}catch{console.warn('Skipped unreadable metadata:',entry.name);}}}
await walk(root);await writeFile(join(root,'jarvis-video-metadata.json'),JSON.stringify({version:1,videos},null,2)+'\n');console.log(`Prepared metadata for ${videos.length} videos.`);
