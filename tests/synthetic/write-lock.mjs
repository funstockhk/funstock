/**
 * Every write action takes the one script lock. Read actions do not.
 * No network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine, boot, call, login } from './engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gasPath = path.join(root, 'apps-script/Code.gs');
const gas = fs.readFileSync(gasPath, 'utf8');
assert.equal((gas.match(/LockService\.getScriptLock\(\)/g) || []).length, 1);
assert.equal(gas.includes('getDocumentLock'), false);
assert.equal(gas.includes('getUserLock'), false);

const READS = [
  'me', 'getDashboard', 'getPlans', 'getProposals', 'getDocuments', 'getMonth',
  'getContracts', 'getReconciliation', 'getLogs', 'getEffectiveTargets'
];

const events = [];
global.LockService = {
  getScriptLock: function () {
    const rec = { waited: false, released: false };
    events.push(rec);
    return {
      waitLock: function () { rec.waited = true; },
      releaseLock: function () { rec.released = true; }
    };
  }
};

const engine = loadEngine(gasPath);
const store = boot(engine);
const advisor = login(engine, 'AC02-SYN-ADVISOR');
assert.equal(advisor.ok, true, advisor.error || advisor.code);
const writes = engine.FS_IMPLEMENTED_ACTIONS.filter((action) => READS.indexOf(action) < 0);
assert.ok(writes.indexOf('postFourStatements') >= 0);
assert.ok(writes.indexOf('uploadDocument') >= 0);
assert.ok(writes.indexOf('login') >= 0);
assert.equal(writes.indexOf('getPlans'), -1);

function run(action) {
  events.length = 0;
  const token = action === 'login' ? '' : advisor.token;
  const payload = action === 'login'
    ? { jobId: 'AC02-SYN-ADVISOR', password: 'synthetic-only-not-a-real-secret' }
    : {};
  const uploaded = action === 'uploadDocument' || action === 'uploadProposal'
    ? { name: 'syn.txt', mime: 'text/plain', data: Buffer.from('synthetic').toString('base64') }
    : null;
  call(engine, token, action, payload, uploaded);
  return events.slice();
}

const locked = [];
for (const action of writes) {
  const seen = run(action);
  assert.equal(seen.length, 1, action + ' lock calls ' + seen.length);
  assert.equal(seen[0].waited, true, action + ' did not wait on the script lock');
  assert.equal(seen[0].released, true, action + ' did not release the script lock');
  locked.push(action);
}

const unlocked = [];
for (const action of READS) {
  const seen = run(action);
  assert.equal(seen.length, 0, action + ' acquired a lock');
  unlocked.push(action);
}

console.log(JSON.stringify({
  ok: true,
  writes: locked.length,
  reads: unlocked.length,
  lock: 'LockService.getScriptLock'
}, null, 2));
