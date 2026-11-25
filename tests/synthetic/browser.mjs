import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const puppeteer = require('/tmp/puppeteer-core/node_modules/puppeteer-core');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shotDir = path.join(root, 'tests/synthetic/artifacts');
const publicDir = '/opt/cursor/artifacts';
fs.mkdirSync(shotDir, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });
const base = process.env.BASE || 'http://127.0.0.1:8765';
const results = [];
const version = 'apps-script/Code.gs + site/admin';
const password = 'synthetic-only-not-a-real-secret';

function rec(round, id, input, expected, actual, ok) {
  results.push({
    round, id, input, expected, actual, version,
    environment: 'synthetic-browser',
    backend: 'apps-script/Code.gs via tests/synthetic/server.mjs',
    status: ok ? 'pass' : 'fail'
  });
  if (!ok) console.error('FAIL', id, JSON.stringify(actual));
}

async function shot(page, name) {
  const file = path.join(shotDir, name);
  await page.screenshot({ path: file, fullPage: true });
  fs.copyFileSync(file, path.join(publicDir, name));
  return file;
}

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
await page.setViewport({ width: 1280, height: 800 });

const assetPaths = ['/admin/login.html', '/admin/index.html', '/admin/css/admin.css', '/admin/js/app.js', '/admin/js/api.js', '/admin/js/rules.js', '/admin/js/build.js', '/site/admin/js/config.js', '/favicon.svg', '/assets/logo-horizontal.svg'];
const assetStatus = {};
for (const p of assetPaths) {
  const res = await page.goto(base + p, { waitUntil: 'domcontentloaded' });
  assetStatus[p] = res.status();
}
rec('R1', 'SYN-R1-ASSETS', assetPaths, '200', assetStatus, Object.values(assetStatus).every((s) => s === 200));

const configOnDisk = fs.readFileSync(path.join(root, 'site/admin/js/config.js'), 'utf8');
rec('R1', 'SYN-R1-CONFIG-PLACEHOLDER', { file: 'site/admin/js/config.js' }, 'TODO placeholder, no live exec URL', configOnDisk.indexOf('__AC02_EXEC_URL__') >= 0 && configOnDisk.indexOf('TODO') >= 0 && configOnDisk.indexOf('script.google.com') < 0, configOnDisk.indexOf('__AC02_EXEC_URL__') >= 0 && configOnDisk.indexOf('TODO') >= 0 && configOnDisk.indexOf('script.google.com') < 0);

