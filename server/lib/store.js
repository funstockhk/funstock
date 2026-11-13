'use strict';

const fs = require('fs');
const path = require('path');

function load(file) {
  if (!fs.existsSync(file)) {
    const err = new Error('本地数据存储不存在或不可用，已拒绝访问。');
    err.code = 'AUTH_STORE_MISSING';
    err.status = 403;
    throw err;
  }
  const raw = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const err = new Error('本地数据存储无法读取，已拒绝访问。');
    err.code = 'AUTH_STORE_MISSING';
    err.status = 403;
    throw err;
  }
  return data;
}

function save(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function nowIso() {
  const d = new Date();
  // Store in Asia/Shanghai wall clock with explicit offset
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} +08:00`;
}

function todayYmd() {
  return nowIso().slice(0, 10);
}

function newId(prefix) {
  const n = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${n}${r}`.toUpperCase();
}

function log(store, actor, action, target, result, notes) {
  store.logs = store.logs || [];
  store.logs.push({
    time: nowIso(),
    actor: actor || 'system',
    action,
    target: target || '',
    result,
    notes: notes || '',
  });
}

module.exports = { load, save, nowIso, todayYmd, newId, log, path };
