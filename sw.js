// Service worker — caches app shell so the installed PWA opens offline
// instead of showing "This site can't be reached".
const SW_VERSION = 'v8-2026-05-09';
const CACHE_NAME = 'mm-shell-' + SW_VERSION;

// App-shell files to pre-cache on install
const SHELL_URLS = [
    '/maps.html',
    '/manifest.json',
    '/AssetsGIS/icons/icon-192x192.png',
    '/AssetsGIS/icons/icon-512x512.png',
    '/AssetsGIS/image-1.png',
    '/AssetsGIS/hero-banner-1280.webp'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(SHELL_URLS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    // Purge old caches from previous SW versions
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    // Cache API only supports GET. Let every other method pass through untouched —
    // covers form POSTs, analytics beacons (gtag, Clarity), and any XHR/fetch POSTs.
    if (e.request.method !== 'GET') return;

    const url = new URL(e.request.url);

    // Navigation requests (page loads): network-first, fall back to cached maps.html
    if (e.request.mode === 'navigate') {
        e.respondWith(
            fetch(e.request, { cache: 'no-store' })
                .then(resp => {
                    // Update cache with fresh copy
                    const clone = resp.clone();
                    caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
                    return resp;
                })
                .catch(() => caches.match('/maps.html'))
        );
        return;
    }

    // Same-origin assets: network-first with cache fallback
    if (url.origin === self.location.origin) {
        e.respondWith(
            fetch(e.request)
                .then(resp => {
                    if (resp.ok) {
                        const clone = resp.clone();
                        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
                    }
                    return resp;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }

    // Cross-origin (Google Maps, Firebase, Razorpay CDNs): pass-through,
    // these APIs don't work offline anyway
});
