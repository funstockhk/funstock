'use strict';

const crypto = require('crypto');

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const digest = crypto.createHmac('sha256', s).update(String(password), 'utf8').digest('hex');
  return `hmac-sha256$${s}$${digest}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('hmac-sha256$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [, salt, expected] = parts;
  if (!salt || !expected || !/^[0-9a-f]+$/i.test(expected)) return false;
  const digest = crypto.createHmac('sha256', salt).update(String(password), 'utf8').digest('hex');
  try {
    const a = Buffer.from(digest, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function publicUser(user) {
  if (!user) return null;
  return {
    jobId: user.jobId,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
  };
}

/** Auth table must exist and have at least one row. Never default-allow. */
function assertAuthStore(store) {
  if (!store || !Array.isArray(store.users)) {
    const err = new Error('授权用户表缺失或不可用，已拒绝访问。');
    err.code = 'AUTH_STORE_MISSING';
    err.status = 403;
    throw err;
  }
}

function findActiveUser(store, jobId) {
  assertAuthStore(store);
  return store.users.find((u) => u && u.jobId === jobId) || null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  newToken,
  publicUser,
  assertAuthStore,
  findActiveUser,
};
