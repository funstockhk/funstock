import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEngine, boot, call, login } from './engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rules = (await import(path.join(root, 'site/admin/js/rules.js'))).default
  || await import(path.join(root, 'site/admin/js/rules.js'));
const FSRules = rules.default || rules;
const engine = loadEngine(path.join(root, 'apps-script/Code.gs'));
const store = boot(engine);
const advisor = login(engine, 'AC02-SYN-ADVISOR');
const client = login(engine, 'AC02-SYN-CLIENT');
const results = [];
const version = 'apps-script/Code.gs + site/admin rules';

function rec(round, id, input, expected, actual, ok, note) {
  results.push({
    round, id, input, expected, actual,
    version, environment: 'synthetic-memory', backend: 'apps-script/Code.gs',
    status: ok ? 'pass' : 'fail', note: note || ''
  });
  if (!ok) console.error('FAIL', id, JSON.stringify(actual));
}

function monthOf(asOf) {
  return String(asOf).slice(0, 7);
}

const me = call(engine, advisor.token, 'me', {});
rec('R1', 'SYN-R1-AUTH-OK', { jobId: 'AC02-SYN-ADVISOR' }, '顾问会话', me.data && me.data.user && me.data.user.role, me.ok && me.data.user.role === '顾问');
rec('R1', 'SYN-R1-OPENING-FLAG', {}, 'default false', me.data && me.data.openingConfirmed, me.data && me.data.openingConfirmed === false);
rec('R1', 'SYN-R1-NO-TOKEN', { action: 'getPlans' }, 'UNAUTHENTICATED', call(engine, '', 'getPlans', {}).code, call(engine, '', 'getPlans', {}).code === 'UNAUTHENTICATED');
const bad = call(engine, '', 'login', { jobId: 'AC02-SYN-ADVISOR', password: 'wrong' });
rec('R1', 'SYN-R1-BAD-PASSWORD', { password: 'wrong' }, '拒绝', bad.code || bad.error, bad.ok === false);
const disabled = call(engine, '', 'login', { jobId: 'AC02-SYN-DISABLED', password: 'synthetic-only-not-a-real-secret' });
rec('R1', 'SYN-R1-DISABLED', { jobId: 'AC02-SYN-DISABLED' }, '拒绝', disabled.ok, disabled.ok === false);
const emptyEngine = loadEngine(path.join(root, 'apps-script/Code.gs'));
emptyEngine.setTestStore_({ users: [], logs: [] });
const emptyLogin = call(emptyEngine, '', 'login', { jobId: 'AC02-SYN-ADVISOR', password: 'x' });
rec('R1', 'SYN-R1-EMPTY-AUTH', { users: [] }, 'AUTH_STORE_MISSING', emptyLogin.code, emptyLogin.code === 'AUTH_STORE_MISSING');
engine.setTestStore_(store);

rec('R1', 'SYN-R1-MONTH-CANON', { value: '2026-11-01' }, '2026-11', FSRules.canonYearMonth('2026-11-01'), FSRules.canonYearMonth('2026-11-01') === '2026-11');
rec('R1', 'SYN-R1-SHEET-TEXT', { month: '2026-11' }, "'2026-11", engine.sheetMonthKey_('2026-11'), engine.sheetMonthKey_('2026-11') === "'2026-11");
const dateKey = engine.canonYearMonth_(new Date('2026-11-01T00:00:00+08:00'));
rec('R1', 'SYN-R1-DATE-COERCION', { date: '2026-11-01+08' }, '2026-11', dateKey, dateKey === '2026-11');

const asOf = me.data.asOf;
const current = monthOf(asOf);
store.plans.push({ id: 'PL-SEEDED', yearMonth: current + '-01', type: '固定', title: 'SYN_DASH', status: '未完成', planDate: asOf, owner: 'SYN' });
const dash = call(engine, advisor.token, 'getDashboard', {});
const dashHit = (dash.data.plansThisMonth || []).some((p) => p.id === 'PL-SEEDED');
rec('R2', 'SYN-R2-DASH-CANON', { seeded: current + '-01' }, 'listed on current month', dashHit, dashHit === true);

