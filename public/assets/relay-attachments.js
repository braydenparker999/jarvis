// Local, memory-only file drafts. Uploading requires an explicitly supplied
// transport; selection and previews never imply server acceptance.
export const RELAY_ATTACHMENT_TYPES=Object.freeze(['image/png','image/jpeg','image/webp','application/pdf','text/plain','text/markdown','text/csv','application/json']);
export function createAttachmentDraft({maxFiles=4,maxBytes=1024*1024,onChange=()=>{},preview=async()=>null,upload=null}={}){
  let items=[],notice='';const emit=()=>onChange(snapshot());
  const snapshot=()=>({items:items.map(({file,abort,...item})=>({...item})),notice,available:typeof upload==='function'});
  function remove(id){const item=items.find(item=>item.id===id);item?.abort?.abort();items=items.filter(item=>item.id!==id);emit();}
  async function add(files){
    notice='';
    for(const file of files){
      if(items.length>=maxFiles){notice=`Choose up to ${maxFiles} files.`;break;}
      if(!file.size||file.size>maxBytes){notice=`${file.name}: choose a nonempty file under ${Math.round(maxBytes/1024/1024)} MB.`;continue;}
      if(!RELAY_ATTACHMENT_TYPES.includes(file.type)){notice=`${file.name}: choose PNG, JPEG, WebP, PDF, plain text, Markdown, CSV or JSON.`;continue;}
      if(items.some(item=>item.name===file.name&&item.size===file.size&&item.modified===file.lastModified)){notice='That file is already selected.';continue;}
      const item={id:crypto.randomUUID(),file,name:file.name,size:file.size,type:file.type,modified:file.lastModified,status:'selected',progress:0,error:'',preview:null,attachment:null};items.push(item);emit();
      try{const value=await preview(file);if(items.includes(item)){item.preview=value;emit();}}catch{if(items.includes(item)){item.error='Preview unavailable. The selected file is unchanged.';emit();}}
    }
    emit();
  }
  async function start(){
    if(!upload){notice='Sending attachments is not available yet. Files remain on this device.';emit();return false;}
    await Promise.all(items.filter(item=>!['uploading','ready'].includes(item.status)).map(async item=>{
      const abort=new AbortController();item.abort=abort;item.status='uploading';item.error='';item.progress=0;emit();
      try{
        const accepted=await upload(item.file,{id:item.id,signal:abort.signal,onProgress:value=>{if(items.includes(item)&&!abort.signal.aborted&&Number.isFinite(value)){item.progress=Math.max(item.progress,Math.min(99,Math.max(0,value)));emit();}}});
        if(!items.includes(item)||abort.signal.aborted)return;
        if(!accepted||typeof accepted.id!=='string'||!accepted.id)throw Error('No upload receipt');
        item.attachment=accepted;item.status='ready';item.progress=100;emit();
      }catch{if(items.includes(item)&&!abort.signal.aborted){item.status='error';item.error='Upload failed. Your file is still selected; retry or remove it.';emit();}}
    }));return items.length>0&&items.every(item=>item.status==='ready');
  }
  return {snapshot,add,remove,start,clear(){for(const item of items)item.abort?.abort();items=[];notice='';emit();}};
}

