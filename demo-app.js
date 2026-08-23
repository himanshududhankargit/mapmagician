/* ============================================================================
   demo-app.js — Map Magician "Demo Mode" (standalone)
   ----------------------------------------------------------------------------
   APP_VERSION 140.

   WHY THIS IS A SEPARATE PAGE, NOT A FLAG INSIDE maps-app.js
   maps-app.js is ~700 KB and boots Firebase Database + Functions, Razorpay, the
   layer metadata fetch (d1/d2/d3.bin, ~2.6 MB), a polygon Web Worker,
   annotations and the purchase/paywall machinery. A demo has to be instant and
   must be *incapable* of touching paid content. Both fall out of not loading any
   of it: this page pulls firebase-auth ONLY — no database, no functions, no
   layer fetch, no entitlement code. "A demo can never show paid maps" is
   therefore structural here, not a rule that could regress.

   THE TILES ARE PUBLIC BY DESIGN
   /demo/* is its own CloudFront cache behavior with TrustedKeyGroups DISABLED
   and no viewer-request function — so no signed cookie and no mmp-token is
   needed, and it serves on both domains. Exposure is bounded by construction:
   exactly one plan lives under that prefix, and every tile there is watermarked
   (verified byte-identical to the MapMagicianTM/ source).

   🛑 THE SIGN-IN GATE IS LEAD CAPTURE, NOT PROTECTION. Because the tiles are
   public, anyone who reads this file can fetch them directly without signing
   in. The gate exists to put a name to a visitor, not to guard the pixels —
   do not let it grow into something the tile security is assumed to rest on.
   ========================================================================== */