const plan = call(engine, advisor.token, 'savePlan', {
  yearMonth: '2026-11-01', type: '固定', title: 'SYN_PLAN', planDate: '2026-11-30', owner: 'SYN', clientRequestId: 'PL-REQ-1'
});
rec('R2', 'SYN-R2-PLAN-MONTH', { yearMonth: '2026-11-01' }, '2026-11', plan.data && plan.data.plan.yearMonth, plan.ok && plan.data.plan.yearMonth === '2026-11');
const planReplay = call(engine, advisor.token, 'savePlan', {
  yearMonth: '2026-11', type: '固定', title: 'SYN_PLAN_DUP', clientRequestId: 'PL-REQ-1'
});
rec('R2', 'SYN-R2-PLAN-IDEMPOTENT', { clientRequestId: 'PL-REQ-1' }, 'same id', planReplay.data && planReplay.data.plan.id, planReplay.ok && planReplay.data.idempotentReplay === true && planReplay.data.plan.id === plan.data.plan.id);
const plans = call(engine, advisor.token, 'getPlans', {});
rec('R2', 'SYN-R2-PLAN-READ', { title: 'SYN_PLAN' }, 'present once', (plans.data.plans || []).filter((p) => p.clientRequestId === 'PL-REQ-1').length, (plans.data.plans || []).filter((p) => p.clientRequestId === 'PL-REQ-1').length === 1);

const months = [];
for (let y = 2025, m = 8; y < 2026 || (y === 2026 && m <= 10); ) {
  months.push(y + '-' + String(m).padStart(2, '0'));
  m += 1;
  if (m === 13) { m = 1; y += 1; }
}
months.push('2026-11');
let monthFails = [];
months.forEach((ym, index) => {
  const id = 'CA-M-' + ym;
  const added = call(engine, advisor.token, 'addCashItem', {
    yearMonth: ym, date: ym + '-15', desc: 'SYN_' + ym, direction: '收入', amount: 1, currency: 'HKD', counterparty: 'SYN', clientRequestId: id
  });
  const read = call(engine, advisor.token, 'getMonth', { yearMonth: ym + '-01' });
  const row = ((read.data && read.data.month && read.data.month.cashItems) || []).find((item) => item.id === (added.data && added.data.item && added.data.item.id));
  if (!added.ok || !row || row.amount !== 1 || read.data.month.yearMonth !== ym) monthFails.push(ym + ':' + (added.error || 'mismatch'));
});
rec('R2', 'SYN-R2-MONTH-SPAN', { from: '2025-08', to: '2026-11' }, 'read-after-write each month', monthFails, monthFails.length === 0);

store.months['2026-11-01'] = store.months['2026-11-01'] || {
  yearMonth: '2026-11-01', deadline: '2026-12-05', statements: [], cashItems: [
    { id: 'CA-ALIAS', date: '2026-11-02', desc: 'ALIAS', direction: '收入', amount: 100, currency: 'HKD', amountHkd: 100, counterparty: 'SYN', clientRequestId: 'ALIAS' }
  ], rejectedCash: [], ledgerGenerated: false, bankBalanced: false, completionConfirmed: false, posted: false
};
const alias = call(engine, advisor.token, 'getMonth', { yearMonth: '2026-11' });
const aliasHit = ((alias.data.month && alias.data.month.cashItems) || []).some((item) => item.id === 'CA-ALIAS');
rec('R2', 'SYN-R2-CASH-ALIAS', { stored: '2026-11-01', query: '2026-11' }, 'CA-ALIAS listed under 2026-11', { hit: aliasHit, key: alias.data.month.yearMonth }, aliasHit && alias.data.month.yearMonth === '2026-11');

