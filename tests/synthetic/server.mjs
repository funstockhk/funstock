import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEngine, boot, call } from './engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const siteRoot = path.join(root, 'site');
const engine = loadEngine(path.join(root, 'apps-script/Code.gs'));
/* Repo site/admin/js/build.js is a TODO placeholder and must not carry identity values.
 * The browser harness overlays the approved preview identity so the shell can be exercised. */
const TEST_PAGE_BUILD = [
  'window.AC02_BUILD = { buildId: "ac02-preview", dataMode: "ac02-preview", productionData: false };',
  'window.AC02_IDENTITIES = [',
  '  { buildId: "ac02-preview", dataMode: "ac02-preview", productionData: false },',
  '  { buildId: "ac02-official", dataMode: "ac02-official", productionData: false }',
  '];',
  ''
].join('\n');
const store = boot(engine);
const delays = {};

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
};

function send(res, status, body, type) {
  res.writeHead(status, { 'content-type': type || 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/__test/delay') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      Object.keys(delays).forEach((k) => delete delays[k]);
      Object.assign(delays, body || {});
      return send(res, 200, '{"ok":true}', 'application/json');
    }
    if (req.method === 'POST' && req.url === '/api') {
      const raw = await readBody(req);
      let body = {};
      const ctype = req.headers['content-type'] || '';
      if (ctype.indexOf('multipart/form-data') === 0) {
        body = parseMultipart(raw, ctype);
      } else {
        body = JSON.parse(raw || '{}');
      }
      const payload = body.payload || {};
      const wait = Number(payload.__delayMs || delays[body.action] || 0);
      delete payload.__delayMs;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const out = call(engine, body.token || '', body.action, payload, body.file || null);
      return send(res, 200, JSON.stringify(out), 'application/json');
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/admin/js/config.js')) {
      return send(res, 200, 'window.FS_API_BASE = "";\n', types['.js']);
    }
    if (url.pathname.endsWith('/admin/js/build.js')) {
      return send(res, 200, TEST_PAGE_BUILD, types['.js']);
    }
    let filePath = path.normalize(path.join(siteRoot, decodeURIComponent(url.pathname)));
    if (!filePath.startsWith(siteRoot)) return send(res, 403, 'no');
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    if (!fs.existsSync(filePath)) return send(res, 404, 'missing');
    const ext = path.extname(filePath);
    return send(res, 200, fs.readFileSync(filePath), types[ext] || 'application/octet-stream');
  } catch (err) {
    return send(res, 500, String(err && err.stack || err));
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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

const port = Number(process.env.PORT || 8765);
server.listen(port, '127.0.0.1', () => {
  console.log('synthetic-admin http://127.0.0.1:' + port + '/admin/login.html');
});
