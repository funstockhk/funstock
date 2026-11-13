'use strict';

const { newId, nowIso, todayYmd } = require('./store');

const STATUSES = [
  '草稿',
  '待收（付）首期',
  '执行中',
  '逾期',
  '暂停',
  '已解除待结算',
  '状态一：完成交付并完成收款',
  '状态二：部分交付部分收款（双方同意）',
  '状态三：协议取消解除',
];

const EXECUTION_STATES = new Set(['执行中', '逾期', '暂停']);
const CLOSED_STATES = new Set([
  '状态一：完成交付并完成收款',
  '状态二：部分交付部分收款（双方同意）',
  '状态三：协议取消解除',
]);

function findContract(store, contractNo) {
  const c = (store.contracts || []).find((x) => x.contractNo === contractNo);
  if (!c) {
    const err = new Error('找不到该合同。');
    err.status = 404;
    throw err;
  }
  return c;
}

function findFile(store, fileId) {
  const f = (store.files || []).find((x) => x.id === fileId);
  if (!f) {
    const err = new Error('找不到该文件。');
    err.status = 404;
    throw err;
  }
  return f;
}

function claimFile(file, module, contractNo, actor, role) {
  file.claimedBy = file.claimedBy || [];
  const already = file.claimedBy.some((c) => c.module === module && c.contractNo === contractNo && c.role === role);
  if (!already) {
    file.claimedBy.push({ module, contractNo, role, at: nowIso(), actor });
  }
}

function createContract(store, payload, actor) {
  if (payload.generateOfficial) {
    const err = new Error('对客正式合同生成入口已关闭。本预览只做台账、流程、状态和文件归档。');
    err.status = 403;
    err.code = 'GENERATION_CLOSED';
    throw err;
  }
  const contractNo = payload.contractNo || newId('CT');
  if ((store.contracts || []).some((c) => c.contractNo === contractNo)) {
    const err = new Error('合同号已存在。');
    err.status = 400;
    throw err;
  }
  const c = {
    contractNo,
    counterparty: payload.counterparty,
    type: payload.type, // 咨询技术 | 贸易 | 服务 | 销售
    stage: '生成',
    status: '草稿',
    signedDate: payload.signedDate || '',
    signedFileId: '',
    firstVoucherFileId: '',
    amount: Number(payload.amount) || 0,
    currency: payload.currency || 'HKD',
    firstAmount: Number(payload.firstAmount) || Number(payload.amount) || 0,
    firstDueDate: payload.firstDueDate || '',
    agreementFileId: '',
    closeType: '',
    deliveryType: payload.type === '贸易' ? '贸易' : '咨询技术',
    plan: [],
    payments: payload.payments || [],
    notes: payload.notes || '测试台账，非正式对客合同文本。',
    createdAt: nowIso(),
    createdBy: actor,
  };
  store.contracts = store.contracts || [];
  store.contracts.push(c);
  return c;
}

function archiveSigned(store, contractNo, fileId, signedDate, actor) {
  const c = findContract(store, contractNo);
  if (CLOSED_STATES.has(c.status)) {
    const err = new Error('已完结的合同不能再改签署正本。');
    err.status = 400;
    throw err;
  }
  const file = findFile(store, fileId);
  c.signedFileId = fileId;
  c.signedDate = signedDate || c.signedDate || todayYmd();
  claimFile(file, '合同', contractNo, actor, '签署正本');
  // If first voucher already present, may enter execution; otherwise 待收（付）首期
  refreshStage(store, c);
  return c;
}

function claimFirstVoucher(store, contractNo, fileId, actor) {
  const c = findContract(store, contractNo);
  if (!c.signedFileId) {
    const err = new Error('尚未归档双方签署的合同扫描正本，不能登记首期凭证，也不能进入执行。');
    err.status = 400;
    throw err;
  }
  const file = findFile(store, fileId);
  c.firstVoucherFileId = fileId;
  claimFile(file, '合同', contractNo, actor, '首期凭证');
  // Also allow finance to claim the same file later; do not create a second ledger amount here.
  refreshStage(store, c);
  return c;
}

