'use strict';

const { newId, nowIso, todayYmd } = require('./store');

const CASH_LINE_LIMIT = 2000;
const CASH_MONTH_LIMIT = 20000;
const WAIVER_TYPES = ['银行利息', 'MPF', '工资', '租金'];

function ensureMonth(store, yearMonth) {
  store.months = store.months || {};
  if (!store.months[yearMonth]) {
    const [y, m] = yearMonth.split('-').map(Number);
    const deadlineMonth = m === 12 ? 1 : m + 1;
    const deadlineYear = m === 12 ? y + 1 : y;
    const deadline = `${deadlineYear}-${String(deadlineMonth).padStart(2, '0')}-05`;
    store.months[yearMonth] = {
      yearMonth,
      deadline,
      statements: [],
      cashItems: [],
      rejectedCash: [],
      ledgerGenerated: false,
      bankBalanced: false,
      bankBalanceDiff: null,
      completionConfirmed: false,
      completionConfirmedAt: null,
      posted: false,
      postedAt: null,
    };
  }
  return store.months[yearMonth];
}

function pastDeadline(month, asOf) {
  const day = asOf || todayYmd();
  return day > month.deadline;
}

function hkd(amount, currency, fx) {
  const rate = currency === 'HKD' || !currency ? 1 : (fx[currency] || null);
  if (rate == null) {
    const err = new Error(`没有币种 ${currency} 的汇率，拒绝折算，以免造数。`);
    err.status = 400;
    throw err;
  }
  return round2(Number(amount) * rate);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function fxMap(store) {
  const map = { HKD: 1 };
  for (const row of store.config.fx || []) map[row.currency] = Number(row.rate);
  return map;
}

function addStatement(store, yearMonth, payload) {
  const month = ensureMonth(store, yearMonth);
  if (month.posted) {
    const err = new Error('该月已定稿并计入正式四套账，不能再改月结单。');
    err.status = 400;
    throw err;
  }
  if (month.completionConfirmed) {
    const err = new Error('该月完成页已确认，不能再改月结单。如需调整请走冲账流程。');
    err.status = 400;
    throw err;
  }
  month.ledgerGenerated = false;
  month.bankBalanced = false;
  const stmt = {
    id: payload.id || newId('ST'),
    accountId: payload.accountId,
    accountName: payload.accountName,
    fileId: payload.fileId || '',
    opening: round2(payload.opening),
    closing: round2(payload.closing),
    currency: payload.currency || 'HKD',
    lines: (payload.lines || []).map((ln) => ({
      id: ln.id || newId('SL'),
      date: ln.date,
      desc: ln.desc,
      direction: ln.direction, // 收入 | 支出
      amount: round2(ln.amount),
      currency: ln.currency || payload.currency || 'HKD',
      counterparty: ln.counterparty || '',
      waiverCategory: ln.waiverCategory || '',
    })),
  };
  const computed = round2(
    stmt.opening +
      stmt.lines.reduce((s, ln) => s + (ln.direction === '收入' ? ln.amount : -ln.amount), 0),
  );
  stmt.internalDiff = round2(computed - stmt.closing);
  const idx = month.statements.findIndex((s) => s.accountId === stmt.accountId);
  if (idx >= 0) month.statements[idx] = stmt;
  else month.statements.push(stmt);
  return stmt;
}

function addCashItem(store, yearMonth, payload) {
  const month = ensureMonth(store, yearMonth);
  if (month.posted || month.completionConfirmed) {
    const err = new Error('该月已确认或已定稿，不能再按快捷通道登记现金或第三方收支。');
    err.status = 400;
    throw err;
  }
  const amount = round2(payload.amount);
  const fx = fxMap(store);
  const amountHkd = hkd(amount, payload.currency || 'HKD', fx);

  const reason = checkCashLimits(month, amountHkd, fx);
  if (reason) {
    month.rejectedCash = month.rejectedCash || [];
    month.rejectedCash.push({
      at: nowIso(),
      amount: amountHkd,
      desc: payload.desc || '',
      reason,
    });
    const err = new Error(reason);
    err.status = 400;
    err.code = 'CASH_LIMIT';
    throw err;
  }

  month.ledgerGenerated = false;
  const item = {
    id: payload.id || newId('CA'),
    date: payload.date,
    desc: payload.desc,
    direction: payload.direction,
    amount,
    currency: payload.currency || 'HKD',
    amountHkd,
    counterparty: payload.counterparty || '',
    fileId: payload.fileId || '',
  };
  month.cashItems.push(item);
  return item;
}

function checkCashLimits(month, newAmountHkd, fx) {
  if (newAmountHkd > CASH_LINE_LIMIT) {
    return `单笔现金或第三方收支为 ${newAmountHkd} 港元，超过 2,000 港元上限，不得按本条直接进入第一本明细账，须另行说明并补齐原件后再处理。`;
  }
  const existing = (month.cashItems || []).reduce((s, i) => {
    const v = i.amountHkd != null ? i.amountHkd : hkd(i.amount, i.currency || 'HKD', fx);
    return s + Number(v);
  }, 0);
  if (round2(existing + newAmountHkd) > CASH_MONTH_LIMIT) {
    return `当月现金或第三方收支合计将达到 ${round2(existing + newAmountHkd)} 港元，超过 20,000 港元上限，不得按本条直接进入第一本明细账，须另行说明并补齐原件后再处理。`;
  }
  return null;
}

function generateLedger(store, yearMonth) {
  const month = ensureMonth(store, yearMonth);
  if (!month.statements.length) {
    const err = new Error('尚未上传任何银行月结单，不能生成第一本明细账。');
    err.status = 400;
    throw err;
  }

  // Bank side must match each statement
  const diffs = [];
  for (const stmt of month.statements) {
    const computed = round2(
      stmt.opening +
        stmt.lines.reduce((s, ln) => s + (ln.direction === '收入' ? Number(ln.amount) : -Number(ln.amount)), 0),
    );
    const diff = round2(computed - Number(stmt.closing));
    stmt.internalDiff = diff;
    if (diff !== 0) diffs.push({ account: stmt.accountName, computed, closing: stmt.closing, diff });
  }
  month.bankBalanced = diffs.length === 0;
  month.bankBalanceDiff = diffs;
  if (!month.bankBalanced) {
    month.ledgerGenerated = false;
    const err = new Error(
      '月结单与银行侧收支轧差不一致，不能生成可继续处理的第一本明细账。差额：' +
        diffs.map((d) => `${d.account} 计算${d.computed} / 结单${d.closing} / 差${d.diff}`).join('；'),
    );
    err.status = 400;
    err.code = 'UNBALANCED';
    throw err;
  }

  // Rebuild this month's ledger lines (keep attachment state if line keys match)
  const previous = (store.ledger || []).filter((l) => l.yearMonth === yearMonth);
  const keep = new Map(previous.map((l) => [l.sourceKey, l]));

  store.ledger = (store.ledger || []).filter((l) => l.yearMonth !== yearMonth);
  const fx = fxMap(store);
  const lines = [];

  for (const stmt of month.statements) {
    for (const sl of stmt.lines) {
      const sourceKey = `stmt:${stmt.id}:${sl.id}`;
      const prev = keep.get(sourceKey);
      const line = {
        id: (prev && prev.id) || newId('JL'),
        yearMonth,
        date: sl.date,
        desc: sl.desc,
        direction: sl.direction,
        amount: sl.amount,
        currency: sl.currency || stmt.currency || 'HKD',
        amountHkd: hkd(sl.amount, sl.currency || stmt.currency || 'HKD', fx),
        account: stmt.accountName,
        source: '月结单',
        sourceKey,
        statementId: stmt.id,
        contractNo: (prev && prev.contractNo) || '',
        fileId: (prev && prev.fileId) || stmt.fileId && sl.claimStatement ? stmt.fileId : (prev && prev.fileId) || '',
        voucherStatus: (prev && prev.voucherStatus) || '',
        waiverCategory: sl.waiverCategory || (prev && prev.waiverCategory) || '',
        counterparty: sl.counterparty || '',
        posted: false,
        notes: (prev && prev.notes) || '',
        subject: inferSubject(sl, '月结单'),
        auditTrail: (prev && prev.auditTrail) || [],
      };
      lines.push(line);
    }
  }
  for (const ca of month.cashItems) {
    const sourceKey = `cash:${ca.id}`;
    const prev = keep.get(sourceKey);
    lines.push({
      id: (prev && prev.id) || newId('JL'),
      yearMonth,
      date: ca.date,
      desc: ca.desc,
      direction: ca.direction,
      amount: ca.amount,
      currency: ca.currency || 'HKD',
      amountHkd: ca.amountHkd != null ? ca.amountHkd : hkd(ca.amount, ca.currency || 'HKD', fx),
      account: '现金或第三方（不经公司银行）',
      source: '现金或第三方',
      sourceKey,
      statementId: '',
      contractNo: (prev && prev.contractNo) || ca.contractNo || '',
      fileId: (prev && prev.fileId) || ca.fileId || '',
      voucherStatus: (prev && prev.voucherStatus) || '',
      waiverCategory: '',
      counterparty: ca.counterparty || '',
      posted: false,
      notes: (prev && prev.notes) || '',
      subject: inferSubject(ca, '现金或第三方'),
      auditTrail: (prev && prev.auditTrail) || [],
    });
  }

  store.ledger.push(...lines);
  month.ledgerGenerated = true;
  month.completionConfirmed = false;
  month.posted = false;
  return { month: summarizeMonth(store, yearMonth), lines };
}

function inferSubject(item, source) {
  const cat = item.waiverCategory || '';
  if (cat === '银行利息') return '利息收入';
  if (cat === 'MPF') return 'MPF';
  if (cat === '工资') return '工资';
  if (cat === '租金') return '租金';
  if (item.direction === '收入') return '主营业务收入';
  return '待分类支出';
}

function findLine(store, lineId, opts) {
  const line = (store.ledger || []).find((l) => l.id === lineId);
  if (!line) {
    const err = new Error('找不到该明细。');
    err.status = 404;
    throw err;
  }
  const month = store.months[line.yearMonth];
  const allowPostedNoop = opts && opts.allowPostedNoop;
  if (month && month.posted && !allowPostedNoop) {
    const err = new Error('该月已定稿，不能直接改原暂记痕迹；如需调整请走冲账流程。');
    err.status = 400;
    throw err;
  }
  return line;
}

function canWaive(store, line) {
  if (line.source !== '月结单') {
    return { ok: false, reason: '未出现在月结单上的项目不得免原件（例如现金支付租金）。' };
  }
  const cat = line.waiverCategory;
  if (!WAIVER_TYPES.includes(cat)) {
    return { ok: false, reason: '免原件仅限银行利息、MPF、按正常发放的工资、按正常金额支付的租金。' };
  }
  const std = (store.config && store.config.waiverStandards) || {};
  if (cat === '工资' && Number(line.amountHkd) !== Number(std.salary)) {
    return { ok: false, reason: `工资金额 ${line.amountHkd} 与既定标准 ${std.salary} 不一致，不得免原件，须补传原件并说明差异。` };
  }
  if (cat === '租金' && Number(line.amountHkd) !== Number(std.rent)) {
    return { ok: false, reason: `租金金额 ${line.amountHkd} 与既定标准 ${std.rent} 不一致，不得免原件，须补传原件并说明差异。` };
  }
  return { ok: true };
}

function attachOrClaim(store, lineId, fileId, actor, isClaim) {
  const monthPosted = (() => {
    const preview = (store.ledger || []).find((l) => l.id === lineId);
    return preview && store.months[preview.yearMonth] && store.months[preview.yearMonth].posted;
  })();
  const line = findLine(store, lineId, { allowPostedNoop: true });
  const file = (store.files || []).find((f) => f.id === fileId);
  if (!file) {
    const err = new Error('找不到该文件，不能认领。');
    err.status = 404;
    throw err;
  }
  // Already attached to this same file after the month was posted: only record the claim, do not rewrite the line.
  if (monthPosted && line.fileId === fileId && line.voucherStatus === '已附原件') {
    file.claimedBy = file.claimedBy || [];
    const already = file.claimedBy.some((c) => c.lineId === lineId);
    if (!already) file.claimedBy.push({ module: '月账', lineId: line.id, at: nowIso(), actor });
    return line;
  }
  if (monthPosted) {
    const err = new Error('该月已定稿，不能直接改原暂记痕迹或更换附件；如需调整请走冲账流程。合同或其他模块仍可认领同一份已入账文件，但不能再改该月流水。');
    err.status = 400;
    throw err;
  }
  if (line.voucherStatus === '暂记往来') {
    line.auditTrail.push({
      at: nowIso(),
      actor,
      action: '凭真凭证调整（原暂记痕迹保留）',
      from: '暂记往来',
      to: '已附原件',
      fileId,
    });
  }
  line.fileId = fileId;
  line.voucherStatus = '已附原件';
  file.claimedBy = file.claimedBy || [];
  const already = file.claimedBy.some((c) => c.lineId === lineId);
  if (!already) {
    file.claimedBy.push({ module: '月账', lineId: line.id, at: nowIso(), actor });
  }
  file.source = file.source || (isClaim ? '认领' : '收件');
  return line;
}

function waiveLine(store, lineId, actor) {
  const line = findLine(store, lineId);
  const check = canWaive(store, line);
  if (!check.ok) {
    const err = new Error(check.reason);
    err.status = 400;
    throw err;
  }
  line.voucherStatus = '免原件';
  line.auditTrail.push({ at: nowIso(), actor, action: '标明免原件' });
  return line;
}

function markSuspense(store, lineId, actor, asOf) {
  const line = findLine(store, lineId);
  const month = store.months[line.yearMonth];
  if (!pastDeadline(month, asOf)) {
    const err = new Error(`尚未到限期（${month.deadline}），请先补传或认领原件；限期后仍缺原件且不得免原件的，才可暂记往来。`);
    err.status = 400;
    throw err;
  }
  if (line.voucherStatus === '已附原件' || line.voucherStatus === '免原件') {
    const err = new Error('该笔已附原件或已免原件，不必暂记往来。');
    err.status = 400;
    throw err;
  }
  const check = canWaive(store, line);
  if (check.ok) {
    const err = new Error('该笔符合免原件规定，应标明免原件，而不是暂记往来。');
    err.status = 400;
    throw err;
  }
  line.voucherStatus = '暂记往来';
  line.subject = '其他应收款（暂记往来）';
  line.notes = (line.notes ? line.notes + '；' : '') + '限期后缺原件，暂记与划款人或收款人的往来，不得先记成收入或费用。';
  line.auditTrail.push({ at: nowIso(), actor, action: '标明暂记往来', note: '原痕迹保留，后续调整须另记操作记录。' });
  return line;
}

function completionGroups(store, yearMonth) {
  const lines = (store.ledger || []).filter((l) => l.yearMonth === yearMonth);
  const groups = {
    已附原件: lines.filter((l) => l.voucherStatus === '已附原件'),
    免原件: lines.filter((l) => l.voucherStatus === '免原件'),
    暂记往来: lines.filter((l) => l.voucherStatus === '暂记往来'),
    未处理: lines.filter((l) => !l.voucherStatus),
  };
  return { lines, groups };
}

function confirmCompletion(store, yearMonth, actor, asOf) {
  const month = ensureMonth(store, yearMonth);
  if (!month.ledgerGenerated) {
    const err = new Error('尚未生成第一本明细账。');
    err.status = 400;
    throw err;
  }
  if (!month.bankBalanced) {
    const err = new Error('月结单与第一本明细账对不上，该月不能进入完成页确认，也不能定稿。');
    err.status = 400;
    throw err;
  }
  const { groups, lines } = completionGroups(store, yearMonth);
  if (groups.未处理.length) {
    const err = new Error(
      `尚有 ${groups.未处理.length} 条明细未标明「已附原件 / 免原件 / 暂记往来」，不能确认完成页。`,
    );
    err.status = 400;
    throw err;
  }
  if (!lines.length) {
    const err = new Error('明细为空，不能确认。');
    err.status = 400;
    throw err;
  }
  month.completionConfirmed = true;
  month.completionConfirmedAt = nowIso();
  month.confirmedBy = actor;
  return { month: summarizeMonth(store, yearMonth), groups };
}

function postFourStatements(store, yearMonth, actor) {
  const month = ensureMonth(store, yearMonth);
  if (!month.completionConfirmed) {
    const err = new Error('未经过完成页确认（该附的已附、该免的已免、该暂记的已暂记），不得计入正式四套账，也不得写入给审计用的内部记账文件。');
    err.status = 400;
    throw err;
  }
  if (!month.bankBalanced) {
    const err = new Error('月结单与第一本明细账对不上，该月不能定稿。不把未配平说成已配平。');
    err.status = 400;
    throw err;
  }
  const statements = buildFourStatements(store, yearMonth);
  if (!statements.balanced) {
    const err = new Error(`资产负债表未配平（差 ${statements.balanceDiff}），拒绝定稿，以免把未配平说成已配平。`);
    err.status = 400;
    throw err;
  }
  store.fourStatements = (store.fourStatements || []).filter((r) => r.period !== yearMonth);
  store.fourStatements.push(...statements.rows);
  for (const line of store.ledger) {
    if (line.yearMonth === yearMonth) line.posted = true;
  }
  month.posted = true;
  month.postedAt = nowIso();
  month.postedBy = actor;
  const hasSuspense = (store.ledger || []).some((l) => l.yearMonth === yearMonth && l.voucherStatus === '暂记往来');
  store.exports = store.exports || [];
  store.exports.push({
    period: yearMonth,
    type: '四套账定稿',
    date: todayYmd(),
    summary: statements.summary,
    fileId: '',
    hasSuspense,
    notes: hasSuspense
      ? '本月含暂记往来项目，已在导出中标明。未获真凭证调整前，这些项目不作为已齐备的审计附件。'
      : '本月无暂记往来。',
  });
  return statements;
}

function openingEquity(store, yearMonth) {
  // Use configured opening as of the earliest date <= first day of month; preview uses 2026-10-01
  const acc = (store.config && store.config.accounts) || [];
  const equity = acc.find((a) => a.code === '3001');
  const bank = acc.find((a) => a.code === '1001');
  return {
    equity: equity ? Number(equity.openingAmount) || 0 : 0,
    bank: bank ? Number(bank.openingAmount) || 0 : 0,
    cash: Number((acc.find((a) => a.code === '1002') || {}).openingAmount) || 0,
  };
}

function buildFourStatements(store, yearMonth) {
  const lines = (store.ledger || []).filter((l) => l.yearMonth === yearMonth);
  const opening = openingEquity(store, yearMonth);
  let income = 0;
  let expense = 0;
  let suspenseAsset = 0; // 支出暂记 → 其他应收款
  let suspenseLiability = 0; // 收入暂记 → 其他应付款
  let bankNet = 0;
  let cashNet = 0;

  const detail = [];
  for (const l of lines) {
    const amt = Number(l.amountHkd);
    const signed = l.direction === '收入' ? amt : -amt;
    const isSuspense = l.voucherStatus === '暂记往来';
    const isBank = l.source === '月结单';
    if (isBank) bankNet = round2(bankNet + signed);
    else cashNet = round2(cashNet + signed);

    if (isSuspense) {
      if (l.direction === '支出') suspenseAsset = round2(suspenseAsset + amt);
      else suspenseLiability = round2(suspenseLiability + amt);
    } else if (l.direction === '收入') {
      income = round2(income + amt);
    } else {
      expense = round2(expense + amt);
    }
    detail.push({
      type: '流水明细',
      period: yearMonth,
      item: `${l.date} ${l.desc}（${l.direction}，${l.source}，${l.voucherStatus || '未处理'}）`,
      amountHkd: signed,
      posted: true,
      hasSuspense: isSuspense,
      notes: isSuspense ? '暂记往来，不作为已确认收入或费用，亦非已齐备的审计附件。' : '',
    });
  }

  const profit = round2(income - expense);
  const endBank = round2(opening.bank + bankNet);
  const endCash = round2(opening.cash + cashNet);
  const assets = round2(endBank + endCash + suspenseAsset);
  const equity = round2(opening.equity + profit);
  const liabilities = suspenseLiability;
  const totalLE = round2(liabilities + equity);
  const balanceDiff = round2(assets - totalLE);

  const rows = [
    { type: '利润表', period: yearMonth, item: '收入（不含暂记往来）', amountHkd: income, posted: true, hasSuspense: false, notes: '' },
    { type: '利润表', period: yearMonth, item: '支出（不含暂记往来）', amountHkd: expense, posted: true, hasSuspense: false, notes: '' },
    { type: '利润表', period: yearMonth, item: '本期盈余', amountHkd: profit, posted: true, hasSuspense: false, notes: '收付实现制；暂记往来不计入本期损益。' },
    { type: '资产负债表', period: yearMonth, item: '银行存款', amountHkd: endBank, posted: true, hasSuspense: false, notes: '' },
    { type: '资产负债表', period: yearMonth, item: '现金', amountHkd: endCash, posted: true, hasSuspense: false, notes: '' },
    { type: '资产负债表', period: yearMonth, item: '其他应收款（暂记往来）', amountHkd: suspenseAsset, posted: true, hasSuspense: suspenseAsset !== 0, notes: suspenseAsset ? '未获真凭证前不作为已齐备审计附件。' : '' },
    { type: '资产负债表', period: yearMonth, item: '资产合计', amountHkd: assets, posted: true, hasSuspense: suspenseAsset !== 0, notes: '' },
    { type: '资产负债表', period: yearMonth, item: '其他应付款（暂记往来）', amountHkd: liabilities, posted: true, hasSuspense: liabilities !== 0, notes: '' },
    { type: '资产负债表', period: yearMonth, item: '期初权益', amountHkd: opening.equity, posted: true, hasSuspense: false, notes: '' },
    { type: '资产负债表', period: yearMonth, item: '本期盈余', amountHkd: profit, posted: true, hasSuspense: false, notes: '' },
    { type: '资产负债表', period: yearMonth, item: '权益合计', amountHkd: equity, posted: true, hasSuspense: false, notes: '' },
    { type: '资产负债表', period: yearMonth, item: '负债和权益合计', amountHkd: totalLE, posted: true, hasSuspense: liabilities !== 0, notes: balanceDiff === 0 ? '已配平' : `未配平，差额 ${balanceDiff}` },
    { type: '现金流量表', period: yearMonth, item: '期初货币资金', amountHkd: round2(opening.bank + opening.cash), posted: true, hasSuspense: false, notes: '' },
    { type: '现金流量表', period: yearMonth, item: '银行收支净额', amountHkd: bankNet, posted: true, hasSuspense: false, notes: '' },
    { type: '现金流量表', period: yearMonth, item: '现金或第三方收支净额', amountHkd: cashNet, posted: true, hasSuspense: false, notes: '' },
    { type: '现金流量表', period: yearMonth, item: '期末货币资金', amountHkd: round2(endBank + endCash), posted: true, hasSuspense: false, notes: '' },
    ...detail,
  ];

  return {
    period: yearMonth,
    balanced: balanceDiff === 0,
    balanceDiff,
    summary: `收入 ${income}，支出 ${expense}，盈余 ${profit}，资产 ${assets}，负债和权益 ${totalLE}，差额 ${balanceDiff}${suspenseAsset || liabilities ? '；含暂记往来' : ''}`,
    rows,
    totals: { income, expense, profit, endBank, endCash, suspenseAsset, liabilities, assets, equity, totalLE, balanceDiff },
  };
}

function summarizeMonth(store, yearMonth) {
  const month = ensureMonth(store, yearMonth);
  const { groups, lines } = completionGroups(store, yearMonth);
  return {
    ...month,
    lineCount: lines.length,
    counts: {
      已附原件: groups.已附原件.length,
      免原件: groups.免原件.length,
      暂记往来: groups.暂记往来.length,
      未处理: groups.未处理.length,
    },
    pastDeadline: pastDeadline(month),
  };
}

function incompletePlanWarning(store) {
  const plans = store.plans || [];
  const open = plans.filter((p) => p.status !== '已完成');
  const byTitle = new Map();
  for (const p of open) {
    const key = `${p.type}|${p.title}`;
    const arr = byTitle.get(key) || [];
    arr.push(p);
    byTitle.set(key, arr);
  }
  const warnings = [];
  for (const [key, arr] of byTitle) {
    const months = [...new Set(arr.map((p) => p.yearMonth))].sort();
    if (months.length >= 2) {
      warnings.push({
        title: arr[0].title,
        type: arr[0].type,
        months,
        message: `「${arr[0].title}」已跨 ${months.length} 个月未完成（${months.join('、')}），达到两次以上预警。`,
      });
    }
  }
  return warnings;
}

module.exports = {
  CASH_LINE_LIMIT,
  CASH_MONTH_LIMIT,
  WAIVER_TYPES,
  ensureMonth,
  pastDeadline,
  addStatement,
  addCashItem,
  generateLedger,
  attachOrClaim,
  waiveLine,
  markSuspense,
  confirmCompletion,
  postFourStatements,
  buildFourStatements,
  summarizeMonth,
  completionGroups,
  canWaive,
  incompletePlanWarning,
  checkCashLimits,
  fxMap,
  hkd,
};