const cash = call(engine, advisor.token, 'addCashItem', {
  yearMonth: '2026-11', date: '2026-11-18', desc: 'SYN_CASH_100', direction: '收入', amount: 100, currency: 'HKD', counterparty: 'SYN', clientRequestId: 'CASH-100'
});
const listed = cash.ok && cash.data.readback && cash.data.readback.listed === true && cash.data.readback.amount === 100;
const logHit = (store.logs || []).some((l) => l.action === '登记现金或第三方收支' && String(l.notes).indexOf(cash.data.item.id) >= 0 && String(l.target).indexOf('2026-11') >= 0);
rec('R2', 'SYN-R2-CASH-PARITY', { amount: 100, month: '2026-11' }, 'listed and audited', { listed, logHit, id: cash.data && cash.data.item && cash.data.item.id }, listed && logHit);
const cashReplay = call(engine, advisor.token, 'addCashItem', {
  yearMonth: '2026-11', date: '2026-11-18', desc: 'SYN_CASH_100', direction: '收入', amount: 100, currency: 'HKD', counterparty: 'SYN', clientRequestId: 'CASH-100'
});
const cashCount = (call(engine, advisor.token, 'getMonth', { yearMonth: '2026-11' }).data.month.cashItems || []).filter((item) => item.clientRequestId === 'CASH-100').length;
rec('R2', 'SYN-R2-CASH-IDEMPOTENT', { clientRequestId: 'CASH-100' }, 'one row', { replay: cashReplay.data && cashReplay.data.idempotentReplay, cashCount }, cashReplay.data.idempotentReplay === true && cashCount === 1);

const boundary = call(engine, advisor.token, 'addCashItem', {
  yearMonth: '2026-10', date: '2026-10-02', desc: 'SYN_2000', direction: '支出', amount: 2000, currency: 'HKD', counterparty: 'SYN', clientRequestId: 'CASH-2000'
});
rec('R2', 'SYN-R2-CASH-2000', { amount: 2000 }, 'accepted', boundary.ok && boundary.data.readback.amount, boundary.ok && boundary.data.readback.amount === 2000 && boundary.data.readback.listed === true);

const tiny = { name: 'syn.txt', mime: 'text/plain', data: Buffer.from('synthetic').toString('base64') };
const uploaded = call(engine, advisor.token, 'uploadDocument', { category: '其他', relatedId: 'SYN-REL-1' }, tiny);
rec('R3', 'SYN-R3-RELATED-ECHO', { relatedId: 'SYN-REL-1' }, 'echoed', uploaded.data && uploaded.data.relatedId, uploaded.ok && uploaded.data.relatedId === 'SYN-REL-1' && uploaded.data.file.relatedId === 'SYN-REL-1');
const docs = call(engine, advisor.token, 'getDocuments', {});
rec('R3', 'SYN-R3-RELATED-LIST', { relatedId: 'SYN-REL-1' }, 'visible on file', (docs.data.files || []).some((f) => f.relatedId === 'SYN-REL-1'), (docs.data.files || []).some((f) => f.relatedId === 'SYN-REL-1'));

const proposal = call(engine, advisor.token, 'uploadProposal', { title: 'SYN_PROPOSAL', yearMonth: '2026-11' }, tiny);
const proposalFile = (call(engine, advisor.token, 'getDocuments', {}).data.files || []).find((f) => f.id === proposal.data.file.id);
rec('R3', 'SYN-R3-PROPOSAL-FILE', { title: 'SYN_PROPOSAL' }, '计划与策划书', proposalFile && proposalFile.category, proposal.ok && proposalFile && proposalFile.category === '计划与策划书');