function buildDefaultPlan(c) {
  // Auto performance plan from contract terms
  const start = c.signedDate || todayYmd();
  const startDt = new Date(start + 'T00:00:00+08:00');
  const plusDays = (d, n) => {
    const x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const deliverDue = plusDays(startDt, 12);
  const plan = [
    {
      id: newId('PN'),
      kind: c.deliveryType === '贸易' ? '贸易发货' : '技术文档交付',
      title: c.deliveryType === '贸易' ? '上传发货凭证及双方签字确认' : '上传技术文档及双方签字确认',
      dueDate: deliverDue,
      done: false,
      fileIds: [],
      confirmFileId: '',
    },
    {
      id: newId('PN'),
      kind: '收付款',
      title: `首期收（付）款 ${c.firstAmount} ${c.currency} 与约定时间匹配`,
      dueDate: c.firstDueDate || c.signedDate || start,
      done: Boolean(c.firstVoucherFileId),
      fileIds: c.firstVoucherFileId ? [c.firstVoucherFileId] : [],
      confirmFileId: '',
    },
  ];
  if (Number(c.amount) > Number(c.firstAmount)) {
    const restDue = plusDays(startDt, 30);
    plan.push({
      id: newId('PN'),
      kind: '收付款',
      title: `余额收（付）款 ${Number(c.amount) - Number(c.firstAmount)} ${c.currency}`,
      dueDate: restDue,
      done: false,
      fileIds: [],
      confirmFileId: '',
    });
  }
  return plan;
}

function hasOverdueNode(c, asOf) {
  const day = asOf || todayYmd();
  return (c.plan || []).some((p) => !p.done && p.dueDate && p.dueDate < day);
}

function refreshStage(store, c, asOf) {
  const day = asOf || todayYmd();
  if (CLOSED_STATES.has(c.status) || c.status === '已解除待结算' || c.status === '暂停') {
    return c;
  }
  if (!c.signedFileId) {
    c.stage = '生成';
    c.status = '草稿';
    return c;
  }
  if (!c.firstVoucherFileId) {
    c.stage = '生成';
    c.status = '待收（付）首期';
    return c;
  }
  // Enter execution
  c.stage = '执行';
  if (!c.plan || !c.plan.length) c.plan = buildDefaultPlan(c);
  // Mark first payment node done
  for (const p of c.plan) {
    if (p.kind === '收付款' && p.title.startsWith('首期') && c.firstVoucherFileId) {
      p.done = true;
      if (!p.fileIds.includes(c.firstVoucherFileId)) p.fileIds.push(c.firstVoucherFileId);
    }
  }
  if (hasOverdueNode(c, day)) c.status = '逾期';
  else c.status = '执行中';
  return c;
}

function enterExecution(store, contractNo, actor) {
  const c = findContract(store, contractNo);
  if (!c.signedFileId || !c.firstVoucherFileId) {
    const err = new Error(
      '未完成第一环节规定产物：须同时归档双方签署的合同扫描正本，以及首期收或付银行凭证，才能进入执行。签署正本已归档、首期尚未发生的，状态应为「待收（付）首期」。',
    );
    err.status = 400;
    throw err;
  }
  c.plan = c.plan && c.plan.length ? c.plan : buildDefaultPlan(c);
  refreshStage(store, c);
  return c;
}

function updatePlanNode(store, contractNo, nodeId, payload, actor) {
  const c = findContract(store, contractNo);
  if (!EXECUTION_STATES.has(c.status) && c.status !== '逾期') {
    const err = new Error('合同尚未进入执行阶段，不能更新履约节点。');
    err.status = 400;
    throw err;
  }
  const node = (c.plan || []).find((p) => p.id === nodeId);
  if (!node) {
    const err = new Error('找不到该履约节点。');
    err.status = 404;
    throw err;
  }
  if (payload.fileId) {
    const file = findFile(store, payload.fileId);
    claimFile(file, '合同', c.contractNo, actor, '履约文件');
    if (!node.fileIds.includes(payload.fileId)) node.fileIds.push(payload.fileId);
  }
  if (payload.confirmFileId) {
    const file = findFile(store, payload.confirmFileId);
    claimFile(file, '合同', c.contractNo, actor, '双方确认');
    node.confirmFileId = payload.confirmFileId;
  }
  if (payload.done) {
    // consulting/tech needs technical doc + mutual confirmation; trade needs shipping + confirmation
    if (node.kind !== '收付款') {
      if (!node.fileIds.length || !node.confirmFileId) {
        const err = new Error(
          c.deliveryType === '贸易'
            ? '贸易类须上传发货凭证以及双方签字确认，才能将该交付节点标为完成。'
            : '咨询技术类须上传技术文档以及双方签字确认，才能将该交付节点标为完成。',
        );
        err.status = 400;
        throw err;
      }
    } else if (!node.fileIds.length) {
      const err = new Error('每一笔收付款须上传或认领对应银行凭证，并与约定时间匹配。');
      err.status = 400;
      throw err;
    }
    node.done = true;
  }
  refreshStage(store, c);
  return c;
}

function pauseContract(store, contractNo, agreementFileId, actor) {
  const c = findContract(store, contractNo);
  if (!agreementFileId) {
    const err = new Error('暂停须有双方书面同意文件。');
    err.status = 400;
    throw err;
  }
  const file = findFile(store, agreementFileId);
  claimFile(file, '合同', c.contractNo, actor, '暂停协议');
  c.agreementFileId = agreementFileId;
  c.status = '暂停';
  c.stage = '执行';
  return c;
}

function closeContract(store, contractNo, closeType, agreementFileId, actor) {
  const c = findContract(store, contractNo);
  if (!c.signedFileId) {
    const err = new Error('不得跳过签署正本直接完结。');
    err.status = 400;
    throw err;
  }
  const type = closeType;
  if (type === '状态一' || type === '状态一：完成交付并完成收款') {
    const deliverDone = (c.plan || []).filter((p) => p.kind !== '收付款').every((p) => p.done);
    const payDone = (c.plan || []).filter((p) => p.kind === '收付款').every((p) => p.done);
    if (!deliverDone || !payDone || !c.firstVoucherFileId) {
      const err = new Error('状态一要求全部约定交付已完成且凭证齐备，全部约定款项已收或已付且银行凭证齐备。');
      err.status = 400;
      throw err;
    }
    c.status = '状态一：完成交付并完成收款';
    c.closeType = '状态一';
    c.stage = '完结';
    return c;
  }
  if (type === '状态二' || type === '状态二：部分交付部分收款（双方同意）') {
    if (!agreementFileId) {
      const err = new Error('状态二须有双方确认文件，写明已完成的交付、已收或已付的款项，以及不再履行的部分。不得在无双方协议时把未履行完毕的合同标为状态二。');
      err.status = 400;
      throw err;
    }
    const file = findFile(store, agreementFileId);
    claimFile(file, '合同', c.contractNo, actor, '部分完结协议');
    c.agreementFileId = agreementFileId;
    c.status = '状态二：部分交付部分收款（双方同意）';
    c.closeType = '状态二';
    c.stage = '完结';
    return c;
  }
  if (type === '已解除待结算') {
    if (!agreementFileId) {
      const err = new Error('协议取消或解除须有双方解除或取消协议。');
      err.status = 400;
      throw err;
    }
    const file = findFile(store, agreementFileId);
    claimFile(file, '合同', c.contractNo, actor, '解除协议');
    c.agreementFileId = agreementFileId;
    c.status = '已解除待结算';
    c.closeType = '已解除待结算';
    c.stage = '执行';
    return c;
  }
  if (type === '状态三' || type === '状态三：协议取消解除') {
    if (!agreementFileId && !c.agreementFileId) {
      const err = new Error('状态三须有双方解除或取消协议。不得在无双方协议时把合同标为状态三。');
      err.status = 400;
      throw err;
    }
    if (agreementFileId) {
      const file = findFile(store, agreementFileId);
      claimFile(file, '合同', c.contractNo, actor, '解除协议');
      c.agreementFileId = agreementFileId;
    }
    c.status = '状态三：协议取消解除';
    c.closeType = '状态三';
    c.stage = '完结';
    return c;
  }
  const err = new Error('本预览未写明的完结状态不能新增。请使用状态一、状态二、已解除待结算或状态三。');
  err.status = 400;
  throw err;
}

function officialGenerateBlocked() {
  const err = new Error('对客正式合同生成入口已关闭。合同模板未经审定前，只提供台账、流程、状态和文件归档。');
  err.status = 403;
  err.code = 'GENERATION_CLOSED';
  throw err;
}

module.exports = {
  STATUSES,
  createContract,
  archiveSigned,
  claimFirstVoucher,
  enterExecution,
  updatePlanNode,
  pauseContract,
  closeContract,
  officialGenerateBlocked,
  refreshStage,
  buildDefaultPlan,
  findContract,
};
