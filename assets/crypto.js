// crypto.js —— 浏览器端轻量加密（零知识轻量版）
// 主密码 -> PBKDF2-SHA256 -> AES-256-GCM 密钥；明文只在浏览器内存，密文才落存储。
// 本文件不依赖任何第三方库，使用 Web Crypto API（浏览器原生）。
(function () {
  'use strict';

  const PBKDF2_ITER = 150000; // 与蓝图一致的派生迭代次数

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function unb64(s) {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  // 自算密钥工具：SHA-256(明文密码) -> 64 位小写 hex。
  // 用于后端(SCF)做轻量口令校验时比对，SCF 永不见明文密码（与蓝图 2.2 同思路）。
  async function sha256hex(str) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  async function deriveKey(password, salt) {
    const km = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    // extractable = true：便于写入本地会话缓存（蓝图 2.8 长窗口免密）。
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
      km,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptJSON(obj, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      new TextEncoder().encode(JSON.stringify(obj))
    );
    return { iv: b64(iv), ct: b64(ct) };
  }

  async function decryptJSON(blob, key) {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(blob.iv) },
      key,
      unb64(blob.ct)
    );
    return JSON.parse(new TextDecoder().decode(pt));
  }

  window.CryptoUtil = {
    PBKDF2_ITER: PBKDF2_ITER,
    b64: b64,
    unb64: unb64,
    sha256hex: sha256hex,
    deriveKey: deriveKey,
    encryptJSON: encryptJSON,
    decryptJSON: decryptJSON,
  };
})();
