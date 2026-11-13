/* FUNSTOCK operations admin — single gated shell. Data only from /api. */
(function () {
  const { api, escapeHtml: E, badge } = FS;
  const viewEl = document.getElementById('view');
  const titleEl = document.getElementById('title');
  const whoEl = document.getElementById('who');
  let me = null;
  let financeTab = 'statements';
  let selectedMonth = '2026-10';
  let selectedContract = null;

  const TITLES = {
    dashboard: '总览看板',
    plans: '每月经营计划',
    proposals: '运营策划书',
    documents: '资料与凭证',
    finance: '月账与四套账',
    contracts: '合同与发票',
  };

  function currentView() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/admin' || path === '/admin/index.html') return 'dashboard';
    const m = path.match(/^\/admin\/(plans|proposals|documents|finance|contracts)/);
    return m ? m[1] : 'dashboard';
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

  async function boot() {
    try {
      const data = await api('me');
      me = data.user;
      whoEl.textContent = `${me.displayName} · ${me.role} · ${me.jobId}`;
      await render();
    } catch (e) {
      location.replace('/admin/login.html');
    }
  }

  document.getElementById('logout').addEventListener('click', async () => {
    try { await api('logout'); } catch (e) { /* ignore */ }
    location.replace('/admin/login.html');
  });

  window.addEventListener('popstate', () => { render(); });
  document.getElementById('nav').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    history.pushState({}, '', a.getAttribute('href'));
    render();
  });

  async function render() {
    const view = currentView();
    setNav(view);
    viewEl.innerHTML = '正在读取…';
    try {
      if (view === 'dashboard') await renderDashboard();
      else if (view === 'plans') await renderPlans();
      else if (view === 'proposals') await renderProposals();
      else if (view === 'documents') await renderDocuments();
      else if (view === 'finance') await renderFinance();
      else if (view === 'contracts') await renderContracts();
    } catch (e) {
      if (e.status === 401) return location.replace('/admin/login.html');
      viewEl.innerHTML = alertBox('danger', E(e.message));
    }
  }

  async function renderDashboard() {
    const d = await api('getDashboard');
    const warns = (d.warnings || []).map((w) => `<li>${E(w.message)}</li>`).join('')
      || '<li class="muted">暂无跨月未完成两次以上的预警。</li>';
    const planRows = (d.plansThisMonth || []).map((p) =>
      `<tr><td>${E(p.type)}</td><td>${E(p.title)}</td><td>${E(p.planDate || '')}</td><td>${badge(p.status)}</td></tr>`
    ).join('') || '<tr><td colspan="4" class="muted">本月尚未登记计划。</td></tr>';
    const m = d.month;
    const fin = m ? `${m.yearMonth} · 明细 ${m.lineCount} 条 · 已附 ${m.counts.已附原件} · 免原件 ${m.counts.免原件} · 暂记 ${m.counts.暂记往来} · 未处理 ${m.counts.未处理}<br>${m.ledgerGenerated ? (m.bankBalanced ? badge('银行侧已核对') : badge('未配平')) : badge('尚未生成明细账')} ${m.completionConfirmed ? badge('完成页已确认') : badge('未过完成页')} ${m.posted ? badge('已定稿') : badge('未定稿')}` : '尚未登记月账。';
    const cts = (d.contracts || []).map((c) => `<tr><td>${E(c.contractNo)}</td><td>${E(c.counterparty)}</td><td>${E(c.stage)}</td><td>${badge(c.status)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">暂无合同台账。</td></tr>';
    viewEl.innerHTML = `
      ${alertBox('info', '这是内部预览看板。所有数据由统一接口读取，不使用手工粘贴的数据文件作为正式供数方式。')}
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

  async function renderPlans() {
    const d = await api('getPlans');
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
            <div class="field"><label>年月</label><input name="yearMonth" placeholder="2026-10" required></div>
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
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const payload = Object.fromEntries(fd.entries());
      try { await api('savePlan', payload); await renderPlans(); }
      catch (err) { alert(err.message); }
    });
    viewEl.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await api('savePlan', { id: btn.dataset.id, status: btn.dataset.status }); await renderPlans(); }
        catch (err) { alert(err.message); }
      });
    });
    viewEl.querySelectorAll('[data-act="fb"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const feedback = prompt('请填写回馈（将写入该计划事项）：');
        if (feedback == null) return;
        try { await api('savePlan', { mode: 'feedback', id: btn.dataset.id, feedback }); await renderPlans(); }
        catch (err) { alert(err.message); }
      });
    });
  }

  async function renderProposals() {
    const d = await api('getProposals');
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
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try { await api('uploadProposal', { title: fd.get('title'), yearMonth: fd.get('yearMonth') }, fd.get('file')); await renderProposals(); }
      catch (err) { alert(err.message); }
    });
  }

  async function renderDocuments() {
    const d = await api('getDocuments');
    const files = (d.files || []).map((f) => `<tr>
      <td>${E(f.id)}</td><td>${E(f.date)}</td><td>${E(f.category)}</td><td>${E(f.name)}</td>
      <td>${E(f.source)}</td><td>${badge(f.status)}</td>
      <td>${(f.claimedBy || []).map((c) => E((c.module || '') + (c.role ? '/' + c.role : ''))).join('、') || '尚未被其他模块认领'}</td>
      <td>${FS.fileHref(f.id, f) ? FS.fileLink(f.id, f, '打开') : '—'}</td>
    </tr>`).join('');
    const pics = (d.pics || []).map((p) => `<tr>
      <td>${E(p.id)}</td><td>${E(p.date)}</td><td>${E(p.role)}</td><td>${E(p.version)}</td>
      <td>${p.acknowledged ? badge('已勾选') : badge('未勾选')}</td><td>${E(p.digest)}</td>
    </tr>`).join('');
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
      <div class="card" style="margin-bottom:16px">
        <h3>隐私声明存证（双向）</h3>
        <p class="muted">客户递交经营资料时应勾选并留下存证。顾问回传报告亦可在此记录。</p>
        <button class="btn small" id="pics-btn" type="button">勾选预览版隐私声明并存证</button>
        <table style="margin-top:12px"><thead><tr><th>编号</th><th>日期</th><th>角色</th><th>版本</th><th>勾选</th><th>摘要</th></tr></thead>
        <tbody>${pics || '<tr><td colspan="6" class="muted">尚无存证。</td></tr>'}</tbody></table>
      </div>
      <div class="card">
        <h3>资料与凭证台账</h3>
        <table><thead><tr><th>编号</th><th>日期</th><th>类别</th><th>文件名</th><th>来源</th><th>状态</th><th>被认领</th><th></th></tr></thead>
        <tbody>${files || '<tr><td colspan="8" class="muted">暂无文件。</td></tr>'}</tbody></table>
      </div>`;
    document.getElementById('doc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try { await api('uploadDocument', { category: fd.get('category'), relatedId: fd.get('relatedId') }, fd.get('file')); await renderDocuments(); }
      catch (err) { alert(err.message); }
    });
    document.getElementById('pics-btn').addEventListener('click', async () => {
      try { await api('acknowledgePics', { version: 'PICS-PREVIEW-v0.1' }); await renderDocuments(); }
      catch (err) { alert(err.message); }
    });
  }

  async function renderFinance() {
    const month = selectedMonth;
    const d = await api('getMonth', { yearMonth: month });
    const m = d.month;
    const tabBtn = (id, label) => `<button type="button" data-tab="${id}" class="${financeTab === id ? 'active' : ''}">${label}</button>`;
    let body = '';
    if (financeTab === 'statements') body = renderStmtTab(d);
    else if (financeTab === 'ledger') body = renderLedgerTab(d);
    else if (financeTab === 'completion') body = renderCompletionTab(d);
    else body = renderFourTab(d);

    viewEl.innerHTML = `
      <div class="toolbar">
        <label>月份 <input id="ym" value="${E(month)}" style="width:120px;padding:6px 8px;border:1px solid var(--line);border-radius:8px"></label>
        <button class="btn small ghost" id="load-ym" type="button">切换</button>
        ${m.pastDeadline ? badge('已过提交限期 ' + m.deadline) : badge('限期 ' + m.deadline)}
        ${m.bankBalanced ? badge('银行侧已核对') : (m.ledgerGenerated ? badge('未配平') : badge('尚未生成明细账'))}
        ${m.completionConfirmed ? badge('完成页已确认') : badge('未过完成页')}
        ${m.posted ? badge('已定稿') : badge('未定稿')}
      </div>
      ${alertBox('info', '以每月公司银行月结单为核对称梁。现金或第三方收支单笔不超过 2,000 港元、当月合计不超过 20,000 港元；超限不得按本条直接进入第一本明细账。不造数字，不把未配平说成已配平。')}
      <div class="tabs">
        ${tabBtn('statements', '1. 月结单与现金')}
        ${tabBtn('ledger', '2. 第一本明细账')}
        ${tabBtn('completion', '3. 完成页')}
        ${tabBtn('four', '4. 四套账与导出')}
      </div>
      ${body}`;

    document.getElementById('load-ym').addEventListener('click', () => {
      selectedMonth = document.getElementById('ym').value.trim();
      renderFinance();
    });
    viewEl.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { financeTab = b.dataset.tab; renderFinance(); }));
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
      `<tr><td>${E(c.date)}</td><td>${E(c.desc)}</td><td>${E(c.direction)}</td><td>${E(c.amount)} ${E(c.currency)}</td><td>${E(c.counterparty)}</td></tr>`
    ).join('') || '<tr><td colspan="5" class="muted">尚未登记现金或第三方收支。</td></tr>';
    const rejected = (d.rejectedCash || []).map((r) => `<li>${E(r.at)} · ${E(r.desc)} · ${r.amount} 港元 · ${E(r.reason)}</li>`).join('');
    return `
      <div class="card" style="margin-bottom:16px">
        <h3>登记银行月结单（每账户一份）</h3>
        <form id="stmt-form">
          <div class="form-row">
            <div class="field"><label>账户名称</label><input name="accountName" value="测试银行-港币往来（虚构）" required></div>
            <div class="field"><label>账户代号</label><input name="accountId" value="TEST-BANK-HKD" required></div>
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
            <div class="field"><label>日期</label><input name="date" required placeholder="2026-10-18"></div>
            <div class="field"><label>摘要</label><input name="desc" required></div>
            <div class="field"><label>方向</label><select name="direction"><option>收入</option><option>支出</option></select></div>
            <div class="field"><label>金额</label><input name="amount" type="number" step="0.01" required></div>
            <div class="field"><label>币种</label><input name="currency" value="HKD"></div>
            <div class="field"><label>对方</label><input name="counterparty"></div>
          </div>
          <button class="btn small" type="submit">登记</button>
        </form>
        <table style="margin-top:12px"><thead><tr><th>日期</th><th>摘要</th><th>方向</th><th>金额</th><th>对方</th></tr></thead><tbody>${cash}</tbody></table>
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
    if (!d.month.ledgerGenerated) return alertBox('warn', '尚未生成第一本明细账，不能进入完成页。');
    const section = (title, rows) => `
      <div class="card" style="margin-bottom:12px">
        <h3>${title}（${rows.length}）</h3>
        <table><thead><tr><th>流水号</th><th>日期</th><th>摘要</th><th>方向</th><th>折港币</th><th>对方</th></tr></thead>
        <tbody>${rows.map((l) => `<tr><td>${E(l.id)}</td><td>${E(l.date)}</td><td>${E(l.desc)}</td><td>${E(l.direction)}</td><td>${E(l.amountHkd)}</td><td>${E(l.counterparty)}</td></tr>`).join() || '<tr><td colspan="6" class="muted">无</td></tr>'}</tbody>
        </table>
      </div>`;
    // Fix join() using comma - should use ''
    const list = (rows) => rows.length ? rows.map((l) => `<tr><td>${E(l.id)}</td><td>${E(l.date)}</td><td>${E(l.desc)}</td><td>${E(l.direction)}</td><td>${E(l.amountHkd)}</td><td>${E(l.counterparty)}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">无</td></tr>';
    const g = d.groups || {};
    const unfinished = (g.未处理 || []).length;
    return `
      ${unfinished ? alertBox('danger', `尚有 ${unfinished} 条未处理，不能确认完成页。`) : alertBox('ok', '三类均已列明。确认后才可计入正式四套账。')}
      ${d.month.completionConfirmed ? alertBox('ok', '本月完成页已于 ' + E(d.month.completionConfirmedAt || '') + ' 确认。') : ''}
      <div class="card" style="margin-bottom:12px"><h3>已附原件（${(g.已附原件||[]).length}）</h3>
        <table><thead><tr><th>流水号</th><th>日期</th><th>摘要</th><th>方向</th><th>折港币</th><th>对方</th></tr></thead><tbody>${list(g.已附原件||[])}</tbody></table></div>
      <div class="card" style="margin-bottom:12px"><h3>免原件（${(g.免原件||[]).length}）</h3>
        <table><thead><tr><th>流水号</th><th>日期</th><th>摘要</th><th>方向</th><th>折港币</th><th>对方</th></tr></thead><tbody>${list(g.免原件||[])}</tbody></table></div>
      <div class="card" style="margin-bottom:12px"><h3>暂记往来（${(g.暂记往来||[]).length}）</h3>
        <p class="muted">已暂记的月份可以定稿，但导出须标明暂记项目；未获真凭证调整前，这些项目不作为已齐备的审计附件。</p>
        <table><thead><tr><th>流水号</th><th>日期</th><th>摘要</th><th>方向</th><th>折港币</th><th>对方</th></tr></thead><tbody>${list(g.暂记往来||[])}</tbody></table></div>
      ${d.month.completionConfirmed ? '' : '<button class="btn amber" id="confirm-done" type="button">确认完成页</button>'}`;
  }

  function renderFourTab(d) {
    if (!d.month.completionConfirmed) {
      return alertBox('danger', '未经过完成页确认，不得计入正式四套账，也不得写入给审计用的内部记账文件。');
    }
    const groups = ['利润表', '资产负债表', '现金流量表', '流水明细'];
    const blocks = groups.map((t) => {
      const rows = (d.four || []).filter((r) => r.type === t);
      if (!rows.length && !d.month.posted) return `<div class="card" style="margin-bottom:12px"><h3>${t}</h3><p class="muted">尚未定稿。确认下方按钮后生成。</p></div>`;
      return `<div class="card" style="margin-bottom:12px"><h3>${t}</h3>
        <table><thead><tr><th>项目</th><th>金额（港币）</th><th>含暂记</th><th>备注</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${E(r.item)}</td><td>${E(r.amountHkd)}</td><td>${r.hasSuspense ? badge('含暂记往来') : '—'}</td><td>${E(r.notes || '')}</td></tr>`).join('')}</tbody></table>
      </div>`;
    }).join('');
    return `
      ${d.month.posted ? alertBox('ok', '本月已定稿。含暂记往来的项目已在表内标明，不作为已齐备的审计附件，直至取得真凭证并完成调整。') : alertBox('info', '完成页已确认。银行侧已核对的月份可以定稿。')}
      ${d.month.posted ? '' : '<button class="btn amber" id="post-four" type="button">定稿并写入正式四套账</button>'}
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
    if (stmt) stmt.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(stmt);
      const payload = {
        yearMonth: selectedMonth,
        accountName: fd.get('accountName'),
        accountId: fd.get('accountId'),
        opening: Number(fd.get('opening')),
        closing: Number(fd.get('closing')),
        currency: 'HKD',
        fileId: fd.get('fileId') || '',
        lines: parseLines(fd.get('lines')),
      };
      const file = fd.get('file');
      try { await api('addStatement', payload, file && file.size ? file : null); await renderFinance(); }
      catch (err) { alert(err.message); }
    });
    const cash = document.getElementById('cash-form');
    if (cash) cash.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(cash);
      try {
        await api('addCashItem', {
          yearMonth: selectedMonth,
          date: fd.get('date'),
          desc: fd.get('desc'),
          direction: fd.get('direction'),
          amount: Number(fd.get('amount')),
          currency: fd.get('currency') || 'HKD',
          counterparty: fd.get('counterparty'),
        });
        await renderFinance();
      } catch (err) { alert(err.message); }
    });
    const gen = document.getElementById('gen-ledger');
    if (gen) gen.addEventListener('click', async () => {
      try { await api('generateLedger', { yearMonth: selectedMonth }); financeTab = 'ledger'; await renderFinance(); }
      catch (err) { alert(err.message); }
    });
    const hidden = document.getElementById('hidden-file');
    viewEl.querySelectorAll('[data-act="upload"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        hidden.onchange = async () => {
          const file = hidden.files[0];
          hidden.value = '';
          if (!file) return;
          try { await api('attachVoucher', { lineId: btn.dataset.id }, file); await renderFinance(); }
          catch (err) { alert(err.message); }
        };
        hidden.click();
      });
    });
    viewEl.querySelectorAll('[data-act="claim"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const fileId = prompt('请输入要认领的文件编号（同一文件只传一次）：', (d.files && d.files[0] && d.files[0].id) || '');
        if (!fileId) return;
        try { await api('attachVoucher', { lineId: btn.dataset.id, fileId }); await renderFinance(); }
        catch (err) { alert(err.message); }
      });
    });
    viewEl.querySelectorAll('[data-act="waive"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await api('waiveOriginal', { lineId: btn.dataset.id }); await renderFinance(); }
        catch (err) { alert(err.message); }
      });
    });
    viewEl.querySelectorAll('[data-act="suspense"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await api('markSuspense', { lineId: btn.dataset.id }); await renderFinance(); }
        catch (err) { alert(err.message); }
      });
    });
    const conf = document.getElementById('confirm-done');
    if (conf) conf.addEventListener('click', async () => {
      try { await api('confirmCompletion', { yearMonth: selectedMonth }); await renderFinance(); }
      catch (err) { alert(err.message); }
    });
    const post = document.getElementById('post-four');
    if (post) post.addEventListener('click', async () => {
      try { await api('postFourStatements', { yearMonth: selectedMonth }); await renderFinance(); }
      catch (err) { alert(err.message); }
    });
  }

  async function renderContracts() {
    const d = await api('getContracts');
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
    const invRows = invoices.map((i) => `<tr><td>${E(i.invoiceNo)}</td><td>${E(i.contractNo)}</td><td>${E(i.date)}</td><td>${E(i.amount)} ${E(i.currency)}</td><td>${badge(i.status)}</td></tr>`).join('');
    viewEl.innerHTML = `
      ${alertBox('info', '对客正式合同生成入口已关闭。本模块只做台账、流程、状态和文件归档。收款或付款凭证与月账共用同一份文件：只传一次，合同模块认领关联，不得各记各的。')}
      <div class="disabled-note" style="margin-bottom:16px">「生成正式合同文本」不可用。模板未经审定前，不得对客生成。</div>
      <div class="card" style="margin-bottom:16px">
        <h3>新建合同台账（非正式文本）</h3>
        <form id="ct-form">
          <div class="form-row">
            <div class="field"><label>合同号</label><input name="contractNo" placeholder="FS-TEST-C-001"></div>
            <div class="field"><label>对方名称（须为虚构测试名称）</label><input name="counterparty" required></div>
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
        <h3>发票台账</h3>
        <table><thead><tr><th>发票号</th><th>合同号</th><th>日期</th><th>金额</th><th>状态</th></tr></thead>
        <tbody>${invRows || '<tr><td colspan="5" class="muted">暂无发票。预览不开放对客自动开票。</td></tr>'}</tbody></table>
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
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const payload = Object.fromEntries(fd.entries());
      if (payload.firstAmount === '') delete payload.firstAmount;
      try { const out = await api('createContract', payload); selectedContract = out.contract.contractNo; await renderContracts(); }
      catch (err) { alert(err.message); }
    });
    viewEl.querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault(); selectedContract = a.getAttribute('data-open'); renderContracts();
    }));
    if (!current) return;
    const pickFile = (msg) => prompt(msg || '输入已上传文件编号，或留空改为本地上传：');
    const uploadOrId = async () => {
      const id = pickFile('请输入要认领的文件编号。若要改为上传，请留空并按确定。');
      if (id) return { fileId: id, file: null };
      return new Promise((resolve) => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.onchange = () => resolve({ fileId: '', file: inp.files[0] || null });
        inp.click();
      });
    };
    const signed = document.getElementById('ct-signed');
    if (signed) signed.addEventListener('click', async () => {
      const { fileId, file } = await uploadOrId();
      if (!fileId && !file) return;
      try { await api('archiveSigned', { contractNo: current.contractNo, fileId, signedDate: current.signedDate }, file); await renderContracts(); }
      catch (err) { alert(err.message); }
    });
    const first = document.getElementById('ct-first');
    if (first) first.addEventListener('click', async () => {
      const { fileId, file } = await uploadOrId();
      if (!fileId && !file) return;
      const lineId = prompt('如需同时给某条月账明细认领（避免重复入账），请填写流水号；否则留空。') || '';
      try { await api('claimFirstVoucher', { contractNo: current.contractNo, fileId, lineId }, file); await renderContracts(); }
      catch (err) { alert(err.message); }
    });
    const exec = document.getElementById('ct-exec');
    if (exec) exec.addEventListener('click', async () => {
      try { await api('enterExecution', { contractNo: current.contractNo }); await renderContracts(); }
      catch (err) { alert(err.message); }
    });
    const close = async (closeType) => {
      const { fileId, file } = await uploadOrId();
      try { await api('closeContract', { contractNo: current.contractNo, closeType, agreementFileId: fileId }, file); await renderContracts(); }
      catch (err) { alert(err.message); }
    };
    const b2 = document.getElementById('ct-close2');
    if (b2) b2.addEventListener('click', () => close('状态二'));
    const b3 = document.getElementById('ct-close3');
    if (b3) b3.addEventListener('click', () => close('状态三'));
    const bs = document.getElementById('ct-settle');
    if (bs) bs.addEventListener('click', () => close('已解除待结算'));
    viewEl.querySelectorAll('[data-node]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          if (btn.dataset.kind === 'done') {
            await api('updatePlanNode', { contractNo: current.contractNo, nodeId: btn.dataset.node, done: true });
          } else {
            const { fileId, file } = await uploadOrId();
            if (!fileId && !file) return;
            const payload = { contractNo: current.contractNo, nodeId: btn.dataset.node };
            if (btn.dataset.kind === 'confirm') { payload.confirmFileId = fileId; payload.asConfirm = !fileId; }
            else payload.fileId = fileId;
            await api('updatePlanNode', payload, file);
          }
          await renderContracts();
        } catch (err) { alert(err.message); }
      });
    });
  }

  boot();
})();
