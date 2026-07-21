// Service worker — caches app shell so the installed PWA opens offline
// instead of showing "This site can't be reached".
const SW_VERSION = 'v24-2026-07-21-hero-swr';
const CACHE_NAME = 'mm-shell-' + SW_VERSION;

// Region-icon cache: cross-origin PNGs from CloudFront used by the splash
// (index1.html) and maps.html region browser. Versioned independently of
// the app shell so an SW bump doesn't force users to re-download icons.
const ICON_CACHE = 'mm-icons-v1';
const ICON_URL_PREFIX = 'https://tiles.mapmagician.in/dpplans/0imagesGIS/';
const KEEP_CACHES = [CACHE_NAME, ICON_CACHE];

// App-shell files to pre-cache on install. Splash assets are listed so the
// first visit warms them for subsequent visits — keep this list lean, every
// entry is downloaded on each SW version bump.
const SHELL_URLS = [
    '/',                // splash is the homepage; pre-cache the canonical URL
    '/maps.html',
    '/maps-app.js',
    '/index1.html',     // alias kept for backward compat with old bookmarks
    '/data/menu-states.json',
    '/data/seo-index.json',
    '/AssetsGIS/flatbush.js',
    '/manifest.json',
    '/AssetsGIS/mapmagiciansmall.webp',
    '/AssetsGIS/splash-hero-desktop-1280.webp',
    '/AssetsGIS/splash-hero-mobile-750.webp',
    '/AssetsGIS/icons/icon-192x192.png',
    '/AssetsGIS/icons/icon-512x512.png',
    '/AssetsGIS/image-1.png',
    '/AssetsGIS/hero-banner-1280.webp',
    '/AssetsGIS/hero-banner-768.webp'   // DPR-2 phones resolve srcset to 768w, not 1280w
];

self.addEventListener('install', (e) => {
    // allSettled (not addAll) so a single missing/404 URL — e.g. /data/seo-index.json
    // on a fresh local checkout before the dpplans-seo postbuild has run —
    // doesn't abort the whole install and leave us without an active SW.
    e.waitUntil(
        caches.open(CACHE_NAME)
            // cache:'reload' forces each shell file to revalidate against the network
            // instead of being satisfied from the browser HTTP cache — otherwise a file
            // still inside its max-age (maps-app.js is max-age=14400 / 4h) could be
            // re-stored STALE into the fresh cache, defeating the whole version bump.
            .then(cache => Promise.allSettled(SHELL_URLS.map(url => cache.add(new Request(url, { cache: 'reload' })))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    // Purge old caches from previous SW versions but keep the icon cache.
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => !KEEP_CACHES.includes(k)).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    // Cache API only supports GET. Let every other method pass through untouched —
    // covers form POSTs, analytics beacons (gtag, Clarity), and any XHR/fetch POSTs.
    if (e.request.method !== 'GET') return;

    const url = new URL(e.request.url);

    // Region icons (cross-origin, CloudFront): cache-first with background
    // refresh. Opaque responses (no-cors) are cacheable and render fine in
    // <img> tags. Failing fetch + no cached copy returns a 404 stub so the
    // <img onerror> placeholder fires in the page.
    if (e.request.url.indexOf(ICON_URL_PREFIX) === 0) {
        e.respondWith(
            caches.open(ICON_CACHE).then(async cache => {
                const cached = await cache.match(e.request);
                if (cached) {
                    // Fire-and-forget refresh so updated icons land on the next view.
                    fetch(e.request).then(resp => {
                        if (resp && (resp.ok || resp.type === 'opaque')) {
                            cache.put(e.request, resp.clone()).catch(() => {});
                        }
                    }).catch(() => {});
                    return cached;
                }
                try {
                    const fresh = await fetch(e.request);
                    if (fresh && (fresh.ok || fresh.type === 'opaque')) {
                        cache.put(e.request, fresh.clone()).catch(() => {});
                    }
                    return fresh;
                } catch (err) {
                    return new Response('', { status: 504, statusText: 'icon offline' });
                }
            })
        );
        return;
    }

    // Splash/banner hero images: cache-first with background refresh. They are
    // the LCP element on / and /maps.html and effectively never change, but the
    // generic same-origin branch below is network-first — so on a slow mobile
    // network a repeat visitor's LCP waited on the network even though the image
    // was already cached. Serve the cached copy instantly; the fire-and-forget
    // refresh picks up any future redesign on the next visit.
    if (url.origin === self.location.origin &&
        (url.pathname.indexOf('/AssetsGIS/hero-banner-') === 0 ||
         url.pathname.indexOf('/AssetsGIS/splash-hero-') === 0)) {
        e.respondWith(
            caches.open(CACHE_NAME).then(async cache => {
                const cached = await cache.match(e.request);
                const refresh = fetch(e.request).then(resp => {
                    if (resp && resp.ok) {
                        cache.put(e.request, resp.clone()).catch(() => {});
                    }
                    return resp;
                }).catch(() => null);
                if (cached) return cached;
                return refresh.then(r => r || new Response('', { status: 504, statusText: 'hero offline' }));
            })
        );
        return;
    }

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
