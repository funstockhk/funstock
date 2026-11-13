/**
 * FUNSTOCK 运营管理后台 —— 唯一读写接口（Apps Script）
 * 绑定目标：FUNSTOCK_运营管理后台_数据库_v0.1
 * spreadsheetId: 18KIviTyEjxjxav2v0a3liRwlUI8L8O9anjceRi8En9M
 *
 * 规则：找不到授权表必须拒绝，不得默认放行。不输出、不写入明文密码。
 * 本预览交付时脚本尚未部署。本地预览请用 server/server.js。
 */

var SPREADSHEET_ID = '18KIviTyEjxjxav2v0a3liRwlUI8L8O9anjceRi8En9M';
var AUTH_SHEET = '10_授权用户';
var LOG_SHEET = '12_操作日志';
var TOKEN_PROPS = 'FS_SESSIONS';

function doGet(e) {
  return json_({ ok: false, error: '请使用 POST。未登录请求一律拒绝。' });
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      body = e.parameter;
      if (typeof body.payload === 'string') {
        try { body.payload = JSON.parse(body.payload); } catch (ignore) {}
      }
    }
    var action = body.action;
    var payload = body.payload || body;
    var token = (e && e.parameter && e.parameter.token) || body.token || '';
    var result = dispatch_(action, payload, token);
    return json_({ ok: true, data: result });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err), code: err.code || '' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ss_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) {
    var err = new Error('找不到分表「' + name + '」。');
    err.code = 'SHEET_MISSING';
    throw err;
  }
  return sh;
}

function readTable_(name) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  if (!values.length) return { headers: [], rows: [] };
  var headers = values[0].map(function (h) { return String(h); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var rec = {};
    var empty = true;
    for (var c = 0; c < headers.length; c++) {
      rec[headers[c]] = values[i][c];
      if (values[i][c] !== '' && values[i][c] != null) empty = false;
    }
    rec._row = i + 1;
    if (!empty) rows.push(rec);
  }
  return { headers: headers, rows: rows };
}

function appendRow_(name, record, headersHint) {
  var sh = sheet_(name);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn() || (headersHint && headersHint.length) || 1).getValues()[0];
  var row = headers.map(function (h) {
    var v = record[h];
    return v == null ? '' : v;
  });
  sh.appendRow(row);
}

