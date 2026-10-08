const uuid = value => typeof value==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const canonical = value => Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'
  ?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);

export function validatePublicEvent(event) {
  if (!event || !['jarvis-coordination-v2','jarvis-publication-v1-update'].includes(event.schema) ||
      !uuid(event.eventId) || !uuid(event.requestId) || !uuid(event.attemptId) ||
      !['receipt','progress','final','correction'].includes(event.stage) || !['accepted','conflict'].includes(event.disposition) ||
      typeof event.body!=='string' || !event.body.trim() || event.body.length>6000 ||
      !Number.isSafeInteger(event.sequence) || event.sequence<1 || !Number.isFinite(Date.parse(event.recordedAt)) ||
      event.visibility!=='public' || event.author_authenticated!==false || event.execution_authorized!==false ||
      !['muse','jarvis'].includes(event.destination) || !Array.isArray(event.artifacts) || event.artifacts.length>8 ||
      event.provenance?.source!=='github-issue' || event.provenance.repository!=='braydenparker999/jarvis' ||
      event.provenance.issue!==2 || event.provenance.authorId!==183016859 ||
      !Number.isSafeInteger(event.provenance.commentId) || event.provenance.commentId<1 || !Number.isFinite(Date.parse(event.provenance.publishedAt)))
    throw Error('The inbox returned an invalid public report. Saved messages and the previous cursor have been preserved.');
  if (['final','correction'].includes(event.stage) && (!Number.isSafeInteger(event.resultVersion) || event.resultVersion<1) ||
      event.stage==='correction'&&!uuid(event.supersedesEventId))throw Error('The inbox returned an invalid result version.');
  for (const item of event.artifacts) {
    let url;try{url=new URL(item.url);}catch{}
    if(!uuid(item.id)||!Number.isSafeInteger(item.revision)||item.revision<1||typeof item.label!=='string'||!item.label.trim()||item.label.length>120||
      typeof item.url!=='string'||item.url.length>2048||!url||url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')
      throw Error('The inbox returned an invalid artifact revision.');
  }
  return event;
}
export function mergePublicEvents(known, received) {
  const events=new Map(known.map(event=>[event.eventId,event]));
  for(const candidate of received){
    const event=validatePublicEvent(candidate),previous=events.get(event.eventId);
    if(previous&&canonical(previous)!==canonical(event))throw Error('A saved immutable public report changed. The previous cursor has been preserved.');
    events.set(event.eventId,event);
  }
  return [...events.values()].sort((a,b)=>a.sequence-b.sequence);
}
export const publicReportLabel = message => {
  if(message.kind!=='coordination')return '';
  const report=message.publicReport;
  if(report.disposition==='conflict')return 'Public version conflict · '+report.errorCode;
  if(report.schema==='jarvis-publication-v1-update')return 'Later public reply · original kept';
  return {receipt:'Public receipt report',progress:'Public progress report',final:'Public final report',correction:'Public correction'}[report.stage]+
    (report.resultVersion?' · version '+report.resultVersion:'');
};
export function publicEventMessages(events) {
  return events.map(event=>({id:'coordination:'+event.eventId,role:'assistant',kind:'coordination',replyTo:event.requestId,
    body:event.body,createdAt:event.recordedAt,destination:event.destination,publicReport:event}));
}

export async function readPublicPages(cloud, {requestId, cursor, events=[]}={}) {
  const exact=!!requestId,prefix=exact?'pr2:'+requestId+':':'pc2:',pattern=new RegExp('^'+prefix+'(0|[1-9]\\d{0,14})(?::(0|[1-9]\\d{0,14}))?$');
  let token=cursor||prefix+'0',snapshot=null,last=Number(pattern.exec(token)?.[1]||0),data;
  const received=[],entries=[],seen=new Set();
  do {
    const params=new URLSearchParams({cursor:token});if(exact)params.set('requestId',requestId);
    data=await cloud((exact?'/shared/result?':'/shared/changes?')+params);
    const done=pattern.exec(data.cursor||''),next=data.nextCursor===null?null:pattern.exec(data.nextCursor||'');
    if(data.mode!=='github-publications'||data.coordinationVersion!==2||!done||done[2]!==undefined||Number(done[1])<last||
      snapshot!==null&&Number(done[1])!==snapshot||data.nextCursor!==null&&(!next||next[2]===undefined||Number(next[1])<=last||Number(next[2])!==Number(done[1])||seen.has(data.nextCursor))||
      data.public_inbox!==true||data.author_authenticated!==false||data.execution_authorized!==false)
      throw Error('Public update pagination failed. The previous cursor has been preserved.');
    snapshot=Number(done[1]);
    if(exact){
      if(data.message?.id!==requestId||data.message.role!=='user'||!Array.isArray(data.events))throw Error('The public result target could not be confirmed.');
      if(data.events.some(event=>event.requestId!==requestId)||next&&!data.events.length)throw Error('The public result page skipped its target.');
      received.push(...data.events);
    }else{
      if(!Array.isArray(data.changes))throw Error('The public change page is unreadable.');
      for(const change of data.changes){
        if(!Number.isSafeInteger(change.sequence)||change.sequence<=last||change.sequence>snapshot)throw Error('Public change sequence failed. The previous cursor has been preserved.');
        last=change.sequence;
        if(change.kind==='event')received.push(change.event);
        else if(change.kind==='entry'&&change.entry&&typeof change.entry.body==='string'&&Number.isFinite(Date.parse(change.entry.createdAt)))entries.push(change.entry);
        else throw Error('The public change page is unreadable.');
      }
      if(next&&Number(next[1])!==last)throw Error('The public change cursor skipped entries.');
    }
    if(next)last=Number(next[1]);
    token=data.nextCursor;seen.add(token);
  }while(token!==null);
  return {...data,events:mergePublicEvents(events,received),entries};
}
