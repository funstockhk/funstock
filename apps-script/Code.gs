/**
 * AC02 一体化公司管理后台 —— 独立 Web 应用源码（Apps Script）
 * 包用途：单独绑定新建的空结构业务表与附件目录。
 * 不得粘贴进其他已有脚本项目，也不得用来更新其他客户的已有部署。
 *
 * 绑定目标（源码常量，必须与下方 EXPECTED_* 一致，否则在任何数据读写前拒绝）：
 *   spreadsheetId 见 SPREADSHEET_ID / EXPECTED_SPREADSHEET_ID（占位 __AC02_SPREADSHEET_ID__，建表后替换）
 *   凭证根目录见 DEFAULT_DRIVE_ROOT / EXPECTED_DRIVE_ROOT（占位 __AC02_DRIVE_ROOT__，建目录后替换）
 *
 * 禁止绑定：其他客户的表格、凭证根或已有 Web App。
 *
 * 规则：找不到授权表必须拒绝，不得默认放行。不输出、不写入明文密码。
 * 对客正式合同生成入口保持关闭。发布身份（buildId/dataMode/productionData）只由下方「发布身份开关」常量块决定，
 * 默认 preview = ac02-preview / ac02-preview / false；official = ac02-official / ac02-official / false。
 * 年月键统一为 YYYY-MM；期初未确认时拒绝正式定稿；现金金额须为正数并执行 2000/20000 上限。
 * 脚本属性若把目标改到其他 ID，在任何数据读写前拒绝，且不改写、不清除属性。
 * 资料收件已作为「资料与凭证」模块，不另建独立 /c/ 入口。
 */

var SPREADSHEET_ID = '__AC02_SPREADSHEET_ID__';
var EXPECTED_SPREADSHEET_ID = '__AC02_SPREADSHEET_ID__';
var AUTH_SHEET = '10_授权用户';
var LOG_SHEET = '12_操作日志';
var MONTH_SHEET = '13_月账工作底稿';
var DEFAULT_DRIVE_ROOT = '__AC02_DRIVE_ROOT__';
var EXPECTED_DRIVE_ROOT = '__AC02_DRIVE_ROOT__';
/* ==== 发布身份开关（唯一配置位置）====
 * AC02_RELEASE_MODE_ 只允许 'preview' 或 'official'。拨开关 = 只改下一行的取值并发布新版本；
 * 回退 = 同一部署选回上一版本。不读 Script Properties，不读 01 配置表。
 * 模式名或取值不是下面两套之一（含混搭）时，assertIsolatedTargets_ 在任何数据读写前拒绝。 */
var AC02_RELEASE_MODE_ = 'preview'; /* 只改本行：'preview' -> 'official' */
var AC02_RELEASE_PROFILES_ = {
  preview: { buildId: 'ac02-preview', dataMode: 'ac02-preview', productionData: false },
  official: { buildId: 'ac02-official', dataMode: 'ac02-official', productionData: false }
};
var AC02_RELEASE_ = resolveRelease_(typeof AC02_RELEASE_MODE_ === 'undefined' ? undefined : AC02_RELEASE_MODE_);
var BUILD_ID = AC02_RELEASE_ ? AC02_RELEASE_.buildId : 'ac02-release-invalid';
var DATA_MODE = AC02_RELEASE_ ? AC02_RELEASE_.dataMode : 'release-invalid';
var PRODUCTION_DATA = AC02_RELEASE_ ? AC02_RELEASE_.productionData === true : false;

/* 只接受两套已批准取值之一；其他一律返回 null（随后由 assertIsolatedTargets_ 拒绝）。不抛错，避免脚本加载失败。 */
function resolveRelease_(mode) {
  var allowed = [
    ['preview', 'ac02-preview', 'ac02-preview', false],
    ['official', 'ac02-official', 'ac02-official', false]
  ];
  if (typeof mode !== 'string') return null;
  if (typeof AC02_RELEASE_PROFILES_ !== 'object' || !AC02_RELEASE_PROFILES_) return null;
  if (!Object.prototype.hasOwnProperty.call(AC02_RELEASE_PROFILES_, mode)) return null;
  var p = AC02_RELEASE_PROFILES_[mode];
  if (!p || typeof p !== 'object') return null;
  for (var i = 0; i < allowed.length; i++) {
    var a = allowed[i];
    if (mode === a[0] && p.buildId === a[1] && p.dataMode === a[2] && p.productionData === a[3]) {
      return { mode: a[0], buildId: a[1], dataMode: a[2], productionData: a[3] };
    }
  }
  return null;
}
var SESSION_TTL_SEC = 21600;
var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

var CASH_LINE_LIMIT = 2000;
var CASH_MONTH_LIMIT = 20000;
var WAIVER_TYPES = ['银行利息', 'MPF', '工资', '租金'];

var CONTRACT_STATUSES = [
  '草稿',
  '待收（付）首期',
  '执行中',
  '逾期',
  '暂停',
  '已解除待结算',
  '状态一：完成交付并完成收款',
  '状态二：部分交付部分收款（双方同意）',
  '状态三：协议取消解除'
];
var EXECUTION_STATES = { '执行中': true, '逾期': true, '暂停': true };
var CLOSED_STATES = {
  '状态一：完成交付并完成收款': true,
  '状态二：部分交付部分收款（双方同意）': true,
  '状态三：协议取消解除': true
};

var EXTRA_HEADERS = {
  '02_经营计划与法定提醒': ['编号', '回馈', '回馈人', '回馈时间'],
  '04_流水日记账': ['来源键', '月结单编号', '操作记录'],
  '06_资料与凭证台账': ['认领记录', '上传人', 'MIME', '大小', '请求号'],
  '07_合同台账': ['签署正本编号', '首期凭证编号', '双方协议文件编号', '履约计划JSON', '创建时间', '创建人'],
  '09_隐私声明存证': ['操作人']
};

var MONTH_HEADERS = [
  '年月', '限期', '已生成明细账', '银行侧已核对', '银行差额说明',
  '完成页已确认', '完成确认时间', '确认人', '已定稿', '定稿时间', '定稿人',
  '月结单JSON', '现金及第三方JSON', '被拒现金JSON', '备注'
];

var DRIVE_FOLDER_NAMES = {
  '银行月结单': '02_凭证',
  '银行凭证': '02_凭证',
  '凭证': '02_凭证',
  '现金或第三方凭证': '02_凭证',
  '合同签署正本': '03_合同',
  '履约文件': '03_合同',
  '暂停协议': '03_合同',
  '完结协议': '03_合同',
  '发票': '04_发票',
  '计划与策划书': '06_计划与策划书',
  '收件': '05_收件',
  '其他': '05_收件'
};

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
    assertIsolatedTargets_();
    var uploaded = takeUpload_(payload);
    var result = dispatch_(action, payload, token, uploaded);
    return json_({ ok: true, data: result });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err), code: err.code || '' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function takeUpload_(payload) {
  if (!payload || !payload.file || !payload.file.data) return null;
  var f = payload.file;
  delete payload.file;
  return { name: f.name || 'file', mime: f.mime || 'application/octet-stream', data: f.data };
}

