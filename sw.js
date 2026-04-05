// Minimal service worker — required for PWA installability.
// Forces network-first on navigation so the installed PWA always
// picks up the latest HTML instead of a stale cached version.
const SW_VERSION = 'v2-2026-04-05';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
    // For page navigations, always try network first. Fall back to whatever
    // the browser would do normally if network fails. This prevents the
    // installed PWA from being stuck on a cached maps.html forever.
    if (e.request.mode === 'navigate') {
        e.respondWith(
            fetch(e.request, { cache: 'no-store' }).catch(() => fetch(e.request))
        );
    }
    // All other requests: pass-through (browser default caching).
});
