import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const directory=process.argv[2];
if(!['public','dist'].includes(directory))throw Error('Expected public or dist output directory.');
await writeFile(join(directory,'assets/quick-ai-config.json'),JSON.stringify({version:2,apiOrigin:'https://jarvis-hub-api.braydenparker999.workers.dev'})+'\n');
console.log('Quick AI public configuration prepared without credentials.');