export function createRelayAttachmentUI({getContext,openSheet,notify,document:doc=document}={}){
  const drafts=new Map();let activeKey=null,dialog=null,lastInput=null,lastDialog=null,lastSignature='';
  const make=(tag,text='',cls='')=>{const n=doc.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
  const preview=file=>new Promise((resolve,reject)=>{
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){resolve(null);return;}
    const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);
  });
  function current(){if(!activeKey)return null;if(!drafts.has(activeKey))drafts.set(activeKey,createAttachmentDraft({preview,onChange:render}));return drafts.get(activeKey);}
  function removeButton(item,draft){const button=make('button',item.status==='uploading'?'Cancel':'Remove','text-button');button.type='button';button.dataset.attachmentId=item.id;button.setAttribute('aria-label','Remove '+item.name);button.onclick=()=>draft.remove(item.id);return button;}
  function render(){
    const draft=current(),state=draft?.snapshot();
    const input=doc.querySelector('.composer-input'),signature=JSON.stringify([activeKey,state?.notice,state?.items.map(item=>[item.id,item.status,item.progress,item.error,!!item.preview])]);
    if(input===lastInput&&dialog===lastDialog&&signature===lastSignature&&(!state?.items.length||doc.querySelector('.relay-attachment-summary')))return;
    lastInput=input;lastDialog=dialog;lastSignature=signature;
    const focused=doc.activeElement,focusedId=focused?.dataset.attachmentId,insideDialog=dialog?.contains(focused);
    doc.querySelector('.relay-attachment-summary')?.remove();
    const plus=doc.getElementById('relay-compose-menu');if(plus){plus.hidden=!activeKey;plus.setAttribute('aria-label','Attach images or files'+(state?.items.length?` (${state.items.length} selected)` :''));plus.dataset.count=String(state?.items.length||0);}
    if(input&&state?.items.length){const summary=make('div','','relay-attachment-summary');summary.append(make('p',`${state.items.length} file${state.items.length===1?'':'s'} selected · not sent`));for(const item of state.items){const row=make('div','','relay-attachment-chip');row.append(make('span',item.name),removeButton(item,draft));summary.append(row);}input.before(summary);}
    if(!dialog?.isConnected){if(focusedId)(doc.querySelector('.relay-attachment-chip button')||plus)?.focus({preventScroll:true});return;}
    const list=dialog.querySelector('.relay-attachment-list'),status=dialog.querySelector('[role=status]');list.replaceChildren();
    status.textContent=state?.notice||'Files stay on this device. Sending attachments is not available yet.';
    for(const item of state?.items||[]){const row=make('article','','relay-attachment-item');if(item.preview){const image=make('img');image.src=item.preview;image.alt='Preview of '+item.name;row.append(image);}const info=make('div');info.append(make('p',item.name,'relay-attachment-name'),make('p',`${Math.ceil(item.size/1024)} KB · ${item.status==='selected'?'Selected on this device':item.status==='ready'?'Uploaded, not sent':item.status==='uploading'?'Uploading':'Upload needs retry'}`,'request-meta'));if(item.status==='uploading'){const progress=make('progress');progress.max=100;progress.value=item.progress;progress.setAttribute('aria-label','Uploading '+item.name);info.append(progress);}if(item.error)info.append(make('p',item.error,'relay-owner-error'));row.append(info,removeButton(item,draft));list.append(row);}
    if(focusedId){const region=insideDialog?dialog:doc.querySelector('.relay-attachment-summary');const next=[...region?.querySelectorAll('[data-attachment-id]')||[]].find(node=>node.dataset.attachmentId===focusedId)||region?.querySelector('button')||plus;next?.focus({preventScroll:true});}
  }
  function sync(){const context=getContext();if(!context.ownerAuthorized)for(const [key,draft]of drafts)if(key.startsWith('owner:')){draft.clear();drafts.delete(key);}activeKey=context.ownerAuthorized&&context.key?.startsWith('owner:')?context.key:null;render();}
  function open(){sync();if(!activeKey){notify('Connect to private chat before selecting files.');return;}if(dialog?.isConnected)return;
    dialog=openSheet('Attachments',[]);dialog.classList.add('relay-attachment-sheet');dialog.setAttribute('aria-label','Attachments');trapRelayDialogFocus(dialog);
    const pickerKey=activeKey,pickerDraft=current();
    const controls=make('div','','relay-attachment-actions');
    for(const [label,accept]of [['Choose images','image/png,image/jpeg,image/webp'],['Choose files',RELAY_ATTACHMENT_TYPES.join(',')]]){const input=make('input');input.type='file';input.multiple=true;input.accept=accept;input.hidden=true;input.setAttribute('aria-label',label);input.onchange=()=>{const context=getContext();if(activeKey===pickerKey&&context.key===pickerKey&&(!pickerKey.startsWith('owner:')||context.ownerAuthorized))pickerDraft.add([...input.files]);input.value='';};const button=make('button',label,'sheet-action');button.type='button';button.onclick=()=>input.click();controls.append(button,input);}
    dialog.append(make('p','Preview up to 4 files, 1 MB each. Files are kept in this tab only.','sheet-context'),controls,make('div','','relay-attachment-list'));
    const status=make('p','','sheet-context');status.setAttribute('role','status');dialog.append(status);dialog.addEventListener('close',()=>{dialog=null;},{once:true});render();
  }
  // Keep text-only delivery from silently dropping selected files while the
  // actual authenticated attachment transport is unavailable.
  doc.addEventListener('submit',event=>{if(!event.target.querySelector?.('.composer-input')||!current()?.snapshot().items.length)return;event.preventDefault();event.stopImmediatePropagation();notify('Attachments are not ready to send. Remove selected files to send text only.');open();},true);
  return {open,sync};
}

export function trapRelayDialogFocus(dialog){
  dialog.addEventListener('keydown',event=>{if(event.key!=='Tab')return;const nodes=[...dialog.querySelectorAll('button:not(:disabled),a[href],input:not([hidden]):not(:disabled),select,textarea,[tabindex="0"]')].filter(node=>node.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}});
}
