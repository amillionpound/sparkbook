/* Sparkbook 加密层 —— 纯浏览器端，零知识边界
 * - 主密码 → PBKDF2-SHA256(15万次) → AES-256-GCM 密钥 K
 * - vid（库标识）= SHA-256("sparkbook:" + 主密码) 的 hex，作为 COS 对象 key
 *   （SCF 不接触明文；vid 可被算出不泄露明文，因为还需 K 才能解密）
 * - 整个库作为单个加密包：envelope = { salt, iv, ct }，salt 以明文存于包头
 */
(function (global) {
  'use strict';

  const PBKDF2_ITER = 150000;

  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function deriveKey(password, saltBuf) {
    const pwBuf = new TextEncoder().encode(password);
    const baseKey = await crypto.subtle.importKey(
      'raw', pwBuf, { name: 'PBKDF2' }, false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBuf, iterations: PBKDF2_ITER, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']);
  }

  // 解锁：返回 { vid, key, saltBuf }
  async function unlock(password) {
    const vid = await sha256Hex('sparkbook:' + password);
    // salt 在解密时从 envelope 读取；此处先占位，由 store 决定
    return { vid, password };
  }

  async function deriveKeyFromSalt(password, saltB64) {
    const saltBuf = saltB64 ? b64ToBuf(saltB64) : crypto.getRandomValues(new Uint8Array(16)).buffer;
    const key = await deriveKey(password, saltBuf);
    return { key, saltB64: saltB64 || bufToB64(saltBuf) };
  }

  async function encryptJSON(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return { iv: bufToB64(iv.buffer), ct: bufToB64(ct) };
  }

  async function decryptJSON(key, env) {
    const iv = b64ToBuf(env.iv);
    const ct = b64ToBuf(env.ct);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const text = new TextDecoder().decode(plainBuf);
    return JSON.parse(text);
  }

  // 免密会话：用一次性会话密钥 SK 加密 K 的"可复现口令"，存 localStorage
  // 这里我们把 password 经 SK 加密存盘（SK 仅存活内存）。恢复时用 SK 解密得 password 再派生 K。
  async function makeSessionKey() {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  async function encryptWithKey(rawKey, dataStr) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, rawKey, new TextEncoder().encode(dataStr));
    return { iv: bufToB64(iv.buffer), ct: bufToB64(ct) };
  }
  async function decryptWithKey(rawKey, env) {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(env.iv) }, rawKey, b64ToBuf(env.ct));
    return new TextDecoder().decode(plain);
  }

  global.SparkCrypto = {
    PBKDF2_ITER,
    sha256Hex,
    unlock,
    deriveKeyFromSalt,
    encryptJSON,
    decryptJSON,
    makeSessionKey,
    encryptWithKey,
    decryptWithKey,
    bufToB64,
    b64ToBuf,
  };
})(window);
