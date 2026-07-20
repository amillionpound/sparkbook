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
  // 轻量 Markdown→HTML（输入已 esc 过），用于阅读视图渲染 AI 纪要
  function formatMarkdown(text) {
    let html = text || '';
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    // 把连续的 <li> 包裹进 <ul>
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    html = html.replace(/\n{2,}/g, '</p><p>');
    html = '<p>' + html + '</p>';
    // 清理空标签
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<ul><\/ul>/g, '');
    return html;
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

  // ---------- 弹层栈 / 安卓物理返回键拦截 ----------
  // 维护打开中的弹层栈；每打开一个弹层就 history.pushState 一条记录。
  // 安卓物理返回键触发 popstate 时，改为关闭最上层弹层（有未保存内容先确认），
  // 而不是退出 PWA——避免正在填写的内容丢失。无弹层时不做处理，交由系统把 PWA
  // 切到后台（最小化/切换应用本就会保活，内存中的填写内容不会丢）。
  const modalStack = [];
  let suppressPop = false; // 程序内关闭弹层时屏蔽由其 history.back 触发的 popstate
  function isModalOpen(id) { return !$(id).classList.contains('hidden'); }
  // 有未保存内容需确认时返回提示语，否则返回 null
  function modalDirtyMsg(id) {
    if (id === '#editor') {
      const ta = $('#editor-body').querySelector('textarea');
      if (ta && ta.value.trim()) return '框内有未保存的内容，退出将丢弃。';
    }
    if (id === '#recorder') {
      if (($('#rec-result').value || '').trim()) return '录音转写/纪要尚未保存，退出将丢弃。';
    }
    return null;
  }
  function openModal(id) {
    // 打开弹层时自动收起侧栏（避免遮罩层叠干扰）
    const sb = $('#sidebar'), ov = $('#sidebar-overlay');
    if (sb) sb.classList.remove('open');
    if (ov) ov.classList.add('hidden');
    if (!isModalOpen(id)) {
      modalStack.push(id);
      history.pushState({ sparkModal: id }, '');
    }
    $(id).classList.remove('hidden');
  }
  function dismissModal(id, opts) {
    opts = opts || {};
    if (!opts.force) {
      const dm = modalDirtyMsg(id);
      if (dm && !confirm(dm + '确定丢弃？')) return false;
    }
    $(id).classList.add('hidden');
    const i = modalStack.lastIndexOf(id);
    if (i >= 0) modalStack.splice(i, 1);
    if (!opts.fromBack) { suppressPop = true; history.back(); }
    return true;
  }
  // 安卓物理返回键：关闭最上层弹层（有未保存内容先确认），不退出应用
  window.addEventListener('popstate', () => {
    if (suppressPop) { suppressPop = false; return; }
    if (!modalStack.length) return; // 无弹层 → 系统后台保活，不拦截
    const id = modalStack.pop();
    const dm = modalDirtyMsg(id);
    if (dm) {
      // 有未保存内容：重新压回状态阻止退出，并询问是否丢弃
      modalStack.push(id);
      history.pushState({ sparkModal: id }, '');
      if (confirm(dm + '确定丢弃？')) { modalStack.pop(); $(id).classList.add('hidden'); }
      return;
    }
    $(id).classList.add('hidden');
  });
  // 点击弹层遮罩（卡片外区域）关闭弹层
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) dismissModal('#' + m.id); });
  });

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
      `<span class="cat-pill ${cur.cat === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</span>`
    ).join('');
    box.innerHTML = html;
    box.querySelectorAll('.cat-pill').forEach(p => {
      p.onclick = () => { cur.cat = p.dataset.cat; renderCats(); renderList(); };
    });
  }

  // ---------- 设置（随库加密同步） ----------
  function openSettings() {
    const s = store.settings();
    document.querySelectorAll('#set-model input').forEach(r => { r.checked = (r.value === s.summaryModel); });
    document.querySelectorAll('#set-engine input').forEach(r => { r.checked = (r.value === s.asrEngine); });
    renderSettingsCats();
    renderSettingsRequirements();
    openModal('#settings');
  }
  function renderSettingsCats() {
    const box = $('#set-cats');
    const cats = store.categories();
    if (!cats.length) { box.innerHTML = '<div class="muted small">还没有分类</div>'; return; }
    box.innerHTML = cats.map(c =>
      `<div class="set-cat-row">
        <span class="set-cat-name">${esc(c)}</span>
        ${c === '工作' ? '<span class="set-cat-hint">日报核心 · 不可删</span>'
          : `<button class="set-del-btn" data-delcat="${esc(c)}">删除</button>`}
      </div>`
    ).join('');
    box.querySelectorAll('[data-delcat]').forEach(b => b.onclick = () => {
      const name = b.dataset.delcat;
      if (confirm(`删除分类「${name}」？该分类下的条目将变为未分类。`)) {
        store.removeCategory(name);
        if (cur.cat === name) cur.cat = '';
        renderCats(); renderList(); renderSettingsCats(); sync();
      }
    });
  }
  function initSettings() {
    document.querySelectorAll('#set-model input').forEach(r => r.onchange = () => {
      store.saveSettings({ summaryModel: r.value }); sync();
      toast('会议总结模型：' + (r.value === 'reasoner' ? 'deepseek-reasoner（更准·更慢·约3-4倍成本）' : 'deepseek-chat（快·省）'));
    });
    document.querySelectorAll('#set-engine input').forEach(r => r.onchange = () => {
      store.saveSettings({ asrEngine: r.value }); sync();
      toast('语音引擎优先：' + (r.value === 'flash' ? '极速版（精度略降·≤2h/100MB）' : '标准版（精度最高）'));
    });
    $('#set-add-cat').onclick = () => {
      const v = ($('#set-new-cat').value || '').trim();
      if (!v) return;
      if (store.addCategory(v)) { $('#set-new-cat').value = ''; renderSettingsCats(); renderCats(); sync(); }
      else toast('分类已存在或无效');
    };
    $('#settings-close').onclick = () => dismissModal('#settings');
    $('#settings-btn').onclick = openSettings;
    $('#set-mine-all').onclick = () => {
      if (confirm('将重新扫描全部历史日报并抽取需求（可能消耗少量 API 额度），继续？')) mineAllRequirements();
    };
  }
  function renderSettingsRequirements() {
    const box = $('#set-reqs');
    if (!box) return;
    const reqs = store.requirements();
    if (!reqs.length) {
      box.innerHTML = '<div class="muted small">还没有挖掘到需求。生成日报后会自动积累；或点上方「重新挖掘全部历史日报」。</div>';
      return;
    }
    const keyOf = r => (r.code && r.code.trim()) ? ('C:' + r.code.trim()) : ('N:' + r.name.trim());
    box.innerHTML = reqs.map(r => {
      const k = keyOf(r);
      const code = (r.code || '').trim();
      const name = (r.name || '').trim() || '（未命名）';
      return `<div class="req-row">
        <div class="req-main">
          <span class="req-name">${esc(name)}</span>
          ${code ? `<span class="req-code">${esc(code)}</span>` : ''}
          <span class="req-stage">${esc(r.stage || '未知')}</span>
        </div>
        <div class="req-meta">首见 ${esc(r.firstSeen || '—')} · 最近 ${esc(r.lastSeen || '—')}</div>
        <div class="req-actions">
          <button class="mini-btn" data-editreq="${esc(k)}">✎ 改全称</button>
          <button class="set-del-btn" data-delreq="${esc(k)}">删除</button>
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-editreq]').forEach(b => b.onclick = () => {
      const k = b.dataset.editreq;
      const isCode = k.startsWith('C:');
      const cur = isCode
        ? (store.requirements().find(r => r.code === k.slice(2)) || {}).name
        : (store.requirements().find(r => r.name === k.slice(2)) || {}).name;
      const nv = prompt('修改需求全称：', cur || '');
      if (nv && nv.trim()) {
        const list = store.requirements();
        list.forEach(r => {
          const rk = (r.code && r.code.trim()) ? ('C:' + r.code.trim()) : ('N:' + r.name.trim());
          if (rk === k) r.name = nv.trim();
        });
        store.saveRequirements(list); sync(); renderSettingsRequirements();
      }
    });
    box.querySelectorAll('[data-delreq]').forEach(b => b.onclick = () => {
      if (confirm('删除该需求登记项？')) { store.removeRequirement(b.dataset.delreq); sync(); renderSettingsRequirements(); }
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
    if (e.type === 'worklog') {
      const t = esc(e.title || '');
      const b = esc(e.body || '');
      return (t + (t && b ? ' · ' : '') + b) || '（空）';
    }
    if (e.type === 'daily') {
      const t = esc(e.title || '');
      return (t ? t + ' · ' : '') + esc((e.body || '').slice(0, 60));
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
      const catHtml = (e.category && e.type !== 'daily') ? `<span class="entry-cat">#${esc(e.category)}</span>` : '';
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
      // AI 纪要（独立显示，优先展示）
      if (e.summary) {
        html += `<div class="field"><label>AI 纪要</label><div class="reader-text reader-summary">${formatMarkdown(esc(e.summary))}</div></div>`;
      }
      // 转写原文（可能很长，可滚动）
      if (e.body) {
        html += `<div class="field"><label>转写原文 / 正文</label><pre class="reader-text reader-transcript">${esc(e.body)}</pre></div>`;
      }
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
    } else if (e.type === 'worklog') {
      if (e.title) html += `<div class="field"><label>标题</label><p>${esc(e.title)}</p></div>`;
      if (e.body) html += `<div class="field"><label>内容</label><pre class="reader-text">${esc(e.body)}</pre></div>`;
    } else if (e.type === 'daily') {
      if (e.title) html += `<div class="field"><label>日期 / 标题</label><p>${esc(e.title)}</p></div>`;
      if (e.body) html += `<div class="field"><label>日报内容</label><pre class="reader-text">${esc(e.body)}</pre></div>`;
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
    openModal('#reader');
  }

  // ---------- 编辑/新增 弹层 ----------
  function field(label, html) { return `<div class="field"><label>${label}</label>${html}</div>`; }
  function formHtml(type, e) {
    e = e || {};
    // 会议 / 工作流水 新建时默认分类=工作（日报核心分类），其余类型默认未分类；二者均可手动改
    const defCat = (type === 'meeting' || type === 'worklog') && !e.category ? '工作' : e.category;
    const catOpts = ['<option value="">（未分类）</option>']
      .concat(store.categories().map(c => `<option value="${esc(c)}" ${defCat === c ? 'selected' : ''}>${esc(c)}</option>`));
    let h = `<div class="field"><label>类型</label><select id="f-type">` +
      TYPE_ORDER.map(k => `<option value="${k}" ${type === k ? 'selected' : ''}>${TYPES[k].icon} ${TYPES[k].label}</option>`).join('') +
      `</select></div>`;
    if (type !== 'daily') h += field('分类', `<select id="f-cat">${catOpts.join('')}</select>`);
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
      </div>
      <p class="muted small">转写后原文填入下方「转写原文」，用#行写你的补充/修正，再点「汇总总结」生成纪要。</p>`);
      h += field('转写原文 / 正文', `<textarea id="f-body">${esc(e.body || '')}</textarea>`);
      h += field('AI 纪要（可编辑）', `<div class="rec-inline">
        <button type="button" id="f-sum-go" class="btn btn-ghost">📝 汇总总结</button>
        <span id="f-sum-status" class="muted small"></span>
      </div>
      <textarea id="f-summary" class="textout-area">${esc(e.summary || '')}</textarea>`);
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
    } else if (type === 'worklog') {
      h += field('标题（可空）', `<input id="f-title" value="${esc(e.title || '')}" placeholder="一句话概括，如：与厂商确认 OB 迁移方案" />`);
      h += field('内容', `<textarea id="f-body">${esc(e.body || '')}</textarea>`);
    } else if (type === 'daily') {
      const today = fmtYMD(new Date());
      const dInit = (e && e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.title)) ? e.title : today;
      h += field('日报日期（仅当天）', `<input id="f-daily-date" type="date" value="${esc(dInit)}" />`);
      h += field('标题（可改，默认=日期）', `<input id="f-title" value="${esc(e.title || '')}" placeholder="${today}" />`);
      h += `<div class="field"><label>合并当天记录（会议 + 工作流水）</label>
        <div class="daily-row daily-actions">
          <button type="button" id="f-daily-rec" class="btn btn-ghost">🎙 录音转写</button>
          <button type="button" id="f-daily-selall" class="daily-mini">全选</button>
          <button type="button" id="f-daily-selnone" class="daily-mini">清空</button>
          <span id="f-daily-selcount" class="muted small"></span>
        </div>
        <div id="f-daily-checklist" class="daily-checklist"></div></div>`;
      h += field('追加素材（粘贴流水账 / 自由补充，与勾选项合并）', `<textarea id="f-daily-paste" class="sp-area" placeholder="可粘贴当天其他流水账或自由补充，将并入生成素材"></textarea>`);
      h += field('补充背景（本篇临时，不保存、不进入风格进化）', `<textarea id="f-daily-bg" class="sp-area" placeholder="如：今天重点向 VP 汇报进度；语气偏正式"></textarea>`);
      h += `<div class="daily-row daily-gen-row">
        <button type="button" id="f-daily-gen" class="btn btn-primary">生成日报</button>
        <button type="button" id="f-daily-revise" class="btn btn-primary">进化风格</button>
        <button type="button" id="f-daily-copy" class="btn">复制</button>
      </div>`;
      h += field('日报内容', `<textarea id="f-body">${esc(e.body || '')}</textarea>`);
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
    openModal('#editor');
    // 会议编辑器内嵌录音转写：选文件→上传→转写→填入正文
    const recGo = $('#f-rec-go');
    if (recGo) {
      recGo.onclick = async () => {
        const file = $('#f-rec-file').files[0];
        if (!file) { toast('请先选择录音文件'); return; }
        $('#f-rec-status').textContent = '上传中…';
        try {
          const key = await uploadAudio(file, (p, stage) => { $('#f-rec-status').textContent = '云端' + stage + '…'; });
          $('#f-rec-status').textContent = '云端转写中（可能需1-2分钟）…';
          const res = await transcribeAudio(key);
          const raw = (res.text || '').trim();
          const ta = $('#f-body');
          ta.value = (ta.value ? ta.value + '\n\n' : '') + (raw ? raw + '\n\n# ' : '# ');
          $('#f-rec-status').textContent = '已填入原文，可编辑';
          toast('已填入转写原文，补充后点「汇总总结」');
        } catch (e) { $('#f-rec-status').textContent = ''; toast('转写失败：' + (e.message || e)); }
      };
    }
    // 会议纪要生成：从「转写原文」提炼，# 行作为用户补充/修正
    const sumGo = $('#f-sum-go');
    if (sumGo) {
      sumGo.onclick = async () => {
        const { transcript, context } = splitTranscript($('#f-body').value);
        if (!transcript) { toast('没有可总结的转写原文'); return; }
        $('#f-sum-status').textContent = 'AI 提炼中…';
        try {
          const sp = store.styleProfile();
          const terms = (sp && sp.terms) ? sp.terms : [];
          const rules = (sp && sp.rules) ? sp.rules : [];
          const samples = (sp && sp.samples) ? sp.samples : [];
          const res = await summarizeMeeting(transcript, context, terms, rules, samples);
          $('#f-summary').value = res.summary || '';
          // AI 纪要通常包含「- 主题/议题：xxx」，自动填入标题（仅当标题为空或默认值时）
          const topic = extractTopic(res.summary);
          if (topic) {
            const curTitle = ($('#f-title') ? $('#f-title').value : '').trim();
            if (!curTitle || curTitle.startsWith('会议录音 ')) $('#f-title').value = topic;
          }
          $('#f-sum-status').textContent = res.summary ? '已生成（可编辑）' : '生成失败，已保留原文';
          if (res.llmWarn) toast(res.llmWarn);
        } catch (e) { $('#f-sum-status').textContent = ''; toast('总结失败：' + (e.message || e)); }
      };
    }
    // 日报编辑器：渲染当天勾选清单 + 绑定生成/修改/复制/录音/全选
    if (editorType === 'daily') {
      dailyLast = null; // 每次打开日报编辑器重置初稿比对，避免跨次误用
      const render = () => renderEditorDailyChecklist();
      render();
      const dEl = $('#f-daily-date');
      if (dEl) dEl.onchange = render;
      const recB = $('#f-daily-rec');
      if (recB) recB.onclick = () => { openRecorder(); };
      const sa = $('#f-daily-selall'); if (sa) sa.onclick = () => { document.querySelectorAll('#f-daily-checklist input').forEach(c => c.checked = true); updateEditorDailySelCount(); };
      const sn = $('#f-daily-selnone'); if (sn) sn.onclick = () => { document.querySelectorAll('#f-daily-checklist input').forEach(c => c.checked = false); updateEditorDailySelCount(); };
      const gen = $('#f-daily-gen'); if (gen) gen.onclick = () => editorDailyGenerate();
      const rev = $('#f-daily-revise'); if (rev) rev.onclick = () => editorDailyRevise();
      const cpy = $('#f-daily-copy'); if (cpy) cpy.onclick = () => editorDailyCopy();
    }
    const first = $('#editor-body').querySelector('input,textarea,select');
    if (first) setTimeout(() => first.focus(), 50);
  }
  function collectForm() {
    const type = $('#f-type').value;
    const catEl = $('#f-cat');
    const cat = catEl ? catEl.value : (type === 'daily' ? '工作' : '');
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
      patch.summary = ($('#f-summary') ? $('#f-summary').value : '') || '';
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
    } else if (type === 'worklog') {
      patch.title = ($('#f-title').value || '').trim();
    } else if (type === 'daily') {
      const dEl = $('#f-daily-date');
      const dStr = (dEl ? dEl.value : '').trim() || fmtYMD(new Date());
      let title = ($('#f-title').value || '').trim();
      if (!title) title = dStr;
      patch.title = title;
      patch.category = '工作'; // 日报内部隐藏分类，统一归类工作以贴合数据结构
      if (!editingId) patch.created = toISOMid(dStr); // 新建时把记录日锚定到所选日期，便于按天归档/回溯
    }
    return patch;
  }
  async function saveEditor() {
    const patch = collectForm();
    if (!patch) return; // 校验失败已 toast 提示
    if (editingId) {
      store.updateEntry(editingId, patch);
    } else {
      store.addEntry(patch);
    }
    // 先关弹窗并刷新列表，确保本地已落库且立即可见
    dismissModal('#editor', { force: true });
    renderList(); renderCats();
    // 编辑历史日报后增量重挖该篇需求（网络异常不阻断保存）
    try {
      const e = editingId ? store.get(editingId) : null;
      if (e && e.type === 'daily' && e.body && e.body.trim()) {
        await mineRequirements([{ id: e.id, date: (e.title || '').slice(0, 10), body: e.body }]);
      }
    } catch (err) { console.warn('需求挖掘失败（不影响保存）', err); }
    try {
      await sync();
    } catch (err) {
      toast('已保存到本地，但云端同步失败：' + (err.message || err));
    }
  }

  // ---------- 灵感转普通记录 ----------
  async function convertFlow(id) {
    const e = store.get(id);
    if (!e) return;
    const target = prompt('转为哪种类型？输入：misc / task / ledger / meeting / worklog', 'misc');
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
    openModal('#textout');
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
    openModal('#ledger-summary');
  }

  // ---------- 录音转写（P5） ----------
  function openRecorder() {
    $('#rec-result').value = ''; $('#rec-summary').value = ''; $('#rec-title').value = '';
    $('#rec-save').disabled = true; $('#rec-status').textContent = '';
    openModal('#recorder');
  }
  // 分片上传：把文件切成 ≤4MB 的片，逐片 POST 给 SCF（SCF 用 COS 分块上传合并）。
  // 单文件（<4MB）仍走一次性直传；仅大文件走分片，突破 API 网关 ~6MB 请求体上限。
  // onProgress(percent, stage) 用于回传进度（stage 如「上传中 (3/10)」「合并中」）。
  async function uploadAudio(file, onProgress) {
    const CHUNK = 4 * 1024 * 1024; // 4MB，留足余量低于 API 网关 ~6MB 上限
    const ext = (file.name.split('.').pop() || 'm4a').toLowerCase();
    const total = Math.max(1, Math.ceil(file.size / CHUNK));
    const report = (p, stage) => { if (onProgress) onProgress(p, stage); };
    if (total === 1) {
      report(10, '上传中');
      const r = await fetch(API_BASE + '/api/asr/upload?ext=' + encodeURIComponent(ext), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
      if (!r.ok) throw new Error('上传 HTTP ' + r.status);
      const d = await r.json().catch(() => ({}));
      if (d.code !== 0) throw new Error(d.msg || ('code ' + d.code));
      report(100, '完成');
      return d.key;
    }
    const sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try {
      for (let i = 0; i < total; i++) {
        report(Math.round((i / total) * 90), '上传中 (' + (i + 1) + '/' + total + ')');
        const blob = file.slice(i * CHUNK, (i + 1) * CHUNK);
        const r = await fetch(API_BASE + '/api/asr/upload?ext=' + encodeURIComponent(ext)
          + '&sid=' + encodeURIComponent(sid) + '&part=' + i + '&total=' + total, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob,
        });
        if (!r.ok) throw new Error('分片 ' + (i + 1) + ' 上传 HTTP ' + r.status);
        const d = await r.json().catch(() => ({}));
        if (d.code !== 0) throw new Error(d.msg || ('code ' + d.code));
      }
      report(95, '合并中');
      const rf = await fetch(API_BASE + '/api/asr/upload?sid=' + encodeURIComponent(sid) + '&final=1', {
        method: 'POST',
      });
      const df = await rf.json().catch(() => ({}));
      if (df.code !== 0) throw new Error(df.msg || ('code ' + df.code));
      report(100, '完成');
      return df.key;
    } catch (e) {
      // 失败清理：中止分块上传，避免 COS 残留孤儿分片
      try {
        await fetch(API_BASE + '/api/asr/upload?sid=' + encodeURIComponent(sid) + '&abort=1', { method: 'POST' });
      } catch (_) { /* 忽略清理错误 */ }
      throw e;
    }
  }
  // 把单框内容拆成：转写原文（非#行） + 用户#标注（context）
  function splitTranscript(val) {
    const lines = (val || '').split('\n');
    const trans = [], ctx = [];
    for (const ln of lines) {
      if (ln.trimStart().startsWith('#')) ctx.push(ln.replace(/^\s*#\s?/, '').trim());
      else trans.push(ln);
    }
    return { transcript: trans.join('\n').trim(), context: ctx.filter(Boolean).join('\n').trim() };
  }
  async function transcribeAudio(key) {
    const body = { key, engine: store.settings().asrEngine };
    const r = await fetch(API_BASE + '/api/asr/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (d.code !== 0) throw new Error(d.msg || ('code ' + d.code));
    return { text: d.text || '' };
  }
  // 从 AI 纪要中提取「主题/议题」行，用于自动填充会议标题
  function extractTopic(summary) {
    const m = (summary || '').match(/主题[\/\s]*(?:议题)?[：:]\s*(.+)/);
    return m ? m[1].trim() : '';
  }
  async function summarizeMeeting(transcript, context, terms, rules, samples) {
    const body = {
      text: transcript || '', context: context || '',
      terms: terms || [], rules: rules || [], samples: samples || [],
      model: store.settings().summaryModel,
    };
    const r = await fetch(API_BASE + '/api/asr/summarize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (d.code !== 0) throw new Error(d.msg || ('code ' + d.code));
    return { summary: d.summary || '', llmWarn: d.llm_warn || '' };
  }
  async function recTranscribe() {
    const file = $('#rec-file').files[0];
    if (!file) { toast('请先选择录音文件'); return; }
    $('#rec-status').textContent = '上传中…';
    try {
      const key = await uploadAudio(file, (p, stage) => { $('#rec-status').textContent = '云端' + stage + '…'; });
      $('#rec-status').textContent = '云端转写中（可能需1-2分钟）…';
      const res = await transcribeAudio(key);
      const raw = (res.text || '').trim();
      // 默认预置第一个 #，方便用户直接写补充/修正
      $('#rec-result').value = raw + (raw ? '\n\n# ' : '# ');
      $('#rec-summary').value = '';
      $('#rec-save').disabled = !(raw && raw.trim());
      $('#rec-status').textContent = '已出原文（可编辑，用#行写你的补充）';
      toast('转写完成，请检查/补充后点「汇总总结」');
    } catch (e) { $('#rec-status').textContent = ''; toast('转写失败：' + (e.message || e)); }
  }
  async function recSummarize() {
    const { transcript, context } = splitTranscript($('#rec-result').value);
    if (!transcript) { toast('没有可总结的转写原文'); return; }
    $('#rec-status').textContent = 'AI 提炼纪要中…';
    try {
      const sp = store.styleProfile();
      const terms = (sp && sp.terms) ? sp.terms : [];
      const rules = (sp && sp.rules) ? sp.rules : [];
      const samples = (sp && sp.samples) ? sp.samples : [];
      const res = await summarizeMeeting(transcript, context, terms, rules, samples);
      $('#rec-summary').value = res.summary || '';
      // 自动提取主题填入标题
      const topic = extractTopic(res.summary);
      if (topic) {
        const curTitle = ($('#rec-title') ? $('#rec-title').value : '').trim();
        if (!curTitle || curTitle.startsWith('会议录音 ')) $('#rec-title').value = topic;
      }
      $('#rec-status').textContent = res.summary ? '已生成纪要（可再编辑）' : '纪要生成失败，已保留原文';
      if (res.llmWarn) toast(res.llmWarn);
    } catch (e) { $('#rec-status').textContent = ''; toast('总结失败：' + (e.message || e)); }
  }
  async function recSave() {
    const text = $('#rec-result').value.trim();
    if (!text) { toast('没有可保存的内容'); return; }
    const summary = ($('#rec-summary').value || '').trim();
    const recTitle = ($('#rec-title') ? $('#rec-title').value : '').trim() || ('会议录音 ' + new Date().toISOString().slice(0, 10));
    store.addEntry({ type: 'meeting', title: recTitle, meetingDate: new Date().toISOString().slice(0, 16).replace('T', ' '), body: text, summary: summary });
    await sync();
    toast('已保存为会议记录（原文+纪要）');
    dismissModal('#recorder', { force: true });
    // 若日报编辑器正打开，刷新当天勾选清单（承接录音转写→自动进日报素材）
    const ed = $('#editor');
    if (ed && !ed.classList.contains('hidden')) {
      const t = $('#f-type');
      if (t && t.value === 'daily') renderEditorDailyChecklist();
    }
  }

  // ---------- 日报（记录类型，在编辑器内编写） ----------
  // 日报 = 记录的一种类型(daily)。写日报在「日报类型编辑器」内完成：
  //   选日期(默认今天) → 勾选当天会议+工作流水 → 🎙录音转写(承接) → 追加素材/背景 → 生成 → 填入正文 → 保存落库
  // 历史日报即在记录列表天然回溯/编辑（点 📰日报 类型筛选项即可）。
  let dailyLast = null; // { generated, date, material } 用于「修改」差异比对
  let editorDailyDate = null; // 当前编辑器所选日报日期

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
      const m = (e.summary && e.summary.trim()) ? e.summary : (e.body || '');
      return `- [会议] 参加：${e.title || ''}（${e.meetingDate || ''}）\n  ${m}`;
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
  // 日报只采纳：会议 + 分类为"工作"的条目；日报类型本身不参与生成（防自喂循环）
  function isDailySource(e) {
    if (e.type === 'daily') return false;
    if (e.type === 'meeting') return true;
    return e.category === '工作';
  }
  // 编辑器内：所选日期当天的可合并源（会议 + 工作流水）
  function editorDailyItems(dateStr) {
    if (!dateStr) return [];
    return store.list().filter(x => fmtDateOnly(x.created) === dateStr && isDailySource(x));
  }
  // 渲染编辑器内勾选清单（依据 #f-daily-date）
  function renderEditorDailyChecklist() {
    const box = $('#f-daily-checklist');
    if (!box) return;
    const d = $('#f-daily-date') ? $('#f-daily-date').value : '';
    editorDailyDate = d;
    const items = editorDailyItems(d);
    if (!items.length) {
      box.innerHTML = '<div class="muted small">当天没有会议 / 工作流水。可在「追加素材」粘贴流水账，或点 🎙 录音转写后自动出现在此。</div>';
      updateEditorDailySelCount();
      return;
    }
    const groups = { meeting: [], worklog: [] };
    items.forEach(e => { if (e.type === 'meeting') groups.meeting.push(e); else groups.worklog.push(e); });
    const g = (title, arr) => !arr.length ? '' :
      `<div class="daily-grp">${title}</div>` + arr.map(e =>
        `<label class="daily-check"><input type="checkbox" data-id="${e.id}" checked />
          <span>${TYPES[e.type].icon} ${fmtDate(e.created)} · ${esc(entrySummary(e))}</span></label>`).join('');
    box.innerHTML = g('🎙 会议', groups.meeting) + g('🗒️ 工作流水（当天）', groups.worklog);
    box.querySelectorAll('input').forEach(c => c.onchange = updateEditorDailySelCount);
    updateEditorDailySelCount();
  }
  function updateEditorDailySelCount() {
    const box = $('#f-daily-checklist'); if (!box) return;
    const n = box.querySelectorAll('input:checked').length;
    const total = box.querySelectorAll('input').length;
    const el = $('#f-daily-selcount'); if (el) el.textContent = `${n}/${total} 已选`;
  }
  function getEditorDailySelected() {
    const box = $('#f-daily-checklist'); if (!box) return [];
    const ids = [...box.querySelectorAll('input:checked')].map(c => c.dataset.id);
    return ids.map(id => store.get(id)).filter(Boolean);
  }

  // 编辑器内生成日报
  async function editorDailyGenerate() {
    const dateStr = ($('#f-daily-date') ? $('#f-daily-date').value : '') || fmtYMD(new Date());
    if (!dateStr) { toast('请选择日报日期'); return; }
    const sel = getEditorDailySelected();
    const paste = ($('#f-daily-paste') ? $('#f-daily-paste').value : '').trim();
    let material = formatMaterial(sel);
    if (paste) material += (material ? '\n' : '') + paste;
    if (!material.trim()) { toast('请勾选当天条目或在「追加素材」粘贴'); return; }
    const sp = store.styleProfile();
    const sys = DAILY_SEED + '\n\n# 已习得的风格偏好（动态积累）\n' + formatStyleProfile(sp);
    const bg = ($('#f-daily-bg') ? $('#f-daily-bg').value : '').trim();
    const user = `请基于以下 ${dateStr} 的素材生成当日精简日报。\n\n【素材】\n${material}` +
      (bg ? `\n\n【补充背景 / 要求】\n${bg}` : '') +
      buildRequirementContext(material) +
      `\n\n要求：全文可复制、无特殊格式、段落间不留空行、每篇2-4点、聚焦进度/风险/资源/验收；如有会议素材必须包含「参加：标题」。`;
    const text = await callAI('generate', [{ role: 'system', content: sys }, { role: 'user', content: user }]);
    if (text != null) {
      $('#f-body').value = text;
      const tEl = $('#f-title'); if (tEl && !tEl.value.trim()) tEl.value = dateStr;
      dailyLast = { generated: text, date: dateStr, material };
      toast('已生成日报（可编辑后点「保存」落库）');
    }
  }
  // 需求登记册：从素材中匹配已登记需求，注入生成 prompt（LLM 用全称书写）
  function buildRequirementContext(material) {
    const reqs = store.requirements();
    if (!reqs.length || !material) return '';
    const lines = [];
    reqs.forEach(r => {
      const code = (r.code || '').trim();
      const name = (r.name || '').trim();
      if (!name && !code) return;
      const hit = (code && material.includes(code)) || (name && material.includes(name));
      if (hit) {
        const full = code ? `${code} = ${name}` : name;
        lines.push(`- ${full}（阶段：${r.stage || '未知'}，首见 ${r.firstSeen || '—'}，最近 ${r.lastSeen || '—'}）`);
      }
    });
    if (!lines.length) return '';
    return '\n\n【需求登记册上下文（素材中提及的下列需求，请一律使用其完整名称书写，不要只写代号）】\n' + lines.join('\n');
  }
  // 把 YYYY-MM-DD 转 ISO（失败回退当前时刻）
  function toISOMid(dateStr) {
    const s = (dateStr || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const dt = new Date(s + 'T12:00:00');
      if (!isNaN(dt)) return dt.toISOString();
    }
    return new Date().toISOString();
  }
  // 调 SCF 挖掘需求并合并进登记册
  async function mineRequirements(texts) {
    try {
      const r = await fetch(API_BASE + '/api/mine', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.code !== 0) return;
      const reqs = d.requirements || [];
      if (reqs.length) {
        store.mergeRequirements(reqs);
        await sync();
      }
    } catch (e) { /* 挖掘失败不影响主流程 */ }
  }
  // 全量重新挖掘历史日报（设置页触发）
  async function mineAllRequirements() {
    const dailies = store.list().filter(e => e.type === 'daily' && e.body && e.body.trim());
    if (!dailies.length) { toast('暂无历史日报可挖掘'); return; }
    for (let i = 0; i < dailies.length; i += 15) {
      const batch = dailies.slice(i, i + 15).map(e => ({
        id: e.id, date: (e.title || e.created || '').slice(0, 10), body: e.body,
      }));
      await mineRequirements(batch);
    }
    toast('已重新挖掘全部历史日报（' + dailies.length + ' 篇）');
    renderSettingsRequirements();
  }

  function editorDailyCopy() {
    const t = $('#f-body').value;
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
  async function editorDailyRevise() {
    const revised = $('#f-body').value;
    if (!revised.trim()) { toast('没有可采纳的内容'); return; }
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

  // 风格档案读写（已迁移到「设置」弹层）
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
      // 清空弹层栈并隐藏所有弹层（弹层在 #app 之外，需单独处理）
      modalStack.length = 0;
      document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
      $('#app').classList.add('hidden'); $('#lock-screen').classList.remove('hidden');
      $('#password').value = '';
    };
    const sb = $('#sidebar');
    const ov = $('#sidebar-overlay');
    const closeSb = () => { sb.classList.remove('open'); ov.classList.add('hidden'); };
    const openSb = () => { sb.classList.add('open'); ov.classList.remove('hidden'); };
    $('#menu-toggle').onclick = () => { if (sb.classList.contains('open')) closeSb(); else openSb(); };
    if (ov) ov.onclick = closeSb;

    $('#fab').onclick = () => openEditor(null);
    $('#editor-save').onclick = saveEditor;
    $('#editor-close').onclick = () => dismissModal('#editor');
    $('#editor-exit').onclick = () => dismissModal('#editor');
    // 阅读弹层
    $('#reader-close').onclick = () => { readingId = null; dismissModal('#reader', { force: true }); };
    $('#reader-edit').onclick = () => {
      if (readingId) { openEditor(readingId); dismissModal('#reader', { force: true }); }
    };
    $('#search').addEventListener('input', e => { cur.q = e.target.value.trim(); renderList(); });

    $('#textout-close').onclick = () => dismissModal('#textout');
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
    $('#ls-close').onclick = () => dismissModal('#ledger-summary');
    // 录音转写（独立弹层，仍由底部「🎙 录音转写」按钮唤起；日报编辑器内也有同名按钮唤起同一弹层）
    $('#rec-open-btn').onclick = openRecorder;
    $('#rec-close').onclick = () => dismissModal('#recorder');
    $('#rec-go').onclick = recTranscribe;
    $('#rec-sum').onclick = recSummarize;
    $('#rec-save').onclick = recSave;
    // 日报类型编辑器内的按钮在 openEditor 内动态绑定（每次打开重新渲染）
    $('#sp-save').onclick = saveStyleUI;
    initSettings();

    // 快捷键 N 唤起新增（已解锁时）
    document.addEventListener('keydown', e => {
      if ($('#app').classList.contains('hidden')) return;
      if (e.key === 'n' || e.key === 'N') {
        if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
        openEditor(null);
      }
      if (e.key === 'Escape') {
        if (modalStack.length) dismissModal(modalStack[modalStack.length - 1]);
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
