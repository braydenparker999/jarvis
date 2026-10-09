import { createRelayOwnerApi, OwnerApiError, normalizeOwnerJobCompletion } from './relay-owner-api.js';
import { icon, autosize, copyText, richText } from './ui.js';
import { createOwnerDraftStore } from './relay-draft-store.js';

// Private history and failed sends exist only in this closure; unsent drafts
// also survive in tab storage. In particular,
// never pass them to conversation(), public submitMessage() or shared sync.
export function createRelayOwnerController({ api = createRelayOwnerApi(), draftStore = createOwnerDraftStore(), uuid = () => crypto.randomUUID(), onModeChange = () => {} } = {}) {
  const listeners = new Set();
  let generation = 0, reading = null, failedSend = null, cursor = '0', accountConsent = null, detailEpoch = 0;
  let jobCursor='0',jobFence=null,jobChangesSupported=typeof api.jobChanges==='function',jobResetCache=null,jobReading=null;
  const retryAttempts=new Map();
  let state = { mode: api.selectedMode==='owner'||(api.selectedMode===undefined&&api.hasCredential)?'owner':'public', status: api.hasCredential ? 'unknown' : 'none',
    messages: [], draft: draftStore.read(), devices: [], device: null, pairing: null, error: '', warning: '', busy: false, sending: false, query: '', authenticating: false, account: null, accountReady: false, accountNotice: '', loginDevices: [],
    jobsEnabled:false,jobs:[],jobsError:'',syncStale:false,jobMode:false,jobTitle:'',jobKind:'consequential',jobProject:'',jobGoal:'',requestsOnly:false,workFilter:'all',sendUnconfirmed:false,sendNotice:'',jobDetailId:null,jobDetail:null,jobDetailBusy:false,jobDetailError:'',jobDetailStale:false,jobBusy:false };
  const emit = () => { for (const listener of listeners) listener(); };
  const mode = next => { if (next !== state.mode) { state.mode = next; onModeChange(next); } emit(); };
  function clearPrivate({preserveDraft = false} = {}) { state.loginDevices = []; accountConsent = null; state.account = null; state.accountReady = false; state.accountNotice = ''; state.messages = []; if (!preserveDraft) {state.draft = '';draftStore.save('');} state.devices = []; state.device = null; failedSend = null; cursor = '0';
    jobCursor='0';jobFence=null;jobChangesSupported=typeof api.jobChanges==='function';jobResetCache=null;jobReading=null;
    ++detailEpoch;retryAttempts.clear();state.jobsEnabled=false;state.jobs=[];state.jobsError='';state.syncStale=false;state.query='';state.jobMode=false;state.jobTitle='';state.jobKind='consequential';state.jobProject='';state.jobGoal='';state.requestsOnly=false;state.workFilter='all';state.sendUnconfirmed=false;state.sendNotice='';state.jobDetailId=null;state.jobDetail=null;state.jobDetailBusy=false;state.jobDetailError='';state.jobDetailStale=false;state.jobBusy=false; }
  function failure(error) {
    const safe = error instanceof OwnerApiError ? error : new OwnerApiError('network');
    state.error = safe.message;
    if(['network','unavailable','invalid'].includes(safe.kind))state.syncStale=true;
    if (['expired', 'revoked', 'unauthorized'].includes(safe.kind)) {
      // Invalidate every concurrent read/send, including a response which was
      // authenticated before another operation confirmed revocation.
      ++generation; reading = null; state.busy = false; state.sending = false; state.authenticating = false; api.cancelAuthentication?.();
      clearPrivate({preserveDraft: safe.kind === 'expired'}); state.pairing = null;
      state.status = ['expired', 'revoked'].includes(safe.kind) ? safe.kind : 'unknown';
      emit();
    }
    return safe;
  }
  async function readMessages(epoch) {
    let after = cursor;
    const seen = new Set([after]);
    do {
      const data = await api.messages(after);
      if (epoch !== generation) return;
      const map = new Map(state.messages.map(m => [m.id, m]));
      for (const message of data.messages) map.set(message.id, { ...message, saved: true });
      state.messages = [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      // Every successful page is an authenticated use. Keep the last received
      // numeric position so later reads are incremental even when nextCursor=null.
      if (data.messages.length) {
        const final = data.messages.at(-1);
        if (/^\d{1,15}$/.test(String(final.sequence))) cursor = String(final.sequence);
      }
      if (data.nextCursor !== null) {
        const next = String(data.nextCursor);
        if (seen.has(next) || Number(next) <= Number(after)) throw new OwnerApiError('invalid');
        seen.add(next); cursor = next; after = next;
      } else after = null;
    } while (after !== null);
    // Entry sequences are append-only; transport state is mutable. Refresh that
    // evidence separately so an incremental history cursor cannot hide failures.
    const replied=new Set(state.messages.filter(m=>m.replyTo).map(m=>m.replyTo));
    const recent=Date.now()-30*86400000;
    const ids=state.messages.filter(m=>m.role==='user'&&m.delivery&&!replied.has(m.id)&&Date.parse(m.createdAt)>=recent).map(m=>m.id);
    for(const message of state.messages)if(replied.has(message.id)&&message.delivery)message.delivery={...message.delivery,state:'reply_saved',retryable:false,retryAfter:null};
    if(api.deliveries)for(let i=0;i<ids.length;i+=50){
      const result=await api.deliveries(ids.slice(i,i+50));
      if(epoch!==generation)return;
      const updates=new Map(result.deliveries.map(d=>[d.message_id,d]));
      for(const message of state.messages)if(updates.has(message.id)){
        const {message_id,...delivery}=updates.get(message.id);message.delivery=delivery;
      }
    }
  }
  async function readJobs(epoch){
    if(jobReading?.epoch===epoch){await jobReading.promise;if(epoch!==generation)return;return readJobs(epoch);}
    const reading={epoch,promise:null};jobReading=reading;reading.promise=readJobPages(epoch);
    try{return await reading.promise;}finally{if(jobReading===reading)jobReading=null;}
  }
  async function readJobPages(epoch){
    if(!state.jobsEnabled||!api.jobs&&!api.jobChanges)return;
    try{
      if(jobChangesSupported){
        const seen=new Set();let complete=false,resetOnce=false;
        // Cache and committed cursor stay together in this private closure. A
        // reload starts from zero; a failed page resumes from the last good one.
        // Bound one refresh even while a large migration or active writers run.
        for(let page=0;page<20;++page){
          const position=jobCursor+':'+(jobFence??'fresh');
          if(seen.has(position))throw new OwnerApiError('invalid');seen.add(position);
          let data;
          try{data=await api.jobChanges(jobCursor,jobFence);}
          catch(error){
            if(epoch!==generation)return;
            if(error instanceof OwnerApiError&&[404,405].includes(error.status)){jobChangesSupported=false;return readJobPages(epoch);}
            if(error?.jobCursorReset&&!resetOnce){resetOnce=true;jobCursor='0';jobFence=null;jobResetCache=new Map();seen.clear();continue;}
            throw error;
          }
          if(epoch!==generation)return;
          const valid=value=>typeof value==='string'&&/^\d{1,15}$/.test(value)&&Number.isSafeInteger(Number(value));
          if(!data||!Array.isArray(data.changes)||data.changes.length>50||!valid(data.cursor)||!valid(data.through)
            ||Number(data.cursor)<Number(jobCursor)||Number(data.cursor)>Number(data.through)||typeof data.bootstrapPending!=='boolean'
            ||jobFence!==null&&data.through!==jobFence
            ||!(data.nextCursor===null&&data.cursor===data.through||data.nextCursor===data.cursor&&Number(data.cursor)<Number(data.through)))throw new OwnerApiError('invalid');
          const updates=data.changes.map((change,i)=>{
            if(!change||!valid(change.cursor)||Number(change.cursor)<=Number(jobCursor)||Number(change.cursor)>Number(data.cursor)
              ||i>0&&Number(change.cursor)<=Number(data.changes[i-1].cursor))throw new OwnerApiError('invalid');
            return normalizeOwnerJobCompletion(change.job);
          });
          if(new Set(updates.map(job=>job.id)).size!==updates.length
            ||data.nextCursor!==null&&(!updates.length||data.changes.at(-1).cursor!==data.cursor))throw new OwnerApiError('invalid');
          const jobs=new Map(jobResetCache??state.jobs.map(job=>[job.id,job]));
          for(const job of updates)jobs.set(job.id,job);
          if(jobResetCache)jobResetCache=jobs;else state.jobs=[...jobs.values()].sort((a,b)=>a.sequence-b.sequence);
          jobCursor=data.cursor;jobFence=data.nextCursor===null?null:data.through;
          if(data.nextCursor===null&&!data.bootstrapPending){complete=true;break;}
        }
        if(!complete){state.jobsError='Private request history is still refreshing. Refresh again to continue.';state.syncStale=true;return;}
        if(jobResetCache){state.jobs=[...jobResetCache.values()].sort((a,b)=>a.sequence-b.sequence);jobResetCache=null;}
      }else{
        // Restored older services retain their original creation-page contract.
        let after='0';const seen=new Set([after]),jobs=new Map();
        do{
          const data=await api.jobs(after);if(epoch!==generation)return;
          for(const job of data.jobs)jobs.set(job.id,normalizeOwnerJobCompletion(job));
          if(data.nextCursor!==null){const next=String(data.nextCursor);if(seen.has(next)||Number(next)<=Number(after))throw new OwnerApiError('invalid');seen.add(next);after=next;}else after=null;
        }while(after!==null);
        state.jobs=[...jobs.values()].sort((a,b)=>a.sequence-b.sequence);
      }
      state.jobsError='';state.syncStale=false;
      if(state.jobDetailId)await controller.inspectJob(state.jobDetailId,{refresh:true});
    }catch(error){if(epoch!==generation)return;const safe=error instanceof OwnerApiError?error:new OwnerApiError('network');if(['expired','revoked','unauthorized'].includes(safe.kind))failure(safe);else{state.jobsError=safe.message;state.syncStale=true;}}
  }
  function mergeJob(job){const jobs=new Map(state.jobs.map(j=>[j.id,j]));jobs.set(job.id,normalizeOwnerJobCompletion(job));state.jobs=[...jobs.values()].sort((a,b)=>a.sequence-b.sequence);}
  const controller = {
    get mode() { return state.mode; },
    get hasCredential() { return api.hasCredential; },
    get status() { return state.status; },
    snapshot() { return structuredClone(state); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setDraft(value) { state.draft = value.slice(0, 4000); const saved = draftStore.save(state.draft); if (!saved) state.warning = 'Could not retain this private draft in the tab. Copy it before leaving.'; return saved; },
    setQuery(value) { state.query = value.trim().toLowerCase(); emit(); },
    setWorkFilter(value){if(['all','queued','working','blocked','finished'].includes(value)){state.workFilter=value;emit();}},
    setJobMode(value){if(!state.jobsEnabled||state.sending)return;state.jobMode=value===true;state.sendUnconfirmed=false;emit();},
    setJobTitle(value){state.jobTitle=value.slice(0,120);},
    setJobProject(value){state.jobProject=value.slice(0,120);},
    setJobGoal(value){state.jobGoal=value.slice(0,120);},
    setJobKind(value){if(['read_only','draft','consequential'].includes(value)){state.jobKind=value;emit();}},
    toggleRequests(){state.requestsOnly=!state.requestsOnly;state.query='';emit();},
    closeJobDetail(){++detailEpoch;state.jobDetailId=null;state.jobDetail=null;state.jobDetailBusy=false;state.jobDetailError='';state.jobDetailStale=false;emit();},
    connect() {
      api.selectMode?.('owner');
      ++generation; reading = null; state.busy = false; state.sending = false; state.authenticating = false; state.loginDevices = []; accountConsent = null; state.accountReady = false; api.cancelAuthentication?.();
      state.error = ''; state.pairing = null; state.status = 'none'; api.cancelPairing(); mode('pairing');
    },
    cancelSensitive() {
      if (!state.authenticating && state.mode !== 'account' && !state.loginDevices.length) return;
      ++generation; reading = null; accountConsent = null; state.accountReady = false;
      state.authenticating = false; state.loginDevices = []; state.busy = false; api.cancelAuthentication?.(); emit();
    },
    showPublic() { api.selectMode?.('public');controller.closeJobDetail();controller.cancelSensitive(); mode('public'); },
    showOwner() { api.selectMode?.('owner');controller.closeJobDetail();controller.cancelSensitive(); mode(api.hasCredential ? 'owner' : 'pairing'); },
    async login(username, password, label, remember = false, replacement = {}) {
      if (state.busy || state.sending) return;
      if (replacement.deviceId !== undefined && (replacement.confirmed !== true || !state.loginDevices.some(d => d.id === replacement.deviceId))) { state.error = 'Choose an active device session and confirm its replacement.'; emit(); return; }
      const epoch = ++generation;
      api.cancelPairing(); state.pairing = null; state.busy = true; state.authenticating = true; state.error = ''; emit();
      try {
        const data = await api.login(username, password, label.trim().slice(0, 80) || 'This browser', { remember: remember === true, ...(replacement.deviceId === undefined ? {} : { replaceDeviceId: replacement.deviceId, confirmReplacement: true }) });
        if (epoch !== generation) return;
        clearPrivate({preserveDraft: true}); state.device = data.device; state.status = 'approved'; state.warning = api.storageWarning;state.jobsEnabled=data.jobs_enabled===true;
        state.authenticating = false; mode('owner'); await readMessages(epoch);await readJobs(epoch);
      } catch (error) { if (epoch === generation) { if (error instanceof OwnerApiError && error.kind === 'device_limit') state.loginDevices = error.devices;
          if (error instanceof OwnerApiError && error.kind === 'device_unavailable') state.loginDevices = []; failure(error); } }
      finally { if (epoch === generation) { state.busy = false; state.authenticating = false; emit(); } }
    },
    async showAccount() {
      if (state.busy || state.sending) return;
      if (!api.hasCredential) { controller.connect(); return; }
      controller.closeJobDetail();
      const epoch = ++generation;
      accountConsent = null; state.account = null; state.accountReady = false; state.accountNotice = ''; state.error = '';
      state.busy = true; mode('account');
      try {
        const account = await api.credentials();
        if (epoch !== generation) return;
        state.account = { configured: account.configured, ...(account.configured ? { username: account.username } : {}) };
        const prepared = await api.prepareCredentials(account.configured ? 'change' : 'setup');
        if (epoch !== generation) return;
        accountConsent = prepared.consent_token; state.accountReady = true;
      } catch (error) { if (epoch === generation) failure(error); }
      finally { if (epoch === generation) { state.busy = false; emit(); } }
    },
    async saveCredentials({ username, password, confirmation, currentPassword, consent }) {
      if (state.busy || !state.accountReady || !accountConsent) return;
      if (consent !== true) { state.error = 'Confirm that you want to save this account sign-in.'; emit(); return; }
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username.trim().toLowerCase())) { state.error = 'Use a username of 3–32 letters, numbers, dots, underscores or hyphens, starting with a letter or number.'; emit(); return; }
      if (password.length < 16 || password.length > 128 || new TextEncoder().encode(password).length > 256) { state.error = 'Use a password of 16–128 characters and no more than 256 bytes.'; emit(); return; }
      if (password !== confirmation) { state.error = 'The new passwords do not match. Enter them again.'; emit(); return; }
      const epoch = generation, consentToken = accountConsent, change = state.account.configured;
      accountConsent = null; state.accountReady = false; state.busy = true; state.error = ''; emit();
      try {
        const data = await api.saveCredentials({ username, password, password_confirmation: confirmation, consent_token: consentToken,
          ...(change ? { current_password: currentPassword } : {}) });
        if (epoch !== generation) return;
        state.account = { configured: data.configured, username: data.username };
        state.accountNotice = 'Account sign-in saved. You can sign in here with your username and password after clearing browser data. Existing device sessions remain active.';
      } catch (error) { if (epoch === generation) failure(error); }
      finally { if (epoch === generation) { state.busy = false; emit(); } }
    },
    async startPairing(label, remember = false) {
      if (state.busy) return;
      const epoch = ++generation;
      state.busy = true; state.error = ''; state.pairing = null; state.status = 'none'; emit();
      try {
        const pairing = await api.startPairing(label.trim().slice(0, 80) || 'This phone', { remember: remember === true });
        if (epoch !== generation) return;
        clearPrivate({preserveDraft: true}); state.pairing = pairing; state.status = 'pending';
      } catch (error) { if (epoch === generation) failure(error); }
      finally { if (epoch === generation) { state.busy = false; emit(); } }
    },
    async checkPairing() {
      if (!state.pairing || state.status !== 'pending' || state.busy) return;
      const epoch = generation;
      state.busy = true; state.error = ''; emit();
      try {
        const data = await api.pairingStatus();
        if (epoch !== generation) return;
        state.status = data.status;
        if (data.status === 'approved') {
          state.device = data.device; state.pairing = null; state.warning = api.storageWarning;state.jobsEnabled=data.jobs_enabled===true;
          if (state.mode === 'pairing') mode('owner');
          await readMessages(epoch);
          await readJobs(epoch);
        }
      } catch (error) { if (epoch === generation) failure(error); }
      finally { if (epoch === generation) { state.busy = false; emit(); } }
    },
    async refresh() {
      if (!api.hasCredential || state.status === 'pending') return;
      if (reading) return reading;
      const epoch = generation;
      state.busy = true; state.error = ''; if (state.status === 'unknown') state.status = 'checking'; emit();
      const task = (async () => {
        try {
          const data = await api.session();
          if (epoch !== generation) return;
          state.status = 'approved'; state.device = data.device; state.warning = api.storageWarning;state.jobsEnabled=data.jobs_enabled===true;
          await readMessages(epoch);
          await readJobs(epoch);
        } catch (error) { if (epoch === generation) { failure(error); if (state.status === 'checking') state.status = 'unknown'; } }
        finally { if (epoch === generation) { state.busy = false; emit(); } }
      })();
      reading = task;
      try { await task; } finally { if (reading === task) reading = null; }
    },
    async send({retryOriginal=false}={}) {
      if (state.sending || state.status !== 'approved'||state.mode!=='owner') return;
      const draftBody=state.draft.trim();if(!draftBody&&!retryOriginal)return;
      if(state.jobMode&&!state.jobTitle.trim()&&!retryOriginal){state.error='Give this private request a short title.';emit();return;}
      if(state.jobMode&&state.jobGoal.trim()&&!state.jobProject.trim()&&!retryOriginal){state.error='Give this goal a project name.';emit();return;}
      const epoch = generation;
      const specification=state.jobMode?{title:state.jobTitle.trim(),actionKind:state.jobKind,projectTitle:state.jobProject.trim(),goalTitle:state.jobGoal.trim()}:{};
      const unchanged=failedSend&&failedSend.body===draftBody&&failedSend.jobMode===state.jobMode&&failedSend.title===specification.title&&failedSend.actionKind===specification.actionKind&&failedSend.projectTitle===specification.projectTitle&&failedSend.goalTitle===specification.goalTitle;
      if(failedSend&&!unchanged&&!retryOriginal){state.sendUnconfirmed=true;state.error='Your earlier request is unconfirmed. Retry its original details before sending an edited request.';emit();return;}
      const item=failedSend||{id:uuid(),body:draftBody,jobMode:state.jobMode,...specification};
      let accepted=false;
      failedSend = item; state.sending = true; state.error = '';state.sendUnconfirmed=false;state.sendNotice=''; emit();
      try {
        const data=item.jobMode?await api.createJob(item):await api.sendMessage(item.id, item.body);
        if (epoch !== generation) return;
        accepted=true;if(data.job)mergeJob(data.job);
        const matches=state.draft.trim()===item.body&&state.jobMode===item.jobMode&&(!item.jobMode||state.jobTitle.trim()===item.title&&state.jobKind===item.actionKind&&state.jobProject.trim()===item.projectTitle&&state.jobGoal.trim()===item.goalTitle);
        if(matches){state.draft='';draftStore.save('');state.jobTitle='';state.jobProject='';state.jobGoal='';state.jobMode=false;}else state.sendNotice='Earlier request confirmed · your edited draft is still here';
        failedSend = null;
        await readMessages(epoch);
        await readJobs(epoch);
      } catch (error) { if (epoch === generation) {state.sendUnconfirmed=!accepted;failure(error);} }
      finally { if (epoch === generation) { state.sending = false; emit(); } }
    },
    retryUnconfirmed(){if(failedSend)return controller.send({retryOriginal:true});},
    async inspectJob(id,{refresh=false}={}){
      if(state.status!=='approved'||state.mode!=='owner'||!state.jobsEnabled)return;
      const epoch=generation,detail=++detailEpoch;
      state.jobDetailId=id;state.jobDetailError='';state.jobDetailBusy=true;
      if(!refresh){state.jobDetail=state.jobs.find(j=>j.id===id)?{job:state.jobs.find(j=>j.id===id),events:[]}:null;state.jobDetailStale=false;}
      emit();
      try{const data=await api.jobDetail(id);if(epoch!==generation||detail!==detailEpoch||state.jobDetailId!==id)return;const job=normalizeOwnerJobCompletion(data.job);state.jobDetail={...data,job};state.jobDetailStale=false;mergeJob(job);}
      catch(error){if(epoch===generation&&detail===detailEpoch){const safe=error instanceof OwnerApiError?error:new OwnerApiError('network');if(['expired','revoked','unauthorized'].includes(safe.kind))failure(safe);else{state.jobDetailError=safe.message;state.jobDetailStale=true;}}}
      finally{if(epoch===generation&&detail===detailEpoch){state.jobDetailBusy=false;emit();}}
    },
    async cancelJob(id){
      const job=state.jobs.find(j=>j.id===id);if(state.jobBusy||state.status!=='approved'||state.mode!=='owner'||!job||job.cancelRequested||['completed','failed','cancelled'].includes(job.stage))return;
      const epoch=generation;state.jobBusy=true;state.jobDetailError='';emit();
      try{const data=await api.cancelJob(id);if(epoch!==generation)return;mergeJob(data.job);await controller.inspectJob(id,{refresh:true});}
      catch(error){if(epoch===generation){const safe=failure(error);state.jobDetailError=safe.message;}}
      finally{if(epoch===generation){state.jobBusy=false;emit();}}
    },
    async retryJob(id,confirmed=false){
      const job=state.jobs.find(j=>j.id===id);if(state.jobBusy||state.status!=='approved'||state.mode!=='owner'||!job?.retryAllowed)return;
      if(job.retryRequiresConfirmation&&confirmed!==true){state.jobDetailError='Confirm the risk of repeating work before creating another attempt.';emit();return;}
      const epoch=generation,item=retryAttempts.get(id)||{id:uuid(),confirmed:confirmed===true};retryAttempts.set(id,item);state.jobBusy=true;state.jobDetailError='';emit();
      try{const data=await api.retryJob(id,item.id,item.confirmed);if(epoch!==generation)return;mergeJob(data.job);retryAttempts.delete(id);await readMessages(epoch);await readJobs(epoch);}
      catch(error){if(epoch===generation){const safe=failure(error);state.jobDetailError=safe.message;}}
      finally{if(epoch===generation){state.jobBusy=false;emit();}}
    },
    async retryDelivery(messageId){
      if(state.busy||state.sending||state.status!=='approved'||state.mode!=='owner'||!state.messages.some(m=>m.id===messageId&&m.delivery?.retryable))return;
      const epoch=generation;state.busy=true;state.error='';emit();
      try{
        await api.retryDelivery(messageId);
        if(epoch!==generation)return;
        await readMessages(epoch);
      }catch(error){if(epoch===generation)failure(error);}
      finally{if(epoch===generation){state.busy=false;emit();}}
    },
    async showDevices() {
      if (!api.hasCredential) { controller.showOwner(); return; }
      if (state.status !== 'approved') await controller.refresh();
      if (state.status !== 'approved') { controller.showOwner(); return; }
      controller.closeJobDetail();controller.cancelSensitive(); mode('devices');
      return controller.refreshDevices();
    },
    async refreshDevices() {
      if (state.busy) return;
      const epoch = generation;
      state.busy = true; state.error = ''; emit();
      try {
        const data = await api.devices();
        if (epoch !== generation) return;
        state.devices = data.devices;
      } catch (error) { if (epoch === generation) failure(error); }
      finally { if (epoch === generation) { state.busy = false; emit(); } }
    },
    async revoke(deviceId) {
      if (state.busy || state.sending) return;
      const epoch = generation, self = deviceId === api.deviceId;
      state.busy = true; state.error = ''; emit();
      try {
        await api.revoke(deviceId);
        if (epoch !== generation) return;
        if (self) { ++generation; clearPrivate(); state.status = 'revoked'; state.warning = api.storageWarning; state.busy = false; mode('owner'); }
        else { state.busy = false; await controller.refreshDevices(); }
      } catch (error) { if (epoch === generation) failure(error); }
      finally { if (epoch === generation) { state.busy = false; emit(); } }
    },
    disconnect() { if (api.deviceId) return controller.revoke(api.deviceId); },
    storedSessionChanged() {
      ++generation; reading = null; clearPrivate(); api.refreshStoredCredential();
      state.status = api.hasCredential ? 'unknown' : 'none'; state.error = ''; state.warning = ''; state.busy = false; state.sending = false; state.authenticating = false; state.pairing = null;
      emit();
      if (state.mode !== 'public' && api.hasCredential) return controller.refresh();
    }
  };
  return controller;
}