(function () {
    'use strict';

    var APP_VERSION = 140;

    /* --- host: same rule as maps-app.js:2850, so this works on both domains --- */
    var ON_DPPLANS = /(^|\.)dpplans\.com$/i.test(location.hostname);
    var TILE_HOST  = ON_DPPLANS ? 'tiles.dpplans.com' : 'tiles.mapmagician.in';

    /* --- tile path, assembled at runtime -------------------------------------
       This is OBFUSCATION, NOT SECURITY, and it is worth being clear about why
       it is still here. The browser must issue the request, so the URL is always
       visible in DevTools -> Network, and anything this file can decode a reader
       of this file can decode too. What it buys: the string is not greppable in
       source, and the folder is named 'd1' rather than after the region, so a
       casual observer learns neither the region nor the ...EarthTileQgis naming
       convention used by the *paid* corpus. The real protection is that only
       this one plan exists under /demo/.                                      */
    var _seg = ['ZGVtbw==', 'ZDE='];               // 'demo', 'd1'
    var TILE_BASE = 'https://' + TILE_HOST + '/' + atob(_seg[0]) + '/' + atob(_seg[1]) + '/';

    /* --- extent -------------------------------------------------------------
       Derived from the ACTUAL z18 tile pyramid (x 186694-186742, y 117940-118007),
       not from the export's doc.kml — that file only describes the single z11
       tile, which is ~4x too large and would let the user pan into empty space.  */
    var PLAN = { west: 76.385193, east: 76.452484, south: 17.654491, north: 17.743455 };

    /* Breathing room so the plan's own boundary is visible instead of being
       clipped flush to the viewport edge. The lock is still "this region". */
    var PAD = 0.04;
    var _dLng = (PLAN.east - PLAN.west) * PAD;
    var _dLat = (PLAN.north - PLAN.south) * PAD;
    var BOUNDS = {
        west:  PLAN.west  - _dLng, east:  PLAN.east  + _dLng,
        south: PLAN.south - _dLat, north: PLAN.north + _dLat
    };

    var MIN_ZOOM = 11;   // strictBounds raises the effective floor to whatever fits
    var MAX_ZOOM = 18;   // pyramid stops here

    var firebaseConfig = {
        apiKey: "AIzaSyDUjHKQ3g2yz2o4ax61QS7dq5z0FV8k5Ss",
        authDomain: "sodium-hour-256110.firebaseapp.com",
        databaseURL: "https://sodium-hour-256110.firebaseio.com",
        projectId: "sodium-hour-256110",
        storageBucket: "sodium-hour-256110.appspot.com",
        messagingSenderId: "427608700943",
        appId: "1:427608700943:web:4b79666808054be5654b7a"
    };

    var map = null;
    var toastTimer = null, hintTimer = null;
    var firstTileDrawn = false;
    var mapsReady = false, signedIn = false, started = false;

    /* ======================================================================
       Canvas tile layer
       ----------------------------------------------------------------------
       Ported from CanvasMapType in maps-app.js (~:10467). Native ImageMapType
       renders <img src=tile.png> into the DOM, which Ctrl+S / File->Save As
       refetches into a _files/ folder — i.e. the whole visible plan walks out
       in one keystroke. Off-DOM Image objects are never in the DOM tree, so
       Save As cannot see them, and canvas pixels are runtime-only.
       This matters MORE here than on maps.html, because this page is public.
       No crossOrigin: a tainted canvas still draws, we just can't read pixels.
       ====================================================================== */
    function CanvasTileType() {
        this.tileSize = new google.maps.Size(256, 256);
        this.maxZoom  = MAX_ZOOM;
        this.minZoom  = MIN_ZOOM;
        this.name     = 'demo';
        this._live    = new Set();
    }

    CanvasTileType.prototype.getTile = function (coord, zoom, doc) {
        var div = doc.createElement('div');
        div.style.width = '256px';
        div.style.height = '256px';

        var n = Math.pow(2, zoom);
        if (zoom < MIN_ZOOM || zoom > MAX_ZOOM) return div;
        if (coord.x < 0 || coord.y < 0 || coord.x >= n || coord.y >= n) return div;

        var canvas = doc.createElement('canvas');
        canvas.width = 256; canvas.height = 256;
        canvas.style.width = '256px';
        canvas.style.height = '256px';
        canvas.style.display = 'block';
        div.appendChild(canvas);
        var ctx = canvas.getContext('2d');

        var img = new Image();
        img.onload = function () {
            // Guard: Google may release the tile while the fetch is in flight.
            if (div.parentNode) ctx.drawImage(img, 0, 0, 256, 256);
            img.onload = img.onerror = null;
            if (!firstTileDrawn) { firstTileDrawn = true; hideLoader(); }
        };
        // A 404 is normal — the pyramid is a ragged shape inside a rectangle.
        img.onerror = function () { img.onload = img.onerror = null; };
        img.src = TILE_BASE + zoom + '/' + coord.x + '/' + coord.y + '.png';

        div._mmImg = img;
        this._live.add(div);
        return div;
    };

    CanvasTileType.prototype.releaseTile = function (tile) {
        if (tile && tile._mmImg) {
            tile._mmImg.onload = tile._mmImg.onerror = null;
            tile._mmImg.src = '';            // cancel an in-flight fetch
            tile._mmImg = null;
        }
        this._live.delete(tile);
    };

    /* ================================ UI ================================== */

    function hideLoader() {
        var el = document.getElementById('demo-load');
        if (el) el.classList.add('hide');
    }

    function toast(msg) {
        var el = document.getElementById('demo-toast');
        if (!el) return;
        if (msg) el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
    }

    function hint(show) {
        var el = document.getElementById('demo-hint');
        if (el) el.classList.toggle('show', !!show);
    }

    function showGate(show) {
        var el = document.getElementById('demo-auth');
        if (el) el.classList.toggle('show', !!show);
    }

    function authError(msg) {
        var el = document.getElementById('demo-auth-err');
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('show', !!msg);
    }

    /* ============================== auth ================================== */

    function initAuth() {
        // firebase-auth-compat is loaded WITHOUT database/functions — the demo
        // reads nothing and writes nothing, it only needs an identity.
        if (typeof firebase === 'undefined') {
            // SDK blocked (offline, extension, corporate proxy). Failing closed
            // here would strand the visitor on a dead gate for a page whose
            // tiles are public anyway, so let them through.
            signedIn = true;
            showGate(false);
            startIfReady();
            return;
        }
        firebase.initializeApp(firebaseConfig);

        var btn = document.getElementById('demo-signin');
        var lbl = document.getElementById('demo-signin-label');
        var provider = new firebase.auth.GoogleAuthProvider();

        if (btn) btn.addEventListener('click', function () {
            authError('');
            btn.disabled = true;
            if (lbl) lbl.textContent = 'Opening Google…';
            // Popup, matching triggerGoogleSignIn() in maps-app.js:279 — works on
            // every domain without per-domain OAuth redirect configuration.
            firebase.auth().signInWithPopup(provider).catch(function (err) {
                btn.disabled = false;
                if (lbl) lbl.textContent = 'Continue with Google';
                if (err && (err.code === 'auth/popup-closed-by-user' ||
                            err.code === 'auth/cancelled-popup-request')) return;
                authError('Sign-in could not be completed. Please try again.');
            });
        });

        firebase.auth().onAuthStateChanged(function (user) {
            // Anonymous does NOT count — maps.html signs visitors in anonymously
            // to fetch CloudFront cookies, and this page shares that origin, so
            // an anonymous session would otherwise walk straight past the gate.
            if (user && !user.isAnonymous) {
                signedIn = true;
                showGate(false);
                startIfReady();
            } else {
                signedIn = false;
                showGate(true);
            }
        });
    }

    /* ============================== map =================================== */

    function startIfReady() {
        // Two independent async arrivals: the Maps JS API callback and the
        // Firebase auth state. Whichever lands second builds the map.
        if (started || !mapsReady || !signedIn) return;
        started = true;
        buildMap();
    }

    function buildMap() {
        var bounds = new google.maps.LatLngBounds(
            new google.maps.LatLng(BOUNDS.south, BOUNDS.west),
            new google.maps.LatLng(BOUNDS.north, BOUNDS.east)
        );

        map = new google.maps.Map(document.getElementById('map'), {
            center: { lat: (PLAN.south + PLAN.north) / 2, lng: (PLAN.west + PLAN.east) / 2 },
            zoom: 13,
            minZoom: MIN_ZOOM,
            maxZoom: MAX_ZOOM,
            mapTypeId: 'roadmap',
            // strictBounds is the hard lock: the VIEWPORT can never leave this
            // box, so there is no white void to pan into and no jank from
            // bouncing the camera back after the fact.
            restriction: { latLngBounds: bounds, strictBounds: true },
            disableDefaultUI: true,
            zoomControl: true,
            fullscreenControl: true,
            gestureHandling: 'greedy',
            clickableIcons: false,
            keyboardShortcuts: false
        });

        map.overlayMapTypes.push(new CanvasTileType());
        map.fitBounds(bounds);

        /* --- "you are pushing the wall" -----------------------------------
           Detecting a clamp is not as simple as "viewport touches the bounds":
           at the minimum zoom the viewport touches them permanently, so that
           test fires forever. Instead watch for the center being FROZEN while
           drag events keep arriving — that only happens when Google is
           refusing the movement. */
        var lastCenterKey = null, stuckCount = 0;

        map.addListener('dragstart', function () { lastCenterKey = null; stuckCount = 0; });
        map.addListener('drag', function () {
            var c = map.getCenter();
            if (!c) return;
            var key = c.lat().toFixed(7) + ',' + c.lng().toFixed(7);
            if (key === lastCenterKey) {
                if (++stuckCount === 3) toast('Demo is restricted to this region only');
            } else {
                stuckCount = 0;
            }
            lastCenterKey = key;
        });

        // Same message when they try to zoom back out past the lock.
        document.getElementById('map').addEventListener('wheel', function (e) {
            if (e.deltaY > 0 && map.getZoom() <= map.minZoom) {
                toast('Demo is restricted to this region only');
            }
        }, { passive: true });

        google.maps.event.addListenerOnce(map, 'idle', function () {
            hideLoader();
            hint(true);
            hintTimer = setTimeout(function () { hint(false); }, 5200);
        });
        map.addListener('zoom_changed', function () { clearTimeout(hintTimer); hint(false); });

        // Safety net: never leave the spinner up if every tile 404s. Started
        // here, not at page load, or it would expire while the gate is still up.
        setTimeout(hideLoader, 6000);
    }

    /* ============================== boot ================================== */

    function initDemo() {          // Google Maps JS API callback
        mapsReady = true;
        startIfReady();
    }

    // The Maps API callback must be global. demo-app.js is deferred ahead of the
    // API script, so this is assigned before the callback can fire.
    window.initDemo = initDemo;

    function boot() {
        var cta = document.getElementById('demo-cta');
        if (cta) cta.addEventListener('click', function () {
            location.href = 'maps.html?from=demo';
        });
        showGate(true);            // gate is the default state until auth says otherwise
        initAuth();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
