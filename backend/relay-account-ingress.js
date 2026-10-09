// Inactive account admission boundary. No deployment enables this mode. Public
// or remote input cannot provide a trusted in-memory reservation; absent finite
// upstream/restart admission, requested enforcement closes before Hub storage.
export const relayAccountHubPath=path=>path==='/relay/mcp'||path.startsWith('/relay/oauth/')||path.startsWith('/relay/owner/')||path==='/mcp'||path.startsWith('/oauth/')||['/shared/state','/shared/changes','/shared/result','/shared/messages','/shared/import-hint'].includes(path)||path.startsWith('/v1/');
export const RELAY_ACCOUNT_INGRESS_LIMITS=Object.freeze({bodyBytes:131072,bodyChunks:1024,bodyMs:1000});
const own=(value,key)=>value&&Object.prototype.hasOwnProperty.call(value,key);
const requested=(env,runtime)=>own(env,'RELAY_ACCOUNT_ADMISSION_MODE')||runtime!==undefined;
const blocked=reason=>Object.freeze({status:'blocked',reason});
export function relayAccountOperationDenial(env,runtime){
  if(!requested(env,runtime))return null;
  return blocked(env?.RELAY_ACCOUNT_ADMISSION_MODE==='enforced'?'finite_upstream_admission_unknown':'account_admission_mode_unknown');
}
export function relayAccountDenialResponse(denial){
  return Response.json({error:'Account admission unavailable',code:denial.reason},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'60','X-Content-Type-Options':'nosniff'}});
}
export function assertRelayAccountOperationAllowed(env,runtime){
  const denial=relayAccountOperationDenial(env,runtime);
  if(denial){const error=new Error('Account admission unavailable');error.code=denial.reason;throw error;}
}

// Bound actual streamed bytes and chunks before admission or JSON parsing. This
// read is only used when inactive enforcement is explicitly requested. No body,
// marker, bearer principal, budget or callback can authorize the denied request.
export async function relayAccountRequestGate(request,env,runtime){
  const denial=relayAccountOperationDenial(env,runtime);if(!denial)return {request};
  if(env?.RELAY_ACCOUNT_ADMISSION_MODE!=='enforced')return {response:relayAccountDenialResponse(denial)};
  let reader,timer;
  try{
    const length=request.headers.get('Content-Length');
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)>RELAY_ACCOUNT_INGRESS_LIMITS.bodyBytes))throw Error('body_limit');
    reader=request.body?.getReader();
    if(reader){
      const deadline=performance.now()+RELAY_ACCOUNT_INGRESS_LIMITS.bodyMs;
      let bytes=0,chunks=0;
      const expired=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('body_timeout')),RELAY_ACCOUNT_INGRESS_LIMITS.bodyMs);});
      await Promise.race([expired,(async()=>{
        for(;;){
          if(performance.now()>=deadline)throw Error('body_timeout');
          const part=await reader.read();
          if(performance.now()>=deadline)throw Error('body_timeout');
          if(part.done)break;
          if(!(part.value instanceof Uint8Array)||part.value.byteLength===0||++chunks>RELAY_ACCOUNT_INGRESS_LIMITS.bodyChunks||
            (bytes+=part.value.byteLength)>RELAY_ACCOUNT_INGRESS_LIMITS.bodyBytes)throw Error('body_limit');
        }
      })()]);
    }
  }catch{
    try{void reader?.cancel().catch(()=>{});}catch{}
    return {response:Response.json({error:'Admission request body refused'},{status:413,headers:{'Cache-Control':'no-store'}})};
  }finally{clearTimeout(timer);try{reader?.releaseLock();}catch{}}
  return {response:relayAccountDenialResponse(denial)};
}

