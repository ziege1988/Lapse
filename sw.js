// Service Worker: hält die App offline verfügbar. Bei Änderungen VERSION erhöhen.
const VERSION = 'lapse-v1';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/project.js', 'js/pipeline.js', 'js/player.js', 'js/renderer.js', 'js/export.js',
  'js/geometry.js', 'js/features.js', 'js/align-worker.js', 'js/images.js', 'js/exif.js', 'js/zip.js',
  'vendor/mp4-muxer.mjs', 'vendor/webm-muxer.mjs', 'vendor/gifenc.esm.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Netz zuerst (immer aktuell), bei fehlender Verbindung aus dem Cache
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
