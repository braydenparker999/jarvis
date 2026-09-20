import {API_ORIGIN} from './config.js';
// Enabled only after the deployed Worker and authenticated assistant pass live tests.
export function createDirectApi(fetcher=fetch,origin=API_ORIGIN) {
  async function cloud(path,body,headers={}) {
    const r=await fetcher(origin+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(15000)});
    const data=await r.json();if(!r.ok)throw Error(data.error||'Cloud unavailable. Your draft is saved.');return data;
  }
  async function load() {
    const messages=[],posts=[],seen=new Set();let cursor='0',state;
    do {
      state=await cloud('/shared/state?after='+encodeURIComponent(cursor));
      if(state.mode!=='github-publications'||!Array.isArray(state.messages)||!Array.isArray(state.posts))throw Error('Cloud inbox returned invalid data. Your drafts are safe.');
      messages.push(...state.messages);posts.push(...state.posts);
      if(state.nextCursor!==null && (!/^\d{1,15}$/.test(state.nextCursor)||seen.has(state.nextCursor)||Number(state.nextCursor)<=Number(cursor)))throw Error('Inbox pagination failed. Your drafts are safe.');
      cursor=state.nextCursor;seen.add(cursor);
    } while(cursor!==null);
    const unique=items=>[...new Map(items.map(m=>[m.id,m])).values()];
    state.messages=unique(messages).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));state.posts=unique(posts);
    const answered=new Set(state.messages.filter(m=>m.kind==='reply').map(m=>m.replyTo));
    state.unanswered=state.messages.filter(m=>m.role==='user'&&!answered.has(m.id));return state;
  }
  return async function request(path,body,headers={}) {
    if(path==='/shared/state')return load();
    if(path==='/shared/messages'){await cloud(path,{id:body.id,body:body.body});return load();}
    if(path==='/shared/migrate'){
      if(!/^Bearer [a-f0-9]{64}$/.test(headers.Authorization||''))throw Error('Previous inbox credential unavailable.');
      const old=await cloud('/v1/state',null,headers);
      for(const m of old.messages.filter(m=>m.role==='user'))await cloud('/shared/messages',{id:m.id,body:m.body});
      return load();
    }
    throw Error('Unsupported inbox action');
  };
}
