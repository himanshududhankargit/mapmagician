// Minimal service worker — required for PWA installability.
// Uses network-first pass-through. No caching to avoid stale tiles/auth.
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => { /* pass-through */ });
