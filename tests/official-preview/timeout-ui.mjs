/**
 * Local browser check for the official-preview timeout fix.
 * Same-origin /api is intercepted. exec.invalid is mapped to 127.0.0.1. Nothing is uploaded.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const siteRoot = path.join(root, 'site');

function loadPuppeteer() {
  const cached = path.join(os.tmpdir(), 'puppeteer-core', 'node_modules', 'puppeteer-core');
  const specs = [process.env.PUPPETEER_MODULE, 'puppeteer-core', 'puppeteer', cached].filter(Boolean);
  const failures = [];
  for (const spec of specs) {
    try { return require(spec); } catch (err) { failures.push(spec + ': ' + err.message); }
  }
  throw new Error('Cannot load puppeteer-core. Tried ' + failures.join(' | '));
}

const puppeteer = loadPuppeteer();
const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome';
const outDir = process.env.AC02_ARTIFACT_DIR || '/opt/cursor/artifacts';
fs.mkdirSync(outDir, { recursive: true });

const BUILD = 'ac02-preview';
const FORBIDDEN = '尚未确认是否已保存';
const samplePath = path.join(os.tmpdir(), 'ac02-preview-timeout-marker.txt');
fs.writeFileSync(samplePath, 'official-preview timeout marker\n');
const sampleSize = fs.statSync(samplePath).size;
const sampleName = path.basename(samplePath);
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Hong_Kong',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date());

function fileRow(id) {
  return {
    id: id,
    date: today,
    category: '其他',
    relatedId: '',
    name: sampleName,
    source: '收件',
    status: '已归档',
    claimedBy: [],
    uploadedBy: 'LOCAL-MOCK',
    mime: 'text/plain',
    size: sampleSize,
    driveLink: ''
  };
}

const oldFile = fileRow('FL-OLD');
const savedFile = fileRow('FL-MWN982MJ0XXQC9');
let includeSaved = false;
let failList = false;
const calls = [];
const requestIds = [];

function mePayload() {
  return {
    user: { displayName: '本地核对', role: '顾问', jobId: 'LOCAL-MOCK' },
    asOf: today,
    openingConfirmed: true,
    preview: true,
    officialContractOpen: false,
    buildId: BUILD,
    dataMode: 'official-preview',
    productionData: false,
    release: {
      buildId: BUILD,
      dataMode: 'official-preview',
      productionData: false,
      spreadsheetId: 'LOCAL-MOCK-SHEET',
      driveRootId: 'LOCAL-MOCK-DRIVE'
    }
  };
}

function monthPayload() {
  return {
    openingConfirmed: true,
    months: ['2026-11'],
    month: {
      yearMonth: '2026-11',
      deadline: '2026-12-07',
      pastDeadline: false,
      ledgerGenerated: true,
      bankBalanced: true,
      completionConfirmed: true,
      posted: false,
      cashItems: [],
      statements: [{ accountName: '测试银行', opening: 0, closing: 0, lines: [] }]
    },
    groups: { '未处理': [], '已附原件': [], '免原件': [], '暂记往来': [] },
    lines: [],
    files: [],
    four: [],
    rejectedCash: []
  };
}

function answer(action) {
  if (action === 'me') return { ok: true, data: mePayload() };
  if (action === 'getDashboard') {
    return {
      ok: true,
      data: {
        currentYearMonth: '2026-11',
        asOf: today,
        warnings: [],
        plansThisMonth: [],
        month: null,
        pendingDocs: 0,
        picsPending: 0,
        contracts: [],
        openingConfirmed: true
      }
    };
  }
  if (action === 'getDocuments') {
    const files = includeSaved ? [oldFile, savedFile] : [oldFile];
    return { ok: true, data: { files: files, pics: [] } };
  }
  if (action === 'getMonth') return { ok: true, data: monthPayload() };
  if (action === 'getContracts') return { ok: true, data: { contracts: [], invoices: [], files: [] } };
  return { ok: false, error: 'local timeout ui does not perform ' + action, code: 'TEST_BLOCK' };
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.endsWith('/admin/js/build.js')) {
    const overlay = [
      'window.AC02_BUILD = { buildId: "ac02-preview", dataMode: "ac02-preview", productionData: false };',
      'window.AC02_IDENTITIES = [',
      '  { buildId: "ac02-preview", dataMode: "ac02-preview", productionData: false },',
      '  { buildId: "ac02-official", dataMode: "ac02-official", productionData: true }',
      '];',
      ''
    ].join('\n');
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(overlay);
    return;
  }
  let filePath = path.normalize(path.join(siteRoot, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(siteRoot)) {
    res.writeHead(403);
    res.end('no');
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('missing');
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(filePath));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--host-resolver-rules=MAP exec.invalid 127.0.0.1'
  ]
});

async function shot(page, name) {
  const dest = path.join(outDir, name);
  await page.screenshot({ path: dest, fullPage: true });
  return dest;
}

function assertSafe(text, label) {
  if (text.includes(FORBIDDEN)) throw new Error(label + ' used the write-unconfirmed sentence: ' + text.slice(0, 300));
  if (text.includes('请使用同一请求号重试') || text.includes('可使用同一请求号重试') || text.includes('请稍后用同一请求号重试')) {
    throw new Error(label + ' invited a same-request retry: ' + text.slice(0, 300));
  }
}

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    let host = '';
    try { host = new URL(url).host; } catch (e) { host = ''; }
    if ((() => { try { const u = new URL(url); return u.pathname !== '/api' && u.host !== 'exec.invalid'; } catch (e) { return true; } })()) {
      request.continue().catch(() => {});
      return;
    }
    if (request.method() === 'OPTIONS') {
      request.respond({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      }).catch(() => {});
      return;
    }
    let action = '';
    let payload = {};
    try {
      const body = JSON.parse(request.postData() || '{}');
      action = body.action || '';
      payload = body.payload || {};
    } catch (e) { action = ''; }
    calls.push(action);
    if (action === 'uploadDocument') {
      if (payload.clientRequestId) requestIds.push(payload.clientRequestId);
      includeSaved = true;
      setTimeout(() => request.abort('aborted').catch(() => {}), 150);
      return;
    }
    if (action === 'getDocuments' && failList) {
      return;
    }
    request.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify(answer(action))
    }).catch(() => {});
  });

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(base + '/admin/index.html#documents', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#doc-form', { timeout: 8000 });
  await page.select('#doc-form select[name="category"]', '其他');
  const input = await page.$('#doc-form input[type="file"]');
  await input.uploadFile(samplePath);
  await page.click('#doc-form button[type="submit"]');
  await page.waitForFunction(() => {
    const text = document.querySelector('#status').textContent || '';
    return text.includes('资料已归档') || text.includes('可能尚未保存') || text.includes('尚未确认');
  }, { timeout: 15000 });
  const saved = await page.evaluate(() => ({
    status: document.querySelector('#status').textContent,
    statusClass: document.querySelector('#status').className,
    view: document.querySelector('#view').innerText,
    marker: document.querySelector('#build-marker').textContent,
    gate: document.querySelector('#gate-note').textContent
  }));
  assertSafe(saved.status + '\n' + saved.view, 'reconciled upload');
  if (!saved.status.includes('资料已归档 FL-MWN982MJ0XXQC9')) throw new Error('saved id was not shown: ' + saved.status);
  if (!saved.status.includes('回读台账已确认，请不要再次上传')) throw new Error('read-back success was not explicit: ' + saved.status);
  if (!saved.statusClass.includes('ok')) throw new Error('reconciled upload was not a success: ' + saved.statusClass);
  if (!saved.view.includes('FL-MWN982MJ0XXQC9')) throw new Error('ledger did not list the saved id');
  if (saved.view.includes('FL-OLD') && saved.status.includes('FL-OLD')) throw new Error('matched the pre-existing row');
  if (!saved.marker.includes(BUILD) || !saved.marker.includes('正式预览') || !saved.marker.includes('非生产数据')) {
    throw new Error('identity marker changed: ' + saved.marker);
  }
  if (!saved.gate.includes('财务定稿已关闭') || !saved.gate.includes('对客正式合同生成已关闭')) {
    throw new Error('closure copy missing: ' + saved.gate);
  }
  const savedShot = await shot(page, 'ac02-preview-upload-reconciled.png');

  await page.select('#doc-form select[name="category"]', '其他');
  const inputAgain = await page.$('#doc-form input[type="file"]');
  await inputAgain.uploadFile(samplePath);
  await page.click('#doc-form button[type="submit"]');
  await page.waitForFunction(() => (document.querySelector('#status').textContent || '').includes('可能尚未保存'), { timeout: 15000 });
  const missing = await page.evaluate(() => ({
    status: document.querySelector('#status').textContent,
    button: document.querySelector('#doc-form button[type="submit"]').textContent,
    disabled: document.querySelector('#doc-form button[type="submit"]').disabled
  }));
  assertSafe(missing.status, 'missing ledger row');
  if (!missing.disabled || missing.button.indexOf('请先核对列表') < 0) {
    throw new Error('unconfirmed upload can still be submitted: ' + JSON.stringify(missing));
  }
  const missingShot = await shot(page, 'ac02-preview-upload-not-on-ledger.png');

  await page.evaluate((oldText) => {
    const el = document.getElementById('status');
    el.className = 'status show danger';
    el.textContent = oldText;
  }, '请求超时，尚未确认是否已保存。请使用同一请求号重试；已保存的登记不会重复入账。');
  failList = true;
  await page.click('#nav a[data-view="documents"]');
  await page.waitForFunction(() => {
    const view = document.querySelector('#view').innerText || '';
    return view.includes('读取超时，列表没有载入') || view.includes('尚未确认是否已保存');
  }, { timeout: 25000 });
  const listed = await page.evaluate(() => ({
    status: document.querySelector('#status').textContent,
    statusClass: document.querySelector('#status').className,
    view: document.querySelector('#view').innerText
  }));
  assertSafe(listed.status + '\n' + listed.view, 'list timeout');
  if (!listed.view.includes('读取超时，列表没有载入')) {
    throw new Error('list failure did not use the read timeout wording: ' + listed.view.slice(0, 300));
  }
  if (listed.statusClass.includes('danger') || listed.status.includes(FORBIDDEN)) {
    throw new Error('stale danger banner survived the new list load: ' + JSON.stringify(listed));
  }
  const listShot = await shot(page, 'ac02-preview-list-timeout.png');

  failList = false;
  await page.click('#nav a[data-view="finance"]');
  await page.waitForSelector('[data-tab="four"]', { timeout: 8000 });
  await page.click('[data-tab="four"]');
  await page.waitForSelector('#post-four', { timeout: 8000 });
  const finance = await page.evaluate(() => ({
    disabled: document.querySelector('#post-four').disabled,
    aria: document.querySelector('#post-four').getAttribute('aria-disabled'),
    note: document.querySelector('#post-four-note').textContent
  }));
  if (!finance.disabled || finance.aria !== 'true' || finance.note.indexOf('正式预览禁止财务定稿') < 0) {
    throw new Error('formal post was not closed: ' + JSON.stringify(finance));
  }

  await page.click('#nav a[data-view="contracts"]');
  await page.waitForFunction(() => (document.querySelector('#view').innerText || '').includes('对客正式合同生成入口已关闭'), { timeout: 8000 });
  const contracts = await page.evaluate(() => document.querySelector('#view').innerText);
  if (!contracts.includes('「生成正式合同文本」不可用')) throw new Error('official contract generation was not closed');
  if (requestIds.length < 2 || requestIds[0] === requestIds[1]) {
    throw new Error('follow-up upload reused a request id: ' + JSON.stringify(requestIds));
  }
  if (calls.filter((action) => action === 'uploadDocument').length !== 2) {
    throw new Error('unexpected upload calls: ' + JSON.stringify(calls));
  }
  if (pageErrors.length) throw new Error('page errors: ' + pageErrors.join('\n'));

  console.log(JSON.stringify({
    ok: true,
    base: base,
    requestIds: requestIds,
    savedShot: savedShot,
    missingShot: missingShot,
    listShot: listShot,
    financeClosed: finance.note,
    uploads: calls.filter((action) => action === 'uploadDocument').length
  }, null, 2));
} finally {
  await browser.close();
  server.close();
}
