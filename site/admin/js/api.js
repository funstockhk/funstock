/* FUNSTOCK admin API client. Official data comes from the single interface, never from a pasted data.js.
 * If window.FS_API_BASE is set (see config.js), POST JSON as text/plain to that Apps Script Web App URL.
 * Otherwise keep today's same-origin POST /api for local 8787 preview.
 */
(function (global) {
  const FS = global.FS || (global.FS = {});
  const TOKEN_KEY = 'fs_session_token';

  function apiBase() {
    const raw = global.FS_API_BASE != null ? global.FS_API_BASE : '';
    return String(raw).trim().replace(/\/+$/, '');
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
    if (!res.ok || !body || body.ok === false) {
      const err = new Error((body && body.error) || ('请求失败（' + res.status + '）'));
      err.status = res.status;
      err.code = body && body.code;
      throw err;
    }
  }

  function rememberToken(action, data) {
    if (action === 'login' && data && data.token) setToken(data.token);
    if (action === 'logout') setToken('');
  }

  async function apiRemote(base, action, payload, file) {
    const body = { action: action, payload: Object.assign({}, payload || {}), token: getToken() };
    if (file && file.size) {
      body.payload.file = {
        name: file.name || 'file',
        mime: file.type || 'application/octet-stream',
        data: await fileToBase64(file),
      };
    }
    const res = await fetch(base, {
      method: 'POST',
      redirect: 'follow',
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch (e) { /* ignore */ }
    throwIfFailed(res, parsed);
    rememberToken(action, parsed.data);
    return parsed.data;
  }

  async function apiLocal(action, payload, file) {
    let res;
    if (file && file.size) {
      const fd = new FormData();
      fd.append('action', action);
      fd.append('payload', JSON.stringify(payload || {}));
      fd.append('file', file);
      res = await fetch('/api', { method: 'POST', body: fd, credentials: 'same-origin' });
    } else {
      res = await fetch('/api', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action, payload: payload || {} }),
      });
    }
    let body = null;
    try { body = await res.json(); } catch (e) { /* ignore */ }
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
  FS.fileHref = fileHref;
  FS.fileLink = fileLink;
  FS.escapeHtml = escapeHtml;
  FS.badge = badge;
})(window);