const stamp = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Unknown';
const messageStamp=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value)):'Unknown';
const jobLabel=job=>{
  if(job.result&&!job.completion&&!['waiting_for_owner','failed','cancelled'].includes(job.stage))return 'Reply received · completion unverified'+(job.cancelRequested?' · cancellation requested':'');
  if(job.stage==='running'&&job.execution&&Date.parse(job.execution.leaseExpiresAt)<=Date.now())return job.cancelRequested?'Cancellation requested · outcome unconfirmed':'Acknowledgement expired · outcome unconfirmed';
  if(job.cancelRequested&&!['completed','failed','cancelled'].includes(job.stage))return 'Cancellation requested · awaiting acknowledgement';
  return {queued:'Queued · awaiting assistant',running:'Working · owner-connected assistant acknowledged',waiting_for_owner:'Needs your input',completed:job.completion?'Work reported complete':'Completion unverified',failed:'Failed · review details',cancelled:'Cancelled · assistant acknowledged',outcome_unknown:'Outcome unconfirmed · review details'}[job.stage]||'Status unavailable';
};

export function ownerWorkStatus(job, now=Date.now()) {
  if(job.stage==='completed'&&job.completion)return {state:'finished',label:'Finished · work reported complete'};
  if(job.stage==='cancelled')return {state:'finished',label:'Finished · cancellation acknowledged'};
  if(job.cancelRequested)return {state:'blocked',label:'Blocked · cancellation awaiting acknowledgement'};
  if(job.result&&!job.completion&&!['failed','waiting_for_owner'].includes(job.stage))return {state:'blocked',label:'Blocked · completion unverified'};
  if(job.stage==='queued')return {state:'queued',label:'Queued · awaiting assistant'};
  if(job.stage==='running'&&job.execution&&Date.parse(job.execution.leaseExpiresAt)>now)return {state:'working',label:'Working · execution acknowledged'};
  return {state:'blocked',label:job.stage==='waiting_for_owner'?'Blocked · needs your input':job.stage==='failed'?'Blocked · attempt failed':'Blocked · outcome unconfirmed'};
}

