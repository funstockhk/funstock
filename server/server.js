'use strict';

/**
 * FUNSTOCK internal preview server.
 * Single API used by /admin/. Does not touch the live site, DNS, or production sheets.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const auth = require('./lib/auth');
const storeLib = require('./lib/store');
const finance = require('./lib/finance');
const contracts = require('./lib/contracts');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function readSessions() {
  if (!fs.existsSync(SESSION_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeSessions(s) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function send(res, status, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
    h['Content-Type'] = h['Content-Type'] || 'application/json; charset=utf-8';
    body = JSON.stringify(body);
  }
  h['Content-Length'] = Buffer.byteLength(body || '');
  res.writeHead(status, h);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, obj);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) {
        reject(new Error('请求体过大。'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('无法解析上传。');
  const boundary = '--' + (m[1] || m[2]);
  const parts = [];
  const raw = buffer;
  const marker = Buffer.from('\r\n' + boundary);
  // split
  let start = raw.indexOf(Buffer.from(boundary));
  if (start < 0) return { fields: {}, file: null };
  start += boundary.length;
  if (raw.slice(start, start + 2).toString() === '\r\n') start += 2;
  const fields = {};
  let file = null;
  while (start < raw.length) {
    if (raw.slice(start, start + 2).toString() === '--') break;
    const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd < 0) break;
    const header = raw.slice(start, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    let next = raw.indexOf(Buffer.from('\r\n' + boundary), bodyStart);
    if (next < 0) next = raw.indexOf(Buffer.from(boundary), bodyStart);
    if (next < 0) break;
    const body = raw.slice(bodyStart, next);
    const nameM = /name="([^"]+)"/.exec(header);
    const fileM = /filename="([^"]*)"/.exec(header);
    const typeM = /Content-Type:\s*([^\r\n]+)/i.exec(header);
    const name = nameM ? nameM[1] : '';
    if (fileM && fileM[1]) {
      file = {
        field: name,
        filename: path.basename(fileM[1]),
        mime: typeM ? typeM[1].trim() : 'application/octet-stream',
        data: body,
      };
    } else {
      fields[name] = body.toString('utf8');
    }
    start = next + 2 + boundary.length;
    if (raw.slice(start, start + 2).toString() === '\r\n') start += 2;
  }
  return { fields, file };
}

function loadStoreSafe() {
  return storeLib.load(STORE_FILE);
}

function withStore(writer, fn) {
  const store = loadStoreSafe();
  const result = fn(store);
  if (writer) storeLib.save(STORE_FILE, store);
  return result;
}

function currentUser(req, store) {
  auth.assertAuthStore(store);
  const cookies = parseCookies(req);
  const token = cookies.fs_session || (req.headers['x-session-token'] || '');
  if (!token) return null;
  const sessions = readSessions();
  const sess = sessions[token];
  if (!sess) return null;
  const user = store.users.find((u) => u.jobId === sess.jobId);
  if (!user || user.status !== '启用') return null;
  return { token, user };
}

function requireUser(req, store) {
  const cu = currentUser(req, store);
  if (!cu) {
    const err = new Error('未登录或会话已失效，已拒绝访问。');
    err.status = 401;
    err.code = 'UNAUTHENTICATED';
    throw err;
  }
  return cu;
}

function canWritePlans(role) {
  return role === '顾问';
}
function canUploadProposal(role) {
  return role === '顾问';
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', { 'Access-Control-Allow-Origin': req.headers.origin || '', 'Access-Control-Allow-Credentials': 'true' });
    return;
  }

  // file download
  if (req.method === 'GET' && url.pathname.startsWith('/api/files/')) {
    const store = loadStoreSafe();
    requireUser(req, store);
    const id = decodeURIComponent(url.pathname.slice('/api/files/'.length));
    const file = (store.files || []).find((f) => f.id === id);
    if (!file || !file.localPath || !fs.existsSync(path.join(ROOT, file.localPath))) {
      sendJson(res, 404, { ok: false, error: '找不到该文件。' });
      return;
    }
    const abs = path.join(ROOT, file.localPath);
    const data = fs.readFileSync(abs);
    send(res, 200, data, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/api') {
    sendJson(res, 404, { ok: false, error: '接口不存在。' });
    return;
  }

  const ct = req.headers['content-type'] || '';
  const raw = await readBody(req);
  let action, payload, uploaded = null;

  if (ct.includes('multipart/form-data')) {
    const mp = parseMultipart(raw, ct);
    action = mp.fields.action;
    try {
      payload = mp.fields.payload ? JSON.parse(mp.fields.payload) : { ...mp.fields };
    } catch {
      payload = { ...mp.fields };
    }
    delete payload.action;
    uploaded = mp.file;
  } else {
    let body = {};
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: '请求不是合法 JSON。' });
        return;
      }
    }
    action = body.action;
    payload = body.payload || body;
  }

  try {
    const result = dispatch(req, action, payload || {}, uploaded);
    const headers = { 'Cache-Control': 'no-store' };
    if (action === 'login' && result && result.token) {
      headers['Set-Cookie'] = `fs_session=${result.token}; Path=/; HttpOnly; SameSite=Lax`;
    }
    if (action === 'logout') {
      headers['Set-Cookie'] = 'fs_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
    }
    send(res, 200, { ok: true, data: result }, headers);
  } catch (e) {
    const status = e.status || 500;
    sendJson(res, status, { ok: false, error: e.message || '服务器错误。', code: e.code || '' });
  }
}

function saveUpload(store, uploaded, category, actor, extra) {
  if (!uploaded || !uploaded.data) {
    const err = new Error('没有收到文件。');
    err.status = 400;
    throw err;
  }
  const id = storeLib.newId('FL');
  const safe = (uploaded.filename || 'file').replace(/[^\w.\-\u4e00-\u9fff（）()]+/g, '_');
  const rel = path.join('data', 'uploads', `${id}_${safe}`);
  const abs = path.join(ROOT, rel);
  fs.writeFileSync(abs, uploaded.data);
  const rec = {
    id,
    date: storeLib.todayYmd(),
    category: category || '收件',
    relatedId: (extra && extra.relatedId) || '',
    name: uploaded.filename || safe,
    localPath: rel.replace(/\\/g, '/'),
    driveLink: '',
    source: '收件',
    status: '已归档（本地预览）',
    notes: (extra && extra.notes) || '测试文件（虚构）',
    mime: uploaded.mime,
    size: uploaded.data.length,
    claimedBy: [],
    uploadedBy: actor,
  };
  store.files = store.files || [];
  store.files.push(rec);
  return rec;
}

function dispatch(req, action, payload, uploaded) {
  if (!action) {
    const err = new Error('缺少 action。');
    err.status = 400;
    throw err;
  }

  if (action === 'login') {
    const store = loadStoreSafe();
    auth.assertAuthStore(store);
    if (!store.users.length) {
      const err = new Error('授权用户表为空，已拒绝访问。');
      err.code = 'AUTH_STORE_MISSING';
      err.status = 403;
      throw err;
    }
    const jobId = String(payload.jobId || '').trim();
    const password = String(payload.password || '');
    const user = store.users.find((u) => u.jobId === jobId);
    // constant-ish reject
    if (!user || user.status !== '启用' || !auth.verifyPassword(password, user.passwordHash)) {
      storeLib.log(store, jobId || 'unknown', '登录', '', '拒绝', '工号或口令不正确。');
      storeLib.save(STORE_FILE, store);
      const err = new Error('工号或口令不正确，已拒绝。');
      err.status = 401;
      throw err;
    }
    const token = auth.newToken();
    const sessions = readSessions();
    sessions[token] = { jobId: user.jobId, role: user.role, at: storeLib.nowIso() };
    writeSessions(sessions);
    storeLib.log(store, user.jobId, '登录', '', '成功', '');
    storeLib.save(STORE_FILE, store);
    return { token, user: auth.publicUser(user) };
  }

  // All other actions need a valid store + user
  const store = loadStoreSafe();
  const { user, token } = requireUser(req, store);
  const actor = user.jobId;
  const write = true;

  if (action === 'logout') {
    const sessions = readSessions();
    delete sessions[token];
    writeSessions(sessions);
    storeLib.log(store, actor, '登出', '', '成功', '');
    storeLib.save(STORE_FILE, store);
    return { ok: true };
  }
  if (action === 'me') {
    return { user: auth.publicUser(user), asOf: storeLib.todayYmd(), preview: true };
  }

  if (action === 'getDashboard') {
    const warnings = finance.incompletePlanWarning(store);
    const months = Object.keys(store.months || {}).sort();
    const latest = months[months.length - 1];
    const monthSum = latest ? finance.summarizeMonth(store, latest) : null;
    const pendingDocs = (store.files || []).filter((f) => f.status === '待核验').length;
    const picsPending = (store.pics || []).filter((p) => !p.acknowledged).length;
    const finances = latest && store.months[latest] && store.months[latest].posted
      ? (store.fourStatements || []).filter((r) => r.period === latest && r.type === '利润表')
      : [];
    return {
      asOf: storeLib.todayYmd(),
      company: store.config.companyName,
      warnings,
      plansThisMonth: (store.plans || []).filter((p) => latest && p.yearMonth === latest),
      month: monthSum,
      pendingDocs,
      picsPending,
      finances,
      contracts: (store.contracts || []).map((c) => ({
        contractNo: c.contractNo, status: c.status, stage: c.stage, counterparty: c.counterparty,
      })),
    };
  }

  if (action === 'getPlans') {
    return { plans: store.plans || [], warnings: finance.incompletePlanWarning(store) };
  }
  if (action === 'savePlan') {
    if (!canWritePlans(user.role) && payload.mode !== 'feedback') {
      const err = new Error('仅顾问可下达或修订经营计划。客户可提交回馈。');
      err.status = 403;
      throw err;
    }
    store.plans = store.plans || [];
    if (payload.mode === 'feedback') {
      const p = store.plans.find((x) => x.id === payload.id);
      if (!p) {
        const err = new Error('找不到该计划事项。');
        err.status = 404;
        throw err;
      }
      p.feedback = payload.feedback || '';
      p.feedbackBy = actor;
      p.feedbackAt = storeLib.nowIso();
      storeLib.log(store, actor, '计划回馈', p.id, '成功', '');
      storeLib.save(STORE_FILE, store);
      return { plan: p };
    }
    if (payload.id) {
      const p = store.plans.find((x) => x.id === payload.id);
      if (!p) {
        const err = new Error('找不到该计划事项。');
        err.status = 404;
        throw err;
      }
      Object.assign(p, {
        yearMonth: payload.yearMonth || p.yearMonth,
        type: payload.type || p.type,
        title: payload.title || p.title,
        planDate: payload.planDate || p.planDate,
        owner: payload.owner || p.owner,
        status: payload.status || p.status,
        doneDate: payload.doneDate || p.doneDate,
        waiverRelated: payload.waiverRelated || p.waiverRelated,
        notes: payload.notes != null ? payload.notes : p.notes,
      });
      if (payload.status === '已完成') p.doneDate = p.doneDate || storeLib.todayYmd();
      storeLib.log(store, actor, '修订计划', p.id, '成功', '');
      storeLib.save(STORE_FILE, store);
      return { plan: p, warnings: finance.incompletePlanWarning(store) };
    }
    const p = {
      id: storeLib.newId('PL'),
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
    };
    store.plans.push(p);
    storeLib.log(store, actor, '新增计划', p.id, '成功', '');
    storeLib.save(STORE_FILE, store);
    return { plan: p, warnings: finance.incompletePlanWarning(store) };
  }

  if (action === 'getProposals') {
    return { proposals: store.proposals || [] };
  }
  if (action === 'uploadProposal') {
    if (!canUploadProposal(user.role)) {
      const err = new Error('仅顾问可上传运营策划书。客户可查阅。');
      err.status = 403;
      throw err;
    }
    if (!uploaded) {
      const err = new Error('请上传策划书文件。');
      err.status = 400;
      throw err;
    }
    const file = saveUpload(store, uploaded, '计划与策划书', actor, { notes: '测试策划书（虚构）' });
    const rec = {
      id: storeLib.newId('PR'),
      title: payload.title || file.name,
      yearMonth: payload.yearMonth || '',
      status: '已归档',
      fileId: file.id,
      date: storeLib.todayYmd(),
      notes: payload.notes || '',
    };
    store.proposals = store.proposals || [];
    store.proposals.push(rec);
    storeLib.log(store, actor, '上传策划书', rec.id, '成功', file.id);
    storeLib.save(STORE_FILE, store);
    return { proposal: rec, file };
  }

  if (action === 'getDocuments') {
    return { files: store.files || [], pics: store.pics || [] };
  }
  if (action === 'uploadDocument') {
    if (!uploaded) {
      const err = new Error('请选择要上传的文件。同一文件只传一次，其他模块随后认领。');
      err.status = 400;
      throw err;
    }
    const file = saveUpload(store, uploaded, payload.category || '收件', actor, {
      relatedId: payload.relatedId || '',
      notes: payload.notes || '测试资料（虚构）',
    });
    storeLib.log(store, actor, '上传资料', file.id, '成功', file.category);
    storeLib.save(STORE_FILE, store);
    return { file };
  }
  if (action === 'acknowledgePics') {
    store.pics = store.pics || [];
    const rec = {
      id: storeLib.newId('PC'),
      date: storeLib.todayYmd(),
      role: user.role,
      actor,
      version: payload.version || 'PICS-PREVIEW-v0.1',
      acknowledged: true,
      digest: payload.digest || '已勾选预览版隐私声明（测试存证，非正式对外文本）。',
      notes: payload.notes || '',
    };
    store.pics.push(rec);
    storeLib.log(store, actor, '隐私声明存证', rec.id, '成功', rec.version);
    storeLib.save(STORE_FILE, store);
    return { pics: rec };
  }

  if (action === 'getMonth') {
    const yearMonth = payload.yearMonth;
    if (!yearMonth) {
      return {
        months: Object.keys(store.months || {}).sort(),
        asOf: storeLib.todayYmd(),
      };
    }
    const month = finance.summarizeMonth(store, yearMonth);
    const { groups, lines } = finance.completionGroups(store, yearMonth);
    const four = (store.fourStatements || []).filter((r) => r.period === yearMonth);
    return { month, lines, groups, four, files: store.files || [], rejectedCash: month.rejectedCash || [] };
  }
  if (action === 'addStatement') {
    const stmt = finance.addStatement(store, payload.yearMonth, payload);
    if (uploaded) {
      const file = saveUpload(store, uploaded, '银行月结单', actor, { relatedId: payload.yearMonth, notes: '测试月结单（虚构）' });
      stmt.fileId = file.id;
    } else if (payload.fileId) {
      stmt.fileId = payload.fileId;
      const f = (store.files || []).find((x) => x.id === payload.fileId);
      if (f) {
        f.claimedBy = f.claimedBy || [];
        f.claimedBy.push({ module: '月账', role: '月结单', at: storeLib.nowIso(), actor });
      }
    }
    storeLib.log(store, actor, '登记月结单', payload.yearMonth, '成功', stmt.accountName);
    storeLib.save(STORE_FILE, store);
    return { statement: stmt, month: finance.summarizeMonth(store, payload.yearMonth) };
  }
  if (action === 'addCashItem') {
    const item = finance.addCashItem(store, payload.yearMonth, payload);
    if (uploaded) {
      const file = saveUpload(store, uploaded, '现金或第三方凭证', actor, { relatedId: item.id });
      item.fileId = file.id;
    }
    storeLib.log(store, actor, '登记现金或第三方收支', payload.yearMonth, '成功', item.id);
    storeLib.save(STORE_FILE, store);
    return { item, month: finance.summarizeMonth(store, payload.yearMonth) };
  }
  if (action === 'generateLedger') {
    const out = finance.generateLedger(store, payload.yearMonth);
    storeLib.log(store, actor, '生成第一本明细账', payload.yearMonth, '成功', `共 ${out.lines.length} 条`);
    storeLib.save(STORE_FILE, store);
    return out;
  }
  if (action === 'attachVoucher') {
    let fileId = payload.fileId;
    if (uploaded) {
      const file = saveUpload(store, uploaded, '凭证', actor, { relatedId: payload.lineId });
      fileId = file.id;
    }
    const line = finance.attachOrClaim(store, payload.lineId, fileId, actor, Boolean(payload.fileId) && !uploaded);
    storeLib.log(store, actor, uploaded ? '上传并附原件' : '认领原件', payload.lineId, '成功', fileId);
    storeLib.save(STORE_FILE, store);
    return { line };
  }
  if (action === 'waiveOriginal') {
    const line = finance.waiveLine(store, payload.lineId, actor);
    storeLib.log(store, actor, '标明免原件', payload.lineId, '成功', line.waiverCategory);
    storeLib.save(STORE_FILE, store);
    return { line };
  }
  if (action === 'markSuspense') {
    const line = finance.markSuspense(store, payload.lineId, actor);
    storeLib.log(store, actor, '标明暂记往来', payload.lineId, '成功', '');
    storeLib.save(STORE_FILE, store);
    return { line };
  }
  if (action === 'confirmCompletion') {
    const out = finance.confirmCompletion(store, payload.yearMonth, actor);
    storeLib.log(store, actor, '确认完成页', payload.yearMonth, '成功', JSON.stringify(out.month.counts));
    storeLib.save(STORE_FILE, store);
    return out;
  }
  if (action === 'postFourStatements') {
    const out = finance.postFourStatements(store, payload.yearMonth, actor);
    storeLib.log(store, actor, '定稿四套账', payload.yearMonth, out.balanced ? '成功' : '拒绝', out.summary);
    storeLib.save(STORE_FILE, store);
    return out;
  }
  if (action === 'previewFourStatements') {
    const month = finance.ensureMonth(store, payload.yearMonth);
    if (!month.completionConfirmed) {
      const err = new Error('未经过完成页确认，不得生成正式四套账或审计用文件。此处只拒绝，不造数。');
      err.status = 400;
      throw err;
    }
    return finance.buildFourStatements(store, payload.yearMonth);
  }

  if (action === 'getContracts') {
    return { contracts: store.contracts || [], invoices: store.invoices || [], files: store.files || [], generationOpen: false };
  }
  if (action === 'createContract') {
    const c = contracts.createContract(store, payload, actor);
    storeLib.log(store, actor, '新建合同台账', c.contractNo, '成功', '未开放对客生成');
    storeLib.save(STORE_FILE, store);
    return { contract: c };
  }
  if (action === 'generateOfficialContract') {
    contracts.officialGenerateBlocked();
  }
  if (action === 'archiveSigned') {
    let fileId = payload.fileId;
    if (uploaded) {
      const file = saveUpload(store, uploaded, '合同签署正本', actor, { relatedId: payload.contractNo });
      fileId = file.id;
    }
    const c = contracts.archiveSigned(store, payload.contractNo, fileId, payload.signedDate, actor);
    storeLib.log(store, actor, '归档签署正本', payload.contractNo, '成功', fileId);
    storeLib.save(STORE_FILE, store);
    return { contract: c };
  }
  if (action === 'claimFirstVoucher') {
    let fileId = payload.fileId;
    if (uploaded) {
      const file = saveUpload(store, uploaded, '银行凭证', actor, { relatedId: payload.contractNo });
      fileId = file.id;
    }
    const c = contracts.claimFirstVoucher(store, payload.contractNo, fileId, actor);
    // If a ledger line is named, also claim for finance without double-booking
    if (payload.lineId) {
      finance.attachOrClaim(store, payload.lineId, fileId, actor, true);
    }
    storeLib.log(store, actor, '登记首期凭证', payload.contractNo, '成功', fileId);
    storeLib.save(STORE_FILE, store);
    return { contract: c };
  }
  if (action === 'enterExecution') {
    const c = contracts.enterExecution(store, payload.contractNo, actor);
    storeLib.log(store, actor, '进入执行', payload.contractNo, '成功', c.status);
    storeLib.save(STORE_FILE, store);
    return { contract: c };
  }
  if (action === 'updatePlanNode') {
    let payload2 = Object.assign({}, payload);
    if (uploaded) {
      const file = saveUpload(store, uploaded, '履约文件', actor, { relatedId: payload.contractNo });
      if (payload.asConfirm) payload2.confirmFileId = file.id;
      else payload2.fileId = file.id;
    }
    const c = contracts.updatePlanNode(store, payload.contractNo, payload.nodeId, payload2, actor);
    storeLib.log(store, actor, '更新履约节点', payload.nodeId, '成功', '');
    storeLib.save(STORE_FILE, store);
    return { contract: c };
  }
  if (action === 'pauseContract') {
    let fileId = payload.agreementFileId;
    if (uploaded) {
      const file = saveUpload(store, uploaded, '暂停协议', actor, { relatedId: payload.contractNo });
      fileId = file.id;
    }
    const c = contracts.pauseContract(store, payload.contractNo, fileId, actor);
    storeLib.log(store, actor, '暂停合同', payload.contractNo, '成功', fileId);
    storeLib.save(STORE_FILE, store);
    return { contract: c };
  }
  if (action === 'closeContract') {
    let fileId = payload.agreementFileId;
    if (uploaded) {
      const file = saveUpload(store, uploaded, '完结协议', actor, { relatedId: payload.contractNo });
      fileId = file.id;
    }
    const c = contracts.closeContract(store, payload.contractNo, payload.closeType, fileId, actor);
    storeLib.log(store, actor, '完结合同', payload.contractNo, '成功', c.status);
    storeLib.save(STORE_FILE, store);
    return { contract: c };
  }
  if (action === 'claimFile') {
    const file = (store.files || []).find((f) => f.id === payload.fileId);
    if (!file) {
      const err = new Error('找不到该文件。');
      err.status = 404;
      throw err;
    }
    file.claimedBy = file.claimedBy || [];
    file.claimedBy.push({
      module: payload.module,
      lineId: payload.lineId || '',
      contractNo: payload.contractNo || '',
      role: payload.role || '认领',
      at: storeLib.nowIso(),
      actor,
    });
    if (payload.lineId) finance.attachOrClaim(store, payload.lineId, file.id, actor, true);
    storeLib.log(store, actor, '认领文件', file.id, '成功', payload.module || '');
    storeLib.save(STORE_FILE, store);
    return { file };
  }
  if (action === 'getLogs') {
    return { logs: (store.logs || []).slice(-200).reverse() };
  }

  const err = new Error('未知操作。');
  err.status = 400;
  throw err;
}

function safeJoin(root, rel) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root)) return null;
  return abs;
}

function isAdminAsset(rel) {
  return rel.startsWith('admin/css/') || rel.startsWith('admin/js/');
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  rel = rel.replace(/^\/+/, '');

  // Gate /admin/ except login and static assets
  if (rel === 'admin' || rel.startsWith('admin/')) {
    const isLogin = rel === 'admin/login.html' || rel === 'admin/login';
    if (isLogin) {
      return sendFile(res, path.join(SITE, 'admin', 'login.html'));
    }
    if (isAdminAsset(rel)) {
      return sendFile(res, path.join(SITE, rel));
    }
    // Module paths and /admin/ require session
    try {
      const store = loadStoreSafe();
      const cu = currentUser(req, store);
      if (!cu) {
        if ((req.headers.accept || '').includes('application/json')) {
          return sendJson(res, 401, { ok: false, error: '未登录，已拒绝访问。', code: 'UNAUTHENTICATED' });
        }
        res.writeHead(302, { Location: '/admin/login.html', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
    } catch (e) {
      if (e.code === 'AUTH_STORE_MISSING') {
        if ((req.headers.accept || '').includes('application/json')) {
          return sendJson(res, 403, { ok: false, error: e.message, code: e.code });
        }
        res.writeHead(302, { Location: '/admin/login.html?err=auth_store', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      throw e;
    }
    // All gated admin pages serve the same shell
    return sendFile(res, path.join(SITE, 'admin', 'index.html'));
  }

  const abs = safeJoin(SITE, rel);
  if (!abs) return send(res, 403, 'Forbidden');
  return sendFile(res, abs);
}

function sendFile(res, abs) {
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  const data = fs.readFileSync(abs);
  send(res, 200, data, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method not allowed');
      return;
    }
    serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    sendJson(res, status, { ok: false, error: e.message || '服务器错误。', code: e.code || '' });
  }
});

if (require.main === module) {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  server.listen(PORT, HOST, () => {
    console.log(`FUNSTOCK preview listening on http://127.0.0.1:${PORT}/`);
    console.log(`Admin login: http://127.0.0.1:${PORT}/admin/login.html`);
    console.log('Internal preview only. No DNS change. No production traffic.');
  });
}

module.exports = { server, STORE_FILE, dispatch, loadStoreSafe };
