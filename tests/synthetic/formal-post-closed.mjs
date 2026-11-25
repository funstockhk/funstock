/**
 * Formal four-statement posting stays closed even when the month is ready.
 * No network. Asserts the closed code and zero writes on the mock store.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine, boot, call, login } from './engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const engine = loadEngine(path.join(root, 'apps-script/Code.gs'));
const store = boot(engine);
const advisor = login(engine, 'AC02-SYN-ADVISOR');
assert.equal(advisor.ok, true, advisor.error || advisor.code);

const stmt = call(engine, advisor.token, 'addStatement', {
  yearMonth: '2025-07',
  accountName: 'SYN-BANK',
  accountId: 'SYN-BANK',
  opening: 0,
  closing: 100,
  currency: 'HKD',
  lines: [{ date: '2025-07-15', desc: 'SYN_INTEREST', direction: '收入', amount: 100, counterparty: 'SYN', waiverCategory: '银行利息' }]
});
assert.equal(stmt.ok, true, stmt.error || stmt.code);
const ledger = call(engine, advisor.token, 'generateLedger', { yearMonth: '2025-07' });
assert.equal(ledger.ok, true, ledger.error || ledger.code);
assert.equal(ledger.data.month.bankBalanced, true);
const lineId = ledger.data.lines[0].id;
const waived = call(engine, advisor.token, 'waiveOriginal', { lineId });
assert.equal(waived.ok, true, waived.error || waived.code);
const confirmed = call(engine, advisor.token, 'confirmCompletion', { yearMonth: '2025-07' });
assert.equal(confirmed.ok, true, confirmed.error || confirmed.code);
const preview = call(engine, advisor.token, 'previewFourStatements', { yearMonth: '2025-07' });
assert.equal(preview.ok, true, preview.error || preview.code);
assert.equal(preview.data.balanced, true);
assert.equal(preview.data.persisted, false);

store.config.openingConfirmed = true;
const before = JSON.stringify(store);
const posted = call(engine, advisor.token, 'postFourStatements', { yearMonth: '2025-07' });
assert.equal(posted.ok, false);
assert.equal(posted.code, 'PREVIEW_FORMAL_POST_CLOSED');
assert.equal(posted.status, 403);
assert.equal(JSON.stringify(store), before, 'postFourStatements must not write the mock store');
assert.notEqual(store.months['2025-07'] && store.months['2025-07'].posted, true);

let direct = null;
try {
  engine.postFourStatements_(store, '2025-07', advisor.user.jobId);
} catch (err) {
  direct = err;
}
assert.equal(direct && direct.code, 'PREVIEW_FORMAL_POST_CLOSED');
assert.equal(JSON.stringify(store), before, 'direct postFourStatements_ must not write the mock store');

console.log(JSON.stringify({
  ok: true,
  code: posted.code,
  writes: 0,
  openingConfirmed: true,
  previewBalanced: true
}, null, 2));
