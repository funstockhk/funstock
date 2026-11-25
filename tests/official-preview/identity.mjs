/**
 * Offline contract check for the official-preview admin page.
 * No network. Does not log in, and does not call the live exec.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = 'ac02-preview';
const MODE = 'ac02-preview';
const OLD_BUILD = 'retired-preview-build';
const CACHE = '?v=ac02-admin-20261125r2';
const LOGIN_CACHE = '?v=ac02-admin-20261125r2';
const OFFICIAL_BUILD = 'ac02-official';
const OFFICIAL_MODE = 'ac02-official';

const rules = require(path.join(root, 'site/admin/js/rules.js'));
const expected = { buildId: BUILD, dataMode: MODE, productionData: false };

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assertApprovedAdminFiles() {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'site/admin/js/build.js'))).digest('hex'), '7a00612f09070faae8c493164c0c6c5f944c12df7eea274b386986bce76c94e1');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'site/admin/js/config.js'))).digest('hex'), '351dfaa1f76eb459cddb27296a55f9259f8bbc374a33a25660ffbc6953f1b7cf');
  const configText = read('site/admin/js/config.js');
  assert.equal(configText.includes('http'), false);
  assert.equal(configText.includes('script.google'), false);
  assert.equal(configText.includes('/exec'), false);
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(read('site/admin/js/build.js'), sandbox, { filename: 'site/admin/js/build.js' });
  assert.equal(sandbox.window.AC02_BUILD.productionData, false);
  const identities = sandbox.window.AC02_IDENTITIES;
  assert.equal(Array.isArray(identities) && identities.length, 2);
  identities.forEach((item) => assert.equal(item.productionData, false));
}

function loadBuild() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(read('site/admin/js/build.js'), sandbox, { filename: 'site/admin/js/build.js' });
  return sandbox.window.AC02_BUILD;
}
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'site/admin/js/build.js'))).digest('hex'), '7a00612f09070faae8c493164c0c6c5f944c12df7eea274b386986bce76c94e1');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'site/admin/js/config.js'))).digest('hex'), '351dfaa1f76eb459cddb27296a55f9259f8bbc374a33a25660ffbc6953f1b7cf');
assert.equal(read('site/admin/js/config.js').includes('http'), false);
assert.equal(read('site/admin/js/config.js').includes('script.google'), false);
assert.equal(read('site/admin/js/config.js').includes('/exec'), false);
assert.equal(loadBuild().productionData, false);
{
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(read('site/admin/js/build.js'), sandbox, { filename: 'site/admin/js/build.js' });
  const identities = sandbox.window.AC02_IDENTITIES;
  assert.equal(Array.isArray(identities) && identities.length, 2);
  identities.forEach((item) => assert.equal(item.productionData, false));
}

function matchPayload(extra) {
  const data = {
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
  return Object.assign(data, extra || {});
}

function decision(data, page) {
  return rules.identityDecision(data, page || expected);
}

function assertReject(name, data, page, reason) {
  const out = decision(data, page);
  assert.equal(out.ok, false, name + ' should reject, got ' + JSON.stringify(out));
  if (reason) assert.ok(out.reasons.includes(reason), name + ' reasons ' + out.reasons.join(','));
}

const matched = decision(matchPayload());
assert.equal(matched.ok, true, JSON.stringify(matched));
assert.deepEqual(matched.reasons, []);
assert.equal(matched.profile, 'preview');

function officialPayload(extra) {
  return matchPayload(Object.assign({
    buildId: OFFICIAL_BUILD,
    dataMode: OFFICIAL_MODE,
    productionData: false,
    release: {
      buildId: OFFICIAL_BUILD,
      dataMode: OFFICIAL_MODE,
      productionData: false,
      spreadsheetId: 'LOCAL-MOCK-SHEET',
      driveRootId: 'LOCAL-MOCK-DRIVE'
    }
  }, extra || {}));
}
const official = decision(officialPayload());
assert.equal(official.ok, true, JSON.stringify(official));
assert.equal(official.profile, 'official');
assert.equal(decision(officialPayload(), {
  buildId: OFFICIAL_BUILD,
  dataMode: OFFICIAL_MODE,
  productionData: false
}).ok, true);

const mixes = [
  ['preview build, official mode, preview flag', BUILD, OFFICIAL_MODE, false, 'dataMode'],
  ['preview build, preview mode, official flag', BUILD, MODE, true, 'productionData'],
  ['official build, preview mode, official flag', OFFICIAL_BUILD, MODE, true, 'dataMode'],
  ['official build, official mode, production flag', OFFICIAL_BUILD, OFFICIAL_MODE, true, 'productionData']
];
for (const mix of mixes) {
  const body = matchPayload({
    buildId: mix[1],
    dataMode: mix[2],
    productionData: mix[3],
    release: { buildId: mix[1], dataMode: mix[2], productionData: mix[3] }
  });
  assertReject(mix[0], body, null, mix[4]);
}
assertReject('top preview release official', matchPayload({
  release: { buildId: OFFICIAL_BUILD, dataMode: OFFICIAL_MODE, productionData: false }
}), null, 'release.buildId');
assertReject('top official release preview', officialPayload({
  release: { buildId: BUILD, dataMode: MODE, productionData: false }
}), null, 'release.buildId');

const withoutRelease = matchPayload();
delete withoutRelease.release;
assertReject('missing release object', withoutRelease, null, 'release-missing');
assert.equal(decision(withoutRelease).reasons.includes('release.buildId-missing'), false);

const releaseIdsOnly = matchPayload();
releaseIdsOnly.release = { spreadsheetId: 'LOCAL-MOCK-SHEET', driveRootId: 'LOCAL-MOCK-DRIVE' };
const idsOnly = decision(releaseIdsOnly);
assert.equal(idsOnly.ok, false, 'release spreadsheet ids alone must not pass');
for (const reason of ['release.buildId-missing', 'release.dataMode-missing', 'release.productionData-missing']) {
  assert.ok(idsOnly.reasons.includes(reason), reason + ' in ' + idsOnly.reasons.join(','));
}
assert.equal(idsOnly.reasons.includes('release.buildId'), false);

assertReject('retired simulated-test', matchPayload({
  buildId: OLD_BUILD,
  dataMode: 'simulated-test',
  release: { buildId: OLD_BUILD, dataMode: 'simulated-test', productionData: false }
}), null, 'buildId');

assertReject('wrong build', matchPayload({ buildId: 'ac02-preview-not-approved' }), null, 'buildId');
assertReject('production mode', matchPayload({
  dataMode: 'production',
  release: { buildId: BUILD, dataMode: 'production', productionData: false }
}), null, 'production-mode');
assertReject('production data', matchPayload({
  productionData: true,
  release: { buildId: BUILD, dataMode: MODE, productionData: true }
}), null, 'production-data');
assertReject('string false', matchPayload({ productionData: 'false' }), null, 'productionData');
assertReject('missing production flag', matchPayload({ productionData: null }), null, 'productionData');
assert.equal(decision(matchPayload({ productionData: null })).reasons.includes('productionData-missing'), false);
assert.equal(decision(matchPayload({ buildId: '' })).reasons.includes('buildId-missing'), false);
assert.ok(decision(matchPayload({ buildId: '' })).reasons.includes('buildId'));
assertReject('missing payload', null, null, 'missing');
assertReject('split release build', matchPayload({
  release: { buildId: OLD_BUILD, dataMode: MODE, productionData: false }
}), null, 'release.buildId');
assertReject('page still on simulated-test', matchPayload(), {
  buildId: OLD_BUILD,
  dataMode: 'simulated-test',
  productionData: false
}, 'page-build');
assertReject('page expects production', matchPayload(), {
  buildId: BUILD,
  dataMode: MODE,
  productionData: true
}, 'page-productionData');

assert.deepEqual(JSON.parse(JSON.stringify(expected)), { buildId: BUILD, dataMode: MODE, productionData: false });
assert.equal(CACHE, '?v=ac02-admin-20261125r2');
assert.equal(LOGIN_CACHE, CACHE);
assertApprovedAdminFiles();
assert.ok(read('site/admin/js/build.js').includes('window.AC02_BUILD'));
assert.ok(read('site/admin/js/build.js').includes('window.AC02_IDENTITIES'));
assertApprovedAdminFiles();
assert.ok(read('site/admin/js/rules.js').includes("buildId: '" + OFFICIAL_BUILD + "'"));
assert.ok(read('site/admin/js/rules.js').includes("{ name: 'official', buildId: 'ac02-official', dataMode: 'ac02-official', productionData: false }"));
assert.equal(read('site/admin/js/rules.js').includes('productionData: true'), false);
assert.ok(read('site/admin/js/rules.js').includes('productionData: false'));
assert.ok(read('site/admin/js/app.js').includes("decision.profile === 'official'"));
assert.ok(read('site/admin/js/app.js').includes('正式数据'));
assert.equal(read('site/admin/index.html').includes(BUILD), false);
assert.ok(read('site/admin/index.html').includes('登录后与接口核对。'));
assert.equal(read('site/admin/index.html').includes('?v=' + BUILD + '"'), false);

const config = read('site/admin/js/config.js');
assertApprovedAdminFiles();
assertApprovedAdminFiles();
assert.ok(config.includes('window.FS_API_BASE'));
assert.equal(config.includes('script.google.com'), false);
assert.equal(config.includes('https://'), false);

const adminFiles = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) walk(abs);
    else adminFiles.push(abs);
  }
}
walk(path.join(root, 'site/admin'));
const execHits = [];
for (const abs of adminFiles) {
  const text = fs.readFileSync(abs, 'utf8');
  const previousClient = new RegExp(['AC', '01'].join('') + '|' + ['ac', '01'].join('') + '|' + ['天', '鼎'].join('') + '|' + ['tian', 'ding'].join(''), 'i');
  if (text.includes(OLD_BUILD) || text.includes('simulated-test') || text.includes('script.google.com') || text.includes('https://') || previousClient.test(text)) {
    execHits.push(path.relative(root, abs));
  }
}
assert.deepEqual(execHits, [], 'admin frontend must stay on the AC02 placeholder and the AC02 copy');

const indexHtml = read('site/admin/index.html');
assert.ok(indexHtml.includes('正在确认身份…'));
assert.equal(indexHtml.includes('正式预览'), false);
assert.equal(indexHtml.includes('ac02-preview'), false);
const loginHtml = read('site/admin/login.html');
assert.equal(loginHtml.includes('正在确认身份…'), false);
assert.equal(loginHtml.includes('正式预览'), false);
assert.ok(loginHtml.includes('趣倉有限公司管理后台登录。授权人与顾问共用同一入口。鉴权失败即拒绝；授权表缺失或为空时不会放行。'));
assert.ok(loginHtml.includes('请使用分配的账号登录。授权失败即拒绝，不会放宽鉴权。'));
assert.ok(loginHtml.includes('请使用分配的账号登录。请勿在页面或聊天中保存口令。'));
for (const rel of ['site/admin/index.html']) {
  const html = read(rel);
  const refs = [...html.matchAll(/\b(?:src|href)="([^"]+\.(?:js|css)[^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, rel + ' should reference assets');
  for (const ref of refs) {
    assert.ok(ref.endsWith(CACHE), rel + ' asset is not cache-busted: ' + ref);
    assert.equal(ref.includes(OLD_BUILD), false, ref);
  }
}
for (const ref of [...loginHtml.matchAll(/\b(?:src|href)="([^"]+\.(?:js|css)[^"]*)"/g)].map((m) => m[1])) {
  assert.ok(ref.endsWith(LOGIN_CACHE), 'login asset cache must stay: ' + ref);
}

const app = read('site/admin/js/app.js');
assert.ok(app.includes('Rules.identityDecision(data, window.AC02_BUILD || {})'));
assert.ok(app.includes('if (!decision.ok)'));
assert.ok(app.includes("releaseState !== 'accepted'"));
assert.equal(app.includes('if (!releaseAccepted)'), false);
assert.equal(app.includes('simulated-test'), false);
assert.equal(app.includes(OLD_BUILD), false);
assert.ok(app.includes('对客正式合同生成已关闭'));
assert.ok(app.includes('模拟/草稿 非正式凭证'));
assert.equal(/api\(\s*['"]postFourStatements['"]/.test(app), false);
assert.equal(/api\(\s*['"]generateOfficialContract['"]/.test(app), false);
assert.ok(app.includes('previewFormalPostClosed(undefined, identityProfile)'));
assert.ok(app.includes('正式预览不提供财务定稿。'));
assert.ok(app.includes('确认后仍不能定稿。正式预览不写入正式四套账。'));
assert.ok(app.includes('本版本未开放财务定稿。'));
assert.ok(app.includes('确认后仍不能定稿，本版本不写入正式四套账。'));
assert.ok(read('site/admin/js/rules.js').includes('本版本未开放财务定稿。期初、配平、完成页和未处理项即使全部满足，也不会写入正式四套账。'));
assert.ok(app.includes('id="post-four" type="button" disabled aria-disabled="true"'));
assert.equal(app.includes('此按钮会请求接口写入正式四套账'), false);
assert.equal(app.includes('接口已接受正式定稿'), false);
const readyBooks = {
  openingConfirmed: true,
  ledgerGenerated: true,
  bankBalanced: true,
  completionConfirmed: true,
  unfinished: 0
};
assert.equal(rules.formalPostDecision(readyBooks).allowed, true, 'book prerequisites alone would open the old gate');
const closed = rules.previewFormalPostClosed(readyBooks);
assert.equal(closed.allowed, false);
assert.equal(closed.code, 'PREVIEW_FORMAL_POST_CLOSED');
assert.ok(closed.reasons[0].includes('正式预览禁止财务定稿'));
assert.equal(rules.previewFormalPostClosed().reasons[0].includes('正式预览'), true);
const officialClosed = rules.previewFormalPostClosed(readyBooks, 'official');
assert.equal(officialClosed.allowed, false);
assert.equal(officialClosed.reasons[0].includes('正式预览'), false);
assert.ok(officialClosed.reasons[0].includes('本版本未开放财务定稿'));
assert.equal(rules.previewFormalPostClosed().allowed, false);
assert.equal(rules.monthPlanEmptyText('official', []), '本月尚未登记正式计划（测试数据不计入）');
assert.equal(rules.monthPlanEmptyText('official', [{ title: '测试开户', notes: '虚构' }]), '');
assert.equal(rules.monthPlanEmptyText('official', [{ title: '客户拜访', notes: '' }]), '');
assert.equal(rules.monthPlanEmptyText('preview', []), '本月尚未登记计划。');
assert.equal(rules.monthPlanEmptyText('preview', [{ title: '测试开户' }]), '');
assert.equal(rules.monthPlanEmptyText('', []), '本月尚未登记计划。');
assert.equal(rules.monthPlanEmptyText(undefined, []), '本月尚未登记计划。');
assert.equal(app.includes("const RELEASE_REJECTED = '已拒绝：接口身份与本页不一致。'"), true);
assert.equal(app.includes('正式预览契约不一致'), false);
function renderedRejection(name, data, page) {
  const out = decision(data, page);
  assert.equal(out.ok, false, name);
  const text = '已拒绝：接口身份与本页不一致。 原因：' + out.reasons.join('、');
  assert.equal(text.includes('正式预览'), false, name + ' ' + text);
}
renderedRejection('rejected preview mismatch', matchPayload({ buildId: 'ac02-preview-not-approved' }));
renderedRejection('rejected official mismatch', officialPayload({ buildId: 'ac02-official-not-approved' }));
const rejectedMarker = app.slice(app.indexOf('if (!decision || !decision.ok)'), app.indexOf("decision.profile === 'preview'"));
assert.ok(rejectedMarker.includes('已拒绝'));
assert.equal(rejectedMarker.includes('非生产数据'), false);
assert.ok(app.includes("data && data.productionData === false ? '非生产数据' : 'productionData 不是 false'"));
assert.ok(app.includes("head + ' · 正式预览'"));
assert.ok(app.includes("identityProfile === 'official' ? '' : '测试银行-港币往来（虚构）'"));
assert.ok(app.includes("identityProfile === 'official' ? '' : 'TEST-BANK-HKD'"));
assert.ok(app.includes("identityProfile === 'official' && (!accountName || !accountId)"));
assert.ok(app.includes("identityProfile === 'official' ? '对方名称' : '对方名称（须为虚构测试名称）'"));
assert.equal(read('site/admin/js/rules.js').includes('isTestPlan_'), false);
assert.ok(app.includes('function applyRejectedChrome'));
assert.ok(app.includes('applyRejectedChrome()'));
assert.equal(app.slice(app.indexOf('function applyRejectedChrome'), app.indexOf('function applyOfficialChrome')).includes('正在确认身份…'), false);
assert.ok(read('site/admin/js/app.js').includes('本月尚未登记计划。'));
assert.ok(read('site/admin/js/app.js').includes('monthPlanEmptyText'));
assert.ok(read('site/admin/js/rules.js').includes('本月尚未登记正式计划（测试数据不计入）'));
const boot = app.slice(app.indexOf('async function boot'), app.indexOf('document.getElementById(\'logout\')'));
const rejectAt = boot.indexOf('if (!decision.ok)');
const renderAt = boot.indexOf('await render()');
assert.ok(rejectAt > 0 && renderAt > rejectAt, 'a rejected identity must return before the first business render');

const gas = read('apps-script/Code.gs');
assert.ok(gas.includes("buildId: 'ac02-preview'"));
assert.ok(gas.includes("buildId: 'ac02-official'"));
assert.ok(gas.includes("official: { buildId: 'ac02-official', dataMode: 'ac02-official', productionData: false }"));
assert.ok(gas.includes('productionData: false'));
assert.equal(gas.includes('productionData: true'), false);
assert.equal(gas.split('__AC02_SPREADSHEET_ID__').length - 1 >= 2, true);
assert.equal(gas.split('__AC02_DRIVE_ROOT__').length - 1 >= 2, true);
assert.equal(gas.includes('script.google.com/macros'), false);
assert.equal(gas.includes('simulated-test'), false);
assert.equal(gas.includes(OLD_BUILD), false);

console.log(JSON.stringify({
  ok: true,
  buildId: expected.buildId,
  dataMode: expected.dataMode,
  productionData: expected.productionData,
  exec: '__AC02_EXEC_URL__',
  matched: matched.reasons,
  formalPostClosed: closed.code,
  gasPreview: 'ac02-preview'
}, null, 2));
