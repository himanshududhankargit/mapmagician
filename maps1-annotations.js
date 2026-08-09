// maps1-annotations.js — "Annotate this map", ported from the Android app's
// annotations/ package (MapAnnotation / AnnotationLayer / AnnotationBitmaps /
// RoadStyle / editors / CaptureAnnotationPreview / TileStitchExporter.drawAnnotations).
//
// LAZY-LOADED: maps1-app.js injects this script on the FIRST tap of the Annotate
// pill, so nothing here runs at page start and start time is untouched. By the time
// this executes, the host globals (map, VertexHandleOverlay, showVertexHandle,
// showMagnifier, _dlmapToast, …) all exist — maps1-app.js is a classic top-level
// script, so its let/const/function names share this script's global scope.
//
// Storage schema is IDENTICAL to Android's AnnotationStore JSON (same keys, same
// signed-int colours), so a future RTDB sync can move records between platforms
// without migration.
//
// All drag interactions use Pointer Events (one code path for touch AND mouse),
// with touch-action:none + setPointerCapture; pinch works with two pointers, and
// mouse users get a wheel-resize plus a dedicated blue resize handle.
(function () {
    'use strict';
    if (window.mmAnnotations) return;

    // ---------------------------------------------------------------- constants
    var MAX_ANNOTATIONS = 300;          // AnnotationStore.MAX_ANNOTATIONS
    var NEARBY_METERS = 250000;         // AnnotationLayer.NEARBY_METERS
    var TEXT_BASE_PX = 20;              // AnnotationBitmaps.TEXT_BASE_SP
    var HALO_FRACTION = 0.15;
    var MAX_TEXT_PIXELS = 4000000;
    var CAPTION_SPAN_FRACTION = 0.8;
    var CAPTION_REFRESH_MS = 100;
    var ROAD_WIDTH = 11;                // RoadStyle.ROAD_WIDTH_DP (css px here)
    var DASH_PX = 20, GAP_PX = 15;      // centre-line rhythm
    var UNDO_DEPTH = 20;
    var MIN_TEXT_SCALE = 0.3, MAX_TEXT_SCALE = 6;
    var MAX_BORDER = 20, MAX_ROAD_WIDTH = 20;
    var MAX_STAMP_SUPERSAMPLE = 8;      // TileStitchExporter.MAX_STAMP_SUPERSAMPLE
    var EARTH_R = 6371009;              // android-maps-utils SphericalUtil radius

    var LS_ITEMS = 'mm_annotations_items';
    var LS_DRAFT = 'mm_annotations_draft';
    var LS_LAST_TOOL = 'mm_annotations_last_tool';

    // ------------------------------------------------------------ small helpers
    function rad(d) { return d * Math.PI / 180; }
    function deg(r) { return r * 180 / Math.PI; }

    // Signed 32-bit ARGB ints, exactly as Android stores them in the JSON.
    function argb(hex) { return (0xFF000000 | parseInt(hex.slice(1), 16)) | 0; }
    function cssColor(c) {
        return 'rgb(' + ((c >> 16) & 255) + ',' + ((c >> 8) & 255) + ',' + (c & 255) + ')';
    }
    function cssRgba(c, alpha) {
        return 'rgba(' + ((c >> 16) & 255) + ',' + ((c >> 8) & 255) + ',' + (c & 255) + ',' + alpha + ')';
    }
    // Uniform RGB scaling = scaling HSV's V while keeping H and S (RoadStyle.borderColor).
    function darkenInt(c, f) {
        var r = Math.round(((c >> 16) & 255) * f), g = Math.round(((c >> 8) & 255) * f), b = Math.round((c & 255) * f);
        return (0xFF000000 | (r << 16) | (g << 8) | b) | 0;
    }

    // SphericalUtil ports (matching android-maps-utils semantics).
    function sphDistance(p1, p2) {
        var dLat = rad(p2.lat - p1.lat), dLng = rad(p2.lng - p1.lng);
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(rad(p1.lat)) * Math.cos(rad(p2.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * EARTH_R;
    }
    function sphLength(points) {
        var t = 0;
        for (var i = 1; i < points.length; i++) t += sphDistance(points[i - 1], points[i]);
        return t;
    }
    function polarTriangleArea(tan1, lng1, tan2, lng2) {
        var dLng = lng1 - lng2, t = tan1 * tan2;
        return 2 * Math.atan2(t * Math.sin(dLng), 1 + t * Math.cos(dLng));
    }
    function sphArea(points) {
        if (points.length < 3) return 0;
        var total = 0;
        var prev = points[points.length - 1];
        var pTan = Math.tan((Math.PI / 2 - rad(prev.lat)) / 2), pLng = rad(prev.lng);
        for (var i = 0; i < points.length; i++) {
            var tan = Math.tan((Math.PI / 2 - rad(points[i].lat)) / 2), lng = rad(points[i].lng);
            total += polarTriangleArea(tan, lng, pTan, pLng);
            pTan = tan; pLng = lng;
        }
        return Math.abs(total * EARTH_R * EARTH_R);
    }
    function sphHeading(from, to) {
        var f1 = rad(from.lat), f2 = rad(to.lat), dl = rad(to.lng - from.lng);
        return deg(Math.atan2(Math.sin(dl) * Math.cos(f2),
            Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)));
    }
    function midOf(a, b) { return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }; }

    // Web-Mercator metres per CSS pixel (CSS px are the web's dp — no density term).
    function mpp(lat, zoom) {
        return 156543.03392 * Math.cos(rad(lat)) / Math.pow(2, zoom);
    }

    function fmtArea(sqm) {
        return sqm >= 10000 ? (sqm / 10000).toFixed(2) + ' ha'
                            : Math.round(sqm).toLocaleString('en-IN') + ' m²';
    }
    function fmtLength(m) {
        return m >= 1000 ? (m / 1000).toFixed(2) + ' km'
                         : Math.round(m).toLocaleString('en-IN') + ' m';
    }

    var _idCounter = 0;
    function newId() { return 'a' + Date.now() + '_' + (_idCounter++); }

    // Touch/pen primary input. Drives the "hold to move, don't drag by accident"
    // rules — a swipe starting on a pin must pan the map.
    function isCoarsePointer() {
        return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    }

    function toast(msg) {
        if (typeof _dlmapToast === 'function') { _dlmapToast(msg); return; }
        console.log('[annotations]', msg);
    }
    function mapDiv() { return document.getElementById('map'); }
    function vpH() { var d = mapDiv(); return d ? d.clientHeight : window.innerHeight; }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

    // ------------------------------------------------------------- ShapePalette
    var DEFAULT_AREA = argb('#F44336');
    var DEFAULT_ROAD = argb('#2196F3');
    var ROAD_BORDER_BLUE = argb('#1A237E');   // CalCall's indigo pairing for the default blue
    var PALETTE = [
        ['Blue', argb('#2196F3')], ['Red', argb('#F44336')], ['Green', argb('#4CAF50')],
        ['Orange', argb('#FF9800')], ['Purple', argb('#9C27B0')], ['Teal', argb('#009688')],
        ['Pink', argb('#E91E63')], ['Yellow', argb('#FFEB3B')]
    ];
    function roadBorderColor(surface) {
        return surface === DEFAULT_ROAD ? ROAD_BORDER_BLUE : darkenInt(surface, 0.45);
    }

    // ------------------------------------------------------------ MarkerCatalog
    // Same ids / names / categories / colours as Android's MarkerCatalog, so a pin
    // record is cross-platform. Icons are emoji on the white category-stroked disc
    // (the Android vector drawables aren't shippable as-is on the web).
    var CATEGORIES = [
        ['General', '#E53935'], ['Roads & Orientation', '#FB8C00'], ['Civic & Safety', '#F9A825'],
        ['Financial & Commercial', '#43A047'], ['Transport & Connectivity', '#1E88E5'],
        ['Education', '#8E24AA'], ['Government & Administrative', '#6D4C41'],
        ['Religious & Landmark', '#757575'], ['Utilities & Infrastructure', '#424242']
    ];
    var MARKER_TYPES = [
        ['pin', 'Pin', 0, '📍'], ['text_label', 'Label', 0, ''],
        ['plot_boundary', 'Plot', 0, '📐'], ['subject_property', 'Subject Property', 0, '🏠'],
        ['main_road', 'Main Road', 1, '🛣️'], ['internal_road', 'Internal Road', 1, '🚗'],
        ['highway', 'Highway', 1, '🚛'], ['junction', 'Junction / Chowk', 1, '➕'],
        ['hospital', 'Hospital', 2, '🏥'], ['clinic', 'Clinic', 2, '🩺'],
        ['police_station', 'Police Station', 2, '👮'], ['fire_station', 'Fire Station', 2, '🚒'],
        ['petrol_pump', 'Petrol Pump', 2, '⛽'],
        ['bank', 'Bank', 3, '🏦'], ['atm', 'ATM', 3, '🏧'],
        ['market', 'Market', 3, '🛒'], ['commercial_complex', 'Commercial Complex', 3, '🏬'],
        ['office_building', 'Office Building', 3, '🏢'],
        ['bus_stop', 'Bus Stop', 4, '🚌'], ['railway_station', 'Railway Station', 4, '🚉'],
        ['metro_station', 'Metro Station', 4, '🚇'], ['airport', 'Airport', 4, '✈️'],
        ['school', 'School', 5, '🏫'], ['college', 'College', 5, '🎓'],
        ['university', 'University', 5, '🏛️'], ['coaching_institute', 'Coaching Institute', 5, '📚'],
        ['municipal_corp', 'Municipal Corporation', 6, '🏛️'], ['collector_office', 'Collector Office', 6, '📋'],
        ['tehsil_office', 'Tehsil Office', 6, '🗂️'], ['court', 'Court', 6, '⚖️'],
        ['police_hq', 'Police HQ', 6, '🚔'],
        ['temple', 'Temple', 7, '🛕'], ['mosque', 'Mosque', 7, '🕌'],
        ['church', 'Church', 7, '⛪'], ['landmark', 'Landmark', 7, '🚩'],
        ['water_tank', 'Water Tank', 8, '💧'], ['electric_substation', 'Electric Substation', 8, '⚡'],
        ['drainage', 'Drainage / Nala', 8, '🌊'], ['industrial_area', 'Industrial Area', 8, '🏭'],
        ['warehouse', 'Warehouse', 8, '📦']
    ];
    var DEFAULT_TYPE_ID = 'pin', TEXT_LABEL_ID = 'text_label';
    var typeById = {};
    MARKER_TYPES.forEach(function (t) {
        typeById[t[0]] = { id: t[0], name: t[1], cat: t[2], emoji: t[3] };
    });
    function typeOf(id) { return typeById[id] || typeById[DEFAULT_TYPE_ID]; }

    // ----------------------------------------------------- bitmaps (canvas port)
    // Every annotation is drawn once into a canvas and used everywhere: as the live
    // map stamp, as the marker icon, and as the export stamp — one renderer is what
    // keeps the downloaded sheet identical to the screen (AnnotationBitmaps).
    // Canvases render at devicePixelRatio; {w,h} are the logical CSS dimensions.
    var bmpCache = new Map();
    function cachePut(key, v) {
        if (bmpCache.size > 80) bmpCache.delete(bmpCache.keys().next().value);
        bmpCache.set(key, v);
        return v;
    }
    function mkCanvas(w, h) {
        var dpr = Math.min(window.devicePixelRatio || 1, 3);
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * dpr));
        c.height = Math.max(1, Math.round(h * dpr));
        var ctx = c.getContext('2d');
        ctx.scale(dpr, dpr);
        return { c: c, ctx: ctx };
    }
    var _measureCtx = document.createElement('canvas').getContext('2d');
    function fontMetrics(sizePx) {
        _measureCtx.font = 'bold ' + sizePx + 'px sans-serif';
        var m = _measureCtx.measureText('Mg');
        var asc = m.fontBoundingBoxAscent || sizePx * 0.9;
        var desc = m.fontBoundingBoxDescent || sizePx * 0.25;
        return { asc: asc, desc: desc, lineH: asc + desc };
    }
    function measureWidest(lines, sizePx) {
        _measureCtx.font = 'bold ' + sizePx + 'px sans-serif';
        var w = 0;
        for (var i = 0; i < lines.length; i++) w = Math.max(w, _measureCtx.measureText(lines[i]).width);
        return w;
    }

    // White bold lettering with a black halo — writing on the plan, no plate.
    function textBitmap(text, scale, centered) {
        var key = 't|' + scale + '|' + centered + '|' + text;
        if (bmpCache.has(key)) return bmpCache.get(key);
        var lines = (text === '' ? ' ' : text).split('\n');
        var size = TEXT_BASE_PX * scale;
        var halo = size * HALO_FRACTION;
        var fm = fontMetrics(size);
        var widest = measureWidest(lines, size);
        var area = (widest + halo * 2) * (fm.lineH * lines.length + halo * 2);
        if (area > MAX_TEXT_PIXELS) {           // shrink rather than clip (looks like data loss)
            size *= Math.sqrt(MAX_TEXT_PIXELS / area);
            halo = size * HALO_FRACTION;
            fm = fontMetrics(size);
            widest = measureWidest(lines, size);
        }
        var w = Math.max(1, widest + halo * 2), h = Math.max(1, fm.lineH * lines.length + halo * 2);
        var k = mkCanvas(w, h), ctx = k.ctx;
        ctx.font = 'bold ' + size + 'px sans-serif';
        ctx.lineJoin = 'round';
        ctx.lineWidth = halo;
        ctx.strokeStyle = '#000';
        ctx.fillStyle = '#fff';
        for (var i = 0; i < lines.length; i++) {
            var lw = _measureCtx.measureText(lines[i]).width;
            var x = centered ? halo + (widest - lw) / 2 : halo;
            var y = fm.asc + halo + fm.lineH * i;
            ctx.strokeText(lines[i], x, y);      // halo first, fill on top
            ctx.fillText(lines[i], x, y);
        }
        return cachePut(key, { canvas: k.c, w: w, h: h });
    }

    function wrapLabel(text, maxChars) {
        var out = [];
        text.split('\n').forEach(function (seg) {
            if (seg.length <= maxChars) { out.push(seg); return; }
            var line = '';
            seg.split(' ').forEach(function (word) {
                if (!line) line = word;
                else if (line.length + 1 + word.length <= maxChars) line += ' ' + word;
                else { out.push(line); line = word; }
            });
            if (line) out.push(line);
        });
        return out.length ? out : [text];
    }

    // Category icon disc + captioned white plate (AnnotationBitmaps.pin).
    function pinBitmap(type, label, scale) {
        var s = scale || 1;
        var key = 'p|' + type.id + '|' + s + '|' + label;
        if (bmpCache.has(key)) return bmpCache.get(key);
        var iconSize = 36 * s, pad = 4 * s, textPad = 3 * s;
        var labelOnly = type.id === TEXT_LABEL_ID;
        var fontSize = 12 * s;
        var lines = wrapLabel((label || type.name), 22);
        var fm = fontMetrics(fontSize);
        var widest = measureWidest(lines, fontSize);
        var plateH = fm.lineH * lines.length + textPad * 2;
        var iconBlock = labelOnly ? 0 : iconSize + 2 * s;
        var w = Math.max(iconSize + pad * 2, widest + textPad * 2 + pad * 2);
        var h = pad + iconBlock + plateH + pad;
        var k = mkCanvas(w, h), ctx = k.ctx;
        if (!labelOnly) {
            var cat = CATEGORIES[type.cat];
            var cx = w / 2, cy = pad + iconSize / 2, r = iconSize / 2 - 1.5 * s;
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = '#fff'; ctx.fill();
            ctx.lineWidth = 2.5 * s; ctx.strokeStyle = cat[1]; ctx.stroke();
            ctx.font = (iconSize * 0.52) + 'px sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = '#333';
            ctx.fillText(type.emoji, cx, cy + 1 * s);
        }
        var plateTop = pad + iconBlock;
        var px0 = (w - widest) / 2 - textPad, px1 = (w + widest) / 2 + textPad;
        var radius = 4 * s;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(px0, plateTop, px1 - px0, plateH, radius);
        else ctx.rect(px0, plateTop, px1 - px0, plateH);
        ctx.fillStyle = '#fff'; ctx.fill();
        ctx.lineWidth = 1 * s; ctx.strokeStyle = '#CCCCCC'; ctx.stroke();
        ctx.font = 'bold ' + fontSize + 'px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#333333';
        for (var i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], w / 2, plateTop + textPad + fm.asc + fm.lineH * i);
        }
        return cachePut(key, { canvas: k.c, w: w, h: h });
    }

    // The road's name on an OPAQUE pill in the road's own surface colour: it sits
    // on the band and covers the dashed centre line beneath it, so the dashes can
    // never strike through the lettering (owner report, 2026-08-09).
    function roadLabelBitmap(text, scale, colorInt) {
        var s = scale || 1;
        var color = typeof colorInt === 'number' ? colorInt : DEFAULT_ROAD;
        var key = 'r|' + s + '|' + color + '|' + text;
        if (bmpCache.has(key)) return bmpCache.get(key);
        var size = 11.5 * s, padH = 6 * s, padV = 2.5 * s;
        var fm = fontMetrics(size);
        _measureCtx.font = 'bold ' + size + 'px sans-serif';
        var w = Math.max(1, _measureCtx.measureText(text).width + padH * 2);
        var h = Math.max(1, fm.lineH + padV * 2);
        var k = mkCanvas(w, h), ctx = k.ctx;
        var r = h / 2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(0.5 * s, 0.5 * s, w - s, h - s, r);
        else ctx.rect(0.5 * s, 0.5 * s, w - s, h - s);
        ctx.fillStyle = cssColor(color);
        ctx.fill();
        ctx.lineWidth = 1 * s;
        ctx.strokeStyle = cssColor(roadBorderColor(color));
        ctx.stroke();
        ctx.font = 'bold ' + size + 'px sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillText(text, padH, padV + fm.asc);
        return cachePut(key, { canvas: k.c, w: w, h: h });
    }

    // Where a pin touches the ground: the centre of the icon disc (pinAnchorV).
    function pinAnchorV(type, bmp) {
        if (type.id === TEXT_LABEL_ID || bmp.h <= 0) return 0.5;
        return Math.min(1, Math.max(0, (4 + 18) / bmp.h));
    }

    // ------------------------------------------------------------ model helpers
    function centroidOf(points) {
        if (!points.length) return { lat: 0, lng: 0 };
        var lat = 0, lng = 0;
        points.forEach(function (p) { lat += p.lat; lng += p.lng; });
        return { lat: lat / points.length, lng: lng / points.length };
    }
    // Centroid of the enclosed AREA, not of the corner list (MapAnnotation.areaCentroidOf).
    function areaCentroidOf(points) {
        if (points.length < 3) return centroidOf(points);
        var twiceArea = 0, x = 0, y = 0;
        for (var i = 0; i < points.length; i++) {
            var a = points[i], b = points[(i + 1) % points.length];
            var cross = a.lng * b.lat - b.lng * a.lat;
            twiceArea += cross;
            x += (a.lng + b.lng) * cross;
            y += (a.lat + b.lat) * cross;
        }
        if (Math.abs(twiceArea) < 1e-12) return centroidOf(points);
        return { lat: y / (3 * twiceArea), lng: x / (3 * twiceArea) };
    }
    function anchorOf(a) {
        if (a.kind === 'text' || a.kind === 'pin') return { lat: a.lat, lng: a.lng };
        return centroidOf(a.points);
    }
    function displayName(a) {
        if (a.kind === 'text') {
            var first = (a.text || '').split('\n')[0].trim();
            return first || 'Text';
        }
        if (a.kind === 'pin') return (a.label || '').trim() || typeOf(a.typeId).name;
        if (a.kind === 'area') return (a.label || '').trim() || 'Region';
        return (a.label || '').trim() || 'Road';
    }
    function captionAnchor(a) {
        return (a.labelLat != null && a.labelLng != null)
            ? { lat: a.labelLat, lng: a.labelLng } : areaCentroidOf(a.points);
    }
    function areaSqm(a) { return a.points.length >= 3 ? sphArea(a.points) : 0; }
    function roadLen(a) { return a.points.length >= 2 ? sphLength(a.points) : 0; }

    // ------------------------------------------------------------------- store
    // One JSON array, Android's exact record shapes (AnnotationStore).
    function storeLoad() {
        var raw = lsGet(LS_ITEMS);
        if (!raw) return [];
        var out = [];
        try {
            var arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            arr.forEach(function (o, i) {
                if (!o || typeof o !== 'object') return;
                var base = {
                    id: o.id || newId(),
                    visible: o.visible !== false,
                    order: typeof o.order === 'number' ? o.order : i
                };
                if (o.kind === 'text' && isFinite(o.lat) && isFinite(o.lng)) {
                    out.push(Object.assign(base, {
                        kind: 'text', lat: o.lat, lng: o.lng, text: String(o.text || ''),
                        scale: numOr(o.scale, 1.5), rotation: numOr(o.rotation, 0),
                        centered: !!o.centered, placementZoom: numOr(o.placementZoom, 17)
                    }));
                } else if (o.kind === 'pin' && isFinite(o.lat) && isFinite(o.lng)) {
                    out.push(Object.assign(base, {
                        kind: 'pin', lat: o.lat, lng: o.lng,
                        typeId: o.typeId || DEFAULT_TYPE_ID, label: String(o.label || '')
                    }));
                } else if (o.kind === 'area') {
                    var pts = readPoints(o.points);
                    if (pts.length < 3) return;
                    out.push(Object.assign(base, {
                        kind: 'area', points: pts, label: String(o.label || ''),
                        color: intOr(o.color, DEFAULT_AREA),
                        borderColor: intOr(o.borderColor, intOr(o.color, DEFAULT_AREA)),
                        fillOpacity: numOr(o.fillOpacity, 0.25),
                        borderWidthDp: numOr(o.borderWidthDp, 3),
                        showArea: o.showArea !== false, showLabel: o.showLabel !== false,
                        labelZoom: numOr(o.labelZoom, 17),
                        labelLat: isFinite(o.labelLat) ? o.labelLat : null,
                        labelLng: isFinite(o.labelLng) ? o.labelLng : null,
                        labelScale: numOr(o.labelScale, 1.1), labelRotation: numOr(o.labelRotation, 0)
                    }));
                } else if (o.kind === 'road') {
                    var rp = readPoints(o.points);
                    if (rp.length < 2) return;
                    out.push(Object.assign(base, {
                        kind: 'road', points: rp, label: String(o.label || ''),
                        color: intOr(o.color, DEFAULT_ROAD), widthDp: numOr(o.widthDp, 6),
                        showLabel: o.showLabel !== false, showLength: o.showLength !== false,
                        labelZoom: numOr(o.labelZoom, 17)
                    }));
                }
            });
        } catch (e) { return []; }   // corrupt blob: start clean rather than break the map
        out.sort(function (a, b) { return a.order - b.order; });
        return out;
    }
    function numOr(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
    function intOr(v, d) { return typeof v === 'number' && isFinite(v) ? (v | 0) : d; }
    function readPoints(arr) {
        var out = [];
        if (Array.isArray(arr)) arr.forEach(function (p) {
            if (p && isFinite(p.lat) && isFinite(p.lng)) out.push({ lat: p.lat, lng: p.lng });
        });
        return out;
    }
    function storeSave(list) {
        var arr = list.slice(0, MAX_ANNOTATIONS).map(function (a) {
            var o = { id: a.id, visible: a.visible, order: a.order, kind: a.kind };
            if (a.kind === 'text') {
                o.lat = a.lat; o.lng = a.lng; o.text = a.text; o.scale = a.scale;
                o.rotation = a.rotation; o.centered = a.centered; o.placementZoom = a.placementZoom;
            } else if (a.kind === 'pin') {
                o.lat = a.lat; o.lng = a.lng; o.typeId = a.typeId; o.label = a.label;
            } else if (a.kind === 'area') {
                o.points = a.points; o.label = a.label; o.color = a.color; o.borderColor = a.borderColor;
                o.fillOpacity = a.fillOpacity; o.borderWidthDp = a.borderWidthDp;
                o.showArea = a.showArea; o.showLabel = a.showLabel; o.labelZoom = a.labelZoom;
                o.labelScale = a.labelScale; o.labelRotation = a.labelRotation;
                if (a.labelLat != null) { o.labelLat = a.labelLat; o.labelLng = a.labelLng; }
            } else {
                o.points = a.points; o.label = a.label; o.color = a.color; o.widthDp = a.widthDp;
                o.showLabel = a.showLabel; o.showLength = a.showLength; o.labelZoom = a.labelZoom;
            }
            return o;
        });
        var payload = JSON.stringify(arr);
        lsSet(LS_ITEMS, payload);
        return payload;
    }
    // A drawing the user walked away from — kept, offered back, never auto-deleted.
    function draftSave(kind, points) {
        if (!points.length) { draftClear(); return; }
        lsSet(LS_DRAFT, JSON.stringify({ kind: kind, points: points, savedAt: Date.now() }));
    }
    function draftLoad() {
        var raw = lsGet(LS_DRAFT);
        if (!raw) return null;
        try {
            var o = JSON.parse(raw);
            var pts = readPoints(o.points);
            return pts.length ? { kind: o.kind === 'road' ? 'road' : 'area', points: pts, savedAt: o.savedAt } : null;
        } catch (e) { return null; }
    }
    function draftClear() { lsDel(LS_DRAFT); }

    // -------------------------------------------------------------- overlays
    // GroundStamp: a bitmap pinned to the ground — width is METRES, so it grows and
    // shrinks with the terrain, rotates via CSS. This is the web's GroundOverlay
    // replacement (the Maps JS GroundOverlay cannot rotate). Sizing is measured from
    // the live projection, so it stays glued to the tiles through zoom animations.
    var GroundStamp, ScreenStamp;
    function defineOverlayClasses() {
        if (GroundStamp) return;
        GroundStamp = function (o) {
            this.o = o;                       // {lat, lng, bmp, widthMeters, rotation, z, anchorU, anchorV, onTap}
            this._div = null; this._img = null; this._key = null;
            this.shown = o.shown !== false;
            this.setMap(map);
        };
        GroundStamp.prototype = Object.create(google.maps.OverlayView.prototype);
        GroundStamp.prototype.onAdd = function () {
            var self = this;
            var d = document.createElement('div');
            d.className = 'ann-stamp';
            d.style.zIndex = String(Math.round(this.o.z || 0));
            var img = document.createElement('img');
            img.draggable = false;
            img.alt = '';
            d.appendChild(img);
            this._div = d; this._img = img;
            this._syncImage();
            if (this.o.onTap) {
                d.classList.add('ann-tappable');
                d.addEventListener('click', function (e) { e.stopPropagation(); self.o.onTap(); });
            }
            this.getPanes().overlayMouseTarget.appendChild(d);
        };
        GroundStamp.prototype._syncImage = function () {
            var bmp = this.o.bmp;
            if (!bmp || !this._img) return;
            if (this._key !== bmp.canvas) {
                this._key = bmp.canvas;
                this._img.src = bmp.canvas.toDataURL();
            }
        };
        GroundStamp.prototype.update = function (patch) {
            Object.assign(this.o, patch);
            this._syncImage();
            if (this._div) {
                if (patch && 'z' in patch) this._div.style.zIndex = String(Math.round(this.o.z || 0));
                this.draw();
            }
        };
        GroundStamp.prototype.setShown = function (v) {
            this.shown = v;
            if (!this._div) return;
            if (v) this.draw();                    // re-place before it becomes visible
            else this._div.style.display = 'none';
        };
        GroundStamp.prototype.draw = function () {
            var proj = this.getProjection();
            if (!proj || !this._div) return;
            var o = this.o;
            var ll = new google.maps.LatLng(o.lat, o.lng);
            var p = proj.fromLatLngToDivPixel(ll);
            if (!p) return;
            var dLng = 0.0001;
            var p2 = proj.fromLatLngToDivPixel(new google.maps.LatLng(o.lat, o.lng + dLng));
            var metersPerDeg = 111319.4908 * Math.cos(rad(o.lat));
            var pxPerMeter = p2 ? Math.abs(p2.x - p.x) / (dLng * metersPerDeg) : 0;
            var w = o.widthMeters * pxPerMeter;
            if (!isFinite(w) || w < 1 || !this.shown) { this._div.style.display = 'none'; return; }
            var bmp = o.bmp;
            var u = o.anchorU != null ? o.anchorU : 0.5;
            var v = o.anchorV != null ? o.anchorV : 0.5;
            this._div.style.display = '';
            this._div.style.left = p.x + 'px';
            this._div.style.top = p.y + 'px';
            this._div.style.width = w + 'px';
            this._div.style.height = (w * bmp.h / bmp.w) + 'px';
            this._div.style.transform =
                'translate(' + (-u * 100) + '%,' + (-v * 100) + '%) rotate(' + (o.rotation || 0) + 'deg)';
        };
        GroundStamp.prototype.onRemove = function () {
            if (this._div && this._div.parentNode) this._div.parentNode.removeChild(this._div);
            this._div = null; this._img = null;
        };

        // ScreenStamp: a bitmap pinned to the SCREEN (fixed CSS size), rotated to lie
        // along its road segment, shown only while that segment can hold it — the road
        // caption treatment (CalCall's per-segment lettering).
        ScreenStamp = function (o) {
            this.o = o;                       // {lat, lng, bmp, rotation, z, lengthMeters, onTap}
            this._div = null; this._img = null; this._key = null;
            this.shown = true;
            this.setMap(map);
        };
        ScreenStamp.prototype = Object.create(google.maps.OverlayView.prototype);
        ScreenStamp.prototype.onAdd = function () {
            var self = this;
            var d = document.createElement('div');
            d.className = 'ann-stamp';
            d.style.zIndex = String(Math.round(this.o.z || 0));
            var img = document.createElement('img');
            img.draggable = false;
            img.alt = '';
            d.appendChild(img);
            this._div = d; this._img = img;
            this._sync();
            if (this.o.onTap) {
                d.classList.add('ann-tappable');
                d.addEventListener('click', function (e) { e.stopPropagation(); self.o.onTap(); });
            }
            this.getPanes().overlayMouseTarget.appendChild(d);
        };
        ScreenStamp.prototype._sync = function () {
            var bmp = this.o.bmp;
            if (!bmp || !this._img) return;
            if (this._key !== bmp.canvas) {
                this._key = bmp.canvas;
                this._img.src = bmp.canvas.toDataURL();
            }
        };
        ScreenStamp.prototype.update = function (patch) {
            Object.assign(this.o, patch);
            this._sync();
            if (this._div) {
                if (patch && 'z' in patch) this._div.style.zIndex = String(Math.round(this.o.z || 0));
                this.draw();
            }
        };
        ScreenStamp.prototype.setShown = function (v) {
            this.shown = v;
            if (this._div) this.draw();
        };
        ScreenStamp.prototype.draw = function () {
            var proj = this.getProjection();
            if (!proj || !this._div) return;
            var o = this.o;
            var p = proj.fromLatLngToDivPixel(new google.maps.LatLng(o.lat, o.lng));
            if (!p) return;
            var fits = true;
            if (o.lengthMeters != null) {       // segment must be long enough on screen
                var dLng = 0.0001;
                var p2 = proj.fromLatLngToDivPixel(new google.maps.LatLng(o.lat, o.lng + dLng));
                var pxPerMeter = p2 ? Math.abs(p2.x - p.x) / (dLng * 111319.4908 * Math.cos(rad(o.lat))) : 0;
                fits = o.lengthMeters * pxPerMeter > o.bmp.w;
            }
            if (!this.shown || !fits) { this._div.style.display = 'none'; return; }
            this._div.style.display = '';
            this._div.style.left = p.x + 'px';
            this._div.style.top = p.y + 'px';
            this._div.style.width = o.bmp.w + 'px';
            this._div.style.height = o.bmp.h + 'px';
            this._div.style.transform = 'translate(-50%,-50%) rotate(' + (o.rotation || 0) + 'deg)';
        };
        ScreenStamp.prototype.onRemove = function () {
            if (this._div && this._div.parentNode) this._div.parentNode.removeChild(this._div);
            this._div = null; this._img = null;
        };
    }

    // A hidden OverlayView that lends its projection for container-pixel <-> LatLng
    // conversions (the text placement surface needs them; the Maps JS map object
    // does not expose a projection directly).
    var projHelper = null;
    function ensureProjHelper() {
        if (projHelper) return;
        function P() { this.setMap(map); }
        P.prototype = Object.create(google.maps.OverlayView.prototype);
        P.prototype.onAdd = function () {};
        P.prototype.draw = function () {};
        P.prototype.onRemove = function () {};
        projHelper = new P();
    }
    function containerPxToLatLng(x, y) {
        var proj = projHelper && projHelper.getProjection();
        if (!proj) return map.getCenter();
        var ll = proj.fromContainerPixelToLatLng(new google.maps.Point(x, y));
        return ll || map.getCenter();
    }
    function latLngToContainerPx(lat, lng) {
        var proj = projHelper && projHelper.getProjection();
        if (!proj) return null;
        return proj.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng));
    }

    // ------------------------------------------------------- road band (RoadStyle)
    function roadLayers(colorInt, widthPx) {
        return [
            { color: cssColor(roadBorderColor(colorInt)), w: widthPx, dash: false },
            { color: '#FFFFFF', w: widthPx * 26 / 30, dash: false },
            { color: cssColor(colorInt), w: widthPx * 22 / 30, dash: false },
            { color: '#FFFFFF', w: Math.max(widthPx * 3 / 30, 2), dash: true }
        ];
    }
    function polylineOptsFor(layer, points, z, dashScale) {
        var o = {
            path: points, strokeColor: layer.color, strokeWeight: layer.w,
            zIndex: z, clickable: false, map: map
        };
        if (layer.dash) {
            // Dashes via a repeated symbol: path 'M 0,-1 0,1' spans 2 units, so
            // scale 10 = a 20px dash; repeat 35px leaves the 15px gap (RoadStyle).
            var s = dashScale || 1;
            o.strokeOpacity = 0;
            o.icons = [{
                icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: layer.color, strokeWeight: layer.w, scale: (DASH_PX / 2) * s },
                offset: '0', repeat: ((DASH_PX + GAP_PX) * s) + 'px'
            }];
        }
        return o;
    }

    // ---------------------------------------------------------------- the layer
    // AnnotationLayer port: owns the model, the map objects, stacking order, the
    // export stamps and the capture stand-ins.
    var Z_BASE = 50002, Z_STEP = 3, Z_CAPTION = 61000;
    var layer = {
        handles: new Map(),        // id -> handle
        dormant: [],               // other regions' notes, written back untouched
        restored: false,
        suspended: false,          // true while the capture viewfinder owns the screen
        lastZoom: 15,
        lastCaptionRefresh: 0,

        annotations: function () {
            var out = [];
            this.handles.forEach(function (h) { out.push(h.a); });
            return out;
        },
        ordered: function () {
            return this.annotations().sort(function (a, b) { return a.order - b.order; });
        },
        isFull: function () { return this.handles.size + this.dormant.length >= MAX_ANNOTATIONS; },

        // Notes are scoped by geography: a Solapur plan never opens carrying Pune's
        // lettering. Lazy — only the first idle over real ground counts.
        restoreIfNeeded: function (zoom, centre) {
            if (this.restored) return;
            if (!centre || (centre.lat === 0 && centre.lng === 0)) return;
            this.restored = true;
            var self = this;
            var nearby = [];
            storeLoad().forEach(function (a) {
                if (sphDistance(centre, anchorOf(a)) <= NEARBY_METERS) nearby.push(a);
                else self.dormant.push(a);
            });
            if (histSuppress) {
                // An undo/redo rebuild reproduces the state directly — no prompt.
                nearby.forEach(function (a) { self.attach(a); });
            } else if (nearby.length) {
                // Previous work is OFFERED, not imposed (owner request). Until the
                // user decides, the items ride in dormant so any persist() writes
                // them back — declining must never be able to lose them.
                nearby.forEach(function (a) { self.dormant.push(a); });
                restoreOffer = nearby;
                // Deferred a tick so it lands ON TOP of whatever the user opened
                // (the annotate sheet or the dock), not instead of it.
                setTimeout(offerPreviousAnnotations, 0);
            }
            this.renumber();
            this.applyZoom(zoom);
            histPush(lsGet(LS_ITEMS) || '[]');   // undo's floor: the state as restored
        },

        add: function (a) {
            var maxOrder = -1;
            this.handles.forEach(function (h) { maxOrder = Math.max(maxOrder, h.a.order); });
            a.order = maxOrder + 1;
            this.attach(a);
            this.applyZoom(this.lastZoom);
            this.persist();
        },
        update: function (a) {
            var h = this.handles.get(a.id);
            if (!h) return;
            this.detach(h);
            var nh = this.mkHandle(a);
            this.handles.set(a.id, nh);
            this.build(nh);
            this.applyOrder();
            this.applyZoom(this.lastZoom);
            this.persist();
        },
        remove: function (id) {
            var h = this.handles.get(id);
            if (h) { this.handles.delete(id); this.detach(h); }
            this.renumber();
            this.persist();
        },
        clearAll: function () {
            var self = this;
            this.handles.forEach(function (h) { self.detach(h); });
            this.handles.clear();
            this.persist();
        },
        find: function (id) {
            var h = this.handles.get(id);
            return h ? h.a : null;
        },
        setVisible: function (id, visible) {
            var h = this.handles.get(id);
            if (!h) return;
            h.a.visible = visible;
            this.applyZoom(this.lastZoom);
            this.persist();
        },
        applyStackOrder: function (idsTopFirst) {
            var self = this;
            idsTopFirst.slice().reverse().forEach(function (id, index) {
                var h = self.handles.get(id);
                if (h) h.a.order = index;
            });
            this.applyOrder();
            this.persist();
        },
        renumber: function () {
            this.ordered().forEach(function (a, i) { a.order = i; });
            this.applyOrder();
        },
        persist: function () {
            var payload = storeSave(
                this.annotations().sort(function (a, b) { return a.order - b.order; }).concat(this.dormant));
            histPush(payload);
            refreshOpenPanels();
        },

        mkHandle: function (a) {
            return { a: a, marker: null, stamp: null, captionStamps: [], polygon: null, polylines: [] };
        },
        attach: function (a) {
            if (this.handles.size + this.dormant.length >= MAX_ANNOTATIONS) return;
            var h = this.mkHandle(a);
            this.handles.set(a.id, h);
            this.build(h);
            this.applyOrder();
        },

        build: function (h) {
            var a = h.a, self = this;
            if (a.kind === 'text') {
                var bmp = textBitmap(a.text, a.scale, a.centered);
                h.stamp = new GroundStamp({
                    lat: a.lat, lng: a.lng, bmp: bmp,
                    widthMeters: bmp.w * mpp(a.lat, a.placementZoom),
                    rotation: a.rotation, z: Z_CAPTION + a.order * Z_STEP,
                    shown: false,
                    onTap: function () { openOptions(a); }
                });
            } else if (a.kind === 'pin') {
                var type = typeOf(a.typeId);
                var pb = pinBitmap(type, displayName(a), 1);
                h.marker = new google.maps.Marker({
                    position: { lat: a.lat, lng: a.lng }, map: map,
                    icon: {
                        url: pb.canvas.toDataURL(),
                        scaledSize: new google.maps.Size(pb.w, pb.h),
                        anchor: new google.maps.Point(pb.w / 2, pinAnchorV(type, pb) * pb.h)
                    },
                    // Touch: NOT draggable — a swipe that starts on a pin must pan
                    // the map, not carry the pin off. A long press raises the move
                    // disc instead (below), which is also the precise way to place
                    // it. Mouse keeps direct dragging.
                    draggable: !isCoarsePointer(),
                    clickable: true, visible: false,
                    zIndex: 100000 + a.order, title: displayName(a)
                });
                var pressTimer = null, longPressed = false;
                function cancelPress() {
                    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
                }
                h.marker.addListener('mousedown', function () {
                    if (!isCoarsePointer()) return;
                    longPressed = false;
                    cancelPress();
                    pressTimer = setTimeout(function () {
                        pressTimer = null;
                        longPressed = true;
                        try { if (navigator.vibrate) navigator.vibrate(20); } catch (e) {}
                        showPinMoveHandle(h, a);
                    }, 450);
                });
                h.marker.addListener('mouseup', cancelPress);
                h.marker.addListener('mouseout', cancelPress);
                h.marker.addListener('click', function () {
                    cancelPress();
                    if (longPressed) { longPressed = false; return; }   // the hold owned it
                    openOptions(a);
                });
                h.marker.addListener('drag', function () {
                    var p = h.marker.getPosition();
                    a.lat = p.lat(); a.lng = p.lng();
                });
                h.marker.addListener('dragend', function () {
                    var p = h.marker.getPosition();
                    a.lat = p.lat(); a.lng = p.lng();
                    self.persist();
                });
            } else if (a.kind === 'area') {
                h.polygon = new google.maps.Polygon({
                    paths: a.points, map: map,
                    strokeColor: cssColor(a.borderColor), strokeWeight: a.borderWidthDp,
                    fillColor: cssColor(a.color), fillOpacity: a.fillOpacity,
                    zIndex: Z_BASE + a.order * Z_STEP, clickable: true, visible: false
                });
                h.polygon.addListener('click', function () { openOptions(a); });
                this.buildShapeLabel(h);
            } else if (a.kind === 'road') {
                var layers = roadLayers(a.color, a.widthDp);
                var z = Z_BASE + a.order * Z_STEP;
                h.polylines = layers.map(function (l, i) {
                    var o = polylineOptsFor(l, a.points, z + 1 + i * 0.2, 1);
                    o.visible = false;
                    o.clickable = (i === 0);       // the widest stripe answers taps
                    var pl = new google.maps.Polyline(o);
                    if (i === 0) pl.addListener('click', function () { openOptions(a); });
                    return pl;
                });
                this.buildRoadCaptions(h);
            }
        },
        detach: function (h) {
            if (h.marker) { h.marker.setMap(null); h.marker = null; }
            if (h.stamp) { h.stamp.setMap(null); h.stamp = null; }
            h.captionStamps.forEach(function (s) { s.setMap(null); });
            h.captionStamps = [];
            if (h.polygon) { h.polygon.setMap(null); h.polygon = null; }
            h.polylines.forEach(function (p) { p.setMap(null); });
            h.polylines = [];
        },

        applyOrder: function () {
            var self = this;
            this.handles.forEach(function (h) {
                var a = h.a, z = Z_BASE + a.order * Z_STEP;
                if (h.polygon) h.polygon.setOptions({ zIndex: z });
                h.polylines.forEach(function (p, i) { p.setOptions({ zIndex: z + 1 + i * 0.2 }); });
                if (h.stamp) h.stamp.update({ z: Z_CAPTION + a.order * Z_STEP });
                if (h.marker) h.marker.setZIndex(100000 + a.order);
            });
        },

        // The visibility rules, re-asserted from the model on every pass.
        applyZoom: function (zoom) {
            this.lastZoom = zoom;
            if (this.suspended) return;
            var self = this;
            this.handles.forEach(function (h) {
                var a = h.a, shown = a.visible;
                if (h.polygon) h.polygon.setVisible(shown);
                h.polylines.forEach(function (p) { p.setVisible(shown); });
                if (a.kind === 'text' && h.stamp) {
                    h.stamp.update({
                        lat: a.lat, lng: a.lng, rotation: a.rotation,
                        widthMeters: h.stamp.o.bmp.w * mpp(a.lat, a.placementZoom)
                    });
                    h.stamp.setShown(shown);
                }
                if (a.kind === 'pin' && h.marker) h.marker.setVisible(shown);
                if (a.kind === 'area' && h.stamp) h.stamp.setShown(shown);
                if (a.kind === 'road') {
                    h.captionStamps.forEach(function (s) { s.setShown(shown); });
                }
            });
            this.rebuildUnplacedCaptions();
        },

        // A caption on a shape still being drawn is sized against the live camera.
        rebuildUnplacedCaptions: function () {
            var self = this;
            this.handles.forEach(function (h) {
                if (h.a.kind !== 'area' || h.a.labelZoom > 0) return;
                self.buildShapeLabel(h);
                if (h.stamp) h.stamp.setShown(h.a.visible && !self.suspended);
            });
        },

        captionZoom: function (labelZoom) { return labelZoom > 0 ? labelZoom : this.lastZoom; },

        shortestSpanMetres: function (points) {
            if (points.length < 3) return 0;
            var south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
            points.forEach(function (p) {
                south = Math.min(south, p.lat); north = Math.max(north, p.lat);
                west = Math.min(west, p.lng); east = Math.max(east, p.lng);
            });
            var midLat = (south + north) / 2;
            var w = sphDistance({ lat: midLat, lng: west }, { lat: midLat, lng: east });
            var hgt = sphDistance({ lat: south, lng: west }, { lat: north, lng: west });
            return Math.min(w, hgt);
        },

        // {bmp, position, widthMeters, bearing, render} for an area's caption — the
        // same white-on-halo lettering as free text, clamped to the shape it names.
        shapeLabel: function (a) {
            if (a.kind !== 'area') return null;
            var caption = '';
            if (a.showLabel) caption = (a.label || '').trim();
            if (a.showArea && a.points.length >= 3) {
                caption += (caption ? '\n' : '') + fmtArea(areaSqm(a));
            }
            if (!caption || a.points.length < 3) return null;
            var bmp = textBitmap(caption, a.labelScale, true);
            var centre = captionAnchor(a);
            var natural = bmp.w * mpp(centre.lat, this.captionZoom(a.labelZoom));
            var span = this.shortestSpanMetres(a.points);
            var widthMeters = span <= 0 ? natural : Math.min(natural, span * CAPTION_SPAN_FRACTION);
            if (widthMeters <= 0) return null;
            return {
                bmp: bmp, position: centre, widthMeters: widthMeters, bearing: a.labelRotation,
                render: function (s) { return textBitmap(caption, a.labelScale * s, true); }
            };
        },
        buildShapeLabel: function (h) {
            var a = h.a;
            var label = this.shapeLabel(a);
            if (!label) {
                if (h.stamp) { h.stamp.setMap(null); h.stamp = null; }
                return;
            }
            if (h.stamp) {
                h.stamp.update({
                    lat: label.position.lat, lng: label.position.lng, bmp: label.bmp,
                    widthMeters: label.widthMeters, rotation: label.bearing
                });
            } else {
                h.stamp = new GroundStamp({
                    lat: label.position.lat, lng: label.position.lng, bmp: label.bmp,
                    widthMeters: label.widthMeters, rotation: label.bearing,
                    z: Z_CAPTION + a.order * Z_STEP, shown: false,
                    onTap: function () { openOptions(a); }
                });
            }
        },

        // Road captions: the name + length, once per segment that can hold it.
        roadCaptionText: function (a) {
            var t = '';
            if (a.showLabel) t = (a.label || '').trim();
            if (a.showLength && a.points.length >= 2) {
                t += (t ? ' · ' : '') + fmtLength(roadLen(a));
            }
            return t;
        },
        roadCaptionSpots: function (a) {
            var spots = [];
            for (var i = 0; i < a.points.length - 1; i++) {
                var s = a.points[i], e = a.points[i + 1];
                var bearing = sphHeading(s, e) - 90;
                if (bearing < -90) bearing += 180;
                if (bearing > 90) bearing -= 180;
                spots.push({ position: midOf(s, e), bearing: bearing, lengthMeters: sphDistance(s, e) });
            }
            return spots;
        },
        buildRoadCaptions: function (h) {
            var a = h.a, self = this;
            var caption = this.roadCaptionText(a);
            if (!caption) return;
            var bmp = roadLabelBitmap(caption, 1, a.color);
            this.roadCaptionSpots(a).forEach(function (spot) {
                h.captionStamps.push(new ScreenStamp({
                    lat: spot.position.lat, lng: spot.position.lng, bmp: bmp,
                    rotation: spot.bearing, lengthMeters: spot.lengthMeters,
                    z: Z_CAPTION + a.order * Z_STEP,
                    onTap: function () { openOptions(a); }
                }));
            });
        },

        // Cheap in-place road edits for the editors (reshapeRoad / restyleRoad).
        reshapeRoad: function (id) {
            var h = this.handles.get(id);
            if (!h || h.a.kind !== 'road') return;
            h.polylines.forEach(function (p) { p.setPath(h.a.points); });
            this.refreshCaption(id);
        },
        restyleRoad: function (id) {
            var h = this.handles.get(id);
            if (!h || h.a.kind !== 'road') return;
            var layers = roadLayers(h.a.color, h.a.widthDp);
            h.polylines.forEach(function (p, i) {
                var l = layers[i];
                if (!l) return;
                var o = { strokeColor: l.color, strokeWeight: l.w };
                if (l.dash) {
                    o.strokeOpacity = 0;
                    o.icons = [{
                        icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: l.color, strokeWeight: l.w, scale: DASH_PX / 2 },
                        offset: '0', repeat: (DASH_PX + GAP_PX) + 'px'
                    }];
                }
                p.setOptions(o);
            });
        },
        refreshCaption: function (id) {
            var now = Date.now();
            if (now - this.lastCaptionRefresh < CAPTION_REFRESH_MS) return;
            this.lastCaptionRefresh = now;
            var h = this.handles.get(id);
            if (!h) return;
            var a = h.a;
            if (a.kind === 'road') {
                var caption = this.roadCaptionText(a);
                if (!caption) {
                    h.captionStamps.forEach(function (s) { s.setShown(false); });
                    return;
                }
                var bmp = roadLabelBitmap(caption, 1, a.color);
                var spots = this.roadCaptionSpots(a);
                // Joint count may have changed — rebuild when the spot list did.
                if (spots.length !== h.captionStamps.length) {
                    h.captionStamps.forEach(function (s) { s.setMap(null); });
                    h.captionStamps = [];
                    this.buildRoadCaptions(h);
                    var self = this;
                    h.captionStamps.forEach(function (s) { s.setShown(a.visible && !self.suspended); });
                    return;
                }
                h.captionStamps.forEach(function (s, i) {
                    var spot = spots[i];
                    s.update({ lat: spot.position.lat, lng: spot.position.lng, bmp: bmp,
                               rotation: spot.bearing, lengthMeters: spot.lengthMeters });
                });
                return;
            }
            this.buildShapeLabel(h);
            if (h.stamp) h.stamp.setShown(a.visible && !this.suspended);
        },

        // ---- export data (captureStamps / captureShapes), parametrized on the
        // capture zoom so a saved download regenerates identically.
        captureStamps: function (cz) {
            var self = this, out = [];
            this.ordered().forEach(function (a) {
                if (!a.visible) return;
                if (a.kind === 'text') {
                    var bmp = textBitmap(a.text, a.scale, a.centered);
                    out.push({
                        lat: a.lat, lng: a.lng, bmp: bmp,
                        widthPx: bmp.w * Math.pow(2, cz - a.placementZoom),
                        anchorU: 0.5, anchorV: 0.5, rotation: a.rotation,
                        groundPinned: true, order: a.order,
                        render: function (s) { return textBitmap(a.text, a.scale * s, a.centered); }
                    });
                } else if (a.kind === 'pin') {
                    var type = typeOf(a.typeId);
                    var pb = pinBitmap(type, displayName(a), 1);
                    out.push({
                        lat: a.lat, lng: a.lng, bmp: pb, widthPx: pb.w,
                        anchorU: 0.5, anchorV: pinAnchorV(type, pb), rotation: 0,
                        groundPinned: false, order: a.order,
                        render: function (s) { return pinBitmap(type, displayName(a), s); }
                    });
                } else if (a.kind === 'road') {
                    var caption = self.roadCaptionText(a);
                    if (!caption) return;
                    var rb = roadLabelBitmap(caption, 1, a.color);
                    self.roadCaptionSpots(a).forEach(function (spot) {
                        if (spot.lengthMeters / mpp(spot.position.lat, cz) <= rb.w) return;
                        out.push({
                            lat: spot.position.lat, lng: spot.position.lng, bmp: rb, widthPx: rb.w,
                            anchorU: 0.5, anchorV: 0.5, rotation: spot.bearing,
                            groundPinned: false, order: a.order,
                            render: function (s) { return roadLabelBitmap(caption, s, a.color); }
                        });
                    });
                } else if (a.kind === 'area') {
                    var label = self.shapeLabel(a);
                    if (!label) return;
                    out.push({
                        lat: label.position.lat, lng: label.position.lng, bmp: label.bmp,
                        widthPx: label.widthMeters / mpp(label.position.lat, cz),
                        anchorU: 0.5, anchorV: 0.5, rotation: label.bearing,
                        groundPinned: true, order: a.order, render: label.render
                    });
                }
            });
            return out;
        },
        captureShapes: function () {
            var out = [];
            this.ordered().forEach(function (a) {
                if (!a.visible) return;
                if (a.kind === 'area') {
                    out.push({
                        points: a.points, closed: true,
                        fill: cssRgba(a.color, a.fillOpacity), stroke: cssColor(a.borderColor),
                        strokeWidthPx: a.borderWidthDp, dashed: false, order: a.order
                    });
                } else if (a.kind === 'road') {
                    roadLayers(a.color, a.widthDp).forEach(function (l) {
                        out.push({
                            points: a.points, closed: false, fill: null,
                            stroke: l.color, strokeWidthPx: l.w, dashed: l.dash, order: a.order
                        });
                    });
                }
            });
            return out;
        },

        // ---- capture viewfinder dressing (AnnotationLayer.beginCapturePreview +
        // CaptureAnnotationPreview): screen-space stamps hand over to ground-pinned
        // stand-ins scaled by screenScale; drawn geometry stays and its ink thins.
        standIns: [],
        beginCapturePreview: function (screenScale) {
            this.suspended = true;
            var self = this;
            this.handles.forEach(function (h) {
                var a = h.a;
                if (h.marker) h.marker.setVisible(false);
                h.captionStamps.forEach(function (s) { s.setShown(false); });
                if (h.polygon) h.polygon.setOptions({ strokeWeight: a.borderWidthDp * screenScale });
                if (a.kind === 'road') {
                    var layers = roadLayers(a.color, a.widthDp * screenScale);
                    h.polylines.forEach(function (p, i) {
                        var l = layers[i];
                        if (!l) return;
                        var o = { strokeWeight: l.w };
                        if (l.dash) {
                            o.strokeOpacity = 0;
                            o.icons = [{
                                icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: l.color, strokeWeight: l.w, scale: (DASH_PX / 2) * screenScale },
                                offset: '0', repeat: ((DASH_PX + GAP_PX) * screenScale) + 'px'
                            }];
                        }
                        p.setOptions(o);
                    });
                }
            });
            this.rebuildStandIns(screenScale);
        },
        rebuildStandIns: function (screenScale) {
            var self = this;
            this.standIns.forEach(function (s) { s.setMap(null); });
            this.standIns = [];
            var zoom = map.getZoom();
            this.handles.forEach(function (h) {
                var a = h.a;
                if (!a.visible) return;
                if (a.kind === 'pin') {
                    var type = typeOf(a.typeId);
                    var pb = pinBitmap(type, displayName(a), 1);
                    self.standIns.push(new GroundStamp({
                        lat: a.lat, lng: a.lng, bmp: pb,
                        widthMeters: pb.w * mpp(a.lat, zoom) * screenScale,
                        rotation: 0, anchorU: 0.5, anchorV: pinAnchorV(type, pb),
                        z: Z_CAPTION + a.order * Z_STEP
                    }));
                } else if (a.kind === 'road') {
                    var caption = self.roadCaptionText(a);
                    if (!caption) return;
                    var rb = roadLabelBitmap(caption, 1, a.color);
                    self.roadCaptionSpots(a).forEach(function (spot) {
                        if (spot.lengthMeters / mpp(spot.position.lat, zoom) <= rb.w) return;
                        self.standIns.push(new GroundStamp({
                            lat: spot.position.lat, lng: spot.position.lng, bmp: rb,
                            widthMeters: rb.w * mpp(spot.position.lat, zoom) * screenScale,
                            rotation: spot.bearing, z: Z_CAPTION + a.order * Z_STEP
                        }));
                    });
                }
            });
        },
        endCapturePreview: function () {
            this.standIns.forEach(function (s) { s.setMap(null); });
            this.standIns = [];
            this.suspended = false;
            var self = this;
            this.handles.forEach(function (h) {
                var a = h.a;
                if (h.polygon) h.polygon.setOptions({ strokeWeight: a.borderWidthDp });
                if (a.kind === 'road') self.restyleRoad(a.id);
            });
            this.applyZoom(map.getZoom());
        }
    };

    // -------------------------------------------------------------------- CSS
    function injectCss() {
        if (document.getElementById('ann-css')) return;
        var st = document.createElement('style');
        st.id = 'ann-css';
        st.textContent = [
            '.ann-stamp{position:absolute;pointer-events:none;transform-origin:center;will-change:transform;}',
            '.ann-stamp img{width:100%;height:100%;display:block;-webkit-user-drag:none;user-select:none;}',
            '.ann-stamp.ann-tappable{pointer-events:auto;cursor:pointer;}',
            // scrim + bottom sheet
            '.ann-scrim{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1200;display:flex;align-items:flex-end;justify-content:center;}',
            '.ann-sheet{position:relative;background:#fff;border-radius:16px 16px 0 0;width:100%;max-width:440px;max-height:72vh;overflow-y:auto;padding:14px 18px calc(14px + env(safe-area-inset-bottom));box-shadow:0 -4px 24px rgba(0,0,0,.25);animation:ann-up .18s ease-out;}',
            '@keyframes ann-up{from{transform:translateY(40px);opacity:.4}to{transform:translateY(0);opacity:1}}',
            // Desktop: dialogs dock on the LEFT with no dimmer and a click-through
            // backdrop, so the map stays visible AND usable beside them — you can
            // pan it, and drag an icon out of the dialog straight onto it.
            '@media(min-width:700px){',
            '.ann-scrim{background:transparent;pointer-events:none;align-items:center;justify-content:flex-start;}',
            '.ann-scrim .ann-sheet,.ann-scrim .ann-dialog{pointer-events:auto;margin-left:16px;border-radius:16px;max-height:82vh;border:1px solid #e0e0e0;box-shadow:0 10px 40px rgba(0,0,0,.35);}',
            '}',
            // Sticky, not absolute: the marker grid scrolls, and the close must
            // stay reachable however far down the user is.
            '.ann-x{position:sticky;top:0;float:right;border:0;background:rgba(255,255,255,.92);border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.18);font-size:22px;color:#888;cursor:pointer;padding:2px 10px;line-height:1.4;z-index:6;margin:0 -8px 0 10px;}',
            '.ann-x:hover{color:#333;}',
            '.ann-sheet h3{font-size:17px;margin:2px 0 2px;color:#1a1a1a;}',
            '.ann-sheet .ann-sub{font-size:12px;color:#777;margin:0 0 10px;}',
            '.ann-row{display:flex;align-items:center;gap:14px;padding:12px 6px;border-radius:10px;cursor:pointer;font-size:15px;color:#222;}',
            '.ann-row:active,.ann-row:hover{background:#f2f6f2;}',
            '.ann-row .ann-ic{width:30px;height:30px;flex:0 0 30px;display:flex;align-items:center;justify-content:center;font-size:20px;}',
            '.ann-row .ann-badge{margin-left:auto;font-size:10px;background:#E8F5E9;color:#2E7D32;border-radius:8px;padding:2px 7px;font-weight:600;}',
            '.ann-footnote{font-size:11px;color:#999;margin-top:8px;}',
            '.ann-section{font-size:11px;letter-spacing:.06em;color:#888;margin:10px 0 2px;font-weight:600;}',
            // dialogs
            '.ann-dialog{position:relative;background:#fff;border-radius:14px;width:calc(100% - 32px);max-width:420px;max-height:82vh;overflow-y:auto;padding:18px;box-shadow:0 8px 32px rgba(0,0,0,.3);}',
            '.ann-scrim.ann-center{align-items:center;}',
            '.ann-dialog h3{font-size:16px;margin:0 0 12px;color:#1a1a1a;}',
            '.ann-dialog textarea,.ann-dialog input[type=text]{width:100%;box-sizing:border-box;border:1px solid #ccc;border-radius:8px;padding:9px 10px;font-size:15px;font-family:inherit;color:#222;background:#fff;}',
            '.ann-dialog textarea{min-height:64px;resize:vertical;}',
            '.ann-check{display:flex;align-items:center;gap:8px;font-size:14px;color:#333;margin:10px 0 0;cursor:pointer;}',
            '.ann-preview{margin:12px 0 0;background:repeating-conic-gradient(#e8e8e8 0 25%,#f7f7f7 0 50%) 0 0/16px 16px;border-radius:8px;padding:10px;display:flex;justify-content:center;align-items:center;min-height:46px;overflow:hidden;}',
            '.ann-preview img{max-width:100%;max-height:90px;}',
            // Sticky like the ×: the marker grid scrolls, and ‹ Back / Add must be
            // reachable without scrolling to the end. Negative bottom swallows the
            // dialog's own padding so the row hugs the visible edge.
            '.ann-btnrow{display:flex;justify-content:flex-end;gap:10px;margin-top:16px;position:sticky;bottom:-18px;margin-bottom:-18px;background:#fff;padding:10px 0 14px;box-shadow:0 -8px 12px -10px rgba(0,0,0,.3);z-index:4;}',
            '.ann-btn{border:0;border-radius:20px;padding:9px 20px;font-size:14px;font-weight:600;cursor:pointer;color:#fff;background:#9E9E9E;}',
            '.ann-btn.ann-primary{background:#2E7D32;}',
            '.ann-btn.ann-danger{background:#E53935;}',
            '.ann-btn:disabled{opacity:.4;cursor:default;}',
            '.ann-swatches{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;}',
            '.ann-swatch{width:34px;height:34px;border-radius:50%;cursor:pointer;border:3px solid transparent;box-sizing:border-box;}',
            '.ann-swatch.sel{border-color:#212121;}',
            '.ann-cap{font-size:11px;letter-spacing:.06em;color:#888;margin:14px 0 0;font-weight:600;}',
            // marker grid
            '.ann-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:6px;}',
            '.ann-grid .ann-cat{grid-column:1/-1;font-size:11px;font-weight:700;letter-spacing:.04em;margin:8px 0 0;}',
            '.ann-type{display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 2px;border-radius:10px;cursor:pointer;border:2px solid transparent;touch-action:pan-y;}',
            '.ann-type.sel{border-color:#2E7D32;background:#E8F5E9;}',
            '.ann-type .em{font-size:22px;line-height:1;}',
            '.ann-type .nm{font-size:10px;color:#444;text-align:center;line-height:1.15;}',
            // Add appears right under the icon you tapped — no scrolling to the bottom
            '.ann-cellsave{margin-top:4px;border:0;border-radius:12px;background:#2E7D32;color:#fff;font-size:11px;font-weight:700;padding:4px 14px;cursor:pointer;}',
            // the icon flying under the pointer while dragging one onto the map
            '.ann-ghost{position:fixed;z-index:3000;font-size:30px;transform:translate(-50%,-50%);pointer-events:none;filter:drop-shadow(0 2px 5px rgba(0,0,0,.45));}',
            // while an icon is being dragged the whole dialog gets out of the way,
            // so the map is visible under the finger (essential on mobile, where
            // the sheet covers the screen)
            '.ann-scrim.ann-dragging{background:transparent !important;}',
            '.ann-scrim.ann-dragging .ann-dialog{visibility:hidden;}',
            // options menu
            '.ann-opt{display:flex;align-items:center;gap:16px;padding:13px 8px;border-radius:10px;cursor:pointer;font-size:15px;color:#222;}',
            '.ann-opt:hover,.ann-opt:active{background:#f4f4f4;}',
            '.ann-opt.ann-del{color:#E53935;}',
            // drawing/placement bar — always clear of the bottom controls row
            // (opacity slider + Browse Regions), on mobile and desktop alike
            '.ann-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(112px + env(safe-area-inset-bottom));background:#fff;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,.3);display:flex;align-items:center;gap:8px;padding:10px 14px;z-index:1150;max-width:calc(100vw - 20px);}',
            '.ann-bar .ann-readout{font-size:14px;font-weight:700;color:#212121;min-width:100px;white-space:nowrap;}',
            '.ann-pill{border:0;border-radius:20px;color:#fff;font-size:13px;font-weight:700;padding:8px 14px;cursor:pointer;white-space:nowrap;}',
            // editor panel card
            '.ann-panel{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));margin:0 auto;max-width:480px;background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.3);padding:12px 14px;z-index:1150;font-size:14px;color:#222;}',
            '.ann-panel .ann-prow{display:flex;align-items:center;gap:8px;}',
            '.ann-panel .ann-pname{flex:1;font-weight:700;font-size:15px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.ann-panel .ann-pname.drawing{font-weight:400;font-size:13px;color:#555;white-space:normal;}',
            '.ann-iconbtn{border:0;background:none;font-size:18px;cursor:pointer;padding:5px;line-height:1;color:#555;}',
            '.ann-panel .ann-checks{display:flex;gap:16px;margin-top:8px;flex-wrap:wrap;align-items:center;}',
            '.ann-panel .ann-checks label{display:flex;gap:6px;align-items:center;font-size:13px;cursor:pointer;}',
            '.ann-tabs{display:flex;gap:18px;margin-top:10px;font-size:13px;font-weight:600;color:#888;user-select:none;}',
            '.ann-tabs span{cursor:pointer;padding-bottom:3px;}',
            '.ann-panel .ann-prow,.ann-panel .ann-checks,.ann-swatches,.ann-bar{user-select:none;}',
            '.ann-tabs span.sel{color:#2E7D32;border-bottom:2px solid #2E7D32;}',
            '.ann-sliderrow{display:flex;align-items:center;gap:10px;margin-top:8px;}',
            '.ann-sliderrow input[type=range]{flex:1;}',
            '.ann-sliderrow .lbl{font-size:12px;color:#666;min-width:62px;}',
            '.ann-movelabel{margin-left:auto;font-size:12px;color:#1565C0;cursor:pointer;font-weight:600;}',
            // text placement surface — the surface itself is click-transparent so the
            // map still pans underneath; only the text, handles and bar take input
            '.ann-place{position:fixed;z-index:1200;overflow:hidden;pointer-events:none;}',
            '.ann-place .ann-ptext,.ann-place .ann-handle,.ann-place .ann-bar{pointer-events:auto;}',
            '.ann-place .ann-ptext{position:absolute;transform-origin:center;cursor:grab;touch-action:none;}',
            '.ann-place .ann-ptext img{display:block;-webkit-user-drag:none;user-select:none;pointer-events:none;}',
            '.ann-handle{position:absolute;width:34px;height:34px;border-radius:50%;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;touch-action:none;cursor:pointer;z-index:5;user-select:none;}',
            '.ann-handle.rot{background:#2E7D32;}',
            '.ann-handle.rsz{background:#1565C0;}',
            '.ann-handle.mov{background:#FF5722;}',
            // layers panel rows
            '.ann-lrow{display:flex;align-items:center;gap:10px;padding:9px 4px;border-radius:10px;font-size:14px;color:#222;background:#fff;}',
            '.ann-lrow{will-change:transform;}',
            '.ann-lrow.dragging{opacity:.92;background:#f0f4f0;box-shadow:0 5px 16px rgba(0,0,0,.28);position:relative;z-index:3;border-radius:10px;}',
            '.ann-lrow .drag{cursor:grab;color:#aaa;font-size:17px;padding:4px 6px;touch-action:none;}',
            '.ann-lrow .ic{width:26px;text-align:center;font-size:17px;}',
            '.ann-lrow .nm{flex:1;min-width:0;}',
            '.ann-lrow .nm .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}',
            '.ann-lrow .nm .m{font-size:11px;color:#888;}',
            '.ann-lrow.hidden .nm .t{opacity:.45;}',
            '.ann-lrow button{border:0;background:none;font-size:16px;cursor:pointer;padding:5px;color:#666;}',
            '.ann-draft{background:#FFF8E1;border-radius:10px;padding:10px 12px;margin:6px 0;display:flex;align-items:center;gap:10px;font-size:13px;color:#5D4037;}',
            // "My annotations" dock — grows out of the #btn-my-annotations fab
            '.ann-dock{position:fixed;z-index:1190;background:#fff;border-radius:14px;border:1px solid #e0e0e0;box-shadow:0 8px 32px rgba(0,0,0,.35);width:min(340px,calc(100vw - 84px));display:flex;flex-direction:column;overflow:hidden;transform:scale(.12);opacity:0;transition:transform .18s ease-out,opacity .15s ease-out;}',
            '.ann-dock.open{transform:scale(1);opacity:1;}',
            '.ann-dock-head{display:flex;align-items:center;padding:10px 6px 2px 16px;user-select:none;}',
            '.ann-dock-head h3{font-size:15px;margin:0;flex:1;color:#1a1a1a;}',
            '.ann-dock-body{overflow-y:auto;padding:0 12px 12px;}',
            // floating undo/redo, bottom-left, shown only when actionable
            '.ann-histbar{position:fixed;left:10px;bottom:calc(104px + env(safe-area-inset-bottom));z-index:1090;display:none;flex-direction:column;gap:8px;}',
            '.ann-histbtn{width:42px;height:42px;border-radius:50%;border:none;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.3);font-size:20px;color:#333;cursor:pointer;user-select:none;}',
            '.ann-histbtn:active{background:#f0f0f0;}'
        ].join('\n');
        document.head.appendChild(st);
    }

    // ------------------------------------------------------------ modal helpers
    var openScrims = [];
    function mkScrim(centered) {
        var scrim = document.createElement('div');
        scrim.className = 'ann-scrim' + (centered ? ' ann-center' : '');
        document.body.appendChild(scrim);
        openScrims.push(scrim);
        scrim.addEventListener('click', function (e) {
            if (e.target === scrim) closeScrim(scrim);
        });
        return scrim;
    }
    function closeScrim(scrim) {
        var i = openScrims.indexOf(scrim);
        if (i >= 0) openScrims.splice(i, 1);
        if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
        if (scrim._onClose) scrim._onClose();
    }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function btn(label, cls, onClick) {
        var b = el('button', 'ann-btn' + (cls ? ' ' + cls : ''), label);
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
    }
    // On desktop the backdrop is click-through (the map stays usable), so every
    // sheet/dialog carries its own ×. onClose (optional) runs after closing —
    // the back-stack hook for dialogs opened from the annotate sheet.
    function addCloseX(container, scrim, onClose) {
        var x = el('button', 'ann-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Close');
        x.addEventListener('click', function () {
            closeScrim(scrim);
            if (onClose) onClose();
        });
        // First child: position:sticky only pins it through the scroll when it
        // sits at the top of the scroll content.
        container.insertBefore(x, container.firstChild);
    }
    function confirmDialog(title, message, actionLabel, onConfirm) {
        var scrim = mkScrim(true);
        var d = el('div', 'ann-dialog');
        d.appendChild(el('h3', null, title));
        var p = el('p', null, message);
        p.style.cssText = 'font-size:13px;color:#555;margin:0;line-height:1.5;';
        d.appendChild(p);
        var row = el('div', 'ann-btnrow');
        row.appendChild(btn('Keep', null, function () { closeScrim(scrim); }));
        row.appendChild(btn(actionLabel, 'ann-danger', function () { closeScrim(scrim); onConfirm(); }));
        d.appendChild(row);
        scrim.appendChild(d);
    }

    // ------------------------------------------------------------ mode control
    // One tool owns the screen at a time; starting a new one closes the last.
    // The host's measure mode also listens for map clicks — a drawing started on
    // top of it would double-handle every tap, so it is stopped first.
    var activeMode = null;
    function stopHostMeasure() {
        try {
            if (typeof measureMode !== 'undefined' && measureMode &&
                typeof stopMeasureMode === 'function') stopMeasureMode(false);
        } catch (e) {}
    }
    function enterMode(close) {
        if (activeMode) activeMode();
        stopHostMeasure();
        activeMode = close;
    }
    function exitMode() {
        var m = activeMode;
        activeMode = null;
        if (m) m();
    }

    // ---------------------------------------------------------------- dialogs
    // Compose the words; size/angle/place are chosen on the map itself.
    // onBack (optional): where Cancel/× returns to — the annotate sheet, when
    // the dialog was opened from it.
    function composeTextDialog(existing, onResult, onBack) {
        var scrim = mkScrim(true);
        var d = el('div', 'ann-dialog');
        addCloseX(d, scrim, onBack);
        d.appendChild(el('h3', null, existing ? 'Edit text' : 'Write on the map'));
        var ta = document.createElement('textarea');
        ta.placeholder = 'Your text — a plot number, a note…';
        if (existing) ta.value = existing.text;
        d.appendChild(ta);
        var chk = el('label', 'ann-check');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = existing ? !!existing.centered : false;
        chk.appendChild(cb);
        chk.appendChild(document.createTextNode('Centre-align lines'));
        d.appendChild(chk);
        var prev = el('div', 'ann-preview');
        var img = document.createElement('img');
        prev.appendChild(img);
        d.appendChild(prev);
        function redraw() {
            img.src = textBitmap(ta.value || 'Your text', 1, cb.checked).canvas.toDataURL();
        }
        ta.addEventListener('input', redraw);
        cb.addEventListener('change', redraw);
        redraw();
        var row = el('div', 'ann-btnrow');
        row.appendChild(btn(onBack ? '‹ Back' : 'Cancel', null, function () {
            closeScrim(scrim);
            if (onBack) onBack();
        }));
        row.appendChild(btn(existing ? 'Save' : 'Next', 'ann-primary', function () {
            var text = ta.value.trim();
            if (!text) return;
            closeScrim(scrim);
            onResult(text, cb.checked);
        }));
        d.appendChild(row);
        scrim.appendChild(d);
        setTimeout(function () { ta.focus(); }, 50);
    }

    // Pick what the place IS and what to call it — grid grouped by category.
    // Two ways out: tap an icon and press the Add that appears right under it
    // (no scrolling to a bottom button), or DRAG an icon straight onto the map to
    // place it exactly there. onResult(typeId, label, dropLatLng|null).
    // onBack: where Cancel/× returns to — the annotate sheet, when opened from it.
    function pickMarkerDialog(existing, onResult, onBack) {
        var scrim = mkScrim(true);
        var d = el('div', 'ann-dialog');
        addCloseX(d, scrim, onBack);
        d.appendChild(el('h3', null, existing ? 'Edit marker' : 'Add marker'));
        d.appendChild(el('p', 'ann-sub', existing
            ? 'Drag an icon onto the map to move the marker there (press & hold first on touch) — or tap one and press Save.'
            : 'Drag an icon onto the map to place it (press & hold first on touch) — or tap one and press Add. You name it once it lands.'));
        // The name is asked AFTER the marker lands on the map (owner request) —
        // only the edit flow keeps the field, since renaming is what it is for.
        var input = null;
        if (existing) {
            input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'Name this place (optional)';
            input.value = existing.label;
            d.appendChild(input);
        }
        var selectedId = existing ? existing.typeId : DEFAULT_TYPE_ID;
        function commit(dropLatLng) {
            closeScrim(scrim);
            onResult(selectedId, input ? input.value.trim() : '', dropLatLng || null);
        }
        var grid = el('div', 'ann-grid');
        var cells = [];
        var inlineBtn = null;
        function selectCell(cell, typeId) {
            selectedId = typeId;
            cells.forEach(function (c) { c.classList.remove('sel'); });
            cell.classList.add('sel');
            if (inlineBtn && inlineBtn.parentNode) inlineBtn.parentNode.removeChild(inlineBtn);
            inlineBtn = el('button', 'ann-cellsave', existing ? 'Save' : 'Add');
            inlineBtn.type = 'button';
            inlineBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                commit(null);
            });
            cell.appendChild(inlineBtn);
        }
        CATEGORIES.forEach(function (cat, ci) {
            var head = el('div', 'ann-cat', cat[0]);
            head.style.color = cat[1];
            grid.appendChild(head);
            MARKER_TYPES.forEach(function (t) {
                if (t[2] !== ci) return;
                var cell = el('div', 'ann-type' + (t[0] === selectedId ? ' sel' : ''));
                var em = el('div', 'em', t[3] || '🔤');
                cell.appendChild(em);
                cell.appendChild(el('div', 'nm', t[1]));
                cell.addEventListener('click', function (e) {
                    // A click that the inline Add handled stops here (see below).
                    if (e.target && e.target.classList && e.target.classList.contains('ann-cellsave')) return;
                    selectCell(cell, t[0]);
                });
                // Drag the icon out of the dialog and drop it on the map. Pointer
                // capture keeps the stream on the cell, so the drop coordinates are
                // trustworthy wherever the finger/mouse ends up.
                cell.addEventListener('pointerdown', function (e) {
                    // NOT when the press starts on the inline Add button: capturing
                    // the pointer here retargets the eventual click to the CELL, so
                    // the button's own handler would never fire (the "Add does
                    // nothing" bug) — and a press on Add must never start a drag.
                    if (e.target && e.target.classList && e.target.classList.contains('ann-cellsave')) return;
                    // ONLY a real mouse drags immediately on movement. Touch, pen
                    // and unknown pointer types (some Android browsers report an
                    // empty pointerType, which used to arm instantly — the "icons
                    // move without long press" bug) must press-and-HOLD to lift
                    // the icon: an immediate drag is how the grid scrolls.
                    var isMouse = e.pointerType === 'mouse';
                    var startX = e.clientX, startY = e.clientY;
                    var dragging = false, ghost = null, holdT = null;
                    var armed = isMouse;
                    cell.setPointerCapture(e.pointerId);
                    function beginDrag(x, y) {
                        if (dragging) return;
                        dragging = true;
                        selectedId = t[0];
                        ghost = el('div', 'ann-ghost', t[3] || '🔤');
                        ghost.style.left = x + 'px';
                        ghost.style.top = y + 'px';
                        document.body.appendChild(ghost);
                        // The dialog steps aside so the map is visible under the
                        // finger — the whole point of dragging, and on mobile the
                        // sheet would otherwise cover the drop target completely.
                        scrim.classList.add('ann-dragging');
                        try { if (navigator.vibrate) navigator.vibrate(20); } catch (er) {}
                    }
                    if (!isMouse) holdT = setTimeout(function () {
                        armed = true;
                        beginDrag(startX, startY);      // lifts under the still finger
                    }, 450);
                    function mv(ev) {
                        if (!dragging) {
                            var moved = Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8;
                            if (!armed) {
                                if (moved) cancel();     // it's a scroll — let the browser have it
                                return;
                            }
                            if (moved) beginDrag(ev.clientX, ev.clientY);
                        }
                        if (ghost) {
                            ghost.style.left = ev.clientX + 'px';
                            ghost.style.top = ev.clientY + 'px';
                        }
                    }
                    // Non-passive: while a drag is live, scrolling must not take
                    // over the gesture (touch-action can't change mid-gesture).
                    function tmBlock(ev) { if (dragging) ev.preventDefault(); }
                    function unhook() {
                        clearTimeout(holdT);
                        cell.removeEventListener('pointermove', mv);
                        cell.removeEventListener('pointerup', up);
                        cell.removeEventListener('pointercancel', cancel);
                        cell.removeEventListener('touchmove', tmBlock);
                        if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
                        scrim.classList.remove('ann-dragging');
                    }
                    function up(ev) {
                        var wasDragging = dragging;
                        unhook();
                        if (!wasDragging) return;          // plain tap: the click handler selects
                        // The dialog is hidden during the drag, so anywhere on the
                        // map places the marker; releasing off the map cancels.
                        var mr = mapDiv().getBoundingClientRect();
                        var overMap = ev.clientX >= mr.left && ev.clientX <= mr.right &&
                                      ev.clientY >= mr.top && ev.clientY <= mr.bottom;
                        if (!overMap) return;
                        var ll = containerPxToLatLng(ev.clientX - mr.left, ev.clientY - mr.top);
                        commit({ lat: ll.lat(), lng: ll.lng() });
                    }
                    function cancel() { unhook(); }
                    cell.addEventListener('pointermove', mv);
                    cell.addEventListener('pointerup', up);
                    cell.addEventListener('pointercancel', cancel);
                    cell.addEventListener('touchmove', tmBlock, { passive: false });
                });
                cells.push(cell);
                grid.appendChild(cell);
                if (t[0] === selectedId) selectCell(cell, t[0]);
            });
        });
        d.appendChild(grid);
        var row = el('div', 'ann-btnrow');
        row.appendChild(btn(onBack ? '‹ Back' : 'Cancel', null, function () {
            closeScrim(scrim);
            if (onBack) onBack();
        }));
        d.appendChild(row);
        scrim.appendChild(d);
    }

    // Name a drawn shape and pick its ink (describeShape).
    function describeShapeDialog(kindTitle, measurementNoun, current, onResult) {
        var scrim = mkScrim(true);
        var d = el('div', 'ann-dialog');
        addCloseX(d, scrim);
        d.appendChild(el('h3', null, kindTitle));
        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Name it — plot number, road name…';
        input.value = current.label || '';
        input.addEventListener('keydown', function (e) {   // Enter = Save here too
            if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
        });
        d.appendChild(input);
        var chk = el('label', 'ann-check');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = current.showMeasurement;
        chk.appendChild(cb);
        chk.appendChild(document.createTextNode('Show ' + measurementNoun + ' on the plan'));
        d.appendChild(chk);
        d.appendChild(el('div', 'ann-cap', 'COLOUR'));
        var chosen = current.color;
        var sw = el('div', 'ann-swatches');
        var views = [];
        PALETTE.forEach(function (pair) {
            var s = el('div', 'ann-swatch' + (pair[1] === chosen ? ' sel' : ''));
            s.style.background = cssColor(pair[1]);
            s.title = pair[0];
            s.addEventListener('click', function () {
                chosen = pair[1];
                views.forEach(function (v) { v.classList.remove('sel'); });
                s.classList.add('sel');
            });
            views.push(s);
            sw.appendChild(s);
        });
        d.appendChild(sw);
        var row = el('div', 'ann-btnrow');
        row.appendChild(btn('Cancel', null, function () { closeScrim(scrim); }));
        var saveBtn = btn('OK', 'ann-primary', function () {
            closeScrim(scrim);
            onResult(input.value.trim(), chosen, cb.checked);
        });
        row.appendChild(saveBtn);
        d.appendChild(row);
        scrim.appendChild(d);
    }

    // What can be done to the annotation the user tapped (annotationOptions).
    // The orange move disc + red × over a pin, raised by a long press on touch.
    // Same handle the vertices use, so "hold, then drag the disc" means the same
    // thing everywhere — and the disc keeps the fingertip off the pin itself.
    function showPinMoveHandle(h, a) {
        if (typeof showVertexHandle !== 'function' || !h.marker) return;
        showVertexHandle(h.marker, {
            isSaved: false,
            onMove: function (latLng) {
                a.lat = latLng.lat(); a.lng = latLng.lng();
            },
            onMoveEnd: function () { layer.persist(); },
            onDelete: function () {
                if (typeof hideVertexHandle === 'function') hideVertexHandle();
                layer.remove(a.id);
            }
        });
        toast('Drag the orange disc to move · × deletes');
    }

    function openOptions(a) {
        // Ignored while another tool owns the screen (an editor, the placement
        // surface, or the capture viewfinder) — and idempotent: a double click
        // on an annotation must not stack the options sheet twice.
        if (layer.suspended || activeMode || placementOpen || openScrims.length) return;
        var scrim = mkScrim(false);
        var d = el('div', 'ann-sheet');
        addCloseX(d, scrim);
        d.appendChild(el('h3', null, displayName(a)));
        function opt(icon, label, danger, run) {
            var r = el('div', 'ann-opt' + (danger ? ' ann-del' : ''));
            r.appendChild(el('span', 'ann-ic', icon));
            r.appendChild(el('span', null, label));
            r.addEventListener('click', function () { closeScrim(scrim); run(); });
            d.appendChild(r);
        }
        if (a.kind === 'area') opt('⭕', 'Edit region', false, function () { openRegionEditor(a, false); });
        if (a.kind === 'road') opt('〰️', 'Edit shape', false, function () { openRoadEditor(a); });
        if (a.kind === 'text') opt('✏️', 'Edit text', false, function () {
            // The model is only written on commit — cancelling placement must
            // leave the original wording untouched.
            composeTextDialog(a, function (text, centered) {
                startTextPlacement(text, centered, a);
            });
        });
        // Touch has no direct drag on a pin (a swipe pans the map), so the
        // menu carries the move affordance too — long press is a shortcut,
        // not the only way in.
        if (a.kind === 'pin' && isCoarsePointer()) opt('🧭', 'Move this marker', false, function () {
            var h = layer.handles.get(a.id);
            if (h) showPinMoveHandle(h, a);
        });
        if (a.kind === 'pin') opt('✏️', 'Edit label & type', false, function () {
            pickMarkerDialog(a, function (typeId, label, dropLatLng) {
                a.typeId = typeId; a.label = label;
                if (dropLatLng) { a.lat = dropLatLng.lat; a.lng = dropLatLng.lng; }
                layer.update(a);
            });
        });
        if (a.kind === 'area' || a.kind === 'road') opt('🎨', 'Name & colour', false, function () {
            var isArea = a.kind === 'area';
            describeShapeDialog(
                isArea ? 'Region' : 'Road', isArea ? 'area' : 'length',
                { label: a.label, color: a.color, showMeasurement: isArea ? a.showArea : a.showLength },
                function (label, color, showMeasurement) {
                    a.label = label;
                    if (isArea) {
                        if (a.borderColor === a.color) a.borderColor = color;   // paired inks follow
                        a.color = color;
                        a.showArea = showMeasurement;
                    } else {
                        a.color = color;
                        a.showLength = showMeasurement;
                    }
                    layer.update(a);
                }
            );
        });
        if (a.kind === 'text') opt('🧭', 'Move, resize & rotate', false, function () {
            startTextPlacement(a.text, a.centered, a);
        });
        opt('🚫', 'Hide from the plan', false, function () {
            layer.setVisible(a.id, false);
            toast('Hidden — find it under Annotate → My annotations');
        });
        opt('🗑️', 'Delete', true, function () {
            confirmDialog('Delete ' + displayName(a) + '?',
                'It will be removed from the map and the plan.', 'Delete',
                function () { layer.remove(a.id); });
        });
        scrim.appendChild(d);
    }

    // ------------------------------------------------- text placement (surface)
    // The text floats over the live map at the size and angle it will really have.
    // Drag anywhere on it; pinch (two pointers) or mouse-wheel or the blue handle
    // to size; the green handle swings it; the orange disc drags it 1:1.
    var placementOpen = false;
    function startTextPlacement(text, centered, existing) {
        if (placementOpen) return;
        placementOpen = true;
        var md = mapDiv();
        var mrect = md.getBoundingClientRect();
        var root = el('div', 'ann-place');
        root.style.left = mrect.left + 'px';
        root.style.top = mrect.top + 'px';
        root.style.width = mrect.width + 'px';
        root.style.height = mrect.height + 'px';

        var scale = existing ? existing.scale : 1.5;
        var rotation = existing ? existing.rotation : 0;
        scale = Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, scale));
        var offsetX = 0, offsetY = 0;
        if (existing) {
            // Start where the label already is, and hide the live copy — remembered
            // so that ANY way out puts it back (the visible=false-on-disk bug).
            var px = latLngToContainerPx(existing.lat, existing.lng);
            if (px) { offsetX = px.x - mrect.width / 2; offsetY = px.y - mrect.height / 2; }
            var lh = layer.handles.get(existing.id);
            if (lh && lh.stamp) lh.stamp.setShown(false);
        }

        var holder = el('div', 'ann-ptext');
        var img = document.createElement('img');
        holder.appendChild(img);
        root.appendChild(holder);

        var renderedScale = scale;
        function render() {
            var bmp = textBitmap(text, scale, centered);
            img.src = bmp.canvas.toDataURL();
            img.style.width = bmp.w + 'px';
            img.style.height = bmp.h + 'px';
            renderedScale = scale;
            holder._w = bmp.w; holder._h = bmp.h;
            position();
        }
        function position() {
            var vis = scale / renderedScale;      // cheap CSS scale between re-renders
            holder.style.left = (mrect.width / 2 + offsetX) + 'px';
            holder.style.top = (mrect.height / 2 + offsetY) + 'px';
            holder.style.transform = 'translate(-50%,-50%) rotate(' + rotation + 'deg) scale(' + vis + ')';
            positionHandles();
        }
        function centreX() { return mrect.width / 2 + offsetX; }
        function centreY() { return mrect.height / 2 + offsetY; }

        var rotHandle = el('div', 'ann-handle rot', '↻');
        var rszHandle = el('div', 'ann-handle rsz', '⤢');
        var movHandle = el('div', 'ann-handle mov', '✜');
        root.appendChild(rotHandle); root.appendChild(rszHandle); root.appendChild(movHandle);
        function positionHandles() {
            var vis = scale / renderedScale;
            var hw = (holder._w || 0) * vis / 2, hh = (holder._h || 0) * vis / 2;
            var r = rad(rotation), cos = Math.cos(r), sin = Math.sin(r);
            var cx = centreX(), cy = centreY();
            // rotate handle: bottom-right corner; resize: top-right; move: bottom-left
            rotHandle.style.left = (cx + hw * cos - hh * sin - 17) + 'px';
            rotHandle.style.top = (cy + hw * sin + hh * cos - 17) + 'px';
            rszHandle.style.left = (cx + hw * cos + hh * sin - 17) + 'px';
            rszHandle.style.top = (cy + hw * sin - hh * cos - 17) + 'px';
            movHandle.style.left = (cx - hw * cos - hh * sin - 17) + 'px';
            movHandle.style.top = (cy - hw * sin + hh * cos - 17) + 'px';
        }

        // gestures — pointer events only: one path for touch and mouse
        var pointers = new Map();
        var pinchStart = null;
        function freezeMap(on) { map.setOptions({ gestureHandling: on ? 'none' : 'greedy' }); }
        holder.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            holder.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 2) {
                var ps = Array.from(pointers.values());
                pinchStart = { d: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), scale: scale };
            }
            freezeMap(true);
        });
        holder.addEventListener('pointermove', function (e) {
            if (!pointers.has(e.pointerId)) return;
            var prev = pointers.get(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 2 && pinchStart) {
                var ps = Array.from(pointers.values());
                var d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
                if (pinchStart.d > 0) {
                    scale = Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, pinchStart.scale * d / pinchStart.d));
                    position();
                }
            } else if (pointers.size === 1) {
                offsetX += e.clientX - prev.x;
                offsetY += e.clientY - prev.y;
                position();
            }
        });
        function holderUp(e) {
            pointers.delete(e.pointerId);
            if (pointers.size < 2) pinchStart = null;
            if (pointers.size === 0) { freezeMap(false); render(); }   // crisp at rest
        }
        holder.addEventListener('pointerup', holderUp);
        holder.addEventListener('pointercancel', holderUp);
        holder.addEventListener('wheel', function (e) {
            e.preventDefault();
            scale = Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, scale * Math.pow(1.0015, -e.deltaY)));
            position();
            clearTimeout(root._wheelT);
            root._wheelT = setTimeout(render, 200);
        }, { passive: false });

        function handleDrag(handle, onMove, onUp) {
            handle.addEventListener('pointerdown', function (e) {
                e.preventDefault(); e.stopPropagation();
                handle.setPointerCapture(e.pointerId);
                freezeMap(true);
                var start = { x: e.clientX, y: e.clientY };
                var ctx = onMove(null, start, null);   // init call returns gesture ctx
                function mv(ev) { onMove(ctx, start, { x: ev.clientX, y: ev.clientY }); }
                function up(ev) {
                    handle.removeEventListener('pointermove', mv);
                    handle.removeEventListener('pointerup', up);
                    handle.removeEventListener('pointercancel', up);
                    freezeMap(false);
                    if (onUp) onUp();
                }
                handle.addEventListener('pointermove', mv);
                handle.addEventListener('pointerup', up);
                handle.addEventListener('pointercancel', up);
            });
        }
        function angleTo(p) {
            return deg(Math.atan2(p.y - (mrect.top + centreY()), p.x - (mrect.left + centreX())));
        }
        handleDrag(rotHandle, function (ctx, start, cur) {
            if (!cur) return { a0: angleTo(start), r0: rotation };
            rotation = ctx.r0 + (angleTo(cur) - ctx.a0);
            position();
            return ctx;
        });
        handleDrag(rszHandle, function (ctx, start, cur) {
            var cx = mrect.left + centreX(), cy = mrect.top + centreY();
            if (!cur) return { d0: Math.hypot(start.x - cx, start.y - cy), s0: scale };
            var d = Math.hypot(cur.x - cx, cur.y - cy);
            if (ctx.d0 > 0) {
                scale = Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, ctx.s0 * d / ctx.d0));
                position();
            }
            return ctx;
        }, function () { render(); });
        handleDrag(movHandle, function (ctx, start, cur) {
            if (!cur) return { x0: offsetX, y0: offsetY, sx: start.x, sy: start.y };
            offsetX = ctx.x0 + (cur.x - ctx.sx);
            offsetY = ctx.y0 + (cur.y - ctx.sy);
            position();
            return ctx;
        });

        // The class position is FIXED above the bottom controls — the bar used to
        // sit 26px from the map's bottom edge, underneath the slider/Browse row.
        var bar = el('div', 'ann-bar');
        bar.appendChild(el('span', 'ann-readout', 'Drag · pinch or ⤢ to size'));
        var cancelB = el('button', 'ann-pill', 'Cancel');
        cancelB.style.background = '#616161';
        var doneB = el('button', 'ann-pill', 'Done');
        doneB.style.background = '#2E7D32';
        bar.appendChild(cancelB); bar.appendChild(doneB);
        root.appendChild(bar);

        function close(restore) {
            placementOpen = false;
            freezeMap(false);
            if (root.parentNode) root.parentNode.removeChild(root);
            if (restore && existing) {
                var lh = layer.handles.get(existing.id);
                if (lh && lh.stamp) lh.stamp.setShown(existing.visible);
            }
        }
        cancelB.addEventListener('click', function () { close(true); });
        doneB.addEventListener('click', function () {
            var ll = containerPxToLatLng(centreX(), centreY());
            var zoom = map.getZoom();
            close(false);
            if (existing) {
                existing.text = text;
                existing.lat = ll.lat(); existing.lng = ll.lng();
                existing.scale = scale; existing.rotation = rotation;
                existing.centered = centered; existing.placementZoom = zoom;
                existing.visible = true;
                layer.update(existing);
            } else {
                if (layer.isFull()) { toast('That is as many notes as one map can hold'); return; }
                layer.add({
                    id: newId(), kind: 'text', visible: true, order: 0,
                    lat: ll.lat(), lng: ll.lng(), text: text, scale: scale,
                    rotation: rotation, centered: centered, placementZoom: zoom
                });
                toast('Written on the map — it prints with the plan');
            }
        });
        document.body.appendChild(root);
        render();
    }

    // ------------------------------------------------- vertex editing plumbing
    // Blue corner dots drag; green midpoints add a corner; tapping a corner raises
    // the host's shared move-disc + delete handle (VertexHandleOverlay — the exact
    // affordance the measure tools already taught the user's hand).
    function vertexIcon() {
        return { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#2196F3',
                 fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 };
    }
    function midpointIcon() {
        return { path: google.maps.SymbolPath.CIRCLE, scale: 6.5, fillColor: '#4CAF50',
                 fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 };
    }
    function mkVertexEditor(opts) {
        // opts: { points, closed, minPoints, onLiveChange(), onCommit(), noun }
        var vertexMarkers = [], midMarkers = [];
        var undoStack = [];
        function pushUndo() {
            undoStack.push(opts.points.map(function (p) { return { lat: p.lat, lng: p.lng }; }));
            if (undoStack.length > UNDO_DEPTH) undoStack.shift();
        }
        function undo() {
            var prev = undoStack.pop();
            if (!prev) return false;
            opts.points.length = 0;
            prev.forEach(function (p) { opts.points.push(p); });
            rebuild();
            opts.onLiveChange();
            opts.onCommit();
            return true;
        }
        function segCount() { return opts.closed ? opts.points.length : opts.points.length - 1; }
        function rebuild() {
            teardown(false);
            opts.points.forEach(function (p, i) {
                var m = new google.maps.Marker({
                    position: p, map: map, icon: vertexIcon(), draggable: true,
                    zIndex: 200002, clickable: true
                });
                m._idx = i;
                m.addListener('dragstart', function () {
                    pushUndo();
                    if (typeof showMagnifier === 'function') showMagnifier(m.getPosition());
                });
                m.addListener('drag', function () {
                    var ll = m.getPosition();
                    opts.points[m._idx] = { lat: ll.lat(), lng: ll.lng() };
                    repositionMids();
                    opts.onLiveChange();
                    if (typeof moveMagnifier === 'function') moveMagnifier(ll);
                });
                m.addListener('dragend', function () {
                    if (typeof hideMagnifier === 'function') hideMagnifier();
                    opts.onCommit();
                });
                m.addListener('click', function () {
                    if (typeof showVertexHandle !== 'function') return;
                    showVertexHandle(m, {
                        isSaved: false,
                        onMove: function (latLng) {
                            opts.points[m._idx] = { lat: latLng.lat(), lng: latLng.lng() };
                            repositionMids();
                            opts.onLiveChange();
                        },
                        onMoveEnd: function () { opts.onCommit(); },
                        onDelete: function () {
                            if (opts.points.length <= opts.minPoints) {
                                toast('A ' + opts.noun + ' needs at least ' + opts.minPoints + ' points');
                                return;
                            }
                            pushUndo();
                            opts.points.splice(m._idx, 1);
                            if (typeof hideVertexHandle === 'function') hideVertexHandle();
                            rebuild();
                            opts.onLiveChange();
                            opts.onCommit();
                        }
                    });
                });
                vertexMarkers.push(m);
            });
            for (var i = 0; i < segCount(); i++) {
                (function (i) {
                    var a = opts.points[i], b = opts.points[(i + 1) % opts.points.length];
                    var m = new google.maps.Marker({
                        position: midOf(a, b), map: map, icon: midpointIcon(),
                        zIndex: 200001, clickable: true
                    });
                    m.addListener('click', function () {   // a green midpoint splits its edge
                        pushUndo();
                        opts.points.splice(i + 1, 0, midOf(opts.points[i], opts.points[(i + 1) % opts.points.length]));
                        rebuild();
                        opts.onLiveChange();
                        opts.onCommit();
                    });
                    midMarkers.push(m);
                })(i);
            }
        }
        function repositionMids() {
            for (var i = 0; i < midMarkers.length && i < segCount(); i++) {
                var a = opts.points[i], b = opts.points[(i + 1) % opts.points.length];
                midMarkers[i].setPosition(midOf(a, b));
            }
        }
        function teardown(final) {
            vertexMarkers.forEach(function (m) { m.setMap(null); });
            midMarkers.forEach(function (m) { m.setMap(null); });
            vertexMarkers = []; midMarkers = [];
            if (final && typeof hideVertexHandle === 'function') hideVertexHandle();
        }
        rebuild();
        return { rebuild: rebuild, teardown: function () { teardown(true); }, pushUndo: pushUndo, undo: undo,
                 hasUndo: function () { return undoStack.length > 0; } };
    }

    // ------------------------------------------------------------ region editor
    // Styling and reshaping a marked region. Also the AREA drawing flow: the panel
    // is up from the first corner (Location Plan Maker's way), and Done is disabled
    // until the ring has three corners.
    function openRegionEditor(area, drawing, resumeDraft) {
        exitMode();
        var isNew = drawing;
        var addedToLayer = !drawing;
        var clickL = null;
        var tempPoly = null;      // outline before the annotation joins the layer
        var editor = null;
        var target = 'fill';

        var panel = el('div', 'ann-panel');
        var prow = el('div', 'ann-prow');
        var nameEl = el('span', 'ann-pname');
        var renameB = el('button', 'ann-iconbtn', '✏️');
        var undoB = el('button', 'ann-iconbtn', '↶');
        var delB = el('button', 'ann-iconbtn', '🗑️');
        var doneB = el('button', 'ann-pill', 'Done');
        doneB.style.background = '#2E7D32';
        prow.appendChild(nameEl); prow.appendChild(renameB); prow.appendChild(undoB);
        prow.appendChild(delB); prow.appendChild(doneB);
        panel.appendChild(prow);
        var checks = el('div', 'ann-checks');
        var showLabelCb = document.createElement('input'); showLabelCb.type = 'checkbox';
        var showAreaCb = document.createElement('input'); showAreaCb.type = 'checkbox';
        var l1 = el('label'); l1.appendChild(showLabelCb); l1.appendChild(document.createTextNode('Show name'));
        var l2 = el('label'); l2.appendChild(showAreaCb); l2.appendChild(document.createTextNode('Show area'));
        var moveLabelB = el('span', 'ann-movelabel', 'Move label');
        checks.appendChild(l1); checks.appendChild(l2); checks.appendChild(moveLabelB);
        panel.appendChild(checks);
        var tabs = el('div', 'ann-tabs');
        var tabFill = el('span', 'sel', 'Fill');
        var tabBorder = el('span', null, 'Border');
        tabFill.addEventListener('click', function () { selectTarget('fill'); });
        tabBorder.addEventListener('click', function () { selectTarget('border'); });
        tabs.appendChild(tabFill); tabs.appendChild(tabBorder);
        panel.appendChild(tabs);
        var srow = el('div', 'ann-sliderrow');
        var slbl = el('span', 'lbl', 'Opacity');
        var slider = document.createElement('input');
        slider.type = 'range';
        srow.appendChild(slbl); srow.appendChild(slider);
        panel.appendChild(srow);
        var swatches = el('div', 'ann-swatches');
        panel.appendChild(swatches);
        document.body.appendChild(panel);

        var populating = false;
        function paintSwatches() {
            swatches.innerHTML = '';
            var current = target === 'fill' ? area.color : area.borderColor;
            PALETTE.forEach(function (pair) {
                var s = el('div', 'ann-swatch' + (pair[1] === current ? ' sel' : ''));
                s.style.background = cssColor(pair[1]);
                s.addEventListener('click', function () {
                    if (target === 'fill') area.color = pair[1]; else area.borderColor = pair[1];
                    liveRestyle();
                    commit();
                    paintSwatches();
                });
                swatches.appendChild(s);
            });
        }
        function selectTarget(t) {
            target = t;
            tabFill.classList.toggle('sel', t === 'fill');
            tabBorder.classList.toggle('sel', t === 'border');
            slbl.textContent = t === 'fill' ? 'Opacity' : 'Thickness';
            populating = true;
            if (t === 'fill') { slider.min = 0; slider.max = 100; slider.value = Math.round(area.fillOpacity * 100); }
            else { slider.min = 1; slider.max = MAX_BORDER; slider.value = Math.max(1, Math.min(MAX_BORDER, Math.round(area.borderWidthDp))); }
            populating = false;
            paintSwatches();
        }
        function refreshPanel() {
            nameEl.classList.toggle('drawing', drawing);
            nameEl.textContent = !drawing ? (displayName(area) + ' · ' + fmtArea(areaSqm(area)))
                : area.points.length === 0 ? 'Tap the map to place corners'
                : area.points.length === 1 ? '1 corner — keep tapping'
                : area.points.length === 2 ? '2 corners — one more needed'
                : area.points.length + ' corners — tap Done to finish';
            doneB.disabled = drawing && area.points.length < 3;
            doneB.style.opacity = doneB.disabled ? 0.4 : 1;
            populating = true;
            showLabelCb.checked = area.showLabel;
            showAreaCb.checked = area.showArea;
            populating = false;
            undoB.style.opacity = editor && editor.hasUndo() ? 1 : 0.4;
        }

        function livePolygon() {
            var h = layer.handles.get(area.id);
            return h ? h.polygon : tempPoly;
        }
        function liveRestyle() {
            var p = livePolygon();
            if (p) p.setOptions({
                strokeColor: cssColor(area.borderColor), strokeWeight: area.borderWidthDp,
                fillColor: cssColor(area.color), fillOpacity: area.fillOpacity
            });
        }
        function liveReshape() {
            var p = livePolygon();
            if (p) p.setPath(area.points);
            layer.refreshCaption(area.id);
            refreshPanel();
        }
        function commit() {
            // Until the ring closes, the tapped points live in the draft; once the
            // annotation is real, the annotation itself is the persistence and a
            // surviving draft would resume into a duplicate.
            if (!addedToLayer) draftSave('area', area.points);
            else layer.persist();
        }
        function ensureOnMap() {
            // The moment the ring closes (3 corners) it becomes a real annotation.
            if (addedToLayer || area.points.length < 3) {
                if (!addedToLayer && area.points.length >= 2 && !tempPoly) {
                    tempPoly = new google.maps.Polygon({
                        paths: area.points, map: map,
                        strokeColor: cssColor(area.borderColor), strokeWeight: area.borderWidthDp,
                        fillColor: cssColor(area.color), fillOpacity: area.fillOpacity,
                        zIndex: 200000, clickable: false
                    });
                }
                return;
            }
            if (tempPoly) { tempPoly.setMap(null); tempPoly = null; }
            addedToLayer = true;
            layer.add(area);
            draftClear();
        }

        slider.addEventListener('input', function () {
            if (populating) return;
            if (target === 'fill') area.fillOpacity = slider.value / 100;
            else area.borderWidthDp = Math.max(1, +slider.value);
            liveRestyle();
        });
        slider.addEventListener('change', commit);
        showLabelCb.addEventListener('change', function () {
            if (populating) return;
            area.showLabel = showLabelCb.checked;
            layer.refreshCaption(area.id); commit();
        });
        showAreaCb.addEventListener('change', function () {
            if (populating) return;
            area.showArea = showAreaCb.checked;
            layer.refreshCaption(area.id); commit();
        });
        renameB.addEventListener('click', function () {
            promptName('Region name', area.label, function (name) {
                area.label = name;
                layer.refreshCaption(area.id);
                refreshPanel(); commit();
            });
        });
        undoB.addEventListener('click', function () {
            if (editor && editor.undo()) { liveReshape(); }
        });
        delB.addEventListener('click', function () {
            confirmDialog('Delete this region?',
                displayName(area) + ' will be removed from the map and the plan.', 'Delete',
                function () {
                    if (addedToLayer) layer.remove(area.id);
                    draftClear();
                    exitMode();
                });
        });
        moveLabelB.addEventListener('click', function () {
            if (area.points.length < 3) return;
            panel.style.display = 'none';
            startCaptionPlacement(area, function () { panel.style.display = ''; });
        });
        doneB.addEventListener('click', function () {
            if (drawing) {
                if (area.points.length < 3) return;
                drawing = false;
                if (area.labelZoom <= 0) area.labelZoom = map.getZoom();   // caption ground-pins now
                draftClear();
                if (clickL) { google.maps.event.removeListener(clickL); clickL = null; }
                map.setOptions({ draggableCursor: null });
                layer.update(area);
                refreshPanel();
                return;
            }
            exitMode();
        });

        if (drawing) {
            map.setOptions({ draggableCursor: 'crosshair', disableDoubleClickZoom: true });
            clickL = map.addListener('click', function (e) {
                if (editor) editor.pushUndo();
                area.points.push({ lat: e.latLng.lat(), lng: e.latLng.lng() });
                ensureOnMap();
                liveReshape();
                if (editor) editor.rebuild();
                commit();
                refreshPanel();
            });
            if (resumeDraft) {
                resumeDraft.forEach(function (p) { area.points.push(p); });
                ensureOnMap();
                liveReshape();
            }
        }

        editor = mkVertexEditor({
            points: area.points, closed: true, minPoints: 3, noun: 'region',
            onLiveChange: liveReshape,
            onCommit: function () { commit(); if (addedToLayer) layer.update(area); editorSafeRebuildCaption(); }
        });
        function editorSafeRebuildCaption() { layer.refreshCaption(area.id); }

        // While the editor is up the layer polygon stays; suppress its caption taps
        // conflicting is unnecessary — options sheet won't open because editing UI
        // sits above; a map click just adds corners (drawing) or is ignored.
        selectTarget('fill');
        refreshPanel();

        enterMode(function close() {
            if (clickL) google.maps.event.removeListener(clickL);
            map.setOptions({ draggableCursor: null, disableDoubleClickZoom: false });
            if (editor) editor.teardown();
            if (tempPoly) tempPoly.setMap(null);
            if (panel.parentNode) panel.parentNode.removeChild(panel);
            if (addedToLayer) {
                if (area.labelZoom <= 0) area.labelZoom = map.getZoom();
                draftClear();                     // the annotation is the persistence now
                layer.update(area);
            } else if (area.points.length) {
                draftSave('area', area.points);   // unfinished ring survives (Draft)
            }
        });
    }

    // Move / resize / rotate an area's caption — the text placement surface worn
    // by the caption (labelScale / labelRotation / labelPosition / labelZoom).
    function startCaptionPlacement(area, onClosed) {
        var caption = '';
        if (area.showLabel) caption = (area.label || '').trim();
        if (area.showArea && area.points.length >= 3) caption += (caption ? '\n' : '') + fmtArea(areaSqm(area));
        if (!caption) { toast('Turn on the name or the area first'); if (onClosed) onClosed(); return; }
        // A lightweight reuse of the placement surface via a text stand-in object.
        var stand = {
            id: area.id, kind: 'text', text: caption, centered: true,
            lat: captionAnchor(area).lat, lng: captionAnchor(area).lng,
            scale: area.labelScale, rotation: area.labelRotation,
            placementZoom: layer.captionZoom(area.labelZoom), visible: area.visible
        };
        var h = layer.handles.get(area.id);
        if (h && h.stamp) h.stamp.setShown(false);
        startTextPlacementRaw(stand, function (committed) {
            if (committed) {
                area.labelLat = stand.lat; area.labelLng = stand.lng;
                area.labelScale = stand.scale; area.labelRotation = stand.rotation;
                area.labelZoom = stand.placementZoom;
                layer.update(area);
            } else if (h && h.stamp) {
                h.stamp.setShown(area.visible);
            }
            if (onClosed) onClosed();
        });
    }
    // The placement surface with the commit redirected: the caption flow needs the
    // raw numbers back (labelScale / labelRotation / labelPosition), not a Text
    // annotation written into the layer. startTextPlacement's commit path calls
    // layer.update(existing); intercepting that one call for the stand-in object is
    // what turns the same surface into a caption mover.
    function startTextPlacementRaw(stand, report) {
        if (placementOpen) { report(false); return; }
        var committed = false;
        var origUpd = layer.update;
        layer.update = function (a) {
            if (a === stand) committed = true;    // the surface already wrote into `stand`
            else origUpd.call(layer, a);
        };
        startTextPlacement(stand.text, stand.centered, stand);
        var t = setInterval(function () {         // restore the layer API once it closes
            if (!placementOpen) {
                clearInterval(t);
                layer.update = origUpd;
                report(committed);
            }
        }, 120);
    }

    function promptName(title, current, onSave) {
        var scrim = mkScrim(true);
        var d = el('div', 'ann-dialog');
        addCloseX(d, scrim);
        d.appendChild(el('h3', null, title));
        var input = document.createElement('input');
        input.type = 'text';
        input.value = current || '';
        input.placeholder = 'Name it';
        d.appendChild(input);
        function save() {
            closeScrim(scrim);
            onSave(input.value.trim());
        }
        // Enter commits — the owner typed a name and fumbled to save it; the
        // keyboard's own confirm must work, not just the button.
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
        });
        var row = el('div', 'ann-btnrow');
        row.appendChild(btn('Cancel', null, function () { closeScrim(scrim); }));
        row.appendChild(btn('OK', 'ann-primary', save));
        d.appendChild(row);
        scrim.appendChild(d);
        setTimeout(function () { input.focus(); input.select(); }, 50);
    }

    // -------------------------------------------------------------- road editor
    function openRoadEditor(road) {
        exitMode();
        var panel = el('div', 'ann-panel');
        var prow = el('div', 'ann-prow');
        var nameEl = el('span', 'ann-pname');
        var renameB = el('button', 'ann-iconbtn', '✏️');
        var undoB = el('button', 'ann-iconbtn', '↶');
        var delB = el('button', 'ann-iconbtn', '🗑️');
        var doneB = el('button', 'ann-pill', 'Done');
        doneB.style.background = '#2E7D32';
        prow.appendChild(nameEl); prow.appendChild(renameB); prow.appendChild(undoB);
        prow.appendChild(delB); prow.appendChild(doneB);
        panel.appendChild(prow);
        var checks = el('div', 'ann-checks');
        var showLabelCb = document.createElement('input'); showLabelCb.type = 'checkbox';
        var showLenCb = document.createElement('input'); showLenCb.type = 'checkbox';
        var l1 = el('label'); l1.appendChild(showLabelCb); l1.appendChild(document.createTextNode('Show name'));
        var l2 = el('label'); l2.appendChild(showLenCb); l2.appendChild(document.createTextNode('Show length'));
        checks.appendChild(l1); checks.appendChild(l2);
        panel.appendChild(checks);
        var srow = el('div', 'ann-sliderrow');
        srow.appendChild(el('span', 'lbl', 'Thickness'));
        var slider = document.createElement('input');
        slider.type = 'range'; slider.min = 2; slider.max = MAX_ROAD_WIDTH;
        srow.appendChild(slider);
        panel.appendChild(srow);
        var swatches = el('div', 'ann-swatches');
        panel.appendChild(swatches);
        document.body.appendChild(panel);

        var populating = false;
        function paintSwatches() {
            swatches.innerHTML = '';
            PALETTE.forEach(function (pair) {
                var s = el('div', 'ann-swatch' + (pair[1] === road.color ? ' sel' : ''));
                s.style.background = cssColor(pair[1]);
                s.addEventListener('click', function () {
                    road.color = pair[1];
                    layer.restyleRoad(road.id);
                    layer.persist();
                    paintSwatches();
                });
                swatches.appendChild(s);
            });
        }
        function refreshPanel() {
            nameEl.textContent = displayName(road) + ' · ' + fmtLength(roadLen(road));
            populating = true;
            showLabelCb.checked = road.showLabel;
            showLenCb.checked = road.showLength;
            slider.value = Math.max(2, Math.min(MAX_ROAD_WIDTH, Math.round(road.widthDp)));
            populating = false;
            undoB.style.opacity = editor.hasUndo() ? 1 : 0.4;
            paintSwatches();
        }
        slider.addEventListener('input', function () {
            if (populating) return;
            road.widthDp = Math.max(2, +slider.value);
            layer.restyleRoad(road.id);
        });
        slider.addEventListener('change', function () { layer.persist(); });
        showLabelCb.addEventListener('change', function () {
            if (populating) return;
            road.showLabel = showLabelCb.checked;
            layer.refreshCaption(road.id); layer.persist();
        });
        showLenCb.addEventListener('change', function () {
            if (populating) return;
            road.showLength = showLenCb.checked;
            layer.refreshCaption(road.id); layer.persist();
        });
        renameB.addEventListener('click', function () {
            promptName('Road name', road.label, function (name) {
                road.label = name;
                layer.refreshCaption(road.id);
                refreshPanel(); layer.persist();
            });
        });
        delB.addEventListener('click', function () {
            confirmDialog('Delete this road?',
                displayName(road) + ' will be removed from the map and the plan.', 'Delete',
                function () { layer.remove(road.id); exitMode(); });
        });
        undoB.addEventListener('click', function () {
            if (editor.undo()) { layer.reshapeRoad(road.id); refreshPanel(); }
        });
        doneB.addEventListener('click', exitMode);

        var editor = mkVertexEditor({
            points: road.points, closed: false, minPoints: 2, noun: 'road',
            onLiveChange: function () { layer.reshapeRoad(road.id); refreshPanel(); },
            onCommit: function () { layer.update(road); }
        });
        refreshPanel();

        enterMode(function close() {
            editor.teardown();
            if (panel.parentNode) panel.parentNode.removeChild(panel);
            layer.update(road);
        });
    }

    // ------------------------------------------------------- road drawing (bar)
    // Tap the map to drop joints, watch the length build, then finish and name it.
    // Every tap is written to the draft — survey work must survive a phone call.
    function startRoadDrawing(resumePoints) {
        exitMode();
        var points = (resumePoints || []).slice();
        var vertexMarkers = [];
        var polylines = [];
        var clickL;

        var bar = el('div', 'ann-bar');
        var readout = el('span', 'ann-readout', 'Tap the map to start');
        var cancelB = el('button', 'ann-pill', 'Cancel'); cancelB.style.background = '#9E9E9E';
        var undoB = el('button', 'ann-pill', 'Undo'); undoB.style.background = '#616161';
        var doneB = el('button', 'ann-pill', 'Done'); doneB.style.background = '#2E7D32';
        bar.appendChild(readout); bar.appendChild(cancelB); bar.appendChild(undoB); bar.appendChild(doneB);
        document.body.appendChild(bar);

        function redraw() {
            polylines.forEach(function (p) { p.setMap(null); });
            polylines = [];
            if (points.length >= 2) {
                // The finished road's own look, live from the second tap.
                roadLayers(DEFAULT_ROAD, ROAD_WIDTH).forEach(function (l, i) {
                    polylines.push(new google.maps.Polyline(polylineOptsFor(l, points, 200000 + i * 0.2, 1)));
                });
            }
            readout.textContent =
                points.length === 0 ? 'Tap the map to start' :
                points.length === 1 ? '1 of 2 points' : fmtLength(sphLength(points));
            doneB.disabled = points.length < 2;
            doneB.style.opacity = points.length < 2 ? 0.4 : 1;
            undoB.style.opacity = points.length ? 1 : 0.4;
        }
        function addPoint(p, persist) {
            points.push(p);
            var m = new google.maps.Marker({
                position: p, map: map, zIndex: 200002, draggable: true, clickable: true,
                icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#F44336',
                        fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
            });
            m._idx = points.length - 1;
            // Same affordance as everywhere else vertices appear (Android parity):
            // drag the dot directly, or tap it for the orange move disc + × delete.
            m.addListener('drag', function () {
                var ll = m.getPosition();
                points[m._idx] = { lat: ll.lat(), lng: ll.lng() };
                redraw();
            });
            m.addListener('dragend', function () { draftSave('road', points); });
            m.addListener('click', function () {
                if (typeof showVertexHandle !== 'function') return;
                showVertexHandle(m, {
                    isSaved: false,
                    onMove: function (latLng) {
                        points[m._idx] = { lat: latLng.lat(), lng: latLng.lng() };
                        redraw();
                    },
                    onMoveEnd: function () { draftSave('road', points); },
                    onDelete: function () {
                        points.splice(m._idx, 1);
                        var rm = vertexMarkers.splice(m._idx, 1)[0];
                        if (rm) rm.setMap(null);
                        vertexMarkers.forEach(function (vm, i) { vm._idx = i; });
                        if (typeof hideVertexHandle === 'function') hideVertexHandle();
                        redraw();
                        draftSave('road', points);
                    }
                });
            });
            vertexMarkers.push(m);
            redraw();
            if (persist) draftSave('road', points);
        }
        map.setOptions({ draggableCursor: 'crosshair', disableDoubleClickZoom: true });
        clickL = map.addListener('click', function (e) {
            addPoint({ lat: e.latLng.lat(), lng: e.latLng.lng() }, true);
        });
        // Points already tapped in an earlier session, put back on the map.
        points = [];
        (resumePoints || []).forEach(function (p) { addPoint(p, false); });
        redraw();

        cancelB.addEventListener('click', function () { exitMode(); });   // draft stays on disk
        undoB.addEventListener('click', function () {
            if (!points.length) return;
            if (typeof hideVertexHandle === 'function') hideVertexHandle();
            points.pop();
            var m = vertexMarkers.pop();
            if (m) m.setMap(null);
            redraw();
            draftSave('road', points);
        });
        doneB.addEventListener('click', function () {
            if (points.length < 2) return;
            var result = points.slice();
            draftClear();
            exitMode();
            describeShapeDialog('Road', 'length',
                { label: '', color: DEFAULT_ROAD, showMeasurement: true },
                function (label, color, showLength) {
                    if (layer.isFull()) { toast('That is as many notes as one map can hold'); return; }
                    layer.add({
                        id: newId(), kind: 'road', visible: true, order: 0,
                        points: result, label: label, color: color, widthDp: ROAD_WIDTH,
                        showLabel: true, showLength: showLength, labelZoom: map.getZoom()
                    });
                    toast('Road added — tap it any time to edit');
                });
        });

        enterMode(function close() {
            if (clickL) google.maps.event.removeListener(clickL);
            if (typeof hideVertexHandle === 'function') hideVertexHandle();
            map.setOptions({ draggableCursor: null, disableDoubleClickZoom: false });
            vertexMarkers.forEach(function (m) { m.setMap(null); });
            polylines.forEach(function (p) { p.setMap(null); });
            if (bar.parentNode) bar.parentNode.removeChild(bar);
        });
    }

    // ------------------------------------------------------------- marker flow
    function startAddMarker() {
        if (layer.isFull()) { toast('That is as many notes as one map can hold'); return; }
        stopHostMeasure();
        pickMarkerDialog(null, function (typeId, label, dropLatLng) {
            var c = dropLatLng || (function () {
                var m = map.getCenter();
                return { lat: m.lat(), lng: m.lng() };
            })();
            var pin = {
                id: newId(), kind: 'pin', visible: true, order: 0,
                lat: c.lat, lng: c.lng, typeId: typeId, label: label
            };
            layer.add(pin);
            // Named on the ground, not in the picker: the marker is already visible
            // where it landed, so the user knows what they are naming.
            promptName('Name this place (optional)', '', function (name) {
                if (name) { pin.label = name; layer.update(pin); }
            });
            toast(dropLatLng ? 'Marker placed — drag it to fine-tune'
                             : 'Marker placed at the centre — drag it to fine-tune');
        }, function () { openSheet(); });   // ‹ Back returns to the annotate sheet
    }

    function startAddText() {
        if (layer.isFull()) { toast('That is as many notes as one map can hold'); return; }
        stopHostMeasure();
        composeTextDialog(null, function (text, centered) {
            startTextPlacement(text, centered, null);
        }, function () { openSheet(); });   // ‹ Back returns to the annotate sheet
    }

    // ------------------------------------------------------------ layers panel
    var layersPanelRefresh = null;
    var sheetCountRefresh = null;   // the annotate sheet's "N on this map" line
    function refreshOpenPanels() {
        if (layersPanelRefresh) layersPanelRefresh();
        if (sheetCountRefresh) sheetCountRefresh();
    }

    // ----- undo / redo: whole-model snapshots (the serialized store payload),
    // pushed on every committed change. Cheap — a few KB of JSON per step.
    var HIST_MAX = 50;
    var hist = [], histIndex = -1, histSuppress = false;
    function histPush(payload) {
        if (histSuppress) return;
        if (histIndex >= 0 && hist[histIndex] === payload) return;   // no-op change
        hist = hist.slice(0, histIndex + 1);
        hist.push(payload);
        if (hist.length > HIST_MAX) hist.shift();
        histIndex = hist.length - 1;
        histButtonsSync();
    }
    function histApply(payload) {
        // Replace the store wholesale, then rebuild the layer exactly the way a
        // fresh restore does — geographic scoping included.
        histSuppress = true;
        try {
            lsSet(LS_ITEMS, payload);
            layer.handles.forEach(function (h) { layer.detach(h); });
            layer.handles.clear();
            layer.dormant = [];
            layer.restored = false;
            var c = map.getCenter();
            layer.restoreIfNeeded(map.getZoom(), { lat: c.lat(), lng: c.lng() });
        } finally {
            histSuppress = false;
        }
        refreshOpenPanels();
        histButtonsSync();
    }
    function annUndo() {
        // The editors keep their own point-level undo while they are open; the
        // global history only moves between committed states.
        if (activeMode || placementOpen) { toast('Finish the current edit first'); return; }
        if (histIndex <= 0) return;
        histIndex--;
        histApply(hist[histIndex]);
    }
    function annRedo() {
        if (activeMode || placementOpen) { toast('Finish the current edit first'); return; }
        if (histIndex >= hist.length - 1) return;
        histIndex++;
        histApply(hist[histIndex]);
    }
    var histUndoB = null, histRedoB = null;   // the dock's buttons, when it is open
    // The always-available pair: a floating ↶↷ bar bottom-left of the map that
    // appears the moment there is anything to undo or redo, whatever tool the
    // user is in — not only inside the dock.
    var histBar = null, histBarU = null, histBarR = null;
    function ensureHistBar() {
        if (histBar) return;
        histBar = el('div', 'ann-histbar');
        histBarU = el('button', 'ann-histbtn', '↶');
        histBarU.title = 'Undo annotation change (Ctrl+Z)';
        histBarU.addEventListener('click', annUndo);
        histBarR = el('button', 'ann-histbtn', '↷');
        histBarR.title = 'Redo (Ctrl+Y)';
        histBarR.addEventListener('click', annRedo);
        histBar.appendChild(histBarU);
        histBar.appendChild(histBarR);
        document.body.appendChild(histBar);
    }
    function histButtonsSync() {
        var canU = histIndex > 0, canR = histIndex < hist.length - 1;
        if (histUndoB) histUndoB.style.opacity = canU ? 1 : 0.35;
        if (histRedoB) histRedoB.style.opacity = canR ? 1 : 0.35;
        if (histBar) {
            histBar.style.display = (canU || canR) && !layer.suspended ? 'flex' : 'none';
            histBarU.style.opacity = canU ? 1 : 0.35;
            histBarR.style.opacity = canR ? 1 : 0.35;
        }
    }

    // ----- "load your previous annotations?" — saved work near this map is
    // offered back rather than silently re-attached. Declined items stay in
    // layer.dormant (so nothing can delete them) and remain loadable from the
    // My-annotations panel for the rest of the session.
    var restoreOffer = null, restoreDeclined = [];
    function loadPreviousAnnotations(items) {
        items.forEach(function (a) {
            var i = layer.dormant.indexOf(a);
            if (i >= 0) layer.dormant.splice(i, 1);
            layer.attach(a);
        });
        layer.renumber();
        layer.applyZoom(map.getZoom());
        refreshOpenPanels();
        toast(items.length + ' previous annotation' + (items.length > 1 ? 's' : '') + ' loaded');
    }
    function offerPreviousAnnotations() {
        var items = restoreOffer;
        restoreOffer = null;
        if (!items || !items.length) return;
        var scrim = mkScrim(true);
        var d = el('div', 'ann-dialog');
        d.appendChild(el('h3', null, 'Load your previous annotations?'));
        var p = el('p', null, items.length + ' saved annotation' + (items.length > 1 ? 's' : '') +
            ' found for this area — put them back on the map?');
        p.style.cssText = 'font-size:13px;color:#555;margin:0;line-height:1.5;';
        d.appendChild(p);
        var row = el('div', 'ann-btnrow');
        row.appendChild(btn('Not now', null, function () {
            closeScrim(scrim);
            restoreDeclined = items;             // still loadable from the panel
            refreshOpenPanels();
        }));
        row.appendChild(btn('Load', 'ann-primary', function () {
            closeScrim(scrim);
            loadPreviousAnnotations(items);
        }));
        d.appendChild(row);
        scrim.appendChild(d);
    }

    // ----- "My annotations" dock: a floating panel that EXPANDS out of the
    // #btn-my-annotations fab (sitting above the map-layers fab) and shrinks back
    // into it — the web's version of the Android layers bottom sheet. Non-modal:
    // the map stays live beside it.
    var dockEl = null, dockClosing = null, dockLastToggle = 0;
    function toggleLayersDock() {
        if (!ensureInit()) { toast('Map still loading — try again in a moment'); return; }
        // A double-click is one intent, not open-then-instantly-close.
        var now = Date.now();
        if (now - dockLastToggle < 350) return;
        dockLastToggle = now;
        if (dockEl) collapseLayersDock(); else expandLayersDock();
    }
    function expandLayersDock() {
        if (dockEl) return;
        var fab = document.getElementById('btn-my-annotations') || document.getElementById('btn-layers');
        var r = fab ? fab.getBoundingClientRect()
                    : { left: window.innerWidth - 8, top: 120, height: 48 };
        var d = el('div', 'ann-dock');
        var head = el('div', 'ann-dock-head');
        var title = el('h3', null, 'On this plan');
        histUndoB = el('button', 'ann-iconbtn', '↶');
        histUndoB.title = 'Undo';
        histUndoB.addEventListener('click', annUndo);
        histRedoB = el('button', 'ann-iconbtn', '↷');
        histRedoB.title = 'Redo';
        histRedoB.addEventListener('click', annRedo);
        var collapseB = el('button', 'ann-iconbtn', '×');
        collapseB.style.fontSize = '22px';
        collapseB.addEventListener('click', collapseLayersDock);
        head.appendChild(title);
        head.appendChild(histUndoB); head.appendChild(histRedoB);
        head.appendChild(collapseB);
        histButtonsSync();
        d.appendChild(head);
        var body = el('div', 'ann-dock-body');
        d.appendChild(body);
        // To the LEFT of the fab column, top-aligned with the button, clamped so
        // the whole panel stays on screen; the transform origin sits level with
        // the button so it visibly grows out of it and shrinks back into it.
        var maxH = Math.min(Math.round(window.innerHeight * 0.55), 480);
        var top = Math.max(12, Math.min(r.top, window.innerHeight - maxH - 12));
        d.style.right = (window.innerWidth - r.left + 10) + 'px';
        d.style.top = top + 'px';
        d.style.maxHeight = maxH + 'px';
        d.style.transformOrigin = '100% ' + Math.max(16, r.top - top + r.height / 2) + 'px';
        document.body.appendChild(d);
        var refresh = buildLayersUI(body, collapseLayersDock);
        layersPanelRefresh = refresh;
        refresh();
        dockEl = d;
        requestAnimationFrame(function () {
            requestAnimationFrame(function () { d.classList.add('open'); });
        });
    }
    function collapseLayersDock() {
        var d = dockEl;
        if (!d) return;
        dockEl = null;
        layersPanelRefresh = null;
        histUndoB = null; histRedoB = null;
        d.classList.remove('open');            // shrink back into the button
        clearTimeout(dockClosing);
        dockClosing = setTimeout(function () {
            if (d.parentNode) d.parentNode.removeChild(d);
        }, 220);
    }
    // The annotate sheet's "My annotations" row keeps working through this name.
    function openLayersPanel() { expandLayersDock(); }

    // The panel body. closeHost() hides the hosting surface before an action
    // (focus, edit, resume) takes over the map.
    function buildLayersUI(d, closeHost) {
        var sub = el('p', 'ann-sub');
        d.appendChild(sub);
        var draftHost = el('div');
        d.appendChild(draftHost);
        var listHost = el('div');
        d.appendChild(listHost);
        var clearRow = el('div', 'ann-btnrow');
        var clearB = btn('Delete all', 'ann-danger', function () {
            confirmDialog('Remove everything on this map?',
                'All ' + layer.handles.size + ' labels, markers, areas and roads you placed here will be deleted.',
                'Delete all',
                function () { layer.clearAll(); closeHost(); });
        });
        clearRow.appendChild(clearB);
        d.appendChild(clearRow);

        function iconFor(a) {
            if (a.kind === 'text') return '🔤';
            if (a.kind === 'pin') return typeOf(a.typeId).emoji || '📍';
            if (a.kind === 'area') return '⭕';
            return '〰️';
        }
        function metaFor(a) {
            if (a.kind === 'text') {
                var lines = a.text.split('\n').length;
                return 'Text' + (lines > 1 ? ' · ' + lines + ' lines' : '') +
                       (Math.round(a.rotation) ? ' · ' + Math.round(a.rotation) + '°' : '');
            }
            if (a.kind === 'pin') return typeOf(a.typeId).name;
            if (a.kind === 'area') return 'Area · ' + fmtArea(areaSqm(a));
            return 'Road · ' + fmtLength(roadLen(a));
        }
        function refresh() {
            var items = layer.annotations().sort(function (a, b) { return b.order - a.order; });
            var hidden = items.filter(function (a) { return !a.visible; }).length;
            sub.textContent = !items.length ? 'Nothing added yet — use Annotate to add labels, markers, areas and roads'
                : hidden === 0 ? items.length + ' on the plan · drag ☰ to restack'
                : (items.length - hidden) + ' on the plan · ' + hidden + ' hidden';
            clearB.style.display = items.length ? '' : 'none';

            draftHost.innerHTML = '';
            // Previous annotations the user chose not to load yet — second chance.
            if (restoreDeclined.length) {
                var prevRow = el('div', 'ann-draft');
                prevRow.appendChild(el('span', null, restoreDeclined.length + ' previous annotation' +
                    (restoreDeclined.length > 1 ? 's' : '') + ' not loaded'));
                var loadB = btn('Load', 'ann-primary', function () {
                    var items = restoreDeclined;
                    restoreDeclined = [];
                    loadPreviousAnnotations(items);
                });
                loadB.style.marginLeft = 'auto';
                prevRow.appendChild(loadB);
                draftHost.appendChild(prevRow);
            }
            var draft = draftLoad();
            if (draft && !activeMode) {
                var noun = draft.kind === 'road' ? 'road' : 'area';
                var row = el('div', 'ann-draft');
                row.appendChild(el('span', null, 'Unfinished ' + noun + ' · ' + draft.points.length + ' points saved'));
                var res = btn('Resume', 'ann-primary', function () {
                    closeHost();
                    if (draft.kind === 'road') startRoadDrawing(draft.points);
                    else openRegionEditor(mkNewArea(), true, draft.points);
                });
                res.style.marginLeft = 'auto';
                var disc = el('button', 'ann-iconbtn', '🗑️');
                disc.addEventListener('click', function () {
                    confirmDialog('Discard the unfinished ' + noun + '?',
                        'The ' + draft.points.length + ' points you tapped will be deleted.', 'Discard',
                        function () { draftClear(); refresh(); });
                });
                row.appendChild(res); row.appendChild(disc);
                draftHost.appendChild(row);
            }

            listHost.innerHTML = '';
            items.forEach(function (a) {
                var row = el('div', 'ann-lrow' + (a.visible ? '' : ' hidden'));
                row._id = a.id;
                var drag = el('span', 'drag', '☰');
                var ic = el('span', 'ic', iconFor(a));
                if (a.kind === 'area' || a.kind === 'road') ic.style.color = cssColor(a.color);
                var nm = el('div', 'nm');
                nm.appendChild(el('div', 't', displayName(a)));
                nm.appendChild(el('div', 'm', metaFor(a)));
                var eye = el('button', null, a.visible ? '👁️' : '🚫');
                eye.title = a.visible ? 'Hide from the plan' : 'Show on the plan';
                eye.addEventListener('click', function (e) {
                    e.stopPropagation();
                    layer.setVisible(a.id, !a.visible);
                });
                var edit = el('button', null, '✏️');
                edit.title = 'Edit';
                edit.addEventListener('click', function (e) {
                    e.stopPropagation();
                    closeHost();
                    openOptions(a);
                });
                var del = el('button', null, '🗑️');
                del.addEventListener('click', function (e) {
                    e.stopPropagation();
                    confirmDialog('Delete ' + displayName(a) + '?',
                        'It will be removed from the map and the plan.', 'Delete',
                        function () { layer.remove(a.id); });
                });
                row.appendChild(drag); row.appendChild(ic); row.appendChild(nm);
                row.appendChild(eye); row.appendChild(edit); row.appendChild(del);
                row.addEventListener('click', function () {
                    closeHost();
                    var an = anchorOf(a);
                    map.panTo(an);
                    if (map.getZoom() < 14) map.setZoom(a.kind === 'text' ? Math.round(a.placementZoom) : 16);
                });
                // Drag-to-restack, touch and mouse alike. Listeners live on the
                // DOCUMENT, deliberately NOT via setPointerCapture on the handle:
                // moving the row with insertBefore re-inserts the captured element,
                // which releases the capture and killed the drag after the first
                // swap. The dragged row FOLLOWS the pointer via transform, and a
                // displaced sibling FLIP-slides into its new slot — no teleporting.
                drag.addEventListener('pointerdown', function (e) {
                    e.preventDefault(); e.stopPropagation();
                    row.classList.add('dragging');
                    row.style.transition = 'none';
                    var startY = e.clientY;
                    function place(clientY) {
                        row.style.transform = 'translateY(' + (clientY - startY) + 'px)';
                    }
                    function flip(sib) {
                        // Slide the displaced sibling from where it WAS to where it IS.
                        var before = sib.getBoundingClientRect().top;
                        return function settle() {
                            var d = before - sib.getBoundingClientRect().top;
                            if (!d) return;
                            sib.style.transition = 'none';
                            sib.style.transform = 'translateY(' + d + 'px)';
                            requestAnimationFrame(function () {
                                sib.style.transition = 'transform .16s ease';
                                sib.style.transform = '';
                            });
                        };
                    }
                    function mv(ev) {
                        ev.preventDefault();
                        // Swap when the pointer crosses a neighbour's midline; the
                        // dragged row's layout slot moves by the neighbour's height,
                        // so startY shifts by the same amount to keep the row glued
                        // to the pointer.
                        for (;;) {
                            var next = row.nextElementSibling, prev = row.previousElementSibling;
                            var nb = next && next.getBoundingClientRect();
                            var pb = prev && prev.getBoundingClientRect();
                            if (nb && ev.clientY > nb.top + nb.height / 2) {
                                var settleN = flip(next);
                                listHost.insertBefore(next, row);
                                settleN();
                                startY += nb.height;
                            } else if (pb && ev.clientY < pb.top + pb.height / 2) {
                                var settleP = flip(prev);
                                listHost.insertBefore(row, prev);
                                settleP();
                                startY -= pb.height;
                            } else break;
                        }
                        place(ev.clientY);
                    }
                    function up() {
                        document.removeEventListener('pointermove', mv);
                        document.removeEventListener('pointerup', up);
                        document.removeEventListener('pointercancel', up);
                        // Settle the dragged row into its slot, then commit. The
                        // panel refresh is suppressed for this commit — the list is
                        // already in the final order, and a rebuild would cut the
                        // settle animation short.
                        row.style.transition = 'transform .16s ease';
                        row.style.transform = '';
                        setTimeout(function () {
                            row.classList.remove('dragging');
                            row.style.transition = '';
                        }, 180);
                        var keep = layersPanelRefresh;
                        layersPanelRefresh = null;
                        layer.applyStackOrder(Array.prototype.map.call(listHost.children, function (r) { return r._id; }));
                        layersPanelRefresh = keep;
                    }
                    document.addEventListener('pointermove', mv, { passive: false });
                    document.addEventListener('pointerup', up);
                    document.addEventListener('pointercancel', up);
                });
                listHost.appendChild(row);
            });
        }
        return refresh;
    }

    function mkNewArea() {
        return {
            id: newId(), kind: 'area', visible: true, order: 0, points: [],
            label: '', color: DEFAULT_AREA, borderColor: DEFAULT_AREA,
            fillOpacity: 0.25, borderWidthDp: 3, showArea: true, showLabel: true,
            labelZoom: 0, labelLat: null, labelLng: null, labelScale: 1.1, labelRotation: 0
        };
    }

    // ------------------------------------------------------------ annotate sheet
    // One chooser for every tool that puts something on the map (AnnotateSheet).
    function openSheet() {
        if (!ensureInit()) { toast('Map still loading — try again in a moment'); return; }
        // A double tap on the Annotate pill must not stack a second copy — if any
        // annotate modal is already up, this one keeps it.
        if (openScrims.length) return;
        var scrim = mkScrim(false);
        var d = el('div', 'ann-sheet');
        addCloseX(d, scrim);
        d.appendChild(el('h3', null, 'Annotate this map'));
        d.appendChild(el('p', 'ann-sub', 'Everything you add is saved and printed with the map'));
        var last = lsGet(LS_LAST_TOOL);
        function tool(id, icon, label, hint, run) {
            var r = el('div', 'ann-row');
            r.appendChild(el('span', 'ann-ic', icon));
            var box = el('div');
            box.appendChild(el('div', null, label));
            var h = el('div', null, hint);
            h.style.cssText = 'font-size:11px;color:#999;';
            box.appendChild(h);
            r.appendChild(box);
            if (last === id) r.appendChild(el('span', 'ann-badge', 'LAST USED'));
            r.addEventListener('click', function () {
                lsSet(LS_LAST_TOOL, id);
                closeScrim(scrim);       // the tool takes over the screen
                run();
            });
            d.appendChild(r);
        }
        d.appendChild(el('div', 'ann-section', 'ADD TO THE PLAN'));
        tool('marker', '📍', 'Marker', 'Pin a place with a named icon', startAddMarker);
        tool('text', '🔤', 'Text', 'Write on the plan — it scales with the map', startAddText);
        tool('area', '⭕', 'Area', 'Outline a plot or site boundary', function () {
            var draft = draftLoad();
            if (draft && draft.kind === 'area') { offerDraft(draft); return; }
            openRegionEditor(mkNewArea(), true);
        });
        tool('road', '〰️', 'Road', 'Trace a road or access route', function () {
            var draft = draftLoad();
            if (draft && draft.kind === 'road') { offerDraft(draft); return; }
            startRoadDrawing();
        });
        d.appendChild(el('div', 'ann-section', 'MEASURE — reads a number, adds nothing'));
        tool('measure_area', '📐', 'Measure area', 'Tap out a shape and read its size', function () {
            if (typeof startMeasureMode === 'function') startMeasureMode('area');
        });
        tool('measure_length', '📏', 'Measure length', 'Tap along a route and read the distance', function () {
            if (typeof startMeasureMode === 'function') startMeasureMode('length');
        });
        var mine = el('div', 'ann-row');
        mine.appendChild(el('span', 'ann-ic', '🗂️'));
        var mbox = el('div');
        mbox.appendChild(el('div', null, 'My annotations'));
        var mh = el('div', null, layer.handles.size + ' on this map');
        mh.style.cssText = 'font-size:11px;color:#999;';
        mbox.appendChild(mh);
        mine.appendChild(mbox);
        mine.addEventListener('click', function () { closeScrim(scrim); openLayersPanel(); });
        d.appendChild(mine);
        // Live count: loading previous annotations (or any change) while the sheet
        // is open must update the line — it used to stay at its opening value.
        sheetCountRefresh = function () { mh.textContent = layer.handles.size + ' on this map'; };
        scrim._onClose = function () { sheetCountRefresh = null; };
        d.appendChild(el('div', 'ann-footnote',
            'Saved in this browser and scoped to this map — notes come back whenever you are near them.'));
        scrim.appendChild(d);
    }
    function offerDraft(draft) {
        var noun = draft.kind === 'road' ? 'road' : 'area';
        var scrim = mkScrim(true);
        var d = el('div', 'ann-dialog');
        addCloseX(d, scrim);
        d.appendChild(el('h3', null, 'Unfinished ' + noun + ' found'));
        var p = el('p', null, draft.points.length + ' points from an earlier session are saved. Continue from where you left off?');
        p.style.cssText = 'font-size:13px;color:#555;margin:0;line-height:1.5;';
        d.appendChild(p);
        var row = el('div', 'ann-btnrow');
        row.appendChild(btn('Start fresh', null, function () {
            closeScrim(scrim);
            if (draft.kind === 'road') startRoadDrawing();
            else openRegionEditor(mkNewArea(), true);
        }));
        row.appendChild(btn('Resume', 'ann-primary', function () {
            closeScrim(scrim);
            if (draft.kind === 'road') startRoadDrawing(draft.points);
            else openRegionEditor(mkNewArea(), true, draft.points);
        }));
        d.appendChild(row);
        scrim.appendChild(d);
    }

    // --------------------------------------------- capture + export integration
    function computeScreenScale(hCssOverride) {
        var box = document.getElementById('dlmap-viewfinder-box');
        var boxH = hCssOverride || (box ? box.offsetHeight : 0);
        var vh = vpH();
        return boxH > 0 && vh > 0 ? boxH / vh : 1;
    }
    var captureActive = false;
    function beginCapturePreview() {
        if (!initDone || captureActive) return;
        captureActive = true;
        layer.beginCapturePreview(computeScreenScale());
        histButtonsSync();               // the ↶↷ bar steps aside for the viewfinder
    }
    function refreshCapturePreview() {
        if (!initDone || !captureActive) return;
        layer.rebuildStandIns(computeScreenScale());
    }
    function endCapturePreview() {
        if (!initDone || !captureActive) return;
        captureActive = false;
        layer.endCapturePreview();
        histButtonsSync();
    }

    // Draw the user's annotations onto the FINAL composed sheet, at final-sheet
    // resolution (TileStitchExporter.drawAnnotations with renderScale folded in).
    // Drawing on the stitch instead capped the artwork at stitch resolution, and
    // whenever the compose upscaled (gz capped by MAX_ZOOM_FOR_DP) every marker
    // came out soft — the owner's 2026-08-09 sheet. `fit` is the compose mapping:
    // {dx, dy, scale} of the stitch window into the template.
    // Ground-pinned artwork takes kGround; screen-space artwork also shrinks by
    // the box/viewport ratio so it occupies the same fraction of the sheet it
    // occupied of the box.
    function drawOnSheet(ctx, rect, geo, fit) {
        if (!initDone || !layer.handles.size) return;
        var kGround = Math.pow(2, rect.z - geo.cz) * fit.scale;
        var ss = geo.hCss && vpH() ? geo.hCss / vpH() : 1;
        var k = kGround * ss;
        var worldSize = 256 * Math.pow(2, rect.z);
        function px(lat, lng) {
            var sinY = Math.min(Math.max(Math.sin(rad(lat)), -0.9999), 0.9999);
            return {
                x: fit.dx + ((lng + 180) / 360 * worldSize - rect.left) * fit.scale,
                y: fit.dy + ((0.5 - Math.log((1 + sinY) / (1 - sinY)) / (4 * Math.PI)) * worldSize - rect.top) * fit.scale
            };
        }
        ctx.save();
        // Drawn geometry first, then every bitmap over it — a caption is never
        // buried under the wash of a region drawn after it.
        layer.captureShapes().sort(function (a, b) { return a.order - b.order; }).forEach(function (s) {
            if (s.points.length < 2) return;
            ctx.beginPath();
            s.points.forEach(function (p, i) {
                var q = px(p.lat, p.lng);
                if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
            });
            if (s.closed) {
                ctx.closePath();
                if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
            }
            ctx.strokeStyle = s.stroke;
            ctx.lineWidth = s.strokeWidthPx * k;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.setLineDash(s.dashed ? [DASH_PX * k, GAP_PX * k] : []);
            ctx.stroke();
            ctx.setLineDash([]);
        });
        layer.captureStamps(geo.cz).sort(function (a, b) { return a.order - b.order; }).forEach(function (st) {
            var q = px(st.lat, st.lng);
            var w = st.widthPx * (st.groundPinned ? kGround : k);
            if (!isFinite(w) || w <= 0) return;
            var art = st.bmp;
            // The sheet is deeper than the screen: regenerate the artwork at the
            // sheet's resolution instead of stretching screen pixels over it.
            var mag = w / art.w;
            if (mag > 1.05 && st.render) {
                try {
                    var re = st.render(Math.min(Math.ceil(mag), MAX_STAMP_SUPERSAMPLE));
                    if (re && re.w > 0) art = re;
                } catch (e) {}
            }
            var h = w * art.h / art.w;
            var left = q.x - w * st.anchorU;
            var top = q.y - h * st.anchorV;
            var rot = (st.rotation || 0) % 360;
            if (rot) { ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(rad(rot)); ctx.translate(-q.x, -q.y); }
            ctx.drawImage(art.canvas, left, top, w, h);
            if (rot) ctx.restore();
        });
        ctx.restore();
    }

    // ---------------------------------------------------------------------- init
    var initDone = false;
    function ensureInit() {
        if (initDone) return true;
        if (typeof google === 'undefined' || !google.maps || typeof map === 'undefined' || !map) return false;
        injectCss();
        defineOverlayClasses();
        ensureProjHelper();
        ensureHistBar();
        map.addListener('idle', function () {
            var c = map.getCenter();
            layer.restoreIfNeeded(map.getZoom(), { lat: c.lat(), lng: c.lng() });
            if (!layer.suspended) layer.applyZoom(map.getZoom());
        });
        // The map may already be idle — restore now rather than waiting for a pan.
        var c0 = map.getCenter();
        if (c0) {
            layer.restoreIfNeeded(map.getZoom(), { lat: c0.lat(), lng: c0.lng() });
            layer.applyZoom(map.getZoom());
        }
        initDone = true;
        return true;
    }

    // Desktop keyboards: Ctrl/Cmd+Z and Ctrl+Y / Ctrl+Shift+Z — never while the
    // user is typing in a field.
    document.addEventListener('keydown', function (e) {
        if (!initDone || !(e.ctrlKey || e.metaKey)) return;
        var t = e.target && e.target.tagName;
        if (t === 'INPUT' || t === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
        var k = (e.key || '').toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); annUndo(); }
        else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); annRedo(); }
    });

    window.mmAnnotations = {
        openSheet: openSheet,
        openLayersPanel: openLayersPanel,
        toggleLayersDock: toggleLayersDock,
        undo: annUndo,
        redo: annRedo,
        beginCapturePreview: beginCapturePreview,
        refreshCapturePreview: refreshCapturePreview,
        endCapturePreview: endCapturePreview,
        drawOnSheet: drawOnSheet,
        count: function () { return initDone ? layer.handles.size : 0; }
    };
    ensureInit();
})();
