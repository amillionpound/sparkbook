/* Sparkbook 数据层 + 存储适配器（COS 密文 + 本地回退） + 免密会话 */
(function (global) {
  'use strict';

  const API_BASE = 'https://1256784020-0i70k3at89.ap-guangzhou.tencentscf.com';
  const LOCAL_PREFIX = 'sparkbook:vault:';
  const SESSION_KEY = 'sparkbook:session';
  const DEVKEY_KEY = 'sparkbook:devkey';
  const SESSION_DAYS_KEY = 'sparkbook:sessionDays';

  const TYPES = {
    misc: { label: '杂项', icon: '📝', hasTitle: false },
    task: { label: '任务', icon: '✅', hasTitle: true },
    ledger: { label: '账本', icon: '💰', hasTitle: false },
    meeting: { label: '会议', icon: '📅', hasTitle: true },
    inspiration: { label: '灵感', icon: '💡', hasTitle: false },
  };
  const TYPE_ORDER = ['misc', 'task', 'ledger', 'meeting', 'inspiration'];

  function uid() {
    return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function nowISO() {
    return new Date().toISOString();
  }
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  class SparkStore {
    constructor() {
      this.vid = null;
      this.key = null;
      this.saltB64 = null;
      this.state = null;
      this.mode = 'local'; // 'cos' | 'local'
      this.sessionDays = parseInt(localStorage.getItem(SESSION_DAYS_KEY) || '7', 10);
    }

    // ---- 免密会话 ----
    getSessionDays() { return this.sessionDays; }
    setSessionDays(d) {
      this.sessionDays = Math.max(3, Math.min(14, d | 0));
      localStorage.setItem(SESSION_DAYS_KEY, String(this.sessionDays));
    }
    // 是否能免密自动解锁（仅 PWA 安装态）
    canAutoUnlock() {
      if (!isStandalone()) return false;
      try {
        const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        if (!s || !s.expiresAt) return false;
        return Date.now() < s.expiresAt;
      } catch { return false; }
    }
    async autoUnlock() {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      const devB64 = localStorage.getItem(DEVKEY_KEY);
      if (!s || !devB64) return false;
      const sk = SparkCrypto.b64ToBuf(devB64);
      const skKey = await crypto.subtle.importKey('raw', sk, { name: 'AES-GCM' }, true, ['decrypt']);
      try {
        const pw = await SparkCrypto.decryptWithKey(skKey, s);
        await this.unlock(pw, { remember: false });
        return true;
      } catch { return false; }
    }
    _persistSession(password) {
      if (!isStandalone()) return; // 普通链接不持久化会话
      const devB64 = localStorage.getItem(DEVKEY_KEY) ||
        SparkCrypto.bufToB64(crypto.getRandomValues(new Uint8Array(32)).buffer);
      localStorage.setItem(DEVKEY_KEY, devB64);
      const skKey = crypto.subtle.importKey('raw', SparkCrypto.b64ToBuf(devB64),
        { name: 'AES-GCM' }, true, ['encrypt']);
      return Promise.resolve(skKey).then(k => SparkCrypto.encryptWithKey(k, password)).then(env => {
        localStorage.setItem(SESSION_KEY, JSON.stringify({
          ...env, expiresAt: Date.now() + this.sessionDays * 864e5,
        }));
      });
    }
    clearSession() {
      localStorage.removeItem(SESSION_KEY);
    }

    // ---- 解锁 ----
    async unlock(password, { remember = true } = {}) {
      const { vid } = await SparkCrypto.unlock(password);
      this.vid = vid;
      const env = await this.loadEnvelope(vid);
      let payload;
      if (!env) {
        this.saltB64 = SparkCrypto.bufToB64(crypto.getRandomValues(new Uint8Array(16)).buffer);
        payload = this._emptyState();
      } else {
        this.saltB64 = env.salt;
        const { key } = await SparkCrypto.deriveKeyFromSalt(password, env.salt);
        try {
          payload = await SparkCrypto.decryptJSON(key, env);
        } catch (e) {
          throw new Error('密码错误，或数据已损坏');
        }
        this.key = key;
      }
      const { key } = await SparkCrypto.deriveKeyFromSalt(password, this.saltB64);
      this.key = key;
      this.state = payload;
      if (remember) await this._persistSession(password);
      return payload;
    }

    _emptyState() {
      return {
        version: 1,
        entries: [],
        categories: ['生活', '工作', '项目', '随手'],
        styleProfile: { terms: [], rules: [], samples: [] },
      };
    }

    lock() {
      this.key = null; this.vid = null; this.state = null; this.saltB64 = null;
    }

    // ---- 存储适配器 ----
    async loadEnvelope(vid) {
      // 1) 尝试 COS 预签名 GET
      try {
        const r = await fetch(API_BASE + '/api/vault/presign', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vid, action: 'get' }),
        });
        if (r.ok) {
          const { url } = await r.json();
          const gr = await fetch(url);
          if (gr.ok) {
            this.mode = 'cos';
            return await gr.json();
          }
          if (gr.status === 403 || gr.status === 404) return null; // 新库
        }
      } catch (e) { /* 走回退 */ }
      // 2) 本地回退
      try {
        const raw = localStorage.getItem(LOCAL_PREFIX + vid);
        if (raw) { this.mode = 'local'; return JSON.parse(raw); }
      } catch (e) {}
      return null;
    }

    async save() {
      if (!this.key || !this.state) throw new Error('未解锁');
      this.state.updatedAt = nowISO();
      const { iv, ct } = await SparkCrypto.encryptJSON(this.key, this.state);
      const env = { salt: this.saltB64, iv, ct };
      // COS 优先
      let savedCos = false;
      try {
        const r = await fetch(API_BASE + '/api/vault/presign', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vid: this.vid, action: 'put' }),
        });
        if (r.ok) {
          const { url } = await r.json();
          const pr = await fetch(url, {
            method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
            body: JSON.stringify(env),
          });
          if (pr.ok) savedCos = true;
        }
      } catch (e) {}
      // 本地镜像（离线/回退）
      try {
        localStorage.setItem(LOCAL_PREFIX + this.vid, JSON.stringify(env));
        if (savedCos) this.mode = 'cos'; else this.mode = 'local';
      } catch (e) {}
      return this.mode;
    }

    // ---- CRUD ----
    list() { return this.state.entries.slice(); }
    get(id) { return this.state.entries.find(e => e.id === id); }

    addEntry(partial) {
      const t = nowISO();
      const entry = Object.assign({
        id: uid(), type: 'misc', category: '', title: '', body: '',
        amount: null, direction: 'out', done: false, dueDate: '',
        meetingDate: '', capturedAt: t, created: t, updated: t,
        convertedFrom: null,
      }, partial);
      entry.updated = t;
      this.state.entries.unshift(entry);
      return entry;
    }
    updateEntry(id, patch) {
      const e = this.get(id);
      if (!e) return null;
      Object.assign(e, patch, { updated: nowISO() });
      return e;
    }
    deleteEntry(id) {
      this.state.entries = this.state.entries.filter(e => e.id !== id);
    }
    // 灵感转普通记录：按目标类型补字段
    convertInspiration(id, targetType, extra) {
      const e = this.get(id);
      if (!e || e.type !== 'inspiration') return null;
      const patch = { type: targetType, convertedFrom: 'inspiration', updated: nowISO() };
      if (targetType === 'task') patch.dueDate = extra.dueDate || '';
      if (targetType === 'ledger') { patch.amount = extra.amount || 0; patch.direction = extra.direction || 'out'; }
      if (targetType === 'meeting') patch.meetingDate = extra.meetingDate || '';
      Object.assign(e, patch);
      return e;
    }

    // ---- 分类 ----
    categories() { return this.state.categories.slice(); }
    addCategory(name) {
      name = (name || '').trim();
      if (!name || this.state.categories.includes(name)) return false;
      this.state.categories.push(name);
      return true;
    }
    removeCategory(name) {
      this.state.categories = this.state.categories.filter(c => c !== name);
      // 解除条目上对该分类的引用
      this.state.entries.forEach(e => { if (e.category === name) e.category = ''; });
    }

    // ---- 风格档案 ----
    styleProfile() { return this.state.styleProfile; }
    saveStyleProfile(sp) { this.state.styleProfile = sp; }

    // ---- 查询 ----
    filter({ type, category, q }) {
      let res = this.state.entries;
      if (type && type !== 'all') res = res.filter(e => e.type === type);
      if (category) res = res.filter(e => e.category === category);
      if (q) {
        const kw = q.toLowerCase();
        res = res.filter(e =>
          (e.title || '').toLowerCase().includes(kw) ||
          (e.body || '').toLowerCase().includes(kw) ||
          (e.category || '').toLowerCase().includes(kw));
      }
      return res;
    }
  }

  global.SparkStore = SparkStore;
  global.SparkTypes = TYPES;
  global.SparkTypeOrder = TYPE_ORDER;
})(window);
