import {accessSync, constants, readdirSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Each former npm-test file has exactly one owner in the aggregate workflow.
// New .test.js files default to regressions; Relay files enter fast feedback.
export const dedicated = ['tests/poweramp-blank-library-browser.test.js', 'tests/podcasts-browser.test.js'];
export const relayContracts = ['tests/ci-workflow.test.js', 'tests/oauth-consent-browser.test.js',
  'tests/shared.test.js', 'tests/publications.test.js', 'tests/origins.test.js', 'tests/hub.test.js'];
export const performance = ['tests/poweramp-render-trace-browser.mjs',
  'tests/poweramp-persistent-prototype-browser.mjs', 'tests/poweramp-preview-setup-browser.mjs'];

export function inventory(files) {
  const all = [...files].sort();
  if (new Set(all).size !== all.length) throw Error('Duplicate aggregate test file');
  for (const path of [...dedicated, ...relayContracts]) {
    if (!all.includes(path)) throw Error('Missing required aggregate test: ' + path);
  }
  const relay = all.filter(path => relayContracts.includes(path) || /^tests\/relay-.*\.test\.js$/.test(path));
  const regressions = all.filter(path => !dedicated.includes(path) && !relay.includes(path));
  const groups = {relay, regressions, blankLibrary: [dedicated[0]], podcasts: [dedicated[1]]};
  const assigned = Object.values(groups).flat();
  if (assigned.length !== all.length || new Set(assigned).size !== all.length ||
      all.some(path => !assigned.includes(path))) throw Error('Aggregate inventory must cover every test exactly once');
  return {groups, aggregate: all, performance};
}

export function requireBrowser(env = process.env) {
  const path = env.JARVIS_CHROME;
  if (!path || !path.startsWith('/')) throw Error('JARVIS_CHROME must name an executable Chromium binary; browser coverage cannot skip');
  try {
    if (!statSync(path).isFile()) throw Error('not a file');
    accessSync(path, constants.X_OK);
  } catch {
    throw Error('JARVIS_CHROME is not an executable file; browser coverage cannot skip');
  }
  return path;
}

export function auditWorkflows(source, owner) {
  const count = (text, value) => text.split(value).length - 1;
  for (const group of ['relay', 'regressions', 'blankLibrary', 'podcasts']) {
    if (count(source, `node tests/helpers/ci-test-inventory.mjs run ${group} --require-browser`) !== 1)
      throw Error('Aggregate workflow must execute ' + group + ' exactly once with mandatory Chromium');
  }
  if (/^\s*(?:npm test|node --test tests\/(?:poweramp-blank-library-browser\.test\.js|podcasts-browser\.test\.js))\s*$/m.test(source))
    throw Error('Legacy aggregate or dedicated command duplicates inventoried tests');
  for (const path of performance) {
    if (count(source, 'node --test ' + path) !== 1) throw Error('Preserve one serial performance gate: ' + path);
  }
  const positions = performance.map(path => source.indexOf('node --test ' + path));
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1]))
    throw Error('Preserve serial performance measurement order');
  if (count(source, 'if: ${{ !cancelled() }}') !== 5)
    throw Error('Preserve media/performance evidence after ordinary failures');
  for (const name of ['poweramp-render-trace', 'poweramp-browser', 'podcast-browser', 'ci-test-inventory']) {
    if (count(source, 'name: ' + name + '-${{ github.run_id }}') !== 1)
      throw Error('Preserve browser and coverage evidence artifact: ' + name);
  }
  if (count(source, 'if: always()') !== 4 || count(source, 'retention-days: 14') !== 4)
    throw Error('Preserve always-uploaded browser/coverage artifacts and retention');
  if (!source.includes('python -m unittest discover -s tests -p \'test_r2*.py\' -v'))
    throw Error('Preserve migration integrity coverage');
  if (!owner.includes("- 'tests/oauth-consent-browser.test.js'"))
    throw Error('OAuth browser changes must trigger fast Relay validation');
  if (!owner.includes('node tests/helpers/ci-test-inventory.mjs run relay --require-browser'))
    throw Error('Fast Relay validation must include the OAuth browser contract');
  if (!owner.includes("REQUIRE_RELAY_OWNER_BROWSER: '1'")) throw Error('Owner browser coverage must remain mandatory');
  for (const workflow of [source, owner]) {
    if (!workflow.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}") ||
        !workflow.includes("${{ github.event_name == 'pull_request' && github.ref || github.run_id }}"))
      throw Error('Cancel only superseded pull-request validation, with unique non-PR groups');
  }
  return true;
}

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const coverage = inventory(readdirSync(resolve(root, 'tests')).filter(path => path.endsWith('.test.js')).map(path => 'tests/' + path));
    const [command, group, browser] = process.argv.slice(2);
    if (command === 'check') {
      for (const path of performance) accessSync(resolve(root, path), constants.R_OK);
      console.log(JSON.stringify(coverage, null, 2));
    } else if (command === 'run' && Object.hasOwn(coverage.groups, group) && browser === '--require-browser') {
      requireBrowser();
      console.log('Executing ' + group + ': ' + coverage.groups[group].join(', '));
      const result = spawnSync(process.execPath, ['--test', ...coverage.groups[group]], {cwd: root, env: process.env, stdio: 'inherit'});
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } else throw Error('Use check or run <group> --require-browser');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
