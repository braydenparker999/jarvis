import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const directory=process.argv[2];
if(!directory)throw Error('Expected output directory.');
const path=join(directory,'assets/quick-ai-config.json');
const config=JSON.parse(await readFile(path,'utf8'));
if(config.version!==3 || !['geminiKey','groqKey','tavilyKey'].every(name=>typeof config[name]==='string'&&config[name].trim()))
  throw Error('Quick AI public configuration is incomplete. Add all three keys to Jarvis public/assets/quick-ai-config.json before frontend deployment.');
console.log('Quick AI public configuration verified.');
