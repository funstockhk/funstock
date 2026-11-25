/* AC02 Funstock operations admin — single gated shell. Data only from /api. */
(function () {
  const { api: requestApi, escapeHtml: E, badge } = FS;
  const viewEl = document.getElementById('view');
  const titleEl = document.getElementById('title');
  const whoEl = document.getElementById('who');
  let me = null;
  let signedSession = null;
  let releaseState = 'pending';
  let releaseReasons = [];
  let identityProfile = '';
  const RELEASE_REJECTED = '已拒绝：接口身份与本页不一致。';
  const IDENTITY_PENDING = '正在核对接口身份…';
  const READ_SLOW_MS = 8000;
  const READ_LIMIT_MS = 20000;
  const IDENTITY_REASON_CODES = {
    'page-build': true,
    'page-dataMode': true,
    'page-productionData': true,
    missing: true,
    buildId: true,
    dataMode: true,
    productionData: true,
    'production-mode': true,
    'production-data': true,
    'release.buildId': true,
    'release.dataMode': true,
    'release.productionData': true,
    'release-production-mode': true,
    'release-production-data': true,
    'release-missing': true,
    'release.buildId-missing': true,
    'release.dataMode-missing': true,
    'release.productionData-missing': true,
    'buildId-missing': true,
    'dataMode-missing': true,
    'productionData-missing': true,
    'missing-check': true
  };
  const PAGE_ERROR_CODES = {
    TIMEOUT: true,
    NETWORK: true,
    BAD_RESPONSE: true,
    UPLOAD_NOT_ON_LEDGER: true,
    UPLOAD_AMBIGUOUS: true,
    UPLOAD_RECONCILE_FAILED: true,
    AUTH_STORE_MISSING: true
  };

  /* api.js stops its timer when fetch() resolves, before res.json().
   * A slow body would otherwise leave the view on “正在读取…”. */
  function api(action, payload, file) {
    const requested = payload && Number(payload.__timeoutMs);
    const timeoutMs = requested > 0 ? requested : READ_LIMIT_MS;
    let timer = null;
    const timed = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        const read = FS.isReadAction ? FS.isReadAction(action) : false;
        const err = new Error(read
          ? '读取超时，列表没有载入。请稍后重新打开本页。这次失败只表示没有读到数据。'
          : '请求超时，接口没有返回写入结果。请先核对列表里是否已有这次记录，不要立刻再次提交。');
        err.code = 'TIMEOUT';
        err.intent = read ? 'read' : 'write';
        err.action = action || '';
        reject(err);
      }, timeoutMs);
    });
    const request = Promise.resolve(requestApi(action, payload, file)).finally(function () {
      clearTimeout(timer);
    });
    return Promise.race([request, timed]);
  }

  function visibleIdentityReasons(reasons) {
    const out = [];
    (Array.isArray(reasons) ? reasons : []).forEach(function (reason) {
      const code = IDENTITY_REASON_CODES[reason] ? String(reason) : 'other';
      if (out.indexOf(code) < 0) out.push(code);
    });
    if (!out.length) out.push('other');
    return out;
  }

  function rejectionText() {
    return RELEASE_REJECTED + ' 原因：' + visibleIdentityReasons(releaseReasons).join('、');
  }

  function viewErrorText(err) {
    const message = err && err.message ? String(err.message) : '读取没有完成。';
    const code = err && err.code ? String(err.code) : '';
    const closed = Rules && Rules.previewReplayClosedText && Rules.previewReplayClosedText(code);
    if (closed) return closed;
    if (!err || PAGE_ERROR_CODES[code] || err.intent === 'read' || err.intent === 'write' || err.intent === 'login') {
      return message;
    }
    if (err.status || code) return '接口返回错误：' + message;
    return message;
  }
  let financeTab = 'statements';
  let selectedMonth = '';
  let asOf = '';
  let selectedContract = null;
  let invoiceCsvByNo = {};
  let renderToken = 0;
  const Rules = window.FSRules;

  function alive(token) {
    return token === renderToken;
  }

  function showStatus(message, type) {
    const el = document.getElementById('status');
    if (!el) return;
    el.className = 'status' + (message ? ' show ' + (type || 'info') : '');
    el.textContent = message || '';
  }

  function clearStaleDanger() {
    const el = document.getElementById('status');
    if (!el || !el.classList.contains('danger')) return;
    showStatus('', '');
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function newRequestId(prefix) {
    return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function sha256Hex(file) {
    if (!crypto || !crypto.subtle || !file) throw new Error('无法在本页核对文件内容。已停止，没有提交。');
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function hongKongYmd(now) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Hong_Kong',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now || new Date());
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isUnconfirmedWrite(err) {
    return !!(err && err.intent === 'write' && (err.code === 'TIMEOUT' || err.code === 'NETWORK' || err.code === 'BAD_RESPONSE'));
  }

  function uploadUnconfirmedError(kind) {
    const text = kind === 'missing'
      ? '上传请求没有在时限内返回。已回读资料台账，没有找到本次文件，因此本次可能尚未保存。请稍后重新打开资料页核对，不要立刻再次上传。'
      : kind === 'ambiguous'
        ? '上传请求没有在时限内返回。资料台账里有不止一条与本次文件相符的记录，无法确定编号。请打开列表核对，不要再次上传。'
        : '上传请求没有在时限内返回，回读资料台账也没有成功，所以还不能判断这次文件是否已经入账。请稍后重新打开资料页核对，不要立刻再次上传。';
    const err = new Error(text);
    err.code = kind === 'missing' ? 'UPLOAD_NOT_ON_LEDGER' : kind === 'ambiguous' ? 'UPLOAD_AMBIGUOUS' : 'UPLOAD_RECONCILE_FAILED';
    return err;
  }

  async function confirmUploadedFile(hint, knownIds) {
    let sawLedger = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await delay(2000);
      try {
        const data = await api('getDocuments', { __timeoutMs: 40000 });
        sawLedger = true;
        const judged = FS.reconcileUploadedFile((data && data.files) || [], hint, knownIds);
        if (judged && judged.status && judged.status !== 'missing') return judged;
      } catch (err) {
        if (err && err.status === 401) throw err;
        const transport = err && (err.code === 'TIMEOUT' || err.code === 'NETWORK' || err.code === 'BAD_RESPONSE');
        if (!transport) throw err;
      }
    }
    if (sawLedger) return { status: 'missing', file: null };
    return { status: 'unverified', file: null };
  }

  function ym(value) {
    return Rules.canonYearMonth(value);
  }

  async function withSubmit(btn, fn) {
    if (!btn || btn.dataset.busy === '1') return null;
    btn.dataset.busy = '1';
    const prev = btn.textContent;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = '正在提交…';
    showStatus('正在提交，请稍候。', 'info');
    try {
      return await fn();
    } catch (err) {
      showStatus(viewErrorText(err), 'danger');
      return null;
    } finally {
      if (btn.isConnected) {
        if (btn.dataset.hold === '1') {
          btn.disabled = true;
          btn.setAttribute('aria-disabled', 'true');
          btn.removeAttribute('aria-busy');
          btn.textContent = '请先核对列表';
        } else {
          btn.dataset.busy = '0';
          btn.disabled = false;
          btn.removeAttribute('aria-busy');
          btn.textContent = prev;
        }
      }
    }
  }

  const TITLES = {
    dashboard: '总览看板',
    plans: '每月经营计划',
    proposals: '运营策划书',
    documents: '资料与凭证',
    finance: '月账与四套账',
    contracts: '合同与发票',
    logs: '操作日志',
  };

  function currentView() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    if (/^(plans|proposals|documents|finance|contracts|logs)$/.test(h)) return h;
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const m = path.match(/\/admin\/(plans|proposals|documents|finance|contracts|logs)/);
    if (m) return m[1];
    return 'dashboard';
  }

  function setNav(view) {
    titleEl.textContent = TITLES[view] || '总览看板';
    document.querySelectorAll('#nav a').forEach((a) => {
      a.classList.toggle('active', a.getAttribute('data-view') === view);
    });
  }

  function alertBox(type, html) {
    return `<div class="alert ${type}">${html}</div>`;
  }

  function applyPreviewChrome() {
    const banner = document.querySelector('.preview-banner');
    if (banner) {
      banner.innerHTML = '<span>趣倉有限公司 · 一体化公司管理后台 · <strong>正式预览</strong></span><span>此为正式预览，不是真实运营 · 期初待确认，禁止正式记账 · 财务定稿已关闭 · 对客正式合同生成已关闭</span>';
    }
    const foot = document.querySelector('.side .foot');
    if (foot) foot.textContent = '一户一套：一本独立表、一个专属文件夹、一套接口。正式预览，不是真实运营。期初待确认，禁止正式记账。财务定稿已关闭。';
  }

  function applyRejectedChrome() {
    const banner = document.querySelector('.preview-banner');
    if (banner) {
      banner.innerHTML = '<span>趣倉有限公司 · 一体化公司管理后台</span><span>' + RELEASE_REJECTED + '</span>';
    }
    const foot = document.querySelector('.side .foot');
    if (foot) foot.textContent = RELEASE_REJECTED;
    const gate = document.getElementById('gate-note');
    if (gate) gate.textContent = RELEASE_REJECTED;
  }

  function applyOfficialChrome() {
    const banner = document.querySelector('.preview-banner');
    if (banner) {
      banner.innerHTML = '<span>趣倉有限公司 · 一体化公司管理后台</span><span>财务定稿已关闭 · 对客正式合同生成已关闭</span>';
    }
    const foot = document.querySelector('.side .foot');
    if (foot) foot.textContent = '一户一套：一本独立表、一个专属文件夹、一套接口。期初待确认，禁止正式记账。财务定稿已关闭。';
  }

  function applyReleaseMarker(data, decision) {
    const marker = document.getElementById('build-marker');
    if (!marker) return;
    if (decision && decision.ok && decision.profile === 'official') {
      marker.textContent = (data && data.buildId || '未返回') + ' · ' + (data && data.dataMode || '未返回') + ' · 正式数据';
      applyOfficialChrome();
      return;
    }
    if (!decision || !decision.ok) {
      const buildId = data && data.buildId ? String(data.buildId) : '未返回';
      const dataMode = data && data.dataMode ? String(data.dataMode) : '未返回';
      const flag = data && Object.prototype.hasOwnProperty.call(data, 'productionData') ? String(data.productionData) : '未返回';
      marker.textContent = buildId + ' · ' + dataMode + ' · ' + flag + ' · 已拒绝';
      return;
    }
    if (decision.profile === 'preview') applyPreviewChrome();
    const head = (data && data.buildId || '未返回') + ' · ' + (data && data.dataMode || '未返回') + ' · ' + (data && data.productionData === false ? '非生产数据' : 'productionData 不是 false');
    marker.textContent = head + ' · 正式预览';
  }

  async function boot() {
    try {
      const data = await api('me');
      const decision = (Rules && Rules.identityDecision)
        ? Rules.identityDecision(data, window.AC02_BUILD || {})
        : { ok: false, reasons: ['missing-check'] };
      applyReleaseMarker(data, decision);
      const targets = document.getElementById('target-marker');
      if (targets && window.FSRules && FSRules.describeRelease) {
        const described = FSRules.describeRelease(data);
        targets.dataset.state = described.state;
        targets.textContent = described.text;
      }
      if (!decision.ok) {
        releaseState = 'rejected';
        releaseReasons = decision.reasons || [];
        applyRejectedChrome();
        showStatus(rejectionText(), 'danger');
        viewEl.innerHTML = alertBox('danger', E(rejectionText()));
        return;
      }
      releaseState = 'accepted';
      releaseReasons = [];
      identityProfile = decision.profile || '';
      signedSession = data;
      me = data.user;
      asOf = data.asOf || '';
      whoEl.textContent = `${me.displayName} · ${me.role} · ${me.jobId}`;
      const gate = document.getElementById('gate-note');
      if (gate) {
        if (decision.profile === 'official') {
          gate.textContent = data.openingConfirmed
            ? '期初已确认。财务定稿已关闭，不因配平或完成页放行。对客正式合同生成已关闭。'
            : '期初待确认，禁止正式记账。财务定稿已关闭。对客正式合同生成已关闭。';
        } else {
          gate.textContent = data.openingConfirmed
            ? '正式预览，不是真实运营。期初已确认。财务定稿已关闭，不因配平或完成页放行。对客正式合同生成已关闭。'
            : '正式预览，不是真实运营。期初待确认，禁止正式记账。财务定稿已关闭。对客正式合同生成已关闭。';
        }
      }
      await render();
    } catch (e) {
      const q = (e && e.code === 'AUTH_STORE_MISSING') ? '?err=auth_store' : '';
      location.replace((FS.adminBase ? FS.adminBase() : '/admin') + '/login.html' + q);
    }
  }

  document.getElementById('logout').addEventListener('click', async () => {
    try { await api('logout'); } catch (e) { /* ignore */ }
    location.replace((FS.adminBase ? FS.adminBase() : '/admin') + '/login.html');
  });

  let historyRouteRendered = null;
  function historyRoute() {
    return location.pathname + location.search + location.hash;
  }
  function renderFromHistory() {
    const route = historyRoute();
    if (route === historyRouteRendered) return;
    historyRouteRendered = route;
    render();
  }
  window.addEventListener('popstate', renderFromHistory);
  window.addEventListener('hashchange', renderFromHistory);
  document.getElementById('nav').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    const hash = href.includes('#') ? href.slice(href.indexOf('#')) : '';
    if (hash) {
      e.preventDefault();
      if (location.hash !== hash) location.hash = hash;
      else render();
      return;
    }
    e.preventDefault();
    history.pushState({}, '', href);
    render();
  });

  document.getElementById('back').addEventListener('click', () => {
    if (currentView() !== 'dashboard') {
      location.hash = '#dashboard';
      return;
    }
    location.href = '../index.html';
  });

  function showIdentityPending() {
    viewEl.innerHTML = alertBox('info', E(IDENTITY_PENDING));
  }

  async function render() {
    const view = currentView();
    setNav(view);
    if (releaseState === 'pending') {
      showIdentityPending();
      return;
    }
    if (releaseState !== 'accepted') {
      viewEl.innerHTML = alertBox('danger', E(rejectionText()));
      return;
    }
    clearStaleDanger();
    const token = ++renderToken;
    viewEl.innerHTML = '<p class="muted" role="status" data-read-state="loading">正在读取…</p>';
    const slowTimer = setTimeout(function () {
      if (!alive(token)) return;
      const node = viewEl.querySelector('[data-read-state="loading"]');
      if (!node) return;
      node.textContent = '仍在读取。这一步有时要将近 20 秒，请稍候。';
    }, READ_SLOW_MS);
    try {
      if (view === 'dashboard') await renderDashboard(token);
      else if (view === 'plans') await renderPlans(token);
      else if (view === 'proposals') await renderProposals(token);
      else if (view === 'documents') await renderDocuments(token);
      else if (view === 'finance') await renderFinance(token);
      else if (view === 'contracts') await renderContracts(token);
      else if (view === 'logs') await renderLogs(token);
      if (!alive(token)) return;
      const stillLoading = viewEl.querySelector('[data-read-state="loading"]');
      if (stillLoading) {
        viewEl.innerHTML = alertBox('danger', E('读取没有完成。请稍后重新打开本页。'));
      }
    } catch (e) {
      if (!alive(token)) return;
      if (e.status === 401) return location.replace((FS.adminBase ? FS.adminBase() : '/admin') + '/login.html');
      viewEl.innerHTML = alertBox('danger', E(viewErrorText(e)));
    } finally {
      clearTimeout(slowTimer);
    }
  }

  async function renderDashboard(token) {
    const d = await api('getDashboard');
    if (!alive(token)) return;
    const monthLabel = d.currentYearMonth || ym(d.asOf) || '';
    const warns = (d.warnings || []).map((w) => `<li>${E(w.message)}</li>`).join('')
      || '<li class="muted">暂无跨月未完成两次以上的预警。</li>';
    const monthPlans = d.plansThisMonth || [];
    const emptyPlanText = (Rules && Rules.monthPlanEmptyText)
      ? Rules.monthPlanEmptyText(identityProfile, monthPlans)
      : (monthPlans.length ? '' : '本月尚未登记计划。');
    const planRows = emptyPlanText
      ? `<tr><td colspan="4" class="muted">${E(emptyPlanText)}</td></tr>`
      : monthPlans.map((p) =>
        `<tr><td>${E(p.type)}</td><td>${E(p.title)}</td><td>${E(p.planDate || '')}</td><td>${badge(p.status)}</td></tr>`
      ).join('');
    const m = d.month;
    const fin = m ? `${m.yearMonth} · 明细 ${m.lineCount} 条 · 已附 ${m.counts.已附原件} · 免原件 ${m.counts.免原件} · 暂记 ${m.counts.暂记往来} · 未处理 ${m.counts.未处理}<br>${m.ledgerGenerated ? (m.bankBalanced ? badge('银行侧已核对') : badge('未配平')) : badge('尚未生成明细账')} ${m.completionConfirmed ? badge('完成页已确认') : badge('未过完成页')} ${m.posted ? badge('已定稿') : badge('未定稿')}` : '尚未登记月账。';
    const cts = (d.contracts || []).map((c) => `<tr><td>${E(c.contractNo)}</td><td>${E(c.counterparty)}</td><td>${E(c.stage)}</td><td>${badge(c.status)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">暂无合同台账。</td></tr>';
    viewEl.innerHTML = `
      ${alertBox('info', '内部看板。当前月 ' + E(monthLabel) + '。计划、合同与月账按同一 YYYY-MM 键读取。')}
      <div class="grid cols-3">
        <div class="card"><div class="kpi">${E((d.plansThisMonth || []).length)}<small>当月计划事项</small></div></div>
        <div class="card"><div class="kpi">${E(d.pendingDocs + d.picsPending)}<small>待核验资料 / 待存证</small></div></div>
        <div class="card"><div class="kpi">${E((d.contracts || []).length)}<small>合同台账份数</small></div></div>
      </div>
      <div class="grid cols-2" style="margin-top:16px">
        <div class="card">
          <h3>法定与跨月预警</h3>
          <ul>${warns}</ul>
        </div>
        <div class="card">
          <h3>财务摘要</h3>
          <p>${fin}</p>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <h3>当月计划完成情况</h3>
        <table><thead><tr><th>类型</th><th>事项</th><th>计划日期</th><th>状态</th></tr></thead><tbody>${planRows}</tbody></table>
      </div>
      <div class="card" style="margin-top:16px">
        <h3>合同状态</h3>
        <table><thead><tr><th>合同号</th><th>对方</th><th>环节</th><th>状态</th></tr></thead><tbody>${cts}</tbody></table>
      </div>`;
  }

  async function renderPlans(token) {
    const d = await api('getPlans');
    if (!alive(token)) return;
    const warn = (d.warnings || []).map((w) => E(w.message)).join('<br>');
    const advisor = me.role === '顾问';
    const rows = (d.plans || []).map((p) => `<tr>
      <td>${E(p.yearMonth)}</td><td>${badge(p.type)}</td><td>${E(p.title)}</td>
      <td>${E(p.planDate || '')}</td><td>${E(p.owner || '')}</td><td>${badge(p.status)}</td>
      <td>${E(p.feedback || '')}</td>
      <td class="right">
        ${advisor ? `<button class="btn small ghost" data-act="toggle" data-id="${E(p.id)}" data-status="${p.status === '已完成' ? '未完成' : '已完成'}">${p.status === '已完成' ? '标为未完成' : '标为已完成'}</button>` : ''}
        <button class="btn small ghost" data-act="fb" data-id="${E(p.id)}">回馈</button>
      </td>
    </tr>`).join('');
    viewEl.innerHTML = `
      ${warn ? alertBox('warn', warn) : alertBox('ok', '目前没有「跨月未完成两次以上」的预警。')}
      ${advisor ? `<div class="card" style="margin-bottom:16px">
        <h3>下达或补充计划</h3>
        <form id="plan-form">
          <div class="form-row">
            <div class="field"><label>年月</label><input name="yearMonth" placeholder="2026-11" required pattern="\\d{4}-\\d{2}" title="YYYY-MM"></div>
            <div class="field"><label>类型</label><select name="type"><option>固定</option><option>灵活</option></select></div>
            <div class="field"><label>事项</label><input name="title" required></div>
            <div class="field"><label>计划日期</label><input name="planDate" placeholder="2026-10-28"></div>
            <div class="field"><label>负责人</label><input name="owner"></div>
          </div>
          <div class="field"><label>备注</label><input name="notes"></div>
          <button class="btn teal small" type="submit">保存</button>
        </form>
      </div>` : alertBox('info', '顾问下达固定计划与灵活计划。你可查看并提交回馈。月底应做复盘。')}
      <div class="card">
        <h3>计划一览（固定 + 灵活）</h3>
        <table>
          <thead><tr><th>年月</th><th>类型</th><th>事项</th><th>计划日期</th><th>负责人</th><th>状态</th><th>回馈</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="8" class="muted">暂无计划。</td></tr>'}</tbody>
        </table>
      </div>`;
    const form = document.getElementById('plan-form');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      if (!form.dataset.req) form.dataset.req = newRequestId('PL');
      const fd = new FormData(form);
      const payload = Object.fromEntries(fd.entries());
      payload.yearMonth = ym(payload.yearMonth);
      payload.clientRequestId = form.dataset.req;
      payload.__timeoutMs = 20000;
      if (!payload.yearMonth) {
        showStatus('年月须为 YYYY-MM。', 'danger');
        return;
      }
      withSubmit(btn, async () => {
        const out = await api('savePlan', payload);
        showStatus('计划已保存 ' + out.plan.id + ' · ' + out.plan.yearMonth + (out.idempotentReplay ? '（同一请求号，未重复新增）' : ''), 'ok');
        form.dataset.req = '';
        form.reset();
        await render();
      });
    });
    viewEl.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        withSubmit(btn, async () => {
          await api('savePlan', { id: btn.dataset.id, status: btn.dataset.status, __timeoutMs: 20000 });
          showStatus(btn.dataset.status === '已完成' ? '已标为完成。' : '已标为未完成。', 'ok');
          await render();
        });
      });
    });
    viewEl.querySelectorAll('[data-act="fb"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const feedback = prompt('请填写回馈（将写入该计划事项）：');
        if (feedback == null) return;
        withSubmit(btn, async () => {
          await api('savePlan', { mode: 'feedback', id: btn.dataset.id, feedback, __timeoutMs: 20000 });
          showStatus('回馈已保存。', 'ok');
          await render();
        });
      });
    });
  }

  async function renderProposals(token) {
    const d = await api('getProposals');
    if (!alive(token)) return;
    const advisor = me.role === '顾问';
    const rows = (d.proposals || []).map((p) => `<tr>
      <td>${E(p.id)}</td><td>${E(p.title)}</td><td>${E(p.yearMonth)}</td>
      <td>${badge(p.status)}</td><td>${E(p.date)}</td>
      <td>${p.fileId ? FS.fileLink(p.fileId, p, '查阅') : '—'}</td>
    </tr>`).join('');
    viewEl.innerHTML = `
      <p class="muted">顾问上传的公司运营策划书在此归档。客户可查阅，不把技能文件直接交给客户。</p>
      ${advisor ? `<div class="card" style="margin-bottom:16px">
        <h3>上传策划书</h3>
        <form id="pr-form">
          <div class="form-row">
            <div class="field"><label>标题</label><input name="title" required></div>
            <div class="field"><label>适用年月</label><input name="yearMonth" placeholder="2026-10"></div>
            <div class="field"><label>文件</label><input name="file" type="file" required></div>
          </div>
          <button class="btn teal small" type="submit">上传并归档</button>
        </form>
      </div>` : ''}
      <div class="card">
        <h3>已归档策划书</h3>
        <table><thead><tr><th>编号</th><th>标题</th><th>年月</th><th>状态</th><th>日期</th><th>文件</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">暂无策划书。</td></tr>'}</tbody></table>
      </div>`;
    const form = document.getElementById('pr-form');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      if (!form.dataset.req) form.dataset.req = newRequestId('PR');
      const fd = new FormData(form);
      const yearMonth = ym(fd.get('yearMonth'));
      if (fd.get('yearMonth') && !yearMonth) {
        showStatus('适用年月须为 YYYY-MM。', 'danger');
        return;
      }
      withSubmit(btn, async () => {
        const out = await api('uploadProposal', {
          title: fd.get('title'),
          yearMonth: yearMonth,
          clientRequestId: form.dataset.req,
          __timeoutMs: 25000
        }, fd.get('file'));
        showStatus('策划书已归档 ' + out.proposal.id + ' · 文件 ' + out.file.id, 'ok');
        form.dataset.req = '';
        await render();
      });
    });
  }

  async function renderDocuments(token) {
    const d = await api('getDocuments');
    if (!alive(token)) return;
    const files = (d.files || []).map((f) => `<tr>
      <td>${E(f.id)}</td><td>${E(f.date)}</td><td>${E(f.category)}</td><td>${E(f.name)}</td>
      <td>${E(f.relatedId || '—')}</td>
      <td>${E(f.source)}</td><td>${badge(f.status)}</td>
      <td>${(f.claimedBy || []).map((c) => E((c.module || '') + (c.role ? '/' + c.role : ''))).join('、') || '尚未被其他模块认领'}</td>
      <td>${FS.fileHref(f.id, f) ? FS.fileLink(f.id, f, '打开') : '—'}</td>
    </tr>`).join('');
    const pics = (d.pics || []).map((p) => `<tr>
      <td>${E(p.id)}</td><td>${E(p.date)}</td><td>${E(p.role)}</td><td>${E(p.version)}</td>
      <td>${p.acknowledged ? badge('已勾选') : badge('未勾选')}</td><td>${E(p.digest)}</td>
    </tr>`).join('');
    const knownIds = (d.files || []).map((f) => f && f.id).filter(Boolean);
    viewEl.innerHTML = `
      ${alertBox('info', '同一文件只上传一次。月账、合同等模块只认领和关联，不因引用再记一笔账，也不再要求重传。')}
      <div class="card" style="margin-bottom:16px">
        <h3>上传资料或凭证</h3>
        <form id="doc-form">
          <div class="form-row">
            <div class="field"><label>类别</label>
              <select name="category">
                <option>收件</option><option>银行月结单</option><option>银行凭证</option>
                <option>合同签署正本</option><option>发票</option><option>其他</option>
              </select>
            </div>
            <div class="field"><label>关联编号（可选）</label><input name="relatedId" placeholder="流水号或合同号"></div>
            <div class="field"><label>文件</label><input name="file" type="file" required></div>
          </div>
          <button class="btn teal small" type="submit">上传</button>
        </form>
      </div>
      ${identityProfile !== 'official' && me && me.role === '顾问' ? `<div class="card" id="replay-card" style="margin-bottom:16px">
        <h3>同一请求号重放（仅正式预览、仅一条虚构资料）</h3>
        <p>此为正式预览，不是真实运营。这里只重放已经归档的一条虚构资料。请求号、类别和关联编号都不能改，也不能用来重放其他文件。</p>
        <p>请求号 ${E(Rules.PREVIEW_REPLAY.clientRequestId)} · 预期 fileId ${E(Rules.PREVIEW_REPLAY.fileId)} · 文件 ${E(Rules.PREVIEW_REPLAY.fileName)} · ${E(Rules.PREVIEW_REPLAY.size)} 字节 · 类别 ${E(Rules.PREVIEW_REPLAY.category)} · 关联 ${E(Rules.PREVIEW_REPLAY.relatedId)}</p>
        <form id="replay-form">
          <div class="field"><label>选择那一份原始虚构 PDF</label><input name="file" type="file" accept="application/pdf,.pdf" required></div>
          <button class="btn small" type="submit">重放这一条</button>
        </form>
        <p id="replay-result" class="hint" role="status"></p>
      </div>` : ''}
      ${identityProfile === 'official' ? '' : `<div class="card" style="margin-bottom:16px">
        <h3>隐私声明存证（双向）</h3>
        <p class="muted">客户递交经营资料时应勾选并留下存证。顾问回传报告亦可在此记录。</p>
        <button class="btn small" id="pics-btn" type="button">勾选预览版隐私声明并存证</button>
        <table style="margin-top:12px"><thead><tr><th>编号</th><th>日期</th><th>角色</th><th>版本</th><th>勾选</th><th>摘要</th></tr></thead>
        <tbody>${pics || '<tr><td colspan="6" class="muted">尚无存证。</td></tr>'}</tbody></table>
      </div>`}
      <div class="card">
        <h3>资料与凭证台账</h3>
        <table><thead><tr><th>编号</th><th>日期</th><th>类别</th><th>文件名</th><th>关联编号</th><th>来源</th><th>状态</th><th>被认领</th><th></th></tr></thead>
        <tbody>${files || '<tr><td colspan="9" class="muted">暂无文件。</td></tr>'}</tbody></table>
      </div>`;
    document.getElementById('doc-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target;
      const btn = form.querySelector('button[type="submit"]');
      if (!form.dataset.req) form.dataset.req = newRequestId('FL');
      const fd = new FormData(form);
      const file = fd.get('file');
      const hint = {
        clientRequestId: form.dataset.req,
        name: file && file.name || '',
        category: String(fd.get('category') || ''),
        relatedId: String(fd.get('relatedId') || ''),
        size: file && file.size != null ? file.size : '',
        uploadedBy: me && me.jobId || '',
        date: hongKongYmd()
      };
      withSubmit(btn, async () => {
        let out;
        try {
          out = await api('uploadDocument', {
            category: hint.category,
            relatedId: hint.relatedId,
            clientRequestId: hint.clientRequestId,
            __timeoutMs: 25000
          }, file);
        } catch (err) {
          if (err && err.status === 401) throw err;
          if (!isUnconfirmedWrite(err)) throw err;
          if (btn.isConnected) btn.textContent = '正在核对台账…';
          showStatus('上传请求没有及时返回，正在只读核对资料台账…', 'info');
          const judged = await confirmUploadedFile(hint, knownIds);
          if (!judged || judged.status !== 'found' || !judged.file) {
            btn.dataset.hold = '1';
            const input = form.querySelector('input[type="file"]');
            if (input) input.value = '';
            throw uploadUnconfirmedError(judged && judged.status);
          }
          out = { file: judged.file, relatedId: judged.file.relatedId || '', reconciled: true };
        }
        const echoed = out.relatedId || (out.file && out.file.relatedId) || '';
        showStatus('资料已归档 ' + out.file.id + (echoed ? ' · 关联编号 ' + echoed : ' · 未填写关联编号') + (out.reconciled ? '。回读台账已确认，请不要再次上传。' : ''), 'ok');
        form.dataset.req = '';
        await render();
      });
    });
    const replayForm = document.getElementById('replay-form');
    if (replayForm) replayForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = replayForm.querySelector('button[type="submit"]');
      if (!btn || btn.dataset.busy === '1') return;
      const file = new FormData(replayForm).get('file');
      const resultEl = document.getElementById('replay-result');
      const showReplay = (text, type) => {
        if (resultEl) resultEl.textContent = text;
        showStatus(text, type);
      };
      btn.dataset.busy = '1';
      btn.disabled = true;
      (async () => {
        try {
          if (!file || !file.name) {
            showReplay(Rules.previewReplayRefusal(['file-missing']), 'danger');
            return;
          }
          const sha256 = await sha256Hex(file);
          const plan = Rules.previewReplayGate({
            session: signedSession,
            page: window.AC02_BUILD || {},
            role: me && me.role,
            file: { name: file.name, size: file.size, sha256: sha256 }
          });
          if (!plan.ok || !plan.request) {
            showReplay(Rules.previewReplayRefusal(plan.reasons), 'danger');
            return;
          }
          const out = await api('uploadDocument', {
            category: plan.request.category,
            relatedId: plan.request.relatedId,
            clientRequestId: plan.request.clientRequestId,
            __timeoutMs: 25000
          }, file);
          const verdict = Rules.previewReplayVerdict(out);
          showReplay(Rules.previewReplayText(verdict), verdict.ok ? 'ok' : 'danger');
        } catch (err) {
          showReplay(err ? viewErrorText(err) : '重放没有完成。已停止，没有再次提交。', 'danger');
        } finally {
          if (btn.isConnected) {
            btn.dataset.busy = '0';
            btn.disabled = false;
          }
        }
      })();
    });
    const picsBtn = document.getElementById('pics-btn');
    if (picsBtn) picsBtn.addEventListener('click', () => {
      const btn = document.getElementById('pics-btn');
      if (!btn) return;
      withSubmit(btn, async () => {
        await api('acknowledgePics', { version: 'AC02-PICS-PREVIEW-v0.1', __timeoutMs: 20000 });
        showStatus('隐私声明存证已记录。', 'ok');
        await render();
      });
    });
  }

  async function renderLogs(token) {
    const d = await api('getLogs');
    if (!alive(token)) return;
    const rows = (d.logs || []).map((l) => `<tr>
      <td>${E(l.time)}</td><td>${E(l.actor)}</td><td>${E(l.action)}</td>
      <td>${E(String(l.target || '').replace(/^YM:/, ''))}</td><td>${badge(l.result)}</td><td>${E(l.notes)}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无日志。</td></tr>';
    viewEl.innerHTML = `
      ${alertBox('info', '操作日志只记录动作与结果，不写入明文口令或其他密钥。')}
      <div class="card">
        <h3>最近操作</h3>
        <table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>结果</th><th>备注</th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>`;
  }

  async function renderFinance(token) {
    if (!selectedMonth) {
      const listing = await api('getMonth', {});
      if (!alive(token)) return;
      const months = (listing.months || []).map(ym).filter(Boolean);
      selectedMonth = months.length ? months[months.length - 1] : ym(asOf);
    }
    selectedMonth = ym(selectedMonth);
    if (!selectedMonth) {
      if (!alive(token)) return;
      viewEl.innerHTML = alertBox('danger', '年月须为 YYYY-MM。');
      return;
    }
    let d = await api('getMonth', { yearMonth: selectedMonth });
    if (!alive(token)) return;
    const looksEmpty = !((d.month.cashItems || []).length) && !((d.month.statements || []).length) && !d.month.ledgerGenerated;
    if (looksEmpty) {
      const listing = await api('getMonth', {});
      if (!alive(token)) return;
      const alt = (listing.months || []).find((m) => ym(m) === selectedMonth && String(m) !== selectedMonth);
      if (alt) {
        const alias = await api('getMonth', { yearMonth: alt });
        if (!alive(token)) return;
        const aliasHas = ((alias.month.cashItems || []).length) || ((alias.month.statements || []).length) || alias.month.ledgerGenerated;
        if (aliasHas) d = alias;
      }
    }
    if (d.month) d.month.yearMonth = ym(d.month.yearMonth) || selectedMonth;
    const m = d.month;
    const tabBtn = (id, label) => `<button type="button" data-tab="${id}" class="${financeTab === id ? 'active' : ''}" aria-pressed="${financeTab === id ? 'true' : 'false'}">${label}</button>`;
    let body = '';
    if (financeTab === 'statements') body = renderStmtTab(d);
    else if (financeTab === 'ledger') body = renderLedgerTab(d);
    else if (financeTab === 'completion') body = renderCompletionTab(d);
    else body = renderFourTab(d);
    if (!alive(token)) return;

    viewEl.innerHTML = `
      <div class="toolbar">
        <label for="ym">月份 <input id="ym" value="${E(selectedMonth)}" inputmode="numeric" aria-describedby="ym-hint" style="width:120px;padding:6px 8px;border:1px solid var(--line);border-radius:8px"></label>
        <button class="btn small ghost" id="load-ym" type="button">切换</button>
        <span id="ym-hint" class="muted">键 ${E(m.yearMonth)}</span>
        ${m.pastDeadline ? badge('已过提交限期 ' + m.deadline) : badge('限期 ' + m.deadline)}
        ${m.bankBalanced ? badge('银行侧已核对') : (m.ledgerGenerated ? badge('未配平') : badge('尚未生成明细账'))}
        ${m.completionConfirmed ? badge('完成页已确认') : badge('未过完成页')}
        ${m.posted ? badge('已定稿') : badge('未定稿')}
        ${d.openingConfirmed ? badge('期初已确认') : badge('期初未确认')}
      </div>
      ${alertBox('info', identityProfile === 'official'
        ? '以每月公司银行月结单为核对称梁。现金或第三方收支单笔不超过 2,000 港元、当月合计不超过 20,000 港元；金额须为正数。超限不得按本条直接进入第一本明细账。本版本未开放财务定稿。'
        : '以每月公司银行月结单为核对称梁。现金或第三方收支单笔不超过 2,000 港元、当月合计不超过 20,000 港元；金额须为正数。超限不得按本条直接进入第一本明细账。正式预览不提供财务定稿。')}
      <div class="tabs">
        ${tabBtn('statements', '1. 月结单与现金')}
        ${tabBtn('ledger', '2. 第一本明细账')}
        ${tabBtn('completion', '3. 完成页')}
        ${tabBtn('four', '4. 四套账与导出')}
      </div>
      ${body}`;

    document.getElementById('load-ym').addEventListener('click', () => {
      const next = ym(document.getElementById('ym').value.trim());
      if (!next) {
        showStatus('年月须为 YYYY-MM。', 'danger');
        return;
      }
      selectedMonth = next;
      render();
    });
    viewEl.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { financeTab = b.dataset.tab; render(); }));
    bindFinanceActions(d);
  }

  function renderStmtTab(d) {
    const stmts = (d.month.statements || []).map((s) => `
      <details class="block" open>
        <summary>${E(s.accountName)} · 开户 ${s.opening} → 结单 ${s.closing}${s.fileId ? ' · 已附月结单文件' : ''}${s.internalDiff ? ' · 轧差差额 ' + s.internalDiff : ''}</summary>
        <table><thead><tr><th>日期</th><th>摘要</th><th>方向</th><th>金额</th><th>对方</th><th>免原件类别</th></tr></thead>
        <tbody>${(s.lines || []).map((l) => `<tr><td>${E(l.date)}</td><td>${E(l.desc)}</td><td>${E(l.direction)}</td><td>${E(l.amount)}</td><td>${E(l.counterparty)}</td><td>${E(l.waiverCategory || '')}</td></tr>`).join('')}</tbody></table>
      </details>`).join('') || '<p class="muted">尚未登记银行月结单。</p>';
    const cash = (d.month.cashItems || []).map((c) =>
      `<tr><td>${E(c.id)}</td><td>${E(c.date)}</td><td>${E(c.desc)}</td><td>${E(c.direction)}</td><td>${E(c.amount)} ${E(c.currency)}</td><td>${E(c.counterparty)}</td></tr>`
    ).join('') || '<tr><td colspan="6" class="muted">尚未登记现金或第三方收支。</td></tr>';
    const rejected = (d.rejectedCash || []).map((r) => `<li>${E(r.at)} · ${E(r.desc)} · ${r.amount} 港元 · ${E(r.reason)}</li>`).join('');
    return `
      <div class="card" style="margin-bottom:16px">
        <h3>登记银行月结单（每账户一份）</h3>
        <form id="stmt-form">
          <div class="form-row">
            <div class="field"><label>账户名称</label><input name="accountName" value="${identityProfile === 'official' ? '' : '测试银行-港币往来（虚构）'}" required></div>
            <div class="field"><label>账户代号</label><input name="accountId" value="${identityProfile === 'official' ? '' : 'TEST-BANK-HKD'}" required></div>
            <div class="field"><label>期初余额</label><input name="opening" type="number" step="0.01" required></div>
            <div class="field"><label>月结单期末余额</label><input name="closing" type="number" step="0.01" required></div>
            <div class="field"><label>月结单文件（可改认领已上传文件编号）</label><input name="file" type="file"></div>
            <div class="field"><label>或认领文件编号</label><input name="fileId" placeholder="FL-..."></div>
          </div>
          <div class="field"><label>明细（每行：日期|摘要|收入或支出|金额|对方|免原件类别可选）</label>
            <textarea name="lines" rows="7" placeholder="2026-10-12|测试咨询费-测试客户甲（虚构）|收入|50000|测试客户甲（虚构）|&#10;2026-10-28|十月工资|支出|15000|员工（测试）|工资"></textarea>
          </div>
          <button class="btn teal small" type="submit">保存月结单</button>
        </form>
      </div>
      <div class="card" style="margin-bottom:16px">
        <h3>已登记月结单</h3>${stmts}
      </div>
      <div class="card" style="margin-bottom:16px">
        <h3>登记现金或第三方收支（月结单上看不到的事项）</h3>
        <form id="cash-form">
          <div class="form-row">
            <div class="field"><label for="cash-date">日期</label><input id="cash-date" name="date" required placeholder="2026-11-18" pattern="\\d{4}-\\d{2}-\\d{2}"></div>
            <div class="field"><label for="cash-desc">摘要</label><input id="cash-desc" name="desc" required></div>
            <div class="field"><label for="cash-direction">方向</label><select id="cash-direction" name="direction"><option>收入</option><option>支出</option></select></div>
            <div class="field"><label for="cash-amount">金额</label><input id="cash-amount" name="amount" type="number" step="0.01" min="0.01" max="2000" required inputmode="decimal" aria-describedby="cash-limit"></div>
            <div class="field"><label for="cash-currency">币种</label><input id="cash-currency" name="currency" value="HKD"></div>
            <div class="field"><label for="cash-party">对方</label><input id="cash-party" name="counterparty"></div>
          </div>
          <p id="cash-limit" class="hint">单笔不超过 2,000 港元，当月合计不超过 20,000 港元。金额须为正数；零和负数会在提交前被拒绝。</p>
          <button class="btn small" type="submit">登记</button>
        </form>
        <table style="margin-top:12px"><thead><tr><th>编号</th><th>日期</th><th>摘要</th><th>方向</th><th>金额</th><th>对方</th></tr></thead><tbody>${cash}</tbody></table>
        ${rejected ? `<div class="alert danger"><strong>被拒绝的超限登记（未入第一本明细账）：</strong><ul>${rejected}</ul></div>` : ''}
      </div>
      <button class="btn amber" id="gen-ledger" type="button">提交并生成第一本明细账</button>
      <p class="hint">银行侧余额须与月结单一致，才能继续。对不上则拒绝生成，不会把未配平说成已配平。</p>`;
  }

  function renderLedgerTab(d) {
    if (!d.month.ledgerGenerated) return alertBox('warn', '请先提交月结单与现金收支，生成第一本明细账。');
    if (!d.month.bankBalanced) return alertBox('danger', '银行侧与月结单对不上，不能继续处理附件，也不能定稿。');
    const filesOpts = (d.files || []).map((f) => `<option value="${E(f.id)}">${E(f.id)} · ${E(f.name)}</option>`).join('');
    const rows = (d.lines || []).map((l) => `<tr>
      <td>${E(l.id)}</td><td>${E(l.date)}</td><td>${E(l.desc)}</td><td>${E(l.direction)}</td>
      <td>${E(l.amountHkd)}</td><td>${E(l.source)}</td><td>${E(l.subject)}</td>
      <td>${l.voucherStatus ? badge(l.voucherStatus) : badge('未处理')}</td>
      <td>${l.fileId ? FS.fileLink(l.fileId, d.files, l.fileId) : '—'}</td>
      <td>
        <div class="right">
          <button class="btn small ghost" data-act="upload" data-id="${E(l.id)}">上传附件</button>
          <button class="btn small ghost" data-act="claim" data-id="${E(l.id)}">认领已有文件</button>
          <button class="btn small ghost" data-act="waive" data-id="${E(l.id)}">免原件</button>
          <button class="btn small ghost" data-act="suspense" data-id="${E(l.id)}">暂记往来</button>
        </div>
      </td>
    </tr>`).join('');
    return `
      <div class="card">
        <h3>第一本明细账（草稿）</h3>
        <p class="muted">每一条后面都可以上传附件；已传过的只认领。符合规定的可免原件。限期后既不能免又不能提供原件的，标暂记往来，不得删除，也不得因此与月结单对不上。</p>
        <input type="file" id="hidden-file" style="display:none">
        <select id="claim-file" style="display:none">${filesOpts}</select>
        <table>
          <thead><tr><th>流水号</th><th>日期</th><th>摘要</th><th>方向</th><th>折港币</th><th>来源</th><th>科目</th><th>凭证状态</th><th>文件</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderCompletionTab(d) {
    const list = (rows) => rows.length ? rows.map((l) => `<tr><td>${E(l.id)}</td><td>${E(l.date)}</td><td>${E(l.desc)}</td><td>${E(l.direction)}</td><td>${E(l.amountHkd)}</td><td>${E(l.counterparty)}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">无</td></tr>';
    const g = d.groups || {};
    const unfinished = (g.未处理 || []).length;
    const decision = Rules.completionDecision({
      ledgerGenerated: !!d.month.ledgerGenerated,
      bankBalanced: !!d.month.bankBalanced,
      unfinished: unfinished
    });
    const confirmHint = decision.allowed
      ? (identityProfile === 'official' ? '确认后仍不能定稿，本版本不写入正式四套账。' : '确认后仍不能定稿。正式预览不写入正式四套账。')
      : E(decision.reasons.join(' '));
    const confirmBtn = d.month.completionConfirmed ? '' : `<button class="btn amber" id="confirm-done" type="button" ${decision.allowed ? '' : 'disabled'} aria-disabled="${decision.allowed ? 'false' : 'true'}">确认完成页</button><p class="hint">${confirmHint}</p>`;
    return `
      ${!d.month.ledgerGenerated ? alertBox('warn', '尚未生成第一本明细账，不能进入完成页。') : ''}
      ${d.month.ledgerGenerated && !d.month.bankBalanced ? alertBox('danger', '银行侧与月结单对不上，不能确认完成页，也不能定稿。') : ''}
      ${unfinished ? alertBox('danger', `尚有 ${unfinished} 条未处理，不能确认完成页。`) : (decision.allowed ? alertBox('ok', identityProfile === 'official' ? '三类均已列明。本版本未开放财务定稿。' : '三类均已列明。正式预览仍禁止财务定稿。') : '')}
      ${d.month.completionConfirmed ? alertBox('ok', '本月完成页已于 ' + E(d.month.completionConfirmedAt || '') + ' 确认。') : ''}
      <div class="card" style="margin-bottom:12px"><h3>已附原件（${(g.已附原件||[]).length}）</h3>
        <table><thead><tr><th>流水号</th><th>日期</th><th>摘要</th><th>方向</th><th>折港币</th><th>对方</th></tr></thead><tbody>${list(g.已附原件||[])}</tbody></table></div>
      <div class="card" style="margin-bottom:12px"><h3>免原件（${(g.免原件||[]).length}）</h3>
        <table><thead><tr><th>流水号</th><th>日期</th><th>摘要</th><th>方向</th><th>折港币</th><th>对方</th></tr></thead><tbody>${list(g.免原件||[])}</tbody></table></div>
      <div class="card" style="margin-bottom:12px"><h3>暂记往来（${(g.暂记往来||[]).length}）</h3>
        <p class="muted">已暂记的月份可以定稿，但导出须标明暂记项目；未获真凭证调整前，这些项目不作为已齐备的审计附件。</p>
        <table><thead><tr><th>流水号</th><th>日期</th><th>摘要</th><th>方向</th><th>折港币</th><th>对方</th></tr></thead><tbody>${list(g.暂记往来||[])}</tbody></table></div>
      ${confirmBtn}`;
  }

  function renderFourTab(d) {
    const postClosed = (Rules && Rules.previewFormalPostClosed)
      ? Rules.previewFormalPostClosed(undefined, identityProfile)
      : { allowed: false, reasons: [identityProfile === 'official' ? '本版本未开放财务定稿。' : '正式预览禁止财务定稿。'] };
    const groups = ['利润表', '资产负债表', '现金流量表', '流水明细'];
    const blocks = groups.map((t) => {
      const rows = (d.four || []).filter((r) => r.type === t);
      if (!rows.length) return `<div class="card" style="margin-bottom:12px"><h3>${t}</h3><p class="muted">尚未定稿，这里没有正式数。</p></div>`;
      return `<div class="card" style="margin-bottom:12px"><h3>${t}</h3>
        <table><thead><tr><th>项目</th><th>金额（港币）</th><th>含暂记</th><th>备注</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${E(r.item)}</td><td>${E(r.amountHkd)}</td><td>${r.hasSuspense ? badge('含暂记往来') : '—'}</td><td>${E(r.notes || '')}</td></tr>`).join('')}</tbody></table>
      </div>`;
    }).join('');
    const previewOk = d.month.ledgerGenerated && d.month.bankBalanced && d.month.completionConfirmed && !d.month.posted;
    const postNote = E(postClosed.reasons.join(' '));
    return `
      ${d.month.posted ? alertBox('ok', identityProfile === 'official'
        ? '本月已有定稿记录。本版本不写入正式四套账。含暂记往来的项目已在表内标明，不作为已齐备的审计附件。'
        : '本月已有定稿记录。正式预览不能再次写入正式四套账。含暂记往来的项目已在表内标明，不作为已齐备的审计附件。') : alertBox('info', postNote)}
      ${previewOk ? '<button class="btn teal" id="preview-four" type="button">预览四套账（不定稿，不写入）</button>' : '<button class="btn teal" id="preview-four" type="button" disabled aria-disabled="true">预览四套账（不定稿，不写入）</button>'}
      ${previewOk ? '<button class="btn ghost" id="export-four" type="button">下载四套账草稿 CSV</button>' : '<button class="btn ghost" id="export-four" type="button" disabled aria-disabled="true">下载四套账草稿 CSV</button>'}
      <button class="btn amber" id="post-four" type="button" disabled aria-disabled="true">定稿并写入正式四套账</button>
      <p class="hint" id="post-four-note">${postNote}</p>
      <div style="margin-top:16px">${blocks}</div>`;
  }

  function parseLines(text) {
    return String(text || '').split(/\n+/).map((row) => row.trim()).filter(Boolean).map((row) => {
      const [date, desc, direction, amount, counterparty, waiverCategory] = row.split('|').map((s) => (s || '').trim());
      return { date, desc, direction, amount: Number(amount), counterparty, waiverCategory };
    });
  }

  function bindFinanceActions(d) {
    const stmt = document.getElementById('stmt-form');
    if (stmt) stmt.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = stmt.querySelector('button[type="submit"]');
      const fd = new FormData(stmt);
      const accountName = String(fd.get('accountName') || '').trim();
      const accountId = String(fd.get('accountId') || '').trim();
      if (identityProfile === 'official' && (!accountName || !accountId)) {
        showStatus('请填写账户名称和账户代号。', 'danger');
        return;
      }
      const payload = {
        yearMonth: selectedMonth,
        accountName: accountName,
        accountId: accountId,
        opening: Number(fd.get('opening')),
        closing: Number(fd.get('closing')),
        currency: 'HKD',
        fileId: fd.get('fileId') || '',
        lines: parseLines(fd.get('lines')),
        __timeoutMs: 25000
      };
      const file = fd.get('file');
      withSubmit(btn, async () => {
        await api('addStatement', payload, file && file.size ? file : null);
        showStatus('月结单已保存 · ' + selectedMonth, 'ok');
        await render();
      });
    });
    const cash = document.getElementById('cash-form');
    if (cash) cash.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = cash.querySelector('button[type="submit"]');
      if (!cash.dataset.req) cash.dataset.req = newRequestId('CA');
      const fd = new FormData(cash);
      const date = String(fd.get('date') || '').trim();
      if (ym(date) !== selectedMonth) {
        showStatus('日期须落在所选年月 ' + selectedMonth + ' 内，并使用 YYYY-MM-DD。', 'danger');
        return;
      }
      const checked = Rules.checkCashAmount(fd.get('amount'));
      if (!checked.ok) {
        showStatus(checked.message, 'danger');
        return;
      }
      const currency = fd.get('currency') || 'HKD';
      if (String(currency).toUpperCase() === 'HKD') {
        const existing = (d.month.cashItems || []).reduce((sum, item) => sum + Number(item.amountHkd != null ? item.amountHkd : item.amount || 0), 0);
        const monthChecked = Rules.checkCashMonth(existing, checked.amount);
        if (!monthChecked.ok) {
          showStatus(monthChecked.message, 'danger');
          return;
        }
      }
      withSubmit(btn, async () => {
        const out = await api('addCashItem', {
          yearMonth: selectedMonth,
          date: date,
          desc: fd.get('desc'),
          direction: fd.get('direction'),
          amount: checked.amount,
          currency: currency,
          counterparty: fd.get('counterparty'),
          clientRequestId: cash.dataset.req,
          __timeoutMs: 20000
        });
        const rb = out.readback || {};
        if (!rb.listed) {
          showStatus('接口已返回，但本月列表未看到 ' + (rb.id || '') + '。请不要重复提交。', 'danger');
          return;
        }
        showStatus('现金已登记 ' + rb.id + ' · ' + rb.amount + ' ' + (rb.currency || '') + ' · ' + rb.yearMonth + (out.idempotentReplay ? '（同一请求号，未重复新增）' : ''), 'ok');
        cash.dataset.req = '';
        await render();
      });
    });
    const gen = document.getElementById('gen-ledger');
    if (gen) gen.addEventListener('click', () => {
      withSubmit(gen, async () => {
        await api('generateLedger', { yearMonth: selectedMonth, __timeoutMs: 20000 });
        financeTab = 'ledger';
        showStatus('已生成第一本明细账（工作底稿，不是正式定稿）。', 'ok');
        await render();
      });
    });
    const hidden = document.getElementById('hidden-file');
    viewEl.querySelectorAll('[data-act="upload"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        hidden.onchange = () => {
          const file = hidden.files[0];
          hidden.value = '';
          if (!file) return;
          withSubmit(btn, async () => {
            await api('attachVoucher', { lineId: btn.dataset.id, __timeoutMs: 25000 }, file);
            showStatus('已上传并关联明细 ' + btn.dataset.id, 'ok');
            await render();
          });
        };
        hidden.click();
      });
    });
    viewEl.querySelectorAll('[data-act="claim"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fileId = prompt('请输入要认领的文件编号（同一文件只传一次）：', (d.files && d.files[0] && d.files[0].id) || '');
        if (!fileId) return;
        withSubmit(btn, async () => {
          await api('attachVoucher', { lineId: btn.dataset.id, fileId, __timeoutMs: 20000 });
          showStatus('已认领 ' + fileId + ' → ' + btn.dataset.id, 'ok');
          await render();
        });
      });
    });
    viewEl.querySelectorAll('[data-act="waive"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        withSubmit(btn, async () => {
          await api('waiveOriginal', { lineId: btn.dataset.id, __timeoutMs: 20000 });
          showStatus('已标明免原件 ' + btn.dataset.id, 'ok');
          await render();
        });
      });
    });
    viewEl.querySelectorAll('[data-act="suspense"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        withSubmit(btn, async () => {
          await api('markSuspense', { lineId: btn.dataset.id, __timeoutMs: 20000 });
          showStatus('已标明暂记往来 ' + btn.dataset.id, 'ok');
          await render();
        });
      });
    });
    const conf = document.getElementById('confirm-done');
    if (conf) conf.addEventListener('click', () => {
      if (conf.disabled) {
        showStatus('完成页条件未满足，未提交。', 'danger');
        return;
      }
      withSubmit(conf, async () => {
        await api('confirmCompletion', { yearMonth: selectedMonth, __timeoutMs: 20000 });
        showStatus('完成页已确认。这还不是正式定稿。', 'ok');
        await render();
      });
    });
    const preview = document.getElementById('preview-four');
    if (preview) preview.addEventListener('click', () => {
      if (preview.disabled) {
        showStatus('预览条件未满足，未请求接口。', 'danger');
        return;
      }
      withSubmit(preview, async () => {
        const out = await api('previewFourStatements', { yearMonth: selectedMonth, __timeoutMs: 20000 });
        showStatus((out && out.documentStatus ? out.documentStatus + '。' : '') + ((out && out.summary) ? out.summary : '已生成预览，未定稿，未写入。'), 'info');
      });
    });
    const exp = document.getElementById('export-four');
    if (exp) exp.addEventListener('click', () => {
      if (exp.disabled) {
        showStatus('草稿导出条件未满足，未请求接口。', 'danger');
        return;
      }
      if (!exp.dataset.req) exp.dataset.req = newRequestId('EX');
      withSubmit(exp, async () => {
        const out = await api('exportFourStatementsDraft', {
          yearMonth: selectedMonth,
          format: 'csv',
          clientRequestId: exp.dataset.req,
          __timeoutMs: 20000
        });
        if (!out.csv || String(out.documentStatus) !== '模拟/草稿 非正式凭证' || out.formal === true) {
          showStatus('导出结果缺少草稿标记，已拒绝下载。', 'danger');
          return;
        }
        downloadText(out.filename || '四套账草稿.csv', out.csv);
        showStatus('已下载四套账草稿 CSV。' + out.documentStatus + '。未定稿。', 'ok');
      });
    });
    const post = document.getElementById('post-four');
    if (post) post.addEventListener('click', (event) => {
      event.preventDefault();
      post.disabled = true;
      post.setAttribute('aria-disabled', 'true');
      const closed = (Rules && Rules.previewFormalPostClosed)
        ? Rules.previewFormalPostClosed(undefined, identityProfile)
        : { allowed: false, reasons: [identityProfile === 'official' ? '本版本未开放财务定稿。' : '正式预览禁止财务定稿。'] };
      showStatus(closed.reasons.join(' ') || (identityProfile === 'official' ? '本版本未开放财务定稿。' : '正式预览禁止财务定稿。'), 'danger');
    });
  }

  async function renderContracts(token) {
    const d = await api('getContracts');
    if (!alive(token)) return;
    const list = d.contracts || [];
    const current = selectedContract ? list.find((c) => c.contractNo === selectedContract) : list[0];
    if (current) selectedContract = current.contractNo;
    const rows = list.map((c) => `<tr>
      <td><a href="#" data-open="${E(c.contractNo)}">${E(c.contractNo)}</a></td>
      <td>${E(c.counterparty)}</td><td>${E(c.type)}</td><td>${E(c.stage)}</td>
      <td>${badge(c.status)}</td><td>${E(c.amount)} ${E(c.currency)}</td>
    </tr>`).join('');
    const inv = (d.invoices || []).map((i) => `<tr>
      <td>${E(i.invoiceNo)}</td><td>${E(i.contractNo)}</td><td>${E(i.date)}</td>
      <td>${E(i.amount)} ${E(i.currency)}</td><td>${badge(i.status)}</td>
    </tr>`).join() && ''; // fix below
    const invoices = (d.invoices || []);
    invoiceCsvByNo = {};
    invoices.forEach((i) => { if (i && i.csv) invoiceCsvByNo[i.invoiceNo] = { csv: i.csv, filename: i.filename || (i.invoiceNo + '-草稿.csv') }; });
    const invRows = invoices.map((i) => `<tr>
      <td>${E(i.invoiceNo)}</td><td>${E(i.contractNo)}</td><td>${E(i.date)}</td>
      <td>${E(i.amount)} ${E(i.currency)}</td>
      <td>${badge(i.status || '模拟/草稿 非正式凭证')}</td>
      <td>${i.csv ? `<button class="btn small ghost" type="button" data-csv="${E(i.invoiceNo)}">下载草稿 CSV</button>` : '—'}</td>
    </tr>`).join('');
    viewEl.innerHTML = `
      ${alertBox('info', '对客正式合同生成入口已关闭。订单模块不存在：合同台账不是订单。发票只能生成「模拟/草稿 非正式凭证」，不能取得官方发票号。')}
      <div class="disabled-note" style="margin-bottom:16px">「生成正式合同文本」不可用。源码没有订单表、订单编号或订单动作。</div>
      <div class="card" style="margin-bottom:16px">
        <h3>新建合同台账（非正式文本）</h3>
        <form id="ct-form">
          <div class="form-row">
            <div class="field"><label>合同号</label><input name="contractNo" placeholder="AC02-TEST-C-001"></div>
            <div class="field"><label>${identityProfile === 'official' ? '对方名称' : '对方名称（须为虚构测试名称）'}</label><input name="counterparty" required></div>
            <div class="field"><label>类型</label><select name="type"><option>咨询技术</option><option>服务</option><option>销售</option><option>贸易</option></select></div>
            <div class="field"><label>金额</label><input name="amount" type="number" step="0.01" required></div>
            <div class="field"><label>首期金额</label><input name="firstAmount" type="number" step="0.01"></div>
            <div class="field"><label>约定首期日期</label><input name="firstDueDate" placeholder="2026-10-12"></div>
            <div class="field"><label>签署日期</label><input name="signedDate" placeholder="2026-10-08"></div>
          </div>
          <button class="btn teal small" type="submit">写入台账</button>
        </form>
      </div>
      <div class="card" style="margin-bottom:16px">
        <h3>合同一览</h3>
        <table><thead><tr><th>合同号</th><th>对方</th><th>类型</th><th>环节</th><th>状态</th><th>金额</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">暂无合同。</td></tr>'}</tbody></table>
      </div>
      ${current ? renderContractDetail(current, d.files || []) : ''}
      <div class="card">
        <h3>发票草稿（非正式）</h3>
        <p class="hint">订单：不存在。金额只取合同台账，或取已经写上同一合同号的收入记录。不计算税额，不分配官方发票号，不盖章。</p>
        ${current ? `<form id="inv-form">
          <div class="form-row">
            <div class="field"><label for="inv-contract">合同号</label><input id="inv-contract" name="contractNo" value="${E(current.contractNo)}" required></div>
            <div class="field"><label for="inv-line">收入记录编号（可选）</label><input id="inv-line" name="lineId" placeholder="CA- 或 JL-"></div>
            <div class="field"><label for="inv-file">已上传文件编号（可选）</label><input id="inv-file" name="fileId" placeholder="FL-"></div>
          </div>
          <button class="btn teal small" type="submit">生成发票草稿</button>
        </form>` : '<p class="muted">先写入合同台账，才能生成草稿。</p>'}
        <table style="margin-top:12px"><thead><tr><th>草稿编号</th><th>合同号</th><th>草稿日期</th><th>金额</th><th>状态</th><th></th></tr></thead>
        <tbody>${invRows || '<tr><td colspan="6" class="muted">暂无草稿。这里不会出现正式发票。</td></tr>'}</tbody></table>
      </div>`;
    bindContractActions(current);
  }

  function renderContractDetail(c, files) {
    const plan = (c.plan || []).map((p) => `<tr>
      <td>${E(p.title)}</td><td>${E(p.dueDate)}</td><td>${p.done ? badge('已完成') : badge('未完成')}</td>
      <td>${(p.fileIds || []).join('、') || '—'}</td><td>${E(p.confirmFileId || '—')}</td>
      <td><button class="btn small ghost" data-node="${E(p.id)}" data-kind="file">认领/上传文件</button>
          ${p.kind !== '收付款' ? `<button class="btn small ghost" data-node="${E(p.id)}" data-kind="confirm">双方确认</button>` : ''}
          <button class="btn small ghost" data-node="${E(p.id)}" data-kind="done">标为完成</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">进入执行后将按条款自动生成履约计划。</td></tr>';
    const fileOpts = files.map((f) => `${f.id}（${f.name}）`).join('， ');
    return `<div class="card" style="margin-bottom:16px">
      <h3>合同详情 ${E(c.contractNo)}</h3>
      <p>对方 ${E(c.counterparty)} · ${E(c.type)} · ${E(c.stage)} · ${badge(c.status)} · 金额 ${E(c.amount)} ${E(c.currency)} · 首期 ${E(c.firstAmount)}</p>
      <p class="muted">签署正本：${c.signedFileId ? E(c.signedFileId) : '未归档'} · 首期凭证：${c.firstVoucherFileId ? E(c.firstVoucherFileId) : '未归档'} · 协议文件：${c.agreementFileId ? E(c.agreementFileId) : '无'}</p>
      <div class="right" style="margin:10px 0">
        <button class="btn small" id="ct-signed" type="button">归档签署正本</button>
        <button class="btn small" id="ct-first" type="button">认领或上传首期凭证</button>
        <button class="btn small teal" id="ct-exec" type="button">尝试进入执行</button>
        <button class="btn small ghost" id="ct-pause" type="button">暂停（须协议）</button>
        <button class="btn small ghost" id="ct-close2" type="button">标为状态二（须协议）</button>
        <button class="btn small ghost" id="ct-close3" type="button">标为状态三（须协议）</button>
        <button class="btn small ghost" id="ct-settle" type="button">标为已解除待结算（须协议）</button>
      </div>
      <p class="hint">可认领的已上传文件：${E(fileOpts || '暂无')}</p>
      <h3>履约进度计划</h3>
      <table><thead><tr><th>节点</th><th>约定日期</th><th>状态</th><th>文件</th><th>双方确认</th><th></th></tr></thead>
      <tbody>${plan}</tbody></table>
    </div>`;
  }

  function bindContractActions(current) {
    const form = document.getElementById('ct-form');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      const fd = new FormData(form);
      const payload = Object.fromEntries(fd.entries());
      if (payload.firstAmount === '') delete payload.firstAmount;
      payload.__timeoutMs = 20000;
      withSubmit(btn, async () => {
        const out = await api('createContract', payload);
        selectedContract = out.contract.contractNo;
        showStatus('非正式台账已写入 ' + out.contract.contractNo + '。未生成对客正式合同。这不是订单。', 'ok');
        await render();
      });
    });
    viewEl.querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault(); selectedContract = a.getAttribute('data-open'); render();
    }));
    const invForm = document.getElementById('inv-form');
    if (invForm) invForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = invForm.querySelector('button[type="submit"]');
      if (!invForm.dataset.req) invForm.dataset.req = newRequestId('INV');
      const fd = new FormData(invForm);
      withSubmit(btn, async () => {
        const out = await api('createInvoiceDraft', {
          contractNo: fd.get('contractNo'),
          lineId: fd.get('lineId') || '',
          fileId: fd.get('fileId') || '',
          clientRequestId: invForm.dataset.req,
          __timeoutMs: 20000
        });
        const inv = out.invoice;
        if (!inv || inv.official === true || inv.status !== '模拟/草稿 非正式凭证' || !inv.csv || inv.csv.indexOf('模拟/草稿 非正式凭证') < 0) {
          showStatus('草稿结果不合格，未收下。', 'danger');
          return;
        }
        showStatus((out.idempotentReplay ? '同一来源未重复新增。' : '已生成发票草稿 ') + inv.invoiceNo + '。模拟/草稿 非正式凭证。', 'ok');
        invForm.dataset.req = '';
        await render();
      });
    });
    viewEl.querySelectorAll('[data-csv]').forEach((btn) => btn.addEventListener('click', () => {
      const pack = invoiceCsvByNo[btn.getAttribute('data-csv')];
      if (!pack || pack.csv.indexOf('模拟/草稿 非正式凭证') < 0) {
        showStatus('没有可下载的草稿，或文件缺少非正式标记。', 'danger');
        return;
      }
      downloadText(pack.filename, pack.csv);
      showStatus('已下载发票草稿 CSV。模拟/草稿 非正式凭证。', 'ok');
    }));
    if (!current) return;
    const uploadOrId = () => new Promise((resolve) => {
      const id = prompt('请输入要认领的文件编号。取消则不提交。若要改为上传，请留空并按确定。');
      if (id === null) return resolve(null);
      if (String(id).trim()) return resolve({ fileId: String(id).trim(), file: null });
      const inp = document.createElement('input');
      inp.type = 'file';
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      inp.addEventListener('change', () => finish({ fileId: '', file: (inp.files && inp.files[0]) || null }));
      inp.addEventListener('cancel', () => finish(null));
      inp.click();
    });
    const needFile = async (btn, work) => {
      const picked = await uploadOrId();
      if (!picked || (!picked.fileId && !picked.file)) {
        showStatus('已取消。没有文件编号或文件，未提交。', 'info');
        return;
      }
      withSubmit(btn, () => work(picked));
    };
    const signed = document.getElementById('ct-signed');
    if (signed) signed.addEventListener('click', () => needFile(signed, async ({ fileId, file }) => {
      await api('archiveSigned', { contractNo: current.contractNo, fileId, signedDate: current.signedDate, __timeoutMs: 25000 }, file);
      showStatus('签署正本已归档。', 'ok');
      await render();
    }));
    const first = document.getElementById('ct-first');
    if (first) first.addEventListener('click', () => needFile(first, async ({ fileId, file }) => {
      const lineId = prompt('如需同时给某条月账明细认领（避免重复入账），请填写流水号；否则留空。取消则不提交。');
      if (lineId === null) throw new Error('已取消。');
      await api('claimFirstVoucher', { contractNo: current.contractNo, fileId, lineId: lineId || '', __timeoutMs: 25000 }, file);
      showStatus('首期凭证已关联' + (lineId ? '，并认领到明细 ' + lineId : '') + '。', 'ok');
      await render();
    }));
    const exec = document.getElementById('ct-exec');
    if (exec) exec.addEventListener('click', () => {
      withSubmit(exec, async () => {
        await api('enterExecution', { contractNo: current.contractNo, __timeoutMs: 20000 });
        showStatus('已尝试进入执行。', 'ok');
        await render();
      });
    });
    const pause = document.getElementById('ct-pause');
    if (pause) pause.addEventListener('click', () => needFile(pause, async ({ fileId, file }) => {
      await api('pauseContract', { contractNo: current.contractNo, agreementFileId: fileId, __timeoutMs: 25000 }, file);
      showStatus('合同已暂停。', 'ok');
      await render();
    }));
    const close = (btn, closeType) => needFile(btn, async ({ fileId, file }) => {
      await api('closeContract', { contractNo: current.contractNo, closeType, agreementFileId: fileId, __timeoutMs: 25000 }, file);
      showStatus('合同状态已更新为 ' + closeType + '。', 'ok');
      await render();
    });
    const b2 = document.getElementById('ct-close2');
    if (b2) b2.addEventListener('click', () => close(b2, '状态二'));
    const b3 = document.getElementById('ct-close3');
    if (b3) b3.addEventListener('click', () => close(b3, '状态三'));
    const bs = document.getElementById('ct-settle');
    if (bs) bs.addEventListener('click', () => close(bs, '已解除待结算'));
    viewEl.querySelectorAll('[data-node]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.kind === 'done') {
          withSubmit(btn, async () => {
            await api('updatePlanNode', { contractNo: current.contractNo, nodeId: btn.dataset.node, done: true, __timeoutMs: 20000 });
            showStatus('履约节点已更新。', 'ok');
            await render();
          });
          return;
        }
        needFile(btn, async ({ fileId, file }) => {
          const payload = { contractNo: current.contractNo, nodeId: btn.dataset.node, __timeoutMs: 25000 };
          if (btn.dataset.kind === 'confirm') { payload.confirmFileId = fileId; payload.asConfirm = !fileId; }
          else payload.fileId = fileId;
          await api('updatePlanNode', payload, file);
          showStatus('履约文件已关联。', 'ok');
          await render();
        });
      });
    });
  }

  showIdentityPending();
  boot();
})();
