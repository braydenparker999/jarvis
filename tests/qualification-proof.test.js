import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {makePlan, inputOwners, COMPONENTS, RECIPE, REPOSITORY, WORKFLOW, checkedRun, checkedJobs, checkedRecipe, publicClient, findProof, assertCurrent} from '../scripts/qualification-proof.mjs';

const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40);
const env = {node22:'v22.20.0', node24:'v24.19.0', browser:'Google Chrome 154.0.8037.57', platform:'ubuntu-24.04-x64', measurement:'full-isolated-serial-v1'};
const files = readdirSync(new URL('./', import.meta.url)).filter(p => p.endsWith('.test.js')).map(p => ({path:'tests/' + p, sha}));
const entries = [...files, ...RECIPE.map(path => ({path,sha})), {path:'public/drawercast/player.js',sha},
  {path:'public/assets/relay-owner-ui.js',sha}, {path:'public/podcasts/app.js',sha}, {path:'backend/worker.js',sha},
  {path:'package-lock.json',sha}, {path:'tests/helpers/poweramp-fixture.js',sha}];
const unique = [...new Map(entries.map(e => [e.path,e])).values()];
const plan = makePlan(unique,env);
const goodRun = () => ({id:123, run_attempt:2, workflow_id:777, repository:{full_name:REPOSITORY}, head_repository:{full_name:REPOSITORY,fork:false},
  event:'push',head_branch:'main',path:WORKFLOW,status:'completed',conclusion:'success',head_sha:sha,html_url:'https://github.com/' + REPOSITORY + '/actions/runs/123'});
const jobs = (p = plan) => ['qualified-source-' + p.digest, ...COMPONENTS.map(name => 'qualified-' + name + '-' + p.components[name].digest)]
  .map(name => ({name,id:1,run_id:123,run_attempt:2,status:'completed',conclusion:'success'}));
const tree = () => ({truncated:false,tree:plan.recipe.map(e => ({...e,type:'blob'}))});
const changed = (path, value = otherSha) => makePlan(unique.map(e => e.path === path ? {...e,sha:value} : e),env);

