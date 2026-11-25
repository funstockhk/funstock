/**
 * Local render of the admin preview. Mocks `me` in the browser.
 * Same-origin /api and exec.invalid are answered locally and are never continued.
 * exec.invalid is mapped to 127.0.0.1 so a missed intercept cannot leave the machine.
 * Browser and output paths come from the environment, then from common install locations.
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
  const specifiers = [];
  if (process.env.PUPPETEER_MODULE) specifiers.push(process.env.PUPPETEER_MODULE);
  specifiers.push('puppeteer-core', 'puppeteer');
  const cached = path.join(os.tmpdir(), 'puppeteer-core', 'node_modules', 'puppeteer-core');
  if (fs.existsSync(path.join(cached, 'package.json'))) specifiers.push(cached);
  const failures = [];
  for (const spec of specifiers) {
    try { return require(spec); } catch (err) { failures.push(spec + ': ' + err.message); }
  }
  throw new Error('Cannot load puppeteer-core. Set PUPPETEER_MODULE. Tried ' + failures.join(' | '));
}

function resolveChrome() {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) throw new Error('Browser executable not found: ' + fromEnv);
    return fromEnv;
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const dirs = [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/opt/google/chrome'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Chrome not found. Set PUPPETEER_EXECUTABLE_PATH.');
}

function resolveOutDirs() {
  const dirs = [];
  dirs.push(process.env.AC02_ARTIFACT_DIR || path.join(os.tmpdir(), 'ac02-preview-artifacts'));
  const review = process.env.AC02_REVIEW_ARTIFACT_DIR;
  if (review) dirs.push(review);
  else if (fs.existsSync('/opt/cursor/artifacts')) dirs.push('/opt/cursor/artifacts');
  const unique = [];
  for (const dir of dirs) {
    const abs = path.resolve(dir);
    if (!unique.includes(abs)) unique.push(abs);
    fs.mkdirSync(abs, { recursive: true });
  }
  return unique;
}

const puppeteer = loadPuppeteer();
const chromePath = resolveChrome();
const outDirs = resolveOutDirs();

const BUILD = 'ac02-preview';
const MODE = 'ac02-preview';
const calls = [];
const errors = [];
let mode = 'match';

function mePayload() {
  const base = {
    user: { displayName: '本地核对', role: '顾问', jobId: 'LOCAL-MOCK' },
    asOf: '2026-11-19',
    openingConfirmed: false,
    preview: true,
    officialContractOpen: false,
    buildId: BUILD,
    dataMode: MODE,
    productionData: false,
    release: {
      buildId: BUILD,
      dataMode: MODE,
      productionData: false,
      spreadsheetId: 'LOCAL-MOCK-SHEET',
      driveRootId: 'LOCAL-MOCK-DRIVE'
    }
  };
  if (mode === 'production') {
    base.productionData = true;
    base.dataMode = 'production';
    base.release.productionData = true;
    base.release.dataMode = 'production';
  }
  if (mode === 'old') {
    base.buildId = 'retired-preview-build';
    base.dataMode = 'simulated-test';
    base.release.buildId = base.buildId;
    base.release.dataMode = base.dataMode;
  }
  if (mode === 'finance-ready') base.openingConfirmed = true;
  return base;
}

function readyMonth() {
  return {
    ok: true,
    data: {
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
        statements: []
      },
      groups: { '未处理': [], '已附原件': [], '免原件': [], '暂记往来': [] },
      lines: [],
      files: [],
      four: [],
      rejectedCash: []
    }
  };
}

function answer(action) {
  if (action === 'me') return { ok: true, data: mePayload() };
  if (mode === 'production' || mode === 'old') {
    return { ok: false, error: 'rejected identity must not read business data', code: 'TEST_BLOCK' };
  }
  if (action === 'getDashboard') {
    return {
      ok: true,
      data: {
        currentYearMonth: '2026-11',
        asOf: '2026-11-19',
        warnings: [],
        plansThisMonth: [],
        month: null,
        pendingDocs: 0,
        picsPending: 0,
        contracts: [],
        openingConfirmed: mode === 'finance-ready'
      }
    };
  }
  if (mode === 'finance-ready' && action === 'getMonth') return readyMonth();
  if (mode === 'finance-ready' && action === 'getContracts') {
    return { ok: true, data: { contracts: [], invoices: [], files: [] } };
  }
  return { ok: false, error: 'this local render does not perform ' + action, code: 'TEST_BLOCK' };
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
};

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
  const primary = path.join(outDirs[0], name);
  await page.screenshot({ path: primary, fullPage: true });
  for (const dir of outDirs.slice(1)) fs.copyFileSync(primary, path.join(dir, name));
  return outDirs.length > 1 ? path.join(outDirs[outDirs.length - 1], name) : primary;
}

async function openShell(page, nextMode) {
  mode = nextMode;
  calls.length = 0;
  await page.goto(base + '/admin/index.html', { waitUntil: 'networkidle0' });
  try {
    await page.waitForFunction(() => {
      const marker = document.querySelector('#build-marker');
      return marker && marker.textContent.indexOf('登录后与接口核对') < 0;
    }, { timeout: 8000 });
  } catch (err) {
    const state = await page.evaluate(() => ({
      url: location.href,
      text: document.body ? document.body.innerText.slice(0, 500) : ''
    })).catch(() => ({}));
    throw new Error('shell did not settle ' + JSON.stringify({ mode, calls, errors, state }));
  }
}

const summary = { base, shots: [], calls: [], blockedHosts: [] };

try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    let host = '';
    try { host = new URL(url).host; } catch (e) { host = ''; }
    if ((() => { try { const u = new URL(url); return u.pathname === '/api' || u.host === 'exec.invalid'; } catch (e) { return false; } })()) {
      let action = '';
      try { action = JSON.parse(request.postData() || '{}').action || ''; } catch (e) { action = ''; }
      calls.push({ host, method: request.method(), action, intercepted: true });
      request.respond({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(answer(action))
      });
      return;
    }
    request.continue();
  });

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(base + '/admin/login.html', { waitUntil: 'networkidle0' });
  const loginText = await page.evaluate(() => document.body.innerText);
  if (!loginText.includes('授权失败即拒绝，不会放宽鉴权。') || !loginText.includes('授权表缺失或为空时不会放行。') || loginText.includes('正在确认身份…')) {
    throw new Error('login page no longer states the authentication boundary');
  }
  summary.shots.push(await shot(page, 'ac02-preview-login-desktop.png'));
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  if (!desktopOverflow) throw new Error('login desktop overflow');

  await page.setViewport({ width: 390, height: 844 });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  summary.shots.push(await shot(page, 'ac02-preview-login-mobile.png'));
  if (!mobileOverflow) throw new Error('login mobile overflow');

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(base + '/admin/login.html?err=auth_store', { waitUntil: 'networkidle0' });
  const authStore = await page.$eval('#err', (el) => ({ show: el.classList.contains('show'), text: el.textContent }));
  if (!authStore.show || authStore.text.indexOf('授权用户表缺失或不可用') < 0) {
    throw new Error('auth store rejection is not visible: ' + JSON.stringify(authStore));
  }
  summary.shots.push(await shot(page, 'ac02-preview-login-auth-store.png'));
  if (calls.length !== 0) throw new Error('login render issued an API call: ' + JSON.stringify(calls));

  await openShell(page, 'match');
  const matched = await page.evaluate(() => ({
    status: document.querySelector('#status').textContent,
    statusClass: document.querySelector('#status').className,
    marker: document.querySelector('#build-marker').textContent,
    gate: document.querySelector('#gate-note').textContent,
    banner: document.querySelector('.preview-banner').innerText,
    who: document.querySelector('#who').textContent,
    view: document.querySelector('#view').innerText
  }));
  if (matched.statusClass.includes('danger')) throw new Error('matching identity showed a mismatch: ' + JSON.stringify(matched));
  if (!matched.marker.includes(BUILD) || !matched.marker.includes(MODE) || !matched.marker.includes('正式预览')) {
    throw new Error('marker did not accept the official preview: ' + matched.marker);
  }
  if (!matched.banner.includes('不是真实运营') || !matched.gate.includes('不是真实运营') || !matched.gate.includes('财务定稿已关闭')) {
    throw new Error('shell lost the preview or formal-post closure: ' + matched.gate);
  }
  if (!matched.view.includes('内部看板')) throw new Error('matched shell did not render the local dashboard');
  summary.shots.push(await shot(page, 'ac02-preview-shell-match.png'));
  const matchCalls = calls.map((c) => c.action);
  if (JSON.stringify(matchCalls) !== JSON.stringify(['me', 'getDashboard'])) {
    throw new Error('match render called unexpected actions: ' + JSON.stringify(calls));
  }

  await openShell(page, 'production');
  const produced = await page.evaluate(() => ({
    status: document.querySelector('#status').textContent,
    marker: document.querySelector('#build-marker').textContent,
    view: document.querySelector('#view').innerText,
    who: document.querySelector('#who').textContent
  }));
  if (!produced.status.includes('已拒绝') || !produced.view.includes('已拒绝')) {
    throw new Error('production identity was not rejected: ' + JSON.stringify(produced));
  }
  if (produced.who.trim()) throw new Error('production identity was allowed into the shell');
  await page.click('#nav a[data-view="plans"]');
  await page.waitForFunction(() => document.querySelector('#view').innerText.includes('已拒绝'));
  summary.shots.push(await shot(page, 'ac02-preview-shell-production-rejected.png'));
  if (calls.map((c) => c.action).some((action) => action && action !== 'me')) {
    throw new Error('production rejection continued into a business call: ' + JSON.stringify(calls));
  }

  await openShell(page, 'old');
  const old = await page.evaluate(() => ({
    status: document.querySelector('#status').textContent,
    marker: document.querySelector('#build-marker').textContent,
    view: document.querySelector('#view').innerText
  }));
  if (!old.status.includes('已拒绝') || !old.marker.includes('retired-preview-build') || !old.marker.includes('已拒绝')) {
    throw new Error('old build was not rejected: ' + JSON.stringify(old));
  }
  if (!old.view.includes('已拒绝') || old.view.includes('内部看板')) {
    throw new Error('old build still rendered business data');
  }
  summary.shots.push(await shot(page, 'ac02-preview-shell-old-build-rejected.png'));
  if (calls.map((c) => c.action).some((action) => action && action !== 'me')) {
    throw new Error('old build continued into a business call: ' + JSON.stringify(calls));
  }

  await openShell(page, 'finance-ready');
  await page.click('#nav a[data-view="finance"]');
  await page.waitForSelector('[data-tab="four"]');
  await page.click('[data-tab="four"]');
  await page.waitForSelector('#post-four');
  const postUi = await page.$eval('#post-four', (btn) => ({
    disabled: btn.disabled,
    aria: btn.getAttribute('aria-disabled'),
    note: document.querySelector('#post-four-note').textContent
  }));
  if (!postUi.disabled || postUi.aria !== 'true' || !postUi.note.includes('正式预览禁止财务定稿')) {
    throw new Error('formal post control was enabled: ' + JSON.stringify(postUi));
  }
  await page.$eval('#post-four', (btn) => {
    btn.disabled = false;
    btn.removeAttribute('disabled');
    btn.setAttribute('aria-disabled', 'false');
    btn.click();
  });
  await page.waitForFunction(() => {
    const status = document.querySelector('#status');
    return status && status.className.includes('danger') && status.textContent.includes('正式预览禁止财务定稿');
  });
  const forced = await page.$eval('#post-four', (btn) => btn.disabled);
  if (!forced) throw new Error('handler left the formal-post button enabled');
  if (calls.some((call) => call.action === 'postFourStatements')) {
    throw new Error('preview issued postFourStatements: ' + JSON.stringify(calls));
  }
  summary.shots.push(await shot(page, 'ac02-preview-formal-post-closed.png'));

  await page.click('#nav a[data-view="contracts"]');
  await page.waitForFunction(() => {
    const text = document.querySelector('#view').innerText;
    return text.includes('对客正式合同生成入口已关闭') && text.includes('生成正式合同文本') && text.includes('不可用');
  });
  if (calls.some((call) => call.action === 'generateOfficialContract' || call.action === 'postFourStatements')) {
    throw new Error('preview issued a closed write: ' + JSON.stringify(calls));
  }
  summary.shots.push(await shot(page, 'ac02-preview-contract-closed.png'));

  summary.runtime = { chrome: chromePath, outDirs };
  summary.calls = calls.slice();
  summary.ok = true;
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