await page.goto(base + '/admin/login.html', { waitUntil: 'networkidle0' });
const loginLeak = await page.evaluate(() => document.body.innerText.indexOf('__AC02_SPREADSHEET_ID__') >= 0 || document.body.innerText.indexOf('__AC02_DRIVE_ROOT__') >= 0);
rec('R1', 'SYN-R1-LOGIN-NO-TARGET-IDS', { page: 'login' }, 'ids absent before auth', loginLeak, loginLeak === false);
const home = await page.$eval('a.login-home', (a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') }));
const foot = await page.$eval('.login-foot', (el) => el.innerText);
const hart = await page.evaluate(() => document.body.innerText.toLowerCase().indexOf('harthelm') >= 0);
const keys = await page.evaluate(async () => {
  const home = document.querySelector('.login-home');
  home.focus();
  const order = [document.activeElement.id || document.activeElement.className];
  for (let i = 0; i < 3; i++) {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  }
  const tabbed = [];
  home.focus();
  const seq = [home];
  let node = home;
  for (let i = 0; i < 3; i++) {
    const all = Array.from(document.querySelectorAll('a, button, input'));
    const idx = all.indexOf(node);
    node = all[idx + 1];
    tabbed.push(node && (node.id || node.className));
  }
  return tabbed;
});
const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
rec('R1', 'SYN-R1-LOGIN-HOME', {}, '返回公司主页 -> ../index.html', home, home.text === '返回公司主页' && home.href === '../index.html');
rec('R1', 'SYN-R1-LOGIN-FOOTER', {}, 'Funstock name, mailto, copyright', foot, foot.indexOf('趣倉有限公司') >= 0 && foot.indexOf('FUNSTOCK LIMITED') >= 0 && foot.indexOf('Funstockhk@gmail.com') >= 0 && foot.indexOf('©2026 FUNSTOCK LIMITED. 保留所有權利。') >= 0 && hart === false);
rec('R1', 'SYN-R1-LOGIN-KEYS', { from: '返回公司主页' }, ['jobId', 'password', 'go'], keys, JSON.stringify(keys) === JSON.stringify(['jobId', 'password', 'go']));
rec('R1', 'SYN-R1-LOGIN-NO-OVERFLOW', { viewport: '1280' }, true, desktopOverflow, desktopOverflow === true);
await shot(page, 'r1-login-desktop.png');
await page.setViewport({ width: 390, height: 844 });
const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
await shot(page, 'r1-login-mobile.png');
rec('R1', 'SYN-R1-LOGIN-MOBILE', { viewport: '390' }, 'no overflow', mobileOverflow, mobileOverflow === true);
await page.setViewport({ width: 1280, height: 800 });

await fetch(base + '/__test/delay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 600 }) });
await page.type('#jobId', 'AC02-SYN-ADVISOR');
await page.type('#password', 'wrong-password');
await page.click('#go');
await page.waitForFunction(() => document.querySelector('#go').textContent.indexOf('正在登录') >= 0);
rec('R1', 'SYN-R1-LOGIN-LOADING', {}, '正在登录', '正在登录', true);
await page.waitForFunction(() => document.querySelector('#err').classList.contains('show'));
await fetch(base + '/__test/delay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const errText = await page.$eval('#err', (el) => el.textContent);
rec('R1', 'SYN-R1-UI-BAD-LOGIN', { password: 'wrong-password' }, 'visible rejection', errText, /拒绝|不正确/.test(errText));

await page.click('#password', { clickCount: 3 });
await page.type('#password', password);
await page.click('#go');
await page.waitForFunction(() => location.pathname.indexOf('/admin') >= 0 && !location.pathname.endsWith('login.html'));
await page.waitForFunction(() => document.querySelector('#who') && document.querySelector('#who').textContent.indexOf('顾问') >= 0);
const gate = await page.$eval('#gate-note', (el) => el.textContent);
rec('R1', 'SYN-R1-GATE-VISIBLE', {}, '期初待确认', gate, gate.indexOf('期初待确认') >= 0 && gate.indexOf('禁止正式记账') >= 0);
const buildText = await page.$eval('#build-marker', (el) => el.textContent);
rec('R1', 'SYN-R1-BUILD-MARKER', {}, 'ac02-preview non-production', buildText, buildText.indexOf('ac02-preview') >= 0 && buildText.indexOf('非生产') >= 0);
const observed = await page.evaluate(async () => {
  const me = await FS.api('me');
  const shown = document.querySelector('#target-marker').textContent;
  const release = me.release || {};
  return {
    state: document.querySelector('#target-marker').dataset.state,
    shown,
    sheet: release.spreadsheetId || '',
    drive: release.driveRootId || '',
    calls: 'me only'
  };
});
rec('R1', 'SYN-R1-TARGETS-FROM-ME', { source: 'me.release' }, 'DOM echoes response ids', observed, observed.state === 'observed' && observed.sheet && observed.drive && observed.shown.indexOf(observed.sheet) >= 0 && observed.shown.indexOf(observed.drive) >= 0 && observed.shown.indexOf('本次 me.release') >= 0);
await shot(page, 'r1-targets-desktop.png');
await shot(page, 'r1-dashboard-desktop.png');

const views = ['plans', 'proposals', 'documents', 'finance', 'contracts', 'logs', 'dashboard'];
const titles = [];
for (const view of views) {
  await page.click('#nav a[data-view="' + view + '"]');
  await page.waitForFunction((expected) => location.hash.indexOf(expected) >= 0 || (expected === 'dashboard' && (location.hash === '' || location.hash === '#dashboard')), {}, view);
  await page.waitForFunction(() => !document.querySelector('#view').textContent.includes('正在读取'));
  titles.push(await page.$eval('#title', (el) => el.textContent));
}
rec('R1', 'SYN-R1-NAV', { views }, 'each module title', titles, titles.length === 7 && titles.indexOf('操作日志') >= 0 && titles.indexOf('月账与四套账') >= 0);

await page.setViewport({ width: 390, height: 844 });
await page.click('#nav a[data-view="dashboard"]');
await page.waitForFunction(() => document.querySelector('#target-marker') && document.querySelector('#target-marker').dataset.state === 'observed');
const mobileOverflowTargets = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
await shot(page, 'r1-targets-mobile.png');
const mobileGate = await page.$eval('#gate-note', (el) => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0);
await shot(page, 'r1-dashboard-mobile.png');
rec('R1', 'SYN-R1-MOBILE-GATE', { viewport: '390x844' }, 'gate note visible', mobileGate, mobileGate === true && mobileOverflowTargets === true);

await page.setViewport({ width: 1280, height: 800 });
await page.evaluate(() => sessionStorage.clear());
await page.goto(base + '/admin/index.html', { waitUntil: 'networkidle0' });
rec('R1', 'SYN-R1-UI-REDIRECT', {}, 'login.html', page.url(), page.url().indexOf('login.html') >= 0);

await page.type('#jobId', 'AC02-SYN-ADVISOR');
await page.type('#password', password);
await page.click('#go');
await page.waitForFunction(() => document.querySelector('#who') && document.querySelector('#who').textContent.indexOf('顾问') >= 0);
await page.click('#nav a[data-view="contracts"]');
await page.waitForFunction(() => document.querySelector('#view') && document.querySelector('#view').textContent.indexOf('不是订单') >= 0);
const orderGap = await page.$eval('#view', (el) => el.textContent);
rec('R3', 'SYN-R3-UI-ORDER-GAP', {}, '合同不是订单', orderGap.indexOf('不是订单') >= 0, orderGap.indexOf('不是订单') >= 0 && orderGap.indexOf('模拟/草稿 非正式凭证') >= 0);
await shot(page, 'r3-contracts-order-gap.png');

await fetch(base + '/__test/delay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ savePlan: 700 }) });
await page.click('#nav a[data-view="plans"]');
await page.waitForSelector('#plan-form');
await page.type('#plan-form input[name="yearMonth"]', '2026-11');
await page.type('#plan-form input[name="title"]', 'SYN_UI_PLAN');
await page.evaluate(() => {
  const btn = document.querySelector('#plan-form button[type="submit"]');
  btn.click();
  btn.click();
});
await page.waitForFunction(() => {
  const status = document.querySelector('#status');
  return status && status.textContent.indexOf('计划已保存') >= 0;
}, { timeout: 8000 });
const planRows = await page.$$eval('#view tr', (rows) => rows.map((r) => r.textContent).filter((t) => t.indexOf('SYN_UI_PLAN') >= 0).length);
const busyText = await page.$eval('#status', (el) => el.textContent);
rec('R2', 'SYN-R2-UI-PLAN-ONCE', { clicks: 2, title: 'SYN_UI_PLAN' }, 'one row and success', { planRows, busyText }, planRows === 1 && busyText.indexOf('计划已保存') >= 0);
await shot(page, 'r2-plan-saved.png');

const timeoutCode = await page.evaluate(async () => {
  try {
    await FS.api('getLogs', { __delayMs: 1200, __timeoutMs: 300 });
    return 'NO_TIMEOUT';
  } catch (err) {
    return err.code || err.message;
  }
});
rec('R2', 'SYN-R2-UI-TIMEOUT', { timeoutMs: 300, delayMs: 1200 }, 'TIMEOUT', timeoutCode, timeoutCode === 'TIMEOUT');

await fetch(base + '/__test/delay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ getMonth: 900 }) });
await page.evaluate(() => { location.hash = '#finance'; });
await page.click('#nav a[data-view="logs"]');
await page.waitForFunction(() => document.querySelector('#view') && document.querySelector('#view').textContent.indexOf('最近操作') >= 0, { timeout: 8000 });
await new Promise((r) => setTimeout(r, 1200));
const afterRace = await page.$eval('#view', (el) => el.textContent);
rec('R2', 'SYN-R2-STALE-RENDER', { delayed: 'getMonth', then: 'logs' }, 'logs remain', afterRace.indexOf('最近操作') >= 0 && afterRace.indexOf('登记现金或第三方') < 0, afterRace.indexOf('最近操作') >= 0 && afterRace.indexOf('登记现金或第三方') < 0);
await fetch(base + '/__test/delay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

await page.click('#nav a[data-view="finance"]');
await page.waitForFunction(() => document.querySelector('#view') && document.querySelector('#view').textContent.indexOf('四套账') >= 0);
await page.click('#view button[data-tab="four"]');
await page.waitForSelector('#post-four');
const postDisabled = await page.$eval('#post-four', (el) => el.disabled);
const exportDisabled = await page.$eval('#export-four', (el) => el.disabled);
const postHint = await page.$eval('#view', (el) => el.textContent);
await page.click('#post-four');
const postStatus = await page.$eval('#status', (el) => el.textContent);
rec('R4', 'SYN-R4-UI-POST-DISABLED', { openingConfirmed: false }, 'disabled and not submitted', { postDisabled, exportDisabled, postStatus }, postDisabled === true && exportDisabled === true && /期初|禁止|未生成|不能定稿/.test(postHint + postStatus));
await shot(page, 'r4-finance-post-locked.png');

await page.click('#view button[data-tab="completion"]');
await page.waitForSelector('#confirm-done');
const confirmDisabled = await page.$eval('#confirm-done', (el) => el.disabled);
rec('R4', 'SYN-R4-UI-CONFIRM-DISABLED', {}, 'disabled before ledger', confirmDisabled, confirmDisabled === true);
await shot(page, 'r4-completion-locked.png');

rec('R1', 'SYN-R1-CONSOLE', {}, 'no pageerror', errors, errors.length === 0);

const out = {
  version,
  environment: 'synthetic-browser http://127.0.0.1:8765',
  passed: results.filter((r) => r.status === 'pass').length,
  failed: results.filter((r) => r.status === 'fail').length,
  results
};
fs.writeFileSync(path.join(root, 'tests/synthetic/results/browser-rounds.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ passed: out.passed, failed: out.failed, errors }));
await browser.close();
process.exit(out.failed ? 1 : 0);
