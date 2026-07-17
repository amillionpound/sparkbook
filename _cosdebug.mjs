import crypto from 'crypto';
const API='https://1256784020-0i70k3at89.ap-guangzhou.tencentscf.com';
const web=crypto.webcrypto;
async function presign(vid,action){const r=await fetch(API+'/api/vault/presign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vid,action})});return r.json();}
const vid='0123456789abcdef'.repeat(4);
const p=await presign(vid,'put');
console.log('URL:',p.url);
const putR=await fetch(p.url,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:'{"x":1}'});
console.log('PUT status:',putR.status);
const txt=await putR.text();
console.log('BODY:',txt.slice(0,600));