import {isRelayAccountAdmission,accountAdmissionPlan,accountAdmissionPreparationIds,consumeRelayAccountReservation,relayAccountAdmissionHash} from './relay-account-admission.js';
import {RELAY_MIGRATION_PREFLIGHT_PLAN as PREFLIGHT,relayMigrationPreflightAdmission,relayMigrationPreflightStep,relayMigrationPreflightBudget} from './relay-migration-preflight.js';
import {RELAY_MIGRATION_CATALOG as CATALOG} from './relay-migration-preflight-catalog.js';
const prepared=new WeakMap(),history=new WeakMap();
const copy=value=>JSON.parse(JSON.stringify(value));
const immutable=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(immutable);Object.freeze(value);}return value;};
const nativeBlocked=reason=>({...blocked(reason),native:{rowsRead:0,rowsWritten:0,databaseBytes:null}});
const costSum=values=>values.reduce((sum,value)=>{for(const key of ['rowsRead','rowsWritten','storedBytes']){sum[key]+=value[key];if(!Number.isSafeInteger(sum[key]))throw Error('Finite bound overflow');}return sum;},{rowsRead:0,rowsWritten:0,storedBytes:0});
const day=now=>new Date(now).toISOString().slice(0,10);
export async function relayAccountRuntimeIdentity(){
  if(!CATALOG.schemaBasis||!CATALOG.sourceFiles['backend/relay-account-ingress.js']||!CATALOG.sourceFiles['backend/relay-account-admission.js'])return null;
  return {sourceHash:await relayAccountAdmissionHash(Object.entries(CATALOG.sourceFiles).sort(([a],[b])=>a.localeCompare(b))),
    catalogHash:await relayAccountAdmissionHash({schemaBasis:CATALOG.schemaBasis,tables:CATALOG.tables,indices:CATALOG.indices,triggers:CATALOG.triggers,provider:CATALOG.provider})};
}
export async function relayAccountScopeIdentity(ctx){
  const id=ctx?.id?.toString();return typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)?relayAccountAdmissionHash(id):null;
}
const receiptBinding=receipt=>Object.fromEntries(['planId','day','scope','lane','id','payloadHash','sourceHash','catalogHash','reportsHash'].map(key=>[key,receipt[key]]));
async function preparationConfiguration(allocator,ctx,input,now){
  if(!isRelayAccountAdmission(allocator))return {reason:'account_authority_unknown'};
  const plan=accountAdmissionPlan(allocator),identity=await relayAccountRuntimeIdentity();
  if(!plan||!identity||plan.day!==day(now)||plan.sourceHash!==identity.sourceHash||plan.catalogHash!==identity.catalogHash)return {reason:'account_runtime_identity_unknown'};
  const scope=plan.scopes.find(item=>item.id===input?.scope),scopeIdentity=await relayAccountScopeIdentity(ctx);
  if(!scope||!scopeIdentity||scope.identityHash!==scopeIdentity)return {reason:'account_hub_scope_unknown'};
  if(plan.account.evidenceHash!==await relayAccountAdmissionHash(input.evidence)||input.coordination?.planId!==plan.planId||
    input.coordination.maxReservations!==plan.coordination.maxReservations||input.coordination.maxRejections!==plan.coordination.maxRejections||
    input.coordination.storedBytes!==plan.coordination.storedBytes)return {reason:'account_preparation_binding_unknown'};
  const expected=plan.scopes.map(item=>({scope:item.id,...item.preparation})).sort((a,b)=>a.scope.localeCompare(b.scope));
  if(JSON.stringify([...(input.allocations||[])].sort((a,b)=>a.scope.localeCompare(b.scope)))!==JSON.stringify(expected)||
    JSON.stringify(input.reserve)!==JSON.stringify(costSum(plan.scopes.map(item=>item.ordinary)))||
    ['rowsRead','rowsWritten','storedBytes'].some(key=>plan.account.used[key]!==input.evidence.account?.[key]?.used||plan.account.limit[key]!==input.evidence.account?.[key]?.limit))return {reason:'account_preparation_binding_unknown'};
  return {plan,identity};
}

// Operator/internal executable adapter. It has no HTTP route. It accepts only
// a genuine local durable allocator, never a caller callback/serialized receipt.
// Transport across isolates is intentionally unavailable pending upstream proof.
export async function relayAccountPrepare(allocator,ctx,input,now=Date.now()){
  let signature,snapshot,configuration;
  try{signature=JSON.stringify(input);snapshot=JSON.parse(signature);configuration=await preparationConfiguration(allocator,ctx,snapshot,now);}catch{return nativeBlocked('account_preparation_input_unknown');}
  if(configuration.reason)return nativeBlocked(configuration.reason);
  let paid;
  const permit=await relayMigrationPreflightAdmission(ctx,snapshot,now,async claim=>{
    const payloadHash=await relayAccountAdmissionHash({input:snapshot,reservationId:claim.reservationId});
    const receipt=await allocator.reserve({planId:configuration.plan.planId,day:claim.utcDay,scope:claim.scope,lane:'preparation',id:claim.reservationId,payloadHash,
      cost:{rowsRead:PREFLIGHT.stepRowsRead,rowsWritten:PREFLIGHT.stepRowsWritten,storedBytes:PREFLIGHT.checkpointBytes}},now);
    paid=consumeRelayAccountReservation(receipt,receiptBinding(receipt),now);
    if(paid.status!=='granted')return {status:'blocked',reason:'external_admission_unknown'};
    const trace=history.get(ctx)||[];trace.push(paid.id);history.set(ctx,trace);
    return {status:'reserved',reservationId:claim.reservationId,utcDay:claim.utcDay,scope:claim.scope,allocationSignature:claim.allocationSignature,attempt:paid.attempt,
      reserved:{rowsRead:paid.attempt*PREFLIGHT.stepRowsRead,rowsWritten:paid.attempt*PREFLIGHT.stepRowsWritten,storedBytes:PREFLIGHT.checkpointBytes},
      coordination:{planId:claim.coordination.planId,signature:claim.accountPlanSignature,reservations:paid.counters.reservations,rejections:paid.counters.rejections,reserved:claim.accountReserved}};
  });
  if(permit?.status==='blocked')return permit;
  if(JSON.stringify(input)!==signature)return nativeBlocked('account_preparation_input_changed');
  const result=immutable({...relayMigrationPreflightStep(ctx,snapshot,now,permit),runtimeIdentity:configuration.identity,paidReservationId:paid.id});
  if(result.status==='complete')prepared.set(result,{ctx,input:snapshot,identity:configuration.identity,planSignature:configuration.plan.signature});
  return result;
}

