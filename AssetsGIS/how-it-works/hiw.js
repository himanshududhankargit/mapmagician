/* "How Development Plan GIS works" card for the homepage carousel (#gisScreenshots).
 *
 * The magician walks in with the rolled-up Development Plan, unrolls it over the satellite, fires the GPS pins,
 * rolls the opacity slider and zooms to a plot. Everything is drawn on a 320x640 stage scaled to the card and
 * rendered by one stateless function, render(t), for t in a 14.5 s loop, so any moment can be shown with seek(t).
 * It ends by turning the magician into the MapMagician logo (his head is the logo's head, so only the body changes).
 *
 * Imagery: PMRDA captures from the live map (z13 satellite + plan, z15 close-up matched to the z13 frame) and, for the
 * last close-up, the plan's own z18 tiles (Wagholi + Loni Kalbhor North) laid over the z17 capture.
 * World coordinates are the z13 capture's device pixels, offset to the crop (crop origin 500,205).
 * Runs only while the card is on screen; prefers-reduced-motion gets one still frame.
 */
(function () {
    'use strict';
    var root = document.getElementById('mm-hiw');
    if (!root || root.__hiw) return;
    var BASE = root.hasAttribute('data-base') ? root.getAttribute('data-base') : 'AssetsGIS/how-it-works/';   // "" = same folder as the page
    var NS = 'http://www.w3.org/2000/svg';
    var LOOP = 14.5, RESET = 14.1;   // from RESET the world is back at beat 1 while the logo fades out
    var NAVY = '#163141', DEEP = '#0d2230', SAGE = '#73A68A', GOLD = '#FFD54A';

    // ------------------------------------------------------------------ easing + helpers
    function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
    function seg(t, a, b) { return clamp01((t - a) / (b - a)); }
    function lerp(a, b, u) { return a + (b - a) * u; }
    function eio(u) { return u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
    function eo(u) { return 1 - Math.pow(1 - u, 3); }
    function back(u) { var c = 1.6; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2); }
    function pop(u) { return u <= 0 ? 0 : u >= 1 ? 1 : back(u); }
    function rot(x, y, deg) { var r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [x * c - y * s, x * s + y * c]; }
    function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

    // ------------------------------------------------------------------ the walker (side-on, jointed)
    // Geometry matches the storyboard character sheet. Facing right; SVG rotate is clockwise, so forward = negative.
    var SVB = [60, 8, 262, 404], SAX = (155 - 60) / 262, SAY = (401 - 8) / 404;
    var FVB = [140, 36, 316, 384], FAX = (262 - 140) / 316, FAY = (400 - 36) / 384;
    var BH = 150, SW = BH * SVB[2] / SVB[3], FW = BH * FVB[2] / FVB[3];   // base element sizes (stage px)
    var HIP_N = [158, 310], HIP_F = [149, 310], SH_N = [151, 232], SH_F = [160, 230];
    var THIGH = 44, SHIN = 33, UPPER = 37, FORE = 33;
    var HALF = [
        { nt: 26, nk: 2, ft: -20, fk: 12, nu: -24, nf: 8, fu: 24, ff: 36, bob: 0 },     // contact
        { nt: 16, nk: 16, ft: -14, fk: 34, nu: -14, nf: 10, fu: 16, ff: 30, bob: -4 },  // down
        { nt: 2, nk: 4, ft: 10, fk: 58, nu: 0, nf: 14, fu: 2, ff: 20, bob: 3 },         // passing
        { nt: -12, nk: 0, ft: 24, fk: 30, nu: 14, nf: 26, fu: -14, ff: 10, bob: 5 }     // up
    ];
    var CYCLE = HALF.concat(HALF.map(function (p) {
        return { nt: p.ft, nk: p.fk, ft: p.nt, fk: p.nk, nu: p.fu, nf: p.ff, fu: p.nu, ff: p.nf, bob: p.bob };
    }));
    var STAND = { nt: 0, nk: 0, ft: -4, fk: 2, nu: 4, nf: 16, fu: -2, ff: 12, bob: 0 };
    var POINT = { nt: 6, nk: 2, ft: -8, fk: 4, nu: 72, nf: 8, fu: -4, ff: 14, bob: 0 };
    var JOINTS = ['nt', 'nk', 'ft', 'fk', 'nu', 'nf', 'fu', 'ff', 'bob'];
    var WAND_WALK = [44, -14], WAND_AIM = [4, 44];

    function cyclePose(phase) {
        var p = ((phase % 8) + 8) % 8, i = Math.floor(p), f = p - i, a = CYCLE[i], b = CYCLE[(i + 1) % 8], o = {};
        JOINTS.forEach(function (k) { o[k] = lerp(a[k], b[k], f); });
        return o;
    }
    function mix(a, b, u) { var o = {}; JOINTS.forEach(function (k) { o[k] = lerp(a[k], b[k], u); }); return o; }
    function withArms(p, nu, nf, fu, ff) { var o = mix(p, p, 0); o.nu = nu; o.nf = nf; o.fu = fu; o.ff = ff; return o; }

    function legSvg(j, hip, fill, edge) {
        var x = hip[0], y = hip[1], k = y + THIGH, e = edge ? ' stroke="#fff" stroke-width="3"' : '';
        return '<g data-j="' + j + 't"><rect x="' + (x - 12.5) + '" y="' + (y - 8) + '" width="25" height="' + (THIGH + 16) + '" rx="12" fill="' + fill + '"' + e + '/>' +
            '<g data-j="' + j + 'k"><rect x="' + (x - 12) + '" y="' + (k - 10) + '" width="24" height="' + (SHIN + 12) + '" rx="12" fill="' + fill + '"' + e + '/>' +
            '<path d="M' + (x - 16) + ',' + (k + SHIN - 3) + ' l30,0 c16,0 24,8 24,16 l0,5 l-54,0 z" fill="' + fill + '"' + e + '/></g></g>';
    }
    function armSvg(j, sh, fill, edge, wand) {
        var x = sh[0], y = sh[1], el = y + UPPER, wr = el + FORE, e = edge ? ' stroke="#fff" stroke-width="3"' : '';
        var w = wand ? '<line data-w="0" stroke="#fff" stroke-width="12" stroke-linecap="round"/><line data-w="1" stroke="' + NAVY + '" stroke-width="7" stroke-linecap="round"/>' +
            '<line data-w="2" stroke="#fff" stroke-width="5" stroke-linecap="round"/>' : '';
        return '<g data-j="' + j + 'u"><rect x="' + (x - 12.5) + '" y="' + (y - 9) + '" width="25" height="' + (UPPER + 18) + '" rx="12" fill="' + fill + '"' + e + '/>' +
            '<g data-j="' + j + 'f"><rect x="' + (x - 11.5) + '" y="' + (el - 8) + '" width="23" height="' + (FORE + 10) + '" rx="11.5" fill="' + fill + '"' + e + '/>' + w +
            '<circle cx="' + x + '" cy="' + (wr + 2) + '" r="12" fill="#fff" stroke="' + NAVY + '" stroke-width="7"/></g></g>';
    }
    var ST = ' stroke="' + NAVY + '" stroke-linejoin="round" stroke-linecap="round"';
    function sideSvg() {
        return '<svg viewBox="' + SVB.join(' ') + '" xmlns="' + NS + '"><defs><linearGradient id="hw-rg" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#fffdf3"/><stop offset=".55" stop-color="#efe7cf"/><stop offset="1" stop-color="#cfc4a3"/></linearGradient></defs><g data-j="bob">' +
            armSvg('f', SH_F, DEEP, false, false) +
            '<path d="M128,284 C118,316 108,342 92,362 C116,359 134,345 144,318 Z" fill="' + DEEP + '"/>' +
            legSvg('f', HIP_F, DEEP, false) + legSvg('n', HIP_N, NAVY, true) +
            '<rect x="142" y="190" width="28" height="30" rx="6" fill="#fff"' + ST + ' stroke-width="7"/>' +
            '<path d="M128,214 C117,242 117,286 124,318 L188,318 C194,288 195,250 187,222 C177,211 141,207 128,214 Z" fill="' + NAVY + '"/>' +
            '<path d="M172,213 C185,221 191,240 190,264 L180,264 C182,244 177,226 165,214 Z" fill="#fff"' + ST + ' stroke-width="5"/>' +
            '<path d="M186,219 L203,210 L204,229 Z" fill="' + SAGE + '"' + ST + ' stroke-width="4"/><circle cx="187" cy="219" r="5" fill="' + NAVY + '"/>' +
            '<circle cx="183" cy="284" r="4.2" fill="' + SAGE + '"/><circle cx="183" cy="302" r="4.2" fill="' + SAGE + '"/>' +
            '<g data-carry="1"><g transform="rotate(-4 160 262)"><rect x="92" y="250" width="150" height="26" rx="13" fill="url(#hw-rg)"' + ST + ' stroke-width="5"/>' +
            '<ellipse cx="240" cy="263" rx="6" ry="12" fill="#e5dcc0"' + ST + ' stroke-width="4"/></g></g>' +
            armSvg('n', SH_N, NAVY, true, true) +
            '<path d="M114,118 C102,140 102,176 116,194 C128,208 152,214 172,210 C186,207 196,200 198,190 C199,185 196,182 196,180 C200,178 203,174 200,170 L198,166 ' +
            'C204,164 211,158 210,152 C209,147 203,144 199,142 C199,134 198,124 194,116 Z" fill="#fff"' + ST + ' stroke-width="8"/>' +
            '<path d="M113,116 C107,127 105,140 107,152 C112,144 117,135 125,129 C133,123 143,120 152,119 L153,114 Z" fill="' + NAVY + '"/>' +
            '<path d="M131,141 C120,142 118,161 123,171 C128,180 141,179 145,170 C148,161 146,144 131,141 Z" fill="#fff"' + ST + ' stroke-width="7"/>' +
            '<path d="M133,152 C128,156 129,164 135,166" fill="none"' + ST + ' stroke-width="4"/>' +
            '<ellipse cx="180" cy="148" rx="4.6" ry="7.2" fill="' + NAVY + '"/>' +
            '<path d="M170,131 C175,126 183,126 189,131" fill="none"' + ST + ' stroke-width="6"/>' +
            '<path d="M176,184 C183,191 191,191 197,185" fill="none"' + ST + ' stroke-width="6"/>' +
            '<path d="M112,108 L118,30 C118,23 124,19 132,19 L178,19 C186,19 191,23 191,30 L197,106 Z" fill="' + NAVY + '"/>' +
            '<path d="M114.6,80 L193.6,80 L194.8,96 L113.4,96 Z" fill="' + SAGE + '"/>' +
            '<path d="M80,104 C92,112 120,114 154,114 C190,114 214,111 228,102 C231,111 226,122 214,124 C190,128 120,128 96,125 C84,123 78,114 80,104 Z" fill="' + NAVY + '"/>' +
            '</g></svg>';
    }
    // Front pose: head, hat and wand hand are cut from the logo artwork (mascot-solid.svg = the logo mascot with its face
    // and hands filled white), body drawn around them. data-logo is the whole logo bust in the same place, so fading the
    // body out and the bust in turns him into the logo without his head moving.
    function frontSvg() {
        var src = BASE + 'mascot-solid.svg', img = '<image href="' + src + '" x="87" y="27" width="363" height="349" clip-path="url(#hw-c';
        return '<svg viewBox="' + FVB.join(' ') + '" xmlns="' + NS + '"><defs><clipPath id="hw-ch"><rect x="160" y="40" width="178" height="166"/></clipPath>' +
            '<clipPath id="hw-cw"><rect x="373" y="70" width="72" height="194"/></clipPath></defs>' +
            '<g data-body="1"><path d="M212,286 C198,318 184,342 166,358 C194,357 214,343 226,318 Z" fill="' + DEEP + '"/>' +
            '<rect x="229" y="304" width="26" height="80" rx="12" fill="' + DEEP + '"/><path d="M226,376 L258,376 C275,376 283,384 283,392 L283,397 L226,397 Z" fill="' + DEEP + '"/>' +
            '<g data-up="1"><rect x="193" y="222" width="28" height="72" rx="13" fill="' + DEEP + '"/><circle cx="207" cy="300" r="13" fill="#fff" stroke="' + NAVY + '" stroke-width="7"/></g>' +
            '<rect x="253" y="304" width="26" height="80" rx="12" fill="' + NAVY + '" stroke="#fff" stroke-width="3"/>' +
            '<path d="M250,376 L282,376 C299,376 307,384 307,392 L307,397 L250,397 Z" fill="' + NAVY + '" stroke="#fff" stroke-width="3"/></g>' +
            '<g data-up="1">' + img + 'h)"/><g data-body="1">' +
            '<path d="M204,213 C198,246 197,288 203,322 L303,322 C309,288 308,246 302,213 C286,204 220,204 204,213 Z" fill="' + NAVY + '"/>' +
            '<path d="M237,207 L253,266 L269,207 Z" fill="#fff"' + ST + ' stroke-width="6"/>' +
            '<path d="M253,214 L235,204 L235,225 Z M253,214 L271,204 L271,225 Z" fill="' + SAGE + '"' + ST + ' stroke-width="5"/><circle cx="253" cy="214" r="5.5" fill="' + NAVY + '"/>' +
            '<circle cx="253" cy="286" r="4.5" fill="' + SAGE + '"/><circle cx="253" cy="304" r="4.5" fill="' + SAGE + '"/></g>' +
            '<g data-tap="1"><line data-body="1" x1="292" y1="234" x2="386" y2="257" stroke="' + NAVY + '" stroke-width="31" stroke-linecap="round"/>' + img + 'w)"/></g></g>' +
            '<image data-logo="1" href="' + src + '" x="87" y="27" width="363" height="349" opacity="0"/></svg>';
    }

    // forward kinematics: where the wand tip is, in side-svg units
    function wandTip(p, w) {
        var e = rot(0, UPPER, -p.nu), h = rot(0, FORE + 2, -(p.nu + p.nf)), L = Math.hypot(w[0], w[1]);
        var tv = rot(w[0] / L * 62, w[1] / L * 62, -(p.nu + p.nf));
        return [SH_N[0] + e[0] + h[0] + tv[0], SH_N[1] + e[1] + h[1] + tv[1] - p.bob];
    }
    // side-svg point -> stage, for a walker with feet at (fx, fy), height h, facing dir (1 right, -1 left)
    function sideToStage(pt, fx, fy, h, dir) {
        var k = h / BH, bx = (pt[0] - SVB[0]) * BH / SVB[3], by = (pt[1] - SVB[1]) * BH / SVB[3];
        return [fx + dir * k * (bx - SAX * SW), fy + k * (by - SAY * BH)];
    }
    function frontToStage(pt, fx, fy, h) {
        var k = h / BH, bx = (pt[0] - FVB[0]) * BH / FVB[3], by = (pt[1] - FVB[1]) * BH / FVB[3];
        return [fx + k * (bx - FAX * FW), fy + k * (by - FAY * BH)];
    }

    // ------------------------------------------------------------------ world + camera
    var C0 = [350, 700], C1 = [846.4, 726.45], W1 = 41;          // C1/W1 = the z18 close-up around Survey No. 143
    var LM = [[530, 370], [205, 760], [329, 1029]];               // GPS pins: Wagholi junction, Kharadi river bend, Manjari Rd
    var Z15 = [740, 615, 220, 220], Z18 = [824.3, 682.2, 44.25, 88.5];
    // close-ups are laid out at the stage scale they are shown at (z18: the final zoom; z15: when z18 starts to cover it)
    var K18 = 320 / W1, K15 = 320 / 90;
    function camera(t) {
        if (t >= RESET) return { W: 700, cx: C0[0], cy: C0[1] };
        if (t < 3) return { W: 700 - 28 * eo(t / 3), cx: C0[0], cy: C0[1] };
        if (t < 9.7) return { W: 672, cx: C0[0], cy: C0[1] };
        var u = eio(seg(t, 9.7, 10.7)), W = 672 * Math.pow(W1 / 672, u), f = (W - W1) / (672 - W1);
        return { W: W, cx: C1[0] + (C0[0] - C1[0]) * f, cy: C1[1] + (C0[1] - C1[1]) * f };
    }
    function worldToStage(cam, x, y) { var k = 320 / cam.W; return [(x - (cam.cx - cam.W / 2)) * k, (y - (cam.cy - cam.W)) * k]; }
    // the plan sheet lands slightly off, then snaps true when the pins go in
    function sheetXf(t) {
        var u = back(seg(t, 6.45, 6.75)); if (t < 6.45) u = 0;
        return { tx: lerp(18, 0, u), ty: lerp(22, 0, u), r: lerp(-2.5, 0, u), s: lerp(.95, 1, u) };
    }
    function sheetPoint(m, x, y) {
        var dx = (x - 500) * m.s, dy = (y - 700) * m.s, q = rot(dx, dy, m.r);
        return [500 + q[0] + m.tx, 700 + q[1] + m.ty];
    }

    // ------------------------------------------------------------------ choreography
    var PUSH_TIP, ROLL0;   // wand reach ahead of the feet when pushing (stage px at base height); where the roll appears
    function rollX(t) {
        if (t < 2.1 || t >= RESET) return -1;
        if (t < 3.2) return ROLL0;
        var u = seg(t, 3.2, 5.1); return ROLL0 + (354 - ROLL0) * (u * u * (3 - 2 * u));
    }
    function pct(t) {
        if (t < 7.4) return 100;
        if (t < 8.4) return lerp(100, 20, eio(seg(t, 7.4, 8.4)));
        if (t < 8.8) return 20;
        return lerp(20, 70, eio(seg(t, 8.8, 9.35)));
    }
    var RAIL_L = 30, RAIL_W = 200, RAIL_Y = 586;
    // the end card's logo: bust 200 px wide, centred, top at 128 -> where the front walker must stand so his head is the logo's head
    var LOGO_W = 200, LOGO_H = LOGO_W * 384 / 363, LOGO_TOP = 128;
    var LOGO_FX = 160 - LOGO_W / 2 + 53 * LOGO_H / 384 + FAX * LOGO_H * 316 / 384, LOGO_FY = LOGO_TOP + 9 * LOGO_H / 384 + FAY * LOGO_H;
    function ballX(t) { return RAIL_L + RAIL_W * pct(t) / 100; }
    function turnSquash(t, a, b) { var u = seg(t, a, b); return Math.abs(Math.cos(Math.PI * u)); }

    function walker(t) {
        var s = { mode: 'side', x: 0, y: 596, gy: null, morph: 0, h: BH, dir: 1, sq: 1, op: 1, carry: false, pose: STAND, wand: WAND_WALK, tap: 0, bow: 0, spark: false };
        var x0 = -46, v = 84;
        if (t < 1.6) {
            var x = t <= 1.25 ? x0 + v * t : 59 + v * ((t - 1.25) - Math.pow(t - 1.25, 2) / .7);
            s.x = x; s.carry = true;
            s.pose = mix(cyclePose((x - x0) / (.4 * BH) * 8), STAND, seg(t, 1.45, 1.6));
        } else if (t < 3.2) {
            s.x = 73.7; s.carry = t < 1.8;
            if (t >= 1.8 && t < 2.98) {
                s.mode = 'front'; s.tap = Math.sin(Math.PI * seg(t, 2.0, 2.3)); s.spark = t > 1.9 && t < 2.5;
            }
            if (t >= 1.72 && t < 1.88) s.sq = turnSquash(t, 1.72, 1.88);
            if (t >= 2.9 && t < 3.06) s.sq = turnSquash(t, 2.9, 3.06);
        } else if (t < 5.3) {
            var raw = rollX(t) - 17 - PUSH_TIP, xx = raw < 250 ? raw : 250 + 20 * (1 - Math.exp(-(raw - 250) / 20));
            s.x = Math.max(73.7, xx);
            var walk = withArms(cyclePose((s.x - 73.7) / (.4 * BH) * 8), 76, 10, 70, 16);
            s.pose = mix(mix(STAND, walk, seg(t, 3.2, 3.35)), STAND, seg(t, 5.12, 5.3));
            s.wand = WAND_AIM;
        } else if (t < 7.0) {
            s.x = 270.1; s.dir = t < 5.38 ? 1 : -1;
            if (t < 5.46) s.sq = turnSquash(t, 5.3, 5.46);
            s.pose = mix(mix(STAND, POINT, seg(t, 5.46, 5.6)), STAND, seg(t, 6.6, 6.8));
            s.wand = t < 6.7 ? WAND_AIM : WAND_WALK; s.spark = t > 5.5 && t < 6.5;
        } else if (t < 9.4) {
            var off = 17 + PUSH_TIP * .693, bx = ballX(t);
            if (t < 7.15) { s.x = 270.1; s.dir = -1; }
            else if (t < 7.4) {
                var u = seg(t, 7.15, 7.4); s.x = lerp(270.1, ballX(7.4) + off, u); s.gy = lerp(596, RAIL_Y, u); s.y = s.gy - 22 * Math.sin(Math.PI * u);
                s.dir = -1; s.h = lerp(BH, 104, u); s.pose = CYCLE[2];
            } else if (t < 8.5) {
                s.h = 104; s.y = RAIL_Y; s.dir = -1; s.x = bx + off;
                s.pose = t < 8.4 ? withArms(cyclePose((ballX(7.4) - bx) / (.4 * 104) * 8), 76, 10, 70, 16) : mix(withArms(STAND, 76, 10, 70, 16), STAND, seg(t, 8.4, 8.5));
                s.wand = WAND_AIM;
            } else if (t < 8.8) {
                var h2 = seg(t, 8.5, 8.8); s.h = 104; s.x = lerp(bx + off, bx - off, eio(h2)); s.gy = RAIL_Y; s.y = RAIL_Y - 46 * Math.sin(Math.PI * h2);
                s.dir = h2 < .5 ? -1 : 1; s.pose = CYCLE[2];
            } else {
                s.h = 104; s.y = RAIL_Y; s.dir = 1; s.x = bx - off;
                s.pose = t < 9.35 ? withArms(cyclePose((bx - ballX(8.8)) / (.4 * 104) * 8), 76, 10, 70, 16) : STAND;
                s.wand = t < 9.35 ? WAND_AIM : WAND_WALK;
            }
        } else if (t < 11.4) {
            if (t < 9.85) {
                s.h = 104; s.y = RAIL_Y; s.x = ballX(9.4) - 17 - PUSH_TIP * .693;
                if (t >= 9.48) { s.mode = 'front'; s.spark = true; }
                if (t < 9.56) s.sq = turnSquash(t, 9.4, 9.56);
                var po = seg(t, 9.65, 9.85); s.op = 1 - po; s.h *= 1 - .7 * po;
            } else if (t < 10.9) { s.mode = 'none'; }
            else {
                s.mode = 'front'; s.x = 196; s.y = 352; var pi = seg(t, 10.9, 11.05); s.h = 124 * lerp(.3, 1, pop(pi)); s.op = pi;
                s.spark = t > 11.0; if (t > 11.3) { var po2 = seg(t, 11.3, 11.4); s.op = 1 - po2; }
            }
        } else if (t < RESET + .35) {
            if (t < 11.62) { s.mode = 'none'; }
            else {
                s.mode = 'front'; s.x = LOGO_FX; s.y = LOGO_FY; var pi2 = seg(t, 11.62, 11.8); s.h = LOGO_H * lerp(.3, 1, pop(pi2));
                s.op = pi2 * (1 - seg(t, RESET, RESET + .35)); s.morph = eio(seg(t, 12.0, 12.55));
            }
        } else { s.mode = 'none'; }
        if (s.gy == null) s.gy = s.y;
        return s;
    }
    function tipOf(s) {
        if (s.mode === 'front') return frontToStage([381, 113], s.x, s.y, s.h);
        return sideToStage(wandTip(s.pose, s.wand), s.x, s.y, s.h, s.dir);
    }

    // ------------------------------------------------------------------ DOM
    var CSS = '' +
        '#mm-hiw{position:relative;width:100%;height:100%;overflow:hidden;background:#24302a;border-radius:inherit;font-family:inherit;-webkit-user-select:none;user-select:none}' +
        '#mm-hiw .hw-stage{position:absolute;left:0;top:0;width:320px;height:640px;transform-origin:0 0}' +
        '#mm-hiw .hw-world{position:absolute;left:0;top:0;width:1000px;height:1400px;transform-origin:0 0;will-change:transform}' +
        '#mm-hiw .hw-world img{position:absolute;left:0;top:0;width:1000px;height:1400px;max-width:none;object-fit:fill;display:block}' +
        '#mm-hiw .hw-clip{position:absolute;inset:0;overflow:hidden}' +
        '#mm-hiw .hw-sheet{position:absolute;left:0;top:0;width:1000px;height:1400px;transform-origin:500px 700px}' +
        '#mm-hiw .hw-paper{position:absolute;left:-24px;top:-24px;right:-24px;bottom:-90px;background:#fbfaf3;box-shadow:0 14px 34px rgba(0,0,0,.5)}' +
        '#mm-hiw .hw-lod{--f:7%;position:absolute;left:0;top:0;transform-origin:0 0;-webkit-mask-image:linear-gradient(90deg,transparent,#000 var(--f),#000 calc(100% - var(--f)),transparent),linear-gradient(transparent,#000 var(--f),#000 calc(100% - var(--f)),transparent);' +
        '-webkit-mask-composite:source-in;mask-image:linear-gradient(90deg,transparent,#000 var(--f),#000 calc(100% - var(--f)),transparent),linear-gradient(transparent,#000 var(--f),#000 calc(100% - var(--f)),transparent);mask-composite:intersect}' +
        '#mm-hiw .hw-lod img{position:absolute;inset:0;width:100%;height:100%;max-width:none;display:block}' +
        '#mm-hiw .hw-pin{position:absolute;width:54px;height:66px;margin:-66px 0 0 -27px;transform-origin:50% 100%;filter:drop-shadow(0 6px 5px rgba(0,0,0,.45))}' +
        '#mm-hiw .hw-ring{position:absolute;width:52px;height:52px;margin:-26px 0 0 -26px;border:5px dashed ' + GOLD + ';border-radius:50%;box-shadow:0 0 0 4px rgba(0,0,0,.35)}' +
        '#mm-hiw .hw-roll{position:absolute;left:0;top:-8px;width:34px;height:656px;margin-left:-17px;border:3px solid ' + NAVY + ';border-radius:17px;box-sizing:border-box;transform-origin:50% 50%;' +
        'background:linear-gradient(90deg,#a89b76 0%,#efe7cf 20%,#fffdf3 44%,#efe7cf 70%,#9c8f6a 100%);box-shadow:12px 0 18px rgba(0,0,0,.45)}' +
        '#mm-hiw .hw-roll span{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) rotate(90deg);white-space:nowrap;font-size:11px;font-weight:800;letter-spacing:.2em;color:' + NAVY + '}' +
        '#mm-hiw .hw-fx{position:absolute;left:0;top:0;overflow:visible}' +
        '#mm-hiw .hw-wk{position:absolute;left:0;top:0;transform-origin:0 0;filter:drop-shadow(0 0 1.3px #fff) drop-shadow(0 0 1.3px #fff) drop-shadow(0 0 1px #fff) drop-shadow(0 6px 6px rgba(0,0,0,.35))}' +
        '#mm-hiw .hw-wk svg{display:block;width:100%;height:100%;overflow:visible}' +
        '#mm-hiw .hw-gs{position:absolute;left:0;top:0;width:60px;height:9px;margin:-4.5px 0 0 -30px;border-radius:50%;background:radial-gradient(rgba(0,0,0,.45),rgba(0,0,0,0) 70%)}' +
        '#mm-hiw .hw-cap{position:absolute;left:0;right:0;top:0;padding:22px 20px 70px;background:linear-gradient(rgba(5,12,20,.8),rgba(5,12,20,0));color:#fff;' +
        'font-size:25px;font-weight:800;line-height:1.13;letter-spacing:-.01em;text-shadow:0 2px 6px rgba(0,0,0,.45)}' +
        '#mm-hiw .hw-cap small{display:block;font-size:11.5px;letter-spacing:.16em;color:' + GOLD + ';margin-bottom:7px;text-transform:uppercase;font-weight:800}' +
        '#mm-hiw .hw-bubble{position:absolute;left:150px;top:392px;background:#fff;color:' + NAVY + ';font-weight:700;font-size:14px;padding:8px 12px;border-radius:14px;' +
        'box-shadow:0 6px 16px rgba(0,0,0,.35);white-space:nowrap;transform-origin:0 100%}' +
        '#mm-hiw .hw-bubble:after{content:"";position:absolute;left:-7px;bottom:10px;border:8px solid transparent;border-right-color:#fff;border-left:0}' +
        '#mm-hiw .hw-rail{position:absolute;left:' + RAIL_L + 'px;width:' + RAIL_W + 'px;top:' + RAIL_Y + 'px;height:14px}' +
        '#mm-hiw .hw-bar{position:absolute;inset:0;border-radius:7px;background:#fff;box-shadow:0 4px 12px rgba(0,0,0,.4);overflow:hidden}' +
        '#mm-hiw .hw-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:7px;background:#0f8a7e}' +
        '#mm-hiw .hw-ball{position:absolute;left:0;bottom:7px;width:34px;height:34px;margin-left:-17px;border-radius:50%;background:#0f8a7e;border:3px solid #fff;box-sizing:border-box;box-shadow:0 4px 10px rgba(0,0,0,.4)}' +
        '#mm-hiw .hw-lab{position:absolute;left:0;top:-60px;background:#fff;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:800;color:' + NAVY + ';box-shadow:0 3px 10px rgba(0,0,0,.3);font-variant-numeric:tabular-nums}' +
        '#mm-hiw .hw-redpin{position:absolute;left:117px;top:327px;width:46px;height:56px;margin:-56px 0 0 -23px;transform-origin:50% 100%;filter:drop-shadow(0 4px 4px rgba(0,0,0,.45))}' +
        '#mm-hiw .hw-ripple{position:absolute;left:117px;top:327px;width:60px;height:24px;margin:-12px 0 0 -30px;border:2.5px solid #E53935;border-radius:50%}' +
        '#mm-hiw .hw-info{position:absolute;left:16px;top:392px;background:#fff;border-radius:14px;padding:10px 12px;box-shadow:0 8px 20px rgba(0,0,0,.4);font-size:12px;color:#33445a;transform-origin:20% 0}' +
        '#mm-hiw .hw-info em{display:block;font-style:normal;font-size:10.5px;font-weight:800;letter-spacing:.1em;color:#E53935}' +
        '#mm-hiw .hw-info b{display:block;font-size:16px;color:' + NAVY + '}' +
        '#mm-hiw .hw-info span{display:inline-block;font-size:10.5px;font-weight:700;padding:3px 7px;border-radius:999px;background:#eef3f1;color:#0f6b61;margin:6px 4px 0 0}' +
        '#mm-hiw .hw-attr{position:absolute;right:4px;bottom:3px;font-size:6.5px;line-height:1.2;color:rgba(255,255,255,.75);text-align:right;text-shadow:0 0 2px rgba(0,0,0,.8)}' +
        '#mm-hiw .hw-end{position:absolute;inset:0;background:#F6F2D9;overflow:hidden;color:' + NAVY + ';text-align:center}' +
        '#mm-hiw .hw-wm{position:absolute;left:25px;top:' + (LOGO_TOP + 196) + 'px;width:270px;height:auto;max-width:none;display:block}' +
        '#mm-hiw .hw-endt{position:absolute;left:0;right:0;top:' + (LOGO_TOP + 254) + 'px}' +
        '#mm-hiw .hw-endt i{display:block;font-style:normal;font-size:15px;font-weight:700;color:#3d6b57}' +
        '#mm-hiw .hw-endt p{margin:6px 0 0;font-size:13px;color:#5a6b80;line-height:1.4}' +
        '#mm-hiw .hw-endt span{display:inline-block;margin-top:16px;background:' + NAVY + ';color:#fff;border-radius:999px;font-weight:800;font-size:15px;padding:11px 20px}' +
        '#mm-hiw .hw-endt small{display:block;font-size:12.5px;color:#7a8898;margin-top:12px}';

    var PIN = '<svg viewBox="0 0 26 32" width="100%" height="100%"><path d="M13 1C6.9 1 2 5.9 2 12c0 8.2 11 19 11 19s11-10.8 11-19C24 5.9 19.1 1 13 1z" fill="FILL" stroke="EDGE" stroke-width="2"/><circle cx="13" cy="12" r="4.2" fill="DOT"/></svg>';
    var CAPS = [
        [0.15, 1.6, 'Development Plan GIS', 'Your area,<br>from space'],
        [1.7, 3.2, 'Step 1', 'The official<br>Development Plan'],
        [3.3, 5.3, 'Step 2', 'He lays it on<br>the satellite map'],
        [5.35, 7.0, 'Step 3', 'Pinned to exact<br>GPS points'],
        [7.05, 9.4, 'Step 4', 'Slide to see<br>what’s underneath'],
        [9.5, 11.5, 'Step 5', 'Right down to your<br>survey number']
    ];

    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var html = '<div class="hw-stage" aria-hidden="true">' +
        '<div class="hw-world" data-r="wsat"><img data-src="sat.webp" alt=""></div>' +
        '<div class="hw-clip" data-r="clip"><div class="hw-world" data-r="wsheet"><div class="hw-sheet" data-r="sheet"><div class="hw-paper" data-r="paper"></div>' +
        '<img data-src="plan.webp" alt="" data-r="plan">' +
        LM.map(function (p, i) { return '<div class="hw-pin" data-r="pin' + i + '" style="left:' + p[0] + 'px;top:' + p[1] + 'px">' + PIN.replace('FILL', '#FFC531').replace('EDGE', NAVY).replace('DOT', NAVY) + '</div>'; }).join('') +
        '</div></div></div>' +
        '<div class="hw-world" data-r="wtop">' +
        LM.map(function (p, i) { return '<div class="hw-ring" data-r="ring' + i + '" style="left:' + p[0] + 'px;top:' + p[1] + 'px"></div>'; }).join('') +
        '</div>' +
        '<div class="hw-lod" data-r="z15" style="width:' + (Z15[2] * K15).toFixed(1) + 'px;height:' + (Z15[3] * K15).toFixed(1) + 'px"><img data-src="z15.webp" alt=""></div>' +
        '<div class="hw-lod" data-r="z18" style="--f:3%;width:' + (Z18[2] * K18).toFixed(1) + 'px;height:' + (Z18[3] * K18).toFixed(1) + 'px"><img data-src="z18.webp" alt=""></div>' +
        '<div class="hw-roll" data-r="roll"><span>DEVELOPMENT PLAN</span></div>' +
        '<svg class="hw-fx" data-r="fx" width="320" height="640" viewBox="0 0 320 640"></svg>' +
        '<div class="hw-rail" data-r="rail"><div class="hw-bar"><i data-r="fill"></i></div><div class="hw-ball" data-r="ball"></div><div class="hw-lab" data-r="lab">PLAN 100%</div></div>' +
        '<div class="hw-ripple" data-r="ripple"></div><div class="hw-redpin" data-r="redpin">' + PIN.replace('FILL', '#E53935').replace('EDGE', '#fff').replace('DOT', '#fff') + '</div>' +
        '<div class="hw-info" data-r="info"><em>YOUR PLOT</em><b>Survey No. 143</b><span>Zone</span><span>Roads</span><span>Reservations</span></div>' +
        '<div class="hw-bubble" data-r="bubble">What’s planned here?</div>' +
        '<div class="hw-cap" data-r="cap"></div>' +
        '<div class="hw-attr" data-r="attr">Imagery ©2026 Airbus, CNES / Airbus, Landsat / Copernicus,<br>Maxar Technologies · Map data ©2026 Google</div>' +
        '<div class="hw-end" data-r="end"><img class="hw-wm" data-r="wm" data-src="wordmark.webp" alt="MapMagician"><div class="hw-endt" data-r="endt"><i>Development Plan GIS</i>' +
        '<p>157+ locations · zones · roads · survey numbers</p><span>Open the map →</span><small>mapmagician.in</small></div></div>' +
        '<div class="hw-gs" data-r="gs"></div>' +
        '<div class="hw-wk" data-r="side" style="width:' + SW + 'px;height:' + BH + 'px">' + sideSvg() + '</div>' +
        '<div class="hw-wk" data-r="front" style="width:' + FW + 'px;height:' + BH + 'px">' + frontSvg() + '</div>' +
        '</div>';
    root.innerHTML = html;
    var R = {};
    Array.prototype.forEach.call(root.querySelectorAll('[data-r]'), function (el) { R[el.getAttribute('data-r')] = el; });
    var stage = root.firstChild;
    var J = {};
    Array.prototype.forEach.call(R.side.querySelectorAll('[data-j]'), function (el) { J[el.getAttribute('data-j')] = el; });
    var WL = R.side.querySelectorAll('[data-w]'), CARRY = R.side.querySelector('[data-carry]');
    var BODY = R.front.querySelectorAll('[data-body]'), LOGO = R.front.querySelector('[data-logo]'), TAP = R.front.querySelector('[data-tap]');

    PUSH_TIP = sideToStage(wandTip(withArms(STAND, 76, 10, 70, 16), WAND_AIM), 0, 0, BH, 1)[0];
    ROLL0 = 73.7 + PUSH_TIP + 17;

    // sparkles + beams (stars pooled, positions derived from t so seek() works)
    var POOL = 64, stars = [], dots = [];
    var STAR = 'M0,-1C.1,-.3 .3,-.1 1,0C.3,.1 .1,.3 0,1C-.1,.3 -.3,.1 -1,0C-.3,-.1 -.1,-.3 0,-1Z';
    for (var i = 0; i < POOL; i++) {
        var p = document.createElementNS(NS, 'path'); p.setAttribute('d', STAR); p.setAttribute('stroke', NAVY); p.setAttribute('stroke-width', '.12');
        p.style.display = 'none'; R.fx.appendChild(p); stars.push(p);
    }
    for (i = 0; i < 36; i++) {
        var c = document.createElementNS(NS, 'circle'); c.setAttribute('r', '2.6'); c.setAttribute('fill', GOLD); c.setAttribute('stroke', NAVY); c.setAttribute('stroke-width', '1');
        c.style.display = 'none'; R.fx.appendChild(c); dots.push(c);
    }
    var flecks = [];
    for (i = 0; i < 40; i++) {
        var f = document.createElementNS(NS, 'rect'); f.setAttribute('fill', i % 5 ? '#fbfaf3' : GOLD); f.style.display = 'none'; R.fx.appendChild(f); flecks.push(f);
    }
    var rnd = rng(20261025), EMIT = [];
    function emit(t0, x, y, n, o) {
        o = o || {};
        for (var k = 0; k < n; k++) EMIT.push({
            t0: t0 + (o.stagger || 0) * k, x: x + (o.dx ? (rnd() - .5) * o.dx : 0), y: y + (o.dy ? (rnd() - .5) * o.dy : 0),
            a: rnd() * Math.PI * 2, v: (o.v || 40) * (.5 + rnd()), life: (o.life || .6) * (.7 + .6 * rnd()), size: (o.size || 7) * (.6 + .7 * rnd()),
            col: rnd() < (o.white || .3) ? '#fff' : GOLD, g: o.g == null ? 30 : o.g
        });
    }
    function buildEmitters() {
        var s, tp;
        s = walker(2.05); tp = tipOf(s); emit(2.05, tp[0], tp[1], 10, { v: 55 });
        emit(2.12, ROLL0, 320, 16, { dy: 560, v: 30, life: .7, size: 8, white: .4 });
        for (var tt = 3.3; tt < 5.0; tt += .12) { var rx = rollX(tt); s = walker(tt); tp = tipOf(s); emit(tt, rx - 14, tp[1], 2, { v: 35, life: .45, size: 6 }); }
        [0, 1, 2].forEach(function (i) { var at = 5.55 + .3 * i + .25, pp = pinStage(i, at); emit(at, pp[0], pp[1] - 4, 9, { v: 50, size: 7 }); });
        emit(6.5, 160, 330, 14, { dx: 260, dy: 460, v: 20, life: .7, size: 8, white: .5 });
        s = walker(9.62); emit(9.66, s.x, s.y - 50, 14, { dx: 30, dy: 60, v: 45, size: 8 });
        emit(10.92, 117, 327, 7, { v: 40, size: 6 });
        emit(10.92, 196, 300, 12, { dx: 30, dy: 60, v: 45, size: 7 });
        emit(11.4, 196, 300, 8, { dx: 30, dy: 50, v: 40, size: 6 });
        emit(11.62, 160, 230, 16, { dx: 120, dy: 160, v: 40, size: 9, white: .4 });
        emit(12.2, 160, 230, 18, { dx: 200, dy: 190, v: 25, life: .8, size: 8, white: .5 });
        var STARS = [[356, 101], [387, 88], [408, 127]];   // the three sparkles drawn by the logo's wand
        for (tt = 12.7, i = 0; tt < 14.0; tt += .3, i++) { tp = frontToStage(STARS[i % 3], LOGO_FX, LOGO_FY, LOGO_H); emit(tt, tp[0], tp[1], 2, { v: 18, size: 6, g: -6, life: .5 }); }
    }
    function pinStage(i, t) {
        var m = sheetXf(t), w = sheetPoint(m, LM[i][0], LM[i][1]); return worldToStage(camera(t), w[0], w[1]);
    }
    buildEmitters();

    // ------------------------------------------------------------------ render(t)
    var last = {};
    function set(el, prop, v) { var key = (el.__k || (el.__k = Math.random())) + prop; if (last[key] !== v) { last[key] = v; el.style[prop] = v; } }
    function show(el, on) { set(el, 'display', on ? '' : 'none'); }
    function xfWorld(el, cam) { var k = 320 / cam.W; set(el, 'transform', 'translate(' + (-(cam.cx - cam.W / 2) * k).toFixed(2) + 'px,' + (-(cam.cy - cam.W) * k).toFixed(2) + 'px) scale(' + k.toFixed(5) + ')'); }
    function lod(el, r, kRef, o, cam) {
        show(el, o > 0); if (o <= 0) return;
        var p = worldToStage(cam, r[0], r[1]);
        set(el, 'opacity', o.toFixed(3));
        set(el, 'transform', 'translate(' + p[0].toFixed(2) + 'px,' + p[1].toFixed(2) + 'px) scale(' + (320 / cam.W / kRef).toFixed(5) + ')');
    }
    var capIdx = -2;

    function render(t) {
        t = ((t % LOOP) + LOOP) % LOOP;
        var cam = camera(t), reset = t >= RESET;
        xfWorld(R.wsat, cam); xfWorld(R.wsheet, cam); xfWorld(R.wtop, cam);

        // plan sheet: grows in with the roll, is clipped at the roll, snaps true, then follows the slider
        var rx = rollX(t), sheetOn = !reset && t >= 2.1;
        show(R.clip, sheetOn);
        if (sheetOn) {
            var grow = eo(seg(t, 2.1, 2.5)), inset = 320 * (1 - grow);
            var right = rx < 0 ? 320 : Math.max(0, 320 - rx);
            set(R.clip, 'clipPath', 'inset(' + inset.toFixed(1) + 'px ' + right.toFixed(1) + 'px ' + inset.toFixed(1) + 'px 0px)');
            var m = sheetXf(t);
            set(R.sheet, 'transform', 'translate(' + m.tx.toFixed(2) + 'px,' + m.ty.toFixed(2) + 'px) rotate(' + m.r.toFixed(3) + 'deg) scale(' + m.s.toFixed(4) + ')');
            set(R.paper, 'opacity', String(1 - seg(t, 6.6, 6.85)));
            var po = t < 7.4 ? 1 : t < 9.7 ? pct(t) / 100 : lerp(.7, .9, seg(t, 9.7, 10.1));
            set(R.plan, 'opacity', po.toFixed(3));
            for (var i = 0; i < 3; i++) {
                var at = 5.55 + .3 * i + .25, pu = seg(t, at - .05, at + .2), fade = 1 - seg(t, 9.7, 9.9);
                show(R['pin' + i], t >= at - .05 && t < 9.9);
                set(R['pin' + i], 'transform', 'scale(' + pop(pu).toFixed(3) + ')'); set(R['pin' + i], 'opacity', String(fade));
            }
        }
        // true-position rings, then the close-up tiles as the camera zooms
        for (i = 0; i < 3; i++) {
            var ro = seg(t, 5.4, 5.6) * (1 - seg(t, 6.75, 7.0));
            show(R['ring' + i], !reset && ro > 0); set(R['ring' + i], 'opacity', ro.toFixed(3));
            set(R['ring' + i], 'transform', 'scale(' + (1 + .25 * Math.sin(Math.PI * seg(t, 5.8 + .3 * i, 6.1 + .3 * i))).toFixed(3) + ')');
        }
        var o15 = reset || t < 9.7 ? 0 : clamp01((330 - cam.W) / 150), o17 = reset || t < 9.7 ? 0 : clamp01((90 - cam.W) / 38);
        lod(R.z15, Z15, K15, o15, cam); lod(R.z18, Z18, K18, o17, cam);

        // the roll
        show(R.roll, rx >= 0 && rx < 345);
        if (rx >= 0) set(R.roll, 'transform', 'translateX(' + rx.toFixed(1) + 'px) scaleY(' + pop(seg(t, 2.1, 2.5)).toFixed(3) + ')');

        // slider rail (beat 5)
        var railIn = eo(seg(t, 7.0, 7.3)) * (1 - seg(t, 9.6, 9.85));
        show(R.rail, !reset && railIn > 0);
        if (railIn > 0) {
            set(R.rail, 'transform', 'translateY(' + (70 * (1 - railIn)).toFixed(1) + 'px)'); set(R.rail, 'opacity', railIn.toFixed(3));
            var pc = pct(t); set(R.fill, 'width', pc.toFixed(1) + '%'); set(R.ball, 'left', pc.toFixed(1) + '%');
            var lab = 'PLAN ' + Math.round(pc) + '%'; if (R.lab.textContent !== lab) R.lab.textContent = lab;
        }

        // red pin + info (beat 6)
        var pd = seg(t, 10.75, 10.95), on6 = !reset && t >= 10.75;
        show(R.redpin, on6); set(R.redpin, 'transform', 'translateY(' + (-90 * (1 - eo(pd))).toFixed(1) + 'px) scale(' + (pd < 1 ? 1 : 1 + .15 * Math.sin(Math.PI * seg(t, 10.95, 11.1))).toFixed(3) + ')');
        var rp = seg(t, 10.92, 11.35); show(R.ripple, on6 && rp > 0 && rp < 1);
        set(R.ripple, 'transform', 'scale(' + (.4 + 1.2 * rp).toFixed(3) + ')'); set(R.ripple, 'opacity', (1 - rp).toFixed(3));
        var ip = seg(t, 11.05, 11.25); show(R.info, !reset && ip > 0);
        set(R.info, 'transform', 'scale(' + lerp(.6, 1, pop(ip)).toFixed(3) + ')'); set(R.info, 'opacity', ip.toFixed(3));

        // captions + bubble
        var ci = -1, co = 0;
        for (i = 0; i < CAPS.length; i++) if (t >= CAPS[i][0] && t < CAPS[i][1]) { ci = i; co = seg(t, CAPS[i][0], CAPS[i][0] + .25) * (1 - seg(t, CAPS[i][1] - .2, CAPS[i][1])); }
        if (ci !== capIdx) { capIdx = ci; if (ci >= 0) R.cap.innerHTML = '<small>' + CAPS[ci][2] + '</small>' + CAPS[ci][3]; }
        show(R.cap, ci >= 0); set(R.cap, 'opacity', co.toFixed(3));
        var bo = seg(t, .75, .95) * (1 - seg(t, 1.55, 1.7)); show(R.bubble, bo > 0);
        set(R.bubble, 'transform', 'scale(' + pop(seg(t, .75, .95)).toFixed(3) + ')'); set(R.bubble, 'opacity', bo.toFixed(3));

        // end card
        var eop = t < 11.4 ? 0 : seg(t, 11.4, 11.7) * (1 - seg(t, RESET, RESET + .35));
        show(R.end, eop > 0); set(R.end, 'opacity', eop.toFixed(3));
        if (eop > 0) {
            var wm = eo(seg(t, 12.35, 12.75)), et = eo(seg(t, 12.6, 12.95));
            set(R.wm, 'opacity', wm.toFixed(3)); set(R.wm, 'transform', 'translateY(' + (14 * (1 - wm)).toFixed(1) + 'px)');
            set(R.endt, 'opacity', et.toFixed(3)); set(R.endt, 'transform', 'translateY(' + (12 * (1 - et)).toFixed(1) + 'px)');
        }

        // the magician
        var s = walker(t), sideOn = s.mode === 'side', frontOn = s.mode === 'front';
        show(R.side, sideOn); show(R.front, frontOn); show(R.gs, s.mode !== 'none');
        if (s.mode !== 'none') {
            var k = s.h / BH;
            set(R.gs, 'transform', 'translate(' + s.x.toFixed(1) + 'px,' + (s.gy + 1).toFixed(1) + 'px) scale(' + (k * (sideOn ? 1 : 1.15)).toFixed(3) + ')');
            set(R.gs, 'opacity', (s.op * (1 - s.morph) * (1 - Math.min(.6, (s.gy - s.y) / 60))).toFixed(3));
        }
        if (sideOn) {
            set(R.side, 'transform', 'translate(' + s.x.toFixed(1) + 'px,' + s.y.toFixed(1) + 'px) scale(' + (s.dir * k * s.sq).toFixed(4) + ',' + k.toFixed(4) + ') translate(' + (-SAX * SW).toFixed(2) + 'px,' + (-SAY * BH).toFixed(2) + 'px)');
            set(R.side, 'opacity', String(s.op));
            var P = s.pose;
            J.nt.setAttribute('transform', 'rotate(' + (-P.nt).toFixed(1) + ' ' + HIP_N[0] + ' ' + HIP_N[1] + ')');
            J.nk.setAttribute('transform', 'rotate(' + P.nk.toFixed(1) + ' ' + HIP_N[0] + ' ' + (HIP_N[1] + THIGH) + ')');
            J.ft.setAttribute('transform', 'rotate(' + (-P.ft).toFixed(1) + ' ' + HIP_F[0] + ' ' + HIP_F[1] + ')');
            J.fk.setAttribute('transform', 'rotate(' + P.fk.toFixed(1) + ' ' + HIP_F[0] + ' ' + (HIP_F[1] + THIGH) + ')');
            J.nu.setAttribute('transform', 'rotate(' + (-P.nu).toFixed(1) + ' ' + SH_N[0] + ' ' + SH_N[1] + ')');
            J.nf.setAttribute('transform', 'rotate(' + (-P.nf).toFixed(1) + ' ' + SH_N[0] + ' ' + (SH_N[1] + UPPER) + ')');
            J.fu.setAttribute('transform', 'rotate(' + (-P.fu).toFixed(1) + ' ' + SH_F[0] + ' ' + SH_F[1] + ')');
            J.ff.setAttribute('transform', 'rotate(' + (-P.ff).toFixed(1) + ' ' + SH_F[0] + ' ' + (SH_F[1] + UPPER) + ')');
            J.bob.setAttribute('transform', 'translate(0,' + (-P.bob).toFixed(1) + ')');
            CARRY.style.display = s.carry ? '' : 'none';
            var L = Math.hypot(s.wand[0], s.wand[1]), ux = s.wand[0] / L, uy = s.wand[1] / L, hx = SH_N[0], hy = SH_N[1] + UPPER + FORE + 2;
            var x0 = hx - ux * 12, y0 = hy - uy * 12, x1 = hx + ux * 62, y1 = hy + uy * 62;
            for (var w = 0; w < 3; w++) {
                var a0 = w < 2 ? [x0, y0] : [x1 - ux * 9, y1 - uy * 9], a1 = w < 2 ? [x1, y1] : [x1 - ux, y1 - uy];
                WL[w].setAttribute('x1', a0[0].toFixed(1)); WL[w].setAttribute('y1', a0[1].toFixed(1)); WL[w].setAttribute('x2', a1[0].toFixed(1)); WL[w].setAttribute('y2', a1[1].toFixed(1));
            }
        }
        if (frontOn) {
            set(R.front, 'transform', 'translate(' + s.x.toFixed(1) + 'px,' + s.y.toFixed(1) + 'px) scale(' + (k * s.sq).toFixed(4) + ',' + k.toFixed(4) + ') translate(' + (-FAX * FW).toFixed(2) + 'px,' + (-FAY * BH).toFixed(2) + 'px)');
            set(R.front, 'opacity', String(s.op));
            set(R.front, 'filter', t >= 11.4 ? 'none' : '');   // on the cream card he is the logo: no sticker outline or shadow
            TAP.setAttribute('transform', 'rotate(' + (16 * s.tap).toFixed(1) + ' 292 234)');
            for (i = 0; i < BODY.length; i++) BODY[i].setAttribute('opacity', (1 - s.morph).toFixed(3));
            LOGO.setAttribute('opacity', s.morph.toFixed(3));
        }

        // sparkles
        var used = 0;
        for (i = 0; i < EMIT.length && used < POOL; i++) {
            var e = EMIT[i], age = t - e.t0;
            if (age < 0 || age >= e.life) continue;
            var u = age / e.life, sc = e.size * Math.sin(Math.PI * u), px = e.x + Math.cos(e.a) * e.v * age, py = e.y + Math.sin(e.a) * e.v * age + e.g * age * age;
            var el = stars[used++]; el.style.display = '';
            el.setAttribute('fill', e.col);
            el.setAttribute('transform', 'translate(' + px.toFixed(1) + ' ' + py.toFixed(1) + ') rotate(' + (u * 90).toFixed(0) + ') scale(' + sc.toFixed(2) + ')');
        }
        for (; used < POOL; used++) stars[used].style.display = 'none';
        // wand beams to the pins (beat 4)
        var di = 0;
        for (i = 0; i < 3; i++) {
            var b0 = 5.55 + .3 * i, bp = seg(t, b0, b0 + .25), bf = 1 - seg(t, b0 + .25, b0 + .5);
            if (reset || t < b0 || bf <= 0) { for (var d = 0; d < 12; d++) dots[di++].style.display = 'none'; continue; }
            var tp = tipOf(walker(b0)), pp = pinStage(i, b0 + .25), cx = (tp[0] + pp[0]) / 2, cy = Math.min(tp[1], pp[1]) - 70;
            for (d = 0; d < 12; d++) {
                var q = (d + 1) / 12, dot = dots[di++];
                if (q > bp) { dot.style.display = 'none'; continue; }
                var bx = (1 - q) * (1 - q) * tp[0] + 2 * (1 - q) * q * cx + q * q * pp[0], by = (1 - q) * (1 - q) * tp[1] + 2 * (1 - q) * q * cy + q * q * pp[1];
                dot.style.display = ''; dot.setAttribute('cx', bx.toFixed(1)); dot.setAttribute('cy', by.toFixed(1)); dot.setAttribute('opacity', bf.toFixed(2));
            }
        }
        // paper flecks as the margin lets go (beat 4)
        var fa = t - 6.6;
        for (i = 0; i < flecks.length; i++) {
            var fl = flecks[i];
            if (reset || fa < 0 || fa > .55) { fl.style.display = 'none'; continue; }
            var r1 = ((i * 7919) % 1000) / 1000, r2 = ((i * 104729) % 1000) / 1000, onTop = i % 2;
            var fx0 = onTop ? 320 * r1 : 6 + 8 * r2, fy0 = onTop ? 6 + 8 * r2 : 640 * r1;
            fl.style.display = ''; var sz = 2 + 4 * r2;
            fl.setAttribute('x', (fx0 - (onTop ? 0 : 40 * fa * (1 + r1))).toFixed(1)); fl.setAttribute('y', (fy0 - (onTop ? 40 * fa * (1 + r1) : -20 * fa)).toFixed(1));
            fl.setAttribute('width', sz.toFixed(1)); fl.setAttribute('height', sz.toFixed(1)); fl.setAttribute('opacity', (1 - fa / .55).toFixed(2));
        }
    }

    // ------------------------------------------------------------------ scale, load, play only when visible
    function fit() { var h = root.clientHeight || 640; stage.style.transform = 'scale(' + (h / 640) + ')'; }
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(root); else window.addEventListener('resize', fit);

    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var clock = 0, prev = 0, raf = 0, visible = false, ready = false, paused = false;
    function frame(now) {
        raf = 0;
        if (!visible || !ready || paused || document.hidden) return;
        if (prev) clock += Math.min(.1, (now - prev) / 1000);
        prev = now; render(clock);
        raf = requestAnimationFrame(frame);
    }
    function kick() { if (!raf && visible && ready && !paused && !reduce && !document.hidden) { prev = 0; raf = requestAnimationFrame(frame); } }
    function load() {
        var imgs = root.querySelectorAll('img[data-src]'), need = [];
        Array.prototype.forEach.call(imgs, function (im) {
            im.src = BASE + im.getAttribute('data-src'); im.removeAttribute('data-src');
            if (/sat|plan/.test(im.src)) need.push(im.decode ? im.decode().catch(function () {}) : Promise.resolve());
        });
        Promise.all(need).then(function () { ready = true; render(reduce ? 9.3 : clock); kick(); });
    }
    var loaded = false;
    if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (es) { if (es[0].isIntersecting && !loaded) { loaded = true; load(); } }, { rootMargin: '600px' }).observe(root);
        new IntersectionObserver(function (es) { visible = es[0].isIntersecting; if (visible) kick(); }, { threshold: .25 }).observe(root);
    } else { loaded = true; visible = true; load(); }
    document.addEventListener('visibilitychange', kick);

    root.__hiw = {
        seek: function (t) { clock = t; render(t); },
        pause: function () { paused = true; },
        play: function () { paused = false; kick(); },
        ready: function () { return ready; },
        loop: LOOP
    };
})();
