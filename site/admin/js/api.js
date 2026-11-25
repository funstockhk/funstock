/* AC02 admin API client. Official data comes from the single interface, never from a pasted data.js.
 * If window.FS_API_BASE is set (see config.js), POST JSON as text/plain to that Apps Script Web App URL.
 * Otherwise keep today's same-origin POST /api for local 18787 preview.
 */
(function (global) {
  const FS = global.FS || (global.FS = {});
  const TOKEN_KEY = 'ac02_session_token';

  function apiBase() {
    const raw = global.FS_API_BASE != null ? global.FS_API_BASE : '';
    return String(raw).trim().replace(/\/+$/, '');
  }

  function adminBase() {
    const rawPath = location.pathname || '/';
    const trimmed = rawPath.replace(/\/index\.html$/, '').replace(/\/login\.html$/, '').replace(/\/+$/, '') || '';
    const m = trimmed.match(/^(.*\/admin)(?:\/(?:plans|proposals|documents|finance|contracts|logs))?$/);
    if (m) return m[1];
    if (trimmed.endsWith('/admin')) return trimmed;
    return '/admin';
  }

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setToken(token) {
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* private mode */ }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result || '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = () => reject(new Error('无法读取要上传的文件。'));
      reader.readAsDataURL(file);
    });
  }

  function throwIfFailed(res, body) {
    if (!res.ok || !body || body.ok !== true) {
      const err = new Error((body && body.error) || ('请求失败（' + (res && res.status) + '）'));
      err.status = res.status;
      err.code = body && body.code;
      throw err;
    }
  }

  function rememberToken(action, data) {
    if (action === 'login' && data && data.token) setToken(data.token);
    if (action === 'logout') setToken('');
  }

  const READ_ACTIONS = {
    me: true,
    logout: true,
    getDashboard: true,
    getPlans: true,
    getProposals: true,
    getDocuments: true,
    getMonth: true,
    getContracts: true,
    getReconciliation: true,
    getLogs: true,
    getEffectiveTargets: true
  };

  const LIST_ACTIONS = {
    getDashboard: true,
    getPlans: true,
    getProposals: true,
    getDocuments: true,
    getMonth: true,
    getContracts: true,
    getReconciliation: true,
    getLogs: true
  };

  function isReadAction(action) {
    return !!READ_ACTIONS[action];
  }

  function splitMeta(payload) {
    const src = Object.assign({}, payload || {});
    const timeoutMs = Number(src.__timeoutMs) > 0 ? Number(src.__timeoutMs) : 20000;
    delete src.__timeoutMs;
    return { payload: src, timeoutMs: timeoutMs };
  }

  function failureError(kind, action, statusText) {
    const read = isReadAction(action);
    const list = !!LIST_ACTIONS[action];
    const suffix = statusText || '';
    let message;
    if (action === 'login') {
      if (kind === 'timeout') message = '登录请求超时，尚未登录。请再试一次。';
      else if (kind === 'network') message = '登录请求没有送到接口。请再试一次。';
      else message = '登录接口没有返回可识别的结果' + suffix + '。请再试一次。';
    } else if (read) {
      if (kind === 'timeout') {
        message = list
          ? '读取超时，列表没有载入。请稍后重新打开本页。这次失败只表示没有读到数据。'
          : '读取超时，这次没有拿到数据。请稍后重新打开本页。';
      } else if (kind === 'network') {
        message = list
          ? '网络中断，列表没有载入。请稍后重新打开本页。这次失败只表示没有读到数据。'
          : '网络中断，这次没有拿到数据。请稍后重新打开本页。';
      } else {
        message = '接口没有返回可识别的读取结果' + suffix + '。请稍后重新打开本页。';
      }
    } else if (kind === 'timeout') {
      message = '请求超时，接口没有返回写入结果。请先核对列表里是否已有这次记录，不要立刻再次提交。';
    } else if (kind === 'network') {
      message = '网络中断，接口没有返回写入结果。请先核对列表里是否已有这次记录，不要立刻再次提交。';
    } else {
      message = '接口没有返回可识别的写入结果' + suffix + '。请先核对列表，不要立刻再次提交。';
    }
    const err = new Error(message);
    err.code = kind === 'timeout' ? 'TIMEOUT' : kind === 'network' ? 'NETWORK' : 'BAD_RESPONSE';
    err.intent = action === 'login' ? 'login' : read ? 'read' : 'write';
    err.action = action || '';
    err.retryable = false;
    return err;
  }

  function knownIdSet(knownIds) {
    if (knownIds == null) return null;
    const set = new Set();
    knownIds.forEach(function (id) { if (id) set.add(id); });
    return set;
  }

  function sameUpload(file, hint) {
    if (!file) return false;
    const name = String(hint.name || '').trim();
    if (!name || String(file.name || '').trim() !== name) return false;
    const category = String(hint.category || '').trim();
    if (category && String(file.category || '').trim() !== category) return false;
    if (String(file.relatedId || '').trim() !== String(hint.relatedId || '').trim()) return false;
    const uploadedBy = String(hint.uploadedBy || '').trim();
    if (uploadedBy && file.uploadedBy && String(file.uploadedBy).trim() !== uploadedBy) return false;
    const date = String(hint.date || '').trim();
    if (date && file.date && String(file.date).trim() !== date) return false;
    if (hint.size != null && hint.size !== '' && file.size != null && file.size !== '') {
      const want = Number(hint.size);
      const got = Number(file.size);
      if (Number.isFinite(want) && Number.isFinite(got) && want !== got) return false;
    }
    return true;
  }

  /* Read-only match of a timed-out upload against getDocuments files.
   * A stored clientRequestId wins. Otherwise a row is recognized by name,
   * category, related id, and optional size, date, and uploader.
   * knownIds are rows already on screen before this upload; they are not treated as this attempt. */
  function reconcileUploadedFile(files, hint, knownIds) {
    const list = Array.isArray(files) ? files : [];
    const wanted = hint || {};
    const req = String(wanted.clientRequestId || '').trim();
    if (req) {
      const byReq = list.filter(function (file) {
        if (!file) return false;
        return String(file.clientRequestId || '') === req || String(file.requestId || '') === req;
      });
      if (byReq.length === 1) return { status: 'found', file: byReq[0] };
      if (byReq.length > 1) return { status: 'ambiguous', file: null };
    }
    const known = knownIdSet(knownIds);
    const matches = list.filter(function (file) {
      if (!file || !file.id) return false;
      if (known && known.has(file.id)) return false;
      return sameUpload(file, wanted);
    });
    if (matches.length === 1) return { status: 'found', file: matches[0] };
    if (matches.length > 1) return { status: 'ambiguous', file: null };
    return { status: 'missing', file: null };
  }

  async function fetchWithTimeout(url, options, timeoutMs, action) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs);
    try {
      const opts = Object.assign({}, options);
      if (ctrl) opts.signal = ctrl.signal;
      return await fetch(url, opts);
    } catch (e) {
      if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')))) throw failureError('timeout', action);
      throw failureError('network', action);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readBody(res, action) {
    let parsed = null;
    try { parsed = await res.json(); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      const err = failureError('bad_response', action, '（' + (res && res.status) + '）');
      err.status = res && res.status;
      throw err;
    }
    return parsed;
  }

  async function apiRemote(base, action, payload, file) {
    const meta = splitMeta(payload);
    const body = { action: action, payload: meta.payload, token: getToken() };
    if (file && file.size) {
      body.payload.file = {
        name: file.name || 'file',
        mime: file.type || 'application/octet-stream',
        data: await fileToBase64(file),
      };
    }
    const res = await fetchWithTimeout(base, {
      method: 'POST',
      redirect: 'follow',
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    }, meta.timeoutMs, action);
    const parsed = await readBody(res, action);
    throwIfFailed(res, parsed);
    rememberToken(action, parsed.data);
    return parsed.data;
  }

  async function apiLocal(action, payload, file) {
    const meta = splitMeta(payload);
    let res;
    if (file && file.size) {
      const fd = new FormData();
      fd.append('action', action);
      fd.append('payload', JSON.stringify(meta.payload));
      fd.append('token', getToken());
      fd.append('file', file);
      res = await fetchWithTimeout('/api', { method: 'POST', body: fd, credentials: 'same-origin' }, meta.timeoutMs, action);
    } else {
      res = await fetchWithTimeout('/api', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action, payload: meta.payload, token: getToken() }),
      }, meta.timeoutMs, action);
    }
    const body = await readBody(res, action);
    throwIfFailed(res, body);
    rememberToken(action, body.data);
    return body.data;
  }

  async function api(action, payload, file) {
    const base = apiBase();
    if (base) return apiRemote(base, action, payload, file);
    return apiLocal(action, payload, file);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fileHref(id, filesOrRecord) {
    const rec = (filesOrRecord && !Array.isArray(filesOrRecord))
      ? filesOrRecord
      : ((Array.isArray(filesOrRecord) ? filesOrRecord.find(function (f) { return f && f.id === id; }) : null) || {});
    if (rec.driveLink) return rec.driveLink;
    if (rec.fileUrl) return rec.fileUrl;
    if (apiBase()) return '';
    if (id) return '/api/files/' + encodeURIComponent(id);
    return '';
  }

  function fileLink(id, filesOrRecord, label) {
    const href = fileHref(id, filesOrRecord);
    const text = label || id || '查阅';
    if (!href) return escapeHtml(id || '—');
    return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' + escapeHtml(text) + '</a>';
  }

  function badge(status) {
    const s = String(status || '');
    let cls = 'muted';
    if (/已完成|已附原件|免原件|已配平|启用|状态一|已归档|执行中/.test(s)) cls = 'ok';
    if (/未完成|待收|待核验|未处理|暂停/.test(s)) cls = 'warn';
    if (/逾期|暂记|拒绝|未配平|解除/.test(s)) cls = 'danger';
    if (/草稿|灵活|固定/.test(s)) cls = 'info';
    return '<span class="badge ' + cls + '">' + escapeHtml(s || '—') + '</span>';
  }

  FS.api = api;
  FS.apiBase = apiBase;
  FS.isReadAction = isReadAction;
  FS.reconcileUploadedFile = reconcileUploadedFile;
  FS.adminBase = adminBase;
  FS.fileHref = fileHref;
  FS.fileLink = fileLink;
  FS.escapeHtml = escapeHtml;
  FS.badge = badge;
})(window);