const contract = call(engine, advisor.token, 'createContract', {
  contractNo: 'SYN-C-1', counterparty: 'SYN_COUNTERPARTY', type: '咨询技术', amount: 100, currency: 'HKD', firstAmount: 40, firstDueDate: '2026-11-30', signedDate: '2026-11-18'
});
rec('R3', 'SYN-R3-CONTRACT-LEDGER', { contractNo: 'SYN-C-1' }, '草稿', contract.data && contract.data.contract.status, contract.ok && contract.data.contract.status === '草稿');
const official = call(engine, advisor.token, 'generateOfficialContract', { contractNo: 'SYN-C-1' });
rec('R3', 'SYN-R3-OFFICIAL-LOCKED', { action: 'generateOfficialContract' }, 'GENERATION_CLOSED', official.code, official.ok === false && official.code === 'GENERATION_CLOSED');
const dashContract = call(engine, advisor.token, 'getDashboard', {});
rec('R3', 'SYN-R3-CONTRACT-DASH', { contractNo: 'SYN-C-1' }, 'on dashboard', (dashContract.data.contracts || []).some((c) => c.contractNo === 'SYN-C-1'), (dashContract.data.contracts || []).some((c) => c.contractNo === 'SYN-C-1'));

const stmt = call(engine, advisor.token, 'addStatement', {
  yearMonth: '2025-07', accountName: 'SYN-BANK', accountId: 'SYN-BANK', opening: 0, closing: 100, currency: 'HKD',
  lines: [{ date: '2025-07-15', desc: 'SYN_INTEREST', direction: '收入', amount: 100, counterparty: 'SYN', waiverCategory: '银行利息' }]
});
const ledger = call(engine, advisor.token, 'generateLedger', { yearMonth: '2025-07' });
rec('R3', 'SYN-R3-LEDGER', { month: '2025-07' }, 'balanced draft', ledger.ok && ledger.data.month.bankBalanced, ledger.ok && ledger.data.month.bankBalanced === true && ledger.data.month.posted !== true);
const lineId = ledger.data.lines[0].id;
const early = call(engine, advisor.token, 'confirmCompletion', { yearMonth: '2025-07' });
rec('R3', 'SYN-R3-CONFIRM-UNFINISHED', { lineId }, 'rejected', early.ok, early.ok === false);
const waived = call(engine, advisor.token, 'waiveOriginal', { lineId });
rec('R3', 'SYN-R3-WAIVE', { lineId }, '免原件', waived.data && waived.data.line.voucherStatus, waived.ok && waived.data.line.voucherStatus === '免原件');
const confirmed = call(engine, advisor.token, 'confirmCompletion', { yearMonth: '2025-07' });
rec('R3', 'SYN-R3-CONFIRM', { month: '2025-07' }, 'confirmed', confirmed.data && confirmed.data.month.completionConfirmed, confirmed.ok && confirmed.data.month.completionConfirmed === true);
const preview = call(engine, advisor.token, 'previewFourStatements', { yearMonth: '2025-07' });
rec('R3', 'SYN-R3-PREVIEW-NOT-POSTED', { month: '2025-07' }, 'not persisted', preview.data && preview.data.persisted, preview.ok && preview.data.persisted === false && preview.data.documentStatus === '模拟/草稿 非正式凭证');
const draftExport = call(engine, advisor.token, 'exportFourStatementsDraft', { yearMonth: '2025-07', format: 'csv', clientRequestId: 'EX-1' });
const postedBefore = call(engine, advisor.token, 'getMonth', { yearMonth: '2025-07' }).data.month.posted;
const draftExportAgain = call(engine, advisor.token, 'exportFourStatementsDraft', { yearMonth: '2025-07', format: 'csv', clientRequestId: 'EX-1' });
rec('R3', 'SYN-R3-FOUR-CSV', { month: '2025-07' }, 'draft csv, not posted', {
  status: draftExport.data && draftExport.data.documentStatus,
  formal: draftExport.data && draftExport.data.formal,
  postedBefore,
  replay: draftExportAgain.data && draftExportAgain.data.idempotentReplay,
  mark: draftExport.data && String(draftExport.data.csv).indexOf('模拟/草稿 非正式凭证') >= 0
}, draftExport.ok && draftExport.data.formal === false && postedBefore === false && draftExportAgain.data.idempotentReplay === true && String(draftExport.data.csv).indexOf('模拟/草稿 非正式凭证') >= 0);
const pdf = call(engine, advisor.token, 'exportFourStatementsDraft', { yearMonth: '2025-07', format: 'pdf' });
rec('R3', 'SYN-R3-PDF-GATED', { format: 'pdf' }, 'PDF_UNSUPPORTED', pdf.code, pdf.code === 'PDF_UNSUPPORTED');
const postedBlocked = call(engine, advisor.token, 'postFourStatements', { yearMonth: '2025-07' });
rec('R4', 'SYN-R4-POST-LOCKED', { openingConfirmed: false }, 'OPENING_UNCONFIRMED', postedBlocked.code, postedBlocked.ok === false && postedBlocked.code === 'OPENING_UNCONFIRMED');
const still = call(engine, advisor.token, 'getMonth', { yearMonth: '2025-07' });
rec('R4', 'SYN-R4-POST-NOT-WRITTEN', { month: '2025-07' }, 'posted false', still.data.month.posted, still.data.month.posted === false);