function fail_(msg, code, status) {
  var err = new Error(msg);
  err.code = code || '';
  err.status = status || 400;
  throw err;
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function asYmd_(v) {
  if (v == null || v === '') return '';
  if (isDate_(v)) {
    if (typeof Utilities !== 'undefined') {
      return Utilities.formatDate(v, 'Asia/Hong_Kong', 'yyyy-MM-dd');
    }
    var d = new Date(v.getTime() + 8 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }
  var s = String(v).trim();
  var m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

function asStr_(v) {
  if (v == null) return '';
  if (isDate_(v)) return asYmd_(v);
  return String(v).trim();
}

/* Month identity is YYYY-MM. Sheets often coerces "2026-11" into a Date that
 * reads back as 2026-11-01. Canonicalize on every read and write so list,
 * dashboard and audit target the same key. A leading apostrophe keeps the
 * cell as text so Sheets does not convert it again. */
function canonYearMonth_(v) {
  if (v == null || v === '') return '';
  if (isDate_(v)) {
    var ymd = asYmd_(v);
    var dm = String(ymd).match(/^(\d{4})-(\d{2})/);
    return dm ? dm[1] + '-' + dm[2] : '';
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

function sheetMonthKey_(v) {
  var c = canonYearMonth_(v);
  return c ? "'" + c : '';
}

function canonYmd_(v) {
  if (v == null || v === '') return '';
  if (isDate_(v)) {
    var y = asYmd_(v);
    return /^\d{4}-\d{2}-\d{2}$/.test(y) ? y : '';
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  var month = Number(m[2]);
  var day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return m[1] + '-' + m[2] + '-' + m[3];
}

function openingConfirmed_(store) {
  var c = (store && store.config) || {};
  return c.openingConfirmed === true;
}

function mergeMonth_(into, extra) {
  if (!extra) return into;
  var seenCash = {};
  (into.cashItems || []).forEach(function (i) { if (i && i.id) seenCash[i.id] = true; });
  (extra.cashItems || []).forEach(function (i) {
    if (i && i.id && seenCash[i.id]) return;
    into.cashItems.push(i);
  });
  var seenStmt = {};
  (into.statements || []).forEach(function (s) { if (s && s.accountId) seenStmt[s.accountId] = true; });
  (extra.statements || []).forEach(function (s) {
    if (s && s.accountId && seenStmt[s.accountId]) return;
    into.statements.push(s);
  });
  (extra.rejectedCash || []).forEach(function (r) { into.rejectedCash.push(r); });
  into.ledgerGenerated = into.ledgerGenerated || extra.ledgerGenerated;
  into.bankBalanced = into.bankBalanced || extra.bankBalanced;
  into.completionConfirmed = into.completionConfirmed || extra.completionConfirmed;
  into.posted = into.posted || extra.posted;
  if (!into.completionConfirmedAt && extra.completionConfirmedAt) into.completionConfirmedAt = extra.completionConfirmedAt;
  if (!into.postedAt && extra.postedAt) into.postedAt = extra.postedAt;
  if (!into.confirmedBy && extra.confirmedBy) into.confirmedBy = extra.confirmedBy;
  if (!into.postedBy && extra.postedBy) into.postedBy = extra.postedBy;
  if (!into.bankBalanceDiff && extra.bankBalanceDiff) into.bankBalanceDiff = extra.bankBalanceDiff;
  return into;
}

function asNum_(v, dflt) {
  if (v == null || v === '') return dflt == null ? 0 : dflt;
  var n = Number(v);
  return isNaN(n) ? (dflt == null ? 0 : dflt) : n;
}

function isYes_(v) {
  if (v === true) return true;
  var s = asStr_(v);
  return s === '是' || s === 'TRUE' || s === 'true' || s === '1';
}

function yesNo_(b) {
  return b ? '是' : '否';
}

function parseJson_(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'object' && !isDate_(v)) return v;
  try { return JSON.parse(String(v)); } catch (e) { return fallback; }
}

function nowIso_() {
  if (typeof Utilities !== 'undefined') {
    return Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd HH:mm:ss') + ' +08:00';
  }
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  function get(t) { return parts.find(function (p) { return p.type === t; }).value; }
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute') + ':' + get('second') + ' +08:00';
}

function todayYmd_() {
  return nowIso_().slice(0, 10);
}

function newId_(prefix) {
  var n = Date.now().toString(36);
  var r = Math.random().toString(36).slice(2, 8);
  return (prefix + '-' + n + r).toUpperCase();
}

function round2_(n) {
  return Math.round(Number(n) * 100) / 100;
}

function readOneProp_(key) {
  var bag = (typeof globalThis !== 'undefined') ? globalThis.__FS_TEST_PROPS__ : null;
  if (bag) {
    if (Object.prototype.hasOwnProperty.call(bag, key)) {
      return bag[key] == null ? '' : String(bag[key]);
    }
    return '';
  }
  if (typeof PropertiesService === 'undefined') return '';
  var value;
  try {
    value = props_().getProperty(key);
  } catch (e) {
    fail_('无法确认正式预览目标，已在任何数据读写前拒绝。', 'TARGET_UNVERIFIED', 403);
  }
  return value == null ? '' : String(value);
}

function assertOverride_(expected, actual) {
  var text = actual == null ? '' : String(actual).trim();
  if (!text) return false;
  if (text !== expected) {
    fail_('运行时目标与已核实的正式预览目标不一致，已在任何数据读写前拒绝。不会改写或清除脚本属性。', 'TARGET_MISMATCH', 403);
  }
  return true;
}

function assertIsolatedTargets_() {
  if (!AC02_RELEASE_) {
    fail_('发布身份开关取值不在已批准的两套之一，已在任何数据读写前拒绝。', 'TARGET_MISMATCH', 403);
  }
  if (SPREADSHEET_ID !== EXPECTED_SPREADSHEET_ID || DEFAULT_DRIVE_ROOT !== EXPECTED_DRIVE_ROOT) {
    fail_('源码常量与已核实的正式预览目标不一致，已在任何数据读写前拒绝。', 'TARGET_MISMATCH', 403);
  }
  var sheetOver = assertOverride_(EXPECTED_SPREADSHEET_ID, readOneProp_('AC02_SPREADSHEET_ID'));
  var driveOver = assertOverride_(EXPECTED_DRIVE_ROOT, readOneProp_('AC02_DRIVE_ROOT_ID'));
  var driveOver2 = assertOverride_(EXPECTED_DRIVE_ROOT, readOneProp_('DRIVE_ROOT_ID'));
  return {
    buildId: BUILD_ID,
    dataMode: DATA_MODE,
    productionData: PRODUCTION_DATA,
    spreadsheetId: EXPECTED_SPREADSHEET_ID,
    driveRootId: EXPECTED_DRIVE_ROOT,
    spreadsheetSource: sheetOver ? 'property-matches-official-preview-target' : 'source-constant',
    driveSource: (driveOver || driveOver2) ? 'property-matches-official-preview-target' : 'source-constant'
  };
}

function ss_() {
  assertIsolatedTargets_();
  return SpreadsheetApp.openById(EXPECTED_SPREADSHEET_ID);
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

function ensureHeaders_(name, required) {
  var sh = sheet_(name);
  var last = sh.getLastColumn();
  var headers = last ? sh.getRange(1, 1, 1, last).getValues()[0].map(function (h) { return String(h); }) : [];
  var added = false;
  (required || []).forEach(function (h) {
    if (h && headers.indexOf(h) < 0) {
      headers.push(h);
      added = true;
    }
  });
  if (added) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  return headers;
}

function ensureKnownHeaders_() {
  Object.keys(EXTRA_HEADERS).forEach(function (name) {
    try { ensureHeaders_(name, EXTRA_HEADERS[name]); } catch (ignore) {}
  });
}

function ensureMonthSheet_() {
  var sh = ss_().getSheetByName(MONTH_SHEET);
  if (!sh) {
    sh = ss_().insertSheet(MONTH_SHEET);
    sh.getRange(1, 1, 1, MONTH_HEADERS.length).setValues([MONTH_HEADERS]);
  } else {
    ensureHeaders_(MONTH_SHEET, MONTH_HEADERS);
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
  var lastCol = sh.getLastColumn();
  var headers = lastCol
    ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h); })
    : (headersHint || []);
  var row = headers.map(function (h) {
    var v = record[h];
    return v == null ? '' : v;
  });
  sh.appendRow(row);
}

function updateRow_(name, rowNumber, record) {
  var sh = sheet_(name);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h); });
  var row = headers.map(function (h) {
    var v = record[h];
    return v == null ? '' : v;
  });
  sh.getRange(rowNumber, 1, 1, headers.length).setValues([row]);
}

function upsertRow_(name, keyHeader, keyValue, record) {
  var table = readTable_(name);
  var found = null;
  table.rows.forEach(function (r) {
    if (asStr_(r[keyHeader]) === asStr_(keyValue)) found = r;
  });
  if (found) {
    Object.keys(record).forEach(function (k) { found[k] = record[k]; });
    updateRow_(name, found._row, found);
    return found;
  }
  appendRow_(name, record);
  return record;
}

function replaceWhere_(name, pred, records, headersHint, carryKey) {
  var sh = sheet_(name);
  var table = readTable_(name);
  var toDelete = [];
  var carried = {};
  table.rows.forEach(function (r) {
    if (pred(r)) {
      toDelete.push(r._row);
      /* 上线第 1 步：被整段重写的行，按 carryKey 把「测试标记」原值带回新行（不清空）。 */
      if (carryKey && asStr_(r[TEST_MARK_HEADER_]) !== '') carried[asStr_(r[carryKey])] = r[TEST_MARK_HEADER_];
    }
  });
  toDelete.sort(function (a, b) { return b - a; });
  toDelete.forEach(function (row) { sh.deleteRow(row); });
  (records || []).forEach(function (rec) {
    if (carryKey && Object.prototype.hasOwnProperty.call(carried, asStr_(rec[carryKey]))) {
      rec = Object.assign({}, rec);
      rec[TEST_MARK_HEADER_] = carried[asStr_(rec[carryKey])];
    }
    appendRow_(name, rec, headersHint);
  });
}

/* ---- 上线第 1 步：测试标记（清单方案 a）----
 * 相关表末尾一列，表头「测试标记」，测试行填「测试」。读入时只挂不可枚举属性 _testMark，
 * 不进任何响应 JSON、不进缓存；统计/汇总/计数路径用 liveRows_ 排除。没有该列或该列为空时与 Version 4 相同。 */
var TEST_MARK_HEADER_ = '测试标记';
var TEST_MARK_VALUE_ = '测试';
/* 上线第 2 步：前端「虚构资料重放」夹具请求号（rules.js PREVIEW_REPLAY.clientRequestId）。正式身份下 uploadDocument 拒绝它及测试行重放。 */
var PREVIEW_REPLAY_CLIENT_REQUEST_ID_ = 'ac02-preview-replay-req-001';

function setTestMark_(obj) {
  Object.defineProperty(obj, '_testMark', { value: true, writable: true, configurable: true, enumerable: false });
  return obj;
}

function markTestRow_(obj, row) {
  if (obj && row && asStr_(row[TEST_MARK_HEADER_]) === TEST_MARK_VALUE_) setTestMark_(obj);
  return obj;
}

function isTestRow_(obj) {
  return !!(obj && obj._testMark === true);
}

function liveRows_(arr) {
  return (arr || []).filter(function (x) { return !isTestRow_(x); });
}

/* 整行回写（updateRow_）前，把表里已有的「测试标记」原值带回记录，避免被写成空。 */
function keepTestMark_(rec, found) {
  if (found && Object.prototype.hasOwnProperty.call(found, TEST_MARK_HEADER_) && !Object.prototype.hasOwnProperty.call(rec, TEST_MARK_HEADER_)) {
    rec[TEST_MARK_HEADER_] = found[TEST_MARK_HEADER_];
  }
  return rec;
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
  if (!salt || !expected || !/^[0-9a-f]+$/i.test(expected)) return false;
  var actual;
  if (typeof Utilities !== 'undefined' && Utilities.computeHmacSha256Signature) {
    actual = bytesToHex_(Utilities.computeHmacSha256Signature(String(password), salt));
  } else if (typeof __fsHmacHex === 'function') {
    actual = __fsHmacHex(String(password), salt);
  } else {
    return false;
  }
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

function assertAuthStore_(store) {
  if (!store || !Array.isArray(store.users)) {
    var err = new Error('授权用户表缺失或不可用，已拒绝访问。');
    err.code = 'AUTH_STORE_MISSING';
    err.status = 403;
    throw err;
  }
  if (!store.users.length) {
    var err2 = new Error('授权用户表为空，已拒绝访问。');
    err2.code = 'AUTH_STORE_MISSING';
    err2.status = 403;
    throw err2;
  }
}

function publicUser_(user) {
  if (!user) return null;
  return {
    jobId: user.jobId,
    displayName: user.displayName,
    role: user.role,
    status: user.status
  };
}

function log_(actor, action, target, result, notes) {
  var tAudit = stageNow_();
  try {
    if (testStore_()) {
      testStore_().logs = testStore_().logs || [];
      testStore_().logs.push({
        time: nowIso_(),
        actor: actor || '',
        action: action || '',
        target: target || '',
        result: result || '',
        notes: notes || ''
      });
      stageAudit_(tAudit);
      return;
    }
    appendRow_(LOG_SHEET, {
      '时间': nowIso_(),
      '操作人': actor || '',
      '动作': action || '',
      '对象': target || '',
      '结果': result || '',
      '备注': notes || ''
    });
  } catch (ignore) {}
  stageAudit_(tAudit);
}

function cache_() {
  return CacheService.getScriptCache();
}

function props_() {
  return PropertiesService.getScriptProperties();
}

function putSession_(tok, user) {
  var rec = JSON.stringify({
    jobId: String(user.jobId),
    role: String(user.role),
    displayName: String(user.displayName),
    status: String(user.status || '启用'),
    exp: Date.now() + SESSION_TTL_SEC * 1000
  });
  if (typeof CacheService !== 'undefined') {
    try { cache_().put('sess:' + tok, rec, SESSION_TTL_SEC); } catch (ignore) {}
  }
  if (typeof PropertiesService !== 'undefined') {
    try { props_().setProperty('sess:' + tok, rec); } catch (ignore) {}
  }
  if (testStore_()) {
    testStore_()._sessions = testStore_()._sessions || {};
    testStore_()._sessions[tok] = rec;
  }
}

function getSession_(tok) {
  if (!tok) return null;
  var raw = '';
  if (testStore_() && testStore_()._sessions) raw = testStore_()._sessions[tok] || '';
  if (!raw && typeof CacheService !== 'undefined') {
    try { raw = cache_().get('sess:' + tok) || ''; } catch (ignore) {}
  }
  if (!raw && typeof PropertiesService !== 'undefined') {
    try { raw = props_().getProperty('sess:' + tok) || ''; } catch (ignore) {}
  }
  if (!raw) return null;
  var obj;
  try { obj = JSON.parse(raw); } catch (e) { return null; }
  if (obj.exp && Date.now() > Number(obj.exp)) {
    removeSession_(tok);
    return null;
  }
  return obj;
}

function removeSession_(tok) {
  if (!tok) return;
  if (testStore_() && testStore_()._sessions) delete testStore_()._sessions[tok];
  if (typeof CacheService !== 'undefined') {
    try { cache_().remove('sess:' + tok); } catch (ignore) {}
  }
  if (typeof PropertiesService !== 'undefined') {
    try { props_().deleteProperty('sess:' + tok); } catch (ignore) {}
  }
}

function testStore_() {
  if (typeof globalThis !== 'undefined' && globalThis.__FS_TEST_STORE__) return globalThis.__FS_TEST_STORE__;
  return null;
}

function setTestStore_(store) {
  if (typeof globalThis !== 'undefined') {
    if (store) globalThis.__FS_TEST_STORE__ = store;
    else delete globalThis.__FS_TEST_STORE__;
  }
}

function driveRootId_() {
  assertIsolatedTargets_();
  return EXPECTED_DRIVE_ROOT;
}

function driveFolderFor_(category) {
  var rid = driveRootId_();
  if (!rid) fail_('未配置凭证根目录，已拒绝上传。', 'DRIVE_UNCONFIGURED', 403);
  var name = DRIVE_FOLDER_NAMES[category] || '05_收件';
  var cachedFolder = cachedDriveFolder_(rid, name);
  if (cachedFolder) return cachedFolder;
  var root = DriveApp.getFolderById(rid);
  var it = root.getFoldersByName(name);
  if (it.hasNext()) {
    var found = it.next();
    rememberDriveFolder_(rid, name, found);
    return found;
  }
  return root;
}

function fileLinkOf_(id) {
  return id ? 'https://drive.google.com/file/d/' + id + '/view' : '';
}

function driveIdFromLink_(link) {
  var s = asStr_(link);
  var m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}


/* ---- 第四轮第二步：按动作读表 + 读请求不补表头 + config 短时缓存（users 不缓存，一律现读） ----
 * READ_ONLY_ACTIONS_ 与 applyAction_ 内的 readActions 相同，另加 'me'。这些动作从不
 * 走 persist_，所以跳过 ensureKnownHeaders_（它会写表头）。
 * STORE_ACTION_TABLES_：按动作列出其代码路径实际读到的 store 表（含间接助手）。
 * 未列出的动作一律全量读取（与 V2 相同顺序）。未预读的表仍挂惰性 getter，
 * 首次访问时才读，所以映射有漏只会多读一次，不会把表当成空的。 */
var READ_ONLY_ACTIONS_ = {
  me: true,
  getDashboard: true,
  getPlans: true,
  getProposals: true,
  getDocuments: true,
  getMonth: true,
  getContracts: true,
  getReconciliation: true,
  getLogs: true,
  getEffectiveTargets: true
};

/* V2 loadStore_ 的读取顺序，全量回退时原样保持。 */
var STORE_TABLE_ORDER_ = [
  'users', 'config', 'plans', 'files', 'pics', 'ledger', 'fourStatements',
  'invoices', 'exports', 'logs', 'proposals', 'contracts', 'months'
];

/* store.users 在非测试模式下只被 loadStore_ 读取、无动作使用（鉴权走 requireUser_）。 */
var STORE_ACTION_TABLES_ = {
  me: ['config'],                                   /* openingConfirmed_ */
  getEffectiveTargets: [],                          /* 只返回 assertIsolatedTargets_() */
  getDashboard: ['config', 'plans', 'files', 'pics', 'ledger', 'fourStatements', 'exports', 'proposals', 'contracts', 'months'], /* 第五轮：不读 users/invoices/logs；proposals 由 reconstructMonths_ 访问 */
  getPlans: ['plans'],                              /* incompletePlanWarning_ 只读 plans */
  savePlan: ['plans'],                              /* persist_ dirty.plans 只写 plans */
  getProposals: ['files', 'proposals'],             /* loadProposals_(files) */
  getDocuments: ['files', 'pics'],
  acknowledgePics: ['pics'],                        /* persist_ dirty.pics */
  uploadProposal: ['files', 'proposals'],         /* saveUpload_ + persist proposals/files */
  uploadDocument: [],                               /* dispatch_ 在锁内重读 files，锁外读的会被覆盖 */
  getContracts: ['files', 'contracts', 'invoices'], /* loadContracts_(files) */
  getLogs: ['logs']
};

var STORE_CACHE_PREFIX_ = 'ac02-store-cache:v1:' + BUILD_ID + ':';
var STORE_CACHE_TTL_SEC_ = 60;
var STORE_CACHE_MAX_BYTES_ = 100000;
var DRIVE_FOLDER_CACHE_PREFIX_ = 'ac02-drive-folder:v1:';
var DRIVE_FOLDER_CACHE_TTL_SEC_ = 600;
var DRIVE_FOLDER_MEMO_ = {};

function storeLoader_(key, store) {
  if (key === 'users') return loadUsers_();
  if (key === 'config') return cachedTable_('config', loadConfig_);
  if (key === 'plans') return loadPlans_();
  if (key === 'files') return loadFiles_();
  if (key === 'pics') return loadPics_();
  if (key === 'ledger') return loadLedger_();
  if (key === 'fourStatements') return loadFour_();
  if (key === 'invoices') return loadInvoices_();
  if (key === 'exports') return loadExports_();
  if (key === 'logs') return loadLogs_();
  if (key === 'proposals') return loadProposals_(store.files);
  if (key === 'contracts') return loadContracts_(store.files);
  if (key === 'months') return loadMonths_(store);
  return undefined;
}

function setStoreValue_(store, key, value) {
  Object.defineProperty(store, key, { value: value, writable: true, configurable: true, enumerable: true });
}

function defineLazyTable_(store, key) {
  Object.defineProperty(store, key, {
    configurable: true,
    enumerable: true,
    get: function () {
      var t0 = stageNow_();
      var value = storeLoader_(key, store);
      stageMark_('load-store', t0, key);
      setStoreValue_(store, key, value);
      return value;
    },
    set: function (value) {
      setStoreValue_(store, key, value);
    }
  });
}

function loadStore_(action) {
  if (testStore_()) return testStore_();
  if (!READ_ONLY_ACTIONS_[action]) ensureKnownHeaders_();
  var wanted = Object.prototype.hasOwnProperty.call(STORE_ACTION_TABLES_, action)
    ? STORE_ACTION_TABLES_[action]
    : STORE_TABLE_ORDER_;
  var store = {};
  STORE_TABLE_ORDER_.forEach(function (key) { defineLazyTable_(store, key); });
  STORE_TABLE_ORDER_.forEach(function (key) {
    if (wanted.indexOf(key) >= 0) {
      var touch = store[key];
    }
  });
  return store;
}

function utf8Bytes_(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/* 只缓存能被 JSON 原样还原的值：字符串、有限数、布尔、null、数组、普通对象。 */
function jsonSafe_(v) {
  if (v === null) return true;
  var t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return isFinite(v);
  if (Array.isArray(v)) return v.every(jsonSafe_);
  if (t === 'object' && Object.prototype.toString.call(v) === '[object Object]') {
    return Object.keys(v).every(function (k) { return jsonSafe_(v[k]); });
  }
  return false;
}

function cachedTable_(name, loader) {
  var key = STORE_CACHE_PREFIX_ + name;
  var cache = null;
  if (typeof CacheService !== 'undefined') {
    try { cache = cache_(); } catch (e) { cache = null; }
  }
  if (cache) {
    try {
      var raw = cache.get(key);
      if (raw) return JSON.parse(raw);
    } catch (ignore) {}
  }
  var value = loader();
  if (cache) {
    try {
      if (jsonSafe_(value)) {
        var text = JSON.stringify(value);
        if (utf8Bytes_(text) <= STORE_CACHE_MAX_BYTES_) cache.put(key, text, STORE_CACHE_TTL_SEC_);
      }
    } catch (ignore2) {}
  }
  return value;
}

function storeCacheClear_() {
  if (typeof CacheService === 'undefined') return;
  try { cache_().removeAll([STORE_CACHE_PREFIX_ + 'config']); } catch (ignore) {}
}

/* ---- 上传文件夹 ID 缓存：未命中或缓存 ID 失效/已删除/不在根目录下，退回原查找 ---- */
function driveFolderCacheKey_(rid, name) {
  return DRIVE_FOLDER_CACHE_PREFIX_ + rid + ':' + name;
}

function folderHasParent_(folder, rid) {
  var it = folder.getParents();
  while (it.hasNext()) {
    if (it.next().getId() === rid) return true;
  }
  return false;
}

function cachedDriveFolder_(rid, name) {
  var key = driveFolderCacheKey_(rid, name);
  if (DRIVE_FOLDER_MEMO_[key]) {
    try {
      var memo = DRIVE_FOLDER_MEMO_[key];
      if (!memo.isTrashed() && memo.getName() === name && folderHasParent_(memo, rid)) return memo;
    } catch (ignoreMemo) {}
    delete DRIVE_FOLDER_MEMO_[key];
  }
  if (typeof CacheService === 'undefined') return null;
  var id = '';
  try { id = cache_().get(key) || ''; } catch (e) { return null; }
  if (!id) return null;
  try {
    var folder = DriveApp.getFolderById(id);
    if (folder && !folder.isTrashed() && folder.getName() === name && folderHasParent_(folder, rid)) {
      DRIVE_FOLDER_MEMO_[key] = folder;
      return folder;
    }
  } catch (ignore) {}
  try { cache_().remove(key); } catch (ignore2) {}
  return null;
}

function rememberDriveFolder_(rid, name, folder) {
  var key = driveFolderCacheKey_(rid, name);
  DRIVE_FOLDER_MEMO_[key] = folder;
  if (typeof CacheService === 'undefined') return;
  try {
    var id = folder.getId();
    if (id) cache_().put(key, String(id), DRIVE_FOLDER_CACHE_TTL_SEC_);
  } catch (ignore) {}
}

/* ---- 只记耗时的阶段日志：一行 console.log，只含阶段名、毫秒、动作名（load-store 另带表名）。
 * 不写表、不含业务内容/用户标识/payload；任何日志异常都吞掉，不影响请求。 ---- */
var STAGE_STATE_ = null;

function stageNow_() {
  try { return Date.now(); } catch (e) { return 0; }
}

function stageBegin_(action) {
  try {
    var known = typeof FS_IMPLEMENTED_ACTIONS !== 'undefined' && FS_IMPLEMENTED_ACTIONS.indexOf(action) >= 0;
    STAGE_STATE_ = { action: known ? String(action) : 'unknown', stages: [], audit: null };
  } catch (e) {
    STAGE_STATE_ = null;
  }
}

function stageMark_(name, t0, table) {
  try {
    if (!STAGE_STATE_) return;
    var entry = [String(name), Math.max(0, stageNow_() - t0)];
    if (table) entry.push(String(table));
    STAGE_STATE_.stages.push(entry);
  } catch (ignore) {}
}

function stageAudit_(t0) {
  try {
    if (!STAGE_STATE_) return;
    STAGE_STATE_.audit = (STAGE_STATE_.audit || 0) + Math.max(0, stageNow_() - t0);
  } catch (ignore) {}
}

function stageFlush_() {
  try {
    if (STAGE_STATE_) {
      var stages = STAGE_STATE_.stages.slice();
      if (STAGE_STATE_.audit != null) stages.push(['commit-audit', STAGE_STATE_.audit]);
      if (typeof console !== 'undefined' && console && typeof console.log === 'function') {
        console.log(JSON.stringify({ t: 'ac02-stage', action: STAGE_STATE_.action, stages: stages }));
      }
    }
  } catch (ignore) {}
  STAGE_STATE_ = null;
}

function loadUsers_() {
  var table = assertAuthTable_();
  return table.rows.map(function (r) {
    return {
      jobId: asStr_(r['工号']),
      displayName: asStr_(r['显示名']),
      role: asStr_(r['角色']),
      status: asStr_(r['状态']),
      passwordHash: asStr_(r['密码哈希']),
      notes: asStr_(r['备注']),
      _row: r._row
    };
  });
}

function loadConfig_() {
  var rows = readTable_('01_公司与汇率配置').rows;
  var config = {
    companyName: '',
    companyNo: '',
    fx: [{ currency: 'HKD', rate: 1 }],
    accounts: [],
    waiverStandards: {},
    openingConfirmed: false
  };
  var fxSeen = { HKD: true };
  rows.forEach(function (r) {
    if (!config.companyName && asStr_(r['公司法定名称'])) {
      config.companyName = asStr_(r['公司法定名称']);
      config.companyNo = asStr_(r['公司编号']);
    }
    var cur = asStr_(r['币种']);
    if (cur && !fxSeen[cur]) {
      fxSeen[cur] = true;
      config.fx.push({ currency: cur, rate: asNum_(r['汇率（兑港币）'], 1) });
    }
    var code = asStr_(r['科目编码']);
    if (code) {
      var notes = asStr_(r['备注']);
      if (isYes_(r['期初已确认'])) config.openingConfirmed = true;
      config.accounts.push({
        code: code,
        name: asStr_(r['科目名称']),
        openingDate: asYmd_(r['期初日期']),
        openingAmount: asNum_(r['期初金额'], 0),
        notes: notes
      });
      var wm = notes.match(/免原件标准金额\s*([0-9]+(?:\.[0-9]+)?)/);
      if (wm) {
        if (code === '5001' || asStr_(r['科目名称']) === '工资') config.waiverStandards.salary = Number(wm[1]);
        if (code === '5003' || asStr_(r['科目名称']) === '租金') config.waiverStandards.rent = Number(wm[1]);
      }
    }
  });
  if (config.waiverStandards.salary == null) config.waiverStandards.salary = 15000;
  if (config.waiverStandards.rent == null) config.waiverStandards.rent = 8000;
  return config;
}

function loadPlans_() {
  return readTable_('02_经营计划与法定提醒').rows.map(function (r) {
    var id = asStr_(r['编号']);
    if (!id) {
      id = 'PL-' + asStr_(r['年月']) + '-' + asStr_(r['类型（固定/灵活）']) + '-' + asStr_(r['事项']);
    }
    return markTestRow_({
      id: id,
      yearMonth: canonYearMonth_(r['年月']),
      type: asStr_(r['类型（固定/灵活）']),
      title: asStr_(r['事项']),
      planDate: asYmd_(r['计划日期']),
      owner: asStr_(r['负责人']),
      status: asStr_(r['完成状态']) || '未完成',
      doneDate: asYmd_(r['完成日期']),
      waiverRelated: asStr_(r['是否免原件项目']),
      notes: asStr_(r['备注']),
      feedback: asStr_(r['回馈']),
      feedbackBy: asStr_(r['回馈人']),
      feedbackAt: asStr_(r['回馈时间']),
      _row: r._row
    }, r);
  });
}

function planRecord_(p) {
  return {
    '编号': p.id || '',
    '年月': sheetMonthKey_(p.yearMonth),
    '类型（固定/灵活）': p.type || '',
    '事项': p.title || '',
    '计划日期': p.planDate || '',
    '负责人': p.owner || '',
    '完成状态': p.status || '',
    '完成日期': p.doneDate || '',
    '是否免原件项目': p.waiverRelated || '',
    '备注': p.notes || '',
    '回馈': p.feedback || '',
    '回馈人': p.feedbackBy || '',
    '回馈时间': p.feedbackAt || ''
  };
}

function loadProposals_(files) {
  return readTable_('03_顾问策划书台账').rows.map(function (r) {
    var link = asStr_(r['文件链接']);
    var fileId = fileIdFromLink_(files, link);
    return {
      id: asStr_(r['编号']),
      title: asStr_(r['标题']),
      yearMonth: canonYearMonth_(r['适用年月']),
      status: asStr_(r['状态']),
      fileId: fileId,
      driveLink: link,
      date: asYmd_(r['上传日期']),
      notes: asStr_(r['备注']),
      _row: r._row
    };
  });
}

function proposalRecord_(p, files) {
  var link = p.driveLink || '';
  if (!link && p.fileId && files) {
    var f = (files || []).find(function (x) { return x.id === p.fileId; });
    if (f) link = f.driveLink || '';
  }
  return {
    '编号': p.id || '',
    '标题': p.title || '',
    '适用年月': p.yearMonth ? sheetMonthKey_(p.yearMonth) : '',
    '状态': p.status || '',
    '文件链接': link,
    '上传日期': p.date || '',
    '备注': p.notes || ''
  };
}

function loadFiles_() {
  return readTable_('06_资料与凭证台账').rows.map(function (r) {
    return markTestRow_({
      id: asStr_(r['编号']),
      date: asYmd_(r['日期']),
      category: asStr_(r['类别']),
      relatedId: asStr_(r['对应流水号或合同号']),
      name: asStr_(r['文件名称']),
      driveLink: asStr_(r['文件链接']),
      source: asStr_(r['来源（收件/认领）']) || '收件',
      status: asStr_(r['状态']),
      notes: asStr_(r['备注']),
      yearMonth: canonYearMonth_(r['所属年月']),
      account: asStr_(r['账户']),
      opening: r['开户余额'] === '' || r['开户余额'] == null ? '' : asNum_(r['开户余额']),
      closing: r['期末余额'] === '' || r['期末余额'] == null ? '' : asNum_(r['期末余额']),
      claimedBy: parseJson_(r['认领记录'], []) || [],
      uploadedBy: asStr_(r['上传人']),
      mime: asStr_(r['MIME']),
      size: asNum_(r['大小'], 0),
      clientRequestId: asStr_(r['请求号']),
      _row: r._row
    }, r);
  });
}

function fileRecord_(f) {
  return {
    '编号': f.id || '',
    '日期': f.date || '',
    '类别': f.category || '',
    '对应流水号或合同号': f.relatedId || '',
    '文件名称': f.name || '',
    '文件链接': f.driveLink || '',
    '来源（收件/认领）': f.source || '',
    '状态': f.status || '',
    '备注': f.notes || '',
    '所属年月': f.yearMonth ? sheetMonthKey_(f.yearMonth) : '',
    '账户': f.account || '',
    '开户余额': f.opening === '' || f.opening == null ? '' : f.opening,
    '期末余额': f.closing === '' || f.closing == null ? '' : f.closing,
    '认领记录': JSON.stringify(f.claimedBy || []),
    '上传人': f.uploadedBy || '',
    'MIME': f.mime || '',
    '大小': f.size || '',
    '请求号': f.clientRequestId || ''
  };
}

function loadPics_() {
  return readTable_('09_隐私声明存证').rows.map(function (r) {
    return markTestRow_({
      id: asStr_(r['编号']),
      date: asYmd_(r['日期']),
      role: asStr_(r['操作人角色']),
      actor: asStr_(r['操作人']),
      version: asStr_(r['声明版本']),
      acknowledged: isYes_(r['是否勾选']),
      digest: asStr_(r['存证摘要']),
      notes: asStr_(r['备注']),
      _row: r._row
    }, r);
  });
}

function picsRecord_(p) {
  return {
    '编号': p.id || '',
    '日期': p.date || '',
    '操作人角色': p.role || '',
    '声明版本': p.version || '',
    '是否勾选': p.acknowledged ? '是' : '否',
    '存证摘要': p.digest || '',
    '备注': p.notes || '',
    '操作人': p.actor || ''
  };
}

function loadLedger_() {
  return readTable_('04_流水日记账').rows.map(function (r) {
    var id = asStr_(r['流水号']);
    var yearMonth = canonYearMonth_(r['所属年月']);
    var source = asStr_(r['来源（月结单/现金或第三方）']);
    var statementId = asStr_(r['月结单编号']);
    var sourceKey = asStr_(r['来源键']);
    if (!sourceKey) {
      if (source === '现金或第三方') sourceKey = 'cash:' + id;
      else sourceKey = 'stmt:' + (statementId || yearMonth) + ':' + id;
    }
    return markTestRow_({
      id: id,
      yearMonth: yearMonth,
      date: asYmd_(r['日期']),
      desc: asStr_(r['摘要']),
      direction: asStr_(r['收支方向']),
      amount: asNum_(r['金额']),
      currency: asStr_(r['币种']) || 'HKD',
      amountHkd: asNum_(r['折港币']),
      subject: asStr_(r['科目']),
      account: asStr_(r['账户']),
      source: source,
      sourceKey: sourceKey,
      statementId: statementId,
      contractNo: asStr_(r['关联合同号']),
      fileId: asStr_(r['认领文件编号']) || asStr_(r['凭证号']),
      voucherStatus: asStr_(r['凭证状态（已附原件/免原件/暂记往来）']),
      waiverCategory: asStr_(r['免原件类别']),
      counterparty: asStr_(r['往来对象']),
      posted: isYes_(r['是否定稿']),
      notes: asStr_(r['备注']),
      auditTrail: parseJson_(r['操作记录'], []) || [],
      _row: r._row
    }, r);
  });
}

function ledgerRecord_(l) {
  return {
    '流水号': l.id || '',
    '日期': l.date || '',
    '摘要': l.desc || '',
    '收支方向': l.direction || '',
    '金额': l.amount,
    '币种': l.currency || 'HKD',
    '折港币': l.amountHkd,
    '科目': l.subject || '',
    '账户': l.account || '',
    '来源（月结单/现金或第三方）': l.source || '',
    '关联合同号': l.contractNo || '',
    '凭证号': l.fileId || '',
    '凭证状态（已附原件/免原件/暂记往来）': l.voucherStatus || '',
    '往来对象': l.counterparty || '',
    '是否定稿': yesNo_(l.posted),
    '备注': l.notes || '',
    '所属年月': sheetMonthKey_(l.yearMonth),
    '认领文件编号': l.fileId || '',
    '免原件类别': l.waiverCategory || '',
    '来源键': l.sourceKey || '',
    '月结单编号': l.statementId || '',
    '操作记录': JSON.stringify(l.auditTrail || [])
  };
}

function loadFour_() {
  return readTable_('05_四套账报表').rows.map(function (r) {
    return markTestRow_({
      type: asStr_(r['报表类型']),
      period: canonYearMonth_(r['期间']),
      item: asStr_(r['项目']),
      amountHkd: asNum_(r['金额（港币）']),
      posted: isYes_(r['是否定稿']),
      hasSuspense: isYes_(r['是否含暂记往来']),
      notes: asStr_(r['备注']),
      _row: r._row
    }, r);
  });
}

function fourRecord_(r) {
  return {
    '报表类型': r.type || '',
    '期间': sheetMonthKey_(r.period),
    '项目': r.item || '',
    '金额（港币）': r.amountHkd,
    '是否定稿': yesNo_(r.posted),
    '是否含暂记往来': yesNo_(r.hasSuspense),
    '备注': r.notes || ''
  };
}

function loadInvoices_() {
  try {
    return readTable_('08_发票台账').rows.map(function (r) {
      return {
        invoiceNo: asStr_(r['发票号']),
        contractNo: asStr_(r['关联合同号']),
        date: asYmd_(r['开具日期']),
        amount: asNum_(r['金额']),
        currency: asStr_(r['币种']) || 'HKD',
        direction: asStr_(r['收付方向']),
        driveLink: asStr_(r['文件链接']),
        status: asStr_(r['状态']),
        notes: asStr_(r['备注']),
        official: false,
        _row: r._row
      };
    });
  } catch (e) {
    return [];
  }
}

function invoiceRecord_(inv) {
  return {
    '发票号': inv.invoiceNo || '',
    '关联合同号': inv.contractNo || '',
    '开具日期': inv.date || '',
    '金额': inv.amount,
    '币种': inv.currency || '',
    '收付方向': inv.direction || '',
    '文件链接': '',
    '状态': '模拟/草稿 非正式凭证',
    '备注': inv.notes || ''
  };
}

function loadExports_() {
  return readTable_('11_导出与报告摘要').rows.map(function (r) {
    return {
      period: canonYearMonth_(r['期间']),
      type: asStr_(r['报告类型']),
      date: asYmd_(r['生成日期']),
      summary: asStr_(r['摘要']),
      fileId: '',
      driveLink: asStr_(r['文件链接']),
      hasSuspense: isYes_(r['是否含暂记往来']),
      notes: asStr_(r['备注']),
      _row: r._row
    };
  });
}

function exportRecord_(e) {
  return {
    '期间': e.period ? sheetMonthKey_(e.period) : '',
    '报告类型': e.type || '',
    '生成日期': e.date || '',
    '摘要': e.summary || '',
    '文件链接': e.driveLink || '',
    '是否含暂记往来': yesNo_(e.hasSuspense),
    '备注': e.notes || ''
  };
}

function loadLogs_() {
  return readTable_('12_操作日志').rows.map(function (r) {
    return {
      time: asStr_(r['时间']),
      actor: asStr_(r['操作人']),
      action: asStr_(r['动作']),
      target: asStr_(r['对象']),
      result: asStr_(r['结果']),
      notes: asStr_(r['备注']),
      _row: r._row
    };
  });
}

function fileIdFromLink_(files, link) {
  var url = asStr_(link);
  if (!url) return '';
  var found = (files || []).find(function (f) { return f.driveLink && f.driveLink === url; });
  if (found) return found.id;
  var did = driveIdFromLink_(url);
  if (did) {
    found = (files || []).find(function (f) { return driveIdFromLink_(f.driveLink) === did; });
    if (found) return found.id;
  }
  return '';
}

function parsePlanText_(text, c) {
  var plan = [];
  asStr_(text).split('；').forEach(function (part) {
    var s = part.trim();
    if (!s) return;
    var m = s.match(/^(.*)（约定(\d{4}-\d{2}-\d{2})，(已完成|未完成)）$/);
    var title = m ? m[1] : s;
    var due = m ? m[2] : (c && c.firstDueDate) || '';
    var done = m ? m[3] === '已完成' : false;
    var kind = /收（付）款|收付款/.test(title) ? '收付款' : (c && c.deliveryType === '贸易' ? '贸易发货' : '技术文档交付');
    var fileIds = [];
    if (kind === '收付款' && title.indexOf('首期') === 0 && c && c.firstVoucherFileId) {
      fileIds = [c.firstVoucherFileId];
      done = true;
    }
    plan.push({
      id: newId_('PN'),
      kind: kind,
      title: title,
      dueDate: due,
      done: done,
      fileIds: fileIds,
      confirmFileId: ''
    });
  });
  return plan;
}

function planSummary_(plan) {
  return (plan || []).map(function (p) {
    return p.title + '（约定' + (p.dueDate || '') + '，' + (p.done ? '已完成' : '未完成') + '）';
  }).join('；');
}

function loadContracts_(files) {
  return readTable_('07_合同台账').rows.map(function (r) {
    var signedLink = asStr_(r['签署正本链接']);
    var firstLink = asStr_(r['首期凭证链接']);
    var agrLink = asStr_(r['双方协议文件链接']);
    var signedId = asStr_(r['签署正本编号']) || fileIdFromLink_(files, signedLink);
    var firstId = asStr_(r['首期凭证编号']) || fileIdFromLink_(files, firstLink);
    var agrId = asStr_(r['双方协议文件编号']) || fileIdFromLink_(files, agrLink);
    var c = {
      contractNo: asStr_(r['合同号']),
      counterparty: asStr_(r['对方名称']),
      type: asStr_(r['类型']),
      stage: asStr_(r['环节（生成/执行/完结）']),
      status: asStr_(r['状态']),
      signedDate: asYmd_(r['签署日期']),
      signedFileId: signedId,
      firstVoucherFileId: firstId,
      amount: asNum_(r['金额']),
      currency: asStr_(r['币种']) || 'HKD',
      firstAmount: asNum_(r['首期金额'], asNum_(r['金额'])),
      firstDueDate: asYmd_(r['约定首期日期']),
      agreementFileId: agrId,
      closeType: asStr_(r['完结类型']),
      deliveryType: asStr_(r['交付类别']) || (asStr_(r['类型']) === '贸易' ? '贸易' : '咨询技术'),
      plan: parseJson_(r['履约计划JSON'], null),
      payments: [],
      notes: asStr_(r['备注']),
      createdAt: asStr_(r['创建时间']),
      createdBy: asStr_(r['创建人']),
      _row: r._row
    };
    if (!c.plan || !c.plan.length) {
      c.plan = parsePlanText_(r['履约计划'], c);
    }
    return markTestRow_(c, r);
  });
}

function contractRecord_(c, files) {
  function linkOf(id) {
    if (!id) return '';
    var f = (files || []).find(function (x) { return x.id === id; });
    return (f && f.driveLink) || '';
  }
  return {
    '合同号': c.contractNo || '',
    '对方名称': c.counterparty || '',
    '类型': c.type || '',
    '环节（生成/执行/完结）': c.stage || '',
    '状态': c.status || '',
    '签署日期': c.signedDate || '',
    '签署正本链接': linkOf(c.signedFileId),
    '首期凭证链接': linkOf(c.firstVoucherFileId),
    '金额': c.amount,
    '币种': c.currency || 'HKD',
    '备注': c.notes || '',
    '首期金额': c.firstAmount,
    '履约计划': planSummary_(c.plan),
    '双方协议文件链接': linkOf(c.agreementFileId),
    '完结类型': c.closeType || '',
    '交付类别': c.deliveryType || '',
    '约定首期日期': c.firstDueDate || '',
    '签署正本编号': c.signedFileId || '',
    '首期凭证编号': c.firstVoucherFileId || '',
    '双方协议文件编号': c.agreementFileId || '',
    '履约计划JSON': JSON.stringify(c.plan || []),
    '创建时间': c.createdAt || '',
    '创建人': c.createdBy || ''
  };
}

function computedDeadline_(yearMonth) {
  var parts = String(yearMonth).split('-').map(Number);
  var y = parts[0];
  var m = parts[1];
  var deadlineMonth = m === 12 ? 1 : m + 1;
  var deadlineYear = m === 12 ? y + 1 : y;
  return deadlineYear + '-' + String(deadlineMonth).padStart(2, '0') + '-05';
}

function emptyMonth_(yearMonth) {
  return {
    yearMonth: yearMonth,
    deadline: computedDeadline_(yearMonth),
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
    confirmedBy: '',
    postedBy: ''
  };
}

function loadMonths_(store) {
  var months = {};
  var table = { rows: [] };
  try {
    if (ss_().getSheetByName(MONTH_SHEET)) table = readTable_(MONTH_SHEET);
  } catch (ignore) {}
  table.rows.forEach(function (r) {
    var ym = canonYearMonth_(r['年月']);
    if (!ym) return;
    var parsed = {
      yearMonth: ym,
      deadline: asYmd_(r['限期']) || computedDeadline_(ym),
      statements: parseJson_(r['月结单JSON'], []) || [],
      cashItems: parseJson_(r['现金及第三方JSON'], []) || [],
      rejectedCash: parseJson_(r['被拒现金JSON'], []) || [],
      ledgerGenerated: isYes_(r['已生成明细账']),
      bankBalanced: isYes_(r['银行侧已核对']),
      bankBalanceDiff: parseJson_(r['银行差额说明'], null),
      completionConfirmed: isYes_(r['完成页已确认']),
      completionConfirmedAt: asStr_(r['完成确认时间']) || null,
      confirmedBy: asStr_(r['确认人']),
      posted: isYes_(r['已定稿']),
      postedAt: asStr_(r['定稿时间']) || null,
      postedBy: asStr_(r['定稿人'])
    };
    if (!months[ym]) months[ym] = parsed;
    else mergeMonth_(months[ym], parsed);
  });
  reconstructMonths_(store, months);
  return months;
}

function reconstructMonths_(store, months) {
  var seen = {};
  (store.ledger || []).forEach(function (l) {
    var k = canonYearMonth_(l.yearMonth);
    if (!k) return;
    l.yearMonth = k;
    seen[k] = true;
  });
  (store.files || []).forEach(function (f) {
    var k = canonYearMonth_(f.yearMonth);
    if (!k) return;
    f.yearMonth = k;
    seen[k] = true;
  });
  (store.fourStatements || []).forEach(function (r) {
    var k = canonYearMonth_(r.period);
    if (!k) return;
    r.period = k;
    seen[k] = true;
  });
  (store.plans || []).forEach(function (p) {
    var k = canonYearMonth_(p.yearMonth);
    if (k) p.yearMonth = k;
  });
  (store.proposals || []).forEach(function (p) {
    var k = canonYearMonth_(p.yearMonth);
    if (k) p.yearMonth = k;
  });
  var rawKeys = Object.keys(months);
  rawKeys.forEach(function (raw) {
    var k = canonYearMonth_(raw);
    if (!k) return;
    if (raw !== k) {
      if (!months[k]) months[k] = emptyMonth_(k);
      mergeMonth_(months[k], months[raw]);
      months[k].yearMonth = k;
      delete months[raw];
    } else if (months[k]) {
      months[k].yearMonth = k;
    }
    seen[k] = true;
  });
  Object.keys(seen).forEach(function (ym) {
    if (!months[ym]) months[ym] = emptyMonth_(ym);
    var month = months[ym];
    var lines = (store.ledger || []).filter(function (l) { return l.yearMonth === ym; });
    if (lines.length && !month.ledgerGenerated) month.ledgerGenerated = true;
    if (lines.some(function (l) { return l.posted; })) month.posted = true;
    if ((store.fourStatements || []).some(function (r) { return r.period === ym; })) month.posted = true;
    if ((store.exports || []).some(function (e) { return e.period === ym && e.type === '四套账定稿'; })) month.posted = true;
    if (!month.statements.length) {
      var byAcct = {};
      lines.filter(function (l) { return l.source === '月结单'; }).forEach(function (l) {
        var key = l.account || '账户';
        if (!byAcct[key]) byAcct[key] = [];
        byAcct[key].push(l);
      });
      Object.keys(byAcct).forEach(function (account) {
        var stmtLines = byAcct[account];
        var file = (store.files || []).find(function (f) {
          return f.category === '银行月结单' && (f.yearMonth === ym || f.relatedId === ym) && (!f.account || f.account === account);
        });
        var stmtId = stmtLines[0].statementId || (file && file.id) || ('ST-' + ym + '-' + account);
        month.statements.push({
          id: stmtId,
          accountId: account,
          accountName: account,
          fileId: (file && file.id) || '',
          opening: file && file.opening !== '' ? Number(file.opening) : 0,
          closing: file && file.closing !== '' ? Number(file.closing) : 0,
          currency: stmtLines[0].currency || 'HKD',
          internalDiff: 0,
          lines: stmtLines.map(function (l) {
            var slId = (l.sourceKey && l.sourceKey.split(':')[2]) || l.id;
            return {
              id: slId,
              date: l.date,
              desc: l.desc,
              direction: l.direction,
              amount: l.amount,
              currency: l.currency,
              counterparty: l.counterparty,
              waiverCategory: l.waiverCategory || ''
            };
          })
        });
      });
    }
    if (!month.cashItems.length) {
      lines.filter(function (l) { return l.source === '现金或第三方'; }).forEach(function (l) {
        var cid = (l.sourceKey && l.sourceKey.indexOf('cash:') === 0) ? l.sourceKey.slice(5) : l.id;
        month.cashItems.push({
          id: cid,
          date: l.date,
          desc: l.desc,
          direction: l.direction,
          amount: l.amount,
          currency: l.currency,
          amountHkd: l.amountHkd,
          counterparty: l.counterparty,
          fileId: l.fileId || ''
        });
      });
    }
    if (month.statements.length) {
      var diffs = [];
      month.statements.forEach(function (stmt) {
        var computed = round2_(stmt.opening + (stmt.lines || []).reduce(function (s, ln) {
          return s + (ln.direction === '收入' ? Number(ln.amount) : -Number(ln.amount));
        }, 0));
        stmt.internalDiff = round2_(computed - Number(stmt.closing));
        if (stmt.internalDiff !== 0) diffs.push({ account: stmt.accountName, computed: computed, closing: stmt.closing, diff: stmt.internalDiff });
      });
      if (month.ledgerGenerated && diffs.length === 0) month.bankBalanced = true;
      if (diffs.length) month.bankBalanceDiff = diffs;
    }
    if (month.posted && month.ledgerGenerated) {
      month.completionConfirmed = true;
      month.bankBalanced = month.bankBalanced || !!(month.statements.length);
    } else if (lines.length && lines.every(function (l) { return !!l.voucherStatus; })) {
      month.completionConfirmed = month.completionConfirmed || false;
    }
  });
}

function monthRecord_(m) {
  return {
    '年月': sheetMonthKey_(m.yearMonth),
    '限期': m.deadline || '',
    '已生成明细账': yesNo_(m.ledgerGenerated),
    '银行侧已核对': yesNo_(m.bankBalanced),
    '银行差额说明': m.bankBalanceDiff ? JSON.stringify(m.bankBalanceDiff) : '',
    '完成页已确认': yesNo_(m.completionConfirmed),
    '完成确认时间': m.completionConfirmedAt || '',
    '确认人': m.confirmedBy || '',
    '已定稿': yesNo_(m.posted),
    '定稿时间': m.postedAt || '',
    '定稿人': m.postedBy || '',
    '月结单JSON': JSON.stringify(m.statements || []),
    '现金及第三方JSON': JSON.stringify(m.cashItems || []),
    '被拒现金JSON': JSON.stringify(m.rejectedCash || []),
    '备注': ''
  };
}


function upsertPlanRow_(p) {
  var table = readTable_('02_经营计划与法定提醒');
  var found = table.rows.find(function (r) { return asStr_(r['编号']) === asStr_(p.id) && asStr_(p.id) !== ''; });
  if (!found) {
    found = table.rows.find(function (r) {
      return canonYearMonth_(r['年月']) === canonYearMonth_(p.yearMonth)
        && asStr_(r['类型（固定/灵活）']) === asStr_(p.type)
        && asStr_(r['事项']) === asStr_(p.title);
    });
  }
  var rec = keepTestMark_(planRecord_(p), found);
  if (found) updateRow_('02_经营计划与法定提醒', found._row, rec);
  else appendRow_('02_经营计划与法定提醒', rec);
}

function persist_(store, dirty) {
  if (testStore_()) return;
  dirty = dirty || {};
  if (dirty.yearMonth) dirty.yearMonth = canonYearMonth_(dirty.yearMonth) || dirty.yearMonth;
  ensureKnownHeaders_();
  if (dirty.plans) {
    (store.plans || []).forEach(function (p) { upsertPlanRow_(p); });
  }
  if (dirty.proposals) {
    (store.proposals || []).forEach(function (p) {
      upsertRow_('03_顾问策划书台账', '编号', p.id, proposalRecord_(p, store.files));
    });
  }
  if (dirty.files) {
    (store.files || []).forEach(function (f) {
      upsertRow_('06_资料与凭证台账', '编号', f.id, fileRecord_(f));
    });
  }
  if (dirty.pics) {
    (store.pics || []).forEach(function (p) {
      upsertRow_('09_隐私声明存证', '编号', p.id, picsRecord_(p));
    });
  }
  if (dirty.contracts) {
    (store.contracts || []).forEach(function (c) {
      upsertRow_('07_合同台账', '合同号', c.contractNo, contractRecord_(c, store.files));
    });
  }
  if (dirty.invoices) {
    (store.invoices || []).forEach(function (inv) {
      upsertRow_('08_发票台账', '发票号', inv.invoiceNo, invoiceRecord_(inv));
    });
  }
  if (dirty.month && dirty.yearMonth) {
    upsertMonthRow_(ensureMonth_(store, dirty.yearMonth));
  }
  if (dirty.ledgerMonth && dirty.yearMonth) {
    var lines = (store.ledger || []).filter(function (l) { return canonYearMonth_(l.yearMonth) === dirty.yearMonth; });
    replaceWhere_('04_流水日记账', function (r) { return canonYearMonth_(r['所属年月']) === dirty.yearMonth; }, lines.map(ledgerRecord_), undefined, '流水号');
  }
  if (dirty.four && dirty.yearMonth) {
    var rows = (store.fourStatements || []).filter(function (r) { return r.period === dirty.yearMonth; });
    replaceWhere_('05_四套账报表', function (r) { return canonYearMonth_(r['期间']) === canonYearMonth_(dirty.yearMonth); }, rows.map(fourRecord_));
  }
  if (dirty.exports) {
    var last = (store.exports || [])[(store.exports || []).length - 1];
    if (last && !last._row) appendRow_('11_导出与报告摘要', exportRecord_(last));
  }
}


function upsertMonthRow_(month) {
  ensureMonthSheet_();
  var key = canonYearMonth_(month.yearMonth);
  var table = readTable_(MONTH_SHEET);
  var found = null;
  table.rows.forEach(function (r) {
    if (canonYearMonth_(r['年月']) === key) found = r;
  });
  var rec = keepTestMark_(monthRecord_(month), found);
  if (found) updateRow_(MONTH_SHEET, found._row, rec);
  else appendRow_(MONTH_SHEET, rec);
}

function ensureMonth_(store, yearMonth) {
  var key = canonYearMonth_(yearMonth);
  if (!key) fail_('年月须为 YYYY-MM，例如 2026-11。', 'BAD_MONTH', 400);
  store.months = store.months || {};
  Object.keys(store.months).forEach(function (raw) {
    var canon = canonYearMonth_(raw);
    if (!canon || raw === key && canon === key) return;
    if (canon !== key) return;
    if (!store.months[key]) store.months[key] = emptyMonth_(key);
    if (raw !== key) {
      mergeMonth_(store.months[key], store.months[raw]);
      delete store.months[raw];
    }
  });
  if (!store.months[key]) store.months[key] = emptyMonth_(key);
  store.months[key].yearMonth = key;
  store.months[key].deadline = store.months[key].deadline || computedDeadline_(key);
  return store.months[key];
}

function pastDeadline_(month, asOf) {
  var day = asOf || todayYmd_();
  return day > month.deadline;
}

function fxMap_(store) {
  var map = { HKD: 1 };
  ((store.config && store.config.fx) || []).forEach(function (row) {
    map[row.currency] = Number(row.rate);
  });
  return map;
}

function hkd_(amount, currency, fx) {
  var rate = currency === 'HKD' || !currency ? 1 : (fx[currency] || null);
  if (rate == null) fail_('没有币种 ' + currency + ' 的汇率，拒绝折算，以免造数。', '', 400);
  return round2_(Number(amount) * rate);
}

function addStatement_(store, yearMonth, payload) {
  var key = canonYearMonth_(yearMonth);
  if (!key) fail_('年月须为 YYYY-MM，例如 2026-11。', 'BAD_MONTH', 400);
  var month = ensureMonth_(store, key);
  if (month.posted) fail_('该月已定稿并计入正式四套账，不能再改月结单。', '', 400);
  if (month.completionConfirmed) fail_('该月完成页已确认，不能再改月结单。如需调整请走冲账流程。', '', 400);
  month.ledgerGenerated = false;
  month.bankBalanced = false;
  var stmt = {
    id: payload.id || newId_('ST'),
    accountId: payload.accountId,
    accountName: payload.accountName,
    fileId: payload.fileId || '',
    opening: round2_(payload.opening),
    closing: round2_(payload.closing),
    currency: payload.currency || 'HKD',
    lines: (payload.lines || []).map(function (ln) {
      return {
        id: ln.id || newId_('SL'),
        date: ln.date,
        desc: ln.desc,
        direction: ln.direction,
        amount: round2_(ln.amount),
        currency: ln.currency || payload.currency || 'HKD',
        counterparty: ln.counterparty || '',
        waiverCategory: ln.waiverCategory || ''
      };
    })
  };
  var computed = round2_(
    stmt.opening +
      stmt.lines.reduce(function (s, ln) { return s + (ln.direction === '收入' ? ln.amount : -ln.amount); }, 0)
  );
  stmt.internalDiff = round2_(computed - stmt.closing);
  var idx = month.statements.findIndex(function (s) { return s.accountId === stmt.accountId; });
  if (idx >= 0) month.statements[idx] = stmt;
  else month.statements.push(stmt);
  return stmt;
}

function checkCashLimits_(month, newAmountHkd, fx) {
  if (!(newAmountHkd > 0) || !isFinite(newAmountHkd)) {
    return '金额须为正数。方向用「收入」或「支出」表示；不接受零、负数或非数字。';
  }
  if (newAmountHkd > CASH_LINE_LIMIT) {
    return '单笔现金或第三方收支为 ' + newAmountHkd + ' 港元，超过 2,000 港元上限，不得按本条直接进入第一本明细账，须另行说明并补齐原件后再处理。';
  }
  var existing = (month.cashItems || []).reduce(function (s, i) {
    var v = i.amountHkd != null ? i.amountHkd : hkd_(i.amount, i.currency || 'HKD', fx);
    return s + Number(v);
  }, 0);
  if (round2_(existing + newAmountHkd) > CASH_MONTH_LIMIT) {
    return '当月现金或第三方收支合计将达到 ' + round2_(existing + newAmountHkd) + ' 港元，超过 20,000 港元上限，不得按本条直接进入第一本明细账，须另行说明并补齐原件后再处理。';
  }
  return null;
}

function findCashByRequest_(store, reqId) {
  if (!reqId) return null;
  var found = null;
  Object.keys(store.months || {}).forEach(function (raw) {
    var key = canonYearMonth_(raw);
    ((store.months[raw] && store.months[raw].cashItems) || []).forEach(function (item) {
      if (item && item.clientRequestId === reqId) found = { item: item, yearMonth: key };
    });
  });
  return found;
}

function addCashItem_(store, yearMonth, payload) {
  var key = canonYearMonth_(yearMonth);
  if (!key) fail_('年月须为 YYYY-MM，例如 2026-11。', 'BAD_MONTH', 400);
  var replay = findCashByRequest_(store, payload.clientRequestId);
  if (replay) {
    replay.item.idempotentReplay = true;
    return replay.item;
  }
  var month = ensureMonth_(store, key);
  if (month.posted || month.completionConfirmed) {
    fail_('该月已确认或已定稿，不能再按快捷通道登记现金或第三方收支。', '', 400);
  }
  if (payload.direction !== '收入' && payload.direction !== '支出') {
    fail_('方向须为「收入」或「支出」。', 'CASH_DIRECTION', 400);
  }
  var ymd = canonYmd_(payload.date);
  if (!ymd) fail_('日期须为 YYYY-MM-DD。', 'BAD_DATE', 400);
  if (canonYearMonth_(ymd) !== key) {
    fail_('日期 ' + ymd + ' 不在所选年月 ' + key + ' 内。', 'MONTH_MISMATCH', 400);
  }
  var amount = round2_(payload.amount);
  if (!(amount > 0)) {
    fail_('金额须为正数。方向用「收入」或「支出」表示；不接受零、负数或非数字。', 'CASH_AMOUNT', 400);
  }
  var fx = fxMap_(store);
  var amountHkd = hkd_(amount, payload.currency || 'HKD', fx);
  var reason = checkCashLimits_(month, amountHkd, fx);
  if (reason) {
    month.rejectedCash = month.rejectedCash || [];
    var rej = {
      at: nowIso_(),
      amount: amountHkd,
      desc: payload.desc || '',
      reason: reason,
      clientRequestId: payload.clientRequestId || '',
      yearMonth: key
    };
    var dupRej = (month.rejectedCash || []).some(function (r) {
      return payload.clientRequestId && r.clientRequestId === payload.clientRequestId;
    });
    if (!dupRej) month.rejectedCash.push(rej);
    var err = new Error(reason);
    err.code = 'CASH_LIMIT';
    err.status = 400;
    err.dirty = { month: true, yearMonth: key };
    err.audit = { action: '登记现金或第三方收支', target: 'YM:' + key, result: '拒绝', notes: reason };
    throw err;
  }
  month.ledgerGenerated = false;
  var item = {
    id: payload.id || newId_('CA'),
    date: ymd,
    desc: payload.desc,
    direction: payload.direction,
    amount: amount,
    currency: payload.currency || 'HKD',
    amountHkd: amountHkd,
    counterparty: payload.counterparty || '',
    fileId: payload.fileId || '',
    clientRequestId: payload.clientRequestId || '',
    yearMonth: key,
    contractNo: ''
  };
  if (payload.orderId || payload.orderNo) {
    fail_('源码没有订单。现金登记不能挂订单，合同也不是订单。', 'ORDER_UNSUPPORTED', 400);
  }
  if (payload.contractNo) {
    findContract_(store, payload.contractNo);
    item.contractNo = asStr_(payload.contractNo);
  }
  month.cashItems.push(item);
  return item;
}

function inferSubject_(item, source) {
  var cat = item.waiverCategory || '';
  if (cat === '银行利息') return '利息收入';
  if (cat === 'MPF') return 'MPF';
  if (cat === '工资') return '工资';
  if (cat === '租金') return '租金';
  if (item.direction === '收入') return '主营业务收入';
  return '待分类支出';
}

function generateLedger_(store, yearMonth) {
  var key = canonYearMonth_(yearMonth);
  if (!key) fail_('年月须为 YYYY-MM，例如 2026-11。', 'BAD_MONTH', 400);
  yearMonth = key;
  var month = ensureMonth_(store, yearMonth);
  if (!month.statements.length) fail_('尚未上传任何银行月结单，不能生成第一本明细账。', '', 400);
  var diffs = [];
  month.statements.forEach(function (stmt) {
    var computed = round2_(
      stmt.opening +
        stmt.lines.reduce(function (s, ln) { return s + (ln.direction === '收入' ? Number(ln.amount) : -Number(ln.amount)); }, 0)
    );
    var diff = round2_(computed - Number(stmt.closing));
    stmt.internalDiff = diff;
    if (diff !== 0) diffs.push({ account: stmt.accountName, computed: computed, closing: stmt.closing, diff: diff });
  });
  month.bankBalanced = diffs.length === 0;
  month.bankBalanceDiff = diffs;
  if (!month.bankBalanced) {
    month.ledgerGenerated = false;
    fail_(
      '月结单与银行侧收支轧差不一致，不能生成可继续处理的第一本明细账。差额：' +
        diffs.map(function (d) { return d.account + ' 计算' + d.computed + ' / 结单' + d.closing + ' / 差' + d.diff; }).join('；'),
      'UNBALANCED',
      400
    );
  }
  var previous = (store.ledger || []).filter(function (l) { return l.yearMonth === yearMonth; });
  var keep = {};
  previous.forEach(function (l) { keep[l.sourceKey] = l; });
  store.ledger = (store.ledger || []).filter(function (l) { return l.yearMonth !== yearMonth; });
  var fx = fxMap_(store);
  var lines = [];
  month.statements.forEach(function (stmt) {
    stmt.lines.forEach(function (sl) {
      var sourceKey = 'stmt:' + stmt.id + ':' + sl.id;
      var prev = keep[sourceKey];
      var claimStmt = stmt.fileId && sl.claimStatement ? stmt.fileId : '';
      var fileId = (prev && prev.fileId) || claimStmt || '';
      lines.push({
        id: (prev && prev.id) || newId_('JL'),
        yearMonth: yearMonth,
        date: sl.date,
        desc: sl.desc,
        direction: sl.direction,
        amount: sl.amount,
        currency: sl.currency || stmt.currency || 'HKD',
        amountHkd: hkd_(sl.amount, sl.currency || stmt.currency || 'HKD', fx),
        account: stmt.accountName,
        source: '月结单',
        sourceKey: sourceKey,
        statementId: stmt.id,
        contractNo: (prev && prev.contractNo) || '',
        fileId: fileId,
        voucherStatus: (prev && prev.voucherStatus) || '',
        waiverCategory: sl.waiverCategory || (prev && prev.waiverCategory) || '',
        counterparty: sl.counterparty || '',
        posted: false,
        notes: (prev && prev.notes) || '',
        subject: inferSubject_(sl, '月结单'),
        auditTrail: (prev && prev.auditTrail) || []
      });
    });
  });
  month.cashItems.forEach(function (ca) {
    var sourceKey = 'cash:' + ca.id;
    var prev = keep[sourceKey];
    lines.push({
      id: (prev && prev.id) || newId_('JL'),
      yearMonth: yearMonth,
      date: ca.date,
      desc: ca.desc,
      direction: ca.direction,
      amount: ca.amount,
      currency: ca.currency || 'HKD',
      amountHkd: ca.amountHkd != null ? ca.amountHkd : hkd_(ca.amount, ca.currency || 'HKD', fx),
      account: '现金或第三方（不经公司银行）',
      source: '现金或第三方',
      sourceKey: sourceKey,
      statementId: '',
      contractNo: (prev && prev.contractNo) || ca.contractNo || '',
      fileId: (prev && prev.fileId) || ca.fileId || '',
      voucherStatus: (prev && prev.voucherStatus) || '',
      waiverCategory: '',
      counterparty: ca.counterparty || '',
      posted: false,
      notes: (prev && prev.notes) || '',
      subject: inferSubject_(ca, '现金或第三方'),
      auditTrail: (prev && prev.auditTrail) || []
    });
  });
  lines.forEach(function (l) {
    var prevLine = keep[l.sourceKey];
    if (prevLine && isTestRow_(prevLine)) setTestMark_(l);
  });
  store.ledger.push.apply(store.ledger, lines);
  month.ledgerGenerated = true;
  month.completionConfirmed = false;
  month.posted = false;
  return { month: summarizeMonth_(store, yearMonth), lines: lines };
}

function findLine_(store, lineId, opts) {
  var line = (store.ledger || []).find(function (l) { return l.id === lineId; });
  if (!line) fail_('找不到该明细。', '', 404);
  var month = store.months[line.yearMonth];
  var allowPostedNoop = opts && opts.allowPostedNoop;
  if (month && month.posted && !allowPostedNoop) {
    fail_('该月已定稿，不能直接改原暂记痕迹；如需调整请走冲账流程。', '', 400);
  }
  return line;
}

function canWaive_(store, line) {
  if (line.source !== '月结单') {
    return { ok: false, reason: '未出现在月结单上的项目不得免原件（例如现金支付租金）。' };
  }
  var cat = line.waiverCategory;
  if (WAIVER_TYPES.indexOf(cat) < 0) {
    return { ok: false, reason: '免原件仅限银行利息、MPF、按正常发放的工资、按正常金额支付的租金。' };
  }
  var std = (store.config && store.config.waiverStandards) || {};
  if (cat === '工资' && Number(line.amountHkd) !== Number(std.salary)) {
    return { ok: false, reason: '工资金额 ' + line.amountHkd + ' 与既定标准 ' + std.salary + ' 不一致，不得免原件，须补传原件并说明差异。' };
  }
  if (cat === '租金' && Number(line.amountHkd) !== Number(std.rent)) {
    return { ok: false, reason: '租金金额 ' + line.amountHkd + ' 与既定标准 ' + std.rent + ' 不一致，不得免原件，须补传原件并说明差异。' };
  }
  return { ok: true };
}

function attachOrClaim_(store, lineId, fileId, actor, isClaim) {
  var preview = (store.ledger || []).find(function (l) { return l.id === lineId; });
  var monthPosted = preview && store.months[preview.yearMonth] && store.months[preview.yearMonth].posted;
  var line = findLine_(store, lineId, { allowPostedNoop: true });
  var file = (store.files || []).find(function (f) { return f.id === fileId; });
  if (!file) fail_('找不到该文件，不能认领。', '', 404);
  if (monthPosted && line.fileId === fileId && line.voucherStatus === '已附原件') {
    file.claimedBy = file.claimedBy || [];
    var already = file.claimedBy.some(function (c) { return c.lineId === lineId; });
    if (!already) file.claimedBy.push({ module: '月账', lineId: line.id, at: nowIso_(), actor: actor });
    return line;
  }
  if (monthPosted) {
    fail_('该月已定稿，不能直接改原暂记痕迹或更换附件；如需调整请走冲账流程。合同或其他模块仍可认领同一份已入账文件，但不能再改该月流水。', '', 400);
  }
  if (line.voucherStatus === '暂记往来') {
    line.auditTrail = line.auditTrail || [];
    line.auditTrail.push({
      at: nowIso_(),
      actor: actor,
      action: '凭真凭证调整（原暂记痕迹保留）',
      from: '暂记往来',
      to: '已附原件',
      fileId: fileId
    });
  }
  line.fileId = fileId;
  line.voucherStatus = '已附原件';
  file.claimedBy = file.claimedBy || [];
  var already2 = file.claimedBy.some(function (c) { return c.lineId === lineId; });
  if (!already2) file.claimedBy.push({ module: '月账', lineId: line.id, at: nowIso_(), actor: actor });
  file.source = file.source || (isClaim ? '认领' : '收件');
  return line;
}

function waiveLine_(store, lineId, actor) {
  var line = findLine_(store, lineId);
  var check = canWaive_(store, line);
  if (!check.ok) fail_(check.reason, '', 400);
  line.voucherStatus = '免原件';
  line.auditTrail = line.auditTrail || [];
  line.auditTrail.push({ at: nowIso_(), actor: actor, action: '标明免原件' });
  return line;
}

function markSuspense_(store, lineId, actor, asOf) {
  var line = findLine_(store, lineId);
  var month = store.months[line.yearMonth];
  if (!pastDeadline_(month, asOf)) {
    fail_('尚未到限期（' + month.deadline + '），请先补传或认领原件；限期后仍缺原件且不得免原件的，才可暂记往来。', '', 400);
  }
  if (line.voucherStatus === '已附原件' || line.voucherStatus === '免原件') {
    fail_('该笔已附原件或已免原件，不必暂记往来。', '', 400);
  }
  var check = canWaive_(store, line);
  if (check.ok) fail_('该笔符合免原件规定，应标明免原件，而不是暂记往来。', '', 400);
  line.voucherStatus = '暂记往来';
  line.subject = '其他应收款（暂记往来）';
  line.notes = (line.notes ? line.notes + '；' : '') + '限期后缺原件，暂记与划款人或收款人的往来，不得先记成收入或费用。';
  line.auditTrail = line.auditTrail || [];
  line.auditTrail.push({ at: nowIso_(), actor: actor, action: '标明暂记往来', note: '原痕迹保留，后续调整须另记操作记录。' });
  return line;
}

function completionGroups_(store, yearMonth) {
  var key = canonYearMonth_(yearMonth) || yearMonth;
  var lines = liveRows_(store.ledger).filter(function (l) { return canonYearMonth_(l.yearMonth) === key; });
  var groups = {
    '已附原件': lines.filter(function (l) { return l.voucherStatus === '已附原件'; }),
    '免原件': lines.filter(function (l) { return l.voucherStatus === '免原件'; }),
    '暂记往来': lines.filter(function (l) { return l.voucherStatus === '暂记往来'; }),
    '未处理': lines.filter(function (l) { return !l.voucherStatus; })
  };
  return { lines: lines, groups: groups };
}

function confirmCompletion_(store, yearMonth, actor, asOf) {
  var key = canonYearMonth_(yearMonth);
  var month = ensureMonth_(store, key);
  if (!month.ledgerGenerated) fail_('尚未生成第一本明细账。', '', 400);
  if (!month.bankBalanced) fail_('月结单与第一本明细账对不上，该月不能进入完成页确认，也不能定稿。', 'UNBALANCED', 400);
  var cg = completionGroups_(store, key);
  if (cg.groups['未处理'].length) {
    fail_('尚有 ' + cg.groups['未处理'].length + ' 条明细未标明「已附原件 / 免原件 / 暂记往来」，不能确认完成页。', '', 400);
  }
  if (!cg.lines.length) fail_('明细为空，不能确认。', '', 400);
  month.completionConfirmed = true;
  month.completionConfirmedAt = nowIso_();
  month.confirmedBy = actor;
  return { month: summarizeMonth_(store, yearMonth), groups: cg.groups };
}

function openingEquity_(store, yearMonth) {
  var acc = (store.config && store.config.accounts) || [];
  var equity = acc.find(function (a) { return a.code === '3001'; });
  var bank = acc.find(function (a) { return a.code === '1001'; });
  var cash = acc.find(function (a) { return a.code === '1002'; });
  return {
    equity: equity ? Number(equity.openingAmount) || 0 : 0,
    bank: bank ? Number(bank.openingAmount) || 0 : 0,
    cash: cash ? Number(cash.openingAmount) || 0 : 0
  };
}

function buildFourStatements_(store, yearMonth) {
  var key = canonYearMonth_(yearMonth);
  if (!key) fail_('年月须为 YYYY-MM，例如 2026-11。', 'BAD_MONTH', 400);
  yearMonth = key;
  var lines = liveRows_(store.ledger).filter(function (l) { return canonYearMonth_(l.yearMonth) === yearMonth; });
  var opening = openingEquity_(store, yearMonth);
  var income = 0, expense = 0, suspenseAsset = 0, suspenseLiability = 0, bankNet = 0, cashNet = 0;
  var detail = [];
  lines.forEach(function (l) {
    var amt = Number(l.amountHkd);
    var signed = l.direction === '收入' ? amt : -amt;
    var isSuspense = l.voucherStatus === '暂记往来';
    var isBank = l.source === '月结单';
    if (isBank) bankNet = round2_(bankNet + signed);
    else cashNet = round2_(cashNet + signed);
    if (isSuspense) {
      if (l.direction === '支出') suspenseAsset = round2_(suspenseAsset + amt);
      else suspenseLiability = round2_(suspenseLiability + amt);
    } else if (l.direction === '收入') {
      income = round2_(income + amt);
    } else {
      expense = round2_(expense + amt);
    }
    detail.push({
      type: '流水明细',
      period: yearMonth,
      item: l.date + ' ' + l.desc + '（' + l.direction + '，' + l.source + '，' + (l.voucherStatus || '未处理') + '）',
      amountHkd: signed,
      posted: true,
      hasSuspense: isSuspense,
      notes: isSuspense ? '暂记往来，不作为已确认收入或费用，亦非已齐备的审计附件。' : ''
    });
  });
  var profit = round2_(income - expense);
  var endBank = round2_(opening.bank + bankNet);
  var endCash = round2_(opening.cash + cashNet);
  var assets = round2_(endBank + endCash + suspenseAsset);
  var equity = round2_(opening.equity + profit);
  var liabilities = suspenseLiability;
  var totalLE = round2_(liabilities + equity);
  var balanceDiff = round2_(assets - totalLE);
  var rows = [
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
    { type: '资产负债表', period: yearMonth, item: '负债和权益合计', amountHkd: totalLE, posted: true, hasSuspense: liabilities !== 0, notes: balanceDiff === 0 ? '已配平' : ('未配平，差额 ' + balanceDiff) },
    { type: '现金流量表', period: yearMonth, item: '期初货币资金', amountHkd: round2_(opening.bank + opening.cash), posted: true, hasSuspense: false, notes: '' },
    { type: '现金流量表', period: yearMonth, item: '银行收支净额', amountHkd: bankNet, posted: true, hasSuspense: false, notes: '' },
    { type: '现金流量表', period: yearMonth, item: '现金或第三方收支净额', amountHkd: cashNet, posted: true, hasSuspense: false, notes: '' },
    { type: '现金流量表', period: yearMonth, item: '期末货币资金', amountHkd: round2_(endBank + endCash), posted: true, hasSuspense: false, notes: '' }
  ];
  rows = rows.concat(detail);
  return {
    period: yearMonth,
    balanced: balanceDiff === 0,
    balanceDiff: balanceDiff,
    summary: '收入 ' + income + '，支出 ' + expense + '，盈余 ' + profit + '，资产 ' + assets + '，负债和权益 ' + totalLE + '，差额 ' + balanceDiff + (suspenseAsset || liabilities ? '；含暂记往来' : ''),
    rows: rows,
    totals: { income: income, expense: expense, profit: profit, endBank: endBank, endCash: endCash, suspenseAsset: suspenseAsset, liabilities: liabilities, assets: assets, equity: equity, totalLE: totalLE, balanceDiff: balanceDiff }
  };
}

function postFourStatements_(store, yearMonth, actor) {
  formalPostClosed_();
}

function summarizeMonth_(store, yearMonth) {
  var month = ensureMonth_(store, yearMonth);
  var cg = completionGroups_(store, yearMonth);
  return Object.assign({}, month, {
    lineCount: cg.lines.length,
    counts: {
      '已附原件': cg.groups['已附原件'].length,
      '免原件': cg.groups['免原件'].length,
      '暂记往来': cg.groups['暂记往来'].length,
      '未处理': cg.groups['未处理'].length
    },
    pastDeadline: pastDeadline_(month)
  });
}

function incompletePlanWarning_(store) {
  var plans = liveRows_(store.plans);
  var open = plans.filter(function (p) { return p.status !== '已完成'; });
  var byTitle = {};
  open.forEach(function (p) {
    var key = p.type + '|' + p.title;
    if (!byTitle[key]) byTitle[key] = [];
    byTitle[key].push(p);
  });
  var warnings = [];
  Object.keys(byTitle).forEach(function (key) {
    var arr = byTitle[key];
    var months = [];
    arr.forEach(function (p) {
      if (months.indexOf(p.yearMonth) < 0) months.push(p.yearMonth);
    });
    months.sort();
    if (months.length >= 2) {
      warnings.push({
        title: arr[0].title,
        type: arr[0].type,
        months: months,
        message: '「' + arr[0].title + '」已跨 ' + months.length + ' 个月未完成（' + months.join('、') + '），达到两次以上预警。'
      });
    }
  });
  return warnings;
}


function findContract_(store, contractNo) {
  var c = (store.contracts || []).find(function (x) { return x.contractNo === contractNo; });
  if (!c) fail_('找不到该合同。', '', 404);
  return c;
}

function findFile_(store, fileId) {
  var f = (store.files || []).find(function (x) { return x.id === fileId; });
  if (!f) fail_('找不到该文件。', '', 404);
  return f;
}

function claimContractFile_(file, module, contractNo, actor, role) {
  file.claimedBy = file.claimedBy || [];
  var already = file.claimedBy.some(function (c) {
    return c.module === module && c.contractNo === contractNo && c.role === role;
  });
  if (!already) file.claimedBy.push({ module: module, contractNo: contractNo, role: role, at: nowIso_(), actor: actor });
}

function officialGenerateBlocked_() {
  var err = new Error('对客正式合同生成入口已关闭。本预览只做台账、流程、状态和文件归档。');
  err.status = 403;
  err.code = 'GENERATION_CLOSED';
  throw err;
}

function formalPostClosed_() {
  var err = new Error('本版本未开放财务定稿。期初、配平、完成页和未处理项即使全部满足，也不会写入正式四套账。');
  err.status = 403;
  err.code = 'PREVIEW_FORMAL_POST_CLOSED';
  throw err;
}

var DRAFT_MARK = '模拟/草稿 非正式凭证';
var ORDER_GAP = '源码没有订单表、订单编号或订单动作。合同台账不是订单。';

function csvCell_(v) {
  var s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv_(rows) {
  return rows.map(function (row) { return row.map(csvCell_).join(','); }).join('\r\n') + '\r\n';
}

function findIncomeRecord_(store, lineId) {
  var line = (store.ledger || []).find(function (l) { return l.id === lineId; });
  if (line) {
    return {
      kind: 'ledger',
      id: line.id,
      direction: line.direction,
      amount: line.amount,
      currency: line.currency || 'HKD',
      contractNo: line.contractNo || '',
      yearMonth: canonYearMonth_(line.yearMonth)
    };
  }
  var found = null;
  Object.keys(store.months || {}).forEach(function (raw) {
    ((store.months[raw] && store.months[raw].cashItems) || []).forEach(function (item) {
      if (item && item.id === lineId) {
        found = {
          kind: 'cash',
          id: item.id,
          direction: item.direction,
          amount: item.amount,
          currency: item.currency || 'HKD',
          contractNo: item.contractNo || '',
          yearMonth: canonYearMonth_(item.yearMonth || raw)
        };
      }
    });
  });
  return found;
}

function invoiceCsv_(draft) {
  return toCsv_([
    [DRAFT_MARK],
    ['说明', '草稿编号不是官方发票号。无税率、无签章、无订单。'],
    ['草稿编号', draft.invoiceNo],
    ['官方发票号', ''],
    ['状态', DRAFT_MARK],
    ['合同号', draft.contractNo],
    ['订单', '不存在'],
    ['金额', draft.amount],
    ['币种', draft.currency],
    ['金额来源', draft.amountSource],
    ['合同台账金额', draft.sourceAmount.contract],
    ['收入记录金额', draft.sourceAmount.line == null ? '' : draft.sourceAmount.line],
    ['金额是否相同', draft.amountMatch ? '是' : '否，并列两者，不另造第三个数'],
    ['收入记录', draft.lineId || ''],
    ['年月', draft.yearMonth || ''],
    ['关联文件', (draft.fileIds || []).join(' ')],
    ['草稿生成日', draft.date],
    ['日期含义', draft.dateMeaning]
  ]);
}

function createInvoiceDraft_(store, payload, actor) {
  if (payload.orderId || payload.orderNo) fail_(ORDER_GAP, 'ORDER_UNSUPPORTED', 400);
  var contract = findContract_(store, payload.contractNo);
  var income = null;
  if (payload.lineId) {
    income = findIncomeRecord_(store, payload.lineId);
    if (!income) fail_('找不到该收入记录。', 'LINE_MISSING', 404);
    if (income.direction !== '收入') fail_('发票草稿只能引用方向为收入的既有记录。', 'NOT_INCOME', 400);
    if (income.contractNo !== contract.contractNo) {
      fail_('该收入记录没有关联这张合同。不会把未关联的明细算作此合同的收入。', 'LINK_MISMATCH', 400);
    }
  }
  var fileIds = [];
  if (payload.fileId) fileIds.push(payload.fileId);
  (payload.fileIds || []).forEach(function (id) { if (id && fileIds.indexOf(id) < 0) fileIds.push(id); });
  fileIds.forEach(function (id) {
    var file = findFile_(store, id);
    var rel = file.relatedId || '';
    if (rel !== contract.contractNo && !(income && rel === income.id)) {
      fail_('文件 ' + id + ' 的关联编号与合同或收入记录不一致。', 'LINK_MISMATCH', 400);
    }
  });
  var amount = income ? round2_(income.amount) : round2_(contract.amount);
  var currency = income ? (income.currency || 'HKD') : (contract.currency || 'HKD');
  if (payload.amount != null && payload.amount !== '' && round2_(payload.amount) !== amount) {
    fail_('请求金额与来源金额不一致。草稿不改写来源金额，也不计算税额。', 'AMOUNT_MISMATCH', 400);
  }
  var fingerprint = [contract.contractNo, income ? income.id : '', fileIds.slice().sort().join('|')].join('#');
  store.invoices = store.invoices || [];
  var existing = null;
  if (payload.clientRequestId) {
    existing = store.invoices.find(function (inv) { return inv.clientRequestId === payload.clientRequestId; });
  }
  if (!existing) existing = store.invoices.find(function (inv) { return inv.fingerprint === fingerprint; });
  if (existing) {
    existing.idempotentReplay = true;
    existing.csv = invoiceCsv_(existing);
    return existing;
  }
  var draft = {
    invoiceNo: newId_('DRAFT'),
    officialNumber: null,
    official: false,
    status: DRAFT_MARK,
    contractNo: contract.contractNo,
    orderId: null,
    orderSupported: false,
    date: todayYmd_(),
    dateMeaning: '草稿生成日，不是正式开具日',
    amount: amount,
    currency: currency,
    direction: '收入',
    amountSource: income ? income.kind + ':' + income.id : 'contract:' + contract.contractNo,
    lineId: income ? income.id : '',
    yearMonth: income ? income.yearMonth : '',
    fileIds: fileIds,
    sourceAmount: {
      contract: round2_(contract.amount),
      line: income ? round2_(income.amount) : null
    },
    amountMatch: !income || round2_(income.amount) === round2_(contract.amount),
    fingerprint: fingerprint,
    clientRequestId: payload.clientRequestId || '',
    createdBy: actor,
    createdAt: nowIso_(),
    notes: DRAFT_MARK + '。无官方发票号，无税率，无签章，无订单。金额取自' + (income ? '已关联合同的收入记录 ' + income.id : '合同台账金额') + '。'
  };
  draft.csv = invoiceCsv_(draft);
  draft.filename = draft.invoiceNo + '-草稿.csv';
  store.invoices.push(draft);
  return draft;
}

function issueOfficialInvoice_() {
  fail_('没有官方发票号码、税率或签章的权威规则。不能把草稿标成正式发票。', 'OFFICIAL_INVOICE_CLOSED', 403);
}

function fourDraftCsv_(built) {
  var rows = [
    [DRAFT_MARK],
    ['说明', '这是四套账草稿导出，不是定稿，不是审计附件。'],
    ['期间', built.period],
    ['正式定稿', '否'],
    ['已写入正式四套账', '否'],
    ['报表', '项目', '金额（港币）', '含暂记', '备注', '状态']
  ];
  (built.rows || []).forEach(function (r) {
    rows.push([r.type, r.item, r.amountHkd, r.hasSuspense ? '是' : '否', r.notes || '', DRAFT_MARK]);
  });
  return toCsv_(rows);
}

function exportFourDraft_(store, yearMonth, payload) {
  if (payload && payload.format && String(payload.format).toLowerCase() === 'pdf') {
    fail_('源码没有四套账 PDF 模板或签章。只提供带草稿标记的 CSV。', 'PDF_UNSUPPORTED', 400);
  }
  var key = canonYearMonth_(yearMonth);
  var month = ensureMonth_(store, key);
  if (!month.ledgerGenerated || !month.bankBalanced) fail_('尚未生成已配平的明细账，不能导出四套账草稿。', 'UNBALANCED', 400);
  if (!month.completionConfirmed) fail_('未经过完成页确认，不能导出四套账草稿。此处不写正式账。', '', 400);
  var prior = null;
  if (payload && payload.clientRequestId) {
    prior = (store.exports || []).find(function (e) { return e.clientRequestId === payload.clientRequestId && e.type === '四套账草稿预览'; });
  }
  if (prior) {
    prior.idempotentReplay = true;
    return prior;
  }
  var built = buildFourStatements_(store, key);
  var rec = {
    period: key,
    type: '四套账草稿预览',
    date: todayYmd_(),
    summary: DRAFT_MARK + '。' + built.summary,
    fileId: '',
    hasSuspense: (built.rows || []).some(function (r) { return r.hasSuspense; }),
    notes: DRAFT_MARK + '。未调用定稿，不改变已定稿标志。',
    documentStatus: DRAFT_MARK,
    formal: false,
    persistedFormal: false,
    openingConfirmed: openingConfirmed_(store),
    balanced: built.balanced,
    balanceDiff: built.balanceDiff,
    rows: built.rows,
    totals: built.totals,
    csv: fourDraftCsv_(built),
    filename: 'AC02-' + key + '-四套账草稿.csv',
    clientRequestId: (payload && payload.clientRequestId) || '',
    idempotentReplay: false
  };
  store.exports = store.exports || [];
  store.exports.push(rec);
  return rec;
}

function reconcileContract_(store, contractNo) {
  if (!contractNo) fail_('缺少合同号。', '', 400);
  var contract = findContract_(store, contractNo);
  var files = (store.files || []).filter(function (f) {
    return f.relatedId === contract.contractNo || f.id === contract.signedFileId || f.id === contract.firstVoucherFileId;
  });
  var lines = (store.ledger || []).filter(function (l) { return l.contractNo === contract.contractNo; });
  var cash = [];
  Object.keys(store.months || {}).forEach(function (raw) {
    ((store.months[raw] && store.months[raw].cashItems) || []).forEach(function (item) {
      if (item && item.contractNo === contract.contractNo) cash.push(item);
    });
  });
  var invoices = (store.invoices || []).filter(function (inv) { return inv.contractNo === contract.contractNo; });
  var months = {};
  lines.forEach(function (l) { var k = canonYearMonth_(l.yearMonth); if (k) months[k] = true; });
  cash.forEach(function (c) { var k = canonYearMonth_(c.yearMonth); if (k) months[k] = true; });
  return {
    orderSupported: false,
    orderGap: ORDER_GAP,
    contract: {
      contractNo: contract.contractNo,
      counterparty: contract.counterparty,
      amount: contract.amount,
      currency: contract.currency,
      status: contract.status,
      stage: contract.stage
    },
    files: files.map(function (f) { return { id: f.id, category: f.category, relatedId: f.relatedId || '', name: f.name }; }),
    incomeLines: lines.filter(function (l) { return l.direction === '收入'; }).map(function (l) {
      return { id: l.id, amount: l.amount, currency: l.currency, yearMonth: canonYearMonth_(l.yearMonth), source: l.source };
    }),
    cashIncome: cash.filter(function (c) { return c.direction === '收入'; }).map(function (c) {
      return { id: c.id, amount: c.amount, currency: c.currency, yearMonth: canonYearMonth_(c.yearMonth), contractNo: c.contractNo };
    }),
    invoices: invoices.map(function (inv) {
      return { invoiceNo: inv.invoiceNo, status: inv.status, official: false, amount: inv.amount, lineId: inv.lineId || '' };
    }),
    months: Object.keys(months).sort()
  };
}

function createContract_(store, payload, actor) {
  if (payload.generateOfficial) officialGenerateBlocked_();
  var contractNo = payload.contractNo || newId_('CT');
  if ((store.contracts || []).some(function (c) { return c.contractNo === contractNo; })) {
    fail_('合同号已存在。', '', 400);
  }
  var c = {
    contractNo: contractNo,
    counterparty: payload.counterparty,
    type: payload.type,
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
    notes: payload.notes || '',
    createdAt: nowIso_(),
    createdBy: actor
  };
  store.contracts = store.contracts || [];
  store.contracts.push(c);
  return c;
}

function plusDays_(start, n) {
  var d = new Date(start + 'T00:00:00+08:00');
  d.setDate(d.getDate() + n);
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function buildDefaultPlan_(c) {
  var start = c.signedDate || todayYmd_();
  var startDt = new Date(start + 'T00:00:00+08:00');
  var deliverDue = plusDays_(start, 12);
  var plan = [
    {
      id: newId_('PN'),
      kind: c.deliveryType === '贸易' ? '贸易发货' : '技术文档交付',
      title: c.deliveryType === '贸易' ? '上传发货凭证及双方签字确认' : '上传技术文档及双方签字确认',
      dueDate: deliverDue,
      done: false,
      fileIds: [],
      confirmFileId: ''
    },
    {
      id: newId_('PN'),
      kind: '收付款',
      title: '首期收（付）款 ' + c.firstAmount + ' ' + c.currency + ' 与约定时间匹配',
      dueDate: c.firstDueDate || c.signedDate || start,
      done: Boolean(c.firstVoucherFileId),
      fileIds: c.firstVoucherFileId ? [c.firstVoucherFileId] : [],
      confirmFileId: ''
    }
  ];
  if (Number(c.amount) > Number(c.firstAmount)) {
    plan.push({
      id: newId_('PN'),
      kind: '收付款',
      title: '余额收（付）款 ' + (Number(c.amount) - Number(c.firstAmount)) + ' ' + c.currency,
      dueDate: plusDays_(start, 30),
      done: false,
      fileIds: [],
      confirmFileId: ''
    });
  }
  return plan;
}

function hasOverdueNode_(c, asOf) {
  var day = asOf || todayYmd_();
  return (c.plan || []).some(function (p) { return !p.done && p.dueDate && p.dueDate < day; });
}

function refreshStage_(store, c, asOf) {
  var day = asOf || todayYmd_();
  if (CLOSED_STATES[c.status] || c.status === '已解除待结算' || c.status === '暂停') return c;
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
  c.stage = '执行';
  if (!c.plan || !c.plan.length) c.plan = buildDefaultPlan_(c);
  c.plan.forEach(function (p) {
    if (p.kind === '收付款' && p.title.indexOf('首期') === 0 && c.firstVoucherFileId) {
      p.done = true;
      if (p.fileIds.indexOf(c.firstVoucherFileId) < 0) p.fileIds.push(c.firstVoucherFileId);
    }
  });
  if (hasOverdueNode_(c, day)) c.status = '逾期';
  else c.status = '执行中';
  return c;
}

function archiveSigned_(store, contractNo, fileId, signedDate, actor) {
  var c = findContract_(store, contractNo);
  if (CLOSED_STATES[c.status]) fail_('已完结的合同不能再改签署正本。', '', 400);
  var file = findFile_(store, fileId);
  c.signedFileId = fileId;
  c.signedDate = signedDate || c.signedDate || todayYmd_();
  claimContractFile_(file, '合同', contractNo, actor, '签署正本');
  refreshStage_(store, c);
  return c;
}

function claimFirstVoucher_(store, contractNo, fileId, actor) {
  var c = findContract_(store, contractNo);
  if (!c.signedFileId) fail_('尚未归档双方签署的合同扫描正本，不能登记首期凭证，也不能进入执行。', '', 400);
  var file = findFile_(store, fileId);
  c.firstVoucherFileId = fileId;
  claimContractFile_(file, '合同', contractNo, actor, '首期凭证');
  refreshStage_(store, c);
  return c;
}

function enterExecution_(store, contractNo, actor) {
  var c = findContract_(store, contractNo);
  if (!c.signedFileId || !c.firstVoucherFileId) {
    fail_('未完成第一环节规定产物：须同时归档双方签署的合同扫描正本，以及首期收或付银行凭证，才能进入执行。签署正本已归档、首期尚未发生的，状态应为「待收（付）首期」。', '', 400);
  }
  c.plan = c.plan && c.plan.length ? c.plan : buildDefaultPlan_(c);
  refreshStage_(store, c);
  return c;
}

function updatePlanNode_(store, contractNo, nodeId, payload, actor) {
  var c = findContract_(store, contractNo);
  if (!EXECUTION_STATES[c.status] && c.status !== '逾期') {
    fail_('合同尚未进入执行阶段，不能更新履约节点。', '', 400);
  }
  var node = (c.plan || []).find(function (p) { return p.id === nodeId; });
  if (!node) fail_('找不到该履约节点。', '', 404);
  if (payload.fileId) {
    var file = findFile_(store, payload.fileId);
    claimContractFile_(file, '合同', c.contractNo, actor, '履约文件');
    if (node.fileIds.indexOf(payload.fileId) < 0) node.fileIds.push(payload.fileId);
  }
  if (payload.confirmFileId) {
    var file2 = findFile_(store, payload.confirmFileId);
    claimContractFile_(file2, '合同', c.contractNo, actor, '双方确认');
    node.confirmFileId = payload.confirmFileId;
  }
  if (payload.done) {
    if (node.kind !== '收付款') {
      if (!node.fileIds.length || !node.confirmFileId) {
        fail_(
          c.deliveryType === '贸易'
            ? '贸易类须上传发货凭证以及双方签字确认，才能将该交付节点标为完成。'
            : '咨询技术类须上传技术文档以及双方签字确认，才能将该交付节点标为完成。',
          '',
          400
        );
      }
    } else if (!node.fileIds.length) {
      fail_('每一笔收付款须上传或认领对应银行凭证，并与约定时间匹配。', '', 400);
    }
    node.done = true;
  }
  refreshStage_(store, c);
  return c;
}

function pauseContract_(store, contractNo, agreementFileId, actor) {
  var c = findContract_(store, contractNo);
  if (!agreementFileId) fail_('暂停须有双方书面同意文件。', '', 400);
  var file = findFile_(store, agreementFileId);
  claimContractFile_(file, '合同', c.contractNo, actor, '暂停协议');
  c.agreementFileId = agreementFileId;
  c.status = '暂停';
  c.stage = '执行';
  return c;
}

function closeContract_(store, contractNo, closeType, agreementFileId, actor) {
  var c = findContract_(store, contractNo);
  if (!c.signedFileId) fail_('不得跳过签署正本直接完结。', '', 400);
  var type = closeType;
  if (type === '状态一' || type === '状态一：完成交付并完成收款') {
    var deliverDone = (c.plan || []).filter(function (p) { return p.kind !== '收付款'; }).every(function (p) { return p.done; });
    var payDone = (c.plan || []).filter(function (p) { return p.kind === '收付款'; }).every(function (p) { return p.done; });
    if (!deliverDone || !payDone || !c.firstVoucherFileId) {
      fail_('状态一要求全部约定交付已完成且凭证齐备，全部约定款项已收或已付且银行凭证齐备。', '', 400);
    }
    c.status = '状态一：完成交付并完成收款';
    c.closeType = '状态一';
    c.stage = '完结';
    return c;
  }
  if (type === '状态二' || type === '状态二：部分交付部分收款（双方同意）') {
    if (!agreementFileId) {
      fail_('状态二须有双方确认文件，写明已完成的交付、已收或已付的款项，以及不再履行的部分。不得在无双方协议时把未履行完毕的合同标为状态二。', '', 400);
    }
    var file = findFile_(store, agreementFileId);
    claimContractFile_(file, '合同', c.contractNo, actor, '部分完结协议');
    c.agreementFileId = agreementFileId;
    c.status = '状态二：部分交付部分收款（双方同意）';
    c.closeType = '状态二';
    c.stage = '完结';
    return c;
  }
  if (type === '已解除待结算') {
    if (!agreementFileId) fail_('协议取消或解除须有双方解除或取消协议。', '', 400);
    var file2 = findFile_(store, agreementFileId);
    claimContractFile_(file2, '合同', c.contractNo, actor, '解除协议');
    c.agreementFileId = agreementFileId;
    c.status = '已解除待结算';
    c.closeType = '已解除待结算';
    c.stage = '执行';
    return c;
  }
  if (type === '状态三' || type === '状态三：协议取消解除') {
    if (!agreementFileId && !c.agreementFileId) {
      fail_('状态三须有双方解除或取消协议。不得在无双方协议时把合同标为状态三。', '', 400);
    }
    if (agreementFileId) {
      var file3 = findFile_(store, agreementFileId);
      claimContractFile_(file3, '合同', c.contractNo, actor, '解除协议');
      c.agreementFileId = agreementFileId;
    }
    c.status = '状态三：协议取消解除';
    c.closeType = '状态三';
    c.stage = '完结';
    return c;
  }
  fail_('本预览未写明的完结状态不能新增。请使用状态一、状态二、已解除待结算或状态三。', '', 400);
}

function decodeUpload_(uploaded) {
  if (!uploaded || !uploaded.data) fail_('没有收到文件。', '', 400);
  var raw = String(uploaded.data).replace(/\s/g, '');
  var bytes;
  try {
    bytes = Utilities.base64Decode(raw);
  } catch (e) {
    fail_('无法解码上传文件。', '', 400);
  }
  if (bytes.length > MAX_UPLOAD_BYTES) fail_('上传文件超过 10 MB 上限。', '', 400);
  var name = (uploaded.name || 'file').replace(/[^\w.\-\u4e00-\u9fff（）()]+/g, '_');
  var mime = uploaded.mime || 'application/octet-stream';
  var blob = Utilities.newBlob(bytes, mime, name);
  return { blob: blob, name: uploaded.name || name, mime: mime, size: bytes.length };
}

function saveUpload_(store, uploaded, category, actor, extra) {
  extra = extra || {};
  var rec;
  if (testStore_()) {
    if (!uploaded) fail_('没有收到文件。', '', 400);
    var rawData = uploaded.data != null ? String(uploaded.data) : '';
    var approxBytes = Math.floor(rawData.replace(/\s/g, '').length * 3 / 4);
    if (approxBytes > MAX_UPLOAD_BYTES) fail_('上传文件超过 10 MB 上限。', '', 400);
    rec = {
      id: newId_('FL'),
      date: todayYmd_(),
      category: category || '收件',
      relatedId: extra.relatedId || '',
      name: uploaded.name || 'file',
      driveLink: '',
      source: '收件',
      status: '已归档',
      notes: extra.notes || '',
      mime: uploaded.mime || '',
      size: approxBytes || 0,
      claimedBy: [],
      uploadedBy: actor,
      yearMonth: extra.yearMonth || '',
      account: extra.account || '',
      opening: extra.opening != null ? extra.opening : '',
      closing: extra.closing != null ? extra.closing : '',
      clientRequestId: extra.clientRequestId || ''
    };
    store.files = store.files || [];
    store.files.push(rec);
    return rec;
  }
  var decoded = decodeUpload_(uploaded);
  var folder = driveFolderFor_(category);
  var created = folder.createFile(decoded.blob);
  rec = {
    id: newId_('FL'),
    date: todayYmd_(),
    category: category || '收件',
    relatedId: extra.relatedId || '',
    name: decoded.name,
    driveLink: fileLinkOf_(created.getId()),
    source: '收件',
    status: '已归档',
    notes: extra.notes || '',
    mime: decoded.mime,
    size: decoded.size,
    claimedBy: [],
    uploadedBy: actor,
    yearMonth: extra.yearMonth || '',
    account: extra.account || '',
    opening: extra.opening != null ? extra.opening : '',
    closing: extra.closing != null ? extra.closing : '',
    clientRequestId: extra.clientRequestId || ''
  };
  store.files = store.files || [];
  store.files.push(rec);
  return rec;
}

function newToken_() {
  if (typeof Utilities !== 'undefined') {
    return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  }
  return newId_('TK').replace(/-/g, '') + newId_('TK').replace(/-/g, '');
}

function login_(payload) {
  var jobId = asStr_(payload.jobId);
  var password = String(payload.password || '');
  var found = null;
  if (testStore_()) {
    assertAuthStore_(testStore_());
    found = (testStore_().users || []).find(function (u) { return u.jobId === jobId; }) || null;
    if (found) found = { jobId: found.jobId, displayName: found.displayName, role: found.role, status: found.status, passwordHash: found.passwordHash };
  } else {
    var table = assertAuthTable_();
    table.rows.forEach(function (r) {
      if (asStr_(r['工号']) === jobId) {
        found = {
          jobId: asStr_(r['工号']),
          displayName: asStr_(r['显示名']),
          role: asStr_(r['角色']),
          status: asStr_(r['状态']),
          passwordHash: asStr_(r['密码哈希'])
        };
      }
    });
  }
  if (!found || String(found.status) !== '启用' || !verifyPassword_(password, String(found.passwordHash || ''))) {
    log_(jobId || 'unknown', '登录', '', '拒绝', '工号或口令不正确。');
    fail_('工号或口令不正确，已拒绝。', '', 401);
  }
  var tok = newToken_();
  putSession_(tok, found);
  log_(jobId, '登录', '', '成功', '');
  return { token: tok, user: publicUser_(found) };
}

function requireUser_(token) {
  if (testStore_()) {
    assertAuthStore_(testStore_());
    var sess = getSession_(token);
    if (!sess) fail_('未登录或会话已失效，已拒绝访问。', 'UNAUTHENTICATED', 401);
    var u = (testStore_().users || []).find(function (x) { return x.jobId === sess.jobId; });
    if (!u || u.status !== '启用') fail_('未登录或会话已失效，已拒绝访问。', 'UNAUTHENTICATED', 401);
    return { jobId: u.jobId, displayName: u.displayName, role: u.role, status: u.status };
  }
  assertAuthTable_();
  var session = getSession_(token);
  if (!session) fail_('未登录或会话已失效，已拒绝访问。', 'UNAUTHENTICATED', 401);
  return session;
}

function assertAdvisor_(user, action) {
  if (user && user.role === '顾问') return;
  fail_('当前角色无权执行「' + action + '」。鉴权失败即拒绝。', 'FORBIDDEN', 403);
}

function applyAction_(store, action, payload, user, uploaded) {
  var actor = user.jobId;
  payload = payload || {};
  if (action === 'setOpeningConfirmed' || action === 'confirmOpening' || payload.openingConfirmed != null) {
    fail_('期初确认不能由请求改写。只能由授权宿主在表格列「期初已确认」中维护。', 'OPENING_IMMUTABLE', 403);
  }
  if (action === 'enableProduction' || payload.productionData === true || payload.dataMode === 'production' || payload.dataMode === 'official') {
    fail_('本发布没有正式生产数据模式。', 'PRODUCTION_MODE_CLOSED', 403);
  }
  if (payload.yearMonth) {
    var normalizedMonth = canonYearMonth_(payload.yearMonth);
    if (!normalizedMonth) fail_('年月须为 YYYY-MM，例如 2026-11。', 'BAD_MONTH', 400);
    payload.yearMonth = normalizedMonth;
  }

  if (action === 'me') {
    return {
      user: publicUser_(user),
      asOf: todayYmd_(),
      preview: !PRODUCTION_DATA,
      openingConfirmed: openingConfirmed_(store),
      formalBooksOpen: openingConfirmed_(store),
      officialContractOpen: false,
      buildId: BUILD_ID,
      dataMode: DATA_MODE,
      productionData: PRODUCTION_DATA,
      release: assertIsolatedTargets_()
    };
  }
  if (action === 'getEffectiveTargets') return assertIsolatedTargets_();

  var readActions = {
    getDashboard: true,
    getPlans: true,
    getProposals: true,
    getDocuments: true,
    getMonth: true,
    getContracts: true,
    getReconciliation: true,
    getLogs: true,
    getEffectiveTargets: true
  };
  if (!readActions[action]) {
    if (action === 'acknowledgePics') {
      /* any signed-in enabled role may record its own acknowledgement */
    } else if (action === 'savePlan' && payload.mode === 'feedback') {
      /* client feedback is the only non-advisor write */
    } else {
      assertAdvisor_(user, action);
    }
  }

  if (action === 'getDashboard') {
    var warnings = incompletePlanWarning_(store);
    var currentYearMonth = canonYearMonth_(todayYmd_());
    var hasCurrent = Object.keys(store.months || {}).some(function (raw) { return canonYearMonth_(raw) === currentYearMonth; });
    var monthSum = hasCurrent ? summarizeMonth_(store, currentYearMonth) : null;
    var pendingDocs = liveRows_(store.files).filter(function (f) { return f.status === '待核验'; }).length;
    var picsPending = liveRows_(store.pics).filter(function (p) { return !p.acknowledged; }).length;
    var finances = monthSum && monthSum.posted
      ? liveRows_(store.fourStatements).filter(function (r) { return canonYearMonth_(r.period) === currentYearMonth && r.type === '利润表'; })
      : [];
    return {
      asOf: todayYmd_(),
      currentYearMonth: currentYearMonth,
      company: (store.config && store.config.companyName) || '',
      warnings: warnings,
      openingConfirmed: openingConfirmed_(store),
      plansThisMonth: liveRows_(store.plans).filter(function (p) { return canonYearMonth_(p.yearMonth) === currentYearMonth; }),
      month: monthSum,
      pendingDocs: pendingDocs,
      picsPending: picsPending,
      finances: finances,
      contracts: liveRows_(store.contracts).map(function (c) {
        return { contractNo: c.contractNo, status: c.status, stage: c.stage, counterparty: c.counterparty };
      })
    };
  }

  if (action === 'getPlans') {
    return { plans: store.plans || [], warnings: incompletePlanWarning_(store) };
  }
  if (action === 'savePlan') {
    if (user.role !== '顾问' && payload.mode !== 'feedback') fail_('仅顾问可下达或修订经营计划。客户可提交回馈。', '', 403);
    store.plans = store.plans || [];
    if (payload.mode === 'feedback') {
      var pf = store.plans.find(function (x) { return x.id === payload.id; });
      if (!pf) fail_('找不到该计划事项。', '', 404);
      pf.feedback = payload.feedback || '';
      pf.feedbackBy = actor;
      pf.feedbackAt = nowIso_();
      log_(actor, '计划回馈', pf.id, '成功', '');
      return { plan: pf, _dirty: { plans: true } };
    }
    if (payload.id) {
      var pu = store.plans.find(function (x) { return x.id === payload.id; });
      if (!pu) fail_('找不到该计划事项。', '', 404);
      pu.yearMonth = payload.yearMonth || pu.yearMonth;
      pu.type = payload.type || pu.type;
      pu.title = payload.title || pu.title;
      pu.planDate = payload.planDate || pu.planDate;
      pu.owner = payload.owner || pu.owner;
      pu.status = payload.status || pu.status;
      pu.doneDate = payload.doneDate || pu.doneDate;
      pu.waiverRelated = payload.waiverRelated || pu.waiverRelated;
      if (payload.notes != null) pu.notes = payload.notes;
      if (pu.yearMonth) pu.yearMonth = canonYearMonth_(pu.yearMonth) || pu.yearMonth;
      if (payload.status === '已完成') pu.doneDate = pu.doneDate || todayYmd_();
      log_(actor, '修订计划', 'YM:' + canonYearMonth_(pu.yearMonth), '成功', pu.id);
      return { plan: pu, warnings: incompletePlanWarning_(store), _dirty: { plans: true } };
    }
    var pn = {
      id: newId_('PL'),
      yearMonth: payload.yearMonth,
      type: payload.type,
      title: payload.title,
      planDate: payload.planDate || '',
      owner: payload.owner || '',
      status: payload.status || '未完成',
      doneDate: payload.doneDate || '',
      waiverRelated: payload.waiverRelated || '',
      notes: payload.notes || '',
      feedback: '',
      clientRequestId: payload.clientRequestId || ''
    };
    if (!pn.yearMonth) fail_('年月须为 YYYY-MM。', 'BAD_MONTH', 400);
    if (!pn.title) fail_('事项不能为空。', 'BAD_PLAN', 400);
    var replayPlan = (store.plans || []).find(function (p) {
      return payload.clientRequestId && p.clientRequestId === payload.clientRequestId;
    });
    if (replayPlan) {
      return { plan: replayPlan, idempotentReplay: true, warnings: incompletePlanWarning_(store), _dirty: { plans: true } };
    }
    store.plans.push(pn);
    log_(actor, '新增计划', 'YM:' + pn.yearMonth, '成功', pn.id);
    return { plan: pn, warnings: incompletePlanWarning_(store), _dirty: { plans: true } };
  }

  if (action === 'getProposals') {
    return { proposals: store.proposals || [] };
  }
  if (action === 'uploadProposal') {
    if (user.role !== '顾问') fail_('仅顾问可上传运营策划书。客户可查阅。', '', 403);
    if (!uploaded) fail_('请上传策划书文件。', '', 400);
    var pfile = saveUpload_(store, uploaded, '计划与策划书', actor, {});
    var prec = {
      id: newId_('PR'),
      title: payload.title || pfile.name,
      yearMonth: payload.yearMonth || '',
      status: '已归档',
      fileId: pfile.id,
      driveLink: pfile.driveLink,
      date: todayYmd_(),
      notes: payload.notes || ''
    };
    store.proposals = store.proposals || [];
    store.proposals.push(prec);
    log_(actor, '上传策划书', 'YM:' + (canonYearMonth_(prec.yearMonth) || ''), '成功', prec.id + ' ' + pfile.id);
    return { proposal: prec, file: pfile, _dirty: { proposals: true, files: true } };
  }

  if (action === 'getDocuments') {
    return { files: store.files || [], pics: store.pics || [] };
  }
  if (action === 'uploadDocument') {
    if (!uploaded) fail_('请选择要上传的文件。同一文件只传一次，其他模块随后认领。', '', 400);
    var uploadReqId = asStr_(payload.clientRequestId);
    var replayFile = uploadReqId && (store.files || []).find(function (f) {
      return asStr_(f.clientRequestId) === uploadReqId;
    });
    if (PRODUCTION_DATA === true && (uploadReqId === PREVIEW_REPLAY_CLIENT_REQUEST_ID_ || (replayFile && isTestRow_(replayFile)))) {
      fail_('正式身份下不开放虚构资料重放。', 'PREVIEW_REPLAY_CLOSED', 403);
    }
    if (replayFile) {
      log_(actor, '上传资料', replayFile.id, '幂等重放', (replayFile.category || '') + (replayFile.relatedId ? ' 关联 ' + replayFile.relatedId : ''));
      return { file: replayFile, relatedId: replayFile.relatedId || '', idempotentReplay: true };
    }
    var dfile = saveUpload_(store, uploaded, payload.category || '收件', actor, {
      relatedId: payload.relatedId || '',
      notes: payload.notes || '',
      clientRequestId: uploadReqId
    });
    log_(actor, '上传资料', dfile.id, '成功', (dfile.category || '') + (dfile.relatedId ? ' 关联 ' + dfile.relatedId : ''));
    return { file: dfile, relatedId: dfile.relatedId || '', idempotentReplay: false, _dirty: { files: true } };
  }
  if (action === 'acknowledgePics') {
    store.pics = store.pics || [];
    var picsRec = {
      id: newId_('PC'),
      date: todayYmd_(),
      role: user.role,
      actor: actor,
      version: payload.version || 'PICS-PREVIEW-v0.1',
      acknowledged: true,
      digest: payload.digest || '已勾选隐私声明。',
      notes: payload.notes || ''
    };
    store.pics.push(picsRec);
    log_(actor, '隐私声明存证', picsRec.id, '成功', picsRec.version);
    return { pics: picsRec, _dirty: { pics: true } };
  }

  if (action === 'getMonth') {
    var yearMonth = payload.yearMonth;
    if (!yearMonth) {
      var keys = {};
      Object.keys(store.months || {}).forEach(function (raw) {
        var c = canonYearMonth_(raw);
        if (c) keys[c] = true;
      });
      return { months: Object.keys(keys).sort(), asOf: todayYmd_(), openingConfirmed: openingConfirmed_(store) };
    }
    var hasMonth = Object.keys(store.months || {}).some(function (raw) { return canonYearMonth_(raw) === yearMonth; });
    if (!hasMonth) {
      var virtual = emptyMonth_(yearMonth);
      virtual.lineCount = 0;
      virtual.counts = { '已附原件': 0, '免原件': 0, '暂记往来': 0, '未处理': 0 };
      virtual.pastDeadline = pastDeadline_(virtual);
      return {
        month: virtual,
        lines: [],
        groups: { '已附原件': [], '免原件': [], '暂记往来': [], '未处理': [] },
        four: [],
        files: store.files || [],
        rejectedCash: [],
        openingConfirmed: openingConfirmed_(store),
        formalPostAllowed: openingConfirmed_(store)
      };
    }
    var month = summarizeMonth_(store, yearMonth);
    var groupsWrap = completionGroups_(store, yearMonth);
    var four = liveRows_(store.fourStatements).filter(function (r) { return canonYearMonth_(r.period) === canonYearMonth_(yearMonth); });
    return {
      month: month,
      lines: groupsWrap.lines,
      groups: groupsWrap.groups,
      four: four,
      files: store.files || [],
      rejectedCash: month.rejectedCash || [],
      openingConfirmed: openingConfirmed_(store),
      formalPostAllowed: openingConfirmed_(store)
    };
  }
  if (action === 'addStatement') {
    var stmt = addStatement_(store, payload.yearMonth, payload);
    if (uploaded) {
      var sfile = saveUpload_(store, uploaded, '银行月结单', actor, {
        relatedId: payload.yearMonth,
        yearMonth: payload.yearMonth,
        account: payload.accountName,
        opening: stmt.opening,
        closing: stmt.closing
      });
      stmt.fileId = sfile.id;
    } else if (payload.fileId) {
      stmt.fileId = payload.fileId;
      var sf = (store.files || []).find(function (x) { return x.id === payload.fileId; });
      if (sf) {
        sf.claimedBy = sf.claimedBy || [];
        sf.claimedBy.push({ module: '月账', role: '月结单', at: nowIso_(), actor: actor });
      }
    }
    log_(actor, '登记月结单', 'YM:' + payload.yearMonth, '成功', stmt.accountName);
    return { statement: stmt, month: summarizeMonth_(store, payload.yearMonth), _dirty: { month: true, yearMonth: payload.yearMonth, files: true } };
  }
  if (action === 'addCashItem') {
    var item;
    try {
      item = addCashItem_(store, payload.yearMonth, payload);
    } catch (cashErr) {
      if (cashErr.audit) log_(actor, cashErr.audit.action, cashErr.audit.target, cashErr.audit.result, cashErr.audit.notes);
      throw cashErr;
    }
    if (uploaded) {
      var cfile = saveUpload_(store, uploaded, '现金或第三方凭证', actor, { relatedId: item.id, yearMonth: payload.yearMonth });
      item.fileId = cfile.id;
    }
    var replay = item.idempotentReplay === true;
    log_(actor, '登记现金或第三方收支', 'YM:' + (item.yearMonth || payload.yearMonth), replay ? '幂等重放' : '成功', item.id + ' amount=' + item.amount + ' ' + (item.currency || 'HKD'));
    var savedMonth = summarizeMonth_(store, item.yearMonth || payload.yearMonth);
    var listed = (savedMonth.cashItems || []).some(function (c) { return c.id === item.id; });
    return {
      item: item,
      month: savedMonth,
      idempotentReplay: replay,
      readback: {
        id: item.id,
        amount: item.amount,
        currency: item.currency,
        yearMonth: savedMonth.yearMonth,
        listed: listed
      },
      _dirty: { month: true, yearMonth: savedMonth.yearMonth, files: !!uploaded }
    };
  }
  if (action === 'generateLedger') {
    var out = generateLedger_(store, payload.yearMonth);
    log_(actor, '生成第一本明细账', 'YM:' + payload.yearMonth, '成功', '共 ' + out.lines.length + ' 条');
    return Object.assign(out, { _dirty: { month: true, yearMonth: payload.yearMonth, ledgerMonth: true } });
  }
  if (action === 'attachVoucher') {
    var fileId = payload.fileId;
    if (uploaded) {
      var vfile = saveUpload_(store, uploaded, '凭证', actor, { relatedId: payload.lineId });
      fileId = vfile.id;
    }
    var line = attachOrClaim_(store, payload.lineId, fileId, actor, Boolean(payload.fileId) && !uploaded);
    log_(actor, uploaded ? '上传并附原件' : '认领原件', payload.lineId, '成功', fileId);
    var attYm = line.yearMonth;
    return { line: line, _dirty: { files: true, ledgerMonth: true, yearMonth: attYm, month: true } };
  }
  if (action === 'waiveOriginal') {
    var wline = waiveLine_(store, payload.lineId, actor);
    log_(actor, '标明免原件', payload.lineId, '成功', wline.waiverCategory);
    return { line: wline, _dirty: { ledgerMonth: true, yearMonth: wline.yearMonth, month: true } };
  }
  if (action === 'markSuspense') {
    var sline = markSuspense_(store, payload.lineId, actor);
    log_(actor, '标明暂记往来', payload.lineId, '成功', '');
    return { line: sline, _dirty: { ledgerMonth: true, yearMonth: sline.yearMonth, month: true } };
  }
  if (action === 'confirmCompletion') {
    var conf = confirmCompletion_(store, payload.yearMonth, actor);
    log_(actor, '确认完成页', 'YM:' + payload.yearMonth, '成功', JSON.stringify(conf.month.counts));
    return Object.assign(conf, { _dirty: { month: true, yearMonth: payload.yearMonth } });
  }
  if (action === 'previewFourStatements') {
    var pmonth = ensureMonth_(store, payload.yearMonth);
    if (!pmonth.ledgerGenerated || !pmonth.bankBalanced) {
      fail_('尚未生成已配平的明细账，不能预览四套账。', 'UNBALANCED', 400);
    }
    if (!pmonth.completionConfirmed) {
      fail_('未经过完成页确认，不得生成正式四套账或审计用文件。此处只拒绝，不造数。', '', 400);
    }
    var preview = buildFourStatements_(store, payload.yearMonth);
    preview.persisted = false;
    preview.documentStatus = '模拟/草稿 非正式凭证';
    preview.openingConfirmed = openingConfirmed_(store);
    preview.formalPostAllowed = openingConfirmed_(store);
    if (!preview.openingConfirmed) {
      preview.summary = '期初未确认，本结果只是预览，未写入正式四套账。' + preview.summary;
    }
    return preview;
  }
  if (action === 'postFourStatements') formalPostClosed_();

  if (action === 'getContracts') {
    return {
      contracts: store.contracts || [],
      invoices: store.invoices || [],
      files: store.files || [],
      generationOpen: false,
      orderSupported: false,
      orderGap: ORDER_GAP,
      officialInvoiceOpen: false
    };
  }
  if (action === 'getReconciliation') {
    return reconcileContract_(store, payload.contractNo);
  }
  if (action === 'createInvoiceDraft') {
    var draft = createInvoiceDraft_(store, payload, actor);
    log_(actor, '发票草稿', draft.contractNo, draft.idempotentReplay ? '幂等重放' : '成功', draft.invoiceNo + ' ' + DRAFT_MARK);
    return { invoice: draft, idempotentReplay: !!draft.idempotentReplay, _dirty: { invoices: true } };
  }
  if (action === 'issueOfficialInvoice') issueOfficialInvoice_();
  if (action === 'exportFourStatementsDraft') {
    var exported = exportFourDraft_(store, payload.yearMonth, payload);
    var postedSame = !!(store.months[exported.period] && store.months[exported.period].posted);
    log_(actor, '导出四套账草稿', 'YM:' + exported.period, exported.idempotentReplay ? '幂等重放' : '成功', DRAFT_MARK);
    return Object.assign({}, exported, {
      monthPostedUnchanged: postedSame,
      _dirty: { exports: true }
    });
  }
  if (action === 'createContract') {
    var created = createContract_(store, payload, actor);
    log_(actor, '新建合同台账', created.contractNo, '成功', '未开放对客生成');
    return { contract: created, _dirty: { contracts: true } };
  }
  if (action === 'generateOfficialContract') officialGenerateBlocked_();
  if (action === 'archiveSigned') {
    var asId = payload.fileId;
    if (uploaded) {
      var asFile = saveUpload_(store, uploaded, '合同签署正本', actor, { relatedId: payload.contractNo });
      asId = asFile.id;
    }
    var asC = archiveSigned_(store, payload.contractNo, asId, payload.signedDate, actor);
    log_(actor, '归档签署正本', payload.contractNo, '成功', asId);
    return { contract: asC, _dirty: { contracts: true, files: true } };
  }
  if (action === 'claimFirstVoucher') {
    var fvId = payload.fileId;
    if (uploaded) {
      var fvFile = saveUpload_(store, uploaded, '银行凭证', actor, { relatedId: payload.contractNo });
      fvId = fvFile.id;
    }
    var fvC = claimFirstVoucher_(store, payload.contractNo, fvId, actor);
    if (payload.lineId) attachOrClaim_(store, payload.lineId, fvId, actor, true);
    log_(actor, '登记首期凭证', payload.contractNo, '成功', fvId);
    var fvDirty = { contracts: true, files: true };
    if (payload.lineId) {
      var fl = (store.ledger || []).find(function (l) { return l.id === payload.lineId; });
      if (fl) { fvDirty.ledgerMonth = true; fvDirty.yearMonth = fl.yearMonth; fvDirty.month = true; }
    }
    return { contract: fvC, _dirty: fvDirty };
  }
  if (action === 'enterExecution') {
    var ex = enterExecution_(store, payload.contractNo, actor);
    log_(actor, '进入执行', payload.contractNo, '成功', ex.status);
    return { contract: ex, _dirty: { contracts: true } };
  }
  if (action === 'updatePlanNode') {
    var p2 = Object.assign({}, payload);
    if (uploaded) {
      var nfile = saveUpload_(store, uploaded, '履约文件', actor, { relatedId: payload.contractNo });
      if (payload.asConfirm) p2.confirmFileId = nfile.id;
      else p2.fileId = nfile.id;
    }
    var up = updatePlanNode_(store, payload.contractNo, payload.nodeId, p2, actor);
    log_(actor, '更新履约节点', payload.nodeId, '成功', '');
    return { contract: up, _dirty: { contracts: true, files: true } };
  }
  if (action === 'pauseContract') {
    var psId = payload.agreementFileId;
    if (uploaded) {
      var psFile = saveUpload_(store, uploaded, '暂停协议', actor, { relatedId: payload.contractNo });
      psId = psFile.id;
    }
    var paused = pauseContract_(store, payload.contractNo, psId, actor);
    log_(actor, '暂停合同', payload.contractNo, '成功', psId);
    return { contract: paused, _dirty: { contracts: true, files: true } };
  }
  if (action === 'closeContract') {
    var clId = payload.agreementFileId;
    if (uploaded) {
      var clFile = saveUpload_(store, uploaded, '完结协议', actor, { relatedId: payload.contractNo });
      clId = clFile.id;
    }
    var closed = closeContract_(store, payload.contractNo, payload.closeType, clId, actor);
    log_(actor, '完结合同', payload.contractNo, '成功', closed.status);
    return { contract: closed, _dirty: { contracts: true, files: true } };
  }
  if (action === 'claimFile') {
    var cf = (store.files || []).find(function (f) { return f.id === payload.fileId; });
    if (!cf) fail_('找不到该文件。', '', 404);
    cf.claimedBy = cf.claimedBy || [];
    cf.claimedBy.push({
      module: payload.module,
      lineId: payload.lineId || '',
      contractNo: payload.contractNo || '',
      role: payload.role || '认领',
      at: nowIso_(),
      actor: actor
    });
    var cfDirty = { files: true };
    if (payload.lineId) {
      attachOrClaim_(store, payload.lineId, cf.id, actor, true);
      var cln = (store.ledger || []).find(function (l) { return l.id === payload.lineId; });
      if (cln) { cfDirty.ledgerMonth = true; cfDirty.yearMonth = cln.yearMonth; cfDirty.month = true; }
    }
    log_(actor, '认领文件', cf.id, '成功', payload.module || '');
    return { file: cf, _dirty: cfDirty };
  }
  if (action === 'getLogs') {
    return { logs: (store.logs || []).slice(-200).reverse() };
  }

  fail_('未知操作。', '', 400);
}

function dispatch_(action, payload, token, uploaded) {
  stageBegin_(action);
  DRIVE_FOLDER_MEMO_ = {};
  DISPATCH_TARGETS_OK_ = false;
  try {
    return dispatchBody_(action, payload, token, uploaded);
  } finally {
    /* 写类动作（含失败的写）结束后清 config 缓存；仅在目标校验通过后才碰缓存。 */
    if (DISPATCH_TARGETS_OK_ && isWriteAction_(action) && !testStore_()) storeCacheClear_();
    DISPATCH_TARGETS_OK_ = false;
    DRIVE_FOLDER_MEMO_ = {};
    stageFlush_();
  }
}

var DISPATCH_TARGETS_OK_ = false;

function isWriteAction_(action) {
  return !Object.prototype.hasOwnProperty.call(READ_ONLY_ACTIONS_, action);
}

/* One script lock for every write. Reads stay lock-free. Node tests without LockService skip the call. */
function acquireScriptLock_() {
  if (typeof LockService === 'undefined' || !LockService || typeof LockService.getScriptLock !== 'function') return null;
  var lock = LockService.getScriptLock();
  var tLock = stageNow_();
  try {
    if (lock && typeof lock.waitLock === 'function') lock.waitLock(30000);
  } finally {
    stageMark_('lock-wait', tLock);
  }
  return lock;
}

function releaseScriptLock_(lock) {
  if (lock && typeof lock.releaseLock === 'function') {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function dispatchBody_(action, payload, token, uploaded) {
  var tTargets = stageNow_();
  try { assertIsolatedTargets_(); } finally { stageMark_('assert-targets', tTargets); }
  DISPATCH_TARGETS_OK_ = true;
  /* 写类动作开始前也清一次，保证写路径读到的 config 与 V2 一样是现读。 */
  if (isWriteAction_(action) && !testStore_()) storeCacheClear_();
  if (!action) fail_('缺少 action。', '', 400);

  var writeLock = null;
  if (isWriteAction_(action)) writeLock = acquireScriptLock_();
  try {
    if (action === 'login') {
      var tLogin = stageNow_();
      try { return login_(payload); } finally { stageMark_('authenticate', tLogin); }
    }
    if (!token) fail_('未登录或会话已失效，已拒绝访问。', 'UNAUTHENTICATED', 401);

    var tAuth = stageNow_();
    var user;
    try { user = requireUser_(token); } finally { stageMark_('authenticate', tAuth); }
    if (action === 'logout') {
      removeSession_(token);
      log_(user.jobId, '登出', '', '成功', '');
      return { ok: true };
    }

    var store = loadStore_(action);
    var result;
    if (action === 'uploadDocument' && !testStore_()) {
      var tLockedFiles = stageNow_();
      store.files = loadFiles_();
      stageMark_('load-store', tLockedFiles, 'files');
    }
    var tApply = stageNow_();
    try { result = applyAction_(store, action, payload || {}, user, uploaded); }
    finally { stageMark_('apply-action', tApply); }
    var dirty = result && result._dirty;
    if (result && result._dirty) delete result._dirty;
    if (dirty) {
      var tPersist = stageNow_();
      try { persist_(store, dirty); } finally { stageMark_('persist', tPersist); }
    }
    return result;
  } catch (err) {
    if (err && err.dirty) {
      var tErrorPersist = stageNow_();
      try { persist_(store, err.dirty); } catch (ignore) {}
      finally { stageMark_('persist', tErrorPersist); }
    }
    throw err;
  } finally {
    releaseScriptLock_(writeLock);
  }
}

var FS_IMPLEMENTED_ACTIONS = [
  'login', 'logout', 'me',
  'getDashboard', 'getPlans', 'savePlan',
  'getProposals', 'uploadProposal',
  'getDocuments', 'uploadDocument', 'acknowledgePics',
  'getMonth', 'addStatement', 'addCashItem', 'generateLedger',
  'attachVoucher', 'waiveOriginal', 'markSuspense',
  'confirmCompletion', 'previewFourStatements', 'exportFourStatementsDraft', 'postFourStatements',
  'getContracts', 'getReconciliation', 'getEffectiveTargets', 'createContract', 'generateOfficialContract',
  'createInvoiceDraft', 'issueOfficialInvoice',
  'archiveSigned', 'claimFirstVoucher', 'enterExecution',
  'updatePlanNode', 'pauseContract', 'closeContract',
  'claimFile', 'getLogs'
];

var FS_RULES = {
  SPREADSHEET_ID: SPREADSHEET_ID,
  AUTH_SHEET: AUTH_SHEET,
  CASH_LINE_LIMIT: CASH_LINE_LIMIT,
  CASH_MONTH_LIMIT: CASH_MONTH_LIMIT,
  WAIVER_TYPES: WAIVER_TYPES,
  FS_IMPLEMENTED_ACTIONS: FS_IMPLEMENTED_ACTIONS,
  dispatch_: dispatch_,
  applyAction_: applyAction_,
  login_: login_,
  requireUser_: requireUser_,
  addStatement_: addStatement_,
  addCashItem_: addCashItem_,
  generateLedger_: generateLedger_,
  attachOrClaim_: attachOrClaim_,
  waiveLine_: waiveLine_,
  markSuspense_: markSuspense_,
  confirmCompletion_: confirmCompletion_,
  previewFourStatements_: buildFourStatements_,
  postFourStatements_: postFourStatements_,
  buildFourStatements_: buildFourStatements_,
  summarizeMonth_: summarizeMonth_,
  completionGroups_: completionGroups_,
  canWaive_: canWaive_,
  incompletePlanWarning_: incompletePlanWarning_,
  createContract_: createContract_,
  archiveSigned_: archiveSigned_,
  claimFirstVoucher_: claimFirstVoucher_,
  enterExecution_: enterExecution_,
  updatePlanNode_: updatePlanNode_,
  pauseContract_: pauseContract_,
  closeContract_: closeContract_,
  officialGenerateBlocked_: officialGenerateBlocked_,
  refreshStage_: refreshStage_,
  buildDefaultPlan_: buildDefaultPlan_,
  canonYearMonth_: canonYearMonth_,
  sheetMonthKey_: sheetMonthKey_,
  openingConfirmed_: openingConfirmed_,
  checkCashLimits_: checkCashLimits_,
  assertIsolatedTargets_: assertIsolatedTargets_,
  BUILD_ID: BUILD_ID,
  setTestStore_: setTestStore_
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FS_RULES;
}
