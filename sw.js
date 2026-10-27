// オフライン用：アプリのファイルを端末にキャッシュする。
// ファイルを更新したら VERSION を上げる（次回起動時に新しい版へ切り替わる）。
const VERSION = 'v0.3.2';
const CACHE = `oshi-app-${VERSION}`;
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/store.js', 'js/db.js', 'js/util.js', 'js/ui.js', 'js/oshi.js', 'js/demo.js',
  'js/views/calendar.js', 'js/views/goods.js', 'js/views/lives.js', 'js/views/settings.js',
  'js/views/trade.js', 'js/views/money.js', 'js/views/oshi-edit.js', 'js/views/notify.js', 'js/views/home.js',
  'js/plans.js', 'js/ink.js', 'js/memo.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('oshi-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // GASへの通信は素通し
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