store.config.openingConfirmed = true;
const posted = call(engine, advisor.token, 'postFourStatements', { yearMonth: '2025-07' });
rec('R4', 'SYN-R4-POST-WHEN-FLAG', { openingConfirmed: true, label: 'synthetic gate proof only' }, 'posted', posted.ok && posted.data && posted.data.balanced, posted.ok && posted.data.balanced === true);
store.config.openingConfirmed = false;

const over = call(engine, advisor.token, 'addCashItem', {
  yearMonth: '2026-08', date: '2026-08-15', desc: 'SYN_OVER', direction: '收入', amount: 2000.01, currency: 'HKD', counterparty: 'SYN', clientRequestId: 'CASH-OVER'
});
const overMonth = call(engine, advisor.token, 'getMonth', { yearMonth: '2026-08' });
const overListed = (overMonth.data.month.cashItems || []).some((item) => item.clientRequestId === 'CASH-OVER');
rec('R4', 'SYN-R4-CASH-2000-01', { amount: 2000.01 }, 'CASH_LIMIT and not listed', { code: over.code, listed: overListed, rejected: (overMonth.data.rejectedCash || []).length }, over.code === 'CASH_LIMIT' && overListed === false && (overMonth.data.rejectedCash || []).length >= 1);
const zero = call(engine, advisor.token, 'addCashItem', { yearMonth: '2026-08', date: '2026-08-16', desc: 'ZERO', direction: '收入', amount: 0, currency: 'HKD', clientRequestId: 'CASH-0' });
const neg = call(engine, advisor.token, 'addCashItem', { yearMonth: '2026-08', date: '2026-08-16', desc: 'NEG', direction: '收入', amount: -1, currency: 'HKD', clientRequestId: 'CASH-NEG' });
rec('R4', 'SYN-R4-CASH-NONPOSITIVE', { amounts: [0, -1] }, 'CASH_AMOUNT', [zero.code, neg.code], zero.code === 'CASH_AMOUNT' && neg.code === 'CASH_AMOUNT');
const clientCash = call(engine, client.token, 'addCashItem', { yearMonth: '2026-08', date: '2026-08-16', desc: 'NOPE', direction: '收入', amount: 1, currency: 'HKD' });
rec('R4', 'SYN-R4-CLIENT-CASH', { role: '客户' }, 'FORBIDDEN', clientCash.code, clientCash.code === 'FORBIDDEN');
const clientPlan = call(engine, client.token, 'savePlan', { yearMonth: '2026-11', type: '固定', title: 'NOPE' });
rec('R4', 'SYN-R4-CLIENT-PLAN', { role: '客户' }, 'FORBIDDEN', clientPlan.code, clientPlan.code === 'FORBIDDEN');
const feedback = call(engine, client.token, 'savePlan', { mode: 'feedback', id: plan.data.plan.id, feedback: 'SYN_FB' });
rec('R4', 'SYN-R4-CLIENT-FEEDBACK', { mode: 'feedback' }, 'saved', feedback.ok && feedback.data.plan.feedback, feedback.ok && feedback.data.plan.feedback === 'SYN_FB');
const tamper = call(engine, advisor.token, 'addCashItem', { yearMonth: '2026-11', date: '2026-10-01', desc: 'TAMPER', direction: '收入', amount: 10, currency: 'HKD' });
rec('R4', 'SYN-R4-DATE-MONTH', { date: '2026-10-01', month: '2026-11' }, 'MONTH_MISMATCH', tamper.code, tamper.code === 'MONTH_MISMATCH');
const uiAmount = FSRules.checkCashAmount(2000.01);
const uiZero = FSRules.checkCashAmount(0);
const uiGate = FSRules.formalPostDecision({ openingConfirmed: false, ledgerGenerated: true, bankBalanced: true, completionConfirmed: true, unfinished: 0 });
rec('R4', 'SYN-R4-UI-RULES', { amount: 2000.01, openingConfirmed: false }, 'blocked before request', { uiAmount: uiAmount.code, uiZero: uiZero.code, allowed: uiGate.allowed }, uiAmount.ok === false && uiZero.ok === false && uiGate.allowed === false);

