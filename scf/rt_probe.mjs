// 实时语音识别 4004 排查探针：对照测试不同引擎（只读诊断，不改业务代码）
// 用法: node rt_probe.mjs <engine> [diarize:0|1]
const API = 'https://1256784020-0i70k3at89.ap-guangzhou.tencentscf.com';
const engine = process.argv[2] || '16k_zh_en_speaker_2.0';
const diarize = process.argv[3] === undefined ? 1 : Number(process.argv[3]);

const r = await fetch(API + '/api/asr/rt-url', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ engine, enable_speaker_context: diarize ? 1 : 0 }),
});
const d = await r.json();
if (d.code !== 0) { console.log('rt-url FAIL', d); process.exit(1); }
console.log('engine =', d.engine);

const ws = new WebSocket(d.url);
const t0 = Date.now();
let done = false;
const finish = (tag) => { if (!done) { done = true; console.log('== END (' + tag + ') ' + (Date.now() - t0) + 'ms'); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 200); } };

ws.onopen = () => {
  console.log('WS_OPEN ok');
  // 发 1 秒 16k 静音 PCM（32 片 × 1024B），再发 end
  const silent = new Uint8Array(1024);
  let i = 0;
  const timer = setInterval(() => {
    if (i++ >= 32) { clearInterval(timer); try { ws.send(JSON.stringify({ type: 'end' })); console.log('sent end'); } catch {} return; }
    try { ws.send(silent); } catch {}
  }, 30);
};
ws.onmessage = (ev) => {
  const s = typeof ev.data === 'string' ? ev.data : '(binary)';
  console.log('MSG:', s.slice(0, 300));
  try { const m = JSON.parse(s); if (m.final === 1 || (m.code !== undefined && m.code !== 0)) finish('msg'); } catch {}
};
ws.onerror = (e) => { console.log('WS_ERROR', e?.message || ''); finish('error'); };
ws.onclose = (e) => { console.log('WS_CLOSE code=' + e.code + ' reason=' + (e.reason || '')); finish('close'); };
setTimeout(() => finish('timeout'), 15000);
