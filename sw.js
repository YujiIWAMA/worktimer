const CACHE = 'worklog-v4';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'favicon-32.png', 'favicon-64.png',
  'mascot-work.webp', 'mascot-rest.webp'
];

self.addEventListener('install', e => {
  // 1つでも無いファイルがあっても、全体の初期化は失敗させない
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// ネットワーク優先、オフライン時はキャッシュ
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // 同期APIはキャッシュしない（古い状態を返さないため）
  if (new URL(e.request.url).pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => (list.length ? list[0].focus() : clients.openWindow('./')))
  );
});