function bytesToHex_(bytes) {
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function verifyPassword_(password, stored) {
  if (typeof stored !== 'string' || stored.indexOf('hmac-sha256$') !== 0) return false;
  var parts = stored.split('$');
  if (parts.length !== 3) return false;
  var salt = parts[1];
  var expected = String(parts[2]).toLowerCase();
  var sig = Utilities.computeHmacSha256Signature(String(password), salt);
  var actual = bytesToHex_(sig);
  if (actual.length !== expected.length) return false;
  var ok = true;
  for (var i = 0; i < actual.length; i++) {
    if (actual.charAt(i) !== expected.charAt(i)) ok = false;
  }
  return ok;
}

function assertAuthTable_() {
  var sh = ss_().getSheetByName(AUTH_SHEET);
  if (!sh) {
    var err = new Error('授权用户表缺失或不可用，已拒绝访问。');
    err.code = 'AUTH_STORE_MISSING';
    throw err;
  }
  var values = sh.getDataRange().getValues();
  if (!values || values.length < 2) {
    var err2 = new Error('授权用户表为空或不可用，已拒绝访问。');
    err2.code = 'AUTH_STORE_MISSING';
    throw err2;
  }
  return readTable_(AUTH_SHEET);
}

function log_(actor, action, target, result, notes) {
  try {
    appendRow_(LOG_SHEET, {
      '时间': Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss') + ' +08:00',
      '操作人': actor || '',
      '动作': action || '',
      '对象': target || '',
      '结果': result || '',
      '备注': notes || ''
    });
  } catch (ignore) {}
}

function cache_() {
  return CacheService.getScriptCache();
}

function dispatch_(action, payload, token) {
  if (!action) throw new Error('缺少 action。');

  if (action === 'login') {
    var table = assertAuthTable_();
    var jobId = String(payload.jobId || '').trim();
    var password = String(payload.password || '');
    var found = null;
    table.rows.forEach(function (r) {
      if (String(r['工号']) === jobId) found = r;
    });
    if (!found || String(found['状态']) !== '启用' || !verifyPassword_(password, String(found['密码哈希'] || ''))) {
      log_(jobId || 'unknown', '登录', '', '拒绝', '工号或口令不正确。');
      var e = new Error('工号或口令不正确，已拒绝。');
      throw e;
    }
    var tok = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    cache_().put('sess:' + tok, JSON.stringify({
      jobId: String(found['工号']),
      role: String(found['角色']),
      displayName: String(found['显示名'])
    }), 21600);
    log_(jobId, '登录', '', '成功', '');
    return {
      token: tok,
      user: { jobId: String(found['工号']), displayName: String(found['显示名']), role: String(found['角色']), status: String(found['状态']) }
    };
  }

  var user = requireUser_(token);

  if (action === 'logout') {
    if (token) cache_().remove('sess:' + token);
    log_(user.jobId, '登出', '', '成功', '');
    return { ok: true };
  }
  if (action === 'me') {
    return { user: user, preview: true };
  }
  if (action === 'getDashboard') {
    return {
      company: readTable_('01_公司与汇率配置').rows[0] ? String(readTable_('01_公司与汇率配置').rows[0]['公司法定名称'] || '') : '',
      plans: readTable_('02_经营计划与法定提醒').rows,
      proposals: readTable_('03_顾问策划书台账').rows,
      contracts: readTable_('07_合同台账').rows,
      ledger: readTable_('04_流水日记账').rows
    };
  }
  if (action === 'getPlans') return { plans: readTable_('02_经营计划与法定提醒').rows };
  if (action === 'savePlan') {
    if (user.role !== '顾问' && payload.mode !== 'feedback') throw new Error('仅顾问可下达或修订经营计划。');
    appendRow_('02_经营计划与法定提醒', {
      '年月': payload.yearMonth || '',
      '类型（固定/灵活）': payload.type || '',
      '事项': payload.title || '',
      '计划日期': payload.planDate || '',
      '负责人': payload.owner || '',
      '完成状态': payload.status || '未完成',
      '完成日期': payload.doneDate || '',
      '是否免原件项目': payload.waiverRelated || '',
      '备注': payload.notes || ''
    });
    log_(user.jobId, '保存计划', payload.yearMonth || '', '成功', '');
    return { ok: true };
  }
  if (action === 'getProposals') return { proposals: readTable_('03_顾问策划书台账').rows };
  if (action === 'getDocuments') {
    return { files: readTable_('06_资料与凭证台账').rows, pics: readTable_('09_隐私声明存证').rows };
  }
  if (action === 'acknowledgePics') {
    appendRow_('09_隐私声明存证', {
      '编号': Utilities.getUuid(),
      '日期': Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd'),
      '操作人角色': user.role,
      '声明版本': payload.version || 'PICS-PREVIEW-v0.1',
      '是否勾选': '是',
      '存证摘要': payload.digest || '已勾选',
      '备注': payload.notes || ''
    });
    log_(user.jobId, '隐私声明存证', '', '成功', '');
    return { ok: true };
  }
  if (action === 'getMonth' || action === 'getContracts' || action === 'getLogs') {
    return {
      ledger: readTable_('04_流水日记账').rows,
      four: readTable_('05_四套账报表').rows,
      files: readTable_('06_资料与凭证台账').rows,
      contracts: readTable_('07_合同台账').rows,
      invoices: readTable_('08_发票台账').rows,
      exports: readTable_('11_导出与报告摘要').rows,
      logs: readTable_('12_操作日志').rows,
      generationOpen: false
    };
  }
  if (action === 'generateOfficialContract') {
    var blocked = new Error('对客正式合同生成入口已关闭。本预览只做台账、流程、状态和文件归档。');
    blocked.code = 'GENERATION_CLOSED';
    throw blocked;
  }
  // Writes that require richer validation (月结单轧差、免原件、暂记、合同状态机)
  // 应在本地预览服务中先行跑通。绑定本脚本后，请按同一套规则把校验搬进本文件，
  // 不得改用「找不到授权表就放行」，也不得把明文密码写入表格。
  if (/^(addStatement|addCashItem|generateLedger|attachVoucher|waiveOriginal|markSuspense|confirmCompletion|postFourStatements|createContract|archiveSigned|claimFirstVoucher|enterExecution|updatePlanNode|pauseContract|closeContract|uploadDocument|uploadProposal|claimFile)$/.test(action)) {
    log_(user.jobId, action, payload && (payload.yearMonth || payload.contractNo || '') || '', '已接收（脚本已鉴权）', '完整业务校验以本地预览服务为准；绑定部署后请同步校验逻辑。');
    throw new Error('此操作的完整业务校验已在本地预览服务实现。请先在本地跑通，再把同一套规则同步进本脚本后部署。当前脚本已拒绝默认放行，且登录、取数、存证、计划写入可用。');
  }
  throw new Error('未知操作。');
}

function requireUser_(token) {
  assertAuthTable_();
  if (!token) {
    var err = new Error('未登录或会话已失效，已拒绝访问。');
    err.code = 'UNAUTHENTICATED';
    throw err;
  }
  var raw = cache_().get('sess:' + token);
  if (!raw) {
    var err2 = new Error('未登录或会话已失效，已拒绝访问。');
    err2.code = 'UNAUTHENTICATED';
    throw err2;
  }
  return JSON.parse(raw);
}
