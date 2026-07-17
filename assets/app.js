/* Sparkbook UI 控制器 */
(function () {
  'use strict';
  const store = new SparkStore();
  const $ = sel => document.querySelector(sel);
  const TYPES = window.SparkTypes;
  const TYPE_ORDER = window.SparkTypeOrder;

  let cur = { type: 'all', cat: '', q: '' };
  let editingId = null;
  let editorType = 'misc';

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function esc(s) {
    return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 1800);
  }

  // ---------- 解锁 ----------
  async function doUnlock(pw, remember) {
    try {
      await store.unlock(pw, { remember });
      $('#lock-screen').classList.add('hidden');
      $('#app').classList.remove('hidden');
      afterUnlock();
    } catch (e) {
      $('#lock-error').textContent = e.message || '解锁失败';
    }
  }
  function afterUnlock() {
    renderTypeNav(); renderCats(); renderList(); updateBadge();
  }
  function updateBadge() {
    const b = $('#sync-badge');
    b.className = 'badge ' + (store.mode === 'cos' ? 'cos' : 'local');
    b.textContent = store.mode === 'cos' ? '云端同步' : '本地模式';
  }
  async function sync() {
    try {
      const mode = await store.save();
      updateBadge();
      toast(mode === 'cos' ? '已同步至云端' : '已存本地');
    } catch (e) {
      toast('保存失败：' + (e.message || e));
    }
  }

  // ---------- 侧栏 ----------
  function renderTypeNav() {
    const nav = $('#type-nav');
    const items = [{ key: 'all', label: '全部', icon: '📚' }]
      .concat(TYPE_ORDER.map(k => ({ key: k, label: TYPES[k].label, icon: TYPES[k].icon })));
    nav.innerHTML = items.map(it =>
      `<button data-type="${it.key}" class="${cur.type === it.key ? 'active' : ''}">${it.icon} ${it.label}</button>`
    ).join('');
    nav.querySelectorAll('button').forEach(b =>
      b.onclick = () => { cur.type = b.dataset.type; renderTypeNav(); renderList(); });
  }
  function renderCats() {
    const box = $('#cat-list');
    const cats = store.categories();
    let html = `<span class="cat-pill ${cur.cat === '' ? 'active' : ''}" data-cat="">全部</span>`;
    html += cats.map(c =>
      `<span class="cat-pill ${cur.cat === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}<span class="x" data-x="${esc(c)}">✕</span></span>`
    ).join('');
    box.innerHTML = html;
    box.querySelectorAll('.cat-pill').forEach(p => {
      p.onclick = (e) => {
        if (e.target.dataset.x) return;
        cur.cat = p.dataset.cat; renderCats(); renderList();
      };
    });
    box.querySelectorAll('.x').forEach(x => {
      x.onclick = (e) => {
        e.stopPropagation();
        const name = x.dataset.x;
        if (confirm(`删除分类「${name}」？该分类下的条目将变为未分类。`)) {
          store.removeCategory(name);
          if (cur.cat === name) cur.cat = '';
          renderCats(); renderList(); sync();
        }
      };
    });
  }

  // ---------- 列表 ----------
  function entrySummary(e) {
    if (e.type === 'ledger') {
      const a = (Number(e.amount) || 0).toFixed(2);
      const cls = e.direction === 'in' ? 'amt-in' : 'amt-out';
      const sign = e.direction === 'in' ? '+' : '-';
      return `<span class="${cls}">¥${sign}${a}</span>` + (e.body ? ' · ' + esc(e.body) : '');
    }
    if (e.type === 'task') {
      return esc(e.title) + (e.dueDate ? ` · 截止 ${esc(e.dueDate)}` : '') + (e.done ? ' ✓' : '');
    }
    if (e.type === 'meeting') {
      return esc(e.title) + (e.meetingDate ? ` · ${esc(e.meetingDate)}` : '');
    }
    return esc(e.body || e.title || '');
  }
  function renderList() {
    const list = $('#entry-list');
    const items = store.filter({ type: cur.type, category: cur.cat, q: cur.q });
    const typeLabel = cur.type === 'all' ? '全部' : TYPES[cur.type].label;
    $('#view-title').textContent = cur.cat ? `${typeLabel} · ${cur.cat}` : typeLabel;
    $('#view-count').textContent = `${items.length} 条`;
    if (!items.length) {
      list.innerHTML = `<div class="empty">还没有记录，点右下角 ＋ 新增一条吧</div>`;
      return;
    }
    list.innerHTML = items.map(e => {
      const edited = e.updated && e.created && e.updated > e.created;
      const catHtml = e.category ? `<span class="entry-cat">#${esc(e.category)}</span>` : '';
      const editedHtml = edited ? `<span class="entry-edited">已编辑</span>` : '';
      let actions = `<div class="entry-actions">
        <button class="mini-btn" data-edit="${e.id}">✏️</button>
        ${e.type === 'inspiration' ? `<button class="mini-btn" data-conv="${e.id}" title="转为普通记录">🔀</button>` : ''}
        <button class="mini-btn" data-del="${e.id}">🗑</button>
      </div>`;
      return `<div class="entry ${e.type === 'task' && e.done ? 'done' : ''}" data-id="${e.id}">
        <div class="entry-top">
          <span class="entry-type">${TYPES[e.type].icon} ${TYPES[e.type].label}</span>
          ${catHtml} ${editedHtml}
        </div>
        <div class="entry-body">${entrySummary(e)}</div>
        <div class="entry-meta"><span>创建 ${fmtDate(e.created)}</span>${edited ? `<span>修改 ${fmtDate(e.updated)}</span>` : ''}</div>
        ${actions}
      </div>`;
    }).join('');
    list.querySelectorAll('[data-edit]').forEach(b => b.onclick = (ev) => { ev.stopPropagation(); openEditor(b.dataset.edit); });
    list.querySelectorAll('[data-del]').forEach(b => b.onclick = (ev) => {
      ev.stopPropagation();
      if (confirm('确定删除这条记录？')) { store.deleteEntry(b.dataset.del); renderList(); sync(); }
    });
    list.querySelectorAll('[data-conv]').forEach(b => b.onclick = (ev) => { ev.stopPropagation(); convertFlow(b.dataset.conv); });
  }

  // ---------- 编辑/新增 弹层 ----------
  function field(label, html) { return `<div class="field"><label>${label}</label>${html}</div>`; }
  function formHtml(type, e) {
    e = e || {};
    const catOpts = ['<option value="">（未分类）</option>']
      .concat(store.categories().map(c => `<option value="${esc(c)}" ${e.category === c ? 'selected' : ''}>${esc(c)}</option>`));
    let h = `<div class="field"><label>类型</label><select id="f-type">` +
      TYPE_ORDER.map(k => `<option value="${k}" ${type === k ? 'selected' : ''}>${TYPES[k].icon} ${TYPES[k].label}</option>`).join('') +
      `</select></div>`;
    h += field('分类', `<select id="f-cat">${catOpts.join('')}</select>`);
    if (type === 'task') {
      h += field('标题', `<input id="f-title" value="${esc(e.title || '')}" />`);
      h += field('截止日期', `<input id="f-due" type="date" value="${esc(e.dueDate || '')}" />`);
      h += field('完成', `<label><input id="f-done" type="checkbox" ${e.done ? 'checked' : ''}/> 已勾选划去</label>`);
      h += field('备注', `<textarea id="f-body">${esc(e.body || '')}</textarea>`);
    } else if (type === 'meeting') {
      h += field('标题', `<input id="f-title" value="${esc(e.title || '')}" />`);
      h += field('会议日期', `<input id="f-mdate" type="date" value="${esc(e.meetingDate || '')}" />`);
      h += field('纪要 / 正文', `<textarea id="f-body">${esc(e.body || '')}</textarea>`);
    } else if (type === 'ledger') {
      h += field('金额 (¥)', `<input id="f-amt" type="number" step="0.01" value="${e.amount != null ? e.amount : ''}" />`);
      h += field('方向', `<div class="seg" id="f-dir">
        <button type="button" data-d="out" class="${e.direction !== 'in' ? 'on' : ''}">支出</button>
        <button type="button" data-d="in" class="${e.direction === 'in' ? 'on' : ''}">收入</button></div>`);
      h += field('日期', `<input id="f-ldate" type="date" value="${esc((e.created || '').slice(0, 10))}" />`);
      h += field('备注', `<input id="f-body" value="${esc(e.body || '')}" />`);
    } else if (type === 'inspiration') {
      h += field('灵感内容', `<textarea id="f-body">${esc(e.body || '')}</textarea>`);
    } else { // misc
      h += field('内容', `<textarea id="f-body">${esc(e.body || '')}</textarea>`);
    }
    return h;
  }
  function openEditor(idOrNull, defaultType) {
    editingId = idOrNull;
    const existing = idOrNull ? store.get(idOrNull) : null;
    editorType = defaultType || (existing ? existing.type : (cur.type !== 'all' ? cur.type : 'misc'));
    $('#editor-title').textContent = existing ? '编辑' : '新增';
    $('#editor-body').innerHTML = formHtml(editorType, existing);
    // 类型切换
    $('#f-type').onchange = () => { editorType = $('#f-type').value; openEditor(idOrNull, editorType); };
    // 收支分段
    const dir = $('#f-dir');
    if (dir) dir.querySelectorAll('button').forEach(b => b.onclick = () => {
      dir.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    });
    // 时间戳
    if (existing) {
      $('#editor-stamps').textContent = `创建 ${fmtDate(existing.created)} · 修改 ${fmtDate(existing.updated)}`;
    } else {
      $('#editor-stamps').textContent = '';
    }
    $('#editor').classList.remove('hidden');
    const first = $('#editor-body').querySelector('input,textarea,select');
    if (first) setTimeout(() => first.focus(), 50);
  }
  function collectForm() {
    const type = $('#f-type').value;
    const cat = $('#f-cat').value;
    const body = $('#f-body') ? $('#f-body').value : '';
    const patch = { type, category: cat, body };
    if (type === 'task') {
      patch.title = $('#f-title').value;
      patch.dueDate = $('#f-due').value;
      patch.done = $('#f-done').checked;
    } else if (type === 'meeting') {
      patch.title = $('#f-title').value;
      patch.meetingDate = $('#f-mdate').value;
    } else if (type === 'ledger') {
      patch.amount = parseFloat($('#f-amt').value) || 0;
      patch.direction = ($('#f-dir').querySelector('.on') || {}).dataset?.d || 'out';
      const d = $('#f-ldate').value;
      if (d && (!editingId)) patch.created = new Date(d + 'T00:00:00').toISOString();
    } else if (type === 'inspiration') {
      if (!editingId) patch.capturedAt = new Date().toISOString();
    }
    return patch;
  }
  async function saveEditor() {
    const patch = collectForm();
    if (editingId) store.updateEntry(editingId, patch);
    else store.addEntry(patch);
    $('#editor').classList.add('hidden');
    renderList(); renderCats();
    await sync();
  }

  // ---------- 灵感转普通记录 ----------
  async function convertFlow(id) {
    const e = store.get(id);
    if (!e) return;
    const target = prompt('转为哪种类型？输入：misc / task / ledger / meeting', 'misc');
    if (!target || !TYPE_ORDER.includes(target)) return;
    const extra = {};
    if (target === 'task') extra.dueDate = prompt('截止日期（可空，格式 YYYY-MM-DD）', '') || '';
    if (target === 'ledger') {
      extra.amount = parseFloat(prompt('金额（¥）', '0')) || 0;
      extra.direction = confirm('这是收入吗？确定=收入，取消=支出') ? 'in' : 'out';
    }
    if (target === 'meeting') extra.meetingDate = prompt('会议日期（可空，格式 YYYY-MM-DD）', '') || '';
    store.convertInspiration(id, target, extra);
    renderList();
    await sync();
    toast('已转换为' + TYPES[target].label);
  }

  // ---------- 导出（基础版：当前列表 → Markdown / JSON） ----------
  function exportText() {
    const items = store.filter({ type: cur.type, category: cur.cat, q: cur.q });
    let md = `# Sparkbook 导出（${fmtDate(new Date().toISOString())}）\n\n`;
    let curT = '';
    items.forEach(e => {
      if (e.type !== curT) { curT = e.type; md += `\n## ${TYPES[e.type].label}\n`; }
      const cat = e.category ? ` [${e.category}]` : '';
      md += `- ${fmtDate(e.created)}${cat} ${entrySummary(e)}\n`;
    });
    $('#textout-area').value = md;
    $('#textout').classList.remove('hidden');
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('#unlock-btn').onclick = () => {
      const pw = $('#password').value;
      if (!pw) { $('#lock-error').textContent = '请输入主密码'; return; }
      doUnlock(pw, true);
    };
    $('#password').addEventListener('keydown', e => { if (e.key === 'Enter') $('#unlock-btn').click(); });

    $('#lock-btn').onclick = () => {
      store.clearSession(); store.lock();
      $('#app').classList.add('hidden'); $('#lock-screen').classList.remove('hidden');
      $('#password').value = '';
    };
    $('#menu-toggle').onclick = () => $('#sidebar').classList.toggle('open');

    $('#fab').onclick = () => openEditor(null);
    $('#editor-save').onclick = saveEditor;
    $('#editor-close').onclick = () => $('#editor').classList.add('hidden');
    $('#editor-exit').onclick = () => {
      const ta = $('#editor-body').querySelector('textarea');
      if (ta && ta.value.trim()) {
        if (confirm('框内有内容，直接退出将丢弃。点「确定」丢弃，点「取消」返回保存。')) $('#editor').classList.add('hidden');
      } else $('#editor').classList.add('hidden');
    };
    $('#add-cat-btn').onclick = () => {
      const name = prompt('新分类名称：');
      if (name && store.addCategory(name)) { renderCats(); sync(); }
    };
    $('#search').addEventListener('input', e => { cur.q = e.target.value.trim(); renderList(); });

    $('#textout-close').onclick = () => $('#textout').classList.add('hidden');
    $('#textout-copy').onclick = () => {
      const ta = $('#textout-area'); ta.select();
      navigator.clipboard?.writeText(ta.value).then(() => toast('已复制'), () => toast('复制失败'));
    };
    $('#export-btn').onclick = exportText;
    $('#daily-btn').onclick = () => toast('日报助手将在 P4 阶段接入');

    // 快捷键 N 唤起新增（已解锁时）
    document.addEventListener('keydown', e => {
      if ($('#app').classList.contains('hidden')) return;
      if (e.key === 'n' || e.key === 'N') {
        if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
        openEditor(null);
      }
      if (e.key === 'Escape' && !$('#editor').classList.contains('hidden')) {
        $('#editor').classList.add('hidden');
      }
    });
  }

  // ---------- 启动 ----------
  async function boot() {
    bind();
    if (store.canAutoUnlock()) {
      const ok = await store.autoUnlock();
      if (ok) { $('#lock-screen').classList.add('hidden'); $('#app').classList.remove('hidden'); afterUnlock(); return; }
    }
    $('#lock-screen').classList.remove('hidden');
  }
  boot();
})();
