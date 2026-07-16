// app.js —— 记事本原型 UI 逻辑（原生 JS，无框架）
(function () {
  'use strict';

  const { TYPES, fmtMoney } = window.StoreConst;
  const store = new Store();
  const state = { cat: null, q: '', hideDone: false, editing: null, modalCat: null };

  const $ = (s, r = document) => r.querySelector(s);
  const appEl = $('#app');
  const unlockEl = $('#unlock');
  const modalEl = $('#modal');

  function fmtDate(iso) {
    try {
      return new Date(iso).toISOString().slice(0, 10);
    } catch (e) {
      return '';
    }
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // 页面内对话框（替代被沙箱拦截的 window.prompt / confirm）
  function uiPrompt(title, defaultVal) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal';
      wrap.innerHTML = `
        <div class="modal-card small">
          <h3>${escapeHtml(title)}</h3>
          <input class="dlg-input" type="text" value="${escapeHtml(defaultVal || '')}" />
          <div class="modal-actions">
            <button class="btn ghost dlg-cancel">取消</button>
            <button class="btn-primary inline-btn dlg-ok">确定</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const input = wrap.querySelector('.dlg-input');
      input.focus();
      input.select();
      const done = (val) => { wrap.remove(); resolve(val); };
      wrap.querySelector('.dlg-ok').onclick = () => done(input.value.trim());
      wrap.querySelector('.dlg-cancel').onclick = () => done(null);
      input.onkeydown = (e) => {
        if (e.key === 'Enter') done(input.value.trim());
        if (e.key === 'Escape') done(null);
      };
      wrap.onclick = (e) => { if (e.target === wrap) done(null); };
    });
  }

  function uiConfirm(title) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal';
      wrap.innerHTML = `
        <div class="modal-card small">
          <p class="dlg-msg">${escapeHtml(title)}</p>
          <div class="modal-actions">
            <button class="btn ghost dlg-cancel">取消</button>
            <button class="btn-primary inline-btn danger dlg-ok">确定</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const done = (val) => { wrap.remove(); resolve(val); };
      wrap.querySelector('.dlg-ok').onclick = () => done(true);
      wrap.querySelector('.dlg-cancel').onclick = () => done(false);
      wrap.onclick = (e) => { if (e.target === wrap) done(false); };
    });
  }

  // ============ 解锁 / 创建 ============
  async function init() {
    if (await store.resumeSession()) {
      renderApp();
      return;
    }
    showUnlock();
  }

  function showUnlock() {
    appEl.hidden = true;
    unlockEl.hidden = false;
    const setup = !store.isSetup();
    $('#unlock-title').textContent = setup ? '创建你的记事本' : '解锁记事本';
    $('#unlock-sub').textContent = setup
      ? '设置主密码。明文只在本地加密保存，忘记密码 = 数据不可恢复，请牢记。'
      : '输入主密码以解密本地数据。';
    $('#unlock-btn').textContent = setup ? '创建' : '解锁';
    $('#pw').value = '';
    $('#pw').focus();
  }

  async function doUnlock() {
    const pw = $('#pw').value;
    if (!pw) return toast('请输入密码');
    try {
      if (!store.isSetup()) await store.setup(pw);
      else await store.unlock(pw);
      unlockEl.hidden = true;
      appEl.hidden = false;
      renderApp();
    } catch (err) {
      toast('密码错误，无法解密');
    }
  }

  function lock() {
    store.lock();
    showUnlock();
  }

  // ============ 渲染 ============
  function renderApp() {
    renderSidebar();
    renderMain();
  }

  function renderSidebar() {
    const nb = store.notebook;
    const allCount = nb.entries.length;
    let html = `
      <div class="cat-item ${state.cat === null ? 'active' : ''}" data-action="select-cat" data-id="">
        <span class="dot" style="background:#475569"></span>
        <span class="cat-name">全部</span>
        <span class="cat-count">${allCount}</span>
      </div>`;
    nb.categories.forEach((c) => {
      const cnt = nb.entries.filter((e) => e.categoryId === c.id).length;
      html += `
        <div class="cat-item ${state.cat === c.id ? 'active' : ''}" data-action="select-cat" data-id="${c.id}">
          <span class="dot" style="background:${c.color}"></span>
          <span class="cat-name">${escapeHtml(c.name)}</span>
          <span class="cat-count">${cnt}</span>
          <span class="cat-ops">
            <button data-action="edit-cat" data-id="${c.id}" title="重命名">✎</button>
            <button data-action="del-cat" data-id="${c.id}" title="删除分类">✕</button>
          </span>
        </div>`;
    });
    $('#sidebar-list').innerHTML = html;
    $('#cat-empty').hidden = nb.categories.length > 0;
  }

  function renderMain() {
    const nb = store.notebook;
    const title = state.cat ? (nb.categories.find((c) => c.id === state.cat) || {}).name : '全部';
    $('#view-title').textContent = title;

    // 当前列表
    let list = store.search(state.q, state.cat);
    const hasTask = list.some((e) => e.type === 'task');
    if (state.hideDone) list = list.filter((e) => !(e.type === 'task' && e.done));
    $('#hide-done-wrap').hidden = !hasTask;

    // 账本汇总
    const sum = store.ledgerSummary(list);
    const summaryEl = $('#summary');
    if (sum.count > 0) {
      const byCat = Object.entries(sum.byCat)
        .map(([k, v]) => `<span class="mini">${escapeHtml(k)} ${v >= 0 ? '+' : '-'}${fmtMoney(Math.abs(v)).slice(1)}</span>`)
        .join('');
      summaryEl.hidden = false;
      summaryEl.innerHTML = `
        <div class="sum-grid">
          <div><div class="sum-label">收入</div><div class="sum-val inc">+${fmtMoney(sum.income).slice(1)}</div></div>
          <div><div class="sum-label">支出</div><div class="sum-val exp">-${fmtMoney(sum.expense).slice(1)}</div></div>
          <div><div class="sum-label">结余</div><div class="sum-val bal">${fmtMoney(sum.balance)}</div></div>
        </div>
        <div class="sum-bycat">${byCat}</div>`;
    } else {
      summaryEl.hidden = true;
    }

    if (list.length === 0) {
      $('#entries').innerHTML = `<div class="empty">这里还没有内容，点右上角「+ 新建」记一笔吧。</div>`;
      return;
    }
    $('#entries').innerHTML = list.map(renderEntry).join('');
  }

  function renderEntry(e) {
    const t = TYPES[e.type];
    let extra = '';
    if (e.type === 'ledger') {
      const sign = e.direction === 'income' ? '+' : '-';
      const cls = e.direction === 'income' ? 'inc' : 'exp';
      extra = `<div class="ledger-amt ${cls}">${sign}${fmtMoney(e.amount).slice(1)} ${e.note ? '· ' + escapeHtml(e.note) : ''}</div>`;
    }
    const doneCls = e.type === 'task' && e.done ? ' done' : '';
    const checkbox = e.type === 'task'
      ? `<button class="task-check ${e.done ? 'checked' : ''}" data-action="toggle-task" data-id="${e.id}" title="标记完成">${e.done ? '✓' : ''}</button>`
      : '';
    return `
      <div class="entry ${doneCls}" data-id="${e.id}">
        ${checkbox}
        <div class="entry-body">
          <div class="entry-head">
            <span class="badge" style="background:${t.color}">${t.label}</span>
            <span class="entry-title">${escapeHtml(e.title || '(无标题)')}</span>
            <span class="entry-date">${fmtDate(e.createdAt)}</span>
          </div>
          ${e.content ? `<div class="entry-content">${escapeHtml(e.content)}</div>` : ''}
          ${extra}
        </div>
        <div class="entry-ops">
          <button data-action="edit-entry" data-id="${e.id}" title="编辑">✎</button>
          <button data-action="del-entry" data-id="${e.id}" title="删除">✕</button>
        </div>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ============ 弹窗：新建 / 编辑 ============
  function renderCatPills(selectedId) {
    const nb = store.notebook;
    const box = $('#m-cat');
    if (!nb.categories.length) {
      box.innerHTML = '<span class="cat-pill-empty">（请点右侧「+ 新分类」）</span>';
      state.modalCat = null;
      return;
    }
    const sel = selectedId || nb.categories[0].id;
    box.innerHTML = nb.categories
      .map((c) => `<button type="button" class="cat-pill ${c.id === sel ? 'sel' : ''}" data-action="pick-cat" data-cat="${c.id}" style="--pc:${c.color}">${escapeHtml(c.name)}</button>`)
      .join('');
    state.modalCat = sel;
  }

  function openModal(entryId) {
    state.editing = entryId || null;
    const nb = store.notebook;
    const e = entryId ? nb.entries.find((x) => x.id === entryId) : null;

    renderCatPills(e ? e.categoryId : null);

    $('#m-type').value = e ? e.type : 'note';
    $('#m-title').value = e ? e.title || '' : '';
    $('#m-content').value = e ? e.content || '' : '';
    $('#m-done').checked = e ? !!e.done : false;
    $('#m-amount').value = e && e.type === 'ledger' ? e.amount : '';
    $('#m-direction').value = e && e.type === 'ledger' ? e.direction : 'expense';
    $('#m-note').value = e && e.type === 'ledger' ? e.note || '' : '';

    $('#modal-title').textContent = e ? '编辑' : '新建';
    toggleTypeFields();
    modalEl.hidden = false;
    $('#m-title').focus();
  }

  function closeModal() {
    modalEl.hidden = true;
    state.editing = null;
  }

  function toggleTypeFields() {
    const type = $('#m-type').value;
    $('#task-fields').hidden = type !== 'task';
    $('#ledger-fields').hidden = type !== 'ledger';
  }

  async function saveModal() {
    const type = $('#m-type').value;
    const title = $('#m-title').value.trim();
    const content = $('#m-content').value.trim();
    const categoryId = state.modalCat;
    if (!title && !content) return toast('标题或内容至少填一项');
    if (!categoryId) return toast('请先创建一个分类');

    const data = { type, title, content, categoryId };
    if (type === 'task') data.done = $('#m-done').checked;
    if (type === 'ledger') {
      const amt = parseFloat($('#m-amount').value);
      if (!Number.isFinite(amt) || amt <= 0) return toast('请输入有效金额');
      data.amount = amt;
      data.direction = $('#m-direction').value;
      data.note = $('#m-note').value.trim();
    }

    if (state.editing) store.updateEntry(state.editing, data);
    else store.addEntry(data);
    await store.save();
    closeModal();
    renderApp();
  }

  // ============ 事件委托 ============
  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const id = el.dataset.id;

    switch (action) {
      case 'select-cat':
        state.cat = id || null;
        renderApp();
        break;
      case 'edit-cat': {
        const c = store.categoryById(id);
        const name = await uiPrompt('重命名分类', c.name);
        if (name) { store.updateCategory(id, name); await store.save(); renderApp(); }
        break;
      }
      case 'del-cat': {
        const c = store.categoryById(id);
        if (await uiConfirm(`删除分类「${c.name}」？其中的条目也会一并删除。`)) {
          store.deleteCategory(id);
          if (state.cat === id) state.cat = null;
          await store.save(); renderApp();
        }
        break;
      }
      case 'add-cat': {
        const name = await uiPrompt('新分类名称', '');
        if (name) {
          const cat = store.addCategory(name);
          await store.save();
          state.cat = cat.id;
          renderApp();
          toast('已创建分类「' + cat.name + '」');
        }
        break;
      }
      case 'toggle-task':
        store.toggleTask(id); await store.save(); renderApp();
        break;
      case 'edit-entry':
        openModal(id);
        break;
      case 'del-entry': {
        const e = store.notebook.entries.find((x) => x.id === id);
        if (await uiConfirm(`删除「${(e && e.title) || '该条目'}」？`)) {
          store.deleteEntry(id); await store.save(); renderApp();
        }
        break;
      }
      case 'pick-cat':
        state.modalCat = id;
        renderCatPills(state.modalCat);
        break;
      case 'modal-add-cat': {
        const name = await uiPrompt('新分类名称', '');
        if (name) {
          const cat = store.addCategory(name);
          await store.save();
          renderSidebar();
          renderCatPills(cat.id);
          toast('已创建分类「' + cat.name + '」');
        }
        break;
      }
      case 'new-entry':
        openModal(null);
        break;
      case 'modal-save':
        await saveModal();
        break;
      case 'modal-cancel':
        closeModal();
        break;
      case 'lock':
        lock();
        break;
      case 'restore-cats': {
        const added = store.restoreSeedCategories();
        await store.save();
        renderApp();
        toast(added > 0 ? `已恢复 ${added} 个默认分类` : '默认分类已存在');
        break;
      }
      case 'reset-data': {
        const ok = await uiConfirm('确定清空全部数据并重置？此操作不可恢复（原型数据仅存于本机）。');
        if (ok) {
          Store.clearStorage();
          location.reload();
        }
        break;
      }
      case 'export':
        store.exportBackup();
        toast('已导出加密备份文件');
        break;
      case 'toggle-hide-done':
        state.hideDone = $('#hide-done').checked;
        renderMain();
        break;
    }
  });

  // 输入类事件
  $('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
  $('#unlock-btn').addEventListener('click', doUnlock);
  $('#search').addEventListener('input', (e) => { state.q = e.target.value; renderMain(); });
  $('#m-type').addEventListener('change', toggleTypeFields);

  init();
})();
