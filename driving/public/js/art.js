/*
 * Cami Driving — art.js
 *
 * All drawing for the game. Pure Canvas 2D, everything procedural (the only image ever drawn is the
 * QR code passed in by the game). Defines the global `Art` object described in docs/GAME_DESIGN.md §7.
 *
 * Conventions: CSS pixel units, (x, y) is the center of what is drawn unless noted, `t` is seconds.
 * Every public function save()s / restore()s the context and multiplies (never overwrites) the
 * incoming globalAlpha, so the game can fade whole screens.
 *
 * Performance: anything with soft glows or many path operations (treats, props, trophies, sparkles,
 * lamp glows, HUD backgrounds) is rendered once into an offscreen canvas, cached by kind and size
 * bucket, and blitted with drawImage. No shadowBlur is used anywhere. Per-frame allocations are kept
 * to a handful of short cache-key strings.
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;
  var OL = '#4A3550'; // soft plum outline used for the picture-book look
  var FONT = "Nunito, 'Comic Sans MS', 'Chalkboard SE', 'Trebuchet MS', system-ui, -apple-system, 'Segoe UI', Roboto, Ubuntu, sans-serif";
  var MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', 'DejaVu Sans Mono', Menlo, Consolas, 'Liberation Mono', monospace";

  // ---------------------------------------------------------------------------------------------
  // Biome tables (GAME_DESIGN.md §4)
  // ---------------------------------------------------------------------------------------------

  var BIOMES = {
    meadow: {
      ground: '#7ED957', groundStripe: '#6CC64A', road: '#9AA0B5', roadEdge: '#FFFFFF', laneMark: '#FFE45C',
      accent: '#FF6FB5', dust: '#5DB843', treat: 'strawberry', treatColor: '#FF3B5C',
      props: ['tree', 'bush', 'flowers', 'cow'], seaProps: []
    },
    beach: {
      ground: '#F6DFA0', groundStripe: '#EFD08A', road: '#A9A7B0', roadEdge: '#FFFFFF', laneMark: '#FF8A65',
      accent: '#4FC3F7', dust: '#E8C77A', treat: 'starfish', treatColor: '#FF9F1C',
      props: ['palm', 'umbrella', 'sandcastle'], seaProps: ['boat']
    },
    town: {
      ground: '#E8E3D8', groundStripe: '#D9D2C3', road: '#7D8396', roadEdge: '#FFFFFF', laneMark: '#FFFFFF',
      accent: '#FFD93D', dust: '#BDB6A8', treat: 'balloon', treatColor: '#4D96FF',
      props: ['house', 'roundTree', 'lamppost'], seaProps: []
    },
    night: {
      ground: '#1F3A5F', groundStripe: '#24456F', road: '#3B4256', roadEdge: '#CFD8FF', laneMark: '#FFE45C',
      accent: '#FFF6A5', dust: '#3C5F8F', treat: 'star', treatColor: '#FFD700',
      props: ['houseLit', 'lamppostOn', 'pine'], seaProps: []
    }
  };
  var COLOR_KEYS = ['ground', 'groundStripe', 'road', 'roadEdge', 'laneMark', 'accent', 'dust', 'treatColor'];
  var TREAT_COLORS = { strawberry: '#FF3B5C', starfish: '#FF9F1C', balloon: '#4D96FF', star: '#FFD700' };
  var SEA = '#4FC3F7';

  // ---------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------

  function clamp01(v) { return v > 0 ? (v < 1 ? v : 1) : 0; }
  function mod(a, n) { var r = a % n; return r < 0 ? r + n : r; }
  function num(v, d) { v = +v; return v === v ? v : d; } // NaN-safe

  var rgbCache = Object.create(null);
  function rgb(hex) {
    var c = rgbCache[hex];
    if (c) return c;
    var s = String(hex).replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16) || 0;
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache[hex] = c;
    return c;
  }
  function byte(v) { v = Math.round(v); return v < 0 ? 0 : v > 255 ? 255 : v; }
  function toHex(r, g, b) {
    return '#' + ((1 << 24) | (byte(r) << 16) | (byte(g) << 8) | byte(b)).toString(16).slice(1).toUpperCase();
  }
  function mixHex(a, b, m) {
    var A = rgb(a), B = rgb(b);
    return toHex(A[0] + (B[0] - A[0]) * m, A[1] + (B[1] - A[1]) * m, A[2] + (B[2] - A[2]) * m);
  }
  var shadeCache = new Map();
  // amt < 0 darkens towards a deep plum, amt > 0 lightens towards white.
  function shade(hex, amt) {
    var k = hex + amt;
    var v = shadeCache.get(k);
    if (v) return v;
    if (shadeCache.size > 4000) shadeCache.clear();
    v = amt < 0 ? mixHex(hex, '#2A1830', -amt) : mixHex(hex, '#FFFFFF', amt);
    shadeCache.set(k, v);
    return v;
  }
  function rgba(hex, a) { var c = rgb(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Path helpers (they add to the current path).
  function rr(g, x, y, w, h, r) {
    if (r > w / 2) r = w / 2;
    if (r > h / 2) r = h / 2;
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function circ(g, x, y, r) { g.moveTo(x + r, y); g.arc(x, y, r, 0, TAU); }
  function ell(g, x, y, rx, ry, rot) {
    rot = rot || 0;
    g.moveTo(x + rx * Math.cos(rot), y + rx * Math.sin(rot));
    g.ellipse(x, y, rx, ry, rot, 0, TAU);
  }
  function starPath(g, n, ro, ri, rot, cx, cy) {
    cx = cx || 0; cy = cy || 0;
    g.beginPath();
    for (var i = 0; i < n * 2; i++) {
      var r = i % 2 ? ri : ro;
      var a = rot + i * Math.PI / n - Math.PI / 2;
      if (i === 0) g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      else g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.closePath();
  }
  // Concave 4-point sparkle centered on (0,0), radius r.
  function sparklePath(g, r) {
    var k = r * 0.16;
    g.beginPath();
    g.moveTo(0, -r);
    g.quadraticCurveTo(k, -k, r, 0);
    g.quadraticCurveTo(k, k, 0, r);
    g.quadraticCurveTo(-k, k, -r, 0);
    g.quadraticCurveTo(-k, -k, 0, -r);
    g.closePath();
  }

  // ---------------------------------------------------------------------------------------------
  // Palette
  // ---------------------------------------------------------------------------------------------

  var SC = { from: 'meadow', to: 'meadow', mix: 0 }; // scratch normalized scene
  function normScene(scene) {
    var f = scene && BIOMES[scene.from] ? scene.from : 'meadow';
    var to = scene && BIOMES[scene.to] ? scene.to : f;
    var m = scene ? num(scene.mix, 0) : 0;
    m = clamp01(m);
    if (f === to) m = 0;
    SC.from = f; SC.to = to; SC.mix = m;
    return SC;
  }
  function weight(key) { return (SC.from === key ? 1 - SC.mix : 0) + (SC.to === key ? SC.mix : 0); }

  var palCache = new Map();
  function palette(scene) {
    normScene(scene);
    var q = Math.round(SC.mix * 128);
    var key = SC.from + '>' + SC.to + ':' + q;
    var p = palCache.get(key);
    if (p) return p;
    if (palCache.size > 3000) palCache.clear();
    var m = q / 128, A = BIOMES[SC.from], B = BIOMES[SC.to];
    p = {};
    for (var i = 0; i < COLOR_KEYS.length; i++) {
      var k = COLOR_KEYS[i];
      p[k] = m <= 0 ? A[k] : m >= 1 ? B[k] : mixHex(A[k], B[k], m);
    }
    var dom = m < 0.5 ? A : B;
    p.biome = m < 0.5 ? SC.from : SC.to; // dominant biome key
    p.treat = dom.treat;                 // treat kind of the dominant biome (its color is p.treatColor)
    p.props = dom.props.slice();
    p.seaProps = dom.seaProps.slice();
    p.sea = SEA;
    palCache.set(key, p);
    return p;
  }

  // ---------------------------------------------------------------------------------------------
  // Sprite cache
  // ---------------------------------------------------------------------------------------------

  var sprites = new Map();
  function dprNow() {
    var d = global.devicePixelRatio || 1;
    return d < 1 ? 1 : d > 3 ? 3 : d;
  }
  function newCanvas(w, h) {
    var c = global.document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  // Returns {c, w, h, ox, oy}: canvas plus its CSS size and the anchor (ox, oy) inside it.
  function getSprite(key, w, h, ox, oy, paint, a1, a2, a3) {
    var dpr = dprNow();
    var k = dpr === 1 ? key : key + '@' + dpr;
    var s = sprites.get(k);
    if (s) return s;
    if (sprites.size > 600) sprites.clear();
    var c = newCanvas(w * dpr, h * dpr), g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.translate(ox, oy);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    paint(g, a1, a2, a3);
    s = { c: c, w: w, h: h, ox: ox, oy: oy };
    sprites.set(k, s);
    return s;
  }
  function blit(ctx, s, x, y, scale) {
    ctx.drawImage(s.c, x - s.ox * scale, y - s.oy * scale, s.w * scale, s.h * scale);
  }
  // Geometric size buckets (~12% apart) so cached sprites stay crisp at any requested size.
  function bucket(px) {
    if (!(px > 8)) return 8;
    if (px > 2048) px = 2048;
    return Math.round(Math.pow(2, Math.round(Math.log2(px) * 6) / 6));
  }

  // Big single-slot caches for full-screen backgrounds.
  var screenCache = Object.create(null);
  function screenSprite(name, w, h, paint, a1) {
    var dpr = dprNow();
    var key = w + 'x' + h + '@' + dpr;
    var e = screenCache[name];
    if (e && e.key === key) return e.s;
    var c = newCanvas(w * dpr, h * dpr), g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    paint(g, w, h, a1);
    var s = { c: c, w: w, h: h, ox: 0, oy: 0 };
    screenCache[name] = { key: key, s: s };
    return s;
  }

  // ---------------------------------------------------------------------------------------------
  // Treats (unit space: diameter 1, centered)
  // ---------------------------------------------------------------------------------------------

  function face(g, cx, cy, s, dark) {
    g.fillStyle = 'rgba(255,110,150,0.55)';
    g.beginPath();
    ell(g, cx - 0.13 * s, cy + 0.055 * s, 0.045 * s, 0.03 * s);
    ell(g, cx + 0.13 * s, cy + 0.055 * s, 0.045 * s, 0.03 * s);
    g.fill();
    g.fillStyle = dark;
    g.beginPath();
    ell(g, cx - 0.075 * s, cy - 0.02 * s, 0.032 * s, 0.045 * s);
    ell(g, cx + 0.075 * s, cy - 0.02 * s, 0.032 * s, 0.045 * s);
    g.fill();
    g.fillStyle = '#FFFFFF';
    g.beginPath();
    circ(g, cx - 0.085 * s, cy - 0.035 * s, 0.013 * s);
    circ(g, cx + 0.065 * s, cy - 0.035 * s, 0.013 * s);
    g.fill();
    g.strokeStyle = dark;
    g.lineWidth = 0.026 * s;
    g.beginPath();
    g.arc(cx, cy + 0.03 * s, 0.055 * s, 0.18 * Math.PI, 0.82 * Math.PI);
    g.stroke();
  }

  function berryPath(g) {
    g.beginPath();
    g.moveTo(0, 0.44);
    g.bezierCurveTo(-0.2, 0.41, -0.43, 0.17, -0.41, -0.07);
    g.bezierCurveTo(-0.39, -0.29, -0.16, -0.31, 0, -0.25);
    g.bezierCurveTo(0.16, -0.31, 0.39, -0.29, 0.41, -0.07);
    g.bezierCurveTo(0.43, 0.17, 0.2, 0.41, 0, 0.44);
    g.closePath();
  }
  function calyxPath(g) {
    g.beginPath();
    for (var i = 0; i < 10; i++) {
      var r = i % 2 ? 0.07 : 0.25;
      var a = Math.PI / 2 + i * Math.PI / 5;
      var px = Math.cos(a) * r, py = -0.255 + Math.sin(a) * r * 0.5;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
  }
  function stemPath(g) {
    g.beginPath();
    g.moveTo(0, -0.27);
    g.quadraticCurveTo(0.0, -0.38, 0.07, -0.44);
  }

  function paintTreat(g, kind, B) {
    g.scale(B, B);
    var ow = 8 / B;          // 4 px white outline each side
    var dl = 0.035;          // dark inner outline half-width
    var col = TREAT_COLORS[kind] || '#FF3B5C';
    var dk = shade(col, -0.5), lt = shade(col, 0.55);
    // soft glow
    var gr = g.createRadialGradient(0, 0, 0.1, 0, 0, 0.82);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.42, rgba(lt, 0.6));
    gr.addColorStop(0.7, rgba(col, 0.22));
    gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr;
    g.beginPath(); g.arc(0, 0, 0.82, 0, TAU); g.fill();
    g.lineJoin = 'round'; g.lineCap = 'round';
    var i;

    if (kind === 'starfish') {
      var fat = 0.17, rot = -0.1;
      starPath(g, 5, 0.36, 0.175, rot);
      g.strokeStyle = '#FFFFFF'; g.lineWidth = fat + 2 * dl + ow; g.stroke();
      g.strokeStyle = dk; g.lineWidth = fat + 2 * dl; g.stroke();
      g.strokeStyle = col; g.lineWidth = fat; g.stroke();
      g.fillStyle = col; g.fill();
      // lighter belly
      starPath(g, 5, 0.25, 0.14, rot);
      g.strokeStyle = shade(col, 0.18); g.lineWidth = 0.1; g.stroke();
      g.fillStyle = shade(col, 0.18); g.fill();
      // bumps along the arms
      g.fillStyle = shade(col, 0.6);
      g.beginPath();
      for (i = 0; i < 5; i++) {
        var a = rot + i * TAU / 5 - Math.PI / 2;
        circ(g, Math.cos(a) * 0.31, Math.sin(a) * 0.31, 0.03);
        circ(g, Math.cos(a) * 0.4, Math.sin(a) * 0.4, 0.022);
      }
      g.fill();
      face(g, 0, 0.02, 1.15, '#5A2A12');
      return;
    }

    if (kind === 'balloon') {
      var by = -0.1, rx = 0.33, ry = 0.38;
      // string
      g.beginPath();
      g.moveTo(0, by + ry + 0.06);
      g.bezierCurveTo(0.09, by + ry + 0.12, -0.08, by + ry + 0.18, 0.03, by + ry + 0.26);
      g.strokeStyle = '#FFFFFF'; g.lineWidth = 0.03 + ow; g.stroke();
      g.strokeStyle = '#6E6680'; g.lineWidth = 0.03; g.stroke();
      // knot + balloon white outline
      g.beginPath();
      ell(g, 0, by, rx, ry);
      g.moveTo(0, by + ry - 0.02); g.lineTo(-0.06, by + ry + 0.065); g.lineTo(0.06, by + ry + 0.065); g.closePath();
      g.strokeStyle = '#FFFFFF'; g.lineWidth = 2 * dl + ow; g.stroke();
      g.strokeStyle = dk; g.lineWidth = 2 * dl; g.stroke();
      g.fillStyle = shade(col, -0.18); g.fill();
      // main body leaves a darker crescent bottom-right
      g.beginPath(); ell(g, -0.035, by - 0.04, rx - 0.035, ry - 0.04); g.fillStyle = col; g.fill();
      // shine
      g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 0.065;
      g.beginPath(); g.ellipse(0, by, rx * 0.68, ry * 0.7, 0, Math.PI * 1.08, Math.PI * 1.38); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath(); circ(g, -0.07, by - 0.27, 0.035); g.fill();
      return;
    }

    if (kind === 'star') {
      var sf = 0.14;
      starPath(g, 5, 0.37, 0.18, 0, 0, 0.02);
      g.strokeStyle = '#FFFFFF'; g.lineWidth = sf + 2 * dl + ow; g.stroke();
      g.strokeStyle = shade(col, -0.42); g.lineWidth = sf + 2 * dl; g.stroke();
      g.strokeStyle = col; g.lineWidth = sf; g.stroke();
      g.fillStyle = col; g.fill();
      // lighter inner star for a soft bevel
      starPath(g, 5, 0.25, 0.13, 0, 0, 0.02);
      g.strokeStyle = shade(col, 0.4); g.lineWidth = 0.08; g.stroke();
      g.fillStyle = shade(col, 0.4); g.fill();
      // shine
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath(); ell(g, -0.17, -0.12, 0.06, 0.035, -0.6); g.fill();
      face(g, 0, 0.05, 1.1, '#7A4A00');
      return;
    }

    // strawberry (default)
    berryPath(g);
    g.strokeStyle = '#FFFFFF'; g.lineWidth = 2 * dl + ow; g.stroke();
    calyxPath(g); g.stroke();
    stemPath(g); g.lineWidth = 0.07 + 2 * dl + ow; g.stroke();
    berryPath(g);
    g.strokeStyle = dk; g.lineWidth = 2 * dl; g.stroke();
    g.fillStyle = col; g.fill();
    // volume: darker lower right
    g.save();
    g.clip();
    g.fillStyle = shade(col, -0.16);
    g.beginPath(); ell(g, 0.2, 0.25, 0.32, 0.3); g.fill();
    g.restore();
    // seeds
    var seeds = [-0.2, -0.08, 0, -0.03, 0.2, -0.08, -0.27, 0.1, -0.09, 0.13, 0.11, 0.13, 0.27, 0.1,
      -0.16, 0.27, 0.02, 0.3, 0.17, 0.26, -0.05, 0.42 - 0.04];
    g.fillStyle = '#FFE680';
    g.beginPath();
    for (i = 0; i < seeds.length; i += 2) ell(g, seeds[i], seeds[i + 1], 0.022, 0.032);
    g.fill();
    // shine
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.beginPath(); ell(g, -0.22, -0.1, 0.07, 0.045, -0.9); g.fill();
    // leaves
    var lc = '#46C24F', ld = shade(lc, -0.5);
    calyxPath(g);
    g.strokeStyle = ld; g.lineWidth = 2 * dl; g.stroke();
    g.fillStyle = lc; g.fill();
    stemPath(g);
    g.strokeStyle = ld; g.lineWidth = 0.07 + 2 * dl; g.stroke();
    g.strokeStyle = lc; g.lineWidth = 0.07; g.stroke();
  }

  function treatSprite(kind, B) {
    var S = Math.ceil(B * 1.75);
    return getSprite('t:' + kind + ':' + B, S, S, S / 2, S / 2, paintTreat, kind, B);
  }

  function paintSparkle(g, color, B) {
    g.scale(B, B);
    var gr = g.createRadialGradient(0, 0, 0, 0, 0, 0.5);
    gr.addColorStop(0, rgba(color, 0.7));
    gr.addColorStop(0.35, rgba(color, 0.25));
    gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr;
    g.beginPath(); g.arc(0, 0, 0.5, 0, TAU); g.fill();
    sparklePath(g, 0.42);
    g.fillStyle = color; g.fill();
    sparklePath(g, 0.22);
    g.fillStyle = '#FFFFFF'; g.fill();
  }
  function sparkleSprite(color, B) {
    return getSprite('sp:' + color + ':' + B, B, B, B / 2, B / 2, paintSparkle, color, B);
  }

  function drawTreatStatic(ctx, kind, x, y, size) {
    var B = bucket(size);
    blit(ctx, treatSprite(kind, B), x, y, size / B);
  }

  // ---------------------------------------------------------------------------------------------
  // Props (unit space: width 1, height = aspect, centered)
  // ---------------------------------------------------------------------------------------------

  var LW = 0.03;

  function pShadow(g, x, y, rx, ry) {
    g.fillStyle = 'rgba(40,25,70,0.18)';
    g.beginPath(); ell(g, x, y, rx, ry); g.fill();
  }
  function fs(g, fill, lw, stroke) {
    g.fillStyle = fill; g.fill();
    g.lineWidth = lw || LW; g.strokeStyle = stroke || OL; g.stroke();
  }
  // Union of circles [x, y, r, ...] with an outline only around the outside.
  function blob(g, C, fill, lw) {
    g.beginPath();
    for (var i = 0; i < C.length; i += 3) circ(g, C[i], C[i + 1], C[i + 2]);
    g.lineWidth = (lw || LW) * 2; g.strokeStyle = OL; g.stroke();
    g.fillStyle = fill; g.fill();
  }
  function dots(g, C, fill) {
    g.fillStyle = fill;
    g.beginPath();
    for (var i = 0; i < C.length; i += 3) circ(g, C[i], C[i + 1], C[i + 2]);
    g.fill();
  }
  function flower(g, x, y, r, petal, center) {
    g.beginPath();
    for (var i = 0; i < 5; i++) {
      var a = i * TAU / 5 - Math.PI / 2;
      circ(g, x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.48);
    }
    g.lineWidth = LW * 1.6; g.strokeStyle = OL; g.stroke();
    g.fillStyle = petal; g.fill();
    g.beginPath(); circ(g, x, y, r * 0.36);
    g.fillStyle = center; g.fill(); g.lineWidth = LW * 0.6; g.stroke();
  }

  function propTree(g, A, v) {
    var gy = A / 2 - 0.06;
    pShadow(g, 0.03, gy, 0.36, 0.075);
    g.beginPath();
    g.moveTo(-0.1, gy);
    g.quadraticCurveTo(-0.05, gy - 0.18, -0.07, gy - 0.42);
    g.lineTo(0.07, gy - 0.42);
    g.quadraticCurveTo(0.05, gy - 0.18, 0.1, gy);
    g.closePath();
    fs(g, '#A86B3C');
    var leaf = v === 2 ? '#52BF3F' : '#3FB54A';
    blob(g, [0, -0.2, 0.3, -0.25, -0.02, 0.22, 0.25, -0.02, 0.22, -0.15, -0.33, 0.2, 0.15, -0.35, 0.2, 0, 0.07, 0.22], leaf);
    // inner shade at the bottom + highlights at the top left
    g.save();
    g.beginPath(); circ(g, 0, 0.07, 0.22); circ(g, -0.25, -0.02, 0.22); circ(g, 0.25, -0.02, 0.22);
    g.clip();
    g.fillStyle = 'rgba(30,90,40,0.18)';
    g.beginPath(); ell(g, 0.05, 0.2, 0.5, 0.15); g.fill();
    g.restore();
    dots(g, [-0.15, -0.32, 0.1, -0.29, -0.07, 0.07, 0.03, -0.42, 0.05, 0.12, -0.27, 0.06], 'rgba(255,255,255,0.25)');
    if (v === 0) {
      var ap = [-0.16, -0.12, 0.13, -0.2, 0.24, 0.05, -0.02, 0.06, 0.03, -0.36, -0.3, 0.06];
      g.beginPath();
      for (var i = 0; i < ap.length; i += 2) circ(g, ap[i], ap[i + 1], 0.048);
      fs(g, '#FF4D4D', 0.022);
      dots(g, [-0.175, -0.135, 0.016, 0.115, -0.215, 0.016, 0.225, 0.035, 0.016, -0.035, 0.045, 0.016, 0.015, -0.375, 0.016, -0.315, 0.045, 0.016], 'rgba(255,255,255,0.8)');
    } else if (v === 1) {
      var bl = [-0.16, -0.12, 0.13, -0.2, 0.24, 0.05, -0.02, 0.06, 0.03, -0.36, -0.3, 0.06, -0.12, -0.42 + 0.1];
      for (var j = 0; j < bl.length; j += 2) flower(g, bl[j], bl[j + 1], 0.07, '#FFFFFF', '#FFD93D');
    }
  }

  function propBush(g, A, v) {
    var gy = A / 2 - 0.05;
    pShadow(g, 0.02, gy, 0.44, 0.07);
    blob(g, [-0.27, 0.08, 0.2, 0.27, 0.08, 0.2, 0, -0.04, 0.27, -0.12, 0.12, 0.2, 0.13, 0.12, 0.2], '#3EAE45');
    dots(g, [-0.1, -0.15, 0.08, -0.3, 0.0, 0.06, 0.12, -0.1, 0.06], 'rgba(255,255,255,0.22)');
    var cols = ['#FF6FB5', '#FFFFFF', '#FFE45C'];
    var c = cols[v % 3];
    flower(g, -0.2, 0.02, 0.085, c, '#FFD93D');
    flower(g, 0.06, -0.14, 0.085, c, '#FFD93D');
    flower(g, 0.25, 0.08, 0.085, c, '#FFD93D');
  }

  function propFlowers(g, A, v) {
    var gy = A / 2 - 0.05;
    pShadow(g, 0, gy, 0.42, 0.07);
    var F = [-0.28, -0.04, 0.02, -0.2, 0.28, -0.03, -0.12, 0.11, 0.15, 0.12];
    var palettes = [
      ['#FF6FB5', '#FFE45C', '#FFFFFF', '#B388FF', '#FF8A65'],
      ['#FFE45C', '#FF6FB5', '#B388FF', '#FFFFFF', '#4FC3F7'],
      ['#FFFFFF', '#FF8A65', '#FF6FB5', '#FFE45C', '#B388FF']
    ];
    var P = palettes[v % 3];
    var i;
    // stems
    g.beginPath();
    for (i = 0; i < F.length; i += 2) { g.moveTo(F[i], F[i + 1]); g.quadraticCurveTo(F[i] * 0.8 + 0.03, (F[i + 1] + gy) / 2, F[i] * 0.5, gy - 0.06); }
    g.strokeStyle = OL; g.lineWidth = 0.065; g.stroke();
    g.strokeStyle = '#3FAE3A'; g.lineWidth = 0.035; g.stroke();
    // grass mound hides the stem ends
    blob(g, [-0.25, gy - 0.05, 0.12, 0, gy - 0.07, 0.14, 0.25, gy - 0.05, 0.12], '#4DBA45');
    // leaves
    g.beginPath();
    ell(g, -0.17, 0.25, 0.08, 0.035, -0.5);
    ell(g, 0.17, 0.24, 0.08, 0.035, 0.5);
    ell(g, 0.02, 0.2, 0.07, 0.03, -0.3);
    fs(g, '#4DBA45', 0.022);
    for (i = 0; i < F.length; i += 2) flower(g, F[i], F[i + 1], 0.15, P[i / 2], i === 2 ? '#FF9F1C' : '#FFC93D');
  }

  function propCow(g, A, v) {
    var gy = A / 2 - 0.05;
    pShadow(g, 0.06, gy, 0.42, 0.06);
    var hoof = '#5A4A50', white = '#FFFFFF', spot = '#3B3340', pink = '#FFB3C7';
    // legs (back ones slightly darker)
    var legs = [-0.12, 0.0, 0.26, 0.36];
    for (var i = 0; i < 4; i++) {
      g.beginPath(); rr(g, legs[i] - 0.045, 0.08, 0.09, gy - 0.08, 0.04);
      fs(g, i % 2 ? '#EDE8EE' : white);
      g.beginPath(); rr(g, legs[i] - 0.045, gy - 0.05, 0.09, 0.05, 0.02);
      fs(g, hoof, 0.02);
    }
    // tail
    g.beginPath(); g.moveTo(0.4, -0.04); g.quadraticCurveTo(0.5, 0.02, 0.46, 0.16);
    g.strokeStyle = OL; g.lineWidth = 0.05; g.stroke();
    g.strokeStyle = white; g.lineWidth = 0.022; g.stroke();
    g.beginPath(); ell(g, 0.46, 0.18, 0.035, 0.05, 0.2); fs(g, spot, 0.02);
    // body
    g.beginPath(); rr(g, -0.2, -0.13, 0.62, 0.3, 0.14);
    fs(g, white);
    g.save();
    g.beginPath(); rr(g, -0.2, -0.13, 0.62, 0.3, 0.14); g.clip();
    g.fillStyle = spot;
    g.beginPath();
    ell(g, 0.2, -0.1, 0.11, 0.08, 0.3);
    ell(g, 0.02, 0.1, 0.08, 0.06, -0.2);
    ell(g, 0.38, 0.08, 0.07, 0.09, 0);
    g.fill();
    g.restore();
    g.beginPath(); rr(g, -0.2, -0.13, 0.62, 0.3, 0.14); g.lineWidth = LW; g.strokeStyle = OL; g.stroke();
    // udder
    g.beginPath(); ell(g, 0.2, 0.18, 0.06, 0.035); fs(g, pink, 0.02);
    // head (front-facing)
    var hx = -0.27, hy = -0.1;
    g.beginPath(); ell(g, hx - 0.15, hy - 0.06, 0.08, 0.04, -0.35); ell(g, hx + 0.15, hy - 0.06, 0.08, 0.04, 0.35);
    fs(g, white);
    g.beginPath(); ell(g, hx - 0.15, hy - 0.06, 0.045, 0.02, -0.35); ell(g, hx + 0.15, hy - 0.06, 0.045, 0.02, 0.35);
    g.fillStyle = pink; g.fill();
    // horns
    g.beginPath();
    g.moveTo(hx - 0.07, hy - 0.12); g.quadraticCurveTo(hx - 0.12, hy - 0.2, hx - 0.06, hy - 0.22);
    g.moveTo(hx + 0.07, hy - 0.12); g.quadraticCurveTo(hx + 0.12, hy - 0.2, hx + 0.06, hy - 0.22);
    g.strokeStyle = OL; g.lineWidth = 0.06; g.stroke();
    g.strokeStyle = '#FFE7A0'; g.lineWidth = 0.03; g.stroke();
    g.beginPath(); ell(g, hx, hy, 0.13, 0.14); fs(g, white);
    // patch over one eye
    g.save(); g.beginPath(); ell(g, hx, hy, 0.13, 0.14); g.clip();
    g.beginPath(); ell(g, hx + 0.1, hy - 0.08, 0.08, 0.07); g.fillStyle = spot; g.fill();
    g.restore();
    g.beginPath(); ell(g, hx, hy, 0.13, 0.14); g.lineWidth = LW; g.strokeStyle = OL; g.stroke();
    // muzzle
    g.beginPath(); ell(g, hx, hy + 0.08, 0.12, 0.075); fs(g, pink);
    dots(g, [hx - 0.045, hy + 0.08, 0.018, hx + 0.045, hy + 0.08, 0.018], '#B56B85');
    // eyes
    dots(g, [hx - 0.055, hy - 0.035, 0.026, hx + 0.055, hy - 0.035, 0.026], '#2B2140');
    dots(g, [hx - 0.062, hy - 0.045, 0.009, hx + 0.048, hy - 0.045, 0.009], '#FFFFFF');
    // little bell
    g.beginPath(); circ(g, hx + 0.02, hy + 0.17, 0.035); fs(g, '#FFD93D', 0.02);
  }

  function leaf(g, x, y, dx, dy, len, droop, wid, fill) {
    var ex = x + dx * len, ey = y + dy * len + droop;
    var mx = x + dx * len * 0.5, my = y + dy * len * 0.5 - Math.abs(dx) * 0.05;
    var nx = -dy * wid, ny = dx * wid;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(mx + nx, my + ny, ex, ey);
    g.quadraticCurveTo(mx - nx, my - ny, x, y);
    g.closePath();
    fs(g, fill);
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(mx, my, ex, ey);
    g.strokeStyle = 'rgba(30,90,50,0.45)'; g.lineWidth = 0.014; g.stroke();
  }

  function propPalm(g, A, v) {
    var gy = A / 2 - 0.05;
    pShadow(g, 0.04, gy, 0.3, 0.06);
    var tx = -0.03, ty = -0.33;
    g.beginPath(); g.moveTo(0.06, gy - 0.02); g.quadraticCurveTo(0.14, 0.05, tx, ty);
    g.strokeStyle = OL; g.lineWidth = 0.17; g.stroke();
    g.strokeStyle = '#C98B5A'; g.lineWidth = 0.11; g.stroke();
    // trunk rings
    g.strokeStyle = '#9C6A3E'; g.lineWidth = 0.018;
    g.beginPath();
    for (var i = 1; i < 9; i++) {
      var u = i / 9, iu = 1 - u;
      var px = iu * iu * 0.06 + 2 * iu * u * 0.14 + u * u * tx;
      var py = iu * iu * (gy - 0.02) + 2 * iu * u * 0.05 + u * u * ty;
      g.moveTo(px - 0.05, py - 0.015); g.quadraticCurveTo(px, py + 0.02, px + 0.05, py - 0.015);
    }
    g.stroke();
    var lc = v === 1 ? '#4CC860' : '#3DBE5A';
    leaf(g, tx, ty, -0.93, 0.36, 0.44, 0.06, 0.1, shade(lc, -0.1));
    leaf(g, tx, ty, 0.93, 0.36, 0.44, 0.06, 0.1, shade(lc, -0.1));
    leaf(g, tx, ty, -0.75, -0.62, 0.4, 0.07, 0.1, lc);
    leaf(g, tx, ty, 0.78, -0.6, 0.4, 0.07, 0.1, lc);
    leaf(g, tx, ty, -0.25, -0.97, 0.3, 0.02, 0.09, shade(lc, 0.12));
    leaf(g, tx, ty, 0.3, -0.95, 0.3, 0.02, 0.09, shade(lc, 0.12));
    g.beginPath();
    circ(g, tx - 0.05, ty + 0.04, 0.055); circ(g, tx + 0.05, ty + 0.045, 0.055); circ(g, tx, ty + 0.0, 0.055);
    g.lineWidth = LW * 2; g.strokeStyle = OL; g.stroke();
    g.fillStyle = '#8A5A33'; g.fill();
    dots(g, [tx - 0.065, ty + 0.025, 0.014, tx + 0.035, ty + 0.03, 0.014, tx - 0.015, ty - 0.015, 0.014], 'rgba(255,255,255,0.5)');
  }

  function propUmbrella(g, A, v) {
    var gy = A / 2 - 0.05;
    var cols = [['#FF5A5F', '#FFFFFF'], ['#FFD93D', '#4D96FF'], ['#FF6FB5', '#FFFFFF']][v % 3];
    // towel
    g.save();
    g.translate(-0.05, gy - 0.07); g.rotate(-0.08);
    g.beginPath(); rr(g, -0.28, -0.08, 0.56, 0.17, 0.04);
    fs(g, '#4FC3F7');
    g.fillStyle = '#FFFFFF';
    g.beginPath(); g.rect(-0.14, -0.08, 0.06, 0.17); g.rect(0.08, -0.08, 0.06, 0.17); g.fill();
    g.beginPath(); rr(g, -0.28, -0.08, 0.56, 0.17, 0.04); g.lineWidth = LW; g.strokeStyle = OL; g.stroke();
    g.restore();
    // umbrella shade on the towel
    g.fillStyle = 'rgba(40,25,70,0.16)';
    g.beginPath(); ell(g, 0.08, gy - 0.06, 0.38, 0.08); g.fill();
    // pole
    g.beginPath(); g.moveTo(0, -0.3); g.lineTo(0.03, gy - 0.03);
    g.strokeStyle = OL; g.lineWidth = 0.065; g.stroke();
    g.strokeStyle = '#F4F1EC'; g.lineWidth = 0.035; g.stroke();
    // canopy
    var cy = -0.12, R = 0.48, top = -0.46;
    function dome() {
      g.beginPath();
      g.moveTo(-R, cy);
      g.bezierCurveTo(-R, top + 0.02, -0.18, top, 0, top);
      g.bezierCurveTo(0.18, top, R, top + 0.02, R, cy);
      var n = 6, sw = 2 * R / n;
      for (var i = 0; i < n; i++) {
        var x1 = R - i * sw;
        g.quadraticCurveTo(x1 - sw / 2, cy + 0.07, x1 - sw, cy);
      }
      g.closePath();
    }
    dome();
    g.lineWidth = LW * 2; g.strokeStyle = OL; g.stroke();
    g.fillStyle = cols[0]; g.fill();
    g.save();
    dome(); g.clip();
    g.fillStyle = cols[1];
    g.beginPath();
    var xs = [-R, -R / 3, R / 3];
    for (var k = 0; k < 3; k++) {
      g.moveTo(0, top - 0.05);
      g.lineTo(xs[k], cy + 0.1);
      g.lineTo(xs[k] + 2 * R / 6, cy + 0.1);
      g.closePath();
    }
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.3)';
    g.beginPath(); ell(g, -0.2, -0.33, 0.14, 0.05, -0.35); g.fill();
    g.restore();
    dome(); g.lineWidth = LW; g.strokeStyle = OL; g.stroke();
    g.beginPath(); circ(g, 0, top - 0.015, 0.03); fs(g, cols[0], 0.02);
  }

  function propSandcastle(g, A, v) {
    var gy = A / 2 - 0.05;
    pShadow(g, 0.03, gy, 0.46, 0.06);
    var sand = '#F2C26B', dk = '#D9A24A';
    // flag
    g.beginPath(); g.moveTo(0, -0.27); g.lineTo(0, -0.43);
    g.strokeStyle = OL; g.lineWidth = 0.035; g.stroke();
    g.beginPath(); g.moveTo(0.01, -0.43); g.lineTo(0.15, -0.39); g.lineTo(0.01, -0.35); g.closePath();
    fs(g, ['#FF6FB5', '#4FC3F7', '#FF5A5F'][v % 3], 0.022);
    // towers with merlons, union-outlined
    function tower(x0, y0, w, mer) {
      rr(g, x0, y0, w, gy - y0, 0.03);
      var mw = w / 5;
      for (var i = 0; i < 3; i++) rr(g, x0 + i * 2 * mw, y0 - 0.06, mw, 0.08, 0.015);
      if (mer) return;
    }
    g.beginPath();
    rr(g, -0.38, 0.0, 0.76, gy, 0.03);
    tower(-0.44, -0.14, 0.22, false);
    tower(0.22, -0.14, 0.22, false);
    tower(-0.13, -0.27, 0.26, false);
    g.lineWidth = LW * 2; g.strokeStyle = OL; g.stroke();
    g.fillStyle = sand; g.fill();
    // separating lines between towers and wall
    g.strokeStyle = 'rgba(74,53,80,0.5)'; g.lineWidth = 0.02;
    g.beginPath();
    g.moveTo(-0.22, -0.14 + 0.02); g.lineTo(-0.22, gy - 0.02);
    g.moveTo(0.22, -0.14 + 0.02); g.lineTo(0.22, gy - 0.02);
    g.moveTo(-0.13, 0.02); g.lineTo(-0.13, -0.25);
    g.moveTo(0.13, 0.02); g.lineTo(0.13, -0.25);
    g.stroke();
    // door + windows
    g.beginPath();
    g.moveTo(-0.07, gy); g.lineTo(-0.07, 0.24); g.arc(0, 0.24, 0.07, Math.PI, 0); g.lineTo(0.07, gy); g.closePath();
    fs(g, '#9C6A3E', 0.022);
    g.beginPath();
    rr(g, -0.36, -0.03, 0.06, 0.09, 0.03); rr(g, 0.3, -0.03, 0.06, 0.09, 0.03); rr(g, -0.03, -0.17, 0.06, 0.09, 0.03);
    fs(g, '#9C6A3E', 0.018);
    // sand texture
    dots(g, [-0.3, 0.2, 0.012, -0.2, 0.3, 0.01, 0.2, 0.22, 0.012, 0.3, 0.32, 0.01, -0.05, -0.05, 0.01, 0.06, 0.08, 0.012, 0.36, 0.1, 0.01], dk);
    dots(g, [-0.34, -0.1, 0.03, 0.27, -0.1, 0.03, -0.08, -0.22, 0.03], 'rgba(255,255,255,0.35)');
    // shell
    g.beginPath(); g.moveTo(0.3, gy); g.arc(0.3, gy, 0.05, Math.PI, 0); g.closePath();
    fs(g, '#FFB3A7', 0.016);
  }

  function propBoat(g, A, v) {
    var gy = A / 2 - 0.06;
    // water ripples
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.beginPath(); ell(g, 0, gy - 0.04, 0.5, 0.08); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 0.025;
    g.beginPath();
    g.moveTo(-0.48, gy - 0.02); g.quadraticCurveTo(-0.4, gy - 0.07, -0.32, gy - 0.02);
    g.moveTo(0.32, gy - 0.02); g.quadraticCurveTo(0.4, gy - 0.07, 0.48, gy - 0.02);
    g.stroke();
    var hull = ['#FF5A5F', '#FFD93D', '#7ED957'][v % 3];
    // mast
    g.beginPath(); g.moveTo(0, 0.1); g.lineTo(0, -0.43);
    g.strokeStyle = OL; g.lineWidth = 0.05; g.stroke();
    g.strokeStyle = '#A86B3C'; g.lineWidth = 0.025; g.stroke();
    // sails
    g.beginPath(); g.moveTo(0.03, -0.4); g.quadraticCurveTo(0.3, -0.12, 0.38, 0.06); g.lineTo(0.03, 0.06); g.closePath();
    fs(g, '#FFFFFF');
    g.save(); g.clip();
    g.fillStyle = shade(hull, 0.2);
    g.beginPath(); g.rect(0, -0.16, 0.5, 0.08); g.fill();
    g.restore();
    g.beginPath(); g.moveTo(0.03, -0.4); g.quadraticCurveTo(0.3, -0.12, 0.38, 0.06); g.lineTo(0.03, 0.06); g.closePath();
    g.lineWidth = LW; g.strokeStyle = OL; g.stroke();
    g.beginPath(); g.moveTo(-0.03, -0.3); g.quadraticCurveTo(-0.22, -0.1, -0.3, 0.06); g.lineTo(-0.03, 0.06); g.closePath();
    fs(g, '#FFFFFF');
    // pennant
    g.beginPath(); g.moveTo(0, -0.43); g.lineTo(-0.13, -0.4); g.lineTo(0, -0.36); g.closePath();
    fs(g, '#FF6FB5', 0.02);
    // hull
    g.beginPath();
    g.moveTo(-0.46, 0.08); g.lineTo(0.46, 0.08);
    g.bezierCurveTo(0.42, 0.22, 0.3, 0.32, 0.18, 0.32);
    g.lineTo(-0.18, 0.32);
    g.bezierCurveTo(-0.3, 0.32, -0.42, 0.22, -0.46, 0.08);
    g.closePath();
    fs(g, hull);
    g.strokeStyle = '#FFFFFF'; g.lineWidth = 0.035;
    g.beginPath(); g.moveTo(-0.4, 0.14); g.lineTo(0.4, 0.14); g.stroke();
    g.beginPath(); circ(g, -0.2, 0.22, 0.035); circ(g, 0, 0.22, 0.035); circ(g, 0.2, 0.22, 0.035);
    fs(g, '#BDE7FF', 0.018);
    // bow wave
    g.strokeStyle = '#FFFFFF'; g.lineWidth = 0.03;
    g.beginPath(); g.moveTo(-0.3, gy - 0.02); g.quadraticCurveTo(0, gy + 0.03, 0.3, gy - 0.02); g.stroke();
  }

  var HOUSE_WALLS = ['#FFB3C7', '#B5EAD7', '#FFE6A7'];
  var HOUSE_ROOFS = ['#FF5A5F', '#4D96FF', '#FF8A3D'];
  var HOUSE_DOORS = ['#8E5BD9', '#FF6FB5', '#3FAE5A'];
  var NIGHT_TINT = '#1F2A55';

  function propHouse(g, A, v, lit) {
    var gy = A / 2 - 0.05;
    var wall = HOUSE_WALLS[v % 3], roof = HOUSE_ROOFS[v % 3], door = HOUSE_DOORS[v % 3];
    if (lit) { wall = mixHex(wall, NIGHT_TINT, 0.5); roof = mixHex(roof, NIGHT_TINT, 0.45); door = mixHex(door, NIGHT_TINT, 0.4); }
    var win = lit ? '#FFE58A' : '#BDE7FF';
    pShadow(g, 0.04, gy, 0.46, 0.06);
    // chimney
    g.beginPath(); rr(g, 0.17, -0.42, 0.11, 0.25, 0.02); fs(g, lit ? mixHex('#C4705A', NIGHT_TINT, 0.45) : '#C4705A');
    // walls
    g.beginPath(); rr(g, -0.37, -0.1, 0.74, gy + 0.1, 0.04); fs(g, wall);
    if (lit) {
      // window glow pools on the wall
      var gl = g.createRadialGradient(0, 0, 0, 0, 0, 0.22);
      gl.addColorStop(0, 'rgba(255,229,138,0.55)');
      gl.addColorStop(1, 'rgba(255,229,138,0)');
      g.fillStyle = gl;
      g.save(); g.translate(-0.21, 0.13); g.beginPath(); g.arc(0, 0, 0.22, 0, TAU); g.fill(); g.restore();
      g.save(); g.translate(0.21, 0.13); g.beginPath(); g.arc(0, 0, 0.22, 0, TAU); g.fill(); g.restore();
    }
    // roof
    g.beginPath();
    g.moveTo(-0.47, -0.06); g.lineTo(0, -0.46); g.lineTo(0.47, -0.06); g.closePath();
    g.strokeStyle = OL; g.lineWidth = 0.1; g.stroke();
    g.strokeStyle = roof; g.lineWidth = 0.05; g.stroke();
    g.fillStyle = roof; g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 0.025;
    g.beginPath(); g.moveTo(-0.38, -0.08); g.lineTo(-0.02, -0.4); g.stroke();
    // round attic window
    g.beginPath(); circ(g, 0, -0.2, 0.07); fs(g, win, 0.025);
    g.beginPath(); g.moveTo(-0.07, -0.2); g.lineTo(0.07, -0.2); g.moveTo(0, -0.27); g.lineTo(0, -0.13);
    g.strokeStyle = OL; g.lineWidth = 0.018; g.stroke();
    // windows
    var wx = [-0.29, 0.13];
    for (var i = 0; i < 2; i++) {
      g.beginPath(); rr(g, wx[i], 0.04, 0.16, 0.16, 0.03); fs(g, win, 0.026);
      g.beginPath(); g.moveTo(wx[i] + 0.08, 0.04); g.lineTo(wx[i] + 0.08, 0.2); g.moveTo(wx[i], 0.12); g.lineTo(wx[i] + 0.16, 0.12);
      g.strokeStyle = OL; g.lineWidth = 0.018; g.stroke();
      if (!lit) { g.fillStyle = 'rgba(255,255,255,0.7)'; g.beginPath(); g.rect(wx[i] + 0.02, 0.055, 0.04, 0.04); g.fill(); }
      // flower box
      g.beginPath(); rr(g, wx[i] - 0.015, 0.2, 0.19, 0.05, 0.015); fs(g, lit ? '#6A4A5A' : '#A86B3C', 0.02);
      dots(g, [wx[i] + 0.03, 0.2, 0.025, wx[i] + 0.08, 0.195, 0.025, wx[i] + 0.13, 0.2, 0.025], lit ? '#C46A9A' : '#FF6FB5');
    }
    // door
    g.beginPath();
    g.moveTo(-0.075, gy); g.lineTo(-0.075, 0.17); g.arc(0, 0.17, 0.075, Math.PI, 0); g.lineTo(0.075, gy); g.closePath();
    fs(g, door, 0.026);
    if (lit) { g.beginPath(); circ(g, 0, 0.17, 0.035); fs(g, win, 0.016); }
    dots(g, [0.045, 0.3, 0.014], '#FFD93D');
    // step
    g.beginPath(); rr(g, -0.11, gy - 0.025, 0.22, 0.035, 0.012); fs(g, lit ? '#6E7590' : '#CFC8BA', 0.018);
  }
  function propHouseLit(g, A, v) { propHouse(g, A, v, true); }

  function propRoundTree(g, A, v) {
    var gy = A / 2 - 0.05;
    pShadow(g, 0.03, gy, 0.28, 0.06);
    g.beginPath(); ell(g, 0, gy - 0.01, 0.2, 0.05); fs(g, '#BDB6A8');
    g.beginPath(); rr(g, -0.05, 0.05, 0.1, gy - 0.05, 0.03); fs(g, '#A86B3C');
    var cols = ['#5CCB5F', '#7FD34E', '#F7A1C4'];
    var c = cols[v % 3];
    g.beginPath(); circ(g, 0, -0.22, 0.42); fs(g, c, LW * 1.1);
    g.save(); g.beginPath(); circ(g, 0, -0.22, 0.42); g.clip();
    g.fillStyle = shade(c, -0.12);
    g.beginPath(); circ(g, 0.12, -0.08, 0.42); g.fill();
    g.fillStyle = c;
    g.beginPath(); circ(g, -0.02, -0.25, 0.37); g.fill();
    g.restore();
    g.beginPath(); circ(g, 0, -0.22, 0.42); g.lineWidth = LW * 1.1; g.strokeStyle = OL; g.stroke();
    // leaf dots / blossoms
    var D = [-0.18, -0.32, 0.12, -0.38, 0.22, -0.18, -0.05, -0.08, 0.06, -0.24, -0.26, -0.12];
    g.fillStyle = v === 2 ? '#FFFFFF' : shade(c, -0.18);
    g.beginPath();
    for (var i = 0; i < D.length; i += 2) circ(g, D[i], D[i + 1], 0.03);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.beginPath(); ell(g, -0.18, -0.42, 0.1, 0.05, -0.6); g.fill();
  }

  function propLamppost(g, A, v, on) {
    var gy = A / 2 - 0.05;
    var pole = on ? '#5A6A92' : '#4A5A78';
    if (on) {
      var pool = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      pool.addColorStop(0, 'rgba(255,243,176,0.45)');
      pool.addColorStop(1, 'rgba(255,243,176,0)');
      g.save(); g.translate(0, gy); g.scale(0.95, 0.24);
      g.fillStyle = pool; g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
      g.restore();
    } else {
      pShadow(g, 0.03, gy, 0.26, 0.06);
    }
    // base
    g.beginPath();
    g.moveTo(-0.22, gy); g.lineTo(0.22, gy); g.lineTo(0.13, gy - 0.2); g.lineTo(-0.13, gy - 0.2); g.closePath();
    g.strokeStyle = OL; g.lineWidth = LW * 2; g.stroke();
    g.fillStyle = pole; g.fill();
    // pole
    g.beginPath(); rr(g, -0.065, -0.56, 0.13, gy - 0.18 + 0.56, 0.04); fs(g, pole);
    g.fillStyle = 'rgba(255,255,255,0.25)'; g.beginPath(); g.rect(-0.04, -0.5, 0.025, gy - 0.25 + 0.5); g.fill();
    // collar
    g.beginPath(); rr(g, -0.15, -0.62, 0.3, 0.08, 0.03); fs(g, pole);
    // glass
    var gx0 = -0.22, gy0 = -0.96, gw = 0.44, gh = 0.35;
    g.beginPath(); rr(g, gx0, gy0, gw, gh, 0.1);
    fs(g, on ? '#FFF3B0' : '#EAF6FF');
    if (on) { g.beginPath(); ell(g, 0, gy0 + gh * 0.55, 0.12, 0.12); g.fillStyle = '#FFFFFF'; g.fill(); }
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.beginPath(); rr(g, gx0 + 0.06, gy0 + 0.05, 0.06, 0.18, 0.03); g.fill();
    // cap
    g.beginPath();
    g.moveTo(-0.32, gy0 + 0.02); g.quadraticCurveTo(-0.18, gy0 - 0.16, 0, gy0 - 0.2); g.quadraticCurveTo(0.18, gy0 - 0.16, 0.32, gy0 + 0.02); g.closePath();
    fs(g, pole);
    g.beginPath(); circ(g, 0, gy0 - 0.25, 0.055); fs(g, pole);
    if (on) {
      var cy = gy0 + gh / 2;
      var halo = g.createRadialGradient(0, cy, 0.1, 0, cy, 1.05);
      halo.addColorStop(0, 'rgba(255,246,200,0.75)');
      halo.addColorStop(0.35, 'rgba(255,243,176,0.3)');
      halo.addColorStop(1, 'rgba(255,243,176,0)');
      g.fillStyle = halo;
      g.beginPath(); g.arc(0, cy, 1.05, 0, TAU); g.fill();
    }
  }
  function propLamppostOn(g, A, v) { propLamppost(g, A, v, true); }

  function propPine(g, A, v) {
    var gy = A / 2 - 0.05;
    pShadow(g, 0.03, gy, 0.36, 0.06);
    g.beginPath(); rr(g, -0.07, gy - 0.2, 0.14, 0.2, 0.03); fs(g, '#7A5236');
    var c = ['#2BA36B', '#239A72', '#33AD64'][v % 3];
    var tiers = [[-0.12, 0.54, 0.48], [-0.42, 0.22, 0.4], [-0.72, -0.12, 0.3]];
    for (var i = 0; i < 3; i++) {
      var ty = tiers[i][0], by = tiers[i][1], hw = tiers[i][2];
      g.beginPath();
      g.moveTo(0, ty);
      g.lineTo(hw, by);
      g.quadraticCurveTo(hw * 0.5, by + 0.05, 0, by - 0.005);
      g.quadraticCurveTo(-hw * 0.5, by + 0.05, -hw, by);
      g.closePath();
      g.strokeStyle = OL; g.lineWidth = LW * 2 + 0.03; g.stroke();
      g.strokeStyle = c; g.lineWidth = 0.03; g.stroke();
      g.fillStyle = c; g.fill();
      // lighter left side
      g.beginPath(); g.moveTo(0, ty + 0.03); g.lineTo(-hw + 0.04, by - 0.01); g.quadraticCurveTo(-hw * 0.5, by + 0.035, -0.02, by - 0.01); g.closePath();
      g.fillStyle = shade(c, 0.2); g.fill();
    }
    // a few twinkly snow/light dots
    dots(g, [-0.12, 0.38, 0.022, 0.18, 0.44, 0.022, 0.06, 0.1, 0.022, -0.1, -0.2, 0.02, 0.1, -0.4, 0.018], 'rgba(255,255,255,0.55)');
  }

  var PROPS = {
    tree: { a: 1.25, pad: 0.08, variants: 3, sway: 0.025, draw: propTree },
    bush: { a: 0.72, pad: 0.08, variants: 3, sway: 0.012, draw: propBush },
    flowers: { a: 0.8, pad: 0.08, variants: 3, sway: 0.05, draw: propFlowers },
    cow: { a: 0.8, pad: 0.08, variants: 1, sway: 0, draw: propCow },
    palm: { a: 1.45, pad: 0.1, variants: 2, sway: 0.035, draw: propPalm },
    umbrella: { a: 1.0, pad: 0.08, variants: 3, sway: 0, draw: propUmbrella },
    sandcastle: { a: 0.9, pad: 0.08, variants: 3, sway: 0, draw: propSandcastle },
    boat: { a: 0.95, pad: 0.08, variants: 3, sway: 0, bob: true, draw: propBoat },
    house: { a: 1.05, pad: 0.08, variants: 3, sway: 0, draw: propHouse },
    roundTree: { a: 1.35, pad: 0.08, variants: 3, sway: 0.02, draw: propRoundTree },
    lamppost: { a: 2.6, pad: 0.12, variants: 1, sway: 0, draw: propLamppost },
    houseLit: { a: 1.05, pad: 0.08, variants: 3, sway: 0, draw: propHouseLit },
    lamppostOn: { a: 2.6, pad: 0.65, variants: 1, sway: 0, draw: propLamppostOn },
    pine: { a: 1.5, pad: 0.08, variants: 3, sway: 0.015, draw: propPine }
  };

  function paintProp(g, spec, B, v) {
    g.scale(B, B);
    g.lineJoin = 'round'; g.lineCap = 'round';
    spec.draw(g, spec.a, v);
  }
  function propSprite(kind, spec, B, v) {
    var W = Math.ceil(B * (1 + 2 * spec.pad)), H = Math.ceil(B * (spec.a + 2 * spec.pad));
    return getSprite('p:' + kind + ':' + v + ':' + B, W, H, W / 2, H / 2, paintProp, spec, B, v);
  }

  // ---------------------------------------------------------------------------------------------
  // Ground decor (seeded, deterministic, scrolls with the world)
  // ---------------------------------------------------------------------------------------------

  var DECOR = (function () {
    var rnd = mulberry32(20240607), out = [];
    for (var i = 0; i < 90; i++) {
      out.push({ fx: rnd(), fy: rnd(), k: rnd(), s: 0.7 + rnd() * 0.6, ph: rnd() * TAU, sp: 1.2 + rnd() * 2.2, rot: rnd() * TAU });
    }
    return out;
  })();
  var STARS = (function () {
    var rnd = mulberry32(777), out = [];
    for (var i = 0; i < 70; i++) {
      out.push({ fx: rnd(), fy: rnd(), s: 0.5 + rnd() * rnd() * 1.3, ph: rnd() * TAU, sp: 1.5 + rnd() * 2.5, rot: rnd() * 0.8 });
    }
    return out;
  })();
  var WAVES = (function () {
    var rnd = mulberry32(4242), out = [];
    for (var i = 0; i < 26; i++) out.push({ fx: rnd(), fy: rnd(), s: 0.6 + rnd() * 0.6, ph: rnd() * TAU });
    return out;
  })();

  function paintTuft(g, B) {
    g.scale(B, B);
    g.beginPath();
    g.moveTo(-0.3, 0.3); g.quadraticCurveTo(-0.3, 0, -0.45, -0.25);
    g.moveTo(0, 0.3); g.quadraticCurveTo(0.02, -0.1, 0, -0.42);
    g.moveTo(0.3, 0.3); g.quadraticCurveTo(0.3, 0, 0.45, -0.22);
    g.strokeStyle = '#4FAE3A'; g.lineWidth = 0.14; g.stroke();
  }
  function paintDaisy(g, B, col) {
    g.scale(B, B);
    g.fillStyle = col;
    g.beginPath();
    for (var i = 0; i < 5; i++) { var a = i * TAU / 5; circ(g, Math.cos(a) * 0.22, Math.sin(a) * 0.22, 0.2); }
    g.fill();
    g.fillStyle = '#FFC93D'; g.beginPath(); circ(g, 0, 0, 0.14); g.fill();
  }
  function paintShell(g, B) {
    g.scale(B, B);
    g.beginPath(); g.moveTo(0, 0.3); g.lineTo(-0.38, -0.05); g.arc(0, -0.05, 0.38, Math.PI, 0); g.closePath();
    g.fillStyle = '#FFC1B5'; g.fill();
    g.strokeStyle = '#E8907F'; g.lineWidth = 0.07; g.stroke();
    g.beginPath(); g.moveTo(0, 0.3); g.lineTo(-0.2, -0.36); g.moveTo(0, 0.3); g.lineTo(0, -0.42); g.moveTo(0, 0.3); g.lineTo(0.2, -0.36);
    g.stroke();
  }
  function paintPebble(g, B) {
    g.scale(B, B);
    g.fillStyle = '#E5C47F'; g.beginPath(); ell(g, 0, 0, 0.4, 0.28); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); ell(g, -0.12, -0.08, 0.12, 0.07); g.fill();
  }
  function paintGStar(g, B) {
    g.scale(B, B);
    var gr = g.createRadialGradient(0, 0, 0, 0, 0, 0.5);
    gr.addColorStop(0, 'rgba(255,246,165,0.75)');
    gr.addColorStop(0.4, 'rgba(255,246,165,0.18)');
    gr.addColorStop(1, 'rgba(255,246,165,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 0.5, 0, TAU); g.fill();
    sparklePath(g, 0.36); g.fillStyle = '#FFF6A5'; g.fill();
    g.fillStyle = '#FFFFFF'; g.beginPath(); circ(g, 0, 0, 0.07); g.fill();
  }
  function decorSprite(name, B, paint, col) {
    return getSprite('d:' + name + ':' + B + (col || ''), B, B, B / 2, B / 2, paint, B, col);
  }

  // ---------------------------------------------------------------------------------------------
  // Ground
  // ---------------------------------------------------------------------------------------------

  var seaGrad = { key: '', g: null };

  function drawGround(ctx, w, h, scene, roadCx, R, scroll, t) {
    var P = palette(scene); // also normalizes SC
    var A0 = ctx.globalAlpha;
    R = num(R, 100); scroll = num(scroll, 0); t = num(t, 0);
    ctx.save();
    ctx.fillStyle = P.ground;
    ctx.fillRect(0, 0, w, h);

    // stripes: bands 0.5R tall, period R, scrolling with the world
    var period = R, off = mod(scroll, period), y;
    ctx.fillStyle = P.groundStripe;
    ctx.beginPath();
    for (y = off - period; y < h; y += period) ctx.rect(0, y, w, period * 0.5);
    ctx.fill();

    var wM = weight('meadow'), wB = weight('beach'), wT = weight('town'), wN = weight('night');
    var tileH = 3 * R, toff = mod(scroll, tileH), clear = 0.6 * R, i, d, base, x, s, dx;

    // town: paving grid
    if (wT > 0.01) {
      ctx.globalAlpha = A0 * wT * 0.5;
      ctx.strokeStyle = shade(BIOMES.town.groundStripe, -0.12);
      ctx.lineWidth = Math.max(1, R * 0.006);
      ctx.beginPath();
      var cell = R * 0.25, goff = mod(scroll, cell);
      for (y = goff - cell; y < h; y += cell) {
        ctx.moveTo(0, y); ctx.lineTo(roadCx - clear, y);
        ctx.moveTo(roadCx + clear, y); ctx.lineTo(w, y);
      }
      for (x = roadCx + clear; x < w; x += cell) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (x = roadCx - clear; x > 0; x -= cell) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      ctx.stroke();
      // curbs
      ctx.globalAlpha = A0 * wT;
      ctx.fillStyle = '#C9C2B4';
      ctx.fillRect(roadCx - 0.58 * R, 0, 0.05 * R, h);
      ctx.fillRect(roadCx + 0.53 * R, 0, 0.05 * R, h);
    }

    // meadow: grass tufts and tiny daisies
    if (wM > 0.01) {
      ctx.globalAlpha = A0 * wM;
      var Bt = bucket(R * 0.07), Bd = bucket(R * 0.05);
      var tuft = decorSprite('tuft', Bt, paintTuft), daisyW = decorSprite('daisy', Bd, paintDaisy, '#FFFFFF'),
        daisyP = decorSprite('daisy', Bd, paintDaisy, '#FFB3D1');
      for (base = toff - tileH; base < h + R * 0.1; base += tileH) {
        for (i = 0; i < DECOR.length; i++) {
          d = DECOR[i]; y = base + d.fy * tileH;
          if (y < -R * 0.1 || y > h + R * 0.1) continue;
          x = d.fx * w; dx = x - roadCx;
          if (dx < clear && dx > -clear) continue;
          if (d.k < 0.65) blit(ctx, tuft, x, y, d.s * R * 0.07 / Bt);
          else blit(ctx, d.k < 0.82 ? daisyW : daisyP, x, y, d.s * R * 0.05 / Bd);
        }
      }
    }

    // beach: shells and pebbles, then the sea on the right
    if (wB > 0.01) {
      ctx.globalAlpha = A0 * wB;
      var Bs = bucket(R * 0.06), Bp = bucket(R * 0.04);
      var shell = decorSprite('shell', Bs, paintShell), peb = decorSprite('pebble', Bp, paintPebble);
      var shoreX = roadCx + 1.15 * R;
      for (base = toff - tileH; base < h + R * 0.1; base += tileH) {
        for (i = 0; i < DECOR.length; i += 2) {
          d = DECOR[i]; y = base + d.fy * tileH;
          if (y < -R * 0.1 || y > h + R * 0.1) continue;
          x = d.fx * w; dx = x - roadCx;
          if ((dx < clear && dx > -clear) || x > shoreX - 0.1 * R) continue;
          if (d.k < 0.4) blit(ctx, shell, x, y, d.s * R * 0.06 / Bs);
          else blit(ctx, peb, x, y, d.s * R * 0.04 / Bp);
        }
      }
      if (shoreX < w) drawSea(ctx, w, h, shoreX, R, scroll, t, A0 * wB);
    }

    // night: deterministic twinkling stars
    if (wN > 0.01) {
      var Bg = bucket(R * 0.1), gst = decorSprite('gstar', Bg, paintGStar);
      ctx.save();
      for (base = toff - tileH; base < h + R * 0.1; base += tileH) {
        for (i = 0; i < STARS.length; i++) {
          d = STARS[i]; y = base + d.fy * tileH;
          if (y < -R * 0.1 || y > h + R * 0.1) continue;
          x = d.fx * w; dx = x - roadCx;
          if (dx < 0.62 * R && dx > -0.62 * R) continue;
          var tw = 0.55 + 0.45 * Math.sin(t * d.sp + d.ph);
          ctx.globalAlpha = A0 * wN * tw;
          s = R * 0.1 * d.s * (0.8 + 0.25 * tw);
          blit(ctx, gst, x, y, s / Bg);
        }
      }
      ctx.restore();
    }
    ctx.restore();
  }

  function shoreAt(y, shoreX, R, scroll, t) {
    var u = y - scroll;
    return shoreX + 0.035 * R * Math.sin(TAU * u / (0.6 * R)) + 0.012 * R * Math.sin(TAU * u / (0.23 * R) + t * 1.3);
  }

  function drawSea(ctx, w, h, shoreX, R, scroll, t, alpha) {
    var step = Math.max(6, R * 0.04), y;
    ctx.globalAlpha = alpha;
    // wet sand
    ctx.fillStyle = '#E8C77A';
    ctx.beginPath();
    ctx.moveTo(w + 2, -step);
    for (y = -step; y <= h + step; y += step) ctx.lineTo(shoreAt(y, shoreX, R, scroll, t) - 0.07 * R, y);
    ctx.lineTo(w + 2, h + step);
    ctx.closePath();
    ctx.fill();
    // water
    var key = (shoreX | 0) + ':' + (w | 0);
    if (seaGrad.key !== key) {
      var gr = ctx.createLinearGradient(shoreX, 0, w, 0);
      gr.addColorStop(0, '#6AD3FA');
      gr.addColorStop(0.25, SEA);
      gr.addColorStop(1, '#2FA2E0');
      seaGrad.key = key; seaGrad.g = gr;
    }
    ctx.fillStyle = seaGrad.g;
    ctx.beginPath();
    ctx.moveTo(w + 2, -step);
    for (y = -step; y <= h + step; y += step) ctx.lineTo(shoreAt(y, shoreX, R, scroll, t), y);
    ctx.lineTo(w + 2, h + step);
    ctx.closePath();
    ctx.fill();
    // foam line
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.03 * R;
    ctx.beginPath();
    for (y = -step; y <= h + step; y += step) {
      var sx = shoreAt(y, shoreX, R, scroll, t);
      if (y === -step) ctx.moveTo(sx, y); else ctx.lineTo(sx, y);
    }
    ctx.stroke();
    // lapping second foam line
    ctx.globalAlpha = alpha * 0.55;
    ctx.lineWidth = 0.016 * R;
    var lap = 0.08 * R + 0.025 * R * Math.sin(t * 1.4);
    ctx.beginPath();
    for (y = -step; y <= h + step; y += step) {
      var sx2 = shoreAt(y, shoreX, R, scroll, t * 0.7) + lap;
      if (y === -step) ctx.moveTo(sx2, y); else ctx.lineTo(sx2, y);
    }
    ctx.stroke();
    // little wave marks
    ctx.globalAlpha = alpha * 0.8;
    ctx.lineWidth = 0.012 * R;
    ctx.lineCap = 'round';
    var tileH = 2 * R, toff = mod(scroll, tileH), x0 = shoreX + 0.2 * R, span = w - x0;
    if (span > 0) {
      ctx.beginPath();
      for (var base = toff - tileH; base < h + R * 0.1; base += tileH) {
        for (var i = 0; i < WAVES.length; i++) {
          var d = WAVES[i]; y = base + d.fy * tileH;
          if (y < -R * 0.1 || y > h + R * 0.1) continue;
          var x = x0 + d.fx * span + Math.sin(t * 0.9 + d.ph) * 0.02 * R, s = 0.045 * R * d.s;
          ctx.moveTo(x - s, y);
          ctx.quadraticCurveTo(x - s / 2, y - s * 0.55, x, y);
          ctx.quadraticCurveTo(x + s / 2, y - s * 0.55, x + s, y);
        }
      }
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Road
  // ---------------------------------------------------------------------------------------------

  function drawRoad(ctx, roadCx, R, h, scene, scroll, t) {
    var P = palette(scene);
    var A0 = ctx.globalAlpha;
    R = num(R, 100); scroll = num(scroll, 0);
    var x0 = roadCx - R / 2, y;
    ctx.save();
    // soft contact shadow on the ground
    ctx.fillStyle = 'rgba(40,25,70,0.12)';
    ctx.fillRect(x0 - R * 0.035, 0, R * 1.07, h);
    ctx.fillStyle = P.road;
    ctx.fillRect(x0, 0, R, h);
    // darker rims
    ctx.fillStyle = shade(P.road, -0.12);
    ctx.fillRect(x0, 0, R * 0.03, h);
    ctx.fillRect(x0 + R * 0.97, 0, R * 0.03, h);
    // subtle scrolling texture so speed reads on the road too
    var tile = R * 2, toff = mod(scroll, tile);
    ctx.fillStyle = shade(P.road, 0.12);
    ctx.globalAlpha = A0 * 0.5;
    ctx.beginPath();
    for (var base = toff - tile; base < h; base += tile) {
      for (var i = 0; i < 24; i++) {
        var d = DECOR[i];
        y = base + d.fy * tile;
        if (y < -10 || y > h + 10) continue;
        var x = x0 + R * (0.1 + 0.8 * d.fx);
        ell(ctx, x, y, R * 0.018 * d.s, R * 0.01 * d.s);
      }
    }
    ctx.fill();
    ctx.globalAlpha = A0;
    // edge lines
    ctx.fillStyle = P.roadEdge;
    ctx.fillRect(x0 + R * 0.05, 0, R * 0.032, h);
    ctx.fillRect(x0 + R * (0.95 - 0.032), 0, R * 0.032, h);
    // dashed center line
    var period = 0.42 * R, dash = 0.2 * R, off = mod(scroll, period);
    ctx.strokeStyle = P.laneMark;
    ctx.lineWidth = 0.036 * R;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (y = off - period; y < h + period; y += period) { ctx.moveTo(roadCx, y); ctx.lineTo(roadCx, y + dash); }
    ctx.stroke();
    // night: little glowing reflectors along the edges
    normScene(scene);
    var wN = weight('night');
    if (wN > 0.01) {
      var B = bucket(R * 0.07), spr = decorSprite('gstar', B, paintGStar);
      ctx.globalAlpha = A0 * wN * (0.75 + 0.25 * Math.sin(num(t, 0) * 3));
      var rp = 0.84 * R, roff = mod(scroll, rp);
      for (y = roff - rp; y < h + rp; y += rp) {
        blit(ctx, spr, x0 + R * 0.015, y, R * 0.07 / B);
        blit(ctx, spr, x0 + R * 0.985, y, R * 0.07 / B);
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------
  // Props, treats, puddles
  // ---------------------------------------------------------------------------------------------

  function drawProp(ctx, kind, x, y, size, t) {
    var spec = PROPS[kind];
    if (!spec || !(size > 0)) return;
    t = num(t, 0);
    var v = spec.variants > 1 ? (Math.floor(Math.abs(x) * 0.173) % spec.variants) : 0;
    var B = bucket(size), spr = propSprite(kind, spec, B, v), k = size / B;
    ctx.save();
    if (spec.sway) {
      var baseY = y + spec.a * size / 2;
      ctx.translate(x, baseY);
      ctx.rotate(spec.sway * Math.sin(t * 1.4 + x * 0.013));
      blit(ctx, spr, 0, -spec.a * size / 2, k);
    } else if (spec.bob) {
      ctx.translate(x, y + Math.sin(t * 2 + x * 0.01) * size * 0.025);
      ctx.rotate(0.05 * Math.sin(t * 1.6 + x * 0.01));
      blit(ctx, spr, 0, 0, k);
    } else {
      blit(ctx, spr, x, y, k);
    }
    ctx.restore();
  }

  function drawTreat(ctx, kind, x, y, size, t, alpha) {
    if (!(size > 0)) return;
    var a = alpha === undefined || alpha === null ? 1 : num(alpha, 1);
    if (!(a > 0)) return;
    t = num(t, 0);
    var A0 = ctx.globalAlpha;
    ctx.save();
    if (a < 1) ctx.globalAlpha = A0 * a;
    var ph = x * 0.004;
    var by = y + Math.sin(t * 3.2 + ph) * size * 0.06;
    var s = size * (1 + 0.035 * Math.sin(t * 4.3 + ph));
    var B = bucket(s);
    blit(ctx, treatSprite(TREAT_COLORS[kind] ? kind : 'strawberry', B), x, by, s / B);
    // occasional glint
    var gl = Math.sin(t * 1.9 + ph * 7);
    if (gl > 0.55) {
      var gk = (gl - 0.55) / 0.45, gs = size * 0.5 * gk, Bg = bucket(gs);
      ctx.translate(x + size * 0.27, by - size * 0.27);
      ctx.rotate(t * 1.5);
      blit(ctx, sparkleSprite('#FFFFFF', Bg), 0, 0, gs / Bg);
    }
    ctx.restore();
  }

  function puddleShape(g, rx, ry) {
    // wobbly blob, fixed shape
    g.beginPath();
    var n = 10;
    for (var i = 0; i <= n; i++) {
      var a = i * TAU / n, k = 1 + 0.07 * Math.sin(a * 3 + 0.6) + 0.04 * Math.sin(a * 5 + 1.3);
      var px = Math.cos(a) * rx * k, py = Math.sin(a) * ry * k;
      if (i === 0) g.moveTo(px, py);
      else {
        var am = (i - 0.5) * TAU / n, km = 1 + 0.07 * Math.sin(am * 3 + 0.6) + 0.04 * Math.sin(am * 5 + 1.3);
        g.quadraticCurveTo(Math.cos(am) * rx * km / Math.cos(Math.PI / n), Math.sin(am) * ry * km / Math.cos(Math.PI / n), px, py);
      }
    }
    g.closePath();
  }
  function paintPuddle(g, Bw, Bh) {
    var rx = Bw / 2, ry = Bh / 2, lw = Math.max(2, Bw * 0.022);
    puddleShape(g, rx, ry);
    g.fillStyle = '#5BB8F0'; g.fill();
    g.lineWidth = lw * 2; g.strokeStyle = 'rgba(45,110,170,0.55)'; g.stroke();
    // lighter inner water
    g.save();
    puddleShape(g, rx, ry); g.clip();
    g.fillStyle = '#86D3FF';
    g.beginPath(); ell(g, -rx * 0.1, -ry * 0.12, rx * 0.8, ry * 0.68); g.fill();
    g.restore();
    // shines
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = lw * 1.4; g.lineCap = 'round';
    g.beginPath(); g.ellipse(0, 0, rx * 0.62, ry * 0.5, 0, Math.PI * 1.1, Math.PI * 1.4); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath(); ell(g, rx * 0.35, ry * 0.25, rx * 0.08, ry * 0.07); circ(g, rx * 0.5, ry * 0.05, ry * 0.05); g.fill();
  }

  function drawPuddle(ctx, x, y, w, h, t, rippleAge) {
    if (!(w > 0) || !(h > 0)) return;
    t = num(t, 0); rippleAge = num(rippleAge, -1);
    var Bw = bucket(w), Bh = Math.max(4, Math.round(Bw * h / w));
    var pad = Math.ceil(Bw * 0.08), W = Bw + 2 * pad, H = Bh + 2 * pad;
    var spr = getSprite('pd:' + Bw + 'x' + Bh, W, H, W / 2, H / 2, paintPuddle, Bw, Bh);
    var A0 = ctx.globalAlpha, k = w / Bw;
    ctx.save();
    ctx.translate(x, y);
    var sq = 1;
    if (rippleAge >= 0 && rippleAge < 0.6) sq = 1 + 0.12 * Math.sin(rippleAge * 25) * (1 - rippleAge / 0.6);
    ctx.scale(sq, 2 - sq);
    blit(ctx, spr, 0, 0, k);
    ctx.lineCap = 'round';
    if (rippleAge >= 0) {
      // expanding rings right after the splash
      ctx.strokeStyle = '#FFFFFF';
      for (var i = 0; i < 3; i++) {
        var a = rippleAge * 1.1 - i * 0.22;
        if (a <= 0 || a >= 1) continue;
        ctx.globalAlpha = A0 * (1 - a) * 0.9;
        ctx.lineWidth = Math.max(1.5, w * 0.025 * (1 - a));
        ctx.beginPath(); ctx.ellipse(0, 0, w * 0.1 + w * 0.42 * a, h * 0.1 + h * 0.42 * a, 0, 0, TAU); ctx.stroke();
      }
      // the rippled look stays: gentle concentric rings
      var fade = clamp01((rippleAge - 0.3) / 0.6);
      if (fade > 0) {
        ctx.globalAlpha = A0 * 0.55 * fade;
        ctx.lineWidth = Math.max(1.5, w * 0.014);
        var wob = 0.04 * Math.sin(t * 3);
        ctx.beginPath();
        ctx.ellipse(0, 0, w * (0.16 + wob * 0.5), h * (0.15 + wob * 0.5), 0, 0, TAU);
        ctx.moveTo(w * (0.3 - wob), 0);
        ctx.ellipse(0, 0, w * (0.3 - wob), h * (0.28 - wob), 0, 0, TAU);
        ctx.stroke();
      }
    } else {
      // calm water: one slow drifting sparkle
      var sp = Math.sin(t * 1.3 + x * 0.01);
      if (sp > 0.3) {
        var gs = h * 0.35 * (sp - 0.3) / 0.7, Bg = bucket(gs);
        blit(ctx, sparkleSprite('#FFFFFF', Bg), -w * 0.18, -h * 0.12, gs / Bg);
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------
  // Car (unit space: width 1)
  // ---------------------------------------------------------------------------------------------

  var EMPTY = {};
  var coneCache = { H: -1, g: null };
  var CAR_RED = '#FF4D4D', CAR_GLASS = '#BDE7FF', CAR_WHEEL = '#222222';

  function wheel(g, x, y, ang) {
    g.save();
    g.translate(x, y);
    if (ang) g.rotate(ang);
    g.beginPath(); rr(g, -0.11, -0.17, 0.22, 0.34, 0.09);
    g.fillStyle = CAR_WHEEL; g.fill();
    g.lineWidth = 0.04; g.strokeStyle = OL; g.stroke();
    // chunky tread blocks so the steering angle reads clearly
    g.strokeStyle = '#5A5662'; g.lineWidth = 0.035;
    g.beginPath();
    g.moveTo(-0.055, -0.1); g.lineTo(0.055, -0.1);
    g.moveTo(-0.055, -0.033); g.lineTo(0.055, -0.033);
    g.moveTo(-0.055, 0.033); g.lineTo(0.055, 0.033);
    g.moveTo(-0.055, 0.1); g.lineTo(0.055, 0.1);
    g.stroke();
    g.restore();
  }

  function drawCar(ctx, x, y, w, h, bodyAngle, wheelAngle, t, opts) {
    if (!(w > 0) || !(h > 0)) return;
    opts = opts || EMPTY;
    t = num(t, 0);
    var wa = num(wheelAngle, 0), H = h / w, hh = H / 2;
    var sq = clamp01(num(opts.squash, 0));
    var sleeping = !!opts.sleeping;
    ctx.save();
    ctx.translate(x, y);
    ctx.save();
    ctx.rotate(num(bodyAngle, 0));
    ctx.scale(w * (1 - 0.12 * sq), w * (1 + 0.06 * sq));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // headlight cone (under everything)
    if (opts.headlights) {
      var L = 3.6;
      if (coneCache.H !== H) {
        var gr = ctx.createLinearGradient(0, -hh, 0, -hh - L);
        gr.addColorStop(0, 'rgba(255,243,176,0.35)');
        gr.addColorStop(0.55, 'rgba(255,243,176,0.16)');
        gr.addColorStop(1, 'rgba(255,243,176,0)');
        coneCache.H = H; coneCache.g = gr;
      }
      ctx.fillStyle = coneCache.g;
      ctx.beginPath();
      ctx.moveTo(-0.32, -hh + 0.1); ctx.lineTo(0.32, -hh + 0.1);
      ctx.lineTo(1.15, -hh - L); ctx.quadraticCurveTo(0, -hh - L - 0.4, -1.15, -hh - L);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-0.24, -hh + 0.1); ctx.lineTo(0.24, -hh + 0.1);
      ctx.lineTo(0.7, -hh - L * 0.8); ctx.lineTo(-0.7, -hh - L * 0.8);
      ctx.closePath();
      ctx.fill();
    }

    // shadow
    ctx.fillStyle = 'rgba(30,20,50,0.22)';
    ctx.beginPath(); rr(ctx, -0.36, -hh + 0.1, 0.84, H, 0.4); ctx.fill();

    // wheels
    wheel(ctx, -0.45, -hh * 0.55, wa);
    wheel(ctx, 0.45, -hh * 0.55, wa);
    wheel(ctx, -0.45, hh * 0.58, 0);
    wheel(ctx, 0.45, hh * 0.58, 0);

    // side mirrors ("ears")
    ctx.beginPath();
    ell(ctx, -0.44, -hh * 0.12, 0.08, 0.055, 0.3);
    ell(ctx, 0.44, -hh * 0.12, 0.08, 0.055, -0.3);
    ctx.fillStyle = CAR_RED; ctx.fill();
    ctx.lineWidth = 0.04; ctx.strokeStyle = OL; ctx.stroke();

    // body
    ctx.beginPath(); rr(ctx, -0.4, -hh, 0.8, H, 0.4);
    ctx.fillStyle = CAR_RED; ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#E8363E';
    ctx.fillRect(0.25, -hh, 0.2, H);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(-0.4, -hh, 0.11, H);
    ctx.restore();
    ctx.beginPath(); rr(ctx, -0.4, -hh, 0.8, H, 0.4);
    ctx.lineWidth = 0.05; ctx.strokeStyle = OL; ctx.stroke();

    // headlamps
    ctx.beginPath();
    circ(ctx, -0.23, -hh + 0.1, 0.07);
    circ(ctx, 0.23, -hh + 0.1, 0.07);
    ctx.fillStyle = opts.headlights ? '#FFFDE0' : '#FFF3C4'; ctx.fill();
    ctx.lineWidth = 0.03; ctx.strokeStyle = OL; ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); circ(ctx, -0.25, -hh + 0.08, 0.023); circ(ctx, 0.21, -hh + 0.08, 0.023); ctx.fill();
    // taillights
    ctx.beginPath();
    rr(ctx, -0.3, hh - 0.11, 0.13, 0.065, 0.03);
    rr(ctx, 0.17, hh - 0.11, 0.13, 0.065, 0.03);
    ctx.fillStyle = '#B5123A'; ctx.fill();
    ctx.lineWidth = 0.025; ctx.strokeStyle = OL; ctx.stroke();

    // hood shine
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 0.05;
    ctx.beginPath(); ctx.moveTo(-0.28, -hh + 0.3); ctx.quadraticCurveTo(-0.3, -hh + 0.2, -0.19, -hh + 0.16); ctx.stroke();

    // windshield
    var wt = -hh * 0.56, wb = -hh * 0.1;
    ctx.beginPath();
    ctx.moveTo(-0.27, wt); ctx.lineTo(0.27, wt); ctx.lineTo(0.33, wb); ctx.lineTo(-0.33, wb); ctx.closePath();
    ctx.lineWidth = 0.1; ctx.strokeStyle = OL; ctx.stroke();
    ctx.lineWidth = 0.05; ctx.strokeStyle = CAR_GLASS; ctx.stroke();
    ctx.fillStyle = CAR_GLASS; ctx.fill();

    // eyes on the windshield
    var ey = (wt + wb) / 2 + 0.01, ex = 0.15;
    var blink = !sleeping && mod(t, 4.7) < 0.13;
    if (sleeping || blink) {
      ctx.strokeStyle = '#2B2140';
      ctx.lineWidth = 0.035;
      ctx.beginPath();
      if (sleeping) {
        ctx.arc(-ex, ey - 0.03, 0.075, 0.12 * Math.PI, 0.88 * Math.PI);
        ctx.moveTo(ex + 0.075 * Math.cos(0.12 * Math.PI), ey - 0.03 + 0.075 * Math.sin(0.12 * Math.PI));
        ctx.arc(ex, ey - 0.03, 0.075, 0.12 * Math.PI, 0.88 * Math.PI);
        // lashes
        for (var s = -1; s <= 1; s += 2) {
          var cx = s * ex;
          ctx.moveTo(cx - 0.05, ey + 0.035); ctx.lineTo(cx - 0.07, ey + 0.07);
          ctx.moveTo(cx, ey + 0.045); ctx.lineTo(cx, ey + 0.085);
          ctx.moveTo(cx + 0.05, ey + 0.035); ctx.lineTo(cx + 0.07, ey + 0.07);
        }
      } else {
        ctx.moveTo(-ex - 0.08, ey); ctx.quadraticCurveTo(-ex, ey + 0.04, -ex + 0.08, ey);
        ctx.moveTo(ex - 0.08, ey); ctx.quadraticCurveTo(ex, ey + 0.04, ex + 0.08, ey);
      }
      ctx.stroke();
    } else {
      ctx.beginPath();
      ell(ctx, -ex, ey, 0.1, 0.125);
      ell(ctx, ex, ey, 0.1, 0.125);
      ctx.fillStyle = '#FFFFFF'; ctx.fill();
      ctx.lineWidth = 0.028; ctx.strokeStyle = OL; ctx.stroke();
      var look = Math.max(-0.6, Math.min(0.6, wa)) * 0.07;
      ctx.fillStyle = '#2B2140';
      ctx.beginPath();
      circ(ctx, -ex + look, ey - 0.03, 0.062);
      circ(ctx, ex + look, ey - 0.03, 0.062);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      circ(ctx, -ex + look - 0.022, ey - 0.055, 0.022);
      circ(ctx, ex + look - 0.022, ey - 0.055, 0.022);
      ctx.fill();
    }

    // roof
    var rt = wb, rb = hh * 0.5;
    ctx.beginPath(); rr(ctx, -0.31, rt, 0.62, rb - rt, 0.16);
    ctx.fillStyle = '#FF6A6A'; ctx.fill();
    ctx.lineWidth = 0.04; ctx.strokeStyle = OL; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); rr(ctx, -0.26, rt + 0.07, 0.1, (rb - rt) * 0.55, 0.05); ctx.fill();

    // rear window
    var bt = rb + 0.02, bb = hh * 0.74;
    ctx.beginPath();
    ctx.moveTo(-0.28, bt); ctx.lineTo(0.28, bt); ctx.lineTo(0.23, bb); ctx.lineTo(-0.23, bb); ctx.closePath();
    ctx.lineWidth = 0.08; ctx.strokeStyle = OL; ctx.stroke();
    ctx.lineWidth = 0.03; ctx.strokeStyle = '#9FD4F2'; ctx.stroke();
    ctx.fillStyle = '#9FD4F2'; ctx.fill();
    ctx.restore();

    // floating Z's while asleep (screen aligned)
    if (sleeping) {
      ctx.lineJoin = 'round';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var A0 = ctx.globalAlpha;
      for (var i = 0; i < 3; i++) {
        var p = mod(t * 0.45 + i / 3, 1);
        var zs = w * (0.28 + 0.3 * p);
        ctx.globalAlpha = A0 * Math.sin(Math.PI * p);
        ctx.font = '800 ' + Math.round(zs) + 'px ' + FONT;
        var zx = w * 0.35 + p * w * 0.55 + Math.sin(p * 7) * w * 0.08, zy = -h * 0.4 - p * h * 0.75;
        ctx.lineWidth = zs * 0.2; ctx.strokeStyle = OL; ctx.strokeText('Z', zx, zy);
        ctx.fillStyle = '#FFFFFF'; ctx.fillText('Z', zx, zy);
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------
  // Gate
  // ---------------------------------------------------------------------------------------------

  var BUNTING = ['#FFFFFF', '#FFE45C', '#4FC3F7', '#7ED957', '#FF6FB5', '#FF8A65'];

  function drawGate(ctx, roadCx, y, R, toBiome, t) {
    if (!(R > 0)) return;
    var B = BIOMES[toBiome] || BIOMES.meadow;
    var acc = B.accent, accD = shade(acc, -0.25), accL = shade(acc, 0.45);
    t = num(t, 0);
    var A0 = ctx.globalAlpha;
    ctx.save();
    ctx.translate(roadCx, y);
    ctx.save();
    ctx.scale(R, R);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    var lw = 0.011, px = 0.6, x0 = -px, x2 = px, y0 = -0.07, cyc = -0.27;
    var i, u, iu, bx, by;
    // shadow on the road
    ctx.fillStyle = 'rgba(40,25,70,0.16)';
    ctx.beginPath();
    ctx.moveTo(x0 + 0.03, y0 + 0.17); ctx.quadraticCurveTo(0.03, cyc + 0.17, x2 + 0.03, y0 + 0.17);
    ctx.lineTo(x2 + 0.03, y0 + 0.24); ctx.quadraticCurveTo(0.03, cyc + 0.24, x0 + 0.03, y0 + 0.24);
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ell(ctx, -px + 0.02, 0.12, 0.08, 0.03); ell(ctx, px + 0.02, 0.12, 0.08, 0.03); ctx.fill();
    // pillars (candy-cane striped)
    for (var sd = -1; sd <= 1; sd += 2) {
      var pxs = sd * px;
      ctx.beginPath(); rr(ctx, pxs - 0.04, -0.09, 0.08, 0.21, 0.025);
      ctx.fillStyle = '#FFFFFF'; ctx.fill();
      ctx.save(); ctx.clip();
      ctx.fillStyle = acc;
      ctx.beginPath();
      for (var k = -3; k < 6; k++) {
        var sy = -0.09 + k * 0.05;
        ctx.moveTo(pxs - 0.05, sy); ctx.lineTo(pxs + 0.05, sy - 0.04); ctx.lineTo(pxs + 0.05, sy - 0.02); ctx.lineTo(pxs - 0.05, sy + 0.02);
        ctx.closePath();
      }
      ctx.fill();
      ctx.restore();
      ctx.beginPath(); rr(ctx, pxs - 0.04, -0.09, 0.08, 0.21, 0.025);
      ctx.lineWidth = lw * 1.4; ctx.strokeStyle = OL; ctx.stroke();
    }
    // banner band
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(0, cyc, x2, y0);
    ctx.strokeStyle = OL; ctx.lineWidth = 0.075 + 2 * lw; ctx.stroke();
    ctx.strokeStyle = acc; ctx.lineWidth = 0.075; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x0 + 0.02, y0 - 0.022); ctx.quadraticCurveTo(0, cyc - 0.022, x2 - 0.02, y0 - 0.022);
    ctx.strokeStyle = accL; ctx.lineWidth = 0.016; ctx.stroke();
    // pillar top balls
    ctx.beginPath(); circ(ctx, -px, y0 - 0.005, 0.05); circ(ctx, px, y0 - 0.005, 0.05);
    ctx.fillStyle = '#FFD93D'; ctx.fill(); ctx.lineWidth = lw * 1.4; ctx.strokeStyle = OL; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); circ(ctx, -px - 0.015, y0 - 0.02, 0.014); circ(ctx, px - 0.015, y0 - 0.02, 0.014); ctx.fill();
    // bunting pennants
    var N = 12;
    for (i = 0; i < N; i++) {
      u = 0.07 + i * (0.86 / (N - 1));
      if (u > 0.36 && u < 0.64) continue;
      iu = 1 - u;
      bx = iu * iu * x0 + u * u * x2;
      by = iu * iu * y0 + 2 * iu * u * cyc + u * u * y0 + 0.035;
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(Math.sin(t * 3.2 + i * 1.7) * 0.18);
      ctx.beginPath(); ctx.moveTo(-0.028, 0); ctx.lineTo(0.028, 0); ctx.lineTo(0, 0.075); ctx.closePath();
      ctx.fillStyle = BUNTING[i % BUNTING.length] === acc ? accD : BUNTING[i % BUNTING.length];
      ctx.fill();
      ctx.lineWidth = lw * 0.9; ctx.strokeStyle = OL; ctx.stroke();
      ctx.restore();
    }
    // twinkling bulbs on the band
    for (i = 0; i < 11; i++) {
      u = 0.06 + i * 0.088;
      if (u > 0.4 && u < 0.6) continue;
      iu = 1 - u;
      bx = iu * iu * x0 + u * u * x2;
      by = iu * iu * y0 + 2 * iu * u * cyc + u * u * y0;
      ctx.globalAlpha = A0 * (0.55 + 0.45 * Math.sin(t * 5 + i * 1.3));
      ctx.fillStyle = i % 2 ? '#FFFFFF' : '#FFF3B0';
      ctx.beginPath(); circ(ctx, bx, by, 0.016); ctx.fill();
    }
    ctx.globalAlpha = A0;
    // medallion with rotating sunburst
    var my = (y0 + cyc) / 2 - 0.02, mr = 0.105;
    ctx.save();
    ctx.translate(0, my);
    ctx.rotate(t * 0.6);
    ctx.fillStyle = rgba(accL, 0.85);
    ctx.beginPath();
    for (i = 0; i < 12; i++) {
      var a0 = i * TAU / 12;
      ctx.moveTo(Math.cos(a0 - 0.12) * mr * 0.9, Math.sin(a0 - 0.12) * mr * 0.9);
      ctx.lineTo(Math.cos(a0) * mr * 1.55, Math.sin(a0) * mr * 1.55);
      ctx.lineTo(Math.cos(a0 + 0.12) * mr * 0.9, Math.sin(a0 + 0.12) * mr * 0.9);
      ctx.closePath();
    }
    ctx.fill();
    ctx.restore();
    ctx.beginPath(); circ(ctx, 0, my, mr);
    ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.lineWidth = 0.03; ctx.strokeStyle = OL; ctx.stroke();
    ctx.lineWidth = 0.016; ctx.strokeStyle = acc;
    ctx.beginPath(); circ(ctx, 0, my, mr - 0.016); ctx.stroke();
    ctx.restore(); // unit scale
    // treat icon in pixel space so it stays crisp
    var ts = 0.16 * R;
    var B2 = bucket(ts);
    blit(ctx, treatSprite(B.treat, B2), 0, my * R + Math.sin(t * 3) * R * 0.006, ts / B2);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------
  // Particles
  // ---------------------------------------------------------------------------------------------

  function drawParticle(ctx, p) {
    if (!p) return;
    var life = clamp01(num(p.life, 1));
    if (life <= 0) return;
    var sz = num(p.size, 10);
    if (!(sz > 0)) return;
    var x = num(p.x, 0), y = num(p.y, 0), rot = num(p.rot, 0);
    var color = p.color || '#FFFFFF';
    var A0 = ctx.globalAlpha;
    ctx.save();
    switch (p.kind) {
      case 'sparkle': {
        var k = Math.sin(Math.PI * life);
        var s = sz * (0.6 + 1.0 * k) * 1.7, B = bucket(s);
        ctx.globalAlpha = A0 * Math.min(1, life * 2.5);
        ctx.translate(x, y);
        ctx.rotate(rot);
        blit(ctx, sparkleSprite(color, B), 0, 0, s / B);
        break;
      }
      case 'confetti': {
        ctx.globalAlpha = A0 * Math.min(1, life * 3);
        ctx.translate(x, y);
        ctx.rotate(rot);
        var fx = 0.2 + 0.8 * Math.abs(Math.cos(rot * 2.3));
        ctx.fillStyle = color;
        ctx.fillRect(-sz * 0.5 * fx, -sz * 0.32, sz * fx, sz * 0.64);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillRect(-sz * 0.5 * fx, -sz * 0.32, sz * fx * 0.35, sz * 0.64);
        break;
      }
      case 'droplet': {
        ctx.globalAlpha = A0 * Math.min(1, life * 2);
        var r = sz * 0.5;
        ctx.beginPath(); circ(ctx, x, y, r);
        ctx.fillStyle = p.color || '#6EC6FF'; ctx.fill();
        ctx.lineWidth = Math.max(1, r * 0.25); ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath(); circ(ctx, x - r * 0.3, y - r * 0.3, r * 0.28); ctx.fill();
        break;
      }
      case 'dust': {
        var gr = sz * 0.5 * (1.5 - 0.7 * life);
        ctx.globalAlpha = A0 * 0.6 * Math.min(1, life * 1.5);
        ctx.fillStyle = color;
        ctx.beginPath();
        circ(ctx, x, y, gr);
        circ(ctx, x - gr * 0.6, y + gr * 0.3, gr * 0.7);
        circ(ctx, x + gr * 0.6, y + gr * 0.25, gr * 0.65);
        ctx.fill();
        ctx.globalAlpha = A0 * 0.3 * life;
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath(); circ(ctx, x - gr * 0.25, y - gr * 0.3, gr * 0.35); ctx.fill();
        break;
      }
      default: {
        ctx.globalAlpha = A0 * life;
        ctx.fillStyle = color;
        ctx.beginPath(); circ(ctx, x, y, sz * 0.5); ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------
  // HUD: tray, trophies, rainbow, traffic light, sound-off
  // ---------------------------------------------------------------------------------------------

  function trayGeom(w, h) {
    var slot = 0.08 * h, pitch = 0.095 * h, cy = 0.07 * h;
    var pw = 9 * pitch + slot + 0.035 * h, ph = slot + 0.028 * h;
    return { slot: slot, pitch: pitch, cy: cy, pw: pw, ph: ph };
  }
  function paintTrayBg(g, w, h) {
    var G = trayGeom(w, h), cx = 0, cy = 0;
    var x0 = cx - G.pw / 2, y0 = cy - G.ph / 2;
    g.fillStyle = 'rgba(40,25,70,0.18)';
    g.beginPath(); rr(g, x0, y0 + 0.006 * h, G.pw, G.ph, G.ph / 2); g.fill();
    g.beginPath(); rr(g, x0, y0, G.pw, G.ph, G.ph / 2);
    g.fillStyle = 'rgba(255,252,246,0.92)'; g.fill();
    g.lineWidth = Math.max(2, 0.005 * h); g.strokeStyle = 'rgba(74,53,80,0.35)'; g.stroke();
    g.setLineDash([0.011 * h, 0.008 * h]);
    for (var i = 0; i < 10; i++) {
      var sx = cx + (i - 4.5) * G.pitch;
      g.beginPath(); circ(g, sx, cy, G.slot * 0.42);
      g.fillStyle = 'rgba(74,53,80,0.07)'; g.fill();
      g.lineWidth = Math.max(1.5, 0.0035 * h); g.strokeStyle = 'rgba(74,53,80,0.32)'; g.stroke();
    }
    g.setLineDash([]);
  }
  function paintTrayWrap(g, a, b) { paintTrayBg(g, a, b); }

  function drawTray(ctx, w, h, kinds, pulseSlot, pulseT, t) {
    var G = trayGeom(w, h), cx = w / 2;
    var bw = Math.ceil(G.pw + 0.02 * h), bh = Math.ceil(G.ph + 0.03 * h);
    var bg = getSprite('tray:' + w + 'x' + h, bw, bh, G.pw / 2 + 0.01 * h, G.ph / 2 + 0.01 * h, paintTrayWrap, w, h);
    var A0 = ctx.globalAlpha;
    ctx.save();
    blit(ctx, bg, cx, G.cy, 1);
    var n = kinds ? Math.min(10, kinds.length) : 0;
    var ps = num(pulseSlot, -1), pt = clamp01(num(pulseT, 0));
    for (var i = 0; i < n; i++) {
      var sx = cx + (i - 4.5) * G.pitch, sc = 1;
      if (i === ps) {
        sc = 1 + 0.45 * Math.sin(Math.PI * pt);
        ctx.globalAlpha = A0 * (1 - pt);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = G.slot * 0.08;
        ctx.beginPath(); circ(ctx, sx, G.cy, G.slot * (0.45 + 0.4 * pt)); ctx.stroke();
        ctx.globalAlpha = A0;
      }
      drawTreatStatic(ctx, kinds[i], sx, G.cy, G.slot * 0.95 * sc);
    }
    ctx.restore();
  }

  function paintTrophy(g, B) {
    g.scale(B, B);
    var ow = 6 / B;
    var gr = g.createRadialGradient(0, 0, 0.05, 0, 0, 0.7);
    gr.addColorStop(0, 'rgba(255,236,150,0.8)');
    gr.addColorStop(1, 'rgba(255,214,90,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 0.7, 0, TAU); g.fill();
    // ribbons
    function ribbon(sx, col) {
      g.beginPath();
      g.moveTo(sx * 0.04, 0.08); g.lineTo(sx * 0.2, 0.5); g.lineTo(sx * 0.12, 0.44); g.lineTo(sx * 0.05, 0.53); g.lineTo(sx * -0.08, 0.12); g.closePath();
    }
    ribbon(-1); g.strokeStyle = '#FFFFFF'; g.lineWidth = 0.06 + ow; g.stroke();
    ribbon(1); g.stroke();
    ribbon(-1); g.fillStyle = '#FF5A5F'; g.fill(); g.lineWidth = 0.04; g.strokeStyle = OL; g.stroke();
    ribbon(1); g.fillStyle = '#4D96FF'; g.fill(); g.stroke();
    var fat = 0.12;
    starPath(g, 5, 0.38, 0.19, 0, 0, -0.02);
    g.strokeStyle = '#FFFFFF'; g.lineWidth = fat + 0.07 + ow; g.stroke();
    g.strokeStyle = '#B07800'; g.lineWidth = fat + 0.07; g.stroke();
    g.strokeStyle = '#FFC83D'; g.lineWidth = fat; g.stroke();
    g.fillStyle = '#FFC83D'; g.fill();
    starPath(g, 5, 0.25, 0.125, 0, 0, -0.02);
    g.strokeStyle = '#FFE27A'; g.lineWidth = 0.07; g.stroke();
    g.fillStyle = '#FFE27A'; g.fill();
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath(); ell(g, -0.15, -0.16, 0.065, 0.035, -0.6); g.fill();
    g.beginPath(); circ(g, 0.02, -0.25, 0.022); g.fill();
  }

  // Trophy grid geometry, shared with game.js (Art.trophyPos) so flying icons land on the right spot.
  function trophyLayout(w, h, count) {
    var G = trayGeom(w, h);
    var right = w - 0.05 * h;
    var trayRight = w / 2 + G.pw / 2 + 0.025 * h;
    var s = 1, size, pitch, perRow, rows;
    for (var it = 0; it < 30; it++) {
      size = 0.07 * h * s; pitch = size;
      var avail = right + size / 2 - trayRight;
      perRow = Math.max(1, Math.floor((avail - size) / pitch) + 1);
      rows = Math.ceil(count / perRow);
      if (count <= 12 || rows * pitch <= 0.26 * h || s < 0.3) break;
      s *= 0.92;
    }
    return { right: right, size: size, pitch: pitch, perRow: perRow };
  }

  function trophyPos(w, h, i, count) {
    var L = trophyLayout(w, h, Math.max(1, count));
    return { x: L.right - (i % L.perRow) * L.pitch, y: 0.07 * h + Math.floor(i / L.perRow) * L.pitch };
  }

  function drawTrophies(ctx, w, h, count, t) {
    count = Math.max(0, Math.floor(num(count, 0)));
    if (!count) return;
    t = num(t, 0);
    var L = trophyLayout(w, h, count);
    var right = L.right, size = L.size, pitch = L.pitch, perRow = L.perRow;
    var B = bucket(size);
    var spr = getSprite('trophy:' + B, Math.ceil(B * 1.5), Math.ceil(B * 1.5), B * 0.75, B * 0.75, paintTrophy, B);
    ctx.save();
    for (var i = 0; i < count; i++) {
      var r = Math.floor(i / perRow), c = i % perRow;
      var x = right - c * pitch, y = 0.07 * h + r * pitch;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(t * 1.6 + i * 0.9) * 0.08);
      blit(ctx, spr, 0, 0, size * 1.05 / B);
      ctx.restore();
    }
    // newest one twinkles
    var li = count - 1, lr = Math.floor(li / perRow), lc = li % perRow;
    var gk = Math.sin(t * 2.5);
    if (gk > 0.2) {
      var gs = size * 0.55 * (gk - 0.2) / 0.8, Bg = bucket(gs);
      ctx.translate(right - lc * pitch + size * 0.3, 0.07 * h + lr * pitch - size * 0.3);
      ctx.rotate(t);
      blit(ctx, sparkleSprite('#FFFFFF', Bg), 0, 0, gs / Bg);
    }
    ctx.restore();
  }

  function paintCloud(g, B) {
    g.scale(B, B);
    var C = [-0.25, 0.05, 0.2, 0, -0.08, 0.27, 0.25, 0.04, 0.2, 0.1, 0.12, 0.17, -0.1, 0.12, 0.17];
    g.beginPath();
    for (var i = 0; i < C.length; i += 3) circ(g, C[i], C[i + 1], C[i + 2]);
    g.lineWidth = 0.06; g.strokeStyle = '#B9D6EE'; g.stroke();
    g.fillStyle = '#FFFFFF'; g.fill();
    g.fillStyle = 'rgba(185,214,238,0.35)';
    g.beginPath(); ell(g, 0.03, 0.2, 0.36, 0.07); g.fill();
  }
  function cloudSprite(B) { return getSprite('cloud:' + B, B, Math.ceil(B * 0.7), B / 2, B * 0.35, paintCloud, B); }

  var RAINBOW = ['#FF5A5F', '#FF9F1C', '#FFE45C', '#7ED957', '#4FC3F7', '#4D96FF', '#B388FF'];

  function drawRainbow(ctx, w, h, progress, t) {
    var p = clamp01(num(progress, 0));
    if (p <= 0 || p >= 1) return;
    t = num(t, 0);
    var grow = Math.min(1, p / 0.2);
    grow = 1 - Math.pow(1 - grow, 3);
    var fade = p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25;
    var A0 = ctx.globalAlpha;
    var cx = w / 2, cy = 0.84 * h, Ro = Math.min(0.46 * w, 0.7 * h), bt = Ro * 0.065;
    ctx.save();
    ctx.globalAlpha = A0 * fade * 0.92;
    var a0 = Math.PI, a1 = Math.PI + Math.PI * grow;
    // white outline behind the bands
    ctx.lineCap = 'butt';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = bt * 7 + bt * 0.6;
    ctx.beginPath(); ctx.arc(cx, cy, Ro - bt * 3, a0, a1); ctx.stroke();
    for (var i = 0; i < 7; i++) {
      ctx.strokeStyle = RAINBOW[i];
      ctx.lineWidth = bt + 1;
      ctx.beginPath(); ctx.arc(cx, cy, Ro - i * bt, a0, a1); ctx.stroke();
    }
    // sparkles riding along the arc
    for (i = 0; i < 6; i++) {
      var u = (i + 0.5) / 6;
      if (u > grow) continue;
      var aa = Math.PI + Math.PI * u, rr0 = Ro - bt * (1 + (i % 5));
      var tw = 0.5 + 0.5 * Math.sin(t * 6 + i * 2.1);
      var gs = bt * 2.2 * (0.5 + tw), Bg = bucket(gs);
      blit(ctx, sparkleSprite('#FFFFFF', Bg), cx + Math.cos(aa) * rr0, cy + Math.sin(aa) * rr0, gs / Bg);
    }
    // clouds at the ends
    ctx.globalAlpha = A0 * fade;
    var cw = bt * 7.5, Bc = bucket(cw), cl = cloudSprite(Bc);
    var midR = Ro - bt * 3;
    var s1 = Math.min(1, grow * 4);
    blit(ctx, cl, cx - midR, cy + Math.sin(t * 2) * bt * 0.3, cw * s1 / Bc);
    if (grow > 0.85) {
      var s2 = Math.min(1, (grow - 0.85) / 0.15);
      s2 = 1 - Math.pow(1 - s2, 2);
      blit(ctx, cl, cx + midR, cy + Math.sin(t * 2 + 1) * bt * 0.3, cw * s2 / Bc);
    }
    ctx.restore();
  }

  var LIGHT_COLORS = ['#FF4D4D', '#FFD93D', '#3DDC84'];
  function paintLightGlow(g, col, B) {
    var gr = g.createRadialGradient(0, 0, 0, 0, 0, B / 2);
    gr.addColorStop(0, rgba(col, 0.75));
    gr.addColorStop(0.4, rgba(col, 0.3));
    gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, B / 2, 0, TAU); g.fill();
  }

  function drawTrafficLight(ctx, x, y, height, step) {
    var H = num(height, 100);
    if (!(H > 0)) return;
    step = Math.floor(num(step, -1));
    var W = 0.42 * H, top = -0.5 * H;
    ctx.save();
    ctx.translate(x, y);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // hanger
    ctx.strokeStyle = OL; ctx.lineWidth = 0.04 * H;
    ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(0, top - 0.08 * H); ctx.stroke();
    // shadow
    ctx.fillStyle = 'rgba(30,20,50,0.25)';
    ctx.beginPath(); rr(ctx, -W / 2 + 0.03 * H, top + 0.04 * H, W, H, 0.13 * H); ctx.fill();
    // housing
    ctx.beginPath(); rr(ctx, -W / 2, top, W, H, 0.13 * H);
    ctx.fillStyle = '#3A4157'; ctx.fill();
    ctx.lineWidth = 0.028 * H; ctx.strokeStyle = OL; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); rr(ctx, -W / 2 + 0.035 * H, top + 0.035 * H, 0.06 * H, H - 0.07 * H, 0.03 * H); ctx.fill();
    var r = 0.115 * H;
    for (var i = 0; i < 3; i++) {
      var cy = (-0.31 + i * 0.31) * H, col = LIGHT_COLORS[i], on = i === step;
      // socket
      ctx.beginPath(); circ(ctx, 0, cy, r + 0.025 * H);
      ctx.fillStyle = '#23283A'; ctx.fill();
      if (on) {
        var B = bucket(H * 0.75);
        blit(ctx, getSprite('lg:' + col + ':' + B, B, B, B / 2, B / 2, paintLightGlow, col, B), 0, cy, H * 0.75 / B);
      }
      ctx.beginPath(); circ(ctx, 0, cy, r);
      ctx.fillStyle = on ? col : mixHex(col, '#2A3045', 0.68); ctx.fill();
      ctx.lineWidth = 0.018 * H; ctx.strokeStyle = OL; ctx.stroke();
      ctx.fillStyle = on ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.12)';
      ctx.beginPath(); ell(ctx, -r * 0.35, -r * 0.4, r * 0.3, r * 0.18, -0.6); ctx.fill();
      if (on) {
        // happy face on the lit lamp
        var fd = shade(col, -0.55);
        ctx.fillStyle = fd;
        ctx.beginPath(); circ(ctx, -r * 0.33, cy - r * 0.1, r * 0.11); circ(ctx, r * 0.33, cy - r * 0.1, r * 0.11); ctx.fill();
        ctx.strokeStyle = fd; ctx.lineWidth = r * 0.12;
        ctx.beginPath(); ctx.arc(0, cy + r * 0.08, r * 0.38, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
      }
      // visor
      ctx.beginPath(); ctx.arc(0, cy, r + 0.045 * H, Math.PI * 1.08, Math.PI * 1.92);
      ctx.strokeStyle = '#262B3D'; ctx.lineWidth = 0.035 * H; ctx.stroke();
    }
    ctx.restore();
  }

  function speakerIcon(g, cx, cy, s, color, mode) {
    g.save();
    g.translate(cx, cy);
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(-0.34 * s, -0.12 * s); g.lineTo(-0.16 * s, -0.12 * s); g.lineTo(0.06 * s, -0.32 * s);
    g.lineTo(0.06 * s, 0.32 * s); g.lineTo(-0.16 * s, 0.12 * s); g.lineTo(-0.34 * s, 0.12 * s); g.closePath();
    g.fillStyle = color; g.fill();
    g.strokeStyle = color; g.lineWidth = 0.08 * s; g.stroke();
    g.lineWidth = 0.08 * s;
    if (mode === 'off') {
      g.strokeStyle = '#FF4D6D'; g.lineWidth = 0.1 * s;
      g.beginPath(); g.moveTo(0.18 * s, -0.14 * s); g.lineTo(0.42 * s, 0.14 * s); g.moveTo(0.42 * s, -0.14 * s); g.lineTo(0.18 * s, 0.14 * s); g.stroke();
    } else {
      g.beginPath(); g.arc(0.08 * s, 0, 0.17 * s, -0.8, 0.8); g.stroke();
      g.beginPath(); g.arc(0.08 * s, 0, 0.32 * s, -0.8, 0.8); g.stroke();
    }
    g.restore();
  }

  function drawSoundOff(ctx, x, y, size) {
    var s = num(size, 48);
    if (!(s > 0)) return;
    ctx.save();
    ctx.beginPath(); rr(ctx, x, y, s, s, s * 0.28);
    ctx.fillStyle = 'rgba(255,252,246,0.88)'; ctx.fill();
    ctx.lineWidth = Math.max(2, s * 0.05); ctx.strokeStyle = 'rgba(74,53,80,0.45)'; ctx.stroke();
    speakerIcon(ctx, x + s * 0.47, y + s * 0.5, s * 0.82, OL, 'off');
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------
  // Text helpers and screens
  // ---------------------------------------------------------------------------------------------

  function font(px, weight, fam) { return (weight || 800) + ' ' + Math.max(1, Math.round(px)) + 'px ' + (fam || FONT); }
  function wrap(ctx, text, maxW) {
    var words = text.split(' '), lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var test = cur ? cur + ' ' + words[i] : words[i];
      if (cur && ctx.measureText(test).width > maxW) { lines.push(cur); cur = words[i]; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function fitSize(ctx, text, maxPx, maxW, weight, fam) {
    ctx.font = font(100, weight, fam);
    var w100 = ctx.measureText(text).width || 1;
    return Math.min(maxPx, 100 * maxW / w100);
  }
  function qrReady(img) {
    if (!img) return false;
    if (img.complete === false) return false;
    return (img.naturalWidth || img.width || 0) > 0;
  }
  function drawQR(ctx, img, x, y, s, t) {
    // white quiet zone card
    var q = s * 0.06;
    ctx.beginPath(); rr(ctx, x - q, y - q, s + 2 * q, s + 2 * q, q * 1.2);
    ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.lineWidth = Math.max(2, s * 0.008); ctx.strokeStyle = 'rgba(74,53,80,0.25)'; ctx.stroke();
    if (qrReady(img)) {
      var prev = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      try { ctx.drawImage(img, x, y, s, s); } catch (e) { /* broken image: leave the white card */ }
      ctx.imageSmoothingEnabled = prev;
      return;
    }
    // placeholder: faint finder squares + a little spinner
    ctx.fillStyle = '#F1EEF3';
    ctx.fillRect(x, y, s, s);
    var f = s * 0.22;
    ctx.lineWidth = f * 0.16; ctx.strokeStyle = 'rgba(74,53,80,0.25)'; ctx.fillStyle = 'rgba(74,53,80,0.25)';
    var corners = [x, y, x + s - f, y, x, y + s - f];
    for (var i = 0; i < 6; i += 2) {
      ctx.strokeRect(corners[i] + f * 0.08, corners[i + 1] + f * 0.08, f * 0.84, f * 0.84);
      ctx.fillRect(corners[i] + f * 0.3, corners[i + 1] + f * 0.3, f * 0.4, f * 0.4);
    }
    var cx = x + s / 2, cy = y + s / 2;
    for (i = 0; i < 8; i++) {
      var a = i * TAU / 8 + Math.floor(num(t, 0) * 8) * TAU / 8;
      ctx.globalAlpha *= 1;
      ctx.fillStyle = 'rgba(74,53,80,' + (0.15 + 0.6 * (i / 7)) + ')';
      ctx.beginPath(); circ(ctx, cx + Math.cos(a) * s * 0.1, cy + Math.sin(a) * s * 0.1, s * 0.022); ctx.fill();
    }
    ctx.fillStyle = 'rgba(74,53,80,0.7)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = font(s * 0.065, 700);
    ctx.fillText('QR code loading…', cx, cy + s * 0.2);
  }

  // Waiting screen layout (cached per size + url).
  var waitLayout = { key: '', L: null };
  var INSTR = [
    'Scan with the phone, open in Chrome',
    'Tap Start, then choose “Cami”',
    'Or press ← → to test with the keyboard'
  ];
  function layoutWaiting(ctx, w, h, url) {
    var key = w + 'x' + h + '|' + url;
    if (waitLayout.key === key) return waitLayout.L;
    var cx0 = 0.52 * w, cx1 = 0.97 * w, cw = cx1 - cx0;
    var pad = 0.035 * h, iw = cw - 2 * pad;
    var availTop = 0.035 * h, availH = 0.83 * h;
    var urlPx = fitSize(ctx, url, 0.046 * h, iw - 0.04 * h, 700, MONO);
    var lineFont = Math.max(0.026 * h, Math.min(0.034 * h, cw * 0.042));
    var bullet = lineFont * 1.5;
    ctx.font = font(lineFont, 700);
    var lines = [];
    for (var i = 0; i < INSTR.length; i++) {
      var ls = wrap(ctx, INSTR[i], iw - bullet);
      for (var j = 0; j < ls.length; j++) lines.push({ text: ls[j], first: j === 0, idx: i });
    }
    var lineH = lineFont * 1.32, paraGap = lineFont * 0.35;
    var urlBoxH = urlPx * 1.7;
    var q = Math.min(0.44 * h, iw);
    var fixed = pad * 2 + 0.025 * h * 2 + 0.03 * h + urlBoxH + lines.length * lineH + (INSTR.length - 1) * paraGap;
    if (fixed + q > availH) q = Math.max(0.22 * h, availH - fixed);
    var total = fixed + q;
    var cardY = availTop + Math.max(0, (availH - total) / 2);
    var L = {
      cx0: cx0, cw: cw, cardY: cardY, cardH: total, pad: pad, q: q, urlPx: urlPx, urlBoxH: urlBoxH,
      lineFont: lineFont, lineH: lineH, paraGap: paraGap, bullet: bullet, lines: lines
    };
    waitLayout.key = key; waitLayout.L = L;
    return L;
  }

  var TITLE_COLORS = ['#FF4D6D', '#FF9F1C', '#FFC93D', '#3DCC6E', '#4D96FF', '#B388FF'];

  function paintWaitingSky(g, w, h) {
    var sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#BFEAFF');
    sky.addColorStop(0.6, '#E6F7FF');
    sky.addColorStop(1, '#FFF4DE');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
  }
  function paintWaitingBg(g, w, h) {
    var u = Math.min(h, w * 0.55);
    var icx = 0.25 * w, icy = 0.55 * h, irx = Math.min(0.42 * u, 0.235 * w), iry = 0.31 * u;
    // island shadow + body
    g.fillStyle = 'rgba(60,90,120,0.18)';
    g.beginPath(); ell(g, icx + 0.012 * u, icy + 0.03 * u, irx, iry); g.fill();
    g.beginPath(); ell(g, icx, icy + 0.015 * u, irx, iry); g.fillStyle = '#9C6B44'; g.fill(); // earthy side
    g.beginPath(); ell(g, icx, icy, irx, iry);
    g.fillStyle = BIOMES.meadow.ground; g.fill();
    g.save(); g.clip();
    g.fillStyle = BIOMES.meadow.groundStripe;
    for (var y = icy - iry; y < icy + iry; y += 0.12 * u) g.fillRect(icx - irx, y, irx * 2, 0.06 * u);
    g.restore();
    g.beginPath(); ell(g, icx, icy, irx, iry);
    g.lineWidth = 0.008 * u; g.strokeStyle = '#4FA83A'; g.stroke();
    // ring road
    var trx = irx * 0.66, tryy = iry * 0.62, rw = 0.13 * u;
    g.beginPath(); ell(g, icx, icy, trx, tryy);
    g.lineWidth = rw + 0.02 * u; g.strokeStyle = 'rgba(40,25,70,0.15)'; g.stroke();
    g.lineWidth = rw; g.strokeStyle = '#FFFFFF'; g.stroke();
    g.lineWidth = rw - 0.022 * u; g.strokeStyle = BIOMES.meadow.road; g.stroke();
    g.setLineDash([0.035 * u, 0.03 * u]);
    g.lineWidth = 0.009 * u; g.strokeStyle = BIOMES.meadow.laneMark; g.stroke();
    g.setLineDash([]);
    // title
    var title = 'Cami Driving';
    var tx = 0.25 * w, ty = 0.115 * h, ts = Math.min(0.095 * h, fitSize(g, title, 1000, 0.4 * w, 900));
    g.font = font(ts, 900);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    var tw = g.measureText(title).width + ts * 0.04 * (title.length - 1);
    for (var pass = 0; pass < 3; pass++) {
      var x = tx - tw / 2;
      for (var i = 0; i < title.length; i++) {
        var ch = title[i], cw = g.measureText(ch).width;
        if (ch !== ' ') {
          var cy = ty + Math.sin(i * 1.3) * ts * 0.06;
          if (pass === 0) { g.lineWidth = ts * 0.28; g.strokeStyle = OL; g.strokeText(ch, x, cy); }
          else if (pass === 1) { g.lineWidth = ts * 0.14; g.strokeStyle = '#FFFFFF'; g.strokeText(ch, x, cy); }
          else { g.fillStyle = TITLE_COLORS[i % TITLE_COLORS.length]; g.fillText(ch, x, cy); }
        }
        x += cw + ts * 0.04;
      }
    }
  }

  // Props on the waiting island: [kind, dx, dy, size] in island units (u).
  var ISLAND_PROPS = [
    ['tree', -0.33, -0.2, 0.15], ['pine', 0.34, -0.22, 0.11], ['flowers', -0.06, -0.06, 0.08],
    ['cow', 0.08, 0.02, 0.12], ['bush', -0.14, 0.06, 0.09], ['flowers', 0.36, 0.17, 0.08],
    ['roundTree', -0.36, 0.13, 0.11], ['tree', 0.12, -0.1, 0.1]
  ];
  var trailP = { kind: 'sparkle', x: 0, y: 0, size: 0, rot: 0, life: 1, color: '#FFFFFF' };
  var TRAIL_COLORS = ['#FF6FB5', '#FFE45C', '#4FC3F7', '#FFFFFF'];

  function drawWaiting(ctx, w, h, t, qrImg, url, soundOn) {
    t = num(t, 0);
    url = url ? String(url) : 'https://spalladino.github.io/cami-games/driving/controller.html';
    var A0 = ctx.globalAlpha;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.drawImage(screenSprite('waitSky', w, h, paintWaitingSky).c, 0, 0, w, h);

    var u = Math.min(h, w * 0.55);
    var icx = 0.25 * w, icy = 0.55 * h, irx = Math.min(0.42 * u, 0.235 * w), iry = 0.31 * u;
    var i;
    // drifting clouds
    var Bc = bucket(0.16 * u), cl = cloudSprite(Bc);
    for (i = 0; i < 3; i++) {
      var span = w * 0.5 + 0.3 * u;
      var cxp = mod(i * span / 3 + t * (8 + i * 3), span) - 0.15 * u;
      blit(ctx, cl, cxp, [0.3, 0.2, 0.36][i] * h, (0.13 + 0.03 * i) * u / Bc);
    }
    ctx.drawImage(screenSprite('waiting', w, h, paintWaitingBg).c, 0, 0, w, h);
    // the car's lap: ellipse around the island center
    var trx = irx * 0.66, tryy = iry * 0.62;
    var th = t * 0.55;
    var carX = icx + trx * Math.cos(th), carY = icy + tryy * Math.sin(th);
    var vx = -trx * Math.sin(th), vy = tryy * Math.cos(th);
    var ang = Math.atan2(vx, -vy);
    // props behind the car (above it on screen) first, then car, then the rest
    var cw = 0.07 * u, ch = cw * 0.3 / 0.18;
    var drawn = 0;
    // a couple of strawberries waiting on the track
    drawTreat(ctx, 'strawberry', icx - 0.2 * u, icy - 0.05 * u, 0.06 * u, t, 1);
    drawTreat(ctx, 'strawberry', icx + 0.24 * u, icy + 0.04 * u, 0.06 * u, t + 0.7, 1);
    // sparkle trail
    for (i = 6; i >= 1; i--) {
      var pa = th - i * 0.085;
      trailP.x = icx + trx * Math.cos(pa) + Math.sin(i * 2.3 + t * 3) * cw * 0.12;
      trailP.y = icy + tryy * Math.sin(pa) + Math.cos(i * 1.7 + t * 3) * cw * 0.12;
      trailP.life = 1 - i / 7;
      trailP.size = cw * 0.32;
      trailP.rot = t * 2 + i;
      trailP.color = TRAIL_COLORS[(i + Math.floor(t * 4)) % 4];
      drawParticle(ctx, trailP);
    }
    for (i = 0; i < ISLAND_PROPS.length; i++) {
      var P = ISLAND_PROPS[i], py = icy + P[2] * u;
      if (py > carY && !drawn) { drawCar(ctx, carX, carY, cw, ch, ang, 0.32, t, EMPTY); drawn = 1; }
      drawProp(ctx, P[0], icx + P[1] * u, py, P[3] * u, t);
    }
    if (!drawn) drawCar(ctx, carX, carY, cw, ch, ang, 0.32, t, EMPTY);

    // ---- card for dad ----
    var L = layoutWaiting(ctx, w, h, url);
    var x0 = L.cx0, y0 = L.cardY, cwid = L.cw, r = 0.03 * h;
    ctx.fillStyle = 'rgba(40,25,70,0.16)';
    ctx.beginPath(); rr(ctx, x0 + 0.006 * h, y0 + 0.01 * h, cwid, L.cardH, r); ctx.fill();
    ctx.beginPath(); rr(ctx, x0, y0, cwid, L.cardH, r);
    ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.lineWidth = Math.max(2, 0.004 * h); ctx.strokeStyle = 'rgba(74,53,80,0.25)'; ctx.stroke();
    var midX = x0 + cwid / 2, y = y0 + L.pad;
    drawQR(ctx, qrImg, midX - L.q / 2, y, L.q, t);
    y += L.q + 0.025 * h + 0.03 * h;
    // URL pill
    ctx.font = font(L.urlPx, 700, MONO);
    var uw = ctx.measureText(url).width + 0.03 * h;
    ctx.beginPath(); rr(ctx, midX - uw / 2, y, uw, L.urlBoxH, L.urlBoxH * 0.3);
    ctx.fillStyle = '#E3F4FF'; ctx.fill();
    ctx.lineWidth = Math.max(1.5, 0.003 * h); ctx.strokeStyle = '#9CCBEA'; ctx.stroke();
    ctx.fillStyle = '#1D3F72';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(url, midX, y + L.urlBoxH / 2 + L.urlPx * 0.04);
    y += L.urlBoxH + 0.025 * h;
    // instructions
    ctx.textAlign = 'left';
    ctx.font = font(L.lineFont, 700);
    var tx = x0 + L.pad + L.bullet;
    for (i = 0; i < L.lines.length; i++) {
      var ln = L.lines[i];
      if (ln.first && i > 0) y += L.paraGap;
      var ly = y + L.lineH / 2;
      if (ln.first) {
        var bx = x0 + L.pad + L.bullet * 0.38, br = L.lineFont * 0.5;
        ctx.beginPath(); circ(ctx, bx, ly, br);
        ctx.fillStyle = TITLE_COLORS[(ln.idx * 2) % TITLE_COLORS.length]; ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.font = font(L.lineFont * 0.72, 900);
        ctx.fillText(ln.idx < 2 ? String(ln.idx + 1) : '★', bx, ly + L.lineFont * 0.03);
        ctx.textAlign = 'left';
        ctx.font = font(L.lineFont, 700);
      }
      ctx.fillStyle = ln.idx === 2 ? '#7A6A85' : '#3D2C4E';
      ctx.fillText(ln.text, tx, ly);
      y += L.lineH;
    }

    // ---- sound banner ----
    var bh = 0.075 * h, bfs = 0.036 * h;
    var label = soundOn ? 'Sound on' : 'Click anywhere to turn on sound';
    ctx.font = font(bfs, 800);
    var lw = ctx.measureText(label).width;
    var bwid = lw + bh * (soundOn ? 2.45 : 1.9), bcx = w / 2, bcy = 0.93 * h;
    var pulse = soundOn ? 0 : 0.5 + 0.5 * Math.sin(t * 4.5);
    ctx.save();
    ctx.translate(bcx, bcy);
    var sc = 1 + 0.04 * pulse;
    ctx.scale(sc, sc);
    if (!soundOn) {
      ctx.globalAlpha = A0 * (0.25 + 0.35 * pulse);
      ctx.beginPath(); rr(ctx, -bwid / 2 - bh * 0.12, -bh / 2 - bh * 0.12, bwid + bh * 0.24, bh * 1.24, bh * 0.62);
      ctx.fillStyle = '#FFFFFF'; ctx.fill();
      ctx.globalAlpha = A0;
    }
    ctx.fillStyle = 'rgba(40,25,70,0.2)';
    ctx.beginPath(); rr(ctx, -bwid / 2, -bh / 2 + bh * 0.08, bwid, bh, bh / 2); ctx.fill();
    ctx.beginPath(); rr(ctx, -bwid / 2, -bh / 2, bwid, bh, bh / 2);
    ctx.fillStyle = soundOn ? '#3DBE6A' : '#FF5C9E'; ctx.fill();
    ctx.lineWidth = Math.max(2, bh * 0.05); ctx.strokeStyle = '#FFFFFF'; ctx.stroke();
    var ix = -bwid / 2 + bh * 0.72;
    speakerIcon(ctx, ix, 0, bh * 0.62, '#FFFFFF', 'on');
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, -bwid / 2 + bh * 1.3, bh * 0.03);
    if (soundOn) {
      // check mark after the label
      var kx = -bwid / 2 + bh * 1.3 + lw + bh * 0.2;
      ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = bh * 0.1;
      ctx.beginPath(); ctx.moveTo(kx, 0); ctx.lineTo(kx + bh * 0.13, bh * 0.14); ctx.lineTo(kx + bh * 0.36, -bh * 0.16); ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
  }

  function paintMoon(g, B) {
    g.scale(B, B);
    g.beginPath(); circ(g, 0, 0, 0.45);
    g.fillStyle = '#FFE58A'; g.fill();
    g.lineWidth = 0.06; g.strokeStyle = OL; g.stroke();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); circ(g, 0.24, -0.18, 0.36); g.fill();
    g.globalCompositeOperation = 'source-over';
    g.save();
    g.beginPath(); circ(g, 0, 0, 0.45); g.clip();
    g.beginPath(); circ(g, 0.24, -0.18, 0.36); g.lineWidth = 0.06; g.strokeStyle = OL; g.stroke();
    g.restore();
    // sleepy eye + smile
    g.strokeStyle = OL; g.lineWidth = 0.04;
    g.beginPath(); g.arc(-0.2, 0.0, 0.07, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke();
    g.fillStyle = 'rgba(255,120,150,0.5)'; g.beginPath(); circ(g, -0.25, 0.15, 0.05); g.fill();
  }

  var pauseLayout = { key: '', L: null };
  var PAUSE_L1 = 'The steering wheel phone disconnected.';
  var PAUSE_L2 = 'Reopen this on the phone:';
  function layoutPaused(ctx, w, h, url) {
    var key = w + 'x' + h + '|' + url;
    if (pauseLayout.key === key) return pauseLayout.L;
    var pad = 0.04 * h, qs = 0.26 * h;
    var maxCard = Math.min(0.9 * w, 1.75 * h);
    var maxTW = maxCard - qs - 3 * pad;
    var f1 = fitSize(ctx, PAUSE_L1, 0.048 * h, maxTW, 800);
    var f2 = fitSize(ctx, PAUSE_L2, 0.04 * h, maxTW, 700);
    var fu = fitSize(ctx, url, 0.04 * h, maxTW - 0.03 * h, 700, MONO);
    ctx.font = font(f1, 800); var w1 = ctx.measureText(PAUSE_L1).width;
    ctx.font = font(f2, 700); var w2 = ctx.measureText(PAUSE_L2).width;
    ctx.font = font(fu, 700, MONO); var wu = ctx.measureText(url).width + 0.03 * h;
    var tw = Math.max(w1, w2, wu);
    var cardW = pad * 3 + qs + tw, cardH = qs + 2 * pad;
    var L = { pad: pad, qs: qs, f1: f1, f2: f2, fu: fu, wu: wu, cardW: cardW, cardH: cardH };
    pauseLayout.key = key; pauseLayout.L = L;
    return L;
  }

  function drawPaused(ctx, w, h, t, qrImg, url) {
    t = num(t, 0);
    url = url ? String(url) : 'https://spalladino.github.io/cami-games/driving/controller.html';
    ctx.save();
    ctx.fillStyle = 'rgba(14,18,44,0.5)';
    ctx.fillRect(0, 0, w, h);
    var L = layoutPaused(ctx, w, h, url);
    var cx = w / 2, cy = 0.37 * h, x0 = cx - L.cardW / 2, y0 = cy - L.cardH / 2, r = 0.035 * h;
    ctx.fillStyle = 'rgba(10,8,30,0.3)';
    ctx.beginPath(); rr(ctx, x0 + 0.006 * h, y0 + 0.012 * h, L.cardW, L.cardH, r); ctx.fill();
    ctx.beginPath(); rr(ctx, x0, y0, L.cardW, L.cardH, r);
    ctx.fillStyle = '#FFFDF8'; ctx.fill();
    ctx.lineWidth = Math.max(3, 0.006 * h); ctx.strokeStyle = '#CFC6E8'; ctx.stroke();
    drawQR(ctx, qrImg, x0 + L.pad, y0 + L.pad, L.qs, t);
    var tx = x0 + L.pad * 2 + L.qs;
    var lh = L.f1 * 1.25 + L.f2 * 1.3 + L.fu * 1.8 + 0.02 * h;
    var y = cy - lh / 2;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#3D2C4E'; ctx.font = font(L.f1, 800);
    ctx.fillText(PAUSE_L1, tx, y + L.f1 * 0.6);
    y += L.f1 * 1.25 + 0.01 * h;
    ctx.fillStyle = '#6A5A78'; ctx.font = font(L.f2, 700);
    ctx.fillText(PAUSE_L2, tx, y + L.f2 * 0.6);
    y += L.f2 * 1.3 + 0.01 * h;
    var ubh = L.fu * 1.7;
    ctx.beginPath(); rr(ctx, tx, y, L.wu, ubh, ubh * 0.3);
    ctx.fillStyle = '#E3F4FF'; ctx.fill();
    ctx.lineWidth = Math.max(1.5, 0.003 * h); ctx.strokeStyle = '#9CCBEA'; ctx.stroke();
    ctx.fillStyle = '#1D3F72'; ctx.font = font(L.fu, 700, MONO);
    ctx.fillText(url, tx + 0.015 * h, y + ubh / 2 + L.fu * 0.04);
    // sleepy moon on the card corner
    var mr = 0.05 * h, Bm = bucket(mr * 2);
    var moon = getSprite('moon:' + Bm, Bm * 1.2, Bm * 1.2, Bm * 0.6, Bm * 0.6, paintMoon, Bm);
    blit(ctx, moon, x0 + L.cardW - 0.012 * h, y0 + 0.012 * h + Math.sin(t * 1.2) * 0.006 * h, mr * 2 / Bm);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------

  global.Art = {
    palette: palette,
    drawGround: drawGround,
    drawRoad: drawRoad,
    drawProp: drawProp,
    drawTreat: drawTreat,
    drawPuddle: drawPuddle,
    drawCar: drawCar,
    drawGate: drawGate,
    drawParticle: drawParticle,
    drawTray: drawTray,
    drawTrophies: drawTrophies,
    trophyPos: trophyPos,
    drawRainbow: drawRainbow,
    drawTrafficLight: drawTrafficLight,
    drawWaiting: drawWaiting,
    drawPaused: drawPaused,
    drawSoundOff: drawSoundOff
  };
})(typeof window !== 'undefined' ? window : this);
