/* Scoring 4 Cricket service worker: works offline at the ground. Bump VERSION on every release. */
const VERSION = 's4c-v17';
const SHELL = ['./', 'index.html', 'help.html', 'config.js', 'cloud.js', 'manifest.webmanifest', 'icons/logo.png', 'icons/badge-192.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png', 'icons/apple-touch-icon.png', 'lib/jspdf.umd.min.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname.endsWith('script.google.com') || u.hostname.endsWith('googleusercontent.com') || u.hostname === 'accounts.google.com') return; // live data: always network
  const fonts = u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com' || u.hostname === 'cdnjs.cloudflare.com';
  if (u.origin !== location.origin && !fonts) return;
  // network first for our own files (so updates show), cache fallback when offline
  e.respondWith(fetch(e.request).then(r => {
    if (r && (r.ok || r.type === 'opaque')) { const c = r.clone(); caches.open(VERSION).then(cc => cc.put(e.request, c)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
