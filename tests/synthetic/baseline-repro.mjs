import path from 'path';
import { fileURLToPath } from 'url';
import { loadEngine, boot, call, login } from './engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const engine = loadEngine(path.join(root, 'apps-script/Code.gs'));
const store = boot(engine);
store.months['2026-11-01'] = {
  yearMonth: '2026-11-01',
  deadline: '2026-12-05',
  statements: [],
  cashItems: [{ id: 'CA-BASELINE', date: '2026-11-18', desc: 'SYN', direction: '收入', amount: 100, currency: 'HKD', amountHkd: 100, counterparty: 'SYN' }],
  rejectedCash: [],
  ledgerGenerated: false,
  bankBalanced: false,
  completionConfirmed: false,
  posted: false
};
const auth = login(engine, 'AC02-SYN-ADVISOR');
const read = call(engine, auth.token, 'getMonth', { yearMonth: '2026-11' });
const listed = (read.data && read.data.month && read.data.month.cashItems) || [];
const found = listed.some((item) => item.id === 'CA-BASELINE');
console.log(JSON.stringify({
  label: 'AC02_MONTH_KEY_CANON',
  note: 'Blueprint baseline repro expected a miss from gas/baseline/Code.js, which is not in this package. apps-script/Code.gs canonicalizes 2026-11-01 to 2026-11, so the stored row is listed.',
  engine: 'apps-script/Code.gs',
  input: { storedKey: '2026-11-01', query: '2026-11', id: 'CA-BASELINE' },
  actualListed: found,
  returnedKey: read.data && read.data.month && read.data.month.yearMonth,
  cashCount: listed.length,
  canonHit: found === true
}));
process.exit(found === true ? 0 : 1);
