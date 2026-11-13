/* FUNSTOCK admin API client. Official data comes from the single /api interface, never from a pasted data.js. */
(function (global) {
  const FS = global.FS || (global.FS = {});

  async function api(action, payload, file) {
    let res;
    if (file) {
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
        body: JSON.stringify({ action, payload: payload || {} }),
      });
    }
    let body = null;
    try { body = await res.json(); } catch { /* ignore */ }
    if (!res.ok || !body || body.ok === false) {
      const err = new Error((body && body.error) || ('请求失败（' + res.status + '）'));
      err.status = res.status;
      err.code = body && body.code;
      throw err;
    }
    return body.data;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
  FS.escapeHtml = escapeHtml;
  FS.badge = badge;
})(window);
