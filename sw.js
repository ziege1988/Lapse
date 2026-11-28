// Service Worker: hält die App offline verfügbar.
// VERSION wird beim Veröffentlichen automatisch auf den Commit gesetzt (GitHub Actions),
// dadurch erkennt jedes installierte Lapse neue Versionen selbstständig.
const VERSION = 'lapse-__BUILD__';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'css/lab.css', 'css/capture.css', 'css/hero.css', 'js/capture.js', 'js/diag.js', 'js/hero.js', 'js/overlay.js', 'js/sevenseg.js',
  'js/app.js', 'js/project.js', 'js/pipeline.js', 'js/player.js', 'js/renderer.js', 'js/export.js',
  'js/geometry.js', 'js/version.js', 'js/direct.js', 'js/anchors.js', 'js/store.js', 'js/features.js', 'js/align-worker.js', 'js/images.js', 'js/exif.js', 'js/zip.js',
  'vendor/mp4-muxer.mjs', 'vendor/webm-muxer.mjs', 'vendor/gifenc.esm.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  // Kein automatisches skipWaiting: die App entscheidet, wann aktualisiert wird (laufende Arbeit schützen)
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Seite kann ein sofortiges Aktivieren anfordern
self.addEventListener('message', e => { if (e.data === 'activate-now') self.skipWaiting(); });

// Netz zuerst (immer aktuell, Browser-Cache wird nur per ETag geprüft), offline aus dem Cache
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
