import {MODELS,STORAGE_KEY,ACCESS_KEY,API,parseHistory,selectedMessages,streamReply,imageDB,prepareImage,blobData,cleanURL} from './quick-ai-core.js';
const $=id=>document.getElementById(id),db=imageDB();let state,storageOK=true,run=null,access='',ready={};let pending=[];
function warn(s){$('storage-status').hidden=false;$('storage-status').textContent=s;}
try{state=parseHistory(localStorage.getItem(STORAGE_KEY));}catch{state=parseHistory(null);storageOK=false;warn('Saved chats could not be read. This session will not overwrite them.');}
try{access=localStorage.getItem(ACCESS_KEY)||'';}catch{}
function save(){if(!storageOK)return false;try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));return true;}catch{storageOK=false;warn('Storage is full or blocked. Existing chats will not be overwritten; copy new messages before leaving.');return false;}}
const current=()=>state.chats.find(c=>c.id===state.active);
function create(){const c={id:crypto.randomUUID(),title:'New chat',draft:'',provider:'gemini',search:false,messages:[]};state.chats.unshift(c);state.active=c.id;return c;}
if(!current())state.active=state.chats[0]?.id||create().id;
function text(tag,value,cls){const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e;}
function link(url,label){const a=document.createElement('a');a.href=url;a.textContent=label;a.target='_blank';a.rel='noopener noreferrer';return a;}
function bodyRender(node,message){
  node.replaceChildren();const chunks=message.content.split(/(```[\s\S]*?```)/g);
  for(const chunk of chunks){if(!chunk)continue;if(chunk.startsWith('```')){const pre=document.createElement('pre');pre.append(text('code',chunk.slice(3,-3)));node.append(pre);continue;}
    for(const line of chunk.split('\n')){const p=text('p',line||'\u00a0');if(/^\s*[-*] /.test(line))p.classList.add('list-line');
      const sources=message.sources?.sources||[];const re=/\[(\d+)\]/g;let match,last=0;const nodes=[];while((match=re.exec(line))){const source=sources.find(s=>s.id===Number(match[1])&&cleanURL(s.url));if(!source)continue;nodes.push(document.createTextNode(line.slice(last,match.index)),link(cleanURL(source.url),match[0]));last=re.lastIndex;}if(nodes.length){nodes.push(document.createTextNode(line.slice(last)));p.replaceChildren(...nodes);}node.append(p);}
  }
}
async function thumbnails(container,message){for(const id of message.attachments){try{const blob=await db.get(id);if(!blob){container.append(text('span','Image missing · reattach'));continue;}const url=URL.createObjectURL(blob),img=document.createElement('img');img.src=url;img.alt='Attached image';img.onload=()=>URL.revokeObjectURL(url);const item=text('div','','preview');item.append(img);if(message.role==='user'){const remove=text('button','Remove image','text-button');remove.onclick=async()=>{const previous=[...message.attachments];message.attachments=message.attachments.filter(x=>x!==id);if(save()){await db.delete(id).catch(()=>warn('Image removal failed.'));render();}else message.attachments=previous;};item.append(remove);}container.append(item);}catch{container.append(text('span','Image unavailable · reattach'));}}}
function messageElement(m){const article=text('article','','ai-message '+m.role);article.append(text('h2',m.role==='user'?'You':m.provider==='qwen'?'Qwen · '+(m.model||MODELS.qwen):m.provider==='gemini'?'Gemini · '+(m.model||MODELS.gemini):'Quick AI · Groq (earlier reply)'));
  const body=text('div','','body');bodyRender(body,m);if(!m.content&&m.status==='streaming')body.textContent='Thinking…';article.append(body);
  if(m.attachments?.length){const box=text('div','','thumbnails');article.append(box);thumbnails(box,m);}
  if(m.sources?.sources?.length){const list=text('ol','','source-list');for(const s of m.sources.sources){const url=cleanURL(s.url);if(!url)continue;const li=document.createElement('li');li.append(link(url,s.title||url));list.append(li);}article.append(list);}
  if(m.role==='assistant'&&m.status!=='streaming'){
    if(m.status!=='complete'||m.truncated)article.append(text('p',m.truncated?'Reply reached its length limit. Ask to continue.':'Reply interrupted. Tap Retry.','message-note'));
    if(m.content){const b=text('button','Copy','text-button copy');b.onclick=async()=>{try{await navigator.clipboard.writeText(m.content);b.textContent='Copied';}catch{b.textContent='Select text to copy';}};article.append(b);}
  }return article;}
