// maps-newregions.js — the "new regions" bottom sheet, ported from the Android app's
// NewRegionsSheetController + LayerAdditionsStore + NewRegionsAdapter
// (androidGISProject/.../supportClass/, sheet markup at res/layout/map.xml:711-805).
//
// A published region used to appear in complete silence: the layer file re-downloads,
// the polygons are simply there, and the only way to discover one was to pan over it
// by chance. This announces them — the new areas grouped under their region name, and
// a tap to fly the camera there.
//
// LAZY-LOADED: maps-app.js injects this script only when there is genuinely
// something to announce, so nothing here runs at page start. By the time it executes,
// the host globals (map, goToLocation, mmAnalytics) all exist — maps-app.js is a
// classic top-level script, so its let/const/function names share this script's
// global scope. Same arrangement as maps-annotations.js.
//
// WHAT IS THE BASELINE. Android keeps a separate menu_regions_baseline.json in
// filesDir because menuGIS arrives over a ChildEventListener with no snapshot on
// disk. The web needs no such file: getCachedOrFetchLayer ALREADY stores the last
// published copy of every layer in localStorage, version-stamped, and only replaces
// it when appConfig/dataVersions moves. So the previous cache entry IS the baseline,
// and a diff sits exactly on the boundary between two published versions. maps-app.js
// stashes that copy for us before it drops it (_stashLayerBaseline).
//
// WHAT IS DIFFED. d4/menuGIS (new regions, and new places inside a region that
// already existed) and d2/MahaVillage (new village plans) — the same two sources
// Android uses. d1 and d3 are deliberately NOT diffed: one d1 entry is a map SHEET,
// not a region (Nagpur Metropolitan alone is thirty-odd of them), so diffing them
// produced sheet numbers no user could act on.
//
// WHAT IS NOT ANNOUNCED — the three suppression rules, ported verbatim:
//   - anything at all when there is no previous copy (first visit, or the Settings
//     "clear cache" wipe). Every key would look new.
//   - a file that shares no keys at all with the old one — that is a mass re-key or a
//     republish under new names, not an addition.
//   - removals and edits. Only additions.
// Plus the same caps: a flood means a stale baseline, not that the catalogue doubled,
// so it re-baselines quietly instead of showing the user the whole app.
//
// ONE DELIBERATE DEPARTURE FROM ANDROID: no live byte-progress bar. Android drives it
// from the real download because a layer file over mobile data takes seconds; d4.bin
// is 72 KB gzipped and lands in a few hundred ms, so a live bar would be theatre —
// and opening the sheet on every sync would flash "Adding new regions" and hide again
// on the many publishes that add nothing (a d1 republish is the commonest publish
// there is). Here the sheet opens ONLY once the diff has found something, and then
// plays Android's short deliberate fill before revealing, so the change registers
// instead of appearing instantly and being missed.
(function () {
    'use strict';
    if (window.mmNewRegions) return;

    // ---------------------------------------------------------------- constants
    var PENDING_KEY = 'mm_new_regions_pending';   // must match maps-app.js
    var MENU_LAYER = 'menuGIS';                   // a whole region is new
    var MENU_PLACE_LAYER = 'menuGIS:place';       // new places in an existing region
    var VILLAGE_LAYER = 'MahaVillage';            // new village plans

    // Above these, assume a bad baseline rather than a genuine batch. The place limit
    // is deliberately generous — pasting a taluka's worth of towns into one region's
    // villagesJSON is a normal edit and must still be announced; it only needs to sit
    // below the scale of a baseline failure, and the largest single region already
    // holds ~845 places.
    var MAX_NEW_REGIONS = 5;
    var MAX_NEW_PLACES = 150;
    // Hard cap on announced entries; the excess is reported as "+N more".
    var MAX_ENTRIES = 200;
    // A month-old "new region" is not news.
    var MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
    // A menuGIS place is a single lat/lng; pad it into a box the camera can frame
    // (~2 km), so flying to one shows its surroundings instead of a bare point.
    var PLACE_PAD = 0.02;

    var DELIBERATE_FILL_MS = 1200;
    // Layers settle within moments of each other; wait for the last one so the list is
    // complete instead of revealing three times with a fuller list each time.
    var SETTLE_DEBOUNCE_MS = 500;
    // A downward drag past this dismisses the sheet, matching the legend sheet.
    var DRAG_DISMISS_PX = 60;

    // ------------------------------------------------------------ small helpers

    // Same parse as initSidebar's parseVillagesJSON. Duplicated rather than reused
    // because that one is trapped in the initSidebar closure and only published to
    // window later — a diff can run before that happens.
    function parsePlaces(json) {
        if (!json) return [];
        return String(json).split('\n').map(function (line) {
            var parts = line.split('=');
            if (parts.length !== 2) return null;
            var name = parts[0].trim();
            var coords = parts[1].trim().split(',');
            if (coords.length < 2) return null;
            var lat = parseFloat(coords[0]);
            var lng = parseFloat(coords[1]);
            if (!name || isNaN(lat) || isNaN(lng)) return null;
            return { name: name, lat: lat, lng: lng };
        }).filter(Boolean);
    }

    // Production suffixes every sheet key carries. They stack in no fixed order
    // (...EarthTileQgisTM, ...EarthTileQgis2024) so they are stripped in a loop.
    var KEY_SUFFIXES = ['EarthTilesQgis', 'EarthTileQgis', 'EarthTiles', 'EarthTile',
                        'Tiles', 'Tile', 'Qgis', 'TM'];
    var TRAILING_YEAR = /(19|20)\d{2}$/;

    // `101-102-103-104NagpurMetropolitanEarthTileQgis` -> `101-102-103-104 Nagpur Metropolitan`
    // `AlandiCorporationEarthTileQgisTM` -> `Alandi Corporation`
    // Purely cosmetic: a key that strips down to nothing falls back to its raw form.
    function prettify(raw) {
        var original = String(raw == null ? '' : raw);
        var s = original.trim();
        if (!s) return original;
        for (var pass = 0; pass < 6; pass++) {
            var lower = s.toLowerCase();
            var suffix = null;
            for (var i = 0; i < KEY_SUFFIXES.length; i++) {
                var cand = KEY_SUFFIXES[i].toLowerCase();
                if (s.length > cand.length && lower.lastIndexOf(cand) === s.length - cand.length) {
                    suffix = KEY_SUFFIXES[i];
                    break;
                }
            }
            var trimmed;
            if (suffix) trimmed = s.slice(0, s.length - suffix.length);
            else if (TRAILING_YEAR.test(s)) trimmed = s.slice(0, s.length - 4);
            else break;
            if (!trimmed.trim()) break;
            s = trimmed;
        }
        s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
             .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
             .replace(/\s+/g, ' ')
             .trim();
        return s || original;
    }

    // Path segments are inconsistently cased in the data ("madha", "SouthSolapur").
    function titleCase(raw) {
        var s = prettify(raw);
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    }

    // Bounding box of a `kml` value. The format is space-separated `lon,lat,z` tokens
    // with optional "close" markers between rings — the same shape the tile dispatcher
    // reads. Returns null when there is nothing to frame.
    function bboxOfKml(kml) {
        if (!kml) return null;
        var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        var count = 0;
        var tokens = String(kml).split(/\s+/);
        for (var i = 0; i < tokens.length; i++) {
            var token = tokens[i];
            if (!token || token.toLowerCase().indexOf('close') !== -1) continue;
            var parts = token.split(',');
            if (parts.length < 2) continue;
            var lng = parseFloat(parts[0]);
            var lat = parseFloat(parts[1]);
            if (isNaN(lng) || isNaN(lat)) continue;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            count++;
        }
        if (count < 2) return null;
        return { s: minLat, w: minLng, n: maxLat, e: maxLng };
    }

    function placeEntry(regionId, place) {
        return {
            k: regionId + ':' + place.name,
            l: place.name,
            s: place.lat - PLACE_PAD, w: place.lng - PLACE_PAD,
            n: place.lat + PLACE_PAD, e: place.lng + PLACE_PAD
        };
    }

    // ------------------------------------------------------------------- diffing

    // d4 / menuGIS: new regions, and new places inside an existing region.
    //
    // menuGIS, not the layer files, is the authority on what a region IS — it is the
    // unit the user already recognises from the region browser, and its villagesJSON
    // lists the named places inside it with real coordinates. Adding a place to an
    // existing region is the common case (a new town under Solapur is a new map to a
    // user even though the region itself is not new), so both are reported, with
    // different wording.
    function diffMenu(oldRaw, newRaw) {
        var current = {};       // id -> { name, pid, places[] }
        var currentIds = [];
        var id;
        for (id in newRaw) {
            if (!Object.prototype.hasOwnProperty.call(newRaw, id)) continue;
            var rec = newRaw[id] || {};
            var places = parsePlaces(rec.villagesJSON);
            // Nothing to point a camera at. An untappable row would be worse than
            // silence.
            if (!places.length) continue;
            current[id] = {
                // Same rule as MenuGisRegions.nameOf: a whole-state region leaves
                // `district` empty and names itself in `state`.
                name: String(rec.district || '').trim() || String(rec.state || '').trim() || id,
                pid: String(rec.productPurchaseID || '').trim(),
                places: places
            };
            currentIds.push(id);
        }
        if (!currentIds.length) return null;

        var baseline = {};      // id -> { placeName: 1 }
        var baselineIds = 0;
        for (id in oldRaw) {
            if (!Object.prototype.hasOwnProperty.call(oldRaw, id)) continue;
            var old = parsePlaces((oldRaw[id] || {}).villagesJSON);
            var seen = Object.create(null);
            for (var i = 0; i < old.length; i++) seen[old[i].name] = 1;
            baseline[id] = seen;
            baselineIds++;
        }
        if (!baselineIds) {
            console.log('[newregions] menuGIS: no previous copy — nothing announced');
            return null;
        }

        var newRegions = currentIds.filter(function (rid) { return !(rid in baseline); });
        var newPlaces = {};     // id -> [place]
        var newPlaceIds = [];
        var addedPlaceCount = 0;
        currentIds.forEach(function (rid) {
            if (!(rid in baseline)) return;
            var known = baseline[rid];
            var added = current[rid].places.filter(function (p) { return !known[p.name]; });
            if (!added.length) return;
            newPlaces[rid] = added;
            newPlaceIds.push(rid);
            addedPlaceCount += added.length;
        });
        if (!newRegions.length && !addedPlaceCount) return null;

        // Regions and places are added a handful at a time. A flood means the cached
        // copy was stale or from another schema, not that the catalogue doubled —
        // announcing that would show every user the whole app.
        if (newRegions.length > MAX_NEW_REGIONS || addedPlaceCount > MAX_NEW_PLACES) {
            console.warn('[newregions] menuGIS: ' + newRegions.length + ' regions / ' +
                         addedPlaceCount + ' places look new at once — treating as a ' +
                         'stale baseline, not announcing');
            return null;
        }

        var groups = [];
        newRegions.forEach(function (rid) {
            var region = current[rid];
            var entries = region.places.map(function (p) { return placeEntry(rid, p); });
            if (!entries.length) return;
            groups.push({ layer: MENU_LAYER, groupId: rid, label: region.name,
                          pid: region.pid, entries: entries });
        });
        newPlaceIds.forEach(function (rid) {
            var region = current[rid];
            var entries = newPlaces[rid].map(function (p) { return placeEntry(rid, p); });
            if (!entries.length) return;
            groups.push({ layer: MENU_PLACE_LAYER, groupId: rid, label: region.name,
                          pid: region.pid, entries: entries });
        });
        if (!groups.length) return null;

        console.log('[newregions] menuGIS: ' + newRegions.length + ' new region(s), ' +
                    addedPlaceCount + ' new place(s) — ' +
                    groups.map(function (g) { return g.label; }).join(', '));
        return { groups: groups, overflow: 0 };
    }

    // "/VillagePlans/Solapur/Mohol/AdhegaonMoholSolapurTiles/" -> district Solapur,
    // taluka Mohol. The LAST segment is always the entry's own folder, and not every
    // village sits under a taluka ("/VillagePlans/Latur/AusaLaturVillageEarthTileQgis/"),
    // so a taluka only exists when there is a segment between the district and that
    // folder.
    function villageGroupOf(entry) {
        var parts = String((entry && entry.link) || '').split('/').filter(function (p) {
            return p && p.trim();
        });
        var district = parts[1] || '';
        var taluka = parts.length >= 4 ? parts[2] : '';
        if (!district) return { id: '', label: 'Village plans' };
        // A taluka named after its own district reads as "Satara, Satara" — say it once.
        if (!taluka || taluka.toLowerCase() === district.toLowerCase()) {
            return { id: district.toLowerCase(), label: titleCase(district) };
        }
        return { id: (district + '/' + taluka).toLowerCase(),
                 label: titleCase(taluka) + ', ' + titleCase(district) };
    }

    // d2 / MahaVillage: new village plans. Those entries ARE the product — one named
    // village each, grouped by the district/taluka in their link path.
    function diffVillage(oldRaw, newRaw) {
        var oldKeys = Object.keys(oldRaw || {});
        if (!oldKeys.length) {
            console.log('[newregions] village: no previous copy — nothing announced');
            return null;
        }
        var oldSet = Object.create(null);
        oldKeys.forEach(function (k) { oldSet[k] = 1; });

        var newKeys = Object.keys(newRaw || {});
        var shares = newKeys.some(function (k) { return oldSet[k]; });
        if (!shares) {
            console.log('[newregions] village: shares no keys with the previous copy ' +
                        '(mass re-key) — nothing announced');
            return null;
        }

        var added = newKeys.filter(function (k) { return !oldSet[k]; }).sort();
        if (!added.length) return null;

        // Group first, then cap, so the cap never leaves a group half-listed at the tail.
        var byGroup = {};
        var order = [];
        var labels = {};
        added.forEach(function (key) {
            var entry = newRaw[key];
            if (!entry || typeof entry !== 'object') return;
            var bbox = bboxOfKml(entry.kml);
            if (!bbox) return;
            var group = villageGroupOf(entry);
            if (!(group.id in byGroup)) { byGroup[group.id] = []; order.push(group.id); }
            labels[group.id] = group.label;
            byGroup[group.id].push({
                k: key,
                l: String(entry.VillageName || '').trim() || prettify(key),
                s: bbox.s, w: bbox.w, n: bbox.n, e: bbox.e
            });
        });
        if (!order.length) {
            console.log('[newregions] village: ' + added.length +
                        ' added but none had usable coordinates');
            return null;
        }

        var budget = MAX_ENTRIES;
        var overflow = 0;
        var groups = [];
        order.forEach(function (id) {
            var entries = byGroup[id];
            if (budget <= 0) { overflow += entries.length; return; }
            var kept = entries.slice(0, budget);
            overflow += entries.length - kept.length;
            budget -= kept.length;
            groups.push({ layer: VILLAGE_LAYER, groupId: id, label: labels[id],
                          pid: '', entries: kept });
        });

        console.log('[newregions] village: ' + added.length + ' new entries in ' +
                    order.length + ' groups (overflow=' + overflow + ')');
        return { groups: groups, overflow: overflow };
    }

    // --------------------------------------------------- pending-announcement store

    // Merges into whatever is already waiting. Two publishes can land before the user
    // looks, and the second must not erase the first; entries already recorded (same
    // layer + key) are ignored so a re-run never duplicates rows.
    function record(pending) {
        if (!pending || !pending.groups || !pending.groups.length) return;
        var existing = peek();
        var byId = {};
        var order = [];
        (existing ? existing.groups : []).concat(pending.groups).forEach(function (group) {
            var id = group.layer + ' ' + group.groupId;
            var previous = byId[id];
            if (!previous) {
                byId[id] = { layer: group.layer, groupId: group.groupId, label: group.label,
                             pid: group.pid || '', entries: group.entries.slice() };
                order.push(id);
                return;
            }
            var seen = Object.create(null);
            previous.entries.forEach(function (e) { seen[e.k] = 1; });
            group.entries.forEach(function (e) { if (!seen[e.k]) previous.entries.push(e); });
        });

        var budget = MAX_ENTRIES;
        var overflow = (existing ? existing.overflow : 0) + (pending.overflow || 0);
        var capped = [];
        order.forEach(function (id) {
            var group = byId[id];
            if (budget <= 0) { overflow += group.entries.length; return; }
            var kept = group.entries.slice(0, budget);
            overflow += group.entries.length - kept.length;
            budget -= kept.length;
            group.entries = kept;
            capped.push(group);
        });
        if (!capped.length) return;

        try {
            localStorage.setItem(PENDING_KEY, JSON.stringify({
                stampedAt: Date.now(), overflow: overflow, groups: capped
            }));
        } catch (e) { /* quota — an announcement is not worth failing over */ }
    }

    function peek() {
        var raw = null;
        try { raw = localStorage.getItem(PENDING_KEY); } catch (e) { return null; }
        if (!raw) return null;
        try {
            var root = JSON.parse(raw);
            if (root && root.stampedAt > 0 && Date.now() - root.stampedAt > MAX_AGE_MS) {
                console.log('[newregions] pending announcement expired — dropping');
                clear();
                return null;
            }
            var groups = (root && Array.isArray(root.groups) ? root.groups : [])
                .filter(function (g) { return g && Array.isArray(g.entries) && g.entries.length; });
            if (!groups.length) return null;
            return { groups: groups, overflow: (root && root.overflow) || 0 };
        } catch (e) {
            clear();
            return null;
        }
    }

    function clear() {
        try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
    }

    // ------------------------------------------------------------------- the sheet

    // Injected rather than shipped in maps.html so the whole feature — markup, style
    // and behaviour — arrives in one lazy file and costs a user who never sees an
    // announcement exactly nothing. Palette matches the Android sheet
    // (new_regions_sheet_bg / _handle / _badge_bg) and the site's own teal.
    var CSS = [
        /* Bottom sheet at every width. Unlike the legend this is a transient notice,
           not a reference you work beside, so the desktop right-drawer treatment
           would be wrong — it would sit in the same slot as the legend and layers
           panels and read as another permanent surface. Capped at 55% of the
           viewport, exactly the Android sheet's MAX_HEIGHT_FRACTION, so the map stays
           the larger half and the region you fly to is visible behind it.
           z-index 2100 = above the legend sheet (2000), below every dialog (2500+). */
        '.mmnr-sheet{position:fixed;left:0;right:0;bottom:0;z-index:2100;background:#fff;',
        'border-radius:20px 20px 0 0;box-shadow:0 -2px 14px rgba(0,0,0,.3);display:flex;',
        'flex-direction:column;max-height:55vh;max-height:55dvh;padding-bottom:12px;',
        /* Hidden = fully off-screen, INCLUDING the upward box-shadow. A bare 101%
           clears the box but not the ~16px of shadow cast above its top edge, which
           reads as a grey strip stuck to the bottom of the window after Dismiss. */
        'transform:translateY(calc(100% + 24px));transition:transform .28s ease;',
        'will-change:transform;font-family:inherit}',
        '.mmnr-sheet.open{transform:translateY(0)}',
        /* Suppress the slide animation while a finger is dragging the sheet. */
        '.mmnr-sheet.dragging{transition:none}',
        /* Collapsed = the header only, still reachable so another row can be picked
           after flying to one. Mirrors the Android STATE_COLLAPSED peek. */
        '.mmnr-sheet.collapsed .mmnr-body,.mmnr-sheet.collapsed .mmnr-progress{display:none}',
        '.mmnr-grab{flex-shrink:0;padding:10px 0 2px;display:flex;justify-content:center;',
        'cursor:grab;touch-action:none}',
        '.mmnr-grab::before{content:"";width:36px;height:4px;border-radius:2px;background:#D0D0D0}',
        '.mmnr-head{flex-shrink:0;display:flex;align-items:center;gap:8px;padding:8px 12px 0 16px}',
        '.mmnr-heads{flex:1;min-width:0;cursor:pointer}',
        '.mmnr-title{font-size:16px;font-weight:500;color:#212121;margin:0;',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.mmnr-sub{font-size:12px;color:#757575;margin:2px 0 0;line-height:1.35}',
        '.mmnr-dismiss{flex-shrink:0;background:none;border:none;font-family:inherit;',
        'font-size:13px;font-weight:500;color:#008577;cursor:pointer;padding:8px 12px;border-radius:6px}',
        '.mmnr-dismiss:hover{background:#E0F2F1}',
        '.mmnr-progress{flex-shrink:0;height:4px;margin:10px 16px 0;border-radius:2px;',
        'background:#E0E0E0;overflow:hidden}',
        '.mmnr-progress>i{display:block;height:100%;width:0;background:#008577;border-radius:2px}',
        '.mmnr-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;',
        'margin-top:4px;padding-bottom:8px}',
        '.mmnr-group,.mmnr-entry{display:flex;align-items:center;gap:8px;width:100%;',
        'background:none;border:none;font-family:inherit;text-align:left;cursor:pointer}',
        '.mmnr-group{padding:12px 12px 8px 16px}',
        '.mmnr-group:hover,.mmnr-entry:hover{background:#F5F5F5}',
        '.mmnr-gtext{flex:1;min-width:0}',
        '.mmnr-gname{display:block;font-size:15px;font-weight:500;color:#212121;',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.mmnr-badge{display:inline-block;margin-top:3px;padding:2px 8px;border-radius:10px;',
        'background:#E0F2F1;color:#008577;font-size:11px;font-weight:500}',
        '.mmnr-chev{flex-shrink:0;width:24px;height:24px;opacity:.55}',
        '.mmnr-entry{gap:12px;padding:9px 16px 9px 28px}',
        '.mmnr-entry::before{content:"";flex-shrink:0;width:6px;height:6px;border-radius:50%;',
        'background:#F9A825}',
        '.mmnr-ename{flex:1;min-width:0;font-size:13px;color:#757575;',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.mmnr-arrow{flex-shrink:0;width:18px;height:18px;opacity:.45}',
        /* Not a drawer on desktop — just stop it spanning a 27" screen edge to edge.
           LEFT, not right: the FAB stack lives at right:8px and the sheet would sit
           on top of it. Raised 60px so it clears the .bottom-bar (52px on desktop,
           the same offset .fab-stack uses) instead of covering its controls.
           🛑 The hidden transform must clear BOTH the sheet and that 60px offset —
           a percentage alone leaves a strip of the header on screen after Dismiss,
           because 101% of the sheet's own height is only a few px more than 100%. */
        '@media(min-width:700px){.mmnr-sheet{right:auto;left:16px;width:380px;bottom:60px;',
        'border-radius:16px;max-height:60vh;max-height:60dvh;',
        'transform:translateY(calc(100% + 84px))}',
        '.mmnr-grab{display:none}.mmnr-head{padding-top:14px}}'
    ].join('');

    var CHEVRON_SVG = '<svg class="mmnr-chev" viewBox="0 0 24 24" fill="none" stroke="#212121" ' +
                      'stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
    var ARROW_SVG = '<svg class="mmnr-arrow" viewBox="0 0 24 24" fill="none" stroke="#212121" ' +
                    'stroke-width="2" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';

    var els = null;             // built on first reveal, then reused
    var dismissed = false;      // Dismiss pressed: no reappearing this session
    var showingList = false;
    var revealGen = 0;          // cancels a fill whose reveal has been superseded
    var settleTimer = null;
    // Set by demo() only. Adds " · preview" to the subtitle so a stray visitor to the
    // staging page cannot mistake invented regions for a real update.
    var previewMode = false;

    function build() {
        if (els) return els;
        var style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        var sheet = document.createElement('div');
        sheet.className = 'mmnr-sheet';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-live', 'polite');
        sheet.setAttribute('aria-label', 'Newly added map regions');
        sheet.innerHTML =
            '<div class="mmnr-grab" aria-hidden="true"></div>' +
            '<div class="mmnr-head">' +
                '<div class="mmnr-heads">' +
                    '<p class="mmnr-title">Adding new regions</p>' +
                    '<p class="mmnr-sub">Checking for newly added map regions…</p>' +
                '</div>' +
                '<button class="mmnr-dismiss" type="button">Dismiss</button>' +
            '</div>' +
            '<div class="mmnr-progress"><i></i></div>' +
            '<div class="mmnr-body" hidden></div>';
        document.body.appendChild(sheet);

        els = {
            sheet: sheet,
            grab: sheet.querySelector('.mmnr-grab'),
            heads: sheet.querySelector('.mmnr-heads'),
            title: sheet.querySelector('.mmnr-title'),
            sub: sheet.querySelector('.mmnr-sub'),
            progress: sheet.querySelector('.mmnr-progress'),
            fill: sheet.querySelector('.mmnr-progress > i'),
            body: sheet.querySelector('.mmnr-body')
        };

        sheet.querySelector('.mmnr-dismiss').addEventListener('click', dismiss);
        // After navigating, the sheet collapses to its header. Tapping the header
        // brings the list back so another row can be picked — the web equivalent of
        // dragging an Android sheet back up from STATE_COLLAPSED.
        els.heads.addEventListener('click', function () {
            els.sheet.classList.remove('collapsed');
        });

        // Swipe-down-to-dismiss, mirroring the legend sheet and the Android one where
        // any downward drag snaps straight to hidden. Bound to the grabber only, so a
        // drag never fights the scrolling list below it. Swiping away is NOT a
        // dismiss: it hides without clearing, so the announcement is still there on
        // the next load. Only the Dismiss button marks it seen.
        if (window.PointerEvent) {
            var startY = 0, dy = 0, dragging = false;
            els.grab.addEventListener('pointerdown', function (e) {
                dragging = true; startY = e.clientY; dy = 0;
                els.sheet.classList.add('dragging');
                try { els.grab.setPointerCapture(e.pointerId); } catch (err) {}
            });
            els.grab.addEventListener('pointermove', function (e) {
                if (!dragging) return;
                dy = Math.max(0, e.clientY - startY);   // down only; no rubber-banding up
                els.sheet.style.transform = 'translateY(' + dy + 'px)';
            });
            var endDrag = function () {
                if (!dragging) return;
                dragging = false;
                els.sheet.classList.remove('dragging');
                els.sheet.style.transform = '';         // hand control back to the class
                if (dy > DRAG_DISMISS_PX) hide();
            };
            els.grab.addEventListener('pointerup', endDrag);
            els.grab.addEventListener('pointercancel', endDrag);
        }
        return els;
    }

    function hide() {
        if (els) els.sheet.classList.remove('open');
    }

    // Hides the sheet AND marks the announcement seen, so this publish is never
    // announced again on any later load.
    function dismiss() {
        dismissed = true;
        revealGen++;
        hide();
        clear();
    }

    // Debounced because the layers settle within moments of each other and only the
    // last, fullest list should be revealed.
    function scheduleReveal() {
        if (dismissed) return;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(function () {
            settleTimer = null;
            revealPending();
        }, SETTLE_DEBOUNCE_MS);
    }

    function revealPending() {
        if (dismissed) return;
        var pending = peek();
        if (!pending) return;                  // nothing to say: the sheet never opens

        var rows = buildRows(pending);
        if (!rows.length) { clear(); return; }

        var e = build();
        showingList = false;

        // Progress state, then a short deliberate fill. Nothing is really downloading
        // at this point — see the header note on why the web has no live byte bar —
        // the fill exists so the change registers instead of being missed.
        e.title.textContent = 'Adding new regions';
        e.sub.textContent = 'Checking for newly added map regions…';
        e.body.hidden = true;
        e.body.innerHTML = '';
        e.progress.style.display = '';
        e.sheet.classList.remove('collapsed');
        e.sheet.classList.add('open');

        e.fill.style.transition = 'none';
        e.fill.style.width = '0%';
        void e.fill.offsetWidth;               // commit the reset before animating
        e.fill.style.transition = 'width ' + DELIBERATE_FILL_MS + 'ms linear';
        e.fill.style.width = '100%';

        var gen = ++revealGen;
        setTimeout(function () {
            if (gen !== revealGen) return;     // superseded by a fuller list, or dismissed
            showList(pending, rows);
        }, DELIBERATE_FILL_MS);
    }

    // A menuGIS group's children are places INSIDE a newly added region, not additions
    // in their own right; a village group's children each are one. The badge has to
    // say which.
    function captionFor(group, count) {
        if (group.layer === MENU_LAYER) {
            return count === 1 ? 'New region · 1 location'
                               : 'New region · ' + count + ' locations';
        }
        if (group.layer === MENU_PLACE_LAYER) {
            return count === 1 ? '1 new location' : count + ' new locations';
        }
        return count === 1 ? '1 new village plan' : count + ' new village plans';
    }

    function labelFor(group) {
        var label = String(group.label || '').trim();
        if (label) return label;
        if (group.layer === VILLAGE_LAYER) return 'Village plans';
        return String(group.groupId || '').trim() || 'New region';
    }

    function buildRows(pending) {
        var rows = [];
        pending.groups.forEach(function (group) {
            var entries = (group.entries || []).filter(function (en) {
                return typeof en.s === 'number' && typeof en.n === 'number' &&
                       !isNaN(en.s) && !isNaN(en.n) && en.s <= en.n;
            });
            if (!entries.length) return;
            var union = entries.reduce(function (box, en) {
                return { s: Math.min(box.s, en.s), w: Math.min(box.w, en.w),
                         n: Math.max(box.n, en.n), e: Math.max(box.e, en.e) };
            }, { s: Infinity, w: Infinity, n: -Infinity, e: -Infinity });
            rows.push({ type: 'group', label: labelFor(group), pid: group.pid || '',
                        caption: captionFor(group, entries.length), bbox: union });
            entries.forEach(function (en) {
                rows.push({ type: 'entry', label: en.l, pid: group.pid || '',
                            bbox: { s: en.s, w: en.w, n: en.n, e: en.e } });
            });
        });
        return rows;
    }

    function showList(pending, rows) {
        if (dismissed) return;
        var e = build();
        showingList = true;

        var regions = pending.groups.filter(function (g) {
            return g.layer === MENU_LAYER;
        }).length;
        var places = 0, villages = 0;
        pending.groups.forEach(function (g) {
            if (g.layer === MENU_PLACE_LAYER) places += g.entries.length;
            else if (g.layer !== MENU_LAYER) villages += g.entries.length;
        });

        var parts = [];
        if (regions > 0) parts.push(regions === 1 ? '1 new region' : regions + ' new regions');
        if (places > 0) parts.push(places === 1 ? '1 new location' : places + ' new locations');
        if (villages > 0) parts.push(villages === 1 ? '1 new village plan'
                                                    : villages + ' new village plans');

        e.title.textContent = parts.length === 1
            ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + ' added'
            : 'New maps added';
        e.sub.textContent = parts.join(' and ') +
            (pending.overflow > 0 ? ' (+' + pending.overflow + ' more)' : '') +
            ' — tap one to view it on the map' +
            (previewMode ? ' · preview' : '');

        e.body.innerHTML = '';
        rows.forEach(function (row) {
            var btn = document.createElement('button');
            btn.type = 'button';
            if (row.type === 'group') {
                btn.className = 'mmnr-group';
                var text = document.createElement('span');
                text.className = 'mmnr-gtext';
                var name = document.createElement('span');
                name.className = 'mmnr-gname';
                name.textContent = row.label;          // textContent: region names are data
                var badge = document.createElement('span');
                badge.className = 'mmnr-badge';
                badge.textContent = row.caption;
                text.appendChild(name);
                text.appendChild(badge);
                btn.appendChild(text);
                btn.insertAdjacentHTML('beforeend', CHEVRON_SVG);
            } else {
                btn.className = 'mmnr-entry';
                var ename = document.createElement('span');
                ename.className = 'mmnr-ename';
                ename.textContent = row.label;
                btn.appendChild(ename);
                btn.insertAdjacentHTML('beforeend', ARROW_SVG);
            }
            btn.addEventListener('click', function () { navigate(row); });
            e.body.appendChild(btn);
        });

        e.progress.style.display = 'none';
        e.body.hidden = false;
        e.sheet.classList.add('open');

        // Seen: keep it on screen, but never announce this publish again.
        clear();
        try {
            mmAnalytics.event('new_regions_shown',
                { regions: regions, places: places, villages: villages });
        } catch (err) {}
        console.log('[newregions] announced ' + regions + ' region(s) / ' + places +
                    ' place(s) / ' + villages + ' village plan(s)');
    }

    function navigate(row) {
        // Collapse BEFORE flying, not after. The camera centres on the whole map view,
        // so an expanded sheet leaves the place sitting low on screen, half-crowded by
        // the sheet it was picked from. Collapsing (rather than hiding — the header
        // stays reachable so another row can be picked) hands the animation an almost
        // full-screen map to centre in.
        if (els) els.sheet.classList.add('collapsed');
        var b = row.bbox;
        if (!b || typeof map === 'undefined' || !map ||
            typeof google === 'undefined' || !google.maps) return;
        // goToLocation first — it sets zoomBypassActive, the purchase context and the
        // status text — then fitBounds frames the footprint. Same order the
        // search-result picker uses; see invokeSearchPick in maps-app.js.
        if (typeof window.goToLocation === 'function') {
            window.goToLocation((b.s + b.n) / 2, (b.w + b.e) / 2, row.label, row.pid || '');
        }
        try {
            map.fitBounds(new google.maps.LatLngBounds(
                { lat: b.s, lng: b.w }, { lat: b.n, lng: b.e }));
        } catch (err) { /* a degenerate box just leaves goToLocation's framing */ }
    }

    // ---------------------------------------------------------------------- exports

    window.mmNewRegions = {
        // Called by maps-app.js when a diffed layer has been refetched after a
        // version bump, with the copy the browser held beforehand.
        runLayerDiff: function (cacheKey, previous, fresh) {
            try {
                var pending = null;
                if (cacheKey === 'layer_menu') pending = diffMenu(previous, fresh);
                else if (cacheKey === 'layer_village') pending = diffVillage(previous, fresh);
                else return;
                if (!pending) return;
                record(pending);
                // A fresh publish supersedes a list already on screen — its own
                // announcement was cleared when it was shown, so what is pending now
                // is only the new material.
                showingList = false;
                scheduleReveal();
            } catch (e) {
                // An announcement is a nicety; never let it break a layer load.
                console.warn('[newregions] diff failed for', cacheKey, e);
            }
        },
        scheduleReveal: scheduleReveal,
        hide: hide,
        dismiss: dismiss,
        // Preview seam — the web answer to Android's SHOW_DEMO_REGIONS. Plants an
        // announcement so the sheet can be reviewed without waiting for a real
        // publish. Call it from the console any time, or let maps-app.js's
        // NR_DEMO_ON_LOAD fire it on every load while staging.
        //
        // The DATA IS REAL (Amravati and Beed as they stand in menuGIS, Mohol village
        // plans), so tapping a row genuinely flies the camera to the right place and
        // the whole flow can be checked end to end. It touches nothing but this
        // browser's localStorage — no RTDB, no layer file, no purchase state.
        //
        // Clears first rather than merging: a preview must show exactly what it
        // planted, not that plus whatever a real publish happened to leave behind.
        demo: function () {
            function place(label, lat, lng) {
                return { k: 'demo-' + label, l: label,
                         s: lat - PLACE_PAD, w: lng - PLACE_PAD,
                         n: lat + PLACE_PAD, e: lng + PLACE_PAD };
            }
            previewMode = true;
            dismissed = false;
            showingList = false;
            clear();
            console.warn('[newregions] PREVIEW MODE — these regions are planted, not a ' +
                         'real publish. Turn off NR_DEMO_ON_LOAD in maps-app.js before ' +
                         'promoting.');
            record({ overflow: 0, groups: [
                { layer: MENU_LAYER, groupId: 'AmaravatiMaharashtra', label: 'Amravati', pid: '',
                  entries: [place('Amravati', 20.935204, 77.752231),
                            place('Anjangaon Surji', 21.166780, 77.307860),
                            place('Warud, Dist: Amaravati', 21.467867, 78.267760)] },
                { layer: MENU_PLACE_LAYER, groupId: 'Beed', label: 'Beed', pid: '',
                  entries: [place('Beed Municipal Corporation', 18.988983, 75.753508),
                            place('Ambajogai Municipal Council', 18.728176, 76.388371)] },
                { layer: VILLAGE_LAYER, groupId: 'solapur/mohol', label: 'Mohol, Solapur', pid: '',
                  entries: [{ k: 'demo-Adhegaon', l: 'Adhegaon',
                              s: 17.72231, w: 75.53501, n: 17.77477, e: 75.58251 },
                            { k: 'demo-Ankoli', l: 'Ankoli',
                              s: 17.63931, w: 75.57581, n: 17.68705, e: 75.62832 }] }
            ] });
            revealPending();
        }
    };
})();