export function groupOwnerWork(jobs, {query='', filter='all', now=Date.now()}={}) {
  query=query.trim().toLowerCase();
  const roots=new Map();
  for(const job of jobs){const attempts=roots.get(job.rootJobId)||[];attempts.push(job);roots.set(job.rootJobId,attempts);}
  const tasks=[...roots.values()].map(attempts=>{
    attempts.sort((a,b)=>a.attempt-b.attempt||a.sequence-b.sequence);
    const job=attempts.at(-1);return {job,attempts,status:ownerWorkStatus(job,now)};
  }).filter(({job,attempts})=>job.actionKind!=='unclassified'||job.attempt>1||attempts.some(attempt=>attempt.execution||attempt.completion))
    .filter(({status})=>filter==='all'||status.state===filter)
    .filter(({job})=>!query||[job.title,job.body,job.presentation?.projectTitle,job.presentation?.goalTitle,job.presentation?.latestUpdate?.summary,job.latestResult?.body||job.result?.body,job.latestResult?.correctionSummary].some(text=>text?.toLowerCase().includes(query)));
  tasks.sort((a,b)=>b.job.updatedAt.localeCompare(a.job.updatedAt)||b.job.sequence-a.job.sequence);
  return tasks;
}

function meaningfulUpdate(job, events=[]) {
  if(job.presentation?.latestUpdate)return job.presentation.latestUpdate;
  return events.filter(e=>e.authentication_source==='owner-oauth-mcp'
    &&['claimed','running','waiting_for_owner','failed','cancelled','work_completed','result_corrected'].includes(e.kind)
    &&!(e.kind==='running'&&e.summary==='Authenticated execution progress acknowledged.')).at(-1)||null;
}

