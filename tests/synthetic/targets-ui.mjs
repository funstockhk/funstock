import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rules = require(path.join(root, 'site/admin/js/rules.js'));
const describe = rules.describeRelease;
const expectedSheet = '__AC02_SPREADSHEET_ID__';
const expectedDrive = '__AC02_DRIVE_ROOT__';
const results = [];

function rec(id, input, expected, actual, ok) {
  results.push({ id, input, expected, actual, status: ok ? 'pass' : 'fail', environment: 'unit-rules', live: 'BLOCKED' });
  if (!ok) console.error('FAIL', id, actual);
}

const missing = describe({ buildId: 'from-server', dataMode: 'ac02-preview' });
rec('TARGET-MISSING', { release: null }, 'unavailable and no invented id', missing, missing.state === 'unavailable' && missing.spreadsheetId === '' && missing.driveRootId === '' && missing.text.indexOf(expectedSheet) < 0 && missing.text.indexOf(expectedDrive) < 0);

const mismatch = describe({ release: { mismatch: true, buildId: 'from-server', dataMode: 'ac02-preview' } });
rec('TARGET-MISMATCH', { mismatch: true }, 'mismatch and no invented id', mismatch, mismatch.state === 'mismatch' && mismatch.text.indexOf(expectedSheet) < 0 && mismatch.text.indexOf(expectedDrive) < 0);

const echoed = describe({ release: { targetsMatch: false, spreadsheetId: 'RETURNED-SHEET', driveRootId: 'RETURNED-DRIVE' } });
rec('TARGET-MISMATCH-ECHO', { ids: 'only if present' }, 'echo response only', echoed, echoed.state === 'mismatch' && echoed.text.indexOf('RETURNED-SHEET') >= 0 && echoed.text.indexOf('RETURNED-DRIVE') >= 0 && echoed.text.indexOf(expectedSheet) < 0);

const valid = describe({
  buildId: 'ac02-preview',
  dataMode: 'ac02-preview',
  release: { buildId: 'ac02-preview', dataMode: 'ac02-preview', spreadsheetId: 'SERVER-SHEET', driveRootId: 'SERVER-DRIVE' }
});
rec('TARGET-VALID', { source: 'me.release' }, 'observed server ids', valid, valid.state === 'observed' && valid.spreadsheetId === 'SERVER-SHEET' && valid.driveRootId === 'SERVER-DRIVE' && valid.text.indexOf('SERVER-SHEET') >= 0 && valid.text.indexOf('SERVER-DRIVE') >= 0 && valid.text.indexOf(expectedSheet) < 0);

const out = {
  kind: 'synthetic-ui-target-display',
  live: 'BLOCKED',
  passed: results.filter((r) => r.status === 'pass').length,
  failed: results.filter((r) => r.status === 'fail').length,
  results
};
fs.mkdirSync(path.join(root, 'tests/synthetic/results'), { recursive: true });
fs.writeFileSync(path.join(root, 'tests/synthetic/results/targets-ui.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ passed: out.passed, failed: out.failed }));
process.exit(out.failed ? 1 : 0);
