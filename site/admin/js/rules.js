/* Shared AC02 checks. Mirrors gas/release limits. No network. Timezone: Asia/Hong_Kong. */
/* QA：Q1 定稿注释改为保持关闭（previewFormalPostClosed 恒为 allowed:false）。Q2 原修改清单行号作废，以本文件为准。Q3 文件以换行结束。Q4 代码里的待定注释为 8 处，其中与 1528 字节相关的为 3 处。H1 与 apps-script 发布身份开关对齐：preview = ac02-preview / ac02-preview / false，official = ac02-official / ac02-official / false。H2 重放夹具保留初稿既有结构，待后端确定后整组替换，本次不另造新夹具。 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FSRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var CASH_LINE_LIMIT = 2000;
  var CASH_MONTH_LIMIT = 20000;

  function canonYearMonth(v) {
    if (v == null || v === '') return '';
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
      // Timezone: Asia/Hong_Kong (UTC+8, no DST)
      var shifted = new Date(v.getTime() + 8 * 3600 * 1000);
      return shifted.toISOString().slice(0, 7);
    }
    var s = String(v).trim().replace(/^'+/, '').replace(/^YM:/, '');
    var m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T\s].*)?$/);
    if (!m) return '';
    var month = Number(m[2]);
    if (month < 1 || month > 12) return '';
    if (m[3]) {
      var day = Number(m[3]);
      if (day < 1 || day > 31) return '';
    }
    return m[1] + '-' + m[2];
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function checkCashAmount(amount) {
    var n = Number(amount);
    if (!Number.isFinite(n)) {
      return { ok: false, code: 'CASH_AMOUNT', message: '金额须为数字。' };
    }
    n = round2(n);
    if (!(n > 0)) {
      return {
        ok: false,
        code: 'CASH_AMOUNT',
        message: '金额须为正数。方向用「收入」或「支出」表示；不接受零或负数。'
      };
    }
    if (n > CASH_LINE_LIMIT) {
      return {
        ok: false,
        code: 'CASH_LIMIT',
        message: '单笔现金或第三方收支为 ' + n + ' 港元，超过 2,000 港元上限，不得按本条直接进入第一本明细账。'
      };
    }
    return { ok: true, amount: n };
  }

  function checkCashMonth(existingHkd, amountHkd) {
    var next = round2(Number(existingHkd) + Number(amountHkd));
    if (next > CASH_MONTH_LIMIT) {
      return {
        ok: false,
        code: 'CASH_LIMIT',
        message: '当月现金或第三方收支合计将达到 ' + next + ' 港元，超过 20,000 港元上限，不得按本条直接进入第一本明细账。'
      };
    }
    return { ok: true, total: next };
  }

  function formalPostDecision(state) {
    state = state || {};
    var reasons = [];
    // AC02-待定：AC02 是否必须保留「期初余额尚未经独立确认禁止写入正式四套账」门禁未规定，本次原样保留。
    if (state.openingConfirmed !== true) {
      reasons.push('期初余额尚未经独立确认，禁止写入正式四套账。');
    }
    if (!state.ledgerGenerated) reasons.push('尚未生成第一本明细账。');
    if (!state.bankBalanced) reasons.push('银行侧未配平，不能定稿。');
    if (!state.completionConfirmed) reasons.push('未经过完成页确认，不能定稿。');
    if (state.unfinished) reasons.push('仍有未处理明细，不能定稿。');
    return { allowed: reasons.length === 0, reasons: reasons };
  }

  // AC02-待定：财务定稿何时对 AC02 开放未规定，本次保持定稿关闭（previewFormalPostClosed 恒为 allowed:false）。
  /* This release never posts formal books. Prerequisites are ignored. Preview keeps its original sentence. */
  function previewFormalPostClosed(state, profile) {
    var reason = profile === 'official'
      ? '本版本未开放财务定稿。期初、配平、完成页和未处理项即使全部满足，也不会写入正式四套账。'
      : '正式预览禁止财务定稿。期初、配平、完成页和未处理项即使全部满足，也不会写入正式四套账。';
    return {
      allowed: false,
      code: 'PREVIEW_FORMAL_POST_CLOSED',
      reasons: [reason]
    };
  }

  function completionDecision(state) {
    state = state || {};
    var reasons = [];
    if (!state.ledgerGenerated) reasons.push('尚未生成第一本明细账，不能确认完成页。');
    if (!state.bankBalanced) reasons.push('银行侧未配平，不能确认完成页。');
    if (state.unfinished) reasons.push('仍有未处理明细，不能确认完成页。');
    return { allowed: reasons.length === 0, reasons: reasons };
  }

  /* Empty-state copy. Official trusts the returned list; the back end already drops test rows. */
  function monthPlanEmptyText(profile, plans) {
    var list = plans || [];
    if (list.length) return '';
    if (profile === 'official') return '本月尚未登记正式计划（测试数据不计入）';
    return '本月尚未登记计划。';
  }

  function stringOrEmpty(value) {
    return typeof value === 'string' ? value : '';
  }

  var IDENTITY_GROUPS = [
    { name: 'preview', buildId: 'ac02-preview', dataMode: 'ac02-preview', productionData: false },
    { name: 'official', buildId: 'ac02-official', dataMode: 'ac02-official', productionData: false }
  ];

  function hasOwn_(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function exactGroup_(source) {
    if (!source) return null;
    for (var i = 0; i < IDENTITY_GROUPS.length; i++) {
      var group = IDENTITY_GROUPS[i];
      if (source.buildId === group.buildId && source.dataMode === group.dataMode && source.productionData === group.productionData) return group;
    }
    return null;
  }

  function pushUnique_(reasons, code) {
    if (reasons.indexOf(code) < 0) reasons.push(code);
  }

  function pageMismatch_(expected) {
    var reasons = [];
    if (exactGroup_(expected)) return reasons;
    var knownBuild = IDENTITY_GROUPS.some(function (group) { return expected.buildId === group.buildId; });
    var knownMode = IDENTITY_GROUPS.some(function (group) { return expected.dataMode === group.dataMode; });
    var knownFlag = expected.productionData === false || expected.productionData === true;
    if (!knownBuild) reasons.push('page-build');
    if (!knownMode) reasons.push('page-dataMode');
    if (!knownFlag) reasons.push('page-productionData');
    if (!reasons.length) {
      var anchor = IDENTITY_GROUPS.filter(function (group) { return group.buildId === expected.buildId; })[0]
        || IDENTITY_GROUPS.filter(function (group) { return group.dataMode === expected.dataMode; })[0]
        || IDENTITY_GROUPS[0];
      if (expected.buildId !== anchor.buildId) reasons.push('page-build');
      if (expected.dataMode !== anchor.dataMode) reasons.push('page-dataMode');
      if (expected.productionData !== anchor.productionData) reasons.push('page-productionData');
    }
    return reasons;
  }

  function layerMismatch_(source, prefix) {
    var buildCode = prefix ? 'release.buildId' : 'buildId';
    var modeCode = prefix ? 'release.dataMode' : 'dataMode';
    var prodCode = prefix ? 'release.productionData' : 'productionData';
    var buildMissing = prefix ? 'release.buildId-missing' : 'buildId-missing';
    var modeMissing = prefix ? 'release.dataMode-missing' : 'dataMode-missing';
    var prodMissing = prefix ? 'release.productionData-missing' : 'productionData-missing';
    var modeFlag = prefix ? 'release-production-mode' : 'production-mode';
    var dataFlag = prefix ? 'release-production-data' : 'production-data';
    var reasons = [];
    var hasBuild = hasOwn_(source, 'buildId');
    var hasMode = hasOwn_(source, 'dataMode');
    var hasProd = hasOwn_(source, 'productionData');
    if (!hasBuild) reasons.push(buildMissing);
    if (!hasMode) reasons.push(modeMissing);
    if (!hasProd) reasons.push(prodMissing);
    if (hasBuild && hasMode && hasProd && exactGroup_(source)) return { reasons: reasons, group: exactGroup_(source) };
    var anchor = (hasBuild && IDENTITY_GROUPS.filter(function (group) { return group.buildId === source.buildId; })[0])
      || (hasMode && IDENTITY_GROUPS.filter(function (group) { return group.dataMode === source.dataMode; })[0])
      || null;
    if (!prefix) {
      if (!hasBuild || (hasBuild && (!anchor || source.buildId !== anchor.buildId))) pushUnique_(reasons, buildCode);
      if (!hasMode || (anchor && source.dataMode !== anchor.dataMode) || (hasMode && !anchor)) pushUnique_(reasons, modeCode);
      if (!hasProd || (anchor && source.productionData !== anchor.productionData) || (hasProd && !anchor && source.productionData !== false && source.productionData !== true)) pushUnique_(reasons, prodCode);
    } else if (hasBuild && hasMode && hasProd) {
      if (!anchor || source.buildId !== anchor.buildId) pushUnique_(reasons, buildCode);
      if (!anchor || source.dataMode !== anchor.dataMode) pushUnique_(reasons, modeCode);
      if (!anchor || source.productionData !== anchor.productionData) pushUnique_(reasons, prodCode);
    }
    if (hasMode && source.dataMode === 'production') pushUnique_(reasons, modeFlag);
    if (hasProd && source.productionData === true && !exactGroup_(source)) pushUnique_(reasons, dataFlag);
    return { reasons: reasons, group: null };
  }

  /* Accepts only the preview group or the official group, as a whole, with me and release in the same group. */
  function identityDecision(data, expected) {
    var reasons = [];
    expected = expected || {};
    reasons = reasons.concat(pageMismatch_(expected));
    if (!data || typeof data !== 'object') {
      reasons.push('missing');
      return { ok: false, reasons: reasons, profile: '' };
    }
    var top = layerMismatch_(data, '');
    reasons = reasons.concat(top.reasons);
    var release = data.release;
    var releaseProto = release && typeof release === 'object' ? Object.getPrototypeOf(release) : null;
    var releaseIsPlain = !!release && typeof release === 'object' && !Array.isArray(release) && (releaseProto === Object.prototype || releaseProto === null);
    var releaseGroup = null;
    if (!releaseIsPlain) {
      reasons.push('release-missing');
    } else {
      var rel = layerMismatch_(release, 'release.');
      reasons = reasons.concat(rel.reasons);
      releaseGroup = rel.group;
      if (top.group && releaseGroup && top.group.name !== releaseGroup.name) {
        pushUnique_(reasons, 'release.buildId');
        pushUnique_(reasons, 'release.dataMode');
        pushUnique_(reasons, 'release.productionData');
      }
    }
    var profile = top.group && releaseGroup && top.group.name === releaseGroup.name && !reasons.length ? top.group.name : '';
    return { ok: reasons.length === 0, reasons: reasons, profile: profile };
  }

  /* Formats the me.release object already returned at login. Does not invent ids. */
  function describeRelease(data) {
    var release = data && typeof data.release === 'object' && data.release ? data.release : null;
    var buildId = stringOrEmpty(release && release.buildId) || stringOrEmpty(data && data.buildId);
    var dataMode = stringOrEmpty(release && release.dataMode) || stringOrEmpty(data && data.dataMode);
    var head = '版本 ' + (buildId || '未返回') + ' · 环境 ' + (dataMode || '未返回');
    if (!release) {
      return {
        state: 'unavailable',
        spreadsheetId: '',
        driveRootId: '',
        buildId: buildId,
        dataMode: dataMode,
        text: head + '。隔离目标未从本次登录接口返回，页面不填入预置编号。'
      };
    }
    var sheet = stringOrEmpty(release.spreadsheetId);
    var drive = stringOrEmpty(release.driveRootId);
    if (release.mismatch === true || release.targetsMatch === false) {
      var echoed = '';
      if (sheet) echoed += ' 接口返回的表格 ' + sheet + '。';
      if (drive) echoed += ' 接口返回的凭证根 ' + drive + '。';
      return {
        state: 'mismatch',
        spreadsheetId: sheet,
        driveRootId: drive,
        buildId: buildId,
        dataMode: dataMode,
        text: head + '。接口标明隔离目标不一致。页面不另填编号。' + echoed
      };
    }
    if (!sheet || !drive) {
      return {
        state: 'unavailable',
        spreadsheetId: sheet,
        driveRootId: drive,
        buildId: buildId,
        dataMode: dataMode,
        text: head + '。接口未返回完整的有效表格或凭证根。页面不填入预置编号。'
      };
    }
    return {
      state: 'observed',
      spreadsheetId: sheet,
      driveRootId: drive,
      buildId: buildId,
      dataMode: dataMode,
      text: head + '。有效表格 ' + sheet + '。有效凭证根 ' + drive + '。来源：本次 me.release。'
    };
  }

  // AC02-待定：预览重放是否纳入 AC02 正式交付未规定，本次仅替换夹具标识，不删函数。夹具保持初稿既有结构（含虚构 sha256 与 1528 字节），待后端确定后整组替换，本次不另造新夹具。
  /* One already archived synthetic upload. No other request, file, or customer record. */
  var PREVIEW_REPLAY = {
    clientRequestId: 'ac02-preview-replay-req-001',
    fileId: 'ac02-preview-replay-file-001',
    fileName: 'ac02_synthetic_sample.pdf',
    // AC02-待定：预览夹具大小 1528 字节未提供 AC02 新虚构文件，保持原值以免与拒绝文案不一致。
    size: 1528,
    sha256: '000000000000000000000000000000000000000000000000000000000000ac02',
    category: '其他',
    relatedId: 'ac02-preview-replay-rel-001'
  };

  function previewReplayClosedText(code) {
    return code === 'PREVIEW_REPLAY_CLOSED' ? '正式环境不开放虚构资料重放' : '';
  }

  function previewReplayGate(input) {
    input = input || {};
    var reasons = [];
    var identity = identityDecision(input.session, input.page);
    if (!identity.ok) reasons = reasons.concat(identity.reasons);
    else if (identity.profile === 'official') reasons.push('productionData');
    // AC02-待定：重放门禁中的角色字面量 '顾问' 是否沿用未规定，本次原样保留。
    if (input.role !== '顾问') reasons.push('role');
    var file = input.file;
    if (!file) reasons.push('file-missing');
    else {
      if (file.name !== PREVIEW_REPLAY.fileName) reasons.push('file-name');
      // AC02-待定：预览夹具大小 1528 字节与拒绝文案需同步维护，本次未提供新文件故保留原值。
      if (file.size !== PREVIEW_REPLAY.size) reasons.push('file-size');
      if (String(file.sha256 || '').toLowerCase() !== PREVIEW_REPLAY.sha256) reasons.push('file-hash');
    }
    var request = null;
    if (!reasons.length) {
      request = {
        category: PREVIEW_REPLAY.category,
        relatedId: PREVIEW_REPLAY.relatedId,
        clientRequestId: PREVIEW_REPLAY.clientRequestId
      };
    }
    return { ok: reasons.length === 0, reasons: reasons, request: request };
  }

  function previewReplayRefusal(reasons) {
    var known = {
      'file-missing': '没有选择文件。',
      'file-name': '文件名不是这条虚构资料。',
      // AC02-待定：拒绝文案中的「1528 字节」随 PREVIEW_REPLAY.size 保持原值未改。
      'file-size': '文件大小不是 1528 字节。',
      'file-hash': '文件内容不是这条虚构资料。',
      role: '当前角色不能重放。',
      'release-missing': '接口没有返回 release 对象。',
      'release.buildId-missing': 'release 缺少 buildId。',
      'release.dataMode-missing': 'release 缺少 dataMode。',
      'release.productionData-missing': 'release 缺少 productionData。',
      'buildId-missing': '接口缺少 buildId。',
      'dataMode-missing': '接口缺少 dataMode。',
      'productionData-missing': '接口缺少 productionData。'
    };
    var parts = [];
    var environment = false;
    (reasons || []).forEach(function (reason) {
      if (known[reason]) parts.push(known[reason]);
      else environment = true;
    });
    if (environment) parts.unshift('当前身份不是正式预览或不是非生产数据，已拒绝。');
    if (!parts.length) parts.push('已拒绝。');
    return '未向接口提交。' + parts.join('');
  }

  function previewReplayVerdict(out) {
    var file = out && out.file ? out.file : {};
    var reasons = [];
    if (!out || out.idempotentReplay !== true) reasons.push('idempotentReplay');
    if (file.id !== PREVIEW_REPLAY.fileId) reasons.push('fileId');
    if (file.clientRequestId && file.clientRequestId !== PREVIEW_REPLAY.clientRequestId) reasons.push('clientRequestId');
    if (file.name && file.name !== PREVIEW_REPLAY.fileName) reasons.push('name');
    if (file.category && file.category !== PREVIEW_REPLAY.category) reasons.push('category');
    if (file.relatedId && file.relatedId !== PREVIEW_REPLAY.relatedId) reasons.push('relatedId');
    return {
      ok: reasons.length === 0,
      reasons: reasons,
      fileId: file.id || '',
      idempotentReplay: out ? out.idempotentReplay : undefined
    };
  }

  function previewReplayText(verdict) {
    var flag = verdict && verdict.idempotentReplay === true
      ? 'true'
      : verdict && verdict.idempotentReplay === false
        ? 'false'
        : '未返回';
    var head = verdict && verdict.ok
      ? '幂等重放成立。'
      : '幂等重放未成立。已停止，没有再次提交。';
    return head + ' fileId ' + ((verdict && verdict.fileId) || '未返回') + '。idempotentReplay ' + flag + '。仅正式预览的一条虚构资料。';
  }

  // AC02-待定：本文件与后端是否逐条等价未做哈希级核对，保持现有导出清单不变。
  return {
    CASH_LINE_LIMIT: CASH_LINE_LIMIT,
    CASH_MONTH_LIMIT: CASH_MONTH_LIMIT,
    canonYearMonth: canonYearMonth,
    checkCashAmount: checkCashAmount,
    checkCashMonth: checkCashMonth,
    formalPostDecision: formalPostDecision,
    previewFormalPostClosed: previewFormalPostClosed,
    completionDecision: completionDecision,
    identityDecision: identityDecision,
    monthPlanEmptyText: monthPlanEmptyText,
    describeRelease: describeRelease,
    PREVIEW_REPLAY: PREVIEW_REPLAY,
    previewReplayGate: previewReplayGate,
    previewReplayClosedText: previewReplayClosedText,
    previewReplayRefusal: previewReplayRefusal,
    previewReplayVerdict: previewReplayVerdict,
    previewReplayText: previewReplayText
  };
});
