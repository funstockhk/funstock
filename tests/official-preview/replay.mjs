/**
 * Gate and result contract for the one official-preview synthetic replay.
 * No network and no fixture bytes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rules = require(path.join(root, 'site/admin/js/rules.js'));
const REC = rules.PREVIEW_REPLAY;
const page = {
  buildId: 'ac02-preview',
  dataMode: 'ac02-preview',
  productionData: false
};

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function session(extra) {
  const data = {
    buildId: page.buildId,
    dataMode: page.dataMode,
    productionData: false,
    release: {
      buildId: page.buildId,
      dataMode: page.dataMode,
      productionData: false
    }
  };
  return Object.assign(data, extra || {});
}

function file(extra) {
  return Object.assign({
    name: REC.fileName,
    size: REC.size,
    sha256: REC.sha256
  }, extra || {});
}

function gate(extra) {
  const input = Object.assign({
    session: session(),
    page: page,
    role: '顾问',
    file: file()
  }, extra || {});
  return rules.previewReplayGate(input);
}

const allowed = gate();
assert.equal(allowed.ok, true, JSON.stringify(allowed.reasons));
assert.deepEqual(allowed.request, {
  category: '其他',
  relatedId: 'ac02-preview-replay-rel-001',
  clientRequestId: 'ac02-preview-replay-req-001'
});
assert.equal(REC.clientRequestId, 'ac02-preview-replay-req-001');
assert.ok(read('apps-script/Code.gs').includes("var PREVIEW_REPLAY_CLIENT_REQUEST_ID_ = '" + REC.clientRequestId + "'"));
assert.ok(read('site/admin/js/rules.js').includes("clientRequestId: '" + REC.clientRequestId + "'"));
assert.equal(REC.fileId, 'ac02-preview-replay-file-001');
assert.equal(REC.fileName, 'ac02-synthetic-sample.pdf');
assert.equal(REC.size, 593);
assert.equal(REC.sha256, 'c9fef96432df0b61aeda3349a3aab83e97ef2bf4b67dca6ca4ff9554f22d7acf');
assert.equal(allowed.request.clientRequestId, REC.clientRequestId);
assert.equal(Object.keys(allowed.request).length, 3);

function assertRefuse(name, input, reason) {
  const out = gate(input);
  assert.equal(out.ok, false, name);
  assert.equal(out.request, null, name);
  if (reason) assert.ok(out.reasons.includes(reason), name + ' ' + out.reasons.join(','));
  assert.match(rules.previewReplayRefusal(out.reasons), /^未向接口提交。/);
}

assertRefuse('production data', {
  session: session({
    productionData: true,
    release: { buildId: page.buildId, dataMode: page.dataMode, productionData: true }
  })
}, 'productionData');
assertRefuse('production mode', {
  session: session({
    dataMode: 'production',
    release: { buildId: page.buildId, dataMode: 'production', productionData: false }
  })
}, 'production-mode');
assertRefuse('wrong build', { session: session({ buildId: 'ac02-preview-not-approved' }) }, 'buildId');
assertRefuse('page production flag', {
  page: { buildId: page.buildId, dataMode: page.dataMode, productionData: true }
}, 'page-productionData');
assertRefuse('customer role', { role: '客户' }, 'role');
assertRefuse('missing role', { role: '' }, 'role');
assertRefuse('other file name', { file: file({ name: 'invoice.pdf' }) }, 'file-name');
assertRefuse('other size', { file: file({ size: 1529 }) }, 'file-size');
assertRefuse('other bytes', { file: file({ sha256: 'a'.repeat(64) }) }, 'file-hash');
assertRefuse('missing file', { file: null }, 'file-missing');

function refuseSession(name, data, reason) {
  assertRefuse(name, { session: data }, reason);
  assert.match(rules.previewReplayRefusal([reason]), /未向接口提交。/);
}

const noRelease = session();
delete noRelease.release;
refuseSession('no release', noRelease, 'release-missing');
refuseSession('release null', session({ release: null }), 'release-missing');
refuseSession('release string', session({ release: 'nope' }), 'release-missing');
refuseSession('release array', session({ release: [] }), 'release-missing');
refuseSession('release date', session({ release: new Date(0) }), 'release-missing');

function releaseWithout(field) {
  const release = { buildId: page.buildId, dataMode: page.dataMode, productionData: false };
  delete release[field];
  return release;
}
refuseSession('release missing buildId', session({ release: releaseWithout('buildId') }), 'release.buildId-missing');
refuseSession('release missing dataMode', session({ release: releaseWithout('dataMode') }), 'release.dataMode-missing');
refuseSession('release missing productionData', session({ release: releaseWithout('productionData') }), 'release.productionData-missing');

function topWithout(field) {
  const data = session();
  delete data[field];
  return data;
}
refuseSession('top missing buildId', topWithout('buildId'), 'buildId-missing');
assert.ok(gate({ session: topWithout('buildId') }).reasons.includes('buildId'));
refuseSession('top missing dataMode', topWithout('dataMode'), 'dataMode-missing');
assert.ok(gate({ session: topWithout('dataMode') }).reasons.includes('dataMode'));
refuseSession('top missing productionData', topWithout('productionData'), 'productionData-missing');
assert.ok(gate({ session: topWithout('productionData') }).reasons.includes('productionData'));

const blankReleaseBuild = gate({
  session: session({ release: { buildId: '', dataMode: page.dataMode, productionData: false } })
});
assert.equal(blankReleaseBuild.ok, false);
assert.ok(blankReleaseBuild.reasons.includes('release.buildId'));
assert.equal(blankReleaseBuild.reasons.includes('release.buildId-missing'), false);
assert.equal(gate().ok, true);
const officialPage = { buildId: 'ac02-official', dataMode: 'ac02-official', productionData: false };
const officialSession = session({
  buildId: officialPage.buildId,
  dataMode: officialPage.dataMode,
  productionData: false,
  release: {
    buildId: officialPage.buildId,
    dataMode: officialPage.dataMode,
    productionData: false
  }
});
const officialGate = gate({ session: officialSession, page: page });
assert.equal(officialGate.ok, false, JSON.stringify(officialGate.reasons));
assert.equal(officialGate.request, null);
assert.ok(officialGate.reasons.includes('productionData'));
assert.equal(rules.previewReplayClosedText('PREVIEW_REPLAY_CLOSED'), '正式环境不开放虚构资料重放');
assert.equal(rules.previewReplayClosedText('OTHER'), '');
assert.equal(rules.previewReplayClosedText(''), '');
assert.ok(read('site/admin/js/app.js').includes('previewReplayClosedText(code)'));
assert.equal(gate({ session: officialSession, page: officialPage }).ok, false);
assert.ok(gate({ session: officialSession, page: officialPage }).reasons.includes('productionData'));
assertRefuse('mixed top fields', {
  session: session({ dataMode: 'official', release: { buildId: page.buildId, dataMode: 'official', productionData: false } })
}, 'dataMode');
assertRefuse('top preview release official', {
  session: session({ release: { buildId: officialPage.buildId, dataMode: officialPage.dataMode, productionData: false } })
}, 'release.buildId');
assert.equal(rules.previewReplayRefusal(['file-name']).includes('文件名不是这条虚构资料'), true);
assert.equal(rules.previewReplayRefusal(['productionData']).includes('不是正式预览或不是非生产数据'), true);

const pass = rules.previewReplayVerdict({
  idempotentReplay: true,
  file: {
    id: REC.fileId,
    name: REC.fileName,
    category: REC.category,
    relatedId: REC.relatedId,
    clientRequestId: REC.clientRequestId
  }
});
assert.equal(pass.ok, true, pass.reasons.join(','));
const passText = rules.previewReplayText(pass);
assert.match(passText, /幂等重放成立/);
assert.match(passText, /fileId ac02-preview-replay-file-001/);
assert.match(passText, /idempotentReplay true/);
assert.match(passText, /仅正式预览的一条虚构资料/);

function assertVerdictFail(name, body, reason) {
  const out = rules.previewReplayVerdict(body);
  assert.equal(out.ok, false, name);
  if (reason) assert.ok(out.reasons.includes(reason), name + ' ' + out.reasons.join(','));
  const text = rules.previewReplayText(out);
  assert.match(text, /幂等重放未成立/);
  assert.match(text, /没有再次提交/);
  assert.match(text, /fileId /);
  assert.match(text, /idempotentReplay /);
}

assertVerdictFail('new row', {
  idempotentReplay: false,
  file: { id: 'FL-NEW', name: REC.fileName, category: REC.category, relatedId: REC.relatedId }
}, 'idempotentReplay');
assert.equal(rules.previewReplayText(rules.previewReplayVerdict({
  idempotentReplay: false,
  file: { id: 'FL-NEW' }
})).includes('fileId FL-NEW'), true);
assert.equal(rules.previewReplayText(rules.previewReplayVerdict({
  idempotentReplay: false,
  file: { id: 'FL-NEW' }
})).includes('idempotentReplay false'), true);
assertVerdictFail('string true', { idempotentReplay: 'true', file: { id: REC.fileId } }, 'idempotentReplay');
assertVerdictFail('wrong id', { idempotentReplay: true, file: { id: 'FL-OTHER' } }, 'fileId');
assertVerdictFail('other related id', {
  idempotentReplay: true,
  file: { id: REC.fileId, relatedId: 'PL-OTHER' }
}, 'relatedId');
assertVerdictFail('empty', null, 'idempotentReplay');

const app = read('site/admin/js/app.js');
const replayAt = app.indexOf("getElementById('replay-form')");
const picsAt = app.indexOf("getElementById('pics-btn')");
assert.ok(replayAt > 0 && picsAt > replayAt);
const replayHandler = app.slice(replayAt, picsAt);
assert.equal(replayHandler.includes('confirmUploadedFile'), false);
assert.equal(replayHandler.includes('newRequestId'), false);
assert.equal(replayHandler.includes('getDocuments'), false);
assert.equal(replayHandler.includes('sessionStorage'), false);
assert.equal(replayHandler.includes('localStorage'), false);
assert.equal((replayHandler.match(/api\(\s*'uploadDocument'/g) || []).length, 1);
assert.ok(replayHandler.includes('plan.request.clientRequestId'));
assert.ok(replayHandler.includes('previewReplayVerdict'));
assert.equal(app.includes('signedSession = data'), true);
assert.equal(/api\(\s*['"]postFourStatements['"]/.test(app), false);
assert.equal(/api\(\s*['"]generateOfficialContract['"]/.test(app), false);
assert.ok(read('site/admin/js/config.js').includes('__AC02_EXEC_URL__'));
assert.equal(read('site/admin/js/config.js').includes('script.google.com'), false);
assert.ok(read('site/admin/js/build.js').includes('TODO'));
assert.ok(read('site/admin/js/build.js').includes('window.AC02_BUILD'));
assert.equal(/buildId\s*:/.test(read('site/admin/js/build.js')), false);
assert.equal(read('apps-script/Code.gs').includes("buildId: 'ac02-preview'"), true);
assert.equal(read('apps-script/Code.gs').includes('__AC02_SPREADSHEET_ID__'), true);
assert.equal(read('apps-script/Code.gs').includes('__AC02_DRIVE_ROOT__'), true);

console.log(JSON.stringify({
  ok: true,
  request: allowed.request,
  passText: passText
}, null, 2));
