// Always a dry run. Output contains only review artifacts; no apply/upload mode.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {collectInfoMetadata,planDateBackfill,rowsFromArchive} from './video-date-backfill.mjs';

const {values}=parseArgs({options:{inventory:{type:'string'},existing:{type:'string'},sources:{type:'string'},
  'archive-state':{type:'string'},out:{type:'string'},'dry-run':{type:'boolean',default:true}}});
if(!values.inventory||!values.out)throw Error('Usage: node scripts/backfill-video-dates.mjs --inventory SNAPSHOT --out NEW_REVIEW_DIRECTORY [--existing MANIFEST] [--sources SIDECARS] [--archive-state STATE]');
const read=async path=>{try{return JSON.parse(await readFile(resolve(path),'utf8'));}catch{throw Error('A JSON metadata input is unreadable or invalid; existing input files were left unchanged.');}};
const inventory=await read(values.inventory);
// A supplied manifest is mandatory if a live one existed or its read failed.
if(inventory.metadataStatus!=='missing'&&!values.existing)throw Error('The inventory has existing, ambiguous, invalid, unreadable or unknown metadata. Supply the reviewed existing manifest; do not replace it with an empty baseline.');
const existing=values.existing?await read(values.existing):{version:2,videos:[]};
let sources=[],diagnostics=[];
if(values.sources){const collected=await collectInfoMetadata(resolve(values.sources));sources=collected.rows;diagnostics=collected.diagnostics;}
if(values['archive-state'])sources.push(...rowsFromArchive(await read(values['archive-state'])));
const {plan,candidate}=planDateBackfill(inventory,existing,sources);plan.sourceDiagnostics=diagnostics;
const output=resolve(values.out);
// Exclusive directory creation prevents replacing any previously reviewed plan.
await mkdir(output);
await writeFile(join(output,'video-date-backfill-plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
await writeFile(join(output,'jarvis-video-metadata.candidate.json'),JSON.stringify(candidate,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({mode:plan.mode,videos:plan.videos,counts:plan.counts,inventoryFingerprint:plan.inventoryFingerprint}));
