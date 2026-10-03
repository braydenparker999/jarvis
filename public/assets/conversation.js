import {el, icon, richText, sheet, copyText, readLocal, writeLocal, autosize} from './ui.js';

// Keep existing nodes and their scroll anchors across inbox refreshes.
export function conversation({panel, composer, channel, author, body=m=>m.body, notify=()=>{}, draftChanged=()=>{}}){
  let messages=[], query='', savedOnly=false, first=true, timer, start;
  const key='jarvis.'+channel+'.bookmarks.v1';
  const raw=readLocal(key,[]), bookmarks=new Set(Array.isArray(raw)?raw:[]);
  const formatter=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  const savedPosition=readLocal('jarvis.'+channel+'.reading.v1',null);
  const jump=el('button','New messages','new-messages');jump.type='button';jump.hidden=true;panel.after(jump);
  jump.onclick=()=>{query='';savedOnly=false;const input=document.getElementById('conversation-search');if(input)input.value='';update(messages);panel.scrollTop=panel.scrollHeight;jump.hidden=true;};
  function showActions(id){if(document.querySelector('.app-sheet[open]'))return;const m=messages.find(x=>x.id===id);if(!m)return;sheet(m.role==='user'?'Your message':author,[
    {label:'Copy message',icon:'copy',action:async()=>notify(await copyText(body(m))?'Copied':'Select the message text to copy it')},
    {label:bookmarks.has(id)?'Remove bookmark':'Bookmark',icon:'bookmark',action:()=>{bookmarks.has(id)?bookmarks.delete(id):bookmarks.add(id);if(!writeLocal(key,[...bookmarks]))notify('Bookmark could not be saved');update(messages);}},
    {label:'Quote in reply',icon:'quote',action:()=>{const quoted=body(m).slice(0,900).split('\n').map(s=>'> '+s).join('\n');composer.value=(composer.value?composer.value+'\n\n':'')+quoted+'\n\n';composer.value=composer.value.slice(0,composer.maxLength>0?composer.maxLength:16000);draftChanged(composer.value);autosize(composer);composer.focus();composer.setSelectionRange(composer.value.length,composer.value.length);}},
  ]);}
  panel.addEventListener('click',e=>{const a=e.target.closest('[data-message-actions]');if(a)showActions(a.dataset.messageActions);});
  panel.addEventListener('contextmenu',e=>{const row=e.target.closest('[data-message-id]');if(row && !e.target.closest('a')){e.preventDefault();showActions(row.dataset.messageId);}});
  panel.addEventListener('pointerdown',e=>{if(e.target.closest('a,button')||e.button>0)return;const row=e.target.closest('[data-message-id]');if(!row)return;start={x:e.clientX,y:e.clientY};timer=setTimeout(()=>{timer=null;showActions(row.dataset.messageId);},550);},{passive:true});
  panel.addEventListener('pointermove',e=>{if(start && Math.hypot(e.clientX-start.x,e.clientY-start.y)>8)clearTimeout(timer);},{passive:true});
  for(const event of ['pointerup','pointercancel','scroll'])panel.addEventListener(event,()=>clearTimeout(timer),{passive:true});
  panel.addEventListener('scroll',()=>{if(panel.scrollHeight-panel.clientHeight-panel.scrollTop<50)jump.hidden=true;},{passive:true});
  function position(){const r=panel.getBoundingClientRect();const visible=[...panel.children].find(n=>n.dataset.messageId&&n.getBoundingClientRect().bottom>=r.top);return {id:visible?.dataset.messageId,offset:visible?visible.getBoundingClientRect().top-r.top:0,bottom:panel.scrollHeight-panel.clientHeight-panel.scrollTop<70};}
  function update(next){
    const oldIds=new Set(messages.map(x=>x.id)), anchor=position();messages=next;
    const answered=new Set(next.filter(m=>m.kind==='reply').map(m=>m.replyTo));
    const selected=next.filter(m=>(!savedOnly||bookmarks.has(m.id))&&(!query||body(m).toLowerCase().includes(query)));
    const existing=new Map([...panel.children].filter(n=>n.dataset.messageId).map(n=>[n.dataset.messageId,n]));
    panel.querySelector('.chat-empty')?.remove();
    const wanted=new Set(selected.map(m=>m.id));for(const [id,n] of existing)if(!wanted.has(id))n.remove();
    for(let i=0;i<selected.length;i++){
      const m=selected[i];let row=existing.get(m.id);
      if(!row){row=el('article','','message-row '+(m.role==='user'?'outgoing':'incoming'));row.dataset.messageId=m.id;
        const header=el('div','','message-heading');header.append(el('span',m.role==='user'?'You':author,'message-author'));
        const action=el('button','','message-actions');action.type='button';action.dataset.messageActions=m.id;action.setAttribute('aria-label','Message actions');action.innerHTML=icon('more');header.append(action);
        row.append(header,el('div','','bubble rich-body'),el('span','','message-time'));
      }
      row.classList.toggle('bookmarked',bookmarks.has(m.id));
      const content=body(m);if(row._body!==content){richText(row.querySelector('.bubble'),content);row._body=content;}
      const stamp=formatter.format(new Date(m.createdAt));
      const statusText=stamp+(m.role==='user'?' · '+(!m.saved?'Sending':answered.has(m.id)?'Saved':'Awaiting reply'):'')+(bookmarks.has(m.id)?' · Bookmarked':'');
      if(row._stamp!==statusText){row.querySelector('.message-time').textContent=statusText;row._stamp=statusText;}
      if(panel.children[i]!==row)panel.insertBefore(row,panel.children[i]||null);
    }
    if(!selected.length){const empty=el('div','','chat-empty');empty.append(el('h2',query?'No matching messages':savedOnly?'No bookmarks yet':'What’s on your mind?'),el('p',query?'Try a different phrase.':savedOnly?'Bookmark a message from its menu.':'Write a message to '+author+'.'));panel.append(empty);}
    if(first){first=false;if(savedPosition?.id){const row=[...panel.children].find(n=>n.dataset.messageId===savedPosition.id);if(row)panel.scrollTop+=row.getBoundingClientRect().top-panel.getBoundingClientRect().top-savedPosition.offset;else panel.scrollTop=panel.scrollHeight;}else panel.scrollTop=panel.scrollHeight;}
    else if(!query&&!savedOnly){if(anchor.bottom){panel.scrollTop=panel.scrollHeight;jump.hidden=true;}else{const row=[...panel.children].find(n=>n.dataset.messageId===anchor.id);if(row)panel.scrollTop+=row.getBoundingClientRect().top-panel.getBoundingClientRect().top-anchor.offset;if(next.some(m=>!oldIds.has(m.id)))jump.hidden=false;}}
  }
  return {update,search(value){query=value.trim().toLowerCase();savedOnly=false;update(messages);panel.scrollTop=0;},bookmarks(){savedOnly=!savedOnly;query='';update(messages);panel.scrollTop=0;return savedOnly;},latest(){query='';savedOnly=false;update(messages);panel.scrollTop=panel.scrollHeight;},savePosition(){writeLocal('jarvis.'+channel+'.reading.v1',position());},actions:showActions};
}
