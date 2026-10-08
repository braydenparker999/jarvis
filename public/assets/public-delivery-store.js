// Public Relay/Muse only. Private owner state never uses this adapter.
export const MAX_PUBLIC_PENDING = 50;
export const MAX_PUBLIC_CACHED = 250;
const uuid = value => typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const same = (a,b) => a.id===b.id&&a.role===b.role&&a.body===b.body&&(a.replyTo||null)===(b.replyTo||null);
const order = (a,b) => String(a.createdAt||'').localeCompare(String(b.createdAt||''))||a.id.localeCompare(b.id);
export function mergePublicMessages(known,outbox,received){
  const pending=new Map();
  for(const queued of outbox){
    const message={...known.find(m=>m.id===queued.id),...queued};
    if(pending.has(message.id)&&pending.get(message.id).body!==message.body)throw Error('Queued message ID conflict. Your original text is still saved on this device.');
    pending.set(message.id,{...message,saved:false});
  }
  const accepted=new Map(known.filter(m=>m.saved===true).map(m=>[m.id,m]));
  for(const message of received){
    const queued=pending.get(message.id),previous=accepted.get(message.id);
    if(previous&&!same(previous,message))throw Error('The inbox returned different content for an already accepted immutable message. Refresh later; saved text has been preserved.');
    if(queued&&!(message.role==='user'&&message.body===queued.body)){
      pending.set(message.id,{...queued,sendState:'conflict'});continue;
    }
    accepted.set(message.id,{...message,saved:true});
  }
  for(const [id,message] of pending){const proof=accepted.get(id);if(proof&&proof.role==='user'&&proof.body===message.body)pending.delete(id);}
  // Runtime history is complete. Only the serialized offline cache is bounded.
  const messages=[...new Map([...accepted.values(),...pending.values()].map(m=>[m.id,m])).values()].sort(order);
  return {messages,outbox:[...pending.values()].sort(order)};
}

