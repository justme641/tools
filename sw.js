/* 影音播放器 service worker
   只處理本播放器自己的檔案（mirror.html、圖示、manifest、mirror-data.json），
   同資料夾的其他工具頁面與所有外部網址一律不攔截。 */
const CACHE = 'mirror-pwa-v1';
const FILES = ['mirror.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('mirror-pwa-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function mine(url) {
  if (url.origin !== self.location.origin) return false;
  const base = self.location.pathname.replace(/[^/]*$/, '');
  if (!url.pathname.startsWith(base)) return false;
  const name = url.pathname.slice(base.length);
  return FILES.includes(name) || name === 'mirror-data.json';
}

/* 網路優先（有網路時永遠拿最新版），沒網路才用快取 */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!mine(url)) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
