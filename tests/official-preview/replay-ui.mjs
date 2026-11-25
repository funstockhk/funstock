/**
 * Browser check for the one synthetic replay control.
 * Same-origin /api is intercepted. exec.invalid is mapped to 127.0.0.1.
 * The happy path reads AC02_REPLAY_PDF and does not commit those bytes.
 */
import crypto from 'node:crypto';
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
  for (const spec of specs) {
    try { return require(spec); } catch (err) { /* try the next location */ }
  }
  throw new Error('Cannot load puppeteer-core');
}

const puppeteer = loadPuppeteer();
const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/google/chrome/chrome';
const outDir = process.env.AC02_ARTIFACT_DIR || '/opt/cursor/artifacts';
fs.mkdirSync(outDir, { recursive: true });
const rules = require(path.join(root, 'site/admin/js/rules.js'));
const REC = rules.PREVIEW_REPLAY;

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isOriginalFixture(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size === REC.size && fileSha256(file) === REC.sha256;
  } catch (err) {
    return false;
  }
}

function findOriginalFixture() {
  const seen = new Set();
  const candidates = [];
  if (process.env.AC02_REPLAY_PDF) candidates.push(process.env.AC02_REPLAY_PDF);
  const testsDir = path.join(root, 'tests');
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) walk(abs);
      else if (stat.size === REC.size) candidates.push(abs);
    }
  };
  walk(testsDir);
  for (const file of candidates) {
    const abs = path.resolve(file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (isOriginalFixture(abs)) return abs;
  }
  return '';
}

let fixtureSrc = findOriginalFixture();
let fixturePath = '';
if (fixtureSrc) {
  const stat = fs.statSync(fixtureSrc);
  const hash = fileSha256(fixtureSrc);
  if (stat.size !== REC.size || hash !== REC.sha256) throw new Error('fixture bytes do not match the replay gate');
  fixturePath = path.join(os.tmpdir(), REC.fileName);
  fs.copyFileSync(fixtureSrc, fixturePath);
}
const wrongPath = path.join(os.tmpdir(), 'ac02-not-the-replay.txt');
fs.writeFileSync(wrongPath, 'not the synthetic pdf');

const BUILD = 'ac02-preview';
let role = '顾问';
let replay = { idempotentReplay: true, id: 'ac02-preview-replay-file-001' };
const calls = [];
const uploads = [];

function mePayload() {
  return {
    user: { displayName: '本地核对', role: role, jobId: 'LOCAL-MOCK' },
    asOf: '2026-11-19',
    openingConfirmed: false,
    preview: true,
    officialContractOpen: false,
    buildId: BUILD,
    dataMode: 'ac02-preview',
    productionData: false,
    release: { buildId: BUILD, dataMode: 'ac02-preview', productionData: false }
  };
}

function parseMultipart(raw, ctype) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
  const boundary = m && (m[1] || m[2]);
  const parts = String(raw).split('--' + boundary).slice(1, -1);
  const body = { payload: {}, token: '' };
  parts.forEach((part) => {
    const splitAt = part.indexOf('\r\n\r\n');
    if (splitAt < 0) return;
    const head = part.slice(0, splitAt);
    let value = part.slice(splitAt + 4);
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    const name = /name="([^"]+)"/.exec(head);
    if (!name) return;
    if (name[1] === 'payload') body.payload = JSON.parse(value || '{}');
    else if (name[1] === 'token') body.token = value;
    else if (name[1] === 'action') body.action = value;
    else if (name[1] === 'file') {
      body.file = { name: 'upload.bin', mime: 'application/octet-stream', data: Buffer.from(value).toString('base64') };
    }
  });
  return body;
}

