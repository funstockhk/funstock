import crypto from 'crypto';
import { createRequire } from 'module';
import { emptyStore } from './store.mjs';

const require = createRequire(import.meta.url);
require.extensions['.gs'] = require.extensions['.js'];

export function loadEngine(file) {
  global.__fsHmacHex = (message, salt) => crypto.createHmac('sha256', salt).update(String(message)).digest('hex');
  delete global.__FS_TEST_STORE__;
  const resolved = require.resolve(file);
  delete require.cache[resolved];
  return require(file);
}

export function boot(engine) {
  const store = emptyStore();
  engine.setTestStore_(store);
  return store;
}

export function call(engine, token, action, payload, uploaded) {
  try {
    const data = engine.dispatch_(action, payload || {}, token || '', uploaded || null);
    return { ok: true, data: data };
  } catch (err) {
    return { ok: false, error: String(err.message || err), code: err.code || '', status: err.status || 400 };
  }
}

export function login(engine, jobId) {
  const out = call(engine, '', 'login', { jobId: jobId, password: 'synthetic-only-not-a-real-secret' });
  if (!out.ok) return out;
  return { ok: true, token: out.data.token, user: out.data.user };
}