const unbalanced = call(engine, advisor.token, 'addStatement', {
  yearMonth: '2026-07', accountName: 'SYN-BANK', accountId: 'SYN-BANK-2', opening: 0, closing: 1, currency: 'HKD',
  lines: [{ date: '2026-07-01', desc: 'SYN', direction: '收入', amount: 5, counterparty: 'SYN' }]
});
const genBad = call(engine, advisor.token, 'generateLedger', { yearMonth: '2026-07' });
rec('R4', 'SYN-R4-UNBALANCED', { opening: 0, line: 5, closing: 1 }, 'UNBALANCED', genBad.code, unbalanced.ok && genBad.code === 'UNBALANCED');

const linkedCash = call(engine, advisor.token, 'addCashItem', {
  yearMonth: '2024-12-01', date: '2024-12-15', desc: 'SYN_LINKED_INCOME', direction: '收入', amount: 100, currency: 'HKD', counterparty: 'SYN', contractNo: 'SYN-C-1', clientRequestId: 'CASH-LINK'
});
const linkedRead = call(engine, advisor.token, 'getMonth', { yearMonth: '2024-12' });
const linkedRow = ((linkedRead.data.month && linkedRead.data.month.cashItems) || []).find((item) => item.clientRequestId === 'CASH-LINK');
rec('R3', 'SYN-R3-CASH-CONTRACT-MONTH', { storedMonth: '2024-12-01', query: '2024-12' }, 'linked income listed', linkedRow && linkedRow.contractNo, linkedCash.ok && linkedRow && linkedRow.contractNo === 'SYN-C-1' && linkedRead.data.month.yearMonth === '2024-12');
const orderCash = call(engine, advisor.token, 'addCashItem', { yearMonth: '2024-12', date: '2024-12-16', desc: 'ORDER', direction: '收入', amount: 1, currency: 'HKD', orderId: 'ORD-1' });
rec('R3', 'SYN-R3-ORDER-GAP', { orderId: 'ORD-1' }, 'ORDER_UNSUPPORTED', orderCash.code, orderCash.code === 'ORDER_UNSUPPORTED');
const file = call(engine, advisor.token, 'uploadDocument', { category: '其他', relatedId: 'SYN-C-1' }, tiny);
const draft = call(engine, advisor.token, 'createInvoiceDraft', { contractNo: 'SYN-C-1', lineId: linkedCash.data.item.id, fileId: file.data.file.id, clientRequestId: 'INV-1' });
const draftAgain = call(engine, advisor.token, 'createInvoiceDraft', { contractNo: 'SYN-C-1', lineId: linkedCash.data.item.id, fileId: file.data.file.id, clientRequestId: 'INV-2' });
rec('R3', 'SYN-R3-INVOICE-DRAFT', { contractNo: 'SYN-C-1' }, 'draft mark, no official number', {
  status: draft.data && draft.data.invoice.status,
  official: draft.data && draft.data.invoice.official,
  same: draftAgain.data && draftAgain.data.invoice.invoiceNo
}, draft.ok && draft.data.invoice.status === '模拟/草稿 非正式凭证' && draft.data.invoice.official === false && draft.data.invoice.officialNumber == null && String(draft.data.invoice.csv).indexOf('模拟/草稿 非正式凭证') >= 0 && draftAgain.data.invoice.invoiceNo === draft.data.invoice.invoiceNo);
const recon = call(engine, advisor.token, 'getReconciliation', { contractNo: 'SYN-C-1' });
rec('R3', 'SYN-R3-RECONCILE', { contractNo: 'SYN-C-1' }, 'contract, cash, file, draft; no order', {
  orderSupported: recon.data && recon.data.orderSupported
}, recon.ok && recon.data.orderSupported === false && recon.data.cashIncome.some((c) => c.id === linkedCash.data.item.id) && recon.data.files.some((f) => f.id === file.data.file.id) && recon.data.invoices.some((inv) => inv.official === false));
const mismatch = call(engine, advisor.token, 'createInvoiceDraft', { contractNo: 'SYN-C-1', lineId: linkedCash.data.item.id, amount: 999 });
const orderDraft = call(engine, advisor.token, 'createInvoiceDraft', { contractNo: 'SYN-C-1', orderId: 'ORD-9' });
const officialInv = call(engine, advisor.token, 'issueOfficialInvoice', { contractNo: 'SYN-C-1' });
rec('R4', 'SYN-R4-INVOICE-GATES', {}, 'mismatch, order, official closed', [mismatch.code, orderDraft.code, officialInv.code], mismatch.code === 'AMOUNT_MISMATCH' && orderDraft.code === 'ORDER_UNSUPPORTED' && officialInv.code === 'OFFICIAL_INVOICE_CLOSED');
const clientDraft = call(engine, client.token, 'createInvoiceDraft', { contractNo: 'SYN-C-1' });
const clientExport = call(engine, client.token, 'exportFourStatementsDraft', { yearMonth: '2025-07' });
const openingWrite = call(engine, advisor.token, 'setOpeningConfirmed', { openingConfirmed: true });
const openingField = call(engine, advisor.token, 'getPlans', { openingConfirmed: true });
rec('R4', 'SYN-R4-AUTHZ', { role: '客户', opening: true }, 'forbidden or immutable', [clientDraft.code, clientExport.code, openingWrite.code, openingField.code], clientDraft.code === 'FORBIDDEN' && clientExport.code === 'FORBIDDEN' && openingWrite.code === 'OPENING_IMMUTABLE' && openingField.code === 'OPENING_IMMUTABLE' && store.config.openingConfirmed === false);
const big = call(engine, advisor.token, 'uploadDocument', { category: '其他', relatedId: 'TOO-BIG' }, { name: 'big.bin', mime: 'application/octet-stream', data: 'A'.repeat(14 * 1024 * 1024) });
rec('R4', 'SYN-R4-FILE-LIMIT', { bytes: 'about 10MB+' }, 'rejected', big.ok, big.ok === false && String(big.error).indexOf('10') >= 0);