function render(){const c=current();$('history').replaceChildren(...state.chats.map(chat=>{const o=document.createElement('option');o.value=chat.id;o.textContent=chat.title;return o;}));$('history').value=c.id;$('model').value=c.provider;$('search').checked=c.search;$('search-row').hidden=!c.search;$('prompt').value=c.draft;
  $('messages').replaceChildren(...c.messages.map(messageElement));if(!c.messages.length){const empty=text('div','','empty-chat');empty.append(text('h1','What’s on your mind?'),text('p','Ask a question, attach an image, or turn on Search for current sources.'));$('messages').append(empty);}controls();}
function controls(){$('open-unlock').hidden=!!access;const busy=!!run,c=current(),last=c.messages.at(-1),available=!!ready[c.provider];$('send').disabled=busy||!access||!available||!($('prompt').value.trim()||pending.length)||(c.search&&!$('query').value.trim());$('send').hidden=busy;$('stop').hidden=!busy;$('prompt').disabled=busy;$('image').disabled=busy;$('model').disabled=busy;$('search').disabled=busy;$('query').disabled=busy;$('retry').hidden=busy||!access||!available||!(last?.role==='user'||last?.status==='interrupted');$('switch-retry').hidden=busy||!access||!ready.qwen||c.provider!=='gemini'||last?.errorCode!=='limit';$('history').disabled=busy;$('new-chat').disabled=busy;$('delete-chat').disabled=busy;$('messages').setAttribute('aria-busy',String(busy));}
function status(){const c=current();$('status').textContent=!access?'Unlock required':!ready[c.provider]?`${c.provider} is not ready on the free tier`:'Ready · provider limits apply';controls();}
async function refresh(){try{const r=await fetch(API+'/quick-ai/status',{cache:'no-store'});if(!r.ok)throw Error('Worker unavailable');const info=await r.json();ready=info.ready||{};if(!info.accessConfigured)$('status').textContent='Worker unlock needs setup';else status();}catch{$('status').textContent='Quick Chat Worker unavailable';}}
$('prompt').oninput=()=>{current().draft=$('prompt').value;if(current().search&&!$('query').dataset.edited)$('query').value=$('prompt').value.trim().slice(0,350);save();controls();};
$('query').oninput=()=>{$('query').dataset.edited='yes';controls();};
$('prompt').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('composer').requestSubmit();}};
$('model').onchange=()=>{current().provider=$('model').value;save();status();};$('search').onchange=()=>{current().search=$('search').checked;$('search-row').hidden=!current().search;if(current().search&&!$('query').dataset.edited)$('query').value=$('prompt').value.trim().slice(0,350);save();controls();};
$('history').onchange=()=>{state.active=$('history').value;pending=[];save();render();status();};
$('new-chat').onclick=()=>{if(run)return;if(current().messages.length){if(state.chats.length>=50){$('status').textContent='Delete an older chat before creating another.';return;}create();pending=[];save();render();} $('prompt').focus();};
$('delete-chat').onclick=async()=>{if(run||!confirm('Delete this chat and its images from this device?'))return;const old=current();state.chats=state.chats.filter(c=>c!==old);if(!state.chats.length)create();else state.active=state.chats[0].id;pending=[];const removed=save();render();if(!removed)return;for(const id of old.messages.flatMap(m=>m.attachments||[]))try{await db.delete(id);}catch{warn('Some local images could not be removed.');}};
$('image').onchange=async e=>{for(const file of e.target.files){if(pending.length>=3){$('status').textContent='Up to three images per request.';break;}try{const blob=await prepareImage(file);pending.push({id:crypto.randomUUID(),blob});}catch(error){$('status').textContent=error.message;}}e.target.value='';renderPreviews();controls();};
window.addEventListener('paste',async e=>{const files=[...(e.clipboardData?.files||[])].filter(f=>f.type.startsWith('image/'));if(!files.length)return;e.preventDefault();for(const file of files){if(pending.length>=3)break;try{pending.push({id:crypto.randomUUID(),blob:await prepareImage(file)});}catch(error){$('status').textContent=error.message;}}renderPreviews();controls();});
function renderPreviews(){$('previews').replaceChildren(...pending.map(item=>{const box=text('div','','preview');const img=document.createElement('img'),url=URL.createObjectURL(item.blob);img.src=url;img.alt='Image preview';img.onload=()=>URL.revokeObjectURL(url);const b=text('button','Remove','text-button');b.type='button';b.onclick=()=>{pending=pending.filter(p=>p!==item);renderPreviews();controls();};box.append(img,b);return box;}));}
$('stop').onclick=()=>run?.controller.abort();$('retry').onclick=()=>send(true);$('switch-retry').onclick=()=>{current().provider='qwen';save();render();send(true);};$('composer').onsubmit=e=>{e.preventDefault();send(false);};
$('unlock-save').onclick=e=>{e.preventDefault();const value=$('access').value.trim();if(!/^[a-f0-9]{64}$/.test(value)){$('status').textContent='Access credential must be 64 lowercase hexadecimal characters.';return;}access=value;try{localStorage.setItem(ACCESS_KEY,access);}catch{warn('Unlock will last only until this page closes.');}$('unlock').close();status();};
$('open-unlock').onclick=()=>$('unlock').showModal();
async function send(retry){if(run||!access||!ready[current().provider]){if(!access)$('unlock').showModal();return;}const c=current();let user;
  if(retry){user=c.messages.findLast(m=>m.role==='user');if(!user||c.messages.at(-1)?.role==='assistant'&&c.messages.at(-1).status==='complete')return;}
  else{const content=$('prompt').value.trim();if(!content&&!pending.length)return;if(c.search&&!$('query').value.trim()){$('status').textContent='Enter a search query.';return;}user={role:'user',content,attachments:pending.map(p=>p.id),search:c.search,query:$('query').value.trim()};
    // Commit images before changing saved chat state.
    try{for(const p of pending)await db.put(p.id,p.blob);}catch(error){$('status').textContent='Image storage failed. Nothing was sent; retry or free device storage.';return;}
    c.messages.push(user);c.draft='';if(c.messages.length===1)c.title=(content||'Image question').slice(0,60);pending=[];renderPreviews();$('query').value='';delete $('query').dataset.edited;}
  if(retry){user.search=c.search;if(c.search){user.query=$('query').value.trim()||user.query||user.content;if(!user.query){$('status').textContent='Enter a search query.';return;}}save();}
  let selected;try{selected=selectedMessages(c.messages);const count=selected.messages.reduce((n,m)=>n+(m.attachments?.length||0),0);if(count>3)throw Error('Qwen supports at most three images in a request, including earlier images. Start a new chat or reduce images.');
    const payload=[];for(const m of selected.messages){const images=[];for(const id of m.attachments||[]){const blob=await db.get(id);if(!blob)throw Error('An earlier image is missing. Reattach it in a new message.');images.push(await blobData(blob));}payload.push({role:m.role,content:m.content,images,provider:m.provider,continuation:c.provider==='gemini'&&m.provider==='gemini'?m.continuation:null});}selected.messages=payload;
  }catch(error){$('status').textContent=error.message;save();render();return;}
  const reply={role:'assistant',provider:c.provider,model:MODELS[c.provider],content:'',status:'streaming'};c.messages.push(reply);const controller=new AbortController();run={controller};save();render();$('status').textContent=selected.omitted?'Thinking · older context omitted…':'Thinking…';let lastSave=0;
  const article=$('messages').lastElementChild,body=article.querySelector('.body');
  try{const result=await streamReply({access,provider:c.provider,messages:selected.messages,search:user.search,query:user.query||user.content,retry,signal:controller.signal,onEvent:(type,data,content)=>{
    if(type==='metadata'){reply.provider=data.provider;reply.model=data.model;reply.sources=data.search;}
    if(type==='continuation')reply.continuation=data;
    if(type==='text'){const nearBottom=window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-160;reply.content=content;bodyRender(body,reply);$('status').textContent='Replying…';if(Date.now()-lastSave>1000){save();lastSave=Date.now();}if(nearBottom)window.scrollTo(0,document.documentElement.scrollHeight);}
    if(type==='complete')reply.truncated=data.truncated;
  }});reply.status='complete';reply.content=result.content;status();}
  catch(error){reply.status='interrupted';reply.errorCode=error.code||'';if(error.status===401){access='';try{localStorage.removeItem(ACCESS_KEY);}catch{}}$('status').textContent=controller.signal.aborted?'Stopped. Tap Retry.':error.message||'Connection failed. Tap Retry.';controls();}
  finally{run=null;save();render();}
}
window.addEventListener('pagehide',()=>{run?.controller.abort();save();});
render();refresh();
