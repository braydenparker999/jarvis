export const STORAGE_KEY='jarvis.shared.v1';
export const LEGACY_KEY='jarvis.hub.v2';
export function readState(storage){
 const raw=storage.getItem(STORAGE_KEY);
 if(raw){const s=JSON.parse(raw);if(s.version!==1||!['messages','posts','outbox'].every(k=>Array.isArray(s[k])))throw Error('Saved drafts could not be opened. They have not been overwritten.');return s.legacyPending===true?{...s,legacyPending:false}:s;}
 let old;try{old=JSON.parse(storage.getItem(LEGACY_KEY)||'null');}catch{}
 return {version:1,messages:(old?.messages||[]).filter(m=>m.role==='user').map(m=>({...m,saved:false,localOnly:true})),posts:[],outbox:[],composer:old?.composer||'',legacyPending:false,syncedAt:null};
}
export function mergeState(state,remote){
 return {...state,...mergePublicMessages(state.messages,state.outbox,remote.messages),posts:remote.partial?state.posts:remote.posts.map(x=>({...x,saved:true})),publisher:remote.publisher||state.publisher,mode:remote.mode||state.mode,syncedAt:new Date().toISOString()};
}
import {mergePublicMessages} from './public-delivery-store.js';