export function createRelayOwnerUI({ controller = createRelayOwnerController(), document: doc = globalThis.document } = {}) {
  let root, timer, viewKey = '', chatNodes = null, pairLabel = '', pairRemember = false, readingAnchor=null, detailDialog=null, detailSignature='',detailFocus=null,connectionDialog=null,workSignature='',workVisible=50;
  const sensitiveInputs = new Set();
  function clearSensitiveFields() {
    for (const input of sensitiveInputs) { input.value = ''; if (input.type === 'checkbox') input.checked = false; }
    sensitiveInputs.clear();
  }
  function field(form, labelText, id, { type = 'text', required = true, minLength, maxLength = 128, value = '', sensitive = true } = {}) {
    const label = make('label', labelText); label.htmlFor = id;
    const input = make('input'); input.id = id; input.name = id; input.type = type; input.required = required; input.maxLength = maxLength;
    input.autocomplete = 'off'; input.spellcheck = false; input.autocapitalize = 'none'; input.value = value;
    if (minLength !== undefined) input.minLength = minLength;
    if (sensitive) sensitiveInputs.add(input);
    form.append(label, input); return input;
  }
  function loginForm(section, state) {
    section.append(make('h3', 'Sign in with username and password'), make('p', 'Once account sign-in is set up, use it on this same page after clearing cookies or browser data. No pairing code or other phone is needed to sign in.', 'relay-owner-note'));
    const form = make('form', '', 'relay-owner-auth-form'); form.id = 'relay-owner-login-form'; form.autocomplete = 'off';
    const username = field(form, 'Username', 'relay-owner-login-username', { maxLength: 32 });
    const password = field(form, 'Password', 'relay-owner-login-password', { type: 'password' });
    const label = field(form, 'Device name', 'relay-owner-login-label', { required: false, maxLength: 80, sensitive: false }); label.placeholder = 'For example, my restricted phone';
    const remember = make('label', '', 'relay-owner-remember'), checkbox = make('input');
    checkbox.type = 'checkbox'; checkbox.id = 'relay-owner-login-remember'; checkbox.checked = false;
    remember.append(checkbox, make('span', 'Remember this device session on this browser'));
    const notice = make('p', 'If checked, this browser saves only a device token and device ID. Access expires after exactly 365 days of inactivity and renews on authenticated use. Scripts on this shared website origin can read the token. Anyone using this browser can use this access. Your account username and password and private history are not saved by Relay in browser storage. Unsent drafts are kept in this tab, separate from public Relay drafts. Clearing browser data ends this device session; sign in here again with your account credentials.', 'relay-owner-note');
    notice.id = 'relay-owner-login-storage-notice'; checkbox.setAttribute('aria-describedby', notice.id);
    let replacementSelect = null, replacementConsent = null;
    if (state.loginDevices.length) {
      form.append(make('p', 'Your password was verified, but ten device sessions are already active. Re-enter your username and password and choose exactly one session to revoke and replace. That device will be signed out. Labels are supplied by devices and are not verified.', 'relay-owner-note'));
      const selectLabel = make('label', 'Device session to replace'); selectLabel.htmlFor = 'relay-owner-replace-device';
      replacementSelect = make('select'); replacementSelect.id = 'relay-owner-replace-device'; replacementSelect.required = true;
      const empty = make('option', 'Choose one existing session'); empty.value = ''; replacementSelect.append(empty);
      for (const device of state.loginDevices) { const option = make('option', device.label + ' · last used ' + stamp(device.lastSeenAt) + ' · ' + device.id.slice(-8)); option.value = device.id; replacementSelect.append(option); }
      replacementSelect.value = '';
      const replacementLabel = make('label', '', 'relay-owner-remember'); replacementConsent = make('input'); replacementConsent.type = 'checkbox'; replacementConsent.id = 'relay-owner-replacement-consent'; replacementConsent.required = true; replacementConsent.checked = false; sensitiveInputs.add(replacementConsent);
      replacementLabel.append(replacementConsent, make('span', 'I approve revoking the selected device session and replacing it with this browser. Other device sessions stay active.'));
      form.append(selectLabel, replacementSelect, replacementLabel);
    }
    const submit = action(state.authenticating ? 'Signing in…' : state.loginDevices.length ? 'Confirm replacement and sign in' : 'Sign in', () => {}, 'primary'); submit.type = 'submit'; submit.disabled = state.busy;
    form.append(remember, notice, submit);
    form.onsubmit = event => {
      event.preventDefault(); if (state.busy) return;
      const entered = { username: username.value, password: password.value, label: label.value, remember: checkbox.checked, replacement: replacementSelect ? { deviceId: replacementSelect.value, confirmed: replacementConsent.checked } : {} };
      clearSensitiveFields(); controller.login(entered.username, entered.password, entered.label, entered.remember, entered.replacement);
    };
    section.append(form);
  }
  const make = (tag, text = '', cls = '') => { const n = doc.createElement(tag); n.textContent = text; n.className = cls; return n; };
  function action(label, handler, cls = 'secondary') { const n = make('button', label, cls); n.type = 'button'; n.onclick = handler; return n; }
  function statusNodes(container, state) {
    const error = make('p', state.error, 'relay-owner-error'); error.setAttribute('role', 'status'); error.hidden = !state.error;
    const warning = make('p', state.warning, 'relay-owner-note'); warning.hidden = !state.warning;
    container.append(error, warning);
  }
  function position(panel){
    if(!panel)return null;
    const rect=panel.getBoundingClientRect?.();
    const row=rect?[...panel.children].find(n=>n.dataset?.messageId&&n.getBoundingClientRect?.().bottom>=rect.top):null;
    return {id:row?.dataset.messageId,offset:row?row.getBoundingClientRect().top-rect.top:0,scroll:panel.scrollTop,bottom:panel.scrollHeight-panel.scrollTop-panel.clientHeight<70};
  }
  function restorePosition(panel,anchor){
    if(!anchor||anchor.bottom){panel.scrollTop=panel.scrollHeight;return;}
    const row=[...panel.children].find(n=>n.dataset?.messageId===anchor.id);
    if(row?.getBoundingClientRect&&panel.getBoundingClientRect)panel.scrollTop+=row.getBoundingClientRect().top-panel.getBoundingClientRect().top-anchor.offset;
    else panel.scrollTop=anchor.scroll;
  }
  function closeInspector(){
    if(!detailDialog)return;const dialog=detailDialog;detailDialog=null;detailSignature='';dialog.close?.();dialog.remove?.();
    if(detailFocus?.isConnected)detailFocus.focus?.({preventScroll:true});detailFocus=null;
  }
  function renderInspector(state){
    if(state.mode!=='owner'||state.status!=='approved'||!state.jobDetailId){closeInspector();return;}
    if(!doc.body||!doc.createTextNode)return;
    if(!detailDialog){
      detailFocus=doc.activeElement;const dialog=make('dialog','','app-sheet conversation-sheet owner-request-detail');dialog.id='relay-owner-request-dialog';dialog.setAttribute('aria-label','Private request');detailDialog=dialog;
      dialog.addEventListener('close',()=>{if(detailDialog!==dialog)return;detailDialog=null;detailSignature='';dialog.remove();controller.closeJobDetail();if(detailFocus?.isConnected)detailFocus.focus({preventScroll:true});detailFocus=null;});
      dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)controller.closeJobDetail();});
      doc.body.append(dialog);dialog.showModal();
    }
    const currentRefresh=detailDialog.querySelector('#relay-owner-request-refresh');if(currentRefresh){currentRefresh.textContent=state.jobDetailBusy?'Refreshing…':'Refresh request';currentRefresh.disabled=state.jobDetailBusy||state.jobBusy;}
    const signature=JSON.stringify([state.jobDetailId,state.jobDetail,state.jobDetailError,state.jobDetailStale,state.syncStale,state.jobsError,state.jobBusy,jobLabel(state.jobDetail?.job||{})]);if(signature===detailSignature)return;
    const scroll=detailDialog.scrollTop,consent=detailDialog.querySelector('#relay-owner-retry-consent')?.checked===true,historyOpen=detailDialog.querySelector('#relay-owner-request-history')?.open===true,resultHistoryOpen=detailDialog.querySelector('#relay-owner-result-history')?.open===true;
    const focused=detailDialog.contains(doc.activeElement)?{id:doc.activeElement.id,label:doc.activeElement.getAttribute('aria-label')||doc.activeElement.textContent}:null;
    const bounds=detailDialog.getBoundingClientRect(),visible=[...detailDialog.querySelectorAll('[data-reading-anchor]')].find(n=>n.getBoundingClientRect().bottom>=bounds.top+24&&n.getBoundingClientRect().top<bounds.bottom);
    const reading=visible?{id:visible.dataset.readingAnchor,offset:visible.getBoundingClientRect().top-bounds.top}:null;
    detailSignature=signature;detailDialog.replaceChildren();
    const heading=make('div','','dialog-heading'),title=make('h2','Private request'),close=action('',()=>controller.closeJobDetail(),'icon-button');close.innerHTML=icon('close');close.setAttribute('aria-label','Close private request');heading.append(title,close);detailDialog.append(heading);
    const data=state.jobDetail,job=data?.job;
    if(!job){detailDialog.append(make('p',state.jobDetailError||'Opening private request…','sheet-context'));const refresh=action('Retry request details',()=>controller.inspectJob(state.jobDetailId,{refresh:true}));refresh.disabled=state.jobDetailBusy;refresh.hidden=!state.jobDetailError;detailDialog.append(refresh);return;}
    const requestBody=make('p',job.body,'request-body');requestBody.dataset.readingAnchor='request-body';const requestTitle=make('h3',job.title);requestTitle.dataset.readingAnchor='request-title';
    detailDialog.append(make('p',(state.jobDetailStale||state.syncStale||state.jobsError?'Last known: ':'')+jobLabel(job),'request-state'),requestTitle,requestBody);
    const update=meaningfulUpdate(job,data.events),labels=job.presentation;
    if(labels?.projectTitle)detailDialog.append(make('p',labels.projectTitle+(labels.goalTitle?' · '+labels.goalTitle:''),'request-meta'));
    if(update){const progress=make('section','','request-progress');progress.id='relay-owner-latest-progress';progress.append(make('h3','Latest execution update'),make('p',update.summary,'request-body'),make('p',stamp(update.createdAt),'request-meta'));detailDialog.append(progress);}
    const kinds={unclassified:'Ordinary owner message',read_only:'Research or inspection',draft:'Prepare a draft',consequential:'Action · review requested scope'};
    detailDialog.append(make('p',kinds[job.actionKind]+' · attempt '+job.attempt+' · saved '+stamp(job.createdAt),'request-meta'));
    if(job.execution)detailDialog.append(make('p','The owner-connected assistant acknowledged execution '+stamp(job.execution.acknowledgedAt)+'. '+(Date.parse(job.execution.leaseExpiresAt)<=Date.now()?'The recorded acknowledgement window ended ':'The acknowledgement expires ')+stamp(job.execution.leaseExpiresAt)+'.'+(job.stage==='running'&&Date.parse(job.execution.leaseExpiresAt)<=Date.now()?' Refresh to check the current outcome.':''),'request-meta'));
    if(job.cancelRequested)detailDialog.append(make('p',job.stage==='cancelled'?'The assistant acknowledged cancellation.':job.completion?'The assistant reported work complete after cancellation was requested. This does not report that the work stopped.':'Cancellation has been requested. The assistant has not confirmed that the work stopped.','request-meta'));
    if(job.stage==='waiting_for_owner')detailDialog.append(make('p','Review the request history for the assistant’s question or blocker, then send the needed input or decision in your private conversation. Actions follow your existing explicit authorization.','request-meta'));
    if(job.result){
      const latest=job.latestResult||{version:1,...job.result};
      detailDialog.append(make('h3',latest.version>1?'Authenticated correction':'Saved reply'));
      if(latest.version>1){const rationale=make('p',latest.correctionSummary,'request-meta');rationale.id='relay-owner-result-rationale';detailDialog.append(rationale);}
      const result=make('div','','request-body rich-body');result.id='relay-owner-result-latest';result.dataset.readingAnchor='saved-result';result.dataset.resultVersion=String(latest.version);richText(result,latest.body);detailDialog.append(result);
      detailDialog.append(make('p',(latest.version>1?'Correction '+latest.version+' · ':'Immutable owner reply · ')+stamp(latest.createdAt),'request-meta'));
      if(latest.version>1){
        detailDialog.append(make('p','Published by the authenticated owner-connected assistant. Authentication identifies the publisher; factual claims may still need checking.','request-meta'));
        const versionsDisclosure=make('details');versionsDisclosure.id='relay-owner-result-history';versionsDisclosure.open=resultHistoryOpen;const summary=make('summary','Original reply and corrections');summary.id='relay-owner-result-history-toggle';versionsDisclosure.append(summary);
        const versions=data.resultHistory||[{version:1,...job.result}];
        for(const record of versions){
          const version=make('section','','request-result-version');version.dataset.resultVersion=String(record.version);version.append(make('h3',record.version===1?'Original accepted reply':'Authenticated correction · version '+record.version));
          if(record.correctionSummary)version.append(make('p',record.correctionSummary,'request-meta'));
          const content=make('div','','request-body rich-body');content.dataset.readingAnchor='result-version-'+record.version;richText(content,record.body);version.append(content,make('p',stamp(record.createdAt),'request-meta'));versionsDisclosure.append(version);
        }
        if(!data.resultHistory)versionsDisclosure.append(make('p',state.jobDetailBusy?'Loading correction history…':'The full correction history could not be loaded. Refresh the request to read it.','request-meta'));
        detailDialog.append(versionsDisclosure);
      }
    }
    if(job.completion){
      const report=make('section','','request-completion');report.id='relay-owner-completion';report.dataset.resultVersion=String(job.completion.resultVersion);
      const summary=make('p',job.completion.summary,'request-body');summary.id='relay-owner-completion-summary';summary.dataset.readingAnchor='completion-summary';
      report.append(make('h3','Completion report'),summary,make('p','Reported '+stamp(job.completion.createdAt)+' · reply version '+job.completion.resultVersion,'request-meta'),make('p','The authenticated owner-connected assistant reported work complete. This attestation does not certify factual claims or external outcomes.','request-meta'));detailDialog.append(report);
    }
    if(job.failure)detailDialog.append(make('h3',job.failure.code==='completion_unverified'?'Completion unverified':'What needs attention'),make('p',job.failure.message,'request-body'),make('p',job.failure.code==='completion_unverified'?'The reply may be an acknowledgement, a blocker or available information. Review it in your private conversation; it does not establish that the work finished.':job.failure.outcome==='not_started'?'The assistant confirmed that the work did not start.':job.failure.outcome==='unknown'?'The earlier attempt may have done some or all of the work.':'Review what happened before another attempt.','request-meta'));
    if(job.delivery){
      const deliveryLabels={saved:'Request saved privately.',queued:'Request saved; callback delivery is queued.',callback_accepted:'The callback accepted delivery. This does not confirm execution.',delivery_failed:'Callback delivery failed. The saved request remains private.',reply_saved:'An authenticated owner reply is saved.'};
      detailDialog.append(make('h3','Delivery'),make('p',deliveryLabels[job.delivery.state]||'Delivery evidence unavailable.','request-meta'));
    }
    if(data.events.length){
      const details=make('details'),summary=make('summary','Request history');details.id='relay-owner-request-history';details.open=historyOpen;summary.id='relay-owner-request-history-toggle';details.append(summary);const list=make('ol','','request-events');
      for(const event of data.events){const item=make('li',event.summary+' · '+stamp(event.createdAt)+(event.authentication_source==='owner-oauth-mcp'?' · authenticated owner assistant':' · authenticated owner device'));item.dataset.readingAnchor='event:'+event.id;list.append(item);}
      details.append(list);detailDialog.append(details);
    }
    const actions=make('div','','request-actions');
    const refresh=action(state.jobDetailBusy?'Refreshing…':'Refresh request',()=>controller.inspectJob(job.id,{refresh:true}));refresh.id='relay-owner-request-refresh';refresh.setAttribute('aria-label','Refresh request');refresh.disabled=state.jobDetailBusy||state.jobBusy;actions.append(refresh);
    if(!job.cancelRequested&&!['completed','failed','cancelled'].includes(job.stage)){const cancel=action('Request cancellation',()=>controller.cancelJob(job.id));cancel.disabled=state.jobBusy;actions.append(cancel);}
    if(job.delivery?.retryable){const retryDelivery=action('Retry callback delivery',()=>controller.retryDelivery(job.id));retryDelivery.disabled=state.busy||state.sending;actions.append(retryDelivery);}
    if(job.retryAllowed){
      let checkbox=null;
      if(job.retryRequiresConfirmation){const label=make('label','','relay-owner-remember');checkbox=make('input');checkbox.type='checkbox';checkbox.id='relay-owner-retry-consent';checkbox.checked=consent;label.append(checkbox,make('span','I understand the earlier attempt may already have done the work. Create a separate attempt.'));detailDialog.append(label,make('p','This retries the saved request. Existing explicit authorization still governs actions.','request-meta'));}
      const retry=action('Try again',()=>controller.retryJob(job.id,checkbox?.checked===true),'primary');retry.disabled=state.jobBusy;actions.append(retry);
    }else if(['failed','cancelled','outcome_unknown'].includes(job.stage)&&!job.retryJobId)detailDialog.append(make('p','Outcome needs review before another attempt.','request-meta'));
    if(job.retryJobId)actions.append(action('View retry attempt',()=>controller.inspectJob(job.retryJobId)));
    detailDialog.append(actions);
    if(state.jobDetailError){const error=make('p',state.jobDetailError,'relay-owner-error');error.setAttribute('role','status');detailDialog.append(error);}
    detailDialog.scrollTop=scroll;
    if(reading&&scroll>0){const anchor=[...detailDialog.querySelectorAll('[data-reading-anchor]')].find(n=>n.dataset.readingAnchor===reading.id);if(anchor)detailDialog.scrollTop+=anchor.getBoundingClientRect().top-detailDialog.getBoundingClientRect().top-reading.offset;}
    if(focused){const node=focused.id?detailDialog.querySelector('#'+focused.id):[...detailDialog.querySelectorAll('button,summary,input')].find(n=>(n.getAttribute('aria-label')||n.textContent)===focused.label);node?.focus({preventScroll:true});}
  }
  function renderWork(state) {
    const panel=chatNodes.messages,allTasks=groupOwnerWork(state.jobs),tasks=groupOwnerWork(state.jobs,{query:state.query,filter:state.workFilter});
    const signature=JSON.stringify([state.jobs,state.query,state.workFilter,state.jobsError,state.syncStale,workVisible,tasks.map(t=>t.status)]);
    if(workSignature===signature)return;workSignature=signature;
    const open=new Map([...panel.querySelectorAll?.('details[data-work-key]')||[]].map(n=>[n.dataset.workKey,n.open]));
    const scroll=panel.scrollTop,focused=panel.contains?.(doc.activeElement)?doc.activeElement?.id:null;
    const body=make('section','','owner-work');body.id='relay-owner-current-work';body.setAttribute('aria-label','Private current work');
    body.append(make('h2','Current work'),make('p','Private · saved requests and authenticated execution updates','request-meta'));
    const filters=make('div','','owner-work-filters'),filterLabel=make('label','Status');filterLabel.htmlFor='relay-owner-work-filter';
    const filter=make('select');filter.id='relay-owner-work-filter';
    for(const [value,label] of [['all','All work'],['queued','Queued'],['working','Working'],['blocked','Needs attention'],['finished','Finished']]){const option=make('option',label);option.value=value;filter.append(option);}
    filter.value=state.workFilter;filter.onchange=()=>controller.setWorkFilter(filter.value);filters.append(filterLabel,filter);body.append(filters);
    const count=make('p',tasks.length+' of '+allTasks.length+' saved task'+(allTasks.length===1?'':'s'),'request-meta');count.id='relay-owner-work-count';body.append(count);
    if(state.syncStale||state.jobsError){const stale=make('p','Last known records · '+(state.jobsError||'refresh unavailable'),'relay-owner-note');stale.setAttribute('role','status');body.append(stale);}
    function disclosure(key,title,cls,initial=false){const n=make('details','',cls);n.dataset.workKey=key;n.open=open.has(key)?open.get(key):initial;const s=make('summary',title);s.id='owner-work-'+encodeURIComponent(key);n.append(s);return n;}
    function taskRow(task){
      const {job,status,attempts}=task,row=disclosure('task:'+job.id,'','owner-work-task');row.dataset.jobId=job.id;row.dataset.state=status.state;
      row.firstChild.append(make('span',job.title,'owner-work-title'),make('span',status.label,'job-state'));
      row.append(make('p','Owner · You'+(job.execution?' · Owner-connected assistant':' · execution unacknowledged'),'request-meta'));
      const update=meaningfulUpdate(job),latest=job.latestResult||job.result;
      if(update)row.append(make('p',update.kind==='result_corrected'&&latest?.correctionSummary?latest.correctionSummary:update.summary,'request-body owner-work-update'),make('p','Execution update · '+stamp(update.createdAt),'request-meta'));
      if(status.state==='blocked')row.append(make('p',job.failure?.message||job.stage==='waiting_for_owner'&&update?.summary||job.cancelRequested&&'Cancellation was requested; execution has not been confirmed stopped.'||'Refresh or inspect the request evidence to check the current outcome.','request-body owner-work-blocker'));
      row.append(make('p','Record updated · '+stamp(job.updatedAt),'request-meta'));
      if(latest){
        row.append(make('h3',job.resultVersion>1?'Corrected result · version '+job.resultVersion:job.completion?'Final result':'Saved reply · completion unverified'));
        const result=make('div','','request-body rich-body');result.dataset.resultVersion=String(job.resultVersion||1);richText(result,latest.body);row.append(result);
        if(job.completion)row.append(make('p','Completion reported · '+stamp(job.completion.createdAt)+' · reply version '+job.completion.resultVersion,'request-meta'));
      }
      const evidence=action('Evidence and result',()=>controller.inspectJob(job.id),'text-button');evidence.id='owner-work-evidence-'+job.id;row.append(evidence);
      if(attempts.length>1){const earlier=disclosure('attempts:'+job.rootJobId,'Earlier attempts · '+(attempts.length-1),'owner-work-attempts');for(const prior of attempts.slice(0,-1))earlier.append(action('Attempt '+prior.attempt+' · '+jobLabel(prior),()=>controller.inspectJob(prior.id),'text-button'));row.append(earlier);}
      return row;
    }
    function projects(list,container,section){
      const groups=new Map();
      for(const task of list){const title=task.job.presentation?.projectTitle||null;const group=groups.get(title)||new Map(),goal=task.job.presentation?.goalTitle||null,items=group.get(goal)||[];items.push(task);group.set(goal,items);groups.set(title,group);}
      for(const [title,goals] of groups){
        const project=disclosure('project:'+section+':'+JSON.stringify(title),title||'Unassigned requests','owner-work-project',true);container.append(project);
        for(const [goal,items] of goals){const target=goal?disclosure('goal:'+section+':'+JSON.stringify([title,goal]),goal+' · '+items.length+' task'+(items.length===1?'':'s'),'owner-work-goal',true):project;if(goal)project.append(target);for(const task of items)target.append(taskRow(task));}
      }
    }
    const current=tasks.filter(t=>t.status.state!=='finished'),finished=tasks.filter(t=>t.status.state==='finished');
    if(current.length)projects(current.slice(0,workVisible),body,'current');else if(!finished.length)body.append(make('p',state.busy&&!state.jobs.length?'Loading saved requests…':state.query||state.workFilter!=='all'?'No work matches this search and status.':'No current work is recorded.','relay-owner-note'));
    if(current.length>workVisible){const more=action('Show more current work ('+Math.min(workVisible,current.length)+' of '+current.length+')',()=>{workVisible+=50;renderMessages(controller.snapshot());},'text-button');body.append(more);}
    if(finished.length){const done=disclosure('finished','Finished · '+finished.length,'owner-work-finished');if(state.query||state.workFilter==='finished')done.open=true;projects(finished.slice(0,workVisible),done,'finished');if(finished.length>workVisible)done.append(action('Show more finished work',()=>{workVisible+=50;renderMessages(controller.snapshot());},'text-button'));body.append(done);}
    panel.replaceChildren(body);panel.scrollTop=scroll;
    if(focused)[...panel.querySelectorAll?.('[id]')||[]].find(n=>n.id===focused)?.focus({preventScroll:true});
  }
  function renderMessages(state) {
    if (!chatNodes) return;
    const search=doc.getElementById('relay-owner-search'),searchLabel=doc.getElementById('relay-owner-search-label');
    const searchText=state.requestsOnly&&state.jobsEnabled?'Search current work':'Search private messages';
    if(search){search.placeholder=searchText;if(search.value.trim().toLowerCase()!==state.query)search.value=state.query;}if(searchLabel)searchLabel.textContent=searchText;
    const panel=chatNodes.messages,anchor=chatNodes.first&&readingAnchor?readingAnchor:position(panel),jobs=new Map(state.jobs.map(j=>[j.messageId,j]));
    const existing=new Map([...panel.children].filter(n=>n.dataset?.messageId).map(n=>[n.dataset.messageId,n])),nodes=[];
    const work=state.requestsOnly&&state.jobsEnabled;if(work)renderWork(state);else workSignature='';
    const selected = work?[]:state.messages.filter(m => (!state.query || m.body.toLowerCase().includes(state.query))&&(!state.requestsOnly||jobs.has(m.id)));
    for (const m of selected) {
      const job=jobs.get(m.id),replyJob=m.replyTo?jobs.get(m.replyTo):null,stale=state.syncStale||state.jobsError||state.jobDetailStale&&state.jobDetailId===job?.id,signature=JSON.stringify([m,job,replyJob?.resultVersion,state.busy,state.sending,stale,job?jobLabel(job):null]);let row=existing.get(m.id);
      if(row?._signature===signature){nodes.push(row);continue;}
      row = make('article', '', 'message-row ' + (m.role === 'user' ? 'outgoing' : 'incoming'));row._signature=signature;
      row.dataset.messageId = m.id;
      const heading=make('div','','message-heading'),copy=action('',async()=>{copy.setAttribute('aria-label',await copyText(m.body)?'Private message copied':'Copy private message');},'message-actions');copy.innerHTML=icon('copy');copy.setAttribute('aria-label','Copy private message');heading.append(make('span',m.role==='user'?'You':'dot','message-author'),copy);row.append(heading);
      if(job&&job.title!=='Owner request')row.append(make('p',job.title,'owner-request-title'));
      // Request text is inert. The inspector alone formats the saved result.
      row.append(make('p',m.body,'bubble'));
      let status='';
      if(m.role==='user'){
        const labels={saved:'Saved privately · awaiting reply',queued:'Saved · awaiting assistant',callback_accepted:'Sent · awaiting reply',delivery_failed:'Delivery needs retry',reply_saved:'Reply saved'};
        status=job?'':labels[m.delivery?.state]||'Saved privately';
        if(job){
          row.dataset.jobId=job.id;const info=make('div','','message-job');info.dataset.state=job.stage;info.append(make('span',(stale?'Last known: ':'')+jobLabel(job),'job-state'),action('Inspect request',()=>controller.inspectJob(job.id),'text-button'));row.append(info);
        }else if(m.delivery?.retryable){
          const retry=action('Retry callback delivery',()=>controller.retryDelivery(m.id));
          retry.disabled=state.busy||state.sending;row.append(retry);
        }
      }else if(replyJob?.resultVersion>1){
        const correction=make('div','','message-job');correction.dataset.state=replyJob.stage;correction.append(make('span','A correction is saved · version '+replyJob.resultVersion,'job-state'),action('Inspect result',()=>controller.inspectJob(replyJob.id),'text-button'));row.append(correction);
      }
      row.append(make('span',messageStamp(m.createdAt)+(status?' · '+status:''),'message-time'));nodes.push(row);
    }
    if (!selected.length&&!work){const empty=make('div','','chat-empty');empty.append(make('p','Private owner conversation','empty-label'),make('h2',state.query?'No matching messages':state.requestsOnly?'No requests to show':state.busy?'Opening your conversation…':'What would you like to work on?'),make('p',state.query?'Try a different phrase.':state.requestsOnly?'Send a message or a work request. Both stay in your private conversation.':state.busy?'Checking your private inbox.':state.jobsEnabled?'Message dot or turn a thought into a work request. Saved replies and results appear here.':'Message dot privately. Replies appear here after the assistant checks the inbox.'));nodes.push(empty);}
    if(!work){if(panel.insertBefore){const wanted=new Set(nodes);for(const child of [...panel.children])if(!wanted.has(child))child.remove();for(let i=0;i<nodes.length;i++)if(panel.children[i]!==nodes[i])panel.insertBefore(nodes[i],panel.children[i]||null);}else panel.replaceChildren(...nodes);restorePosition(panel,anchor);}chatNodes.first=false;
    if (chatNodes.input.value !== state.draft) { chatNodes.input.value = state.draft; autosize(chatNodes.input); }
    chatNodes.send.disabled = state.sending || state.busy;
    chatNodes.send.setAttribute('aria-label',state.sending?'Sending privately':state.jobMode?'Send private request':'Send private message');
    chatNodes.input.placeholder=state.jobMode?'Describe the work privately…':'Message dot privately…';
    chatNodes.status.textContent=state.sending?'Saving privately…':state.sendUnconfirmed?'Send unconfirmed · your text is still here':state.error?'Private sync unavailable':state.busy?'Refreshing private inbox…':state.sendNotice|| (state.requestsOnly?'Private requests · all saved attempts':state.jobsEnabled?'Private · messages and work requests':'Private · replies arrive after an inbox check');
    chatNodes.jobToggle.hidden=!state.jobsEnabled;chatNodes.jobToggle.disabled=state.sending;chatNodes.jobToggle.setAttribute('aria-pressed',String(state.jobMode));chatNodes.jobToggle.setAttribute('aria-label',state.jobMode?'Switch to private message':'Create work request');chatNodes.jobToggleLabel.textContent=state.jobMode?'Message instead':'Work request';
    chatNodes.jobFields.hidden=!state.jobMode;
    chatNodes.title.required=state.jobMode;if(chatNodes.title.value!==state.jobTitle)chatNodes.title.value=state.jobTitle;if(chatNodes.kind.value!==state.jobKind)chatNodes.kind.value=state.jobKind;
    if(chatNodes.project.value!==(state.jobProject||''))chatNodes.project.value=state.jobProject||'';if(chatNodes.goal.value!==(state.jobGoal||''))chatNodes.goal.value=state.jobGoal||'';
    chatNodes.jobNote.textContent=state.jobKind==='read_only'?'Ask for a report without changing anything. The assistant reviews the request before starting.':state.jobKind==='draft'?'Ask for prepared work to review. This draft scope grants no permission to publish or make other changes.':'The assistant reviews the requested scope and your existing authorization.';
    chatNodes.error.textContent = state.error; chatNodes.error.hidden = !state.error;
    chatNodes.warning.textContent = state.warning; chatNodes.warning.hidden = !state.warning;
    chatNodes.notice.hidden=!state.error;chatNodes.retry.textContent=state.sendUnconfirmed?'Retry private send':'Retry private sync';chatNodes.retry.disabled=state.busy||state.sending;
  }
  function render() {
    if (!root?.isConnected || controller.mode === 'public') { clearSensitiveFields(); return; }
    const state = controller.snapshot();
    if(connectionDialog&&(state.status!=='approved'||state.mode!=='owner')){connectionDialog.close?.();connectionDialog.remove?.();connectionDialog=null;}
    renderInspector(state);
    const key = state.mode === 'owner' && state.status === 'approved' ? 'chat' : state.mode + ':' + state.status;
    const searchToggle = doc.getElementById('chat-search-toggle'); if (searchToggle) searchToggle.hidden = true;
    if (key === 'chat' && viewKey === key) { renderMessages(state); return; }
    const active = doc.activeElement;
    // Preserve unsent setup choices when a status repaint follows network work.
    if (root.contains(active) && active?.id === 'relay-owner-label') pairLabel = active.value;
    if(chatNodes)readingAnchor=position(chatNodes.messages);
    if(state.status!=='approved')readingAnchor=null;
    clearSensitiveFields(); root.classList.add('relay-owner-content'); root.replaceChildren(); viewKey = key; chatNodes = null;
    const section = make('section', '', 'relay-owner-panel'); root.append(section);
    if (key !== 'chat' && state.draft) section.append(make('p', 'Your unsent private draft is kept in this tab. Sign in to review it.', 'relay-owner-notice'));
    if (key === 'chat') {
      section.classList.add('relay-owner-chat');
      const heading = make('div', '', 'relay-owner-heading'); heading.append(make('h2', 'Owner chat')); section.append(heading);
      const search = make('div', '', 'conversation-search'); search.id = 'relay-owner-search-bar'; search.hidden = true;
      const searchLabel = make('label', 'Search private messages', 'sr-only'); searchLabel.htmlFor = 'relay-owner-search';searchLabel.id='relay-owner-search-label';
      const searchInput = make('input'); searchInput.id = 'relay-owner-search'; searchInput.type = 'search'; searchInput.placeholder = 'Search private messages'; searchInput.autocomplete = 'off';searchInput.value=state.query;search.hidden=!state.query; searchInput.oninput = () => controller.setQuery(searchInput.value);const searchClose=action('',()=>ui.toggleSearch(),'icon-button');searchClose.innerHTML=icon('close');searchClose.setAttribute('aria-label','Close search');search.append(searchLabel,searchInput,searchClose); section.append(search);
      workSignature='';workVisible=50;const messages = make('div', '', 'messages'); messages.setAttribute('aria-label', 'Private owner conversation'); messages.setAttribute('aria-live', 'polite'); section.append(messages);
      const form = make('form', '', 'composer'); form.id = 'relay-owner-message-form';
      const fields=make('div','','owner-job-fields');fields.hidden=true;
      const titleLabel=make('label','Request title');titleLabel.htmlFor='relay-owner-job-title';const title=make('input');title.id='relay-owner-job-title';title.maxLength=120;title.placeholder='A short description';title.autocomplete='off';title.oninput=()=>controller.setJobTitle(title.value);const titleField=make('div');titleField.append(titleLabel,title);
      const kindLabel=make('label','Requested scope');kindLabel.htmlFor='relay-owner-job-kind';const kind=make('select');kind.id='relay-owner-job-kind';for(const [value,text] of [['consequential','Needs review'],['read_only','Read-only report'],['draft','Draft only']]){const option=make('option',text);option.value=value;kind.append(option);}kind.onchange=()=>controller.setJobKind(kind.value);const kindField=make('div');kindField.append(kindLabel,kind);const jobNote=make('p');fields.append(titleField,kindField,jobNote);form.append(fields);
      const organization=make('details','','owner-job-organization');organization.append(make('summary','Project and goal (optional)'));
      const labels=make('div','','owner-job-labels');
      const projectLabel=make('label','Project');projectLabel.htmlFor='relay-owner-job-project';const project=make('input');project.id='relay-owner-job-project';project.maxLength=120;project.autocomplete='off';project.oninput=()=>controller.setJobProject(project.value);const projectField=make('div');projectField.append(projectLabel,project);
      const goalLabel=make('label','Goal');goalLabel.htmlFor='relay-owner-job-goal';const goal=make('input');goal.id='relay-owner-job-goal';goal.maxLength=120;goal.autocomplete='off';goal.oninput=()=>controller.setJobGoal(goal.value);const goalField=make('div');goalField.append(goalLabel,goal);labels.append(projectField,goalField);organization.append(labels);fields.append(organization);
      const label = make('label', 'Message dot privately', 'sr-only'); label.htmlFor = 'relay-owner-message-text';
      const input = make('textarea'); input.id = 'relay-owner-message-text'; input.rows = 1; input.maxLength = 4000; input.placeholder = 'Message dot privately…'; input.autocomplete = 'off'; input.required = true; input.value = state.draft;
      input.oninput = () => { controller.setDraft(input.value); autosize(input); };
      input.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } };
      const bottom = make('div', '', 'composer-bottom'), status = make('span'); status.setAttribute('role', 'status');
      const toggle=action('',()=>controller.setJobMode(!controller.snapshot().jobMode),'composer-mode-button');toggle.id='relay-owner-job-toggle';toggle.innerHTML=icon('plus');const toggleLabel=make('span','Work request');toggle.append(toggleLabel);bottom.append(status,toggle);
      const send = action('', () => {}, 'primary send-icon'); send.type = 'submit'; send.innerHTML = icon('send');const inputRow=make('div','','composer-input');inputRow.append(label,input,send);form.append(inputRow,bottom);
      form.onsubmit = event => { event.preventDefault(); controller.setDraft(input.value); controller.send(); };
      section.append(form);
      const error = make('p', '', 'relay-owner-error'); error.setAttribute('role', 'status');
      const warning = make('p', '', 'relay-owner-note owner-storage-warning');
      const retry = action('Retry private sync', () => controller.snapshot().sendUnconfirmed?controller.retryUnconfirmed():controller.refresh(),'text-button'),notice=make('div','','conversation-notice');notice.append(error,retry);section.insertBefore?.(notice,form);if(!section.insertBefore)section.append(notice);section.append(warning);
      chatNodes = { messages, input, status, send, error, warning, retry,notice,jobToggle:toggle,jobToggleLabel:toggleLabel,jobFields:fields,title,kind,jobNote,project,goal,first:true }; renderMessages(state); autosize(input);
      return;
    }
    if (state.mode === 'account') {
      section.append(make('h2', 'Account sign-in'), make('p', 'Your account username and password let you recover private owner access on this same URL. Each successful sign-in creates a separate revocable device session. Account credentials are separate from remembered device access.', 'relay-owner-note'));
      if (state.accountNotice) { const notice = make('p', state.accountNotice, 'relay-owner-note'); notice.setAttribute('role', 'status'); section.append(notice); }
      if (state.accountReady) {
        const change = state.account.configured;
        section.append(make('h3', change ? 'Change username or password' : 'Set up username and password'));
        const form = make('form', '', 'relay-owner-auth-form'); form.id = 'relay-owner-credentials-form'; form.autocomplete = 'off';
        const username = field(form, 'Account username', 'relay-owner-account-username', { minLength: 3, maxLength: 32, value: change ? state.account.username : '' });
        username.setAttribute('pattern', '[A-Za-z0-9][A-Za-z0-9._-]{2,31}');
        const current = change ? field(form, 'Current password', 'relay-owner-current-password', { type: 'password' }) : null;
        const password = field(form, 'New password', 'relay-owner-new-password', { type: 'password', minLength: 16 });
        const confirmation = field(form, 'Confirm new password', 'relay-owner-confirm-password', { type: 'password', minLength: 16 });
        const policy = make('p', 'Choose a unique password of 16–128 characters (at most 256 bytes). Relay stores a salted password verifier on the owner service. Your account credentials remain valid until you change them; the 365-day inactivity limit applies to each device session. There is no email reset: keep your password safely and retain a trusted device session for account management.', 'relay-owner-note');
        const consent = make('label', '', 'relay-owner-remember'), checkbox = make('input'); checkbox.type = 'checkbox'; checkbox.id = 'relay-owner-credentials-consent'; checkbox.required = true; checkbox.checked = false; sensitiveInputs.add(checkbox);
        consent.append(checkbox, make('span', 'I approve saving this account sign-in for owner access until I change it. Device sessions expire after 365 days of inactivity; existing sessions stay active until individually revoked.'));
        policy.id = 'relay-owner-password-policy'; checkbox.setAttribute('aria-describedby', policy.id);
        const submit = action(change ? 'Save account changes' : 'Save account sign-in', () => {}, 'primary'); submit.type = 'submit'; submit.disabled = state.busy;
        form.append(policy, consent, submit); form.onsubmit = event => {
          event.preventDefault(); if (state.busy) return;
          const entered = { username: username.value, password: password.value, confirmation: confirmation.value, currentPassword: current?.value, consent: checkbox.checked };
          clearSensitiveFields(); controller.saveCredentials(entered);
        };
        section.append(form);
      } else if (state.busy) section.append(make('p', state.account ? 'Saving account sign-in…' : 'Verifying owner access and preparing your form…', 'relay-owner-note'));
      else { const fresh = action(state.accountNotice ? 'Change account sign-in' : 'Open a fresh account form', () => controller.showAccount(), 'primary'); section.append(fresh); }
      statusNodes(section, state); section.append(action(state.busy ? 'Close account form' : 'Cancel / owner chat', () => controller.showOwner())); return;
    }
    if (state.mode === 'pairing') {
      section.append(make('h2', 'Connect this phone'));
      if (state.status === 'pending') {
        section.append(make('p', 'On your unrestricted phone, open your existing private chat with dot and ask it to approve this Relay pairing code. Keep this page open.', 'relay-owner-note'));
        const code = make('p', state.pairing.code, 'relay-owner-code'); code.setAttribute('aria-label', 'Pairing code ' + state.pairing.code); section.append(code);
        const copy = action('Copy approval request', async () => { copy.textContent = await copyText('Please approve this Relay phone pairing code: ' + state.pairing.code) ? 'Approval request copied' : 'Select the displayed code to copy it'; }); section.append(copy);
        section.append(make('p', 'Approval code expires ' + stamp(state.pairing.expires_at) + '. This phone has no owner access until you approve it.', 'relay-owner-note'));
        const check = action(state.busy ? 'Checking approval…' : 'Check approval', () => controller.checkPairing(), 'primary'); check.disabled = state.busy; section.append(check);
        section.append(action('Cancel pairing', () => { controller.connect(); render(); }));
      } else {
        loginForm(section, state);
        section.append(make('h3', 'Pair a device or set up account sign-in'), make('p', 'First-time account setup requires an already verified owner session. Pair once below, then open Account sign-in in private owner chat. After setup, your username and password work here independently of the other phone.', 'relay-owner-note'));
        if (['expired', 'revoked'].includes(state.status)) section.append(make('p', state.status === 'expired' ? 'This pairing request has expired. Create a new code.' : 'This pairing request was revoked. Create a new code.', 'relay-owner-error'));
        section.append(make('p', 'Approve a one-time code from your existing private dot chat on your unrestricted phone. Pair each phone separately so either can be revoked.', 'relay-owner-note'));
        const form = make('form'); form.id = 'relay-owner-pair-form';
        const label = make('label', 'Device name'); label.htmlFor = 'relay-owner-label';
        const input = make('input'); input.id = 'relay-owner-label'; input.maxLength = 80; input.placeholder = 'For example, my restricted phone'; input.value = pairLabel; input.autocomplete = 'off'; input.oninput = () => { pairLabel = input.value; };
        const remember = make('label', '', 'relay-owner-remember');
        const checkbox = make('input'); checkbox.type = 'checkbox'; checkbox.id = 'relay-owner-remember'; checkbox.checked = pairRemember; checkbox.onchange = () => { pairRemember = checkbox.checked; };
        remember.append(checkbox, make('span', 'Remember owner access on this browser'));
        const consent = make('p', 'If checked, this browser saves only a device token and device ID. Access expires after exactly 365 days of inactivity and renews on authenticated use. Scripts on this shared website origin can read the token. Anyone using this browser can use this access. Clearing browser data requires signing in again with account credentials, or pairing again if account sign-in is not configured. Private history is not saved in browser storage. Unsent drafts are kept in this tab, separate from public Relay drafts.', 'relay-owner-note'); consent.id = 'relay-owner-storage-notice'; checkbox.setAttribute('aria-describedby', consent.id);
        const start = action(state.busy ? 'Creating code…' : 'Create pairing code', () => {}, 'primary'); start.type = 'submit'; start.disabled = state.busy;
        form.append(label, input, remember, consent, start); form.onsubmit = event => { event.preventDefault(); pairLabel = input.value; pairRemember = checkbox.checked; controller.startPairing(pairLabel, pairRemember); }; section.append(form);
      }
      statusNodes(section, state); section.append(action('Public chat', () => controller.showPublic())); return;
    }
    if (state.mode === 'devices' && state.status === 'approved') {
      section.append(make('h2', 'Owner devices'), make('p', 'Each phone has its own revocable session. Successful authenticated use renews that session’s 365-day inactivity expiry.', 'relay-owner-note'));
      if (!state.devices.length) section.append(make('p', state.busy ? 'Checking devices…' : 'No device list is available yet.', 'relay-owner-note'));
      for (const device of state.devices) {
        const row = make('div', '', 'relay-owner-device');
        row.append(make('h3', device.label + (device.id === state.device?.id ? ' · this phone' : '')),
          make('p', device.revokedAt ? 'Revoked' : 'Last used ' + stamp(device.lastSeenAt) + ' · expires ' + stamp(device.expiresAt), 'relay-owner-note'));
        const revoke = action('Revoke ' + device.label, () => controller.revoke(device.id)); revoke.disabled = state.busy || !!device.revokedAt; row.append(revoke); section.append(row);
      }
      statusNodes(section, state); const refresh = action('Refresh devices', () => controller.refreshDevices()); refresh.disabled = state.busy; section.append(refresh, action('Account sign-in', () => controller.showAccount()), action('Owner chat', () => controller.showOwner())); return;
    }
    section.append(make('h2', 'Owner chat'));
    const text = state.status === 'checking' ? 'Verifying owner access for this phone…' : state.status === 'expired' ? 'This phone’s owner session has expired.' : state.status === 'revoked' ? 'This phone’s owner access has been revoked.' : 'Owner access has not been verified.';
    section.append(make('p', text, 'relay-owner-note')); statusNodes(section, state);
    if (controller.hasCredential) { const retry = action('Retry owner connection', () => controller.refresh(), 'primary'); retry.disabled = state.busy; section.append(retry); }
    else section.append(action('Connect this phone', () => controller.connect(), 'primary'));
    section.append(action('Public chat', () => controller.showPublic()));
  }
  const hideSensitive = () => { if (doc.hidden) { clearSensitiveFields(); controller.cancelSensitive(); } };
  const leavePage = () => { clearSensitiveFields(); controller.cancelSensitive(); };
  doc.addEventListener?.('visibilitychange', hideSensitive);
  doc.defaultView?.addEventListener('pagehide', leavePage);
  doc.defaultView?.addEventListener('beforeunload', leavePage);
  const unsubscribe = controller.subscribe(render);
  const ui={
    controller,
    get mode() { return controller.mode; },
    mount(node) {
      root = node; viewKey = ''; render(); clearInterval(timer);
      if (controller.mode === 'owner' && controller.hasCredential && ['unknown', 'checking'].includes(controller.status)) controller.refresh();
      if (controller.mode === 'pairing' && controller.status === 'pending') controller.checkPairing();
      timer = setInterval(() => {
        if (!root?.isConnected || doc.hidden) return;
        if (controller.status === 'pending' && controller.mode === 'pairing') controller.checkPairing();
        else if (controller.mode === 'owner' && controller.hasCredential) controller.refresh();
      }, controller.status === 'pending' || controller.mode === 'pairing' ? 5000 : 30000);
    },
    unmount() { if(chatNodes)readingAnchor=position(chatNodes.messages);closeInspector();connectionDialog?.close?.();connectionDialog?.remove?.();connectionDialog=null;clearSensitiveFields(); if (viewKey.startsWith('account:') || controller.snapshot().authenticating || controller.snapshot().loginDevices.length) controller.cancelSensitive(); root = null; chatNodes = null; viewKey = ''; clearInterval(timer); },
    toggleSearch() { const bar = doc.getElementById('relay-owner-search-bar'); if (!bar) return; bar.hidden = !bar.hidden; if (!bar.hidden) doc.getElementById('relay-owner-search').focus(); else { doc.getElementById('relay-owner-search').value = ''; controller.setQuery(''); } },
    latest() { if(controller.snapshot().requestsOnly)controller.toggleRequests();else controller.setQuery('');if(chatNodes)chatNodes.messages.scrollTop=chatNodes.messages.scrollHeight; },
    requests(){controller.toggleRequests();if(chatNodes)chatNodes.messages.scrollTop=0;},
    connection(){
      if(!doc.body)return;connectionDialog?.close?.();const state=controller.snapshot(),dialog=make('dialog','','app-sheet conversation-sheet');connectionDialog=dialog;dialog.setAttribute('aria-label','Private owner connection');const heading=make('div','','dialog-heading'),close=action('',()=>dialog.close(),'icon-button');close.innerHTML=icon('close');close.setAttribute('aria-label','Close connection details');heading.append(make('h2','Private owner connection'),close);dialog.append(heading);
      dialog.append(make('p',state.status==='approved'?'Owner access was verified for this device.':state.status==='expired'?'This device session has expired.':state.status==='revoked'?'This device session was revoked.':'Private owner access has not been verified.','sheet-context'));
      if(state.device)dialog.append(make('p','Device access expires '+stamp(state.device.expiresAt)+'. Successful authenticated use renews the inactivity period.','sheet-note'));
      dialog.append(make('p',state.status!=='approved'?'Sign in or reconnect this phone to use the private conversation. Public Relay is available only when you choose it explicitly.':state.jobsEnabled?state.jobsError||'Messages and durable requests are available. A callback receipt confirms delivery only. Working appears only after authenticated assistant acknowledgement.':'Private messages remain available. Durable request details need a newer owner service.','sheet-note'));
      if(state.error)dialog.append(make('p',state.error,'relay-owner-error'));dialog.addEventListener('close',()=>{dialog.remove();if(connectionDialog===dialog)connectionDialog=null;},{once:true});doc.body.append(dialog);dialog.showModal();
    },
    refresh() { return controller.status === 'pending' ? controller.checkPairing() : controller.mode === 'devices' ? controller.refreshDevices() : controller.refresh(); },
    dispose() { this.unmount(); unsubscribe(); doc.removeEventListener?.('visibilitychange', hideSensitive); doc.defaultView?.removeEventListener('pagehide', leavePage); doc.defaultView?.removeEventListener('beforeunload', leavePage); }
  };return ui;
}