const isolatedSheet = '__AC02_SPREADSHEET_ID__';
const isolatedDrive = '__AC02_DRIVE_ROOT__';
function withProps(props, fn) {
  global.__FS_TEST_PROPS__ = props;
  try { return fn(); } finally { delete global.__FS_TEST_PROPS__; }
}
let sheetOpened = false;
global.SpreadsheetApp = { openById: function () { sheetOpened = true; throw new Error('opened'); } };
global.DriveApp = { getFolderById: function () { sheetOpened = true; throw new Error('opened'); } };
const wrongSheet = withProps({ AC02_SPREADSHEET_ID: 'OTHER-SHEET-NOT-ISOLATED' }, function () {
  return call(engine, advisor.token, 'getPlans', {});
});
const wrongDrive = withProps({ DRIVE_ROOT_ID: 'OTHER-DRIVE-NOT-ISOLATED' }, function () {
  return call(engine, '', 'login', { jobId: 'AC02-SYN-ADVISOR', password: 'synthetic-only-not-a-real-secret' });
});
const matched = withProps({
  AC02_SPREADSHEET_ID: isolatedSheet,
  AC02_DRIVE_ROOT_ID: isolatedDrive,
  SECRET_PROPERTY: 'do-not-leak'
}, function () { return call(engine, advisor.token, 'getEffectiveTargets', {}); });
delete global.SpreadsheetApp;
delete global.DriveApp;
const matchedText = JSON.stringify(matched.data || {});
rec('R4', 'SYN-R4-TARGET-MISMATCH', { sheet: 'other', drive: 'other' }, 'TARGET_MISMATCH before open', {
  sheet: wrongSheet.code,
  drive: wrongDrive.code,
  opened: sheetOpened
}, wrongSheet.code === 'TARGET_MISMATCH' && wrongDrive.code === 'TARGET_MISMATCH' && sheetOpened === false && String(wrongSheet.error).indexOf('OTHER-SHEET') < 0 && String(wrongDrive.error).indexOf('OTHER-DRIVE') < 0);
rec('R4', 'SYN-R4-TARGET-MATCH', { override: 'same isolated ids' }, 'two ids only, secret omitted', {
  spreadsheetId: matched.data && matched.data.spreadsheetId,
  driveRootId: matched.data && matched.data.driveRootId,
  leaked: matchedText.indexOf('do-not-leak') >= 0
}, matched.ok && matched.data.spreadsheetId === isolatedSheet && matched.data.driveRootId === isolatedDrive && matched.data.productionData === false && matchedText.indexOf('do-not-leak') < 0 && matchedText.indexOf('SECRET_PROPERTY') < 0);
const noTokenTargets = call(engine, '', 'getEffectiveTargets', {});
const prod = call(engine, advisor.token, 'enableProduction', { productionData: true });
rec('R4', 'SYN-R4-ANON-AND-PROD', {}, 'unauthenticated and no production mode', [noTokenTargets.code, prod.code, me.data && me.data.buildId], noTokenTargets.code === 'UNAUTHENTICATED' && prod.code === 'PRODUCTION_MODE_CLOSED' && me.data.buildId === 'ac02-preview' && me.data.productionData === false);