function answer(action) {
  if (action === 'me') return { ok: true, data: mePayload() };
  if (action === 'getDashboard') {
    return { ok: true, data: { currentYearMonth: '2026-11', warnings: [], plansThisMonth: [], contracts: [], pendingDocs: 0, picsPending: 0 } };
  }
  if (action === 'getDocuments') return { ok: true, data: { files: [], pics: [] } };
  if (action === 'uploadDocument') {
    return {
      ok: true,
      data: {
        idempotentReplay: replay.idempotentReplay,
        relatedId: 'ac02-preview-replay-rel-001',
        file: {
          id: replay.id,
          name: 'ac02-synthetic-sample.pdf',
          category: '其他',
          relatedId: 'ac02-preview-replay-rel-001',
          clientRequestId: 'ac02-preview-replay-req-001'
        }
      }
    };
  }
  return { ok: false, error: 'not used', code: 'TEST_BLOCK' };
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.endsWith('/admin/js/build.js')) {
    const overlay = [
      'window.AC02_BUILD = { buildId: "ac02-preview", dataMode: "ac02-preview", productionData: false };',
      'window.AC02_IDENTITIES = [',
      '  { buildId: "ac02-preview", dataMode: "ac02-preview", productionData: false },',
      '  { buildId: "ac02-official", dataMode: "ac02-official", productionData: false }',
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
  res.writeHead(200, { 'content-type': types[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(filePath));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--host-resolver-rules=MAP exec.invalid 127.0.0.1']
});

let openCount = 0;
async function openDocs(page) {
  calls.length = 0;
  uploads.length = 0;
  openCount += 1;
  await page.goto('http://127.0.0.1:' + server.address().port + '/admin/index.html?load=' + openCount + '#documents', { waitUntil: 'networkidle0' });
}

try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    let host = '';
    try { host = new URL(request.url()).host; } catch (e) { host = ''; }
    if ((() => { try { const u = new URL(request.url()); return u.pathname !== '/api' && u.host !== 'exec.invalid'; } catch (e) { return true; } })()) {
      request.continue().catch(() => {});
      return;
    }
    if (request.method() === 'OPTIONS') {
      request.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' } }).catch(() => {});
      return;
    }
    let action = '';
    let payload = {};
    try {
      const headers = request.headers();
      const ctype = headers['content-type'] || headers['Content-Type'] || '';
      let raw = request.postData();
      if (raw == null && typeof request.fetchPostData === 'function') {
        const buf = await request.fetchPostData();
        raw = buf ? Buffer.from(buf).toString('utf8') : '';
      }
      if (/multipart\/form-data/i.test(ctype)) {
        const parsed = parseMultipart(raw || '', ctype);
        action = parsed.action || '';
        payload = parsed.payload || {};
      } else {
        const body = JSON.parse(raw || '{}');
        action = body.action || '';
        payload = body.payload || {};
      }
    } catch (e) { action = ''; }
    calls.push(action);
    if (action === 'uploadDocument') uploads.push(payload);
    request.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify(answer(action))
    }).catch(() => {});
  });
  await page.setViewport({ width: 1280, height: 900 });
  await openDocs(page);
  await page.waitForSelector('#replay-card', { timeout: 8000 });
  const intro = await page.$eval('#replay-card', (el) => el.innerText);
  if (!intro.includes('仅正式预览') || !intro.includes('虚构') || !intro.includes('ac02-preview-replay-req-001') || !intro.includes('ac02-preview-replay-file-001')) {
    throw new Error('replay card does not name the one synthetic record: ' + intro);
  }
  const gate = await page.$eval('#gate-note', (el) => el.textContent);
  if (!gate.includes('财务定稿已关闭') || !gate.includes('对客正式合同生成已关闭')) throw new Error(gate);

  const before = uploads.length;
  await page.$('#replay-form input[type="file"]').then((el) => el.uploadFile(wrongPath));
  await page.click('#replay-form button[type="submit"]');
  await page.waitForFunction(() => (document.querySelector('#replay-result').textContent || '').includes('未向接口提交'), { timeout: 8000 });
  if (uploads.length !== before) throw new Error('rejected file still called uploadDocument');

  if (!fixturePath) throw new Error('replay fixture is missing or does not match the gate');
  {
    replay = { idempotentReplay: true, id: 'ac02-preview-replay-file-001' };
    await page.$('#replay-form input[type="file"]').then((el) => el.uploadFile(fixturePath));
    await page.click('#replay-form button[type="submit"]');
    await page.waitForFunction(() => (document.querySelector('#replay-result').textContent || '').includes('幂等重放成立'), { timeout: 8000 });
    const shown = await page.$eval('#replay-result', (el) => el.textContent);
    if (!shown.includes('fileId ac02-preview-replay-file-001') || !shown.includes('idempotentReplay true')) throw new Error(shown);
    if (uploads.length !== 1) throw new Error('expected one upload, saw ' + uploads.length);
    const sent = uploads[0];
    if (sent.clientRequestId !== 'ac02-preview-replay-req-001' || sent.category !== '其他' || sent.relatedId !== 'ac02-preview-replay-rel-001') {
      throw new Error('payload drifted: ' + JSON.stringify(sent));
    }
    if (sent.file && sent.file.name !== 'ac02-synthetic-sample.pdf') throw new Error(sent.file && sent.file.name);
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (uploads.length !== 1) throw new Error('automatic retry after success: ' + uploads.length);

    replay = { idempotentReplay: false, id: 'FL-SHOULD-NOT-ACCEPT' };
    await page.waitForFunction(() => document.querySelector('#replay-form button').disabled === false);
    await page.click('#replay-form button[type="submit"]');
    await page.waitForFunction(() => (document.querySelector('#replay-result').textContent || '').includes('幂等重放未成立'), { timeout: 8000 });
    const failed = await page.$eval('#replay-result', (el) => el.textContent);
    if (!failed.includes('fileId FL-SHOULD-NOT-ACCEPT') || !failed.includes('idempotentReplay false') || !failed.includes('没有再次提交')) {
      throw new Error(failed);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (uploads.length !== 2) throw new Error('failure path retried by itself: ' + uploads.length);
    const shot = path.join(outDir, 'ac02-preview-replay-result.png');
    await page.screenshot({ path: shot, fullPage: true });

    const sentUploads = uploads.map((item) => ({
      clientRequestId: item.clientRequestId,
      category: item.category,
      relatedId: item.relatedId
    }));
    role = '客户';
    await openDocs(page);
    await page.waitForSelector('#doc-form', { timeout: 8000 });
    const hidden = await page.$('#replay-card');
    if (hidden) throw new Error('customer can see the replay control');
    if (uploads.length !== 0) throw new Error('customer page issued an upload');

    console.log(JSON.stringify({
      ok: true,
      paths: {
        '成功重放': 'ran',
        '失败重放': 'ran',
        '客户角色隐藏': 'ran'
      },
      fixture: { path: fixtureSrc, bytes: REC.size, sha256: REC.sha256 },
      uploads: sentUploads,
      shown: shown,
      failed: failed,
      shot: shot
    }, null, 2));
  }
} finally {
  await browser.close();
  server.close();
}
