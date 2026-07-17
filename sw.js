/* Sparkbook Service Worker —— 仅缓存离线骨架（登录页 + 静态资源），不缓存动态数据 */
const CACHE = 'sparkbook-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/styles.css',
  './assets/crypto.js',
  './assets/store.js',
  './assets/app.js',
  './assets/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 不拦截 SCF API（实时数据走网络）
  if (url.hostname.includes('tencentscf.com')) return;
  // 导航请求：网络优先，失败回退缓存首页
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
    return;
  }
  // 静态资源：缓存优先
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
