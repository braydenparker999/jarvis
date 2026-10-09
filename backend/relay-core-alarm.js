import * as publications from './publications.js';

// Alarm I/O yields. Serialize its read/compose/write boundaries so a stale
// scheduler cannot erase a wake recorded by a concurrent request.
const writes = new WeakMap(), wakeTables = new WeakSet();
const rows = (ctx, query, ...values) => [...ctx.storage.sql.exec(query, ...values)];
const validTime = value => typeof value === 'number' && Number.isFinite(value);
const MAX_RESERVATIONS = 256;
export const RELAY_ALARM_RETRY_MS = 60000;
export const RELAY_PRECOMMIT_EXPIRY_MS = 300000;

function serialized(ctx, operation) {
  const previous = writes.get(ctx) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  writes.set(ctx, current);
  return current.finally(() => { if (writes.get(ctx) === current) writes.delete(ctx); });
}
function wakeSchema(ctx) {
  if (wakeTables.has(ctx)) return;
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS relay_core_alarm_wakes (id TEXT PRIMARY KEY,due_ms INTEGER NOT NULL,expires_ms INTEGER NOT NULL)');
  ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS relay_core_alarm_due ON relay_core_alarm_wakes(due_ms)');
  ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS relay_core_alarm_expiry ON relay_core_alarm_wakes(expires_ms)');
  wakeTables.add(ctx);
}
function hasWakeTable(ctx) {
  if (wakeTables.has(ctx)) return true;
  if (!rows(ctx,"SELECT name FROM sqlite_master WHERE type='table' AND name='relay_core_alarm_wakes'").length) return false;
  wakeTables.add(ctx); return true;
}
function nextReserved(ctx) {
  return hasWakeTable(ctx) ? rows(ctx,'SELECT MIN(due_ms) AS n FROM relay_core_alarm_wakes')[0].n : null;
}

export function releaseRelayCoreWake(ctx, id) {
  if (id) ctx.storage.sql.exec('DELETE FROM relay_core_alarm_wakes WHERE id=?',id);
}
async function reserve(ctx, now, delay, ignoreElapsed) {
  if (!ctx.storage.setAlarm) return null;
  wakeSchema(ctx);
  if (rows(ctx,'SELECT id FROM relay_core_alarm_wakes LIMIT ?',MAX_RESERVATIONS).length >= MAX_RESERVATIONS)
    throw Error('Relay alarm admission is busy');
  const id=crypto.randomUUID();
  ctx.storage.sql.exec('INSERT INTO relay_core_alarm_wakes VALUES(?,?,?)',id,now+delay,now+Math.max(delay,RELAY_PRECOMMIT_EXPIRY_MS));
  try {
    await serialized(ctx,async()=>{
      const current=ctx.storage.getAlarm ? await ctx.storage.getAlarm() : null;
      const reserved=nextReserved(ctx);
      const times=[reserved,validTime(current)&&(!ignoreElapsed||current>now)?current:null].filter(validTime);
      // Mutation admission explicitly acknowledges durable alarm storage even
      // when another reservation already owns the same earlier timestamp.
      await ctx.storage.setAlarm(Math.max(now+50,Math.min(...times)));
    });
    return id;
  } catch(error) { releaseRelayCoreWake(ctx,id); throw error; }
}
export function reserveRelayCoreWake(ctx, now=Date.now(), delay=100) {
  return reserve(ctx,now,delay,false);
}
export async function beginRelayCoreAlarm(ctx, now=Date.now()) {
  // A fired wake does not prove that its request has committed. Retain a single
  // conservative recovery at its bounded expiry until the owner releases it.
  // A restart loses the promise, but keeps this recovery without a 50ms loop.
  if (hasWakeTable(ctx)) {
    ctx.storage.sql.exec('DELETE FROM relay_core_alarm_wakes WHERE expires_ms<=?',now);
    ctx.storage.sql.exec('UPDATE relay_core_alarm_wakes SET due_ms=expires_ms WHERE due_ms<=?',now);
  }
  return reserve(ctx,now,RELAY_ALARM_RETRY_MS,true);
}

export async function scheduleRelayCoreAlarm(ctx, nextDelivery, now=Date.now()) {
  if (!ctx.storage.setAlarm) return null;
  return serialized(ctx,async()=>{
    const current=ctx.storage.getAlarm ? await ctx.storage.getAlarm() : null;
    // Evaluate sources after the await, inside the serialized setter. The
    // publication helper is absent only on the pre-reconciliation module set.
    const publication=publications.nextPublicationReconciliationAt?.(ctx,now) ?? null;
    const delivery=typeof nextDelivery==='function' ? nextDelivery() : nextDelivery;
    const times=[publication,delivery,nextReserved(ctx)].filter(validTime);
    const next=times.length ? Math.max(now+50,Math.min(...times)) : null;
    if (next!==null) { if(current!==next)await ctx.storage.setAlarm(next); }
    else if (current!==null && current!==undefined && ctx.storage.deleteAlarm) await ctx.storage.deleteAlarm();
    return next;
  });
}
