import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {planOwnerCapability} from '../security/relay-owner-capability-plan.js';
const current='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
test('proposed device/admin split classifies risky operations and cannot authorize an actual request',()=>{
  for(const operation of ['session','messages_list','message','conversation','delivery_list','delivery_retry','jobs_list','job_read','job_create','job_cancel','job_retry'])
    assert.deepEqual(planOwnerCapability({operation}),{enforcement:'not_wired',requiresActionSpecificClearance:true,proposedRequirement:'owner_device'});
  for(const operation of ['devices_list','credentials_status','credentials_prepare','credentials_save','pair_approve'])
    assert.equal(planOwnerCapability({operation}).proposedRequirement,'owner_admin_step_up');
  assert.equal(planOwnerCapability({operation:'device_revoke',currentDeviceId:current,targetDeviceId:current}).proposedRequirement,'owner_device');
  for(const targetDeviceId of [other,undefined,'invalid'])assert.equal(planOwnerCapability({operation:'device_revoke',currentDeviceId:current,targetDeviceId}).proposedRequirement,'owner_admin_step_up');
  assert.equal(planOwnerCapability({operation:'unknown'}).proposedRequirement,'unsupported');
  assert.throws(()=>planOwnerCapability({operation:'message',device_token:'synthetic-token'}),/Invalid/);
  assert.throws(()=>planOwnerCapability({operation:'credentials_save',password:'synthetic-password'}),/Invalid/);
});
test('capability preparation is absent from the actual Worker/browser bundles; no production permissions change',async()=>{
  for(const entry of ['backend/worker.js','public/assets/app.js']){
    const bundled=await build({entryPoints:[entry],bundle:true,write:false,metafile:true,format:'esm',platform:'neutral',external:['node:*'],logLevel:'silent'});
    assert.equal(Object.keys(bundled.metafile.inputs).some(path=>path.includes('relay-owner-capability-plan')),false);
  }
});