const outDir = path.join(root, 'tests/synthetic/results');
fs.mkdirSync(outDir, { recursive: true });
const summary = {
  kind: 'synthetic',
  live: 'BLOCKED',
  liveNote: 'No live GAS or Sheet call. Forthcoming QA live rounds are a separate set and are not these results.',
  version,
  environment: 'synthetic-memory',
  backend: 'apps-script/Code.gs',
  buildId: 'ac02-preview',
  dataMode: 'ac02-preview',
  productionData: false,
  passed: results.filter((r) => r.status === 'pass').length,
  failed: results.filter((r) => r.status === 'fail').length,
  results
};
fs.writeFileSync(path.join(outDir, 'node-rounds.json'), JSON.stringify(summary, null, 2));
['R1', 'R2', 'R3', 'R4'].forEach((round) => {
  const rows = results.filter((r) => r.round === round);
  fs.writeFileSync(path.join(outDir, 'synthetic-' + round.toLowerCase() + '.json'), JSON.stringify({
    kind: 'synthetic', live: 'BLOCKED', round, passed: rows.filter((r) => r.status === 'pass').length, failed: rows.filter((r) => r.status === 'fail').length, results: rows
  }, null, 2));
});
console.log(JSON.stringify({ passed: summary.passed, failed: summary.failed }));
process.exit(summary.failed ? 1 : 0);
