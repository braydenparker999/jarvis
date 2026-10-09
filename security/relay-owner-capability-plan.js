// Review-only preparation. This module is deliberately outside the Worker and
// browser dependency graphs. It does not authorize requests or change scopes.
const deviceOperations = new Set(['session','messages_list','message','conversation','delivery_list','delivery_retry',
  'jobs_list','job_read','job_create','job_cancel','job_retry']);
const adminOperations = new Set(['devices_list','credentials_status','credentials_prepare','credentials_save','pair_approve']);
const id = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function planOwnerCapability(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['operation','currentDeviceId','targetDeviceId'].includes(key))
    || typeof input.operation !== 'string') throw Error('Invalid capability planning input');
  const result = {enforcement:'not_wired',requiresActionSpecificClearance:true};
  if (deviceOperations.has(input.operation)) return {...result,proposedRequirement:'owner_device'};
  if (adminOperations.has(input.operation)) return {...result,proposedRequirement:'owner_admin_step_up'};
  if (input.operation === 'device_revoke') return {...result,proposedRequirement:
    id(input.currentDeviceId) && id(input.targetDeviceId) && input.currentDeviceId === input.targetDeviceId ? 'owner_device' : 'owner_admin_step_up'};
  return {...result,proposedRequirement:'unsupported'};
}