test('all aggregate tests have exactly one execution owner, with a distinct Node24 security runtime', () => {
  const aggregate = ['relay','frontend','poweramp','blankLibrary','podcasts'].flatMap(name => plan.components[name].tests);
  assert.equal(new Set(aggregate).size, files.length);
  assert.deepEqual([...aggregate].sort(), files.map(e => e.path).sort());
  assert.deepEqual(plan.components.owner24.tests, plan.components.relay.tests);
});
test('real component edits invalidate relevant checks while unchanged isolated measurements can be proven', () => {
  const relay = changed('public/assets/relay-owner-ui.js');
  assert.notEqual(relay.components.relay.digest,plan.components.relay.digest);
  assert.notEqual(relay.components.owner24.digest,plan.components.owner24.digest);
  assert.equal(relay.components.performance.digest,plan.components.performance.digest);
  const player = changed('public/drawercast/player.js');
  for (const name of ['poweramp','blankLibrary','performance','frontend']) assert.notEqual(player.components[name].digest,plan.components[name].digest);
  const backend = changed('backend/worker.js');
  for (const name of ['relay','owner24','frontend','podcasts']) assert.notEqual(backend.components[name].digest,plan.components[name].digest);
});
test('dependencies, trusted recipe, new/deleted/renamed tests, unknown paths and environment changes invalidate conservatively', () => {
  for (const path of ['package-lock.json', ...RECIPE]) {
    const p = changed(path);
    for (const name of COMPONENTS) assert.notEqual(p.components[name].digest,plan.components[name].digest);
  }
  for (const additions of [[{path:'unknown/future.js',sha}], [{path:'tests/future-browser.test.js',sha}]]) {
    const p = makePlan([...unique,...additions],env);
    for (const name of COMPONENTS) assert.notEqual(p.components[name].digest,plan.components[name].digest);
  }
  assert.deepEqual(inputOwners('unknown/new-path',plan.coverage),COMPONENTS);
  assert.throws(() => makePlan(unique.filter(e => e.path !== 'tests/oauth-consent-browser.test.js'),env), /Missing required/);
  for (const overrides of [{node22:''},{node24:'v24'}, {browser:''}, {platform:'different'}, {measurement:'shortened'}])
    assert.throws(() => makePlan(unique,{...env,...overrides}), /identity/);
  const upgraded = makePlan(unique,{...env,browser:'Google Chrome 155.0.1.1'});
  for (const name of COMPONENTS) assert.notEqual(upgraded.components[name].digest,plan.components[name].digest);
});
test('wrong repository, source SHA, trigger, branch, workflow, attempt or unsuccessful status cannot qualify', () => {
  checkedRun(goodRun(), {sourceSha:sha,workflowId:777});
  for (const overrides of [{repository:{full_name:'other/repo'}}, {head_repository:{full_name:'fork/repo'}}, {head_repository:{full_name:REPOSITORY,fork:true}},
    {event:'pull_request'}, {event:'workflow_dispatch'}, {head_branch:'other'}, {head_sha:null}, {head_sha:otherSha},
    {path:'.github/workflows/other.yml'}, {workflow_id:555}, {status:'in_progress'}, {conclusion:'failure'}, {run_attempt:0}])
    assert.throws(() => checkedRun({...goodRun(),...overrides},{sourceSha:sha,workflowId:777}), /trusted successful/);
});
test('a copied job name, skipped gate, duplicate or mixed attempt is never a qualification proof', () => {
  const name = 'qualified-source-' + plan.digest, all = jobs();
  checkedJobs(all,goodRun(),[name]);
  for (const invalid of [all.slice(1),[...all,all[0]],all.map(j => ({...j,run_attempt:1})),all.map(j => ({...j,run_id:124})),
    all.map(j => j.name === name ? {...j,conclusion:'skipped'} : j)]) assert.throws(() => checkedJobs(invalid,goodRun(),[name]));
});
test('immutable recipe validation rejects tampering, missing blobs and incomplete trees', () => {
  checkedRecipe(tree(),plan);
  for (const invalid of [{...tree(),truncated:true},{...tree(),tree:[]}, {...tree(),tree:tree().tree.map(e => ({...e,sha:otherSha}))}])
    assert.throws(() => checkedRecipe(invalid,plan));
});
function fixtureFetch({run=goodRun(), all=jobs(), recipe=tree(), error, total=all.length} = {}) {
  return async (url,options) => {
    assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,undefined);
    assert.ok(url.startsWith('https://api.github.com/repos/' + REPOSITORY + '/'));
    if (error) return new Response('', {status:error});
    if (url.includes('/runs?')) return Response.json({workflow_runs:[run]});
    if (url.includes('/git/trees/')) return Response.json(recipe);
    if (url.includes('/attempts/2/jobs?')) return Response.json({total_count:total,jobs:all});
    throw Error('Unexpected metadata request: ' + url);
  };
}
test('exact successful source qualification and equal-component reuse bind to immutable GitHub provenance', async () => {
  const proof = await findProof(plan,{sourceSha:sha,fetcher:fixtureFetch()});
  assert.equal(proof.qualified,true);assert.equal(proof.runId,123);assert.equal(proof.attempt,2);
  const reused = await findProof(plan,{fetcher:fixtureFetch()});
  assert.deepEqual(Object.keys(reused.reuse),COMPONENTS);
  const edited = changed('public/assets/relay-owner-ui.js');
  const partial = await findProof(edited,{fetcher:fixtureFetch()});
  assert.equal(partial.reuse.relay,undefined);assert.ok(partial.reuse.performance);
});
test('expired/unavailable/malformed/incomplete/tampered proof fails closed to full current qualification', async () => {
  for (const options of [{error:403},{error:404},{error:429},{run:{...goodRun(),event:'pull_request'}},{recipe:{...tree(),truncated:true}},
    {total:101},{all:jobs().slice(1)},{all:jobs().map(j => ({...j,conclusion:'cancelled'}))}]) {
    const proof = await findProof(plan,{sourceSha:sha,fetcher:fixtureFetch(options)});
    assert.equal(proof.qualified,false);assert.deepEqual(proof.reuse,{});
  }
  const malformed = await findProof(plan,{sourceSha:sha,fetcher:async()=>new Response('not JSON')});
  assert.equal(malformed.qualified,false);
});
test('public proof reads have a strict host/path/request budget and never accept credentials or redirects', async () => {
  let count=0; const api = publicClient(async()=>{count++;return Response.json({});},{budget:1});
  await api('/repos/' + REPOSITORY + '/actions/runs');
  await assert.rejects(api('/repos/' + REPOSITORY + '/actions/runs'), /budget/);
  await assert.rejects(api('/repos/other/repo/actions/runs'), /budget/);
  assert.equal(count,1);
});
test('changed files/runtime and reduced diagnostic plans cannot satisfy a named qualification', () => {
  assert.throws(() => assertCurrent(plan,'owner24',changed('backend/worker.js').components.owner24.digest), /inputs changed/);
  assert.throws(() => assertCurrent(plan,'owner24',plan.components.owner24.digest,{POWERAMP_LAYER_PICTURES_ONLY:'1'}), /shortened/);
});
