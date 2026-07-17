// 端到端验证：浏览器加密流程 + COS 预签名读写整库（Node 模拟）
import crypto from 'crypto';
const API = 'https://1256784020-0i70k3at89.ap-guangzhou.tencentscf.com';
const PASS = 'test-e2e-pass-123';
const web = crypto.webcrypto;

function b64(buf){ return Buffer.from(buf).toString('base64'); }
function b64dec(s){ return Buffer.from(s,'base64'); }

async function sha256Hex(text){
  const d = await web.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function deriveKey(password, saltBuf){
  const pwKey = await web.subtle.importKey('raw', new TextEncoder().encode(password), {name:'PBKDF2'}, false, ['deriveKey']);
  return web.subtle.deriveKey({name:'PBKDF2', salt: saltBuf, iterations:150000, hash:'SHA-256'}, pwKey, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
}
async function encryptJSON(key, obj){
  const iv = web.getRandomValues(new Uint8Array(12));
  const ct = await web.subtle.encrypt({name:'AES-GCM', iv}, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function decryptJSON(key, env){
  const plain = await web.subtle.decrypt({name:'AES-GCM', iv: b64dec(env.iv)}, key, b64dec(env.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function presign(vid, action){
  const r = await fetch(API+'/api/vault/presign', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({vid, action})});
  return r.json();
}

(async () => {
  const vid = await sha256Hex('sparkbook:'+PASS);
  const salt = web.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(PASS, salt);

  const payload = { version:1, entries:[{id:'e1', type:'inspiration', body:'灵感测试', created:new Date().toISOString(), updated:new Date().toISOString()}], categories:['生活'], styleProfile:{terms:[],rules:[],samples:[]} };
  const env = { salt: b64(salt), ...(await encryptJSON(key, payload)) };

  // PUT
  const pput = await presign(vid,'put');
  const putR = await fetch(pput.url, {method:'PUT', headers:{'Content-Type':'application/octet-stream'}, body: JSON.stringify(env)});
  console.log('PUT status:', putR.status);

  // GET 回
  const pget = await presign(vid,'get');
  const getR = await fetch(pget.url);
  console.log('GET status:', getR.status);
  const back = await getR.json();
  const dec = await decryptJSON(key, back);
  console.log('decrypted entries:', JSON.stringify(dec.entries));
  console.log('ROUND_TRIP_OK:', dec.entries[0].body === '灵感测试');
})().catch(e=>{ console.error('ERR', e); process.exit(1); });
