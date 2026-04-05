/*
 * GeoJson Village Polygon Overlay
 * --------------------------------
 * Ports the Android GeoJsonOverlayManager pattern to the web:
 *   - Downloads zipped GeoJSON per-district from CloudFront
 *   - Parses in a Web Worker (computes bounds/centroid, flattens MultiPolygon rings)
 *   - Persists to IndexedDB (districts / villages / polygon_points)
 *   - On map idle, queries viewport-intersecting villages and renders polylines
 *   - Caches downloaded districts so reloads do not refetch
 *
 * Exposes window.GeoJsonOverlay = { init, onViewportChanged, ensureDistrict,
 *                                    clearDistrict, setVisible, getStats }.
 * Requires JSZip to be loaded before this script.
 */
(function () {
    'use strict';

    // ---------- Configuration ----------
    var DB_NAME = 'mm_geojson_v1';
    var DB_VERSION = 1;
    var POINT_BATCH_SIZE = 1000;      // IndexedDB inserts per transaction
    var RENDER_DEBOUNCE_MS = 200;     // matches Android's 200ms debounce
    var DEFAULT_MAX_CONCURRENT = 3;   // matches Android's download semaphore
    var DEFAULT_MIN_ZOOM = 11;        // matches Android MIN_ZOOM_FOR_VILLAGE_NAMES
    var POLYLINE_COLOR = '#FFEB3B';
    var POLYLINE_WEIGHT = 1.5;
    var POLYLINE_OPACITY = 0.9;
    var POLYLINE_Z_INDEX = 500;

    // ---------- Module state ----------
    var db = null;
    var map = null;
    var options = {};
    var disabled = false;
    var visible = true;
    var parseWorker = null;
    var idleDebounceTimer = null;
    var renderGeneration = 0;          // incremented on every viewport change
    var renderCache = new Map();       // villageId -> google.maps.Polyline[]
    var inflightDownloads = new Map(); // districtKey -> Promise (dedup)
    var downloadSem = null;
    var activeToastTimer = null;
    var geocoder = null;
    var lastGeocodedCenter = null;          // {lat, lng} — last position we geocoded
    var lastGeocodedKey = null;             // cached district key from last geocode
    var geocodeCache = new Map();           // cellKey ("lat_lng" rounded) -> district key
    var DISTRICT_CHECK_DISTANCE_M = 500;    // matches Android DISTRICT_CHECK_DISTANCE_METERS

    // ---------- Tiny semaphore (matches Android Semaphore(3)) ----------
    function Semaphore(max) {
        this.max = max;
        this.current = 0;
        this.queue = [];
    }
    Semaphore.prototype.acquire = function () {
        var self = this;
        if (self.current < self.max) {
            self.current++;
            return Promise.resolve();
        }
        return new Promise(function (resolve) { self.queue.push(resolve); })
            .then(function () { self.current++; });
    };
    Semaphore.prototype.release = function () {
        this.current--;
        var next = this.queue.shift();
        if (next) next();
    };

    // ---------- IndexedDB open + schema ----------
    function openDatabase() {
        return new Promise(function (resolve, reject) {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB not supported'));
                return;
            }
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function (e) {
                var database = e.target.result;
                if (e.oldVersion < 1) {
                    // districts (keyed by districtName)
                    if (!database.objectStoreNames.contains('districts')) {
                        database.createObjectStore('districts', { keyPath: 'districtName' });
                    }
                    // villages (auto-increment id; indexed by district, center, bounds)
                    if (!database.objectStoreNames.contains('villages')) {
                        var vStore = database.createObjectStore('villages', {
                            keyPath: 'id', autoIncrement: true
                        });
                        vStore.createIndex('by_district', 'districtName', { unique: false });
                        vStore.createIndex('by_center', ['centerLat', 'centerLng'], { unique: false });
                    }
                    // polygon_points (auto-increment id; compound index for ordered reads)
                    if (!database.objectStoreNames.contains('polygon_points')) {
                        var pStore = database.createObjectStore('polygon_points', {
                            keyPath: 'id', autoIncrement: true
                        });
                        pStore.createIndex('by_village',
                            ['villageId', 'polygonIndex', 'pointIndex'],
                            { unique: false });
                    }
                }
            };
            req.onsuccess = function () {
                var database = req.result;
                database.onversionchange = function () { database.close(); };
                resolve(database);
            };
            req.onerror = function () { reject(req.error); };
            req.onblocked = function () { reject(new Error('IndexedDB open blocked')); };
        });
    }

    // ---------- IDB helpers ----------
    function idbGet(storeName, key) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(storeName, 'readonly');
            var req = tx.objectStore(storeName).get(key);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function idbPut(storeName, value) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(storeName, 'readwrite');
            var req = tx.objectStore(storeName).put(value);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function openCursorAsync(indexOrStore, range, onEach) {
        return new Promise(function (resolve, reject) {
            var req = indexOrStore.openCursor(range);
            req.onsuccess = function (e) {
                var cursor = e.target.result;
                if (!cursor) { resolve(); return; }
                onEach(cursor.value, cursor);
                cursor.continue();
            };
            req.onerror = function () { reject(req.error); };
        });
    }

    // ---------- District naming (matches Android: lowercase + spaces→underscores) ----------
    function districtKey(districtName) {
        if (!districtName) return '';
        return String(districtName).toLowerCase().replace(/ /g, '_');
    }

    // ---------- Haversine distance (meters) ----------
    function haversineMeters(lat1, lng1, lat2, lng2) {
        var R = 6371000;
        var toRad = Math.PI / 180;
        var dLat = (lat2 - lat1) * toRad;
        var dLng = (lng2 - lng1) * toRad;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    // ---------- Google Geocoding: resolve district from lat/lng (matches Android getDistrict) ----------
    function geocodeDistrict(lat, lng) {
        // Rounded cell cache (~1 km grid at 2 decimals)
        var cellKey = lat.toFixed(2) + '_' + lng.toFixed(2);
        if (geocodeCache.has(cellKey)) {
            return Promise.resolve(geocodeCache.get(cellKey));
        }
        if (typeof google === 'undefined' || !google.maps || !google.maps.Geocoder) {
            return Promise.resolve(null);
        }
        if (!geocoder) geocoder = new google.maps.Geocoder();
        return new Promise(function (resolve) {
            geocoder.geocode({ location: { lat: lat, lng: lng } }, function (results, status) {
                if (status !== 'OK' || !results || !results.length) {
                    console.warn('[GeoJsonOverlay] geocode status=' + status);
                    resolve(null);
                    return;
                }
                // Parse address_components for administrative_area_level_3, fallback locality
                var district = null, locality = null;
                for (var r = 0; r < results.length && (!district || !locality); r++) {
                    var comps = results[r].address_components || [];
                    for (var i = 0; i < comps.length; i++) {
                        var types = comps[i].types || [];
                        if (!district && types.indexOf('administrative_area_level_3') !== -1) {
                            district = comps[i].long_name;
                        }
                        if (!locality && types.indexOf('locality') !== -1) {
                            locality = comps[i].long_name;
                        }
                    }
                }
                var name = district || locality;
                var key = name ? districtKey(name) : null;
                if (key) geocodeCache.set(cellKey, key);
                resolve(key);
            });
        });
    }

    // ---------- Web Worker for GeoJSON parsing ----------
    function createParseWorker() {
        var workerSource = [
            'self.onmessage = function(e) {',
            '  var districtKey = e.data.districtKey;',
            '  var geojson = e.data.geojson;',
            '  try {',
            '    var features = (geojson && geojson.features) || [];',
            '    var villages = [];',
            '    for (var fi = 0; fi < features.length; fi++) {',
            '      var feat = features[fi];',
            '      if (!feat || !feat.geometry) continue;',
            '      var props = feat.properties || {};',
            '      var rings = null;',
            '      if (feat.geometry.type === "Polygon") rings = feat.geometry.coordinates;',
            '      else if (feat.geometry.type === "MultiPolygon") {',
            '        rings = [];',
            '        var mp = feat.geometry.coordinates;',
            '        for (var pi = 0; pi < mp.length; pi++) {',
            '          var poly = mp[pi];',
            '          if (poly && poly.length) rings.push(poly[0]);', // outer ring only
            '        }',
            '      } else continue;',
            '      if (!rings || !rings.length) continue;',
            '      // For Polygon type, keep only outer ring (index 0)',
            '      if (feat.geometry.type === "Polygon") rings = [rings[0]];',
            '      var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;',
            '      var sumLat = 0, sumLng = 0, cnt = 0;',
            '      var points = [];',
            '      for (var ri = 0; ri < rings.length; ri++) {',
            '        var ring = rings[ri];',
            '        if (!ring) continue;',
            '        for (var pj = 0; pj < ring.length; pj++) {',
            '          var lng = ring[pj][0];',
            '          var lat = ring[pj][1];',
            '          if (typeof lat !== "number" || typeof lng !== "number") continue;',
            '          if (lat < minLat) minLat = lat;',
            '          if (lat > maxLat) maxLat = lat;',
            '          if (lng < minLng) minLng = lng;',
            '          if (lng > maxLng) maxLng = lng;',
            '          sumLat += lat; sumLng += lng; cnt++;',
            '          points.push({ polygonIndex: ri, pointIndex: pj, lat: lat, lng: lng });',
            '        }',
            '      }',
            '      if (!cnt) continue;',
            '      var villageName = props.village || props.VILLAGE || props.Village || props.name || props.NAME || props.Name || "";',
            '      var talukaName = props.taluka || props.TALUKA || props.Taluka || props.tehsil || props.TEHSIL || "";',
            '      villages.push({',
            '        villageName: String(villageName),',
            '        talukaName: String(talukaName),',
            '        districtName: districtKey,',
            '        centerLat: sumLat / cnt,',
            '        centerLng: sumLng / cnt,',
            '        boundsNorth: maxLat, boundsSouth: minLat,',
            '        boundsEast: maxLng, boundsWest: minLng,',
            '        polygonCount: rings.length,',
            '        _points: points',
            '      });',
            '    }',
            '    self.postMessage({ ok: true, villages: villages });',
            '  } catch (err) {',
            '    self.postMessage({ ok: false, error: String(err && err.message || err) });',
            '  }',
            '};'
        ].join('\n');
        var blob = new Blob([workerSource], { type: 'application/javascript' });
        return new Worker(URL.createObjectURL(blob));
    }

    function parseInWorker(districtKeyStr, geojson) {
        return new Promise(function (resolve, reject) {
            if (!parseWorker) parseWorker = createParseWorker();
            // One-shot listener so we don't stack handlers
            var onMsg = function (e) {
                parseWorker.removeEventListener('message', onMsg);
                if (e.data && e.data.ok) resolve(e.data.villages);
                else reject(new Error((e.data && e.data.error) || 'parse failed'));
            };
            parseWorker.addEventListener('message', onMsg);
            parseWorker.postMessage({ districtKey: districtKeyStr, geojson: geojson });
        });
    }

    // ---------- Fetch + unzip ----------
    function fetchAndUnzip(districtKeyStr) {
        var url = options.zipBase + encodeURIComponent(districtKeyStr) + '.zip';
        return fetch(url, { credentials: 'include', mode: 'cors' })
            .then(function (res) {
                if (res.status === 403) {
                    // Cookies stale or missing — refresh once and retry
                    if (typeof window.fetchCloudFrontCookies === 'function') {
                        return window.fetchCloudFrontCookies().then(function () {
                            return fetch(url, { credentials: 'include', mode: 'cors' });
                        });
                    }
                    return res;
                }
                return res;
            })
            .then(function (res) {
                if (!res.ok) throw new Error('Zip fetch failed: ' + res.status);
                return res.blob();
            })
            .then(function (blob) {
                if (typeof JSZip === 'undefined') {
                    throw new Error('JSZip not loaded');
                }
                return JSZip.loadAsync(blob);
            })
            .then(function (zip) {
                var entry = null;
                zip.forEach(function (path, file) {
                    if (!entry && /\.geojson$/i.test(path)) entry = file;
                });
                if (!entry) throw new Error('No .geojson in zip');
                return entry.async('string');
            })
            .then(function (text) { return JSON.parse(text); });
    }

    // ---------- IDB inserts ----------
    function deleteDistrictData(districtKeyStr) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(['villages', 'polygon_points'], 'readwrite');
            var villages = tx.objectStore('villages');
            var points = tx.objectStore('polygon_points');
            var vIdx = villages.index('by_district');
            var pIdx = points.index('by_village');
            vIdx.openCursor(IDBKeyRange.only(districtKeyStr)).onsuccess = function (e) {
                var cur = e.target.result;
                if (!cur) return;
                var villageId = cur.value.id;
                villages.delete(villageId);
                var range = IDBKeyRange.bound(
                    [villageId, -Infinity, -Infinity],
                    [villageId, Infinity, Infinity]
                );
                pIdx.openCursor(range).onsuccess = function (ev) {
                    var pcur = ev.target.result;
                    if (pcur) { points.delete(pcur.primaryKey); pcur.continue(); }
                };
                cur.continue();
            };
            tx.oncomplete = resolve;
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error); };
        });
    }

    function insertDistrictAndVillages(districtRecord, villages) {
        // One transaction: district + all villages. Capture autoIncrement IDs.
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(['districts', 'villages'], 'readwrite');
            var dStore = tx.objectStore('districts');
            var vStore = tx.objectStore('villages');
            dStore.put(districtRecord);
            var idMap = new Array(villages.length);
            villages.forEach(function (v, idx) {
                var record = {
                    villageName: v.villageName,
                    talukaName: v.talukaName,
                    districtName: v.districtName,
                    centerLat: v.centerLat,
                    centerLng: v.centerLng,
                    boundsNorth: v.boundsNorth,
                    boundsSouth: v.boundsSouth,
                    boundsEast: v.boundsEast,
                    boundsWest: v.boundsWest,
                    polygonCount: v.polygonCount
                };
                var req = vStore.add(record);
                req.onsuccess = function () { idMap[idx] = req.result; };
            });
            tx.oncomplete = function () { resolve(idMap); };
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error); };
        });
    }

    function insertPointsBatch(records) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('polygon_points', 'readwrite');
            var store = tx.objectStore('polygon_points');
            for (var i = 0; i < records.length; i++) store.add(records[i]);
            tx.oncomplete = resolve;
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error); };
        });
    }

    function persistVillages(districtKeyStr, villages, onProgress) {
        var districtRecord = computeDistrictBounds(districtKeyStr, villages);
        return insertDistrictAndVillages(districtRecord, villages).then(function (idMap) {
            // Flatten point records with resolved villageIds
            var all = [];
            for (var i = 0; i < villages.length; i++) {
                var vid = idMap[i];
                if (!vid) continue;
                var pts = villages[i]._points;
                for (var j = 0; j < pts.length; j++) {
                    all.push({
                        villageId: vid,
                        polygonIndex: pts[j].polygonIndex,
                        pointIndex: pts[j].pointIndex,
                        lat: pts[j].lat,
                        lng: pts[j].lng
                    });
                }
            }
            // Chunk inserts
            var chain = Promise.resolve();
            var total = all.length;
            for (var k = 0; k < all.length; k += POINT_BATCH_SIZE) {
                (function (start) {
                    chain = chain.then(function () {
                        return insertPointsBatch(all.slice(start, start + POINT_BATCH_SIZE));
                    }).then(function () {
                        if (onProgress) onProgress(
                            Math.min(start + POINT_BATCH_SIZE, total), total);
                    });
                })(k);
            }
            return chain.then(function () { return { villageCount: villages.length, pointCount: all.length }; });
        });
    }

    function computeDistrictBounds(districtKeyStr, villages) {
        var n = -90, s = 90, e = -180, w = 180;
        for (var i = 0; i < villages.length; i++) {
            var v = villages[i];
            if (v.boundsNorth > n) n = v.boundsNorth;
            if (v.boundsSouth < s) s = v.boundsSouth;
            if (v.boundsEast > e) e = v.boundsEast;
            if (v.boundsWest < w) w = v.boundsWest;
        }
        return {
            districtName: districtKeyStr,
            boundsNorth: n, boundsSouth: s, boundsEast: e, boundsWest: w,
            featureCount: villages.length,
            downloadedAt: Date.now(),
            lastAccessedAt: Date.now()
        };
    }

    // ---------- Download orchestration ----------
    function ensureDistrict(districtKeyStr) {
        if (disabled || !districtKeyStr) return Promise.resolve(false);
        if (inflightDownloads.has(districtKeyStr)) return inflightDownloads.get(districtKeyStr);

        var promise = (function () {
            return idbGet('districts', districtKeyStr).then(function (existing) {
                if (existing) {
                    // Touch lastAccessedAt (fire-and-forget)
                    existing.lastAccessedAt = Date.now();
                    idbPut('districts', existing);
                    return true;
                }
                return downloadSem.acquire().then(function () {
                    showToast('Downloading village polygons for ' + districtKeyStr + '...');
                    return fetchAndUnzip(districtKeyStr)
                        .then(function (geojson) { return parseInWorker(districtKeyStr, geojson); })
                        .then(function (villages) {
                            if (!villages.length) {
                                showToast('No villages in ' + districtKeyStr, 2500);
                                return false;
                            }
                            console.log('[GeoJsonOverlay] parsed ' + villages.length +
                                ' villages for ' + districtKeyStr);
                            showToast('Saving ' + villages.length + ' villages...');
                            return persistVillages(districtKeyStr, villages, function (done, total) {
                                showToast('Saving ' + districtKeyStr + ': ' +
                                    Math.round(100 * done / total) + '%');
                            }).then(function (res) {
                                console.log('[GeoJsonOverlay] persisted ' + res.villageCount +
                                    ' villages, ' + res.pointCount + ' points for ' + districtKeyStr);
                                showToast('Loaded ' + res.villageCount + ' villages for ' +
                                    districtKeyStr, 2500);
                                // Trigger immediate render now that data is available
                                renderViewport();
                                return true;
                            });
                        })
                        .catch(function (err) {
                            console.error('[GeoJsonOverlay] ensureDistrict failed for ' +
                                districtKeyStr + ':', err);
                            showToast('Failed to load ' + districtKeyStr, 2500);
                            return false;
                        })
                        .then(function (result) { downloadSem.release(); return result; },
                              function (err) { downloadSem.release(); throw err; });
                });
            });
        })();
        inflightDownloads.set(districtKeyStr, promise);
        promise.then(function () { inflightDownloads.delete(districtKeyStr); },
                     function () { inflightDownloads.delete(districtKeyStr); });
        return promise;
    }

    // ---------- Viewport query + rendering ----------
    function queryVisibleVillages(bounds) {
        // Simple strategy: scan the villages store with an index,
        // filter in JS by bounds intersection. Works up to ~50k records/district.
        return new Promise(function (resolve, reject) {
            var matches = [];
            var tx = db.transaction('villages', 'readonly');
            var store = tx.objectStore('villages');
            var req = store.openCursor();
            req.onsuccess = function (e) {
                var cur = e.target.result;
                if (!cur) { resolve(matches); return; }
                var v = cur.value;
                var intersects =
                    v.boundsSouth <= bounds.maxLat &&
                    v.boundsNorth >= bounds.minLat &&
                    v.boundsWest <= bounds.maxLng &&
                    v.boundsEast >= bounds.minLng;
                if (intersects) matches.push(v);
                cur.continue();
            };
            req.onerror = function () { reject(req.error); };
        });
    }

    function getVillagePoints(villageId) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('polygon_points', 'readonly');
            var idx = tx.objectStore('polygon_points').index('by_village');
            var range = IDBKeyRange.bound(
                [villageId, -Infinity, -Infinity],
                [villageId, Infinity, Infinity]
            );
            var pts = [];
            idx.openCursor(range).onsuccess = function (e) {
                var cur = e.target.result;
                if (!cur) { resolve(pts); return; }
                pts.push(cur.value);
                cur.continue();
            };
            tx.onerror = function () { reject(tx.error); };
        });
    }

    function buildPolylinesForVillage(points) {
        // Group points by polygonIndex, build one Polyline per ring
        var rings = new Map();
        for (var i = 0; i < points.length; i++) {
            var p = points[i];
            var arr = rings.get(p.polygonIndex);
            if (!arr) { arr = []; rings.set(p.polygonIndex, arr); }
            arr.push({ lat: p.lat, lng: p.lng });
        }
        var lines = [];
        rings.forEach(function (path) {
            lines.push(new google.maps.Polyline({
                path: path,
                strokeColor: POLYLINE_COLOR,
                strokeWeight: POLYLINE_WEIGHT,
                strokeOpacity: POLYLINE_OPACITY,
                clickable: false,
                zIndex: POLYLINE_Z_INDEX,
                map: visible ? map : null
            }));
        });
        return lines;
    }

    function clearAllRenderedPolylines() {
        renderCache.forEach(function (lines) {
            for (var i = 0; i < lines.length; i++) lines[i].setMap(null);
        });
        renderCache.clear();
    }

    function renderViewport() {
        if (disabled || !map || !visible || !db) {
            console.log('[GeoJsonOverlay] renderViewport skip',
                { disabled: disabled, hasMap: !!map, visible: visible, hasDb: !!db });
            return;
        }
        var minZoom = (options.minZoom != null) ? options.minZoom : DEFAULT_MIN_ZOOM;
        var curZoom = map.getZoom();
        if (curZoom < minZoom) {
            console.log('[GeoJsonOverlay] zoom ' + curZoom + ' < minZoom ' + minZoom +
                ' — clearing and skipping render');
            clearAllRenderedPolylines();
            return;
        }
        var b = map.getBounds();
        if (!b) return;
        var ne = b.getNorthEast();
        var sw = b.getSouthWest();
        var vp = {
            minLat: sw.lat(), maxLat: ne.lat(),
            minLng: sw.lng(), maxLng: ne.lng()
        };
        var gen = ++renderGeneration;
        queryVisibleVillages(vp).then(function (villages) {
            if (gen !== renderGeneration) return; // stale pass
            console.log('[GeoJsonOverlay] render pass: ' + villages.length +
                ' villages in viewport (zoom=' + curZoom + ')');
            var wantIds = new Set(villages.map(function (v) { return v.id; }));
            // Remove polylines no longer visible
            renderCache.forEach(function (lines, vid) {
                if (!wantIds.has(vid)) {
                    for (var i = 0; i < lines.length; i++) lines[i].setMap(null);
                    renderCache.delete(vid);
                }
            });
            // Add polylines for newly visible villages (rate-limited per pass)
            var toAdd = villages.filter(function (v) { return !renderCache.has(v.id); });
            var chain = Promise.resolve();
            toAdd.forEach(function (v) {
                chain = chain.then(function () {
                    if (gen !== renderGeneration) return;
                    return getVillagePoints(v.id).then(function (pts) {
                        if (gen !== renderGeneration) return;
                        var lines = buildPolylinesForVillage(pts);
                        renderCache.set(v.id, lines);
                    });
                });
            });
        }).catch(function (err) {
            console.warn('[GeoJsonOverlay] renderViewport error:', err);
        });
    }

    function debouncedRender() {
        if (idleDebounceTimer) clearTimeout(idleDebounceTimer);
        idleDebounceTimer = setTimeout(renderViewport, RENDER_DEBOUNCE_MS);
    }

    // ---------- Toast UI (reuses #unlock-toast) ----------
    function showToast(message, autoHideMs) {
        try {
            var toast = document.getElementById('unlock-toast');
            var text = document.getElementById('unlock-toast-text');
            if (!toast || !text) { console.log('[GeoJsonOverlay] ' + message); return; }
            text.textContent = message;
            toast.classList.add('show');
            if (activeToastTimer) { clearTimeout(activeToastTimer); activeToastTimer = null; }
            if (autoHideMs) {
                activeToastTimer = setTimeout(function () {
                    toast.classList.remove('show');
                    activeToastTimer = null;
                }, autoHideMs);
            }
        } catch (_) { /* ignore toast errors */ }
    }

    // ---------- Viewport trigger from maps.html idle handler ----------
    function onViewportChanged() {
        if (disabled || !map) return;
        var c = map.getCenter();
        if (!c) return;
        var lat = c.lat(), lng = c.lng();

        // 1. Distance-gated geocoding lookup (matches Android 500m threshold)
        var shouldGeocode = !lastGeocodedCenter ||
            haversineMeters(lastGeocodedCenter.lat, lastGeocodedCenter.lng, lat, lng) >= DISTRICT_CHECK_DISTANCE_M;

        if (shouldGeocode) {
            lastGeocodedCenter = { lat: lat, lng: lng };
            geocodeDistrict(lat, lng).then(function (key) {
                if (!key) {
                    console.log('[GeoJsonOverlay] geocode returned no district at ' + lat.toFixed(4) + ',' + lng.toFixed(4));
                    return;
                }
                if (key !== lastGeocodedKey) {
                    lastGeocodedKey = key;
                    console.log('[GeoJsonOverlay] geocoded district key="' + key + '"');
                }
                ensureDistrict(key);
            });
        } else if (lastGeocodedKey) {
            // Within same 500m cell — kick off ensureDistrict (IDB hit = no-op, miss = download)
            ensureDistrict(lastGeocodedKey);
        }

        // 2. Debounced viewport render
        debouncedRender();
    }

    // ---------- Public API ----------
    function init(mapInstance, opts) {
        map = mapInstance;
        options = opts || {};
        if (!options.zipBase) {
            options.zipBase = 'https://tiles.mapmagician.in/dpplans/0geojson_dontUnzip/';
        }
        if (options.zipBase && options.zipBase.slice(-1) !== '/') options.zipBase += '/';
        var maxConc = options.maxConcurrent || DEFAULT_MAX_CONCURRENT;
        downloadSem = new Semaphore(maxConc);
        return openDatabase().then(function (database) {
            db = database;
            console.log('[GeoJsonOverlay] initialized. DB:', DB_NAME, 'zipBase:', options.zipBase);
        }).catch(function (err) {
            disabled = true;
            console.error('[GeoJsonOverlay] disabled — IndexedDB open failed:', err);
        });
    }

    function setVisible(flag) {
        visible = !!flag;
        if (!visible) {
            renderCache.forEach(function (lines) {
                for (var i = 0; i < lines.length; i++) lines[i].setMap(null);
            });
        } else {
            renderCache.forEach(function (lines) {
                for (var i = 0; i < lines.length; i++) lines[i].setMap(map);
            });
            debouncedRender();
        }
    }

    function clearDistrict(districtKeyOrName) {
        var key = districtKey(districtKeyOrName);
        if (!db || !key) return Promise.resolve();
        return deleteDistrictData(key).then(function () {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('districts', 'readwrite');
                tx.objectStore('districts').delete(key);
                tx.oncomplete = resolve;
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    function getStats() {
        if (!db) return Promise.resolve(null);
        return Promise.all([
            countStore('districts'),
            countStore('villages'),
            countStore('polygon_points')
        ]).then(function (counts) {
            return {
                districts: counts[0], villages: counts[1], points: counts[2],
                rendered: renderCache.size
            };
        });
    }

    function countStore(name) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(name, 'readonly');
            var req = tx.objectStore(name).count();
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    window.GeoJsonOverlay = {
        init: init,
        onViewportChanged: onViewportChanged,
        ensureDistrict: ensureDistrict,
        clearDistrict: clearDistrict,
        setVisible: setVisible,
        getStats: getStats
    };
})();
