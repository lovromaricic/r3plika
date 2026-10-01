/*
 * lib.js - pure helpers for the capture engine.
 * No DOM access except an optional canvas fallback for exotic colour syntaxes,
 * so most of this can be unit-tested in plain Node.
 */
(function (root) {
  'use strict';
  const L = {};
  const PI = Math.PI;

  /* ------------------------------------------------------------------ */
  /* numbers + escaping                                                  */
  /* ------------------------------------------------------------------ */
  L.n = function (v) {
    if (!isFinite(v)) return 0;
    const r = Math.round(v * 100) / 100;
    return r === 0 ? 0 : r;
  };
  const n = L.n;

  const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
  L.esc = (s) => String(s).replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  L.escText = (s) => String(s).replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  L.sanitizeName = function (s) {
    let out = String(s == null ? '' : s).trim().replace(/[^\w\-\u00C0-\uFFFF]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!out) out = 'layer';
    if (/^[\d-]/.test(out)) out = 'l' + out;
    return out;
  };

  /* ------------------------------------------------------------------ */
  /* tokenising                                                          */
  /* ------------------------------------------------------------------ */
  // Split on a separator at the top level (ignores separators inside () and quotes).
  L.splitTop = function (str, sep) {
    sep = sep || ',';
    str = String(str == null ? '' : str);
    const out = [];
    let depth = 0, cur = '', q = null;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (q) {
        cur += c;
        if (c === '\\') { cur += str[++i] || ''; } else if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      if (depth === 0 && (sep === ' ' ? /\s/.test(c) : c === sep)) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };

  L.fnArgs = (s) => s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));

  L.len = function (s, base) {
    if (s == null) return 0;
    s = String(s).trim();
    if (!s || s === 'auto' || s === 'normal') return 0;
    let m = s.match(/^calc\(\s*(-?[\d.]+)%\s*([+-])\s*([\d.]+)px\s*\)$/);
    if (m) return base * parseFloat(m[1]) / 100 + (m[2] === '-' ? -1 : 1) * parseFloat(m[3]);
    m = s.match(/^calc\(\s*(-?[\d.]+)px\s*([+-])\s*([\d.]+)%\s*\)$/);
    if (m) return parseFloat(m[1]) + (m[2] === '-' ? -1 : 1) * base * parseFloat(m[3]) / 100;
    if (s.endsWith('%')) return parseFloat(s) / 100 * base;
    const v = parseFloat(s);
    return isNaN(v) ? 0 : v;
  };

  L.parseAngle = function (tok) {
    const m = String(tok).trim().match(/^(-?[\d.]+)(deg|grad|rad|turn)?$/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    switch (m[2]) {
      case 'grad': return v * 0.9;
      case 'rad': return v * 180 / PI;
      case 'turn': return v * 360;
      default: return v;
    }
  };

  /* ------------------------------------------------------------------ */
  /* colours                                                             */
  /* ------------------------------------------------------------------ */
  const colorCache = new Map();
  let cctx = null;
  L.parseColor = function (str) {
    if (str == null) return null;
    str = String(str).trim();
    if (colorCache.has(str)) return colorCache.get(str);
    let out = null;
    const lower = str.toLowerCase();
    if (lower === 'transparent') out = { r: 0, g: 0, b: 0, a: 0 };
    else {
      const m = lower.match(/^rgba?\(\s*([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
      if (m) {
        let a = 1;
        if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        out = { r: +m[1], g: +m[2], b: +m[3], a: Math.max(0, Math.min(1, a)) };
      } else if (typeof document !== 'undefined') {
        // let the browser resolve oklch(), color-mix(), named colours, etc.
        try {
          if (!cctx) {
            const cv = document.createElement('canvas');
            cv.width = cv.height = 1;
            cctx = cv.getContext('2d', { willReadFrequently: true });
          }
          cctx.fillStyle = '#010203';
          cctx.fillStyle = str;
          if (!(cctx.fillStyle === '#010203' && lower !== '#010203')) {
            cctx.clearRect(0, 0, 1, 1);
            cctx.fillRect(0, 0, 1, 1);
            const d = cctx.getImageData(0, 0, 1, 1).data;
            out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
          }
        } catch (e) { out = null; }
      }
    }
    colorCache.set(str, out);
    return out;
  };

  L.hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  // ` fill="#rrggbb" fill-opacity=".."`  (kind = fill | stroke)
  L.paint = (c, kind) => ` ${kind}="${L.hex(c)}"` + (c.a < 0.999 ? ` ${kind}-opacity="${+c.a.toFixed(3)}"` : '');
  L.sameColor = (a, b) => !!a && !!b && Math.abs(a.r - b.r) < 1 && Math.abs(a.g - b.g) < 1 && Math.abs(a.b - b.b) < 1 && Math.abs(a.a - b.a) < 0.01;

  /* ------------------------------------------------------------------ */
  /* border radius + shapes                                              */
  /* ------------------------------------------------------------------ */
  // returns [tl, tr, br, bl] each {x, y}
  L.radii = function (cs, w, h) {
    const get = (p) => {
      const parts = String(cs[p] || '0').trim().split(/\s+/);
      return {
        x: Math.max(0, L.len(parts[0], w)),
        y: Math.max(0, L.len(parts[1] !== undefined ? parts[1] : parts[0], h)),
      };
    };
    const r = [get('borderTopLeftRadius'), get('borderTopRightRadius'), get('borderBottomRightRadius'), get('borderBottomLeftRadius')];
    let f = 1;
    const chk = (sum, size) => { if (sum > size && sum > 0) f = Math.min(f, size / sum); };
    chk(r[0].x + r[1].x, w); chk(r[3].x + r[2].x, w);
    chk(r[0].y + r[3].y, h); chk(r[1].y + r[2].y, h);
    if (f < 1) r.forEach((c) => { c.x *= f; c.y *= f; });
    return r;
  };
  L.zeroRadii = () => [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];

  const fixCorner = (c) => (c.x <= 0 || c.y <= 0 ? { x: 0, y: 0 } : c);
  L.insetRadii = (r, t, rt, b, l) => [
    fixCorner({ x: Math.max(0, r[0].x - l), y: Math.max(0, r[0].y - t) }),
    fixCorner({ x: Math.max(0, r[1].x - rt), y: Math.max(0, r[1].y - t) }),
    fixCorner({ x: Math.max(0, r[2].x - rt), y: Math.max(0, r[2].y - b) }),
    fixCorner({ x: Math.max(0, r[3].x - l), y: Math.max(0, r[3].y - b) }),
  ];
  // grow (d>0) or shrink (d<0) every non-square corner
  L.growRadii = (r, d) => r.map((c) => (c.x <= 0 || c.y <= 0 ? { x: 0, y: 0 } : fixCorner({ x: Math.max(0, c.x + d), y: Math.max(0, c.y + d) })));

  L.rrPath = function (x, y, w, h, r) {
    const [tl, tr, br, bl] = r;
    const any = r.some((c) => c.x > 0 && c.y > 0);
    if (!any) return `M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`;
    let d = `M${n(x + tl.x)} ${n(y)}`;
    d += `H${n(x + w - tr.x)}`;
    if (tr.x && tr.y) d += `A${n(tr.x)} ${n(tr.y)} 0 0 1 ${n(x + w)} ${n(y + tr.y)}`;
    d += `V${n(y + h - br.y)}`;
    if (br.x && br.y) d += `A${n(br.x)} ${n(br.y)} 0 0 1 ${n(x + w - br.x)} ${n(y + h)}`;
    d += `H${n(x + bl.x)}`;
    if (bl.x && bl.y) d += `A${n(bl.x)} ${n(bl.y)} 0 0 1 ${n(x)} ${n(y + h - bl.y)}`;
    d += `V${n(y + tl.y)}`;
    if (tl.x && tl.y) d += `A${n(tl.x)} ${n(tl.y)} 0 0 1 ${n(x + tl.x)} ${n(y)}`;
    return d + 'Z';
  };

  L.uniformRadius = function (r) {
    const a = r[0];
    return r.every((c) => Math.abs(c.x - a.x) < 0.01 && Math.abs(c.y - a.y) < 0.01) ? a : null;
  };

  // Prefer a native <rect> (Figma turns it into an editable rectangle); fall back to <path>.
  L.shape = function (x, y, w, h, r, attrs) {
    attrs = attrs ? ' ' + attrs.trim() : '';
    const u = L.uniformRadius(r);
    if (u) {
      let rr = '';
      if (u.x > 0 && u.y > 0) rr = Math.abs(u.x - u.y) < 0.01 ? ` rx="${n(u.x)}"` : ` rx="${n(u.x)}" ry="${n(u.y)}"`;
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${rr}${attrs}/>`;
    }
    return `<path d="${L.rrPath(x, y, w, h, r)}"${attrs}/>`;
  };

  /* ------------------------------------------------------------------ */
  /* positions / sizes for backgrounds & object-fit                      */
  /* ------------------------------------------------------------------ */
  // Offset along one axis for background-position / object-position.
  L.bgAxis = function (tok, area, tile) {
    tok = String(tok == null ? '50%' : tok).trim();
    if (tok === 'left' || tok === 'top') return 0;
    if (tok === 'center') return (area - tile) / 2;
    if (tok === 'right' || tok === 'bottom') return area - tile;
    let m = tok.match(/^calc\(\s*(-?[\d.]+)%\s*([+-])\s*([\d.]+)px\s*\)$/);
    if (m) return (area - tile) * parseFloat(m[1]) / 100 + (m[2] === '-' ? -1 : 1) * parseFloat(m[3]);
    m = tok.match(/^calc\(\s*(-?[\d.]+)px\s*([+-])\s*([\d.]+)%\s*\)$/);
    if (m) return parseFloat(m[1]) + (m[2] === '-' ? -1 : 1) * (area - tile) * parseFloat(m[3]) / 100;
    if (tok.endsWith('%')) return (area - tile) * parseFloat(tok) / 100;
    const v = parseFloat(tok);
    return isNaN(v) ? 0 : v;
  };
  L.bgPos = function (str, aw, ah, tw, th) {
    const t = L.splitTop(String(str || '0% 0%'), ' ');
    let a = t[0], b = t[1] === undefined ? 'center' : t[1];
    if (a === 'top' || a === 'bottom' || b === 'left' || b === 'right') { const x = a; a = b; b = x; }
    return { x: L.bgAxis(a, aw, tw), y: L.bgAxis(b, ah, th) };
  };
  L.bgSize = function (str, aw, ah, nw, nh) {
    str = String(str || 'auto').trim();
    const hasNat = nw > 0 && nh > 0;
    if (str === 'cover' || str === 'contain') {
      if (!hasNat) return { w: aw, h: ah };
      const s = str === 'cover' ? Math.max(aw / nw, ah / nh) : Math.min(aw / nw, ah / nh);
      return { w: nw * s, h: nh * s };
    }
    const t = L.splitTop(str, ' ');
    let w = t[0] === 'auto' ? null : L.len(t[0], aw);
    let h = (t[1] === undefined || t[1] === 'auto') ? null : L.len(t[1], ah);
    if (w == null && h == null) return hasNat ? { w: nw, h: nh } : { w: aw, h: ah };
    if (w == null) w = hasNat ? h * nw / nh : aw;
    if (h == null) h = hasNat ? w * nh / nw : ah;
    return { w, h };
  };
  // gradient centre / "at" position (percent is of the box itself, not the leftover space)
  L.parsePos = function (tokens, w, h) {
    let a = tokens.slice();
    const px = (t, size) => (t === 'left' || t === 'top') ? 0 : t === 'center' ? size / 2 : (t === 'right' || t === 'bottom') ? size : L.len(t, size);
    if (a.length === 1) a = (a[0] === 'top' || a[0] === 'bottom') ? ['center', a[0]] : [a[0], 'center'];
    if (a.length >= 4) {
      if (a[0] === 'top' || a[0] === 'bottom') a = [a[2], a[3], a[0], a[1]];
      const edge = (k, off, size) => { const o = L.len(off, size); return (k === 'right' || k === 'bottom') ? size - o : o; };
      return { x: edge(a[0], a[1], w), y: edge(a[2], a[3], h) };
    }
    if (a[0] === 'top' || a[0] === 'bottom' || a[1] === 'left' || a[1] === 'right') a = [a[1], a[0]];
    return { x: px(a[0], w), y: px(a[1], h) };
  };

  L.fitViewBox = function (vb, w, h, par) {
    par = String(par || 'xMidYMid meet').trim();
    if (!vb || !(vb.w > 0) || !(vb.h > 0)) return { sx: 1, sy: 1, tx: 0, ty: 0 };
    if (par.indexOf('none') === 0) {
      const sx = w / vb.w, sy = h / vb.h;
      return { sx, sy, tx: -vb.x * sx, ty: -vb.y * sy };
    }
    const sc = /slice/.test(par) ? Math.max(w / vb.w, h / vb.h) : Math.min(w / vb.w, h / vb.h);
    const m = par.match(/x(Min|Mid|Max)Y(Min|Mid|Max)/) || [0, 'Mid', 'Mid'];
    const ax = m[1] === 'Min' ? 0 : m[1] === 'Max' ? 1 : 0.5;
    const ay = m[2] === 'Min' ? 0 : m[2] === 'Max' ? 1 : 0.5;
    return { sx: sc, sy: sc, tx: (w - vb.w * sc) * ax - vb.x * sc, ty: (h - vb.h * sc) * ay - vb.y * sc };
  };

  /* ------------------------------------------------------------------ */
  /* gradients                                                           */
  /* ------------------------------------------------------------------ */
  L.gradientKind = function (layer) {
    layer = String(layer).trim();
    if (/^(repeating-)?linear-gradient\(/i.test(layer)) return 'linear';
    if (/^(repeating-)?radial-gradient\(/i.test(layer)) return 'radial';
    if (/^(repeating-)?conic-gradient\(/i.test(layer)) return 'conic';
    if (/^url\(/i.test(layer)) return 'url';
    return null;
  };

  L.parseStops = function (parts, toFrac, parseColor) {
    const stops = [];
    for (const p of parts) {
      const toks = L.splitTop(p, ' ');
      let colorTok = null;
      const poss = [];
      for (const t of toks) {
        if (/^-?[\d.]+(%|px|deg|turn|rad|grad|em|rem)?$/.test(t)) poss.push(t);
        else colorTok = t;
      }
      if (!colorTok) continue; // colour hint, ignored
      const col = parseColor(colorTok);
      if (!col) continue;
      if (!poss.length) stops.push({ c: col, pos: null });
      else poss.forEach((pp) => stops.push({ c: col, pos: toFrac(pp) }));
    }
    return stops;
  };

  L.fixStops = function (st) {
    if (!st.length) return st;
    if (st[0].pos == null) st[0].pos = 0;
    if (st[st.length - 1].pos == null) {
      let mx = 1;
      st.forEach((s) => { if (s.pos != null && s.pos > mx) mx = s.pos; });
      st[st.length - 1].pos = mx;
    }
    let prev = st[0].pos;
    for (let i = 1; i < st.length; i++) {
      if (st[i].pos != null) { if (st[i].pos < prev) st[i].pos = prev; prev = st[i].pos; }
    }
    let i = 0;
    while (i < st.length) {
      if (st[i].pos == null) {
        let j = i;
        while (st[j].pos == null) j++;
        const a = st[i - 1].pos, b = st[j].pos;
        for (let k = i; k < j; k++) st[k].pos = a + (b - a) * (k - i + 1) / (j - i + 1);
        i = j;
      }
      i++;
    }
    return st;
  };

  // CSS interpolates in premultiplied space, SVG does not: give transparent stops a neighbour's RGB.
  L.fixTransparent = function (st) {
    for (let i = 0; i < st.length; i++) {
      if (st[i].c.a === 0) {
        let src = null;
        for (let j = i - 1; j >= 0 && !src; j--) if (st[j].c.a > 0) src = st[j];
        for (let j = i + 1; j < st.length && !src; j++) if (st[j].c.a > 0) src = st[j];
        if (src) st[i].c = { r: src.c.r, g: src.c.g, b: src.c.b, a: 0 };
      }
    }
    return st;
  };

  const stopsSvg = (st) => st.map((s) =>
    `<stop offset="${+s.pos.toFixed(4)}" stop-color="${L.hex(s.c)}"${s.c.a < 0.999 ? ` stop-opacity="${+s.c.a.toFixed(3)}"` : ''}/>`).join('');

  L.linearGradient = function (layer, box, id, parseColor) {
    const w = box.w, h = box.h;
    const repeating = /^repeating-/i.test(layer);
    const parts = L.splitTop(L.fnArgs(layer));
    if (!parts.length) return null;
    let dx = 0, dy = 1, i = 0;
    const first = parts[0];
    if (/^to\s/i.test(first)) {
      i = 1;
      const k = first.toLowerCase().split(/\s+/).slice(1);
      const t = k.includes('top'), b = k.includes('bottom'), l = k.includes('left'), r = k.includes('right');
      if ((t || b) && (l || r)) {
        dx = (r ? 1 : -1) * h; dy = (b ? 1 : -1) * w;
        const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
      } else if (t) { dx = 0; dy = -1; } else if (b) { dx = 0; dy = 1; } else if (l) { dx = -1; dy = 0; } else { dx = 1; dy = 0; }
    } else {
      const a = L.parseAngle(first);
      if (a !== null) { i = 1; const rad = a * PI / 180; dx = Math.sin(rad); dy = -Math.cos(rad); }
    }
    const len = Math.abs(w * dx) + Math.abs(h * dy) || 1;
    const stops = L.parseStops(parts.slice(i), (t) => (/%$/.test(t) ? parseFloat(t) / 100 : L.len(t, 0) / len), parseColor);
    if (!stops.length) return null;
    if (stops.length === 1) stops.push({ c: stops[0].c, pos: null });
    L.fixStops(stops); L.fixTransparent(stops);
    const cx = box.x + w / 2, cy = box.y + h / 2;
    let sx = cx - dx * len / 2, sy = cy - dy * len / 2, ex = cx + dx * len / 2, ey = cy + dy * len / 2;
    let spread = '';
    if (repeating) {
      const f0 = stops[0].pos, f1 = stops[stops.length - 1].pos;
      if (f1 > f0) {
        const nsx = sx + (ex - sx) * f0, nsy = sy + (ey - sy) * f0;
        const nex = sx + (ex - sx) * f1, ney = sy + (ey - sy) * f1;
        sx = nsx; sy = nsy; ex = nex; ey = ney;
        stops.forEach((s) => { s.pos = (s.pos - f0) / (f1 - f0); });
        spread = ' spreadMethod="repeat"';
      }
    }
    return {
      def: `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(sx)}" y1="${n(sy)}" x2="${n(ex)}" y2="${n(ey)}"${spread}>${stopsSvg(stops)}</linearGradient>`,
      ref: `url(#${id})`,
    };
  };

  L.radialGradient = function (layer, box, id, parseColor) {
    const w = box.w, h = box.h;
    const repeating = /^repeating-/i.test(layer);
    const parts = L.splitTop(L.fnArgs(layer));
    if (!parts.length) return null;
    let i = 0, shape = 'ellipse', sizeKw = 'farthest-corner';
    let lens = [], atStr = null;
    const first = parts[0];
    if (/^(circle|ellipse|closest|farthest|at\s|[\d.])/i.test(first) || /\sat\s/.test(first)) {
      i = 1;
      let pre = first;
      const ix = first.search(/(^|\s)at\s/);
      if (ix >= 0) { pre = first.slice(0, ix).trim(); atStr = first.slice(ix).trim().replace(/^at\s+/, ''); }
      pre.split(/\s+/).filter(Boolean).forEach((t) => {
        if (t === 'circle' || t === 'ellipse') shape = t;
        else if (/^(closest|farthest)-(side|corner)$/.test(t)) sizeKw = t;
        else lens.push(t);
      });
    }
    const at = atStr ? L.parsePos(atStr.split(/\s+/), w, h) : { x: w / 2, y: h / 2 };
    const dl = at.x, dr = w - at.x, dt = at.y, db = h - at.y;
    let rx, ry;
    if (lens.length === 1) { rx = ry = L.len(lens[0], w); }
    else if (lens.length >= 2) { rx = L.len(lens[0], w); ry = L.len(lens[1], h); }
    else {
      const circle = shape === 'circle';
      const nx = Math.min(Math.abs(dl), Math.abs(dr)), ny = Math.min(Math.abs(dt), Math.abs(db));
      const fx = Math.max(Math.abs(dl), Math.abs(dr)), fy = Math.max(Math.abs(dt), Math.abs(db));
      if (sizeKw === 'closest-side') { if (circle) rx = ry = Math.min(nx, ny); else { rx = nx; ry = ny; } }
      else if (sizeKw === 'farthest-side') { if (circle) rx = ry = Math.max(fx, fy); else { rx = fx; ry = fy; } }
      else if (sizeKw === 'closest-corner') { if (circle) rx = ry = Math.hypot(nx, ny); else { rx = nx * Math.SQRT2; ry = ny * Math.SQRT2; } }
      else { if (circle) rx = ry = Math.hypot(fx, fy); else { rx = fx * Math.SQRT2; ry = fy * Math.SQRT2; } }
    }
    rx = Math.max(rx, 0.01); ry = Math.max(ry, 0.01);
    const stops = L.parseStops(parts.slice(i), (t) => (/%$/.test(t) ? parseFloat(t) / 100 : L.len(t, 0) / rx), parseColor);
    if (!stops.length) return null;
    if (stops.length === 1) stops.push({ c: stops[0].c, pos: null });
    L.fixStops(stops); L.fixTransparent(stops);
    let spread = '', rad = rx;
    if (repeating) {
      const f1 = stops[stops.length - 1].pos;
      if (f1 > 0) { stops.forEach((s) => { s.pos = s.pos / f1; }); rad = rx * f1; spread = ' spreadMethod="repeat"'; }
    }
    const cx = box.x + at.x, cy = box.y + at.y;
    const tf = Math.abs(ry - rx) > 0.01 ? ` gradientTransform="translate(${n(cx)} ${n(cy)}) scale(1 ${+(ry / rx).toFixed(5)}) translate(${n(-cx)} ${n(-cy)})"` : '';
    return {
      def: `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(cx)}" cy="${n(cy)}" r="${n(rad)}"${tf}${spread}>${stopsSvg(stops)}</radialGradient>`,
      ref: `url(#${id})`,
    };
  };

  // conic gradients are rasterised by the caller (SVG has no equivalent)
  L.parseConic = function (layer, box, parseColor) {
    const parts = L.splitTop(L.fnArgs(layer));
    let from = 0, at = { x: box.w / 2, y: box.h / 2 }, i = 0;
    const first = parts[0] || '';
    if (/^(from|at)\b/.test(first)) {
      i = 1;
      const fm = first.match(/from\s+(-?[\d.]+(?:deg|grad|rad|turn)?)/);
      if (fm) from = L.parseAngle(fm[1]) || 0;
      const am = first.match(/\bat\s+(.+)$/);
      if (am) at = L.parsePos(am[1].trim().split(/\s+/), box.w, box.h);
    }
    const stops = L.parseStops(parts.slice(i), (t) => (/%$/.test(t) ? parseFloat(t) / 100 : (L.parseAngle(t) || 0) / 360), parseColor);
    if (!stops.length) return null;
    if (stops.length === 1) stops.push({ c: stops[0].c, pos: null });
    L.fixStops(stops);
    return { from, at, stops };
  };

  /* ------------------------------------------------------------------ */
  /* shadows + filters                                                   */
  /* ------------------------------------------------------------------ */
  L.parseShadows = function (str, parseColor) {
    if (!str || str === 'none') return [];
    return L.splitTop(str, ',').map((s) => {
      const toks = L.splitTop(s, ' ');
      let inset = false, color = null;
      const nums = [];
      for (const t of toks) {
        if (t === 'inset') inset = true;
        else if (/^-?[\d.]+(px)?$/.test(t)) nums.push(parseFloat(t));
        else color = parseColor(t);
      }
      return { inset, color: color || { r: 0, g: 0, b: 0, a: 1 }, x: nums[0] || 0, y: nums[1] || 0, blur: Math.max(0, nums[2] || 0), spread: nums[3] || 0 };
    });
  };

  // CSS `filter` -> SVG <filter>. box = {x,y,w,h} in user space.
  L.filterChain = function (str, id, box, parseColor) {
    if (!str || str === 'none') return null;
    let prims = '', margin = 0;
    const amt = (a) => (/%$/.test(a) ? parseFloat(a) / 100 : parseFloat(a));
    for (const f of L.splitTop(str, ' ')) {
      const m = f.match(/^([a-z-]+)\(([\s\S]*)\)$/);
      if (!m) continue;
      const name = m[1], arg = m[2].trim();
      switch (name) {
        case 'blur': {
          const r = L.len(arg, 0);
          prims += `<feGaussianBlur stdDeviation="${n(r)}"/>`;
          margin = Math.max(margin, r * 3);
          break;
        }
        case 'drop-shadow': {
          const toks = L.splitTop(arg, ' ');
          const colorTok = toks.find((t) => !/^-?[\d.]+(px)?$/.test(t));
          const nums = toks.filter((t) => /^-?[\d.]+(px)?$/.test(t)).map(parseFloat);
          const col = (colorTok && parseColor(colorTok)) || { r: 0, g: 0, b: 0, a: 1 };
          const dx = nums[0] || 0, dy = nums[1] || 0, bl = nums[2] || 0;
          prims += `<feDropShadow dx="${n(dx)}" dy="${n(dy)}" stdDeviation="${n(bl / 2)}" flood-color="${L.hex(col)}" flood-opacity="${+col.a.toFixed(3)}"/>`;
          margin = Math.max(margin, bl * 1.5 + Math.max(Math.abs(dx), Math.abs(dy)));
          break;
        }
        case 'brightness': { const v = amt(arg); prims += `<feComponentTransfer><feFuncR type="linear" slope="${v}"/><feFuncG type="linear" slope="${v}"/><feFuncB type="linear" slope="${v}"/></feComponentTransfer>`; break; }
        case 'contrast': { const v = amt(arg); const ic = -(0.5 * v) + 0.5; prims += `<feComponentTransfer><feFuncR type="linear" slope="${v}" intercept="${ic}"/><feFuncG type="linear" slope="${v}" intercept="${ic}"/><feFuncB type="linear" slope="${v}" intercept="${ic}"/></feComponentTransfer>`; break; }
        case 'opacity': { const v = amt(arg); prims += `<feComponentTransfer><feFuncA type="linear" slope="${v}"/></feComponentTransfer>`; break; }
        case 'invert': { const v = amt(arg); prims += `<feComponentTransfer><feFuncR type="table" tableValues="${v} ${1 - v}"/><feFuncG type="table" tableValues="${v} ${1 - v}"/><feFuncB type="table" tableValues="${v} ${1 - v}"/></feComponentTransfer>`; break; }
        case 'saturate': { prims += `<feColorMatrix type="saturate" values="${amt(arg)}"/>`; break; }
        case 'hue-rotate': { prims += `<feColorMatrix type="hueRotate" values="${L.parseAngle(arg) || 0}"/>`; break; }
        case 'grayscale': {
          const a = 1 - Math.min(1, amt(arg));
          const v = [0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a, 0, 0,
            0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a, 0, 0,
            0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a, 0, 0,
            0, 0, 0, 1, 0];
          prims += `<feColorMatrix type="matrix" values="${v.map((x) => +x.toFixed(4)).join(' ')}"/>`;
          break;
        }
        case 'sepia': {
          const a = 1 - Math.min(1, amt(arg));
          const v = [0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a, 0, 0,
            0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a, 0, 0,
            0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a, 0, 0,
            0, 0, 0, 1, 0];
          prims += `<feColorMatrix type="matrix" values="${v.map((x) => +x.toFixed(4)).join(' ')}"/>`;
          break;
        }
        default: break;
      }
    }
    if (!prims) return null;
    const m2 = Math.ceil(margin) + 2;
    return {
      def: `<filter id="${id}" filterUnits="userSpaceOnUse" x="${n(box.x - m2)}" y="${n(box.y - m2)}" width="${n(box.w + 2 * m2)}" height="${n(box.h + 2 * m2)}" color-interpolation-filters="sRGB">${prims}</filter>`,
      ref: `url(#${id})`,
    };
  };

  /* ------------------------------------------------------------------ */
  /* CSS clip-path basic shapes -> <clipPath>                            */
  /* ------------------------------------------------------------------ */
  L.cssClipPath = function (str, box, id) {
    const m = String(str || '').match(/^(inset|circle|ellipse|polygon)\(([\s\S]*)\)\s*(?:[\w-]+-box)?$/);
    if (!m) return null;
    const fn = m[1], arg = m[2].trim();
    let shape = '';
    if (fn === 'polygon') {
      const list = L.splitTop(arg, ',');
      let rule = '';
      if (/^(nonzero|evenodd)$/.test(list[0])) rule = list.shift();
      const pts = list.map((p) => {
        const t = p.trim().split(/\s+/);
        return `${n(box.x + L.len(t[0], box.w))},${n(box.y + L.len(t[1], box.h))}`;
      });
      if (pts.length < 3) return null;
      shape = `<polygon points="${pts.join(' ')}"${rule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/>`;
    } else if (fn === 'circle' || fn === 'ellipse') {
      const [rp, ap] = arg.split(/\s+at\s+/);
      const at = ap ? L.parsePos(ap.trim().split(/\s+/), box.w, box.h) : { x: box.w / 2, y: box.h / 2 };
      const cx = box.x + at.x, cy = box.y + at.y;
      const toks = (rp || '').trim().split(/\s+/).filter(Boolean);
      const ref = Math.sqrt((box.w * box.w + box.h * box.h) / 2);
      const rad = (t, size, dflt) => {
        if (!t || t === 'closest-side' || t === 'farthest-side') return dflt;
        return /%$/.test(t) ? parseFloat(t) / 100 * size : parseFloat(t);
      };
      if (fn === 'circle') {
        const ds = Math.min(at.x, box.w - at.x, at.y, box.h - at.y);
        const fs = Math.max(at.x, box.w - at.x, at.y, box.h - at.y);
        const r = !toks[0] ? fs : toks[0] === 'closest-side' ? ds : toks[0] === 'farthest-side' ? fs : (/%$/.test(toks[0]) ? parseFloat(toks[0]) / 100 * ref : parseFloat(toks[0]));
        shape = `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}"/>`;
      } else {
        const rx = rad(toks[0], box.w, Math.max(at.x, box.w - at.x));
        const ry = rad(toks[1], box.h, Math.max(at.y, box.h - at.y));
        shape = `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}"/>`;
      }
    } else {
      const [sides, round] = arg.split(/\s+round\s+/);
      const v = sides.trim().split(/\s+/);
      const t = L.len(v[0], box.h), r = L.len(v[1] !== undefined ? v[1] : v[0], box.w);
      const b = L.len(v[2] !== undefined ? v[2] : v[0], box.h), l = L.len(v[3] !== undefined ? v[3] : (v[1] !== undefined ? v[1] : v[0]), box.w);
      const rr = round ? L.len(round.trim().split(/\s+/)[0], Math.min(box.w, box.h)) : 0;
      shape = `<rect x="${n(box.x + l)}" y="${n(box.y + t)}" width="${n(Math.max(0, box.w - l - r))}" height="${n(Math.max(0, box.h - t - b))}"${rr > 0 ? ` rx="${n(rr)}"` : ''}/>`;
    }
    return { def: `<clipPath id="${id}">${shape}</clipPath>`, ref: `url(#${id})` };
  };

  /* ------------------------------------------------------------------ */
  /* generated content, list counters, byte helpers                      */
  /* ------------------------------------------------------------------ */
  L.cssUnescape = (s) => s
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; } })
    .replace(/\\([\s\S])/g, '$1');

  // value of the CSS `content` property -> {text, url}
  L.parseContent = function (value, attrFn) {
    let text = '', url = null;
    for (const t of L.splitTop(value, ' ')) {
      if (/^["']/.test(t)) text += L.cssUnescape(t.slice(1, -1));
      else if (/^url\(/i.test(t)) url = t.slice(4, -1).trim().replace(/^["']|["']$/g, '');
      else if (/^attr\(/i.test(t)) text += attrFn ? (attrFn(t.slice(5, -1).trim()) || '') : '';
      else if (t === 'open-quote') text += '\u201C';
      else if (t === 'close-quote') text += '\u201D';
    }
    return { text, url };
  };

  L.toAlpha = function (i, upper) {
    let s = '';
    while (i > 0) { i--; s = String.fromCharCode(97 + (i % 26)) + s; i = Math.floor(i / 26); }
    return upper ? s.toUpperCase() : s;
  };
  L.toRoman = function (i, upper) {
    const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let s = '';
    for (const [v, r] of map) while (i >= v) { s += r; i -= v; }
    return upper ? s.toUpperCase() : s;
  };
  L.counterText = function (type, i) {
    switch (type) {
      case 'decimal-leading-zero': return (i < 10 ? '0' : '') + i + '.';
      case 'lower-alpha': case 'lower-latin': return L.toAlpha(i, false) + '.';
      case 'upper-alpha': case 'upper-latin': return L.toAlpha(i, true) + '.';
      case 'lower-roman': return L.toRoman(i, false) + '.';
      case 'upper-roman': return L.toRoman(i, true) + '.';
      default: return i + '.';
    }
  };

  L.sniffMime = function (b) {
    if (!b || b.length < 4) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.length > 11 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
    if (b.length > 11 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'image/avif';
    // svg text?
    let head = '';
    for (let i = 0; i < Math.min(b.length, 400); i++) head += String.fromCharCode(b[i]);
    if (/<svg[\s>]/i.test(head) || /^\s*<\?xml/i.test(head) && /<svg/i.test(head)) return 'image/svg+xml';
    return null;
  };

  L.bytesToB64 = function (bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  };
  L.b64ToBytes = function (b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  else root.__w2fLib = L;
})(typeof globalThis !== 'undefined' ? globalThis : this);