// Only complete reports branded by real native preparation above can reserve
// the final all-Hub catalog construction. This builds schema only: lazy private
// feed/data backfill and ordinary/remote operation activation remain closed.
export async function relayAccountConstructCatalog(allocator,reports,now=Date.now()){
  if(!isRelayAccountAdmission(allocator)||!Array.isArray(reports)||!reports.length||reports.length>PREFLIGHT.maxScopes)return nativeBlocked('account_final_authority_unknown');
  const originals=reports.map(report=>prepared.get(report));
  if(originals.some(value=>!value))return nativeBlocked('account_final_report_unattested');
  const plan=accountAdmissionPlan(allocator),identity=await relayAccountRuntimeIdentity();
  if(!plan||!identity||plan.day!==day(now)||plan.sourceHash!==identity.sourceHash||plan.catalogHash!==identity.catalogHash||originals.some(value=>value.planSignature!==plan.signature))return nativeBlocked('account_final_identity_unknown');
  const current=[];
  for(let n=0;n<reports.length;n++){
    const meta=originals[n],next=await relayAccountPrepare(allocator,meta.ctx,{...copy(meta.input),action:'report',expectedRevision:reports[n].revision},now);
    if(next.status!=='complete')return nativeBlocked('account_final_inventory_changed');current.push(next);
  }
  const options=originals[0].input,budget=relayMigrationPreflightBudget(current,options,now);
  if(budget.status!=='reviewable')return nativeBlocked('account_final_budget_unknown');
  const details=[];
  for(const report of current){const meta=prepared.get(report);details.push({scope:report.scope,reportHash:await relayAccountAdmissionHash(report),preparationIds:accountAdmissionPreparationIds(allocator,report.scope),constructionCost:report.estimate.total});}
  if(details.length!==plan.scopes.length||new Set(details.map(item=>item.scope)).size!==details.length)return nativeBlocked('account_final_scope_incomplete');
  const reportsHash=await relayAccountAdmissionHash(details),id=crypto.randomUUID(),payloadHash=await relayAccountAdmissionHash({id,sourceHash:identity.sourceHash,catalogHash:identity.catalogHash,reportsHash});
  const receipt=await allocator.reserveFinal({planId:plan.planId,day:plan.day,id,payloadHash,...identity,reportsHash,reports:details,constructionCost:budget.migration},now);
  const final=consumeRelayAccountReservation(receipt,receiptBinding(receipt),now);
  if(final.status!=='granted')return nativeBlocked('account_final_reservation_unavailable');
  // No await occurs between source/catalog revalidation and construction in a
  // Hub transaction. A source change during reservation is therefore refused.
  const measured={rowsRead:0,rowsWritten:0},completed=[];
  try{
    for(const report of current){
      const meta=prepared.get(report),ctx=meta.ctx;
      ctx.storage.transactionSync(()=>{
        const run=(query,...values)=>{const cursor=ctx.storage.sql.exec(query,...values),rows=[...cursor];if(!Number.isSafeInteger(cursor.rowsRead)||!Number.isSafeInteger(cursor.rowsWritten))throw Error('Metering unavailable');measured.rowsRead+=cursor.rowsRead;measured.rowsWritten+=cursor.rowsWritten;return rows;};
        const state=JSON.parse(run('SELECT checkpoint FROM relay_migration_preflight WHERE id=1')[0]?.checkpoint||'null');
        const catalog=run('SELECT name,type,tbl_name,sql FROM sqlite_master LIMIT 256');
        const signature=JSON.stringify(catalog.map(row=>[row.name,row.type,row.sql]).sort((a,b)=>a[0].localeCompare(b[0])));
        const revisions=JSON.stringify(run('SELECT name,revision FROM relay_migration_preflight_sources ORDER BY name'));
        if(!state||catalog.length===256||state.phase!=='complete'||state.runId!==report.runId||state.scope!==report.scope||state.revision!==report.revision||state.schemaSignature!==signature||state.sourceRevisions!==revisions)throw Error('Source changed');
        for(const row of [...CATALOG.tables,...CATALOG.indices,...CATALOG.triggers])if(!catalog.some(existing=>existing.name===row.name&&existing.type===row.type))run(row.sql);
        if(measured.rowsRead>final.cost.rowsRead||measured.rowsWritten>final.cost.rowsWritten)throw Error('Construction exceeded reservation');
      });
      completed.push(report.scope);
    }
    return {status:'schema_constructed',runtimeIdentity:identity,finalReservationId:final.id,native:measured,scopes:completed,dataBackfill:'pending',ordinaryTransport:'blocked'};
  }catch{return {status:'blocked',reason:'account_construction_rolled_back_or_partial',finalReservationId:final.id,native:measured,completedScopes:completed,ordinaryTransport:'blocked'};}
}