export function createPublicDeliveryStore({storage,tabStorage,key,read}){
  const prefix=key+'.pending.',draftKey=key+'.composer.v1',draftIdKey=key+'.composer-id.v1';
  let draft,draftId;
  const validIntent=value=>value&&uuid(value.id)&&typeof value.body==='string'&&value.body.length<=4000;
  function journals(){
    const pending=[];
    for(let i=0;i<(storage.length||0);i++){
      const name=storage.key(i);if(!name?.startsWith(prefix))continue;
      let message;try{message=JSON.parse(storage.getItem(name));}catch{}
      if(!message||!uuid(message.id)||name!==prefix+message.id||message.role!=='user'||typeof message.body!=='string'
        ||!message.body.trim()||message.body.length>4000||!Number.isFinite(Date.parse(message.createdAt))
        ||message.draftIntent!==undefined&&!validIntent(message.draftIntent))throw Error('A queued message could not be opened. Saved text has not been overwritten.');
      pending.push(message);
    }
    // Concurrent tabs can each admit the last available slot. Valid existing
    // overflow must remain readable so acceptance can drain the queue.
    return pending;
  }
  function savePending(message,{associateDraft=false}={}){
    if(!uuid(message.id)||message.role!=='user'||typeof message.body!=='string'||!message.body.trim()||message.body.length>4000||!Number.isFinite(Date.parse(message.createdAt)))throw Error('This queued message is unreadable. Its saved text has been preserved.');
    const existing=storage.getItem(prefix+message.id),original=existing?JSON.parse(existing):null;
    if(original){if(original.body!==message.body)throw Error('Queued message ID conflict. Your original text is still saved on this device.');}
    else if(journals().length>=MAX_PUBLIC_PENDING){const error=Error('Fifty messages are already queued. Wait for acceptance before sending another; your draft is still here.');error.kind='capacity';throw error;}
    const draftIntent=associateDraft?{id:draftId,body:draft}:message.draftIntent||original?.draftIntent;
    if(draftIntent&&!validIntent(draftIntent))throw Error('The draft could not be associated with this queued message. Your text is still here.');
    try{storage.setItem(prefix+message.id,JSON.stringify({id:message.id,body:message.body,role:'user',createdAt:message.createdAt,saved:false,
      ...(message.type?{type:message.type}:{}),...(message.sendState?{sendState:message.sendState}: {}),...(draftIntent?{draftIntent:{id:draftIntent.id,body:draftIntent.body}}:{})}));}
    catch{const error=Error('This device could not save the queued message. Keep your text here or copy it before leaving.');error.storageFailure=true;throw error;}
  }
  function restore(){
    const state=read(storage);
    if(draft===undefined){
      let savedDraft=null,savedId=null;try{savedDraft=tabStorage?.getItem(draftKey)??null;savedId=tabStorage?.getItem(draftIdKey);}catch{}
      draft=savedDraft??state.composer??'';draftId=uuid(savedId)?savedId:savedDraft===null&&uuid(state.composerId)?state.composerId:crypto.randomUUID();
    }
    // Migrate old aggregate queues to one key per UUID before any shared write.
    for(const queued of state.outbox){const message={...state.messages.find(m=>m.id===queued.id),...queued};savePending(message);}
    const pending=journals();
    // A journal is the durable handoff for this exact draft revision. If clearing
    // the composer failed, restore that queued intent instead of a fresh Send.
    if(pending.some(m=>m.draftIntent?.id===draftId&&m.draftIntent.body===draft))draft='';
    return {...state,...mergePublicMessages(state.messages,[...state.outbox,...pending],[]),composer:draft,composerId:draftId};
  }
  function commit(next){
    const stored=read(storage),pending=journals();
    const known=[...stored.messages.filter(m=>m.saved===true),...next.messages];
    const merged=mergePublicMessages(known,[...stored.outbox,...pending,...next.outbox],next.messages.filter(m=>m.saved===true));
    const posts=[...new Map([...(stored.posts||[]),...(next.posts||[])].map(p=>[p.id,p])).values()].sort(order);
    const nextDraftId=next.composer===draft?draftId:crypto.randomUUID();
    const result={...next,...merged,...('posts' in next?{posts}:{}),composer:next.composer,composerId:nextDraftId};
    // Draft isolation is a real persistence guarantee, not a best-effort claim.
    // Fail before clearing a draft or updating aggregate state if this tab's
    // independent copy cannot be saved.
    try{if(!tabStorage)throw Error();tabStorage.setItem(draftKey,result.composer);tabStorage.setItem(draftIdKey,nextDraftId);}
    catch{const error=Error('This tab could not save its draft. Your text is still here; copy it before reloading.');error.storageFailure=true;throw error;}
    // Each UUID is independently durable. Another tab's aggregate write cannot
    // erase it, and no journal is removed without exact accepted user text.
    for(const message of result.outbox)savePending(message);
    const cachedMessages=[...result.messages.filter(m=>m.saved===true).sort(order).slice(-MAX_PUBLIC_CACHED),...result.outbox].sort(order);
    try{storage.setItem(key,JSON.stringify({...result,messages:cachedMessages,...('posts' in result?{posts:posts.slice(-20)}:{})}));}
    catch{const error=Error('Browser storage could not finish updating. Keep this page open and copy your text before reloading.');error.storageFailure=true;throw error;}
    const accepted=new Map(result.messages.filter(m=>m.saved===true&&m.role==='user').map(m=>[m.id,m.body]));
    for(const message of pending)if(accepted.get(message.id)===message.body)storage.removeItem(prefix+message.id);
    draft=result.composer;draftId=nextDraftId;
    return result;
  }
  return {restore,commit,savePending,draftKey,prefix,
    external(current){const incoming=restore(),posts=[...new Map([...(current.posts||[]),...(incoming.posts||[])].map(p=>[p.id,p])).values()].sort(order);return {...current,...mergePublicMessages(current.messages,[...current.outbox,...incoming.outbox],incoming.messages.filter(m=>m.saved===true)),...('posts' in current?{posts}:{}),composer:current.composer};}};
}
