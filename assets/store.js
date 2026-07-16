// store.js —— 记事本数据模型 + 存储层（localStorage 模拟 COS，预留 SCF 替换点）
(function () {
  'use strict';

  const LS_BLOB = 'notepad_blob_v1';       // 加密块：{v,salt,iv,ct}
  const LS_SESSION = 'notepad_session_v1'; // 会话缓存：{rawKey, exp}
  const SESSION_MS = 6 * 24 * 60 * 60 * 1000; // 6 天免密窗口（蓝图 2.8）

  const TYPES = {
    note:    { label: '杂项', color: '#64748b' },
    task:    { label: '任务', color: '#2563eb' },
    ledger:  { label: '账本', color: '#16a34a' },
    meeting: { label: '会议', color: '#d97706' },
  };

  const CATEGORY_PALETTE = ['#0ea5e9', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#6366f1', '#14b8a6'];

  function uid() {
    return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
  function nowISO() {
    return new Date().toISOString();
  }
  function fmtMoney(n) {
    const v = Number(n) || 0;
    return '¥' + v.toFixed(2);
  }

  class Store {
    constructor() {
      this.notebook = null;   // {version, categories:[], entries:[]}
      this.key = null;        // CryptoKey
      this.salt = null;       // Uint8Array
    }

    isSetup() {
      return !!localStorage.getItem(LS_BLOB);
    }

    // —— 首次创建：设置主密码 ——
    async setup(password) {
      this.salt = crypto.getRandomValues(new Uint8Array(16));
      this.key = await CryptoUtil.deriveKey(password, this.salt);
      this.notebook = SeedData.build();
      await this.save();
      await this._cacheSession(this.key);
      return this.notebook;
    }

    // —— 用主密码解锁 ——
    async unlock(password) {
      const blob = JSON.parse(localStorage.getItem(LS_BLOB));
      this.salt = CryptoUtil.unb64(blob.salt);
      this.key = await CryptoUtil.deriveKey(password, this.salt);
      this.notebook = await CryptoUtil.decryptJSON(blob, this.key); // 密码错误会抛异常
      await this._cacheSession(this.key);
      return this.notebook;
    }

    // —— 会话恢复（6 天内免密）——
    async resumeSession() {
      const s = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
      if (!s || Date.now() > s.exp) return false;
      const blob = JSON.parse(localStorage.getItem(LS_BLOB));
      if (!blob) return false;
      this.salt = CryptoUtil.unb64(blob.salt);
      this.key = await crypto.subtle.importKey(
        'raw',
        CryptoUtil.unb64(s.rawKey),
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      this.notebook = await CryptoUtil.decryptJSON(blob, this.key);
      return true;
    }

    async _cacheSession(key) {
      const raw = await crypto.subtle.exportKey('raw', key);
      localStorage.setItem(
        LS_SESSION,
        JSON.stringify({ rawKey: CryptoUtil.b64(raw), exp: Date.now() + SESSION_MS })
      );
    }

    lock() {
      localStorage.removeItem(LS_SESSION);
      this.notebook = null;
      this.key = null;
    }

    // 恢复默认示例分类（仅补齐缺失的，不动已有分类/条目）。用于误删后一键找回。
    restoreSeedCategories() {
      const seed = SeedData.build();
      let added = 0;
      seed.categories.forEach((sc) => {
        if (!this.categoryById(sc.id)) {
          this.notebook.categories.push(Object.assign({}, sc));
          added++;
        }
      });
      return added;
    }

    // 清空全部本地数据（含会话缓存），回到未初始化状态。
    static clearStorage() {
      localStorage.removeItem(LS_BLOB);
      localStorage.removeItem(LS_SESSION);
    }

    // —— 持久化（替换为 SCF 时，只改这里：把 blob 发到 SCF /api/notebook PUT）——
    async save() {
      const enc = await CryptoUtil.encryptJSON(this.notebook, this.key);
      const blob = {
        v: 1,
        salt: CryptoUtil.b64(this.salt),
        iv: enc.iv,
        ct: enc.ct,
        // authHash 预留：SCF 端可比对 sha256hex(password) 防陌生人覆盖（蓝图 2.2）
      };
      localStorage.setItem(LS_BLOB, JSON.stringify(blob));
    }

    // ===== 分类 =====
    addCategory(name) {
      const color = CATEGORY_PALETTE[this.notebook.categories.length % CATEGORY_PALETTE.length];
      const cat = { id: uid(), name: name.trim(), color, order: this.notebook.categories.length };
      this.notebook.categories.push(cat);
      return cat;
    }
    updateCategory(id, name) {
      const c = this.notebook.categories.find((x) => x.id === id);
      if (c) c.name = name.trim();
      return c;
    }
    deleteCategory(id) {
      this.notebook.categories = this.notebook.categories.filter((x) => x.id !== id);
      this.notebook.entries = this.notebook.entries.filter((e) => e.categoryId !== id);
    }

    // ===== 条目 =====
    addEntry(data) {
      const e = Object.assign(
        { id: uid(), createdAt: nowISO(), updatedAt: nowISO() },
        data
      );
      this.notebook.entries.unshift(e);
      return e;
    }
    updateEntry(id, patch) {
      const e = this.notebook.entries.find((x) => x.id === id);
      if (e) Object.assign(e, patch, { updatedAt: nowISO() });
      return e;
    }
    deleteEntry(id) {
      this.notebook.entries = this.notebook.entries.filter((x) => x.id !== id);
    }
    toggleTask(id) {
      const e = this.notebook.entries.find((x) => x.id === id);
      if (e && e.type === 'task') {
        e.done = !e.done;
        e.updatedAt = nowISO();
      }
      return e;
    }

    // ===== 查询 =====
    categoryById(id) {
      return this.notebook.categories.find((c) => c.id === id) || null;
    }
    entriesOf(categoryId) {
      if (!categoryId) return this.notebook.entries.slice();
      return this.notebook.entries.filter((e) => e.categoryId === categoryId);
    }
    // 全文搜索：标题 + 内容 + 账本备注，跨分类
    search(q, categoryId) {
      const kw = (q || '').trim().toLowerCase();
      let list = this.entriesOf(categoryId);
      if (!kw) return list;
      return list.filter((e) => {
        const hay = [e.title, e.content, e.type === 'ledger' ? e.note || '' : '']
          .join(' ')
          .toLowerCase();
        return hay.includes(kw);
      });
    }

    // ===== 账本汇总 =====
    ledgerSummary(entries) {
      const led = entries.filter((e) => e.type === 'ledger');
      let income = 0, expense = 0;
      const byCat = {};
      led.forEach((e) => {
        const amt = Number(e.amount) || 0;
        if (e.direction === 'income') income += amt;
        else expense += amt;
        const c = this.categoryById(e.categoryId);
        const name = c ? c.name : '未分类';
        byCat[name] = (byCat[name] || 0) + (e.direction === 'income' ? amt : -amt);
      });
      return {
        income,
        expense,
        balance: income - expense,
        count: led.length,
        byCat,
      };
    }

    // ===== 导出加密备份（本地安全网，轻量版无应急恢复）======
    exportBackup() {
      const blob = JSON.parse(localStorage.getItem(LS_BLOB));
      const payload = JSON.stringify(blob, null, 2);
      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'notepad-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  window.Store = Store;
  window.StoreConst = { TYPES: TYPES, CATEGORY_PALETTE: CATEGORY_PALETTE, fmtMoney: fmtMoney };
})();
