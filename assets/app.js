/* Sparkbook UI 控制器 */
(function () {
  'use strict';
  const store = new SparkStore();
  const $ = sel => document.querySelector(sel);
  const TYPES = window.SparkTypes;
  const TYPE_ORDER = window.SparkTypeOrder;
  // 与 store.js 同源，重复声明（store 内部常量未导出）
  const API_BASE = 'https://1256784020-0i70k3at89.ap-guangzhou.tencentscf.com';
  // 日报助手冷启动种子（人设基底，随应用内置，对应 日报助手.txt）
  const DAILY_SEED = `我是银行的公司经营管理平台、同业经营管理平台的项目经理，我负责需求跟进、成本优化与系统运维，还要负责对应的外包人员管理。这两个系统内有对应的集市模块（对公集市、同业集市），两个系统本身用的是oceanbase数据库的oracle模式，集市用的是星环TDH数据库。
你是我的对公、同业经营管理平台项目经理助理。

请根据我提供的流水账，生成精简日报：全文可复制，无特殊格式，段落间不留空行，每篇2-4点，聚焦项目管理核心动作（进度、风险、资源、验收）。除非我主动提及，否则禁止出现“智能表格”等相关字眼。

请长期记忆我的工作语境，包括但不限于：需求、经营平台埋点、厂商对接、成本管控、VP流程、绩效重算、系统画像等词汇。

我会不定期录入带日期的流水账，请你按日期归档；支持我随时生成当天或回溯历史日期的日报。

此外，我会偶尔发送我最终发给领导的正式日报给你。请你分析这些正式版本与我初稿的差异（如措辞更官方、更聚焦结果、删减过程细节等），并在后续生成中自动向我的正式发文风格靠拢。`;

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
  function defaultDateTime() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
        if (name === '工作') { toast('「工作」是日报核心分类，不可删除'); return; }
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
    // 点击卡片本身 → 阅读视图（不冒泡到 action 按钮上）
    list.querySelectorAll('.entry').forEach(el => {
      el.addEventListener('click', ev => {
        if (ev.target.closest('.entry-actions')) return; // 点了操作按钮不触发
        openReader(el.dataset.id);
      });
    });
  }

  // ---------- 阅读详情 ----------
  let readingId = null;
  function openReader(id) {
    const e = store.get(id);
    if (!e) return;
    readingId = id;
    const typeLabel = `${TYPES[e.type].icon} ${TYPES[e.type].label}`;
    $('#reader-title').textContent = typeLabel;
    let html = '';
    // 分类
    if (e.category) html += `<div class="field"><label>分类</label><p>#${esc(e.category)}</p></div>`;
    // 按类型渲染字段
    if (e.type === 'task') {
      html += `<div class="field"><label>标题</label><p>${esc(e.title)}</p></div>`;
      if (e.dueDate) html += `<div class="field"><label>截止日期</label><p>${esc(e.dueDate)}</p></div>`;
      html += `<div class="field"><label>状态</label><p>${e.done ? '✅ 已完成' : '⬜ 未完成'}</p></div>`;
      if (e.body) html += `<div class="field"><label>备注</label><pre class="reader-text">${esc(e.body)}</pre></div>`;
    } else if (e.type === 'meeting') {
      html += `<div class="field"><label>标题</label><p>${esc(e.title)}</p></div>`;
      if (e.meetingDate) html += `<div class="field"><label>会议日期</label><p>${esc(e.meetingDate)}</p></div>`;
      if (e.body) html += `<div class="field"><label>纪要 / 正文</label><pre class="reader-text">${esc(e.body)}</pre></div>`;
    } else if (e.type === 'ledger') {
      const a = (Number(e.amount) || 0).toFixed(2);
      const sign = e.direction === 'in' ? '+' : '-';
      const cls = e.direction === 'in' ? 'amt-in' : 'amt-out';
      html += `<div class="field"><label>金额</label><p class="${cls}">¥${sign}${a}</p></div>`;
      if (e.created) {
        const d = new Date(e.created);
        if (!isNaN(d)) {
          const p = n => String(n).padStart(2, '0');
          html += `<div class="field"><label>时间</label><p>${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}</p></div>`;
        }
      }
      if (e.body) html += `<div class="field"><label>备注</label><p>${esc(e.body)}</p></div>`;
    } else if (e.type === 'inspiration') {
      html += `<div class="field"><label>灵感内容</label><pre class="reader-text">${esc(e.body)}</pre></div>`;
      if (e.capturedAt) html += `<div class="field"><label>捕获时刻</label><p>${fmtDate(e.capturedAt)}</p></div>`;
    } else { // misc
      html += `<div class="field"><label>内容</label><pre class="reader-text">${esc(e.body || '')}</pre></div>`;
    }
    // 时间戳
    const edited = e.updated && e.created && e.updated > e.created;
    $('#reader-stamps').textContent =
      `创建 ${fmtDate(e.created)}${edited ? ' · 修改 ' + fmtDate(e.updated) : ''}`;
    $('#reader-body').innerHTML = html;
    $('#reader').classList.remove('hidden');
  }

  // ---------- 编辑/新增 弹层 ----------
  function field(label, html) { return `<div class="field"><label>${label}</label>${html}</div>`; }
  function formHtml(type, e) {
    e = e || {};
    // 会议类型新建时默认分类=工作（日报核心分类），其余类型默认未分类；二者均可手动改
    const defCat = (type === 'meeting' && !e.category) ? '工作' : e.category;
    const catOpts = ['<option value="">（未分类）</option>']
      .concat(store.categories().map(c => `<option value="${esc(c)}" ${defCat === c ? 'selected' : ''}>${esc(c)}</option>`));
    let h = `<div class="field"><label>类型</label><select id="f-type">` +
      TYPE_ORDER.map(k => `<option value="${k}" ${type === k ? 'selected' : ''}>${TYPES[k].icon} ${TYPES[k].label}</option>`).join('') +
      `</select></div>`;
    h += field('分类', `<select id="f-cat">${catOpts.join('')}</select>`);
    if (type === 'task') {
      h += field('标题', `<input id="f-title" value="${esc(e.title || '')}" />`);
      h += field('截止时间', `<input id="f-due" placeholder="YYYY-MM-DD HH:mm" value="${esc(e.dueDate || defaultDateTime())}" />`);
      h += field('完成', `<label><input id="f-done" type="checkbox" ${e.done ? 'checked' : ''}/> 已勾选划去</label>`);
      h += field('备注', `<textarea id="f-body">${esc(e.body || '')}</textarea>`);
    } else if (type === 'meeting') {
      h += field('标题', `<input id="f-title" value="${esc(e.title || '')}" />`);
      h += field('会议时间', `<input id="f-mdate" placeholder="YYYY-MM-DD HH:mm" value="${esc(e.meetingDate || defaultDateTime())}" />`);
      h += field('录音转写', `<div class="rec-inline">
        <input id="f-rec-file" type="file" accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg,.amr" />
        <button type="button" id="f-rec-go" class="btn btn-ghost">🎙 转写并填入</button>
        <span id="f-rec-status" class="muted small"></span>
      </div>`);
      h += field('纪要 / 正文', `<textarea id="f-body">${esc(e.body || '')}</textarea>`);
    } else if (type === 'ledger') {
      // 账本：日期+时间合并为单个文本框（不依赖控件）；新建默认当前时刻，编辑显示已保存时刻
      const p2 = n => String(n).padStart(2, '0');
      const base = (e.created ? new Date(e.created) : null);
      const ref = (base && !isNaN(base)) ? base : new Date();
      const dtStr = `${ref.getFullYear()}-${p2(ref.getMonth() + 1)}-${p2(ref.getDate())} ${p2(ref.getHours())}:${p2(ref.getMinutes())}`;
      h += field('金额 (¥)', `<input id="f-amt" type="number" step="0.01" value="${e.amount != null ? e.amount : ''}" />`);
      h += field('方向', `<div class="seg" id="f-dir">
        <button type="button" data-d="out" class="${e.direction !== 'in' ? 'on' : ''}">支出</button>
        <button type="button" data-d="in" class="${e.direction === 'in' ? 'on' : ''}">收入</button></div>`);
      h += field('时间', `<input id="f-ldatetime" placeholder="YYYY-MM-DD HH:mm" value="${esc(dtStr)}" />`);
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
    // 会议编辑器内嵌录音转写：选文件→上传→转写→填入正文
    const recGo = $('#f-rec-go');
    if (recGo) {
      recGo.onclick = async () => {
        const file = $('#f-rec-file').files[0];
        if (!file) { toast('请先选择录音文件'); return; }
        if (file.size > 5 * 1024 * 1024) { toast('音频建议小于 5MB（短录音）；更长录音暂不支持'); $('#f-rec-status').textContent = ''; return; }
        $('#f-rec-status').textContent = '上传中…';
        try {
          const key = await uploadAudio(file);
          $('#f-rec-status').textContent = '云端转写中（可能需1-2分钟）…';
          const text = await transcribeAudio(key);
          const ta = $('#f-body');
          ta.value = (ta.value ? ta.value + '\n\n' : '') + text;
          $('#f-rec-status').textContent = '已填入纪要';
          toast('录音已转写并填入纪要');
        } catch (e) { $('#f-rec-status').textContent = ''; toast('转写失败：' + (e.message || e)); }
      };
    }
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
      const due = ($('#f-due').value || '').trim();
      if (due && !/^\d{4}-\d{2}-\d{2}( \d{1,2}:\d{2})?$/.test(due)) { toast('截止时间格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm'); return null; }
      patch.dueDate = due;
      patch.done = $('#f-done').checked;
    } else if (type === 'meeting') {
      patch.title = $('#f-title').value;
      const md = ($('#f-mdate').value || '').trim();
      if (md && !/^\d{4}-\d{2}-\d{2}( \d{1,2}:\d{2})?$/.test(md)) { toast('会议时间格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm'); return null; }
      patch.meetingDate = md;
    } else if (type === 'ledger') {
      patch.amount = parseFloat($('#f-amt').value) || 0;
      patch.direction = ($('#f-dir').querySelector('.on') || {}).dataset?.d || 'out';
      const raw = ($('#f-ldatetime')?.value || '').trim();
      // 允许 YYYY-MM-DD 或 YYYY-MM-DD HH:mm
      if (!/^\d{4}-\d{2}-\d{2}( \d{1,2}:\d{2})?$/.test(raw)) { toast('时间格式应为 YYYY-MM-DD HH:mm'); return null; }
      const norm = raw.indexOf(' ') === -1 ? raw + ' 00:00' : raw;
      const [datePart, timePart] = norm.split(' ');
      const [hh, mm] = timePart.split(':').map(n => parseInt(n, 10));
      if (hh > 23 || mm > 59) { toast('时间不合法（时 0-23，分 0-59）'); return null; }
      const dt = new Date(datePart + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00');
      if (isNaN(dt)) { toast('日期或时间不合法'); return null; }
      // 账本的日期时间即记录时刻，存入 created（新建与编辑一致）
      patch.created = dt.toISOString();
    } else if (type === 'inspiration') {
      if (!editingId) patch.capturedAt = new Date().toISOString();
    }
    return patch;
  }
  async function saveEditor() {
    const patch = collectForm();
    if (!patch) return; // 校验失败已 toast 提示
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
    if (target === 'task') extra.dueDate = prompt('截止时间（可空，格式 YYYY-MM-DD 或 YYYY-MM-DD HH:mm）', '') || '';
    if (target === 'ledger') {
      extra.amount = parseFloat(prompt('金额（¥）', '0')) || 0;
      extra.direction = confirm('这是收入吗？确定=收入，取消=支出') ? 'in' : 'out';
    }
    if (target === 'meeting') extra.meetingDate = prompt('会议时间（可空，格式 YYYY-MM-DD 或 YYYY-MM-DD HH:mm）', '') || '';
    store.convertInspiration(id, target, extra);
    renderList();
    await sync();
    toast('已转换为' + TYPES[target].label);
  }

  // ---------- 导出（全库双格式：MD 人读/喂日报 + JSON 程序恢复） ----------
  let exportFmt = 'md';
  function buildExport(fmt) {
    const items = store.list(); // 全库
    if (fmt === 'json') {
      return JSON.stringify(store.state, null, 2);
    }
    // Markdown：按 类型 → 分类 → 日期 排版
    const now = fmtDate(new Date().toISOString());
    let md = `# Sparkbook 导出（${now}）\n\n`;
    TYPE_ORDER.forEach(type => {
      const ofType = items.filter(e => e.type === type);
      if (!ofType.length) return;
      md += `## ${TYPES[type].icon} ${TYPES[type].label}\n`;
      // 按分类分组（无分类归入 [未分类]）
      const byCat = {};
      ofType.forEach(e => {
        const c = e.category || '未分类';
        (byCat[c] = byCat[c] || []).push(e);
      });
      Object.keys(byCat).forEach(cat => {
        md += `### [${cat}]\n`;
        byCat[cat]
          .slice()
          .sort((a, b) => (a.created || '').localeCompare(b.created || ''))
          .forEach(e => {
            md += `- ${fmtDate(e.created)} · ${entrySummary(e)}\n`;
          });
      });
      md += '\n';
    });
    return md.trim() + '\n';
  }
  function renderExport() {
    $('#textout-area').value = buildExport(exportFmt);
    $('#export-hint').textContent =
      exportFmt === 'json' ? '全库 · JSON 整库（可程序恢复）' : '全库 · 按类型→分类→日期';
  }
  function openExport() {
    exportFmt = 'md';
    $('#export-fmt').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.f === 'md'));
    renderExport();
    $('#textout').classList.remove('hidden');
  }
  function copyExport() {
    const ta = $('#textout-area'); ta.select();
    navigator.clipboard?.writeText(ta.value).then(() => toast('已复制'), () => toast('复制失败'));
  }
  function downloadExport() {
    const txt = $('#textout-area').value;
    const ext = exportFmt === 'json' ? 'json' : 'md';
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sparkbook-export.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已下载 sparkbook-export.' + ext);
  }

  // ---------- 账本汇总（P5） ----------
  function openSummary() {
    const items = store.list().filter(e => e.type === 'ledger');
    let income = 0, expense = 0;
    items.forEach(e => {
      const a = Number(e.amount) || 0;
      if (e.direction === 'in') income += a; else expense += a;
    });
    const net = income - expense;
    $('#ls-totals').innerHTML =
      `收入 <b class="amt-in">¥${income.toFixed(2)}</b> · 支出 <b class="amt-out">¥${expense.toFixed(2)}</b> ` +
      `· 净额 <b>¥${net.toFixed(2)}</b> · 共 ${items.length} 笔`;
    const byMonth = {};
    items.forEach(e => {
      const m = (e.created || '').slice(0, 7);
      if (!m) return;
      byMonth[m] = byMonth[m] || { in: 0, out: 0, n: 0 };
      byMonth[m].n++;
      byMonth[m][e.direction === 'in' ? 'in' : 'out'] += Number(e.amount) || 0;
    });
    $('#ls-month').innerHTML = Object.keys(byMonth).sort().map(m => {
      const x = byMonth[m];
      return `<div class="ls-row"><span>${m}</span><span class="amt-in">+¥${x.in.toFixed(2)}</span>` +
        `<span class="amt-out">-¥${x.out.toFixed(2)}</span><span class="muted">${x.n}笔</span></div>`;
    }).join('') || '<div class="muted small">暂无账本数据</div>';
    const byCat = {};
    items.forEach(e => {
      const c = e.category || '未分类';
      byCat[c] = byCat[c] || { in: 0, out: 0, n: 0 };
      byCat[c].n++;
      byCat[c][e.direction === 'in' ? 'in' : 'out'] += Number(e.amount) || 0;
    });
    $('#ls-cat').innerHTML = Object.keys(byCat).sort().map(c => {
      const x = byCat[c];
      return `<div class="ls-row"><span>#${esc(c)}</span><span class="amt-in">+¥${x.in.toFixed(2)}</span>` +
        `<span class="amt-out">-¥${x.out.toFixed(2)}</span><span class="muted">${x.n}笔</span></div>`;
    }).join('') || '<div class="muted small">暂无账本数据</div>';
    $('#ledger-summary').classList.remove('hidden');
  }

  // ---------- 录音转写（P5） ----------
  function openRecorder() {
    $('#rec-result').value = ''; $('#rec-save').disabled = true; $('#rec-status').textContent = '';
    $('#recorder').classList.remove('hidden');
  }
  // 中继上传：前端把音频 POST 给 SCF，SCF 用服务端密钥写 COS（免浏览器直连 CORS 痛点）
  // 受 API 网关请求体上限（约 6MB）限制，超过则提示用更短录音。
  async function uploadAudio(file) {
    const ext = (file.name.split('.').pop() || 'm4a').toLowerCase();
    const r = await fetch(API_BASE + '/api/asr/upload?ext=' + encodeURIComponent(ext), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    });
    if (!r.ok) throw new Error('上传 HTTP ' + r.status);
    const d = await r.json().catch(() => ({}));
    if (d.code !== 0) throw new Error(d.msg || ('code ' + d.code));
    return d.key;
  }
  async function transcribeAudio(key) {
    const r = await fetch(API_BASE + '/api/asr/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.code !== 0) throw new Error(d.msg || ('code ' + d.code));
    return d.text || '';
  }
  async function recTranscribe() {
    const file = $('#rec-file').files[0];
    if (!file) { toast('请先选择录音文件'); return; }
    if (file.size > 5 * 1024 * 1024) { toast('音频建议小于 5MB（短录音）；更长录音暂不支持'); $('#rec-status').textContent = ''; return; }
    $('#rec-status').textContent = '上传中…';
    try {
      const key = await uploadAudio(file);
      $('#rec-status').textContent = '云端转写中（可能需1-2分钟）…';
      const text = await transcribeAudio(key);
      $('#rec-result').value = text;
      $('#rec-save').disabled = !(text && text.trim());
      $('#rec-status').textContent = '完成';
    } catch (e) { $('#rec-status').textContent = ''; toast('转写失败：' + (e.message || e)); }
  }
  async function recSave() {
    const text = $('#rec-result').value.trim();
    if (!text) { toast('没有可保存的内容'); return; }
    const now = defaultDateTime();
    store.addEntry({ type: 'meeting', title: '会议录音纪要 ' + now.slice(0, 10), meetingDate: now, body: text });
    await sync();
    toast('已保存为会议记录');
    $('#recorder').classList.add('hidden');
  }

  // ---------- 日报助手（P4 + 周报模式 P5） ----------
  let dailyLast = null; // { generated, date, material }
  let dailyMode = 'day'; // day | week

  function fmtDateOnly(iso) { return (iso || '').slice(0, 10); }

  function dailyEntryLine(e) {
    if (e.type === 'ledger') {
      const a = (Number(e.amount) || 0).toFixed(2);
      const sign = e.direction === 'in' ? '+' : '-';
      return `- [账本] ${sign}¥${a} ${e.body || ''}`;
    }
    if (e.type === 'task') {
      return `- [任务] ${e.title || ''}${e.dueDate ? `（截止 ${e.dueDate}）` : ''}${e.done ? '（已完成）' : ''}：${e.body || ''}`;
    }
    if (e.type === 'meeting') {
      return `- [会议] 参加：${e.title || ''}（${e.meetingDate || ''}）\n  ${e.body || ''}`;
    }
    if (e.type === 'inspiration') return `- [灵感] ${e.body || ''}`;
    return `- ${e.body || e.title || ''}`;
  }
  function formatMaterial(entries) {
    return entries.map(dailyEntryLine).join('\n');
  }
  function formatStyleProfile(sp) {
    sp = sp || { terms: [], rules: [], samples: [] };
    let s = '';
    if (sp.terms && sp.terms.length) s += '术语表：' + sp.terms.join('、') + '\n';
    if (sp.rules && sp.rules.length) s += '风格要点：\n' + sp.rules.map(r => '- ' + r).join('\n') + '\n';
    if (sp.samples && sp.samples.length) {
      s += '对照样例：\n';
      sp.samples.forEach(x => { s += `- 初稿：${x.before || ''}\n  终稿：${x.after || ''}\n`; });
    }
    return s.trim() || '（暂无，按基底人设生成）';
  }

  async function callAI(action, messages, opts) {
    opts = opts || {};
    toast(action === 'evolve' ? 'AI 风格进化中…' : 'AI 生成中…');
    try {
      const resp = await fetch(API_BASE + '/api/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action, messages,
          max_tokens: opts.max_tokens || 2000,
          temperature: opts.temperature != null ? opts.temperature : 0.3,
        }),
      });
      const d = await resp.json().catch(() => ({}));
      if (d.code !== 0) { toast('AI 失败：' + (d.msg || d.code)); return null; }
      return d.text;
    } catch (e) { toast('请求失败：' + (e.message || e)); return null; }
  }

  function fmtYMD(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function weekRange() {
    const t = new Date();
    const day = t.getDay(); // 0=周日 .. 6=周六
    const diffToMon = (day === 0 ? -6 : 1 - day);
    const mon = new Date(t); mon.setDate(t.getDate() + diffToMon); mon.setHours(0, 0, 0, 0);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return [fmtYMD(mon), fmtYMD(sun)];
  }
  // 日报只采纳：会议 + 分类为"工作"的条目
  function isDailySource(e) {
    if (e.type === 'meeting') return true;
    return e.category === '工作';
  }
  function dailyRangeItems() {
    const all = store.list();
    if (dailyMode === 'week') {
      const s = $('#daily-start').value, e = $('#daily-end').value;
      if (!s || !e) return [];
      return all.filter(x => { const d = fmtDateOnly(x.created); return d >= s && d <= e && isDailySource(x); });
    }
    const d = $('#daily-date').value;
    if (!d) return [];
    return all.filter(x => fmtDateOnly(x.created) === d && isDailySource(x));
  }
  function renderDailyChecklist() {
    const box = $('#daily-checklist');
    const items = dailyRangeItems();
    if (!items.length) {
      box.innerHTML = '<div class="muted small">该范围没有记录。可在「追加素材」粘贴流水账。</div>';
      updateDailySelCount();
      return;
    }
    box.innerHTML = items.map(e =>
      `<label class="daily-check"><input type="checkbox" data-id="${e.id}" checked />
        <span>${TYPES[e.type].icon} ${fmtDate(e.created)} · ${entrySummary(e)}</span></label>`
    ).join('');
    box.querySelectorAll('input').forEach(c => c.onchange = updateDailySelCount);
    updateDailySelCount();
  }
  function updateDailySelCount() {
    const n = document.querySelectorAll('#daily-checklist input[type=checkbox]:checked').length;
    const total = document.querySelectorAll('#daily-checklist input[type=checkbox]').length;
    $('#daily-selcount').textContent = `${n}/${total} 已选`;
  }
  function getDailySelected() {
    const ids = [...document.querySelectorAll('#daily-checklist input[type=checkbox]:checked')].map(c => c.dataset.id);
    return ids.map(id => store.get(id)).filter(Boolean);
  }

  async function dailyGenerate() {
    const dateStr = dailyMode === 'week'
      ? `${$('#daily-start').value} ~ ${$('#daily-end').value}`
      : $('#daily-date').value;
    if (!dateStr || dateStr === ' ~ ') { toast(dailyMode === 'week' ? '请选择起止日期' : '请选择日期'); return; }
    const sel = getDailySelected();
    const paste = ($('#daily-paste').value || '').trim();
    let material = formatMaterial(sel);
    if (paste) material += (material ? '\n' : '') + paste;
    if (!material.trim()) { toast('请勾选条目或在「追加素材」粘贴'); return; }
    const sp = store.styleProfile();
    const sys = DAILY_SEED + '\n\n# 已习得的风格偏好（动态积累）\n' + formatStyleProfile(sp);
    const bg = ($('#daily-bg').value || '').trim();
    const user = `请基于以下 ${dateStr} 的素材生成当日精简日报。\n\n【素材】\n${material}` +
      (bg ? `\n\n【补充背景 / 要求】\n${bg}` : '') +
      `\n\n要求：全文可复制、无特殊格式、段落间不留空行、每篇2-4点、聚焦进度/风险/资源/验收；如有会议素材必须包含「参加：标题」。`;
    const text = await callAI('generate', [{ role: 'system', content: sys }, { role: 'user', content: user }]);
    if (text != null) {
      $('#daily-result').value = text;
      dailyLast = { generated: text, date: dateStr, material };
      toast('已生成');
    }
  }
  function dailyCopy() {
    const t = $('#daily-result').value;
    if (!t.trim()) { toast('没有可复制的内容'); return; }
    navigator.clipboard?.writeText(t).then(() => toast('已复制'), () => toast('复制失败'));
  }
  function parseStyleJSON(text, fallback) {
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const o = JSON.parse(m[0]);
      return {
        terms: Array.isArray(o.terms) ? o.terms : (fallback.terms || []),
        rules: Array.isArray(o.rules) ? o.rules : (fallback.rules || []),
        samples: Array.isArray(o.samples) ? o.samples : (fallback.samples || []),
      };
    } catch { return null; }
  }
  async function dailyRevise() {
    const revised = $('#daily-result').value;
    if (!revised.trim()) { toast('没有可采纳的内容'); return; }
    // 无论有无差异，先采纳复制
    navigator.clipboard?.writeText(revised).then(() => toast('已复制'), () => toast('复制失败'));
    if (!dailyLast || revised.trim() === (dailyLast.generated || '').trim()) {
      toast('无差异，仅复制');
      return;
    }
    // 有差异 → reasoner 进化风格档案
    const sp = store.styleProfile();
    const msgs = [
      { role: 'system', content: DAILY_SEED + '\n\n你是一位「写作风格进化器」。用户会给你 AI 初稿与其亲自修订后的终稿，请分析终稿相对初稿体现的正式发文偏好（措辞更官方、更聚焦结果、删减过程细节、术语使用、结构详略等），输出更新后的风格偏好档案。只输出一个 JSON，不要解释。' },
      { role: 'user', content:
        `日期：${dailyLast.date}\n\n【AI 初稿】\n${dailyLast.generated}\n\n【用户修订终稿】\n${revised}\n\n当前风格档案：\n${formatStyleProfile(sp)}\n\n请对比差异，提取用户的正式发文偏好，输出更新后的风格档案 JSON，严格格式：\n{"terms":["术语1"],"rules":["要点1"],"samples":[{"before":"初稿片段","after":"终稿片段"}]}\n新增项追加，重复项合并；samples 保留 2-4 组代表性对照。` }
    ];
    const out = await callAI('evolve', msgs, { temperature: 0.2, max_tokens: 1500 });
    if (out == null) return;
    const newSp = parseStyleJSON(out, sp);
    if (newSp) {
      store.saveStyleProfile(newSp);
      await sync();
      toast('风格档案已进化并保存');
    } else {
      toast('风格进化返回非 JSON，已复制终稿');
    }
  }

  // 风格档案读写
  // 冷启动：从 DAILY_SEED 提取初始术语/规则（仅当用户从未编辑过风格档案时）
  const SEED_TERMS = [
    '对公集市', '同业集市', 'OceanBase', 'Oracle模式', '星环TDH',
    '经营平台埋点', '厂商对接', '成本管控', 'VP流程', '绩效重算', '系统画像',
    '需求跟进', '系统运维', '外包人员管理'
  ];
  const SEED_RULES = [
    '精简、可复制、无特殊格式',
    '段落间不留空行',
    '每篇2-4点，聚焦进度/风险/资源/验收',
    '除非用户主动提及，否则不出现"智能表格"等字眼',
    '措辞官方化，聚焦结果而非过程细节'
  ];
  function loadStyleUI() {
    let sp = store.styleProfile() || { terms: [], rules: [], samples: [] };
    // 冷启动：三项全空时自动填入种子
    if ((!sp.terms || !sp.terms.length) && (!sp.rules || !sp.rules.length) && (!sp.samples || !sp.samples.length)) {
      sp = { terms: SEED_TERMS.slice(), rules: SEED_RULES.slice(), samples: [] };
      store.saveStyleProfile(sp);
    }
    $('#sp-terms').value = (sp.terms || []).join('\n');
    $('#sp-rules').value = (sp.rules || []).join('\n');
    $('#sp-samples').value = (sp.samples || []).map(s => (s.before || '') + '\n' + (s.after || '')).join('\n\n');
  }
  function saveStyleUI() {
    const sp = {
      terms: $('#sp-terms').value.split('\n').map(s => s.trim()).filter(Boolean),
      rules: $('#sp-rules').value.split('\n').map(s => s.trim()).filter(Boolean),
      samples: $('#sp-samples').value.split(/\n\s*\n/).map(g => {
        const lines = g.split('\n').map(s => s.trim()).filter(Boolean);
        if (lines.length < 2) return null;
        return {
          before: lines[0].replace(/^[-初稿：:]+/, ''),
          after: lines[1].replace(/^[-终稿：:]+/, ''),
        };
      }).filter(Boolean),
    };
    store.saveStyleProfile(sp);
    sync().then(() => toast('风格档案已保存'));
  }

  function switchDailyMode(mode) {
    dailyMode = mode;
    $('#daily-mode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    $('#daily-dayrow').classList.toggle('hidden', mode !== 'day');
    $('#daily-weekrow').classList.toggle('hidden', mode !== 'week');
    renderDailyChecklist();
  }
  function openDaily() {
    const t = new Date();
    const p = n => String(n).padStart(2, '0');
    $('#daily-date').value = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
    const [ws, we] = weekRange();
    $('#daily-start').value = ws; $('#daily-end').value = we;
    switchDailyMode('day');
    $('#daily-paste').value = ''; $('#daily-bg').value = ''; $('#daily-result').value = '';
    dailyLast = null;
    switchDailyTab('gen');
    $('#daily').classList.remove('hidden');
  }
  function switchDailyTab(tab) {
    $('#daily-tabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    $('#daily-gen').classList.toggle('hidden', tab !== 'gen');
    $('#daily-style').classList.toggle('hidden', tab !== 'style');
    if (tab === 'style') loadStyleUI();
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('#unlock-btn').onclick = () => {
      const pw = $('#password').value;
      if (!pw) { $('#lock-error').textContent = '请输入主密码'; return; }
      doUnlock(pw, true);
    };
    $('#password').addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.keyCode === 13) && !e.isComposing) {
        e.preventDefault();
        const pw = $('#password').value;
        if (!pw) { $('#lock-error').textContent = '请输入主密码'; return; }
        doUnlock(pw, true);
      }
    });

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
    // 阅读弹层
    $('#reader-close').onclick = () => { readingId = null; $('#reader').classList.add('hidden'); };
    $('#reader-edit').onclick = () => {
      if (readingId) { openEditor(readingId); $('#reader').classList.add('hidden'); }
    };
    $('#add-cat-btn').onclick = () => {
      const name = prompt('新分类名称：');
      if (name && store.addCategory(name)) { renderCats(); sync(); }
    };
    $('#search').addEventListener('input', e => { cur.q = e.target.value.trim(); renderList(); });

    $('#textout-close').onclick = () => $('#textout').classList.add('hidden');
    $('#textout-copy').onclick = copyExport;
    $('#textout-download').onclick = downloadExport;
    $('#export-fmt').querySelectorAll('button').forEach(b => b.onclick = () => {
      $('#export-fmt').querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      exportFmt = b.dataset.f;
      renderExport();
    });
    $('#export-btn').onclick = openExport;
    $('#summary-btn').onclick = openSummary;
    $('#ls-close').onclick = () => $('#ledger-summary').classList.add('hidden');
    $('#daily-btn').onclick = openDaily;
    $('#daily-close').onclick = () => $('#daily').classList.add('hidden');
    $('#daily-tabs').querySelectorAll('button').forEach(b => b.onclick = () => switchDailyTab(b.dataset.tab));
    $('#daily-mode').querySelectorAll('button').forEach(b => b.onclick = () => switchDailyMode(b.dataset.mode));
    $('#daily-date').onchange = renderDailyChecklist;
    $('#daily-start').onchange = renderDailyChecklist;
    $('#daily-end').onchange = renderDailyChecklist;
    $('#rec-btn').onclick = openRecorder;
    $('#rec-open-btn').onclick = openRecorder;
    $('#rec-close').onclick = () => $('#recorder').classList.add('hidden');
    $('#rec-go').onclick = recTranscribe;
    $('#rec-save').onclick = recSave;
    $('#daily-selall').onclick = () => { document.querySelectorAll('#daily-checklist input').forEach(c => c.checked = true); updateDailySelCount(); };
    $('#daily-selnone').onclick = () => { document.querySelectorAll('#daily-checklist input').forEach(c => c.checked = false); updateDailySelCount(); };
    $('#daily-gen-btn').onclick = dailyGenerate;
    $('#daily-copy').onclick = dailyCopy;
    $('#daily-revise').onclick = dailyRevise;
    $('#sp-save').onclick = saveStyleUI;

    // 快捷键 N 唤起新增（已解锁时）
    document.addEventListener('keydown', e => {
      if ($('#app').classList.contains('hidden')) return;
      if (e.key === 'n' || e.key === 'N') {
        if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
        openEditor(null);
      }
      if (e.key === 'Escape') {
        if (!$('#reader').classList.contains('hidden')) { readingId = null; $('#reader').classList.add('hidden'); }
        else if (!$('#editor').classList.contains('hidden')) $('#editor').classList.add('hidden');
        else if (!$('#ledger-summary').classList.contains('hidden')) $('#ledger-summary').classList.add('hidden');
        else if (!$('#recorder').classList.contains('hidden')) $('#recorder').classList.add('hidden');
        else if (!$('#daily').classList.contains('hidden')) $('#daily').classList.add('hidden');
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
