/*
 * capture.js - turns the live DOM into one layered SVG string.
 * Injected on demand by background.js (after lib.js).
 *
 * Pipeline:  prepare page -> walk DOM (sync, builds SVG pieces + async image jobs)
 *            -> restore page -> resolve image jobs -> assemble <svg> -> copy / download
 */
(function () {
  'use strict';
  const L = globalThis.__w2fLib;
  if (!L) { console.error('[web-to-figma] lib.js missing'); return; }
  // The newest injection always takes over. An older copy (e.g. left behind when the
  // extension was reloaded) sees a different token and stops answering messages.
  const TOKEN = Math.random().toString(36).slice(2);
  window.__w2f = { version: '1.0.1', token: TOKEN };

  const SVGNS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const n = L.n, esc = L.esc, escText = L.escText;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const DEFAULTS = {
    embedImages: true,     // false -> grey placeholders (tiny output, fast)
    imageScale: 2,         // max pixel density of embedded raster images
    maxImagePx: 2400,      // longest edge cap for embedded images
    jpegQuality: 0.86,
    scrollLazy: true,      // scroll through the page first to trigger lazy loading
    includeFixed: true,    // keep position:fixed elements
    includeHidden: false,  // keep opacity:0 elements
    structure: 'compact',  // 'compact' | 'full'
    fallbackSans: 'Inter',
    whiteBackground: true, // put a white rect behind everything (page / viewport)
    maxNodes: 40000,
    autoCopy: true,
    viewportWidth: 0,      // handled by background.js
  };

  const SKIP = new Set(['script', 'style', 'link', 'meta', 'head', 'noscript', 'template', 'title', 'base', 'source', 'track', 'param', 'datalist', 'area', 'map', 'option', 'optgroup']);
  const NO_PSEUDO = new Set(['img', 'input', 'br', 'hr', 'video', 'canvas', 'iframe', 'embed', 'object', 'textarea', 'select', 'svg', 'meter', 'progress', 'audio']);
  const REPLACED = new Set(['img', 'video', 'canvas', 'iframe', 'svg', 'input', 'textarea', 'select', 'object', 'embed', 'audio']);
  const SEMANTIC = new Set(['header', 'nav', 'main', 'section', 'footer', 'article', 'aside', 'form', 'ul', 'ol', 'li', 'button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'table', 'figure', 'dialog', 'label']);

  const state = { busy: false, last: null };

  /* ==================================================================== */
  /* in-page toast                                                         */
  /* ==================================================================== */
  const REDUCED = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  const UI = (function () {
    let host = null, card = null, ref = {}, countTok = 0;
    const CSS = `
      :host{all:initial}
      .card{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#15171c;background:#fff;border:1px solid #d9d9d2;border-radius:12px;box-shadow:0 10px 36px rgba(20,22,30,.22);padding:12px 14px 13px;width:300px;box-sizing:border-box}
      .card.enter{animation:pop-in .42s cubic-bezier(.34,1.4,.64,1) both}
      .head{display:flex;align-items:flex-start;gap:10px}
      .icon{width:26px;height:26px;flex:none;position:relative;margin-top:1px}
      .icon svg{position:absolute;inset:0;width:100%;height:100%}
      .spin{animation:spin .8s linear infinite}
      .card.done .spin,.card.err .icon{display:none}
      .card:not(.done) .chk{display:none}
      .chk circle{fill:#2f3bff;animation:pop-in .3s ease both}
      .chk path{fill:none;stroke:#fff;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:22;animation:draw .45s ease .1s both}
      .title{font-weight:700;font-size:13.5px}
      .sub{color:#5b606b;font-size:12px;margin-top:2px;min-height:17px;word-break:break-word}
      .x{margin-left:auto;border:0;background:none;font-size:18px;line-height:1;color:#6a6f7a;cursor:pointer;padding:0 2px}
      .bar{height:3px;background:#ebebe6;border-radius:2px;margin-top:10px;overflow:hidden}
      .bar i{display:block;height:100%;width:0;background:#2f3bff;transition:width .35s ease}
      .card:not(.done):not(.err) .bar i{background:linear-gradient(90deg,#2f3bff,#7f89ff,#2f3bff);background-size:200% 100%;animation:shim 1.1s linear infinite}
      .card.err .bar{display:none}
      .card.err .title{color:#b3261e}
      .row{display:none;gap:8px;margin-top:11px}
      .card.done .row{display:flex}
      button.b{font:inherit;font-weight:700;font-size:12.5px;border:1px solid #cfcfc7;background:#fff;border-radius:8px;padding:6px 11px;cursor:pointer;color:inherit}
      button.b.p{background:#2f3bff;border-color:#2f3bff;color:#fff}
      button:focus-visible{outline:2px solid #2f3bff;outline-offset:2px}
      .warn{margin-top:8px;font-size:11.5px;color:#7a5b00}
      @keyframes pop-in{from{opacity:0;transform:translateY(22px) scale(.96)}to{opacity:1;transform:none}}
      @keyframes spin{to{transform:rotate(360deg)}}
      @keyframes shim{to{background-position:-200% 0}}
      @keyframes draw{from{stroke-dashoffset:22}to{stroke-dashoffset:0}}
      @media (prefers-reduced-motion:reduce){*{animation:none !important;transition:none !important}}
    `;
    function ensure() {
      if (host && host.isConnected) return;
      host = document.createElement('div');
      host.id = 'w2f-ui-host';
      host.setAttribute('data-w2f-ignore', '');
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${CSS}</style>
        <div class="card enter">
          <div class="head">
            <div class="icon">
              <svg class="spin" viewBox="0 0 26 26"><circle cx="13" cy="13" r="10" fill="none" stroke="#e4e6f2" stroke-width="3"/><path d="M13 3a10 10 0 0 1 10 10" fill="none" stroke="#2f3bff" stroke-width="3" stroke-linecap="round"/></svg>
              <svg class="chk" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12"/><path d="M7.5 13.5l3.7 3.7 7.3-8.2"/></svg>
            </div>
            <div><div class="title"></div><div class="sub"></div></div>
            <button class="x" aria-label="Close">\u00d7</button>
          </div>
          <div class="bar"><i></i></div>
          <div class="row"><button class="b p" data-a="copy">Copy SVG</button><button class="b" data-a="dl">Download .svg</button></div>
          <div class="warn"></div>
        </div>`;
      card = root.querySelector('.card');
      ref = { title: root.querySelector('.title'), sub: root.querySelector('.sub'), bar: root.querySelector('.bar i'), warn: root.querySelector('.warn') };
      root.querySelector('.x').addEventListener('click', close);
      root.querySelector('[data-a="copy"]').addEventListener('click', async (e) => {
        const ok = state.last ? await copyText(state.last.svg) : false;
        e.target.textContent = ok ? 'Copied \u2713' : 'Copy failed';
      });
      root.querySelector('[data-a="dl"]').addEventListener('click', () => state.last && downloadSvg(state.last));
      document.documentElement.appendChild(host);
    }
    function close() { countTok++; if (host) { host.remove(); host = null; } }

    return {
      hide: close,
      progress(title, sub, pct) {
        ensure();
        card.classList.remove('done', 'err');
        ref.title.textContent = title;
        ref.sub.textContent = sub || '';
        ref.bar.style.width = Math.round((pct || 0) * 100) + '%';
      },
      done(o) {
        ensure();
        const tok = ++countTok;
        card.classList.remove('err');
        card.classList.add('done');
        ref.bar.style.width = '100%';
        ref.title.textContent = o.title;
        const st = o.stats;
        const text = (n) => `${n.toLocaleString()} layers \u00b7 ${st.images} image${st.images === 1 ? '' : 's'} \u00b7 ${fmtBytes(st.bytes)} \u00b7 ${st.width}\u00d7${st.height}` + (o.copied ? ' \u00b7 \u2318V / Ctrl+V' : '');
        ref.warn.textContent = o.warn || '';
        if (REDUCED()) { ref.sub.textContent = text(st.layers); return; }
        const t0 = performance.now(), dur = 800;
        (function f(now) {
          if (tok !== countTok) return;
          const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
          ref.sub.textContent = text(Math.round(e * st.layers));
          if (p < 1) requestAnimationFrame(f);
        })(t0);
      },
      error(msg) {
        ensure();
        card.classList.remove('done');
        card.classList.add('err');
        ref.title.textContent = 'Capture failed';
        ref.sub.textContent = msg;
      },
      // amber scan line sweeps the page and outlines the layers that were captured
      wire(rects) {
        if (REDUCED() || !rects || !rects.length) return;
        const H = window.innerHeight, W = window.innerWidth, DUR = 1300, sx = window.scrollX, sy = window.scrollY;
        const items = rects.map((r) => ({ x: r.x - sx, y: r.y - sy, w: r.w, h: r.h }))
          .filter((r) => r.w > 6 && r.h > 6 && r.x < W && r.y < H && r.x + r.w > 0 && r.y + r.h > 0)
          .sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 220);
        const ov = document.createElement('div');
        ov.setAttribute('data-w2f-ignore', '');
        ov.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;overflow:hidden';
        const root = ov.attachShadow({ mode: 'closed' });
        let html = `<style>
          .line{position:absolute;left:0;right:0;top:0;height:3px;background:#ffc233;box-shadow:0 0 18px 6px rgba(255,194,51,.55);animation:sweep ${DUR}ms cubic-bezier(.45,0,.55,1) both}
          .b{position:absolute;box-sizing:border-box;border:1.5px dashed #2f3bff;background:rgba(47,59,255,.05);opacity:0;animation:wire 1000ms ease both}
          @keyframes sweep{0%{transform:translateY(-6px);opacity:1}92%{opacity:1}100%{transform:translateY(${H}px);opacity:0}}
          @keyframes wire{0%{opacity:0}10%{opacity:1}72%{opacity:1}100%{opacity:0}}
        </style><div class="line"></div>`;
        for (const r of items) html += `<i class="b" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;animation-delay:${Math.round(Math.max(0, r.y) / H * DUR * 0.92)}ms"></i>`;
        root.innerHTML = html;
        document.documentElement.appendChild(ov);
        setTimeout(() => ov.remove(), DUR + 1200);
      },
    };
  })();

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('data-w2f-ignore', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.documentElement.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function downloadSvg(last) {
    const blob = new Blob([last.svg], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (last.fileName || 'capture') + '.svg';
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  const fmtBytes = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  /* ==================================================================== */
  /* element picker                                                        */
  /* ==================================================================== */
  function pickElement() {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.id = 'w2f-ui-host';
      host.setAttribute('data-w2f-ignore', '');
      host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        .hl{position:fixed;display:none;box-sizing:border-box;border:2px solid #2f3bff;background:rgba(47,59,255,.12);border-radius:2px}
        .tip{position:fixed;left:50%;top:12px;transform:translateX(-50%);font:12.5px/1.4 system-ui,sans-serif;background:#15171c;color:#fff;padding:7px 12px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.25);white-space:nowrap}
        .tip b{color:#aab1ff;font-weight:600}
      </style><div class="hl"></div><div class="tip">Click an element to capture \u00b7 <b>\u2191</b> parent \u00b7 <b>\u2193</b> child \u00b7 <b>Esc</b> cancel</div>`;
      const hl = root.querySelector('.hl'), tip = root.querySelector('.tip');
      const cur = document.createElement('style');
      cur.setAttribute('data-w2f-ignore', '');
      cur.textContent = '*{cursor:crosshair!important}';
      document.documentElement.append(cur, host);
      let el = null;
      const stack = [];
      const label = (e) => {
        const r = e.getBoundingClientRect();
        const cls = typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : '';
        return `${e.localName}${e.id ? '#' + e.id : cls} \u00b7 ${Math.round(r.width)}\u00d7${Math.round(r.height)}`;
      };
      const paint = () => {
        if (!el) { hl.style.display = 'none'; return; }
        const r = el.getBoundingClientRect();
        Object.assign(hl.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
        tip.textContent = label(el) + '   \u2191 parent \u00b7 \u2193 child \u00b7 Esc cancel';
      };
      const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
      let lastMouse = null, lock = null;
      const onMove = (e) => {
        lastMouse = { x: e.clientX, y: e.clientY };
        // after ↑/↓ keep the chosen element until the pointer really moves
        if (lock && Math.hypot(e.clientX - lock.x, e.clientY - lock.y) < 8) return;
        lock = null;
        const t = document.elementFromPoint(e.clientX, e.clientY);
        if (t && t !== host && t !== el) { el = t; stack.length = 0; paint(); }
      };
      const onClick = (e) => { stop(e); if (!el) el = document.elementFromPoint(e.clientX, e.clientY); finish(el); };
      const onKey = (e) => {
        if (e.key === 'Escape') { stop(e); finish(null); }
        else if (e.key === 'Enter') { stop(e); finish(el); }
        else if (e.key === 'ArrowUp') { stop(e); lock = lastMouse; if (el && el.parentElement && el.parentElement !== document.documentElement) { stack.push(el); el = el.parentElement; paint(); } }
        else if (e.key === 'ArrowDown') { stop(e); lock = lastMouse; if (stack.length) { el = stack.pop(); paint(); } }
      };
      const swallow = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'dblclick'];
      function finish(t) {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('keydown', onKey, true);
        swallow.forEach((k) => window.removeEventListener(k, stop, true));
        host.remove(); cur.remove();
        resolve(t);
      }
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('click', onClick, true);
      window.addEventListener('keydown', onKey, true);
      swallow.forEach((k) => window.addEventListener(k, stop, true));
    });
  }

  /* ==================================================================== */
  /* context + small helpers                                               */
  /* ==================================================================== */
  function makeCtx(opts) {
    const cv = document.createElement('canvas');
    return {
      opts, defs: [], out: [], jobs: [], uid: 0, names: new Map(), count: 0, warnings: [],
      measure: cv.getContext('2d'), fontOk: new Map(), fontPick: new Map(), metrics: new Map(),
      csCache: new WeakMap(), imgCache: new Map(), wire: [], stats: { groups: 0, texts: 0, images: 0 },
      view: null, canvasBox: null, bgEl: null, truncated: false, cull: null,
    };
  }
  const nid = (c, p) => p + (++c.uid);
  const csOf = (c, el) => {
    let v = c.csCache.get(el);
    if (!v) { v = c.view.win.getComputedStyle(el); c.csCache.set(el, v); }
    return v;
  };
  const rangeOf = (c) => c.view.range || (c.view.range = c.view.doc.createRange());

  function uniqueName(c, base) {
    base = L.sanitizeName(base);
    const k = (c.names.get(base) || 0) + 1;
    c.names.set(base, k);
    return k === 1 ? base : base + '_' + k;
  }
  function layerName(c, el) {
    let base;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    if (el.id) base = el.id;
    else if (cls) base = el.localName + '-' + cls;
    else if (el.localName === 'img' && el.alt) base = 'img-' + el.alt.slice(0, 24);
    else base = el.localName;
    return uniqueName(c, base);
  }

  const placeholder = (box, fill) => `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" fill="${fill || '#e5e7eb'}"/>`;
  const imageTag = (url, x, y, w, h) => `<image xlink:href="${url}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"/>`;

  /* ---- boxes ---- */
  function geom(cs, rect, view) {
    const f = (p) => parseFloat(cs[p]) || 0;
    const g = {
      x: rect.left + view.ox, y: rect.top + view.oy, w: rect.width, h: rect.height,
      bt: f('borderTopWidth'), br: f('borderRightWidth'), bb: f('borderBottomWidth'), bl: f('borderLeftWidth'),
      pt: f('paddingTop'), pr: f('paddingRight'), pb: f('paddingBottom'), pl: f('paddingLeft'),
    };
    g.r = L.radii(cs, g.w, g.h);
    return g;
  }
  function paddingBox(g) {
    return { x: g.x + g.bl, y: g.y + g.bt, w: Math.max(0, g.w - g.bl - g.br), h: Math.max(0, g.h - g.bt - g.bb), r: L.insetRadii(g.r, g.bt, g.br, g.bb, g.bl) };
  }
  function contentBox(g) {
    const p = paddingBox(g);
    return { x: p.x + g.pl, y: p.y + g.pt, w: Math.max(0, p.w - g.pl - g.pr), h: Math.max(0, p.h - g.pt - g.pb), r: L.insetRadii(p.r, g.pt, g.pr, g.pb, g.pl) };
  }
  const boxByKind = (g, kind) => kind === 'content-box' ? contentBox(g) : kind === 'padding-box' ? paddingBox(g) : { x: g.x, y: g.y, w: g.w, h: g.h, r: g.r };

  /* ==================================================================== */
  /* page preparation                                                      */
  /* ==================================================================== */
  function prepareDocument(c, cleanups, root) {
    const style = document.createElement('style');
    style.setAttribute('data-w2f-ignore', '');
    style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}[data-w2f-pb]::before{content:none!important}[data-w2f-pa]::after{content:none!important}';
    document.documentElement.appendChild(style);
    cleanups.push(() => style.remove());
    materializePseudos(c, cleanups, root);
  }

  // ::before / ::after have no geometry API, so swap them for real <span>s with the same computed style.
  function materializePseudos(c, cleanups, root) {
    const list = [root].concat(Array.from(root.querySelectorAll('*')));
    for (const el of list) {
      if (el.namespaceURI !== XHTML) continue;
      const tag = el.localName;
      if (NO_PSEUDO.has(tag) || SKIP.has(tag)) continue;
      for (const which of ['before', 'after']) {
        let pcs;
        try { pcs = getComputedStyle(el, '::' + which); } catch (e) { continue; }
        const content = pcs.content;
        if (!content || content === 'none' || content === 'normal' || pcs.display === 'none') continue;
        const parsed = L.parseContent(content, (name) => el.getAttribute(name));
        const span = document.createElement('span');
        span.setAttribute('data-w2f-pseudo', which);
        for (let i = 0; i < pcs.length; i++) {
          const p = pcs[i];
          if (p === 'content') continue;
          try { span.style.setProperty(p, pcs.getPropertyValue(p), pcs.getPropertyPriority(p)); } catch (e) { /* ignore */ }
        }
        if (parsed.text) span.textContent = parsed.text;
        if (parsed.url) {
          const im = document.createElement('img');
          im.src = parsed.url;
          span.appendChild(im);
        }
        if (which === 'before') el.insertBefore(span, el.firstChild); else el.appendChild(span);
        el.setAttribute(which === 'before' ? 'data-w2f-pb' : 'data-w2f-pa', '');
        cleanups.push(() => { span.remove(); el.removeAttribute(which === 'before' ? 'data-w2f-pb' : 'data-w2f-pa'); });
      }
    }
  }

  // two animation frames (lets IntersectionObserver / lazy loaders fire), but never hang in a throttled tab
  const nextFrames = () => Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 6)))),
    sleep(60),
  ]);

  async function autoScroll() {
    const doc = document.scrollingElement || document.documentElement;
    const vh = window.innerHeight;
    if (doc.scrollHeight <= vh * 1.3) return; // nothing below the fold
    const step = Math.max(300, vh - 40);
    const t0 = performance.now();
    let y = 0, guard = 0;
    while (guard++ < 150 && performance.now() - t0 < 3500) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await nextFrames();
      const max = doc.scrollHeight - vh;
      if (y >= max) break;
      y = Math.min(y + step, max);
    }
    await sleep(60);
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await nextFrames();
  }

  async function settle(timeout) {
    try { await Promise.race([document.fonts.ready, sleep(timeout)]); } catch (e) { /* ignore */ }
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const pending = Array.from(document.images).filter((im) => !im.complete && (im.currentSrc || im.src));
      if (!pending.length) break;
      await sleep(100);
    }
  }

  /* ==================================================================== */
  /* transforms                                                            */
  /* ==================================================================== */
  function neutralizeTransform(el, cs) {
    const hasT = cs.transform && cs.transform !== 'none';
    const hasTr = cs.translate && cs.translate !== 'none';
    const hasR = cs.rotate && cs.rotate !== 'none';
    const hasS = cs.scale && cs.scale !== 'none';
    if (!(hasT || hasTr || hasR || hasS)) return null;
    let m = new DOMMatrix();
    try {
      if (hasTr) { const t = cs.translate.split(' '); m = m.translate(parseFloat(t[0]) || 0, parseFloat(t[1]) || 0); }
      if (hasR) { const t = cs.rotate.split(' '); m = m.rotate(L.parseAngle(t[t.length - 1]) || 0); }
      if (hasS) { const t = cs.scale.split(' ').map(parseFloat); m = m.scale(t[0], isNaN(t[1]) ? t[0] : t[1]); }
      if (hasT) m = m.multiply(new DOMMatrix(cs.transform));
    } catch (e) { return null; }
    const o = cs.transformOrigin.split(' ').map(parseFloat);
    const style = el.style;
    const props = ['transform', 'translate', 'rotate', 'scale'];
    const saved = props.map((p) => [p, style.getPropertyValue(p), style.getPropertyPriority(p)]);
    props.forEach((p) => style.setProperty(p, 'none', 'important'));
    return {
      m, ox: o[0] || 0, oy: o[1] || 0,
      restore() { saved.forEach(([p, v, pr]) => { if (v) style.setProperty(p, v, pr); else style.removeProperty(p); }); },
    };
  }

  /* ==================================================================== */
  /* walker                                                                */
  /* ==================================================================== */
  function childNodesOf(el) {
    if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
    if (el.localName === 'slot') { const a = el.assignedNodes({ flatten: true }); if (a.length) return a; }
    return Array.from(el.childNodes);
  }

  const stackingish = (cs) => parseFloat(cs.opacity) < 1 || (cs.transform && cs.transform !== 'none') || (cs.filter && cs.filter !== 'none') ||
    (cs.mixBlendMode && cs.mixBlendMode !== 'normal') || cs.isolation === 'isolate' || (cs.clipPath && cs.clipPath !== 'none') ||
    /transform|opacity/.test(cs.willChange || '');

  // Approximation of CSS paint order within one parent.
  function paintOrder(c, nodes, parent) {
    let needSort = false;
    const pcs = parent ? csOf(c, parent) : null;
    const flexParent = pcs && /flex|grid/.test(pcs.display);
    const items = nodes.map((nd, i) => {
      let layer = 1, z = 0;
      if (nd.nodeType === 1 && !SKIP.has(nd.localName)) {
        const cs = csOf(c, nd);
        const zi = cs.zIndex === 'auto' ? null : parseInt(cs.zIndex, 10);
        if (zi !== null && !isNaN(zi) && (cs.position !== 'static' || flexParent)) { z = zi; layer = zi < 0 ? 0 : zi === 0 ? 2 : 3; }
        else if (cs.position !== 'static' || stackingish(cs)) layer = 2;
        if (layer !== 1) needSort = true;
      }
      return { nd, i, layer, z };
    });
    if (!needSort) return nodes;
    items.sort((a, b) => a.layer - b.layer || a.z - b.z || a.i - b.i);
    return items.map((x) => x.nd);
  }

  function paintChildren(el, c, inh) {
    const nodes = paintOrder(c, childNodesOf(el), el);
    for (const nd of nodes) {
      if (c.truncated) return;
      if (nd.nodeType === 1) paintSafe(nd, c, inh);
      else if (nd.nodeType === 3) {
        const mark = c.out.length, jm = c.jobs.length;
        try { paintTextNode(nd, el, c, inh); } catch (e) { c.out.length = mark; c.jobs.length = jm; c.warnings.push('text: ' + e.message); }
      }
    }
  }

  // Errors in one element must not poison the rest: roll back its partial output.
  function paintSafe(el, c, inh) {
    const mark = c.out.length, jm = c.jobs.length;
    try { paintElement(el, c, inh); } catch (e) {
      c.out.length = mark; c.jobs.length = jm;
      c.warnings.push(`<${el.localName}>: ${e.message}`);
      if (c.warnings.length < 4) console.warn('[web-to-figma]', el, e);
    }
  }

  function paintElement(el, c, inh) {
    const tag = el.localName;
    if (SKIP.has(tag) || el.id === 'w2f-ui-host' || (el.hasAttribute && el.hasAttribute('data-w2f-ignore'))) return;
    if (el.namespaceURI !== XHTML && !(tag === 'svg' && el.namespaceURI === SVGNS)) return;
    const cs = csOf(c, el);
    if (cs.display === 'none') return;
    if (cs.display === 'contents') { paintChildren(el, c, inh); return; }
    if (++c.count > c.opts.maxNodes) {
      if (!c.truncated) c.warnings.push(`Stopped after ${c.opts.maxNodes} elements (limit).`);
      c.truncated = true;
      return;
    }
    const opacity = parseFloat(cs.opacity);
    if (opacity === 0 && !c.opts.includeHidden) return;
    if (cs.position === 'fixed' && !c.opts.includeFixed) return;
    const tf = neutralizeTransform(el, cs);
    try { paintElementInner(el, cs, c, inh, isNaN(opacity) ? 1 : opacity, tf); } finally { if (tf) tf.restore(); }
  }

  function paintElementInner(el, cs, c, inh, opacity, tf) {
    const view = c.view, tag = el.localName;
    const rect = el.getBoundingClientRect();
    const g = geom(cs, rect, view);
    const isInline = cs.display === 'inline' && !REPLACED.has(tag);
    const visible = cs.visibility === 'visible';

    const overflowClip = tag !== 'html' && tag !== 'body' && !REPLACED.has(tag) && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible');
    // cheap cull: clipped subtrees entirely outside the capture area
    if (c.cull && overflowClip && (g.x > c.cull.x + c.cull.w || g.y > c.cull.y + c.cull.h || g.x + g.w < c.cull.x || g.y + g.h < c.cull.y)) return;

    const bgc = L.parseColor(cs.backgroundColor);
    const hasBgColor = !!bgc && bgc.a > 0;
    const hasBgImg = cs.backgroundImage !== 'none';
    const skipBg = el === c.bgEl;
    const shadows = L.parseShadows(cs.boxShadow, L.parseColor);
    const bi = readBorder(cs);
    const ow = parseFloat(cs.outlineWidth) || 0;
    const outlineCol = L.parseColor(cs.outlineColor);
    const hasOutline = ow > 0 && cs.outlineStyle !== 'none' && !!outlineCol && outlineCol.a > 0;
    const hasPaint = visible && ((!skipBg && (hasBgColor || hasBgImg)) || bi.any || shadows.length > 0 || hasOutline);

    const filterStr = cs.filter, blend = cs.mixBlendMode, clipCss = cs.clipPath;
    const hasFilter = !!filterStr && filterStr !== 'none';
    const hasBlend = !!blend && blend !== 'normal';
    const hasClipCss = !!clipCss && clipCss !== 'none';
    const hasEffects = opacity < 1 || hasFilter || hasBlend || hasClipCss || !!tf;

    const useGroup = hasEffects || hasPaint || c.opts.structure === 'full' || !!el.id || SEMANTIC.has(tag) || REPLACED.has(tag) || tag === 'html' || tag === 'body';
    const gbox = { x: g.x, y: g.y, w: g.w, h: g.h };

    if (c.wire && view.win === window && visible && g.w > 6 && g.h > 6 && (hasPaint || REPLACED.has(tag))) c.wire.push({ x: g.x, y: g.y, w: g.w, h: g.h });

    if (useGroup) {
      let attrs = ` id="${layerName(c, el)}"`;
      if (opacity < 1) attrs += ` opacity="${n(opacity)}"`;
      if (tf) {
        const ax = g.x + tf.ox, ay = g.y + tf.oy, m = tf.m;
        const v = [m.a, m.b, m.c, m.d, m.e, m.f].map((q) => +q.toFixed(6)).join(' ');
        attrs += ` transform="translate(${n(ax)} ${n(ay)}) matrix(${v}) translate(${n(-ax)} ${n(-ay)})"`;
      }
      if (hasFilter) {
        const f = L.filterChain(filterStr, nid(c, '__f'), gbox, L.parseColor);
        if (f) { c.defs.push(f.def); attrs += ` filter="${f.ref}"`; }
      }
      if (hasClipCss) {
        const cp = L.cssClipPath(clipCss, gbox, nid(c, '__cp'));
        if (cp) { c.defs.push(cp.def); attrs += ` clip-path="${cp.ref}"`; }
      }
      if (hasBlend) attrs += ` style="mix-blend-mode:${blend}"`;
      c.out.push(`<g${attrs}>`);
      c.stats.groups++;
    }
    const mark = c.out.length;

    // ---- own box visuals
    let inh2 = inh;
    if (visible && ((g.w > 0 && g.h > 0) || isInline)) {
      const st = { skipBg, shadows, bgc, bi };
      if (isInline) {
        const frags = Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        if (hasBgImg && (/text/.test(cs.backgroundClip) || cs.webkitBackgroundClip === 'text')) {
          // gradient text on an inline element: the gradient spans the element's union box
          const tfill = paintBackground(cs, g, c);
          if (tfill) inh2 = Object.assign({}, inh, { textFill: tfill });
        } else if (hasPaint) for (const fr of frags) paintBox(cs, geom(cs, fr, view), c, st);
      } else if (hasPaint) {
        const tfill = paintBox(cs, g, c, st);
        if (tfill) inh2 = Object.assign({}, inh, { textFill: tfill });
      }
    }

    // ---- content (children / replaced content), optionally clipped by overflow
    let clipOpen = false, cmark = 0;
    if (overflowClip && g.w > 0 && g.h > 0) {
      const pb = paddingBox(g);
      const cid = nid(c, '__clip');
      c.defs.push(`<clipPath id="${cid}">${L.shape(pb.x, pb.y, pb.w, pb.h, pb.r)}</clipPath>`);
      c.out.push(`<g clip-path="url(#${cid})">`);
      clipOpen = true; cmark = c.out.length;
      if (cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap' && el.scrollWidth > el.clientWidth + 1) {
        const cb = contentBox(g);
        inh2 = Object.assign({}, inh2, { ellipsis: { right: cb.x + cb.w } });
      }
    }
    if (visible || !REPLACED.has(tag)) paintContent(el, cs, g, c, inh2, visible);
    if (clipOpen) { if (c.out.length === cmark) c.out.pop(); else c.out.push('</g>'); }

    if (visible && hasOutline && g.w > 0) paintOutline(cs, g, c, ow, outlineCol);

    if (useGroup) { if (c.out.length === mark) c.out.pop(); else c.out.push('</g>'); }
  }

  function paintContent(el, cs, g, c, inh, visible) {
    switch (el.localName) {
      case 'img': if (visible) paintImg(el, cs, g, c); return;
      case 'video': if (visible) paintVideo(el, cs, g, c); return;
      case 'canvas': if (visible) paintCanvas(el, cs, g, c); return;
      case 'iframe': if (visible) paintIframe(el, cs, g, c, inh); return;
      case 'svg': if (visible) paintInlineSvg(el, cs, g, c); return;
      case 'input': case 'textarea': case 'select': if (visible) paintControl(el, cs, g, c); return;
      case 'object': case 'embed': case 'audio': return;
      default:
        if (visible && cs.display === 'list-item') paintMarker(el, cs, c);
        paintChildren(el, c, inh);
    }
  }

  /* ==================================================================== */
  /* box painting: shadows, backgrounds, borders, outline                  */
  /* ==================================================================== */
  function readBorder(cs) {
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((s) => ({
      w: parseFloat(cs['border' + s + 'Width']) || 0,
      st: cs['border' + s + 'Style'],
      col: L.parseColor(cs['border' + s + 'Color']),
    }));
    sides.forEach((s) => { s.vis = s.w > 0 && s.st !== 'none' && s.st !== 'hidden' && !!s.col && s.col.a > 0; });
    return { sides, any: sides.some((s) => s.vis) };
  }

  function paintBox(cs, g, c, st) {
    const opaque = st.bgc && st.bgc.a >= 0.99;
    for (let i = st.shadows.length - 1; i >= 0; i--) if (!st.shadows[i].inset) outerShadow(c, g, st.shadows[i], !opaque);
    let textFill = null;
    if (!st.skipBg) textFill = paintBackground(cs, g, c);
    for (let i = st.shadows.length - 1; i >= 0; i--) if (st.shadows[i].inset) innerShadow(c, g, st.shadows[i]);
    if (st.bi.any) paintBorder(g, c, st.bi);
    return textFill;
  }

  function blurFilter(c, sigma, x, y, w, h) {
    const fid = nid(c, '__blur');
    const m = Math.ceil(sigma * 3) + 2;
    c.defs.push(`<filter id="${fid}" filterUnits="userSpaceOnUse" x="${n(x - m)}" y="${n(y - m)}" width="${n(w + 2 * m)}" height="${n(h + 2 * m)}" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${n(sigma)}"/></filter>`);
    return fid;
  }

  function outerShadow(c, g, s, needHole) {
    if (s.color.a <= 0) return;
    const sp = s.spread;
    const sx = g.x + s.x - sp, sy = g.y + s.y - sp, sw = g.w + 2 * sp, sh = g.h + 2 * sp;
    if (sw <= 0 || sh <= 0) return;
    const sigma = s.blur / 2;
    let attrs = L.paint(s.color, 'fill');
    if (sigma > 0) attrs += ` filter="url(#${blurFilter(c, sigma, sx, sy, sw, sh)})"`;
    let shape = L.shape(sx, sy, sw, sh, L.growRadii(g.r, sp), attrs);
    if (needHole) {
      const m = Math.ceil(sigma * 3) + 4;
      const d = `M${n(sx - m)} ${n(sy - m)}H${n(sx + sw + m)}V${n(sy + sh + m)}H${n(sx - m)}Z ${L.rrPath(g.x, g.y, g.w, g.h, g.r)}`;
      const cid = nid(c, '__hole');
      c.defs.push(`<clipPath id="${cid}"><path d="${d}" clip-rule="evenodd"/></clipPath>`);
      shape = `<g clip-path="url(#${cid})">${shape}</g>`;
    }
    c.out.push(shape);
  }

  function innerShadow(c, g, s) {
    if (s.color.a <= 0) return;
    const pb = paddingBox(g);
    if (pb.w <= 0 || pb.h <= 0) return;
    const sigma = s.blur / 2;
    const m = Math.ceil(sigma * 3 + Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.spread) + 4);
    const ox = pb.x - m, oy = pb.y - m, ow = pb.w + 2 * m, oh = pb.h + 2 * m;
    let d = `M${n(ox)} ${n(oy)}H${n(ox + ow)}V${n(oy + oh)}H${n(ox)}Z`;
    if (pb.w - 2 * s.spread > 0 && pb.h - 2 * s.spread > 0) {
      d += ' ' + L.rrPath(pb.x + s.x + s.spread, pb.y + s.y + s.spread, pb.w - 2 * s.spread, pb.h - 2 * s.spread, L.growRadii(pb.r, -s.spread));
    }
    const cid = nid(c, '__ins');
    c.defs.push(`<clipPath id="${cid}">${L.shape(pb.x, pb.y, pb.w, pb.h, pb.r)}</clipPath>`);
    let attrs = `fill-rule="evenodd"${L.paint(s.color, 'fill')}`;
    if (sigma > 0) attrs += ` filter="url(#${blurFilter(c, sigma, ox, oy, ow, oh)})"`;
    c.out.push(`<g clip-path="url(#${cid})"><path d="${d}" ${attrs}/></g>`);
  }

  function paintBorder(g, c, bi) {
    const [T, R, B, Lf] = bi.sides;
    const uniform = bi.sides.every((s) => s.vis && s.w === T.w && s.st === T.st && L.sameColor(s.col, T.col));
    if (uniform) {
      const bw = T.w;
      const strokes = [];
      if (T.st === 'double' && bw >= 3) {
        const t = bw / 3;
        strokes.push([t / 2, t], [bw - t / 2, t]);
      } else strokes.push([bw / 2, bw]);
      for (const [inset, sw] of strokes) {
        let dash = '';
        if (T.st === 'dashed') dash = ` stroke-dasharray="${n(sw * 2)} ${n(sw)}"`;
        else if (T.st === 'dotted') dash = ` stroke-dasharray="0 ${n(sw * 2)}" stroke-linecap="round"`;
        const r = L.insetRadii(g.r, inset, inset, inset, inset);
        c.out.push(L.shape(g.x + inset, g.y + inset, g.w - 2 * inset, g.h - 2 * inset, r, `fill="none"${L.paint(T.col, 'stroke')} stroke-width="${n(sw)}"${dash}`));
      }
      return;
    }
    // mixed widths / colours: ring path, optionally split into per-side trapezoids
    const ix = g.x + Lf.w, iy = g.y + T.w, iw = g.w - Lf.w - R.w, ih = g.h - T.w - B.w;
    let d = L.rrPath(g.x, g.y, g.w, g.h, g.r);
    if (iw > 0 && ih > 0) d += ' ' + L.rrPath(ix, iy, iw, ih, L.insetRadii(g.r, T.w, R.w, B.w, Lf.w));
    const active = bi.sides.filter((s) => s.w > 0);
    const allSame = active.every((s) => s.vis && L.sameColor(s.col, active[0].col));
    if (allSame) { c.out.push(`<path d="${d}" fill-rule="evenodd"${L.paint(active[0].col, 'fill')}/>`); return; }
    const cid = nid(c, '__bd');
    c.defs.push(`<clipPath id="${cid}"><path d="${d}" clip-rule="evenodd"/></clipPath>`);
    const x2 = g.x + g.w, y2 = g.y + g.h;
    const polys = [
      [T, `${n(g.x)},${n(g.y)} ${n(x2)},${n(g.y)} ${n(x2 - R.w)},${n(g.y + T.w)} ${n(g.x + Lf.w)},${n(g.y + T.w)}`],
      [R, `${n(x2)},${n(g.y)} ${n(x2)},${n(y2)} ${n(x2 - R.w)},${n(y2 - B.w)} ${n(x2 - R.w)},${n(g.y + T.w)}`],
      [B, `${n(x2)},${n(y2)} ${n(g.x)},${n(y2)} ${n(g.x + Lf.w)},${n(y2 - B.w)} ${n(x2 - R.w)},${n(y2 - B.w)}`],
      [Lf, `${n(g.x)},${n(y2)} ${n(g.x)},${n(g.y)} ${n(g.x + Lf.w)},${n(g.y + T.w)} ${n(g.x + Lf.w)},${n(y2 - B.w)}`],
    ];
    let body = '';
    for (const [s, pts] of polys) if (s.vis) body += `<polygon points="${pts}"${L.paint(s.col, 'fill')}/>`;
    c.out.push(`<g clip-path="url(#${cid})">${body}</g>`);
  }

  function paintOutline(cs, g, c, ow, col) {
    const off = parseFloat(cs.outlineOffset) || 0;
    const d = off + ow / 2;
    c.out.push(L.shape(g.x - d, g.y - d, g.w + 2 * d, g.h + 2 * d, L.growRadii(g.r, d), `fill="none"${L.paint(col, 'stroke')} stroke-width="${n(ow)}"`));
  }

  /* ---- backgrounds ---- */
  function parseRepeat(str) {
    const rep = String(str || 'repeat').trim().split(/\s+/);
    if (rep.length === 1) {
      const k = rep[0];
      const both = k === 'repeat' || k === 'space' || k === 'round';
      return [both || k === 'repeat-x', both || k === 'repeat-y'];
    }
    return [rep[0] !== 'no-repeat', rep[1] !== 'no-repeat'];
  }

  // Paint one background layer, tiled if needed.
  function tiled(c, clipB, origin, tile, pos, repStr, contentFn) {
    const [rx, ry] = parseRepeat(repStr);
    const tx = origin.x + pos.x, ty = origin.y + pos.y;
    const radius = clipB.r.some((r) => r.x > 0 && r.y > 0);
    const mkClip = () => {
      const cid = nid(c, '__bgclip');
      c.defs.push(`<clipPath id="${cid}">${L.shape(clipB.x, clipB.y, clipB.w, clipB.h, clipB.r)}</clipPath>`);
      return ` clip-path="url(#${cid})"`;
    };
    if (!rx && !ry) {
      const body = contentFn(tx, ty);
      if (!body) return '';
      const inside = tx >= clipB.x - 0.5 && ty >= clipB.y - 0.5 && tx + tile.w <= clipB.x + clipB.w + 0.5 && ty + tile.h <= clipB.y + clipB.h + 0.5;
      return inside && !radius ? body : `<g${mkClip()}>${body}</g>`;
    }
    if (tile.w < 0.5 || tile.h < 0.5) return '';
    const inner = contentFn(0, 0);
    if (!inner) return '';
    const pid = nid(c, '__pat');
    c.defs.push(`<pattern id="${pid}" patternUnits="userSpaceOnUse" x="${n(tx)}" y="${n(ty)}" width="${n(tile.w)}" height="${n(tile.h)}">${inner}</pattern>`);
    let x0 = clipB.x, y0 = clipB.y, x1 = clipB.x + clipB.w, y1 = clipB.y + clipB.h;
    if (!rx) { x0 = Math.max(x0, tx); x1 = Math.min(x1, tx + tile.w); }
    if (!ry) { y0 = Math.max(y0, ty); y1 = Math.min(y1, ty + tile.h); }
    if (x1 <= x0 || y1 <= y0) return '';
    return `<rect x="${n(x0)}" y="${n(y0)}" width="${n(x1 - x0)}" height="${n(y1 - y0)}" fill="url(#${pid})"${radius ? mkClip() : ''}/>`;
  }

  function conicDataUrl(cg, w, h) {
    const sc = Math.min(1, 1024 / Math.max(w, h));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * sc)); cv.height = Math.max(1, Math.round(h * sc));
    const ctx = cv.getContext('2d');
    if (!ctx.createConicGradient) return null;
    const gr = ctx.createConicGradient((cg.from - 90) * Math.PI / 180, cg.at.x * sc, cg.at.y * sc);
    for (const s of cg.stops) gr.addColorStop(Math.max(0, Math.min(1, s.pos)), `rgba(${Math.round(s.c.r)},${Math.round(s.c.g)},${Math.round(s.c.b)},${s.c.a})`);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, cv.width, cv.height);
    return cv.toDataURL('image/png');
  }

  function paintBackground(cs, g, c) {
    const bgc = L.parseColor(cs.backgroundColor);
    const imgStr = cs.backgroundImage;
    const layers = imgStr && imgStr !== 'none' ? L.splitTop(imgStr, ',') : [];
    const clipList = L.splitTop(cs.backgroundClip || 'border-box', ',');
    const pick = (list, i) => { const a = L.splitTop(list || '', ','); return a.length ? a[i % a.length] : ''; };

    // background-clip:text -> hand the paint to the text instead
    if (clipList.includes('text') || cs.webkitBackgroundClip === 'text') {
      for (const layer of layers) {
        const k = L.gradientKind(layer);
        if (k === 'linear' || k === 'radial') {
          const gr = (k === 'linear' ? L.linearGradient : L.radialGradient)(layer, { x: g.x, y: g.y, w: g.w, h: g.h }, nid(c, '__g'), L.parseColor);
          if (gr) { c.defs.push(gr.def); return gr.ref; }
        }
      }
      return bgc && bgc.a > 0 ? L.hex(bgc) : null;
    }

    if (bgc && bgc.a > 0) {
      const lastClip = clipList[(Math.max(layers.length, 1) - 1) % clipList.length];
      const cb = boxByKind(g, lastClip);
      if (cb.w > 0 && cb.h > 0) c.out.push(L.shape(cb.x, cb.y, cb.w, cb.h, cb.r, L.paint(bgc, 'fill')));
    }

    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      const kind = L.gradientKind(layer);
      if (!kind) continue;
      const origin = boxByKind(g, pick(cs.backgroundOrigin || 'padding-box', i));
      const clipB = boxByKind(g, pick(cs.backgroundClip || 'border-box', i));
      if (clipB.w <= 0 || clipB.h <= 0 || origin.w <= 0 || origin.h <= 0) continue;
      const sizeStr = pick(cs.backgroundSize, i), posStr = pick(cs.backgroundPosition, i), repStr = pick(cs.backgroundRepeat, i);

      if (kind === 'url') {
        if (!c.opts.embedImages) continue;
        const m = layer.match(/^url\(\s*(["']?)([\s\S]*?)\1\s*\)$/i);
        if (!m) continue;
        let url;
        try { url = new URL(m[2], c.view.doc.baseURI).href; } catch (e) { continue; }
        const slot = { s: '' };
        c.out.push(slot);
        c.jobs.push({
          slot, label: 'background',
          run: async () => {
            const data = await getImage(c, { url, wantW: Math.max(origin.w, 1) * c.opts.imageScale });
            const nat = data.svgText ? (svgNatural(data.svgText) || { w: 0, h: 0 }) : { w: data.w, h: data.h };
            const tile = L.bgSize(sizeStr, origin.w, origin.h, nat.w, nat.h);
            const pos = L.bgPos(posStr, origin.w, origin.h, tile.w, tile.h);
            const build = (bx, by) => data.svgText ? svgTextToGroup(c, data.svgText, bx, by, tile.w, tile.h) : imageTag(data.url, bx, by, tile.w, tile.h);
            c.stats.images++;
            return tiled(c, clipB, origin, tile, pos, repStr, build);
          },
          fallback: () => '',
        });
        continue;
      }

      const tile = L.bgSize(sizeStr, origin.w, origin.h, 0, 0);
      const pos = L.bgPos(posStr, origin.w, origin.h, tile.w, tile.h);
      let build;
      if (kind === 'conic') {
        const cg = L.parseConic(layer, { w: tile.w, h: tile.h }, L.parseColor);
        if (!cg) continue;
        const url = conicDataUrl(cg, tile.w, tile.h);
        if (!url) continue;
        build = (bx, by) => imageTag(url, bx, by, tile.w, tile.h);
      } else {
        build = (bx, by) => {
          const gr = (kind === 'linear' ? L.linearGradient : L.radialGradient)(layer, { x: bx, y: by, w: tile.w, h: tile.h }, nid(c, '__g'), L.parseColor);
          if (!gr) return '';
          c.defs.push(gr.def);
          return `<rect x="${n(bx)}" y="${n(by)}" width="${n(tile.w)}" height="${n(tile.h)}" fill="${gr.ref}"/>`;
        };
      }
      c.out.push(tiled(c, clipB, origin, tile, pos, repStr, build));
    }
    return null;
  }

  /* ==================================================================== */
  /* text                                                                  */
  /* ==================================================================== */
  function fontAvailable(c, name) {
    const key = name.toLowerCase();
    if (c.fontOk.has(key)) return c.fontOk.get(key);
    const ctx = c.measure, sample = 'mmmmmmmmmmlliWWW@@ 0123';
    let ok = false;
    for (const base of ['monospace', 'serif', 'sans-serif']) {
      ctx.font = `64px ${base}`;
      const w0 = ctx.measureText(sample).width;
      ctx.font = `64px "${name.replace(/"/g, '')}", ${base}`;
      if (Math.abs(ctx.measureText(sample).width - w0) > 0.01) { ok = true; break; }
    }
    c.fontOk.set(key, ok);
    return ok;
  }

  // First family in the CSS stack that actually exists; generic families map to sensible Figma-friendly names.
  function pickFont(c, stack) {
    if (c.fontPick.has(stack)) return c.fontPick.get(stack);
    const SANS = new Set(['sans-serif', 'system-ui', 'ui-sans-serif', '-apple-system', 'blinkmacsystemfont', 'ui-rounded', 'cursive', 'fantasy', 'emoji', 'math']);
    let chosen = null;
    for (const raw of L.splitTop(stack, ',')) {
      const f = raw.replace(/^["']|["']$/g, '').trim();
      const lf = f.toLowerCase();
      if (SANS.has(lf)) { chosen = c.opts.fallbackSans; break; }
      if (lf === 'serif' || lf === 'ui-serif') { chosen = 'Georgia'; break; }
      if (lf === 'monospace' || lf === 'ui-monospace') { chosen = 'Roboto Mono'; break; }
      if (fontAvailable(c, f)) { chosen = f; break; }
    }
    chosen = chosen || c.opts.fallbackSans;
    c.fontPick.set(stack, chosen);
    return chosen;
  }

  function setFont(c, cs) { c.measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; }
  function fontMetrics(c, cs) {
    setFont(c, cs);
    const key = `${cs.fontStyle}|${cs.fontWeight}|${cs.fontSize}|${cs.fontFamily}`;
    let m = c.metrics.get(key);
    if (m) return m;
    const tm = c.measure.measureText('Hg');
    const size = parseFloat(cs.fontSize) || 16;
    m = {
      asc: tm.fontBoundingBoxAscent != null ? tm.fontBoundingBoxAscent : size * 0.93,
      desc: tm.fontBoundingBoxDescent != null ? tm.fontBoundingBoxDescent : size * 0.25,
    };
    c.metrics.set(key, m);
    return m;
  }

  function textStyle(c, cs) {
    const size = parseFloat(cs.fontSize) || 16;
    let a = ` font-family="${esc(pickFont(c, cs.fontFamily))}" font-size="${n(size)}" font-weight="${esc(cs.fontWeight)}"`;
    if (/italic|oblique/.test(cs.fontStyle)) a += ' font-style="italic"';
    const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0;
    if (ls) a += ` letter-spacing="${n(ls)}"`;
    const wsp = cs.wordSpacing === 'normal' ? 0 : parseFloat(cs.wordSpacing) || 0;
    if (wsp) a += ` word-spacing="${n(wsp)}"`;
    return a;
  }

  function textFillAttrs(cs, inh) {
    if (inh && inh.textFill) return ` fill="${inh.textFill}"`;
    const raw = cs.webkitTextFillColor && cs.webkitTextFillColor !== '' ? cs.webkitTextFillColor : cs.color;
    const col = L.parseColor(raw);
    if (!col || col.a <= 0) return null;
    return L.paint(col, 'fill');
  }

  function textDeco(c, el) {
    let e = el, depth = 0;
    while (e && depth++ < 12) {
      const line = csOf(c, e).textDecorationLine;
      if (line && line !== 'none') return line.replace(/\s*(spelling-error|grammar-error)/g, '').trim();
      if (e === c.view.doc.body) break;
      e = e.parentElement;
    }
    return '';
  }

  function applyTransform(tt, ch, prev) {
    if (tt === 'uppercase') return ch.toUpperCase();
    if (tt === 'lowercase') return ch.toLowerCase();
    if (tt === 'capitalize') return (prev === '' || /[\s\-\u2013\u2014(\["\u201C/]/.test(prev)) ? ch.toUpperCase() : ch;
    return ch;
  }

  function emitText(c, cs, inh, text, x, y, o) {
    const fill = textFillAttrs(cs, inh);
    if (fill === null) return;
    const base = textStyle(c, cs);
    const id = uniqueName(c, text.slice(0, 28));
    let extra = '';
    if (o.anchor && o.anchor !== 'start') extra += ` text-anchor="${o.anchor}"`;
    if (o.deco) extra += ` text-decoration="${esc(o.deco)}"`;
    if (o.preserve) extra += ' xml:space="preserve"';
    const sw = parseFloat(cs.webkitTextStrokeWidth) || 0;
    let stroke = '';
    if (sw > 0) { const sc = L.parseColor(cs.webkitTextStrokeColor); if (sc && sc.a > 0) stroke = `${L.paint(sc, 'stroke')} stroke-width="${n(sw)}"`; }
    let shadowStr = '';
    const shadows = L.parseShadows(cs.textShadow, L.parseColor);
    for (let i = shadows.length - 1; i >= 0; i--) {
      const s = shadows[i];
      if (s.color.a <= 0) continue;
      let f = '';
      if (s.blur > 0) {
        const fid = nid(c, '__ts');
        c.defs.push(`<filter id="${fid}" x="-30%" y="-60%" width="160%" height="220%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${n(s.blur / 2)}"/></filter>`);
        f = ` filter="url(#${fid})"`;
      }
      shadowStr += `<text id="${id}-shadow${i || ''}" x="${n(x + s.x)}" y="${n(y + s.y)}"${base}${L.paint(s.color, 'fill')}${extra}${f}>${escText(text)}</text>`;
    }
    c.stats.texts++;
    c.out.push(`${shadowStr}<text id="${id}" x="${n(x)}" y="${n(y)}"${base}${fill}${extra}${stroke}>${escText(text)}</text>`);
  }

  function paintTextNode(node, parentEl, c, inh) {
    const raw = node.nodeValue;
    if (!raw) return;
    const cs = csOf(c, parentEl);
    if (cs.visibility !== 'visible') return;
    const ws = cs.whiteSpace;
    const preserve = ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces';
    if (!preserve && !/\S/.test(raw)) return;
    if (textFillAttrs(cs, inh) === null) return;
    const view = c.view, rng = rangeOf(c), tt = cs.textTransform;

    const lines = [];
    let cur = null;
    for (let i = 0; i < raw.length;) {
      const cp = raw.codePointAt(i), step = cp > 0xffff ? 2 : 1;
      const ch = raw.slice(i, i + step);
      const prev = i > 0 ? raw[i - 1] : '';
      i += step;
      if (ch === '\n' || ch === '\r') continue;
      rng.setStart(node, i - step); rng.setEnd(node, i);
      const rs = rng.getClientRects();
      if (!rs.length) continue;
      const r = rs[0];
      if (r.height === 0 && r.width === 0) continue;
      const isWs = /\s/.test(ch);
      if (isWs && !preserve && r.width < 0.01) continue;
      let out = isWs && !preserve ? ' ' : ch;
      if (tt !== 'none') out = applyTransform(tt, out, prev);
      const mid = (r.top + r.bottom) / 2;
      if (!cur || Math.abs(mid - cur.mid) > Math.max(2, cur.h * 0.55)) {
        cur = { chars: '', lefts: [], rights: [], left: r.left, right: r.right, top: r.top, h: r.height, mid };
        lines.push(cur);
      }
      cur.chars += out;
      for (let q = 0; q < out.length; q++) { cur.lefts.push(r.left); cur.rights.push(r.right); }
      cur.left = Math.min(cur.left, r.left);
      cur.right = Math.max(cur.right, r.right);
    }
    if (!lines.length) return;

    const m = fontMetrics(c, cs);
    const deco = textDeco(c, parentEl);
    const rtl = cs.direction === 'rtl';
    for (const ln of lines) {
      let s = ln.chars, k = 0;
      if (!preserve) { while (k < s.length && s[k] === ' ') k++; }
      s = s.slice(k);
      s = preserve ? s.replace(/[\r\n]+$/, '') : s.replace(/\s+$/, '');
      if (!s) continue;
      let left = ln.lefts[k] !== undefined ? ln.lefts[k] : ln.left;
      if (inh && inh.ellipsis && ln.right + view.ox > inh.ellipsis.right + 0.5) {
        setFont(c, cs);
        const limit = inh.ellipsis.right - view.ox - c.measure.measureText('\u2026').width;
        let cut = s.length;
        for (let q = k; q < ln.rights.length; q++) if (ln.rights[q] > limit) { cut = q - k; break; }
        s = s.slice(0, cut).replace(/\s+$/, '') + '\u2026';
      }
      const y = ln.top + (ln.h - (m.asc + m.desc)) / 2 + m.asc + view.oy;
      if (rtl) emitText(c, cs, inh, s, ln.right + view.ox, y, { anchor: 'end', deco, preserve });
      else emitText(c, cs, inh, s, left + view.ox, y, { deco, preserve });
    }
  }

  // list markers (disc / circle / square / counters) have no DOM node
  function paintMarker(el, cs, c) {
    const type = cs.listStyleType;
    if (!type || type === 'none' || cs.listStylePosition === 'inside') return;
    const rng = rangeOf(c);
    try { rng.selectNodeContents(el); } catch (e) { return; }
    let r = null;
    for (const q of rng.getClientRects()) if (q.width > 0 && q.height > 0) { r = q; break; }
    if (!r) return;
    const view = c.view, size = parseFloat(cs.fontSize) || 16;
    const col = L.parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    const cy = r.top + view.oy + r.height / 2;
    const right = r.left + view.ox - size * 0.3;
    if (type === 'disc') c.out.push(`<circle cx="${n(right - size * 0.2)}" cy="${n(cy)}" r="${n(size * 0.17)}"${L.paint(col, 'fill')}/>`);
    else if (type === 'circle') c.out.push(`<circle cx="${n(right - size * 0.2)}" cy="${n(cy)}" r="${n(size * 0.15)}" fill="none"${L.paint(col, 'stroke')} stroke-width="1"/>`);
    else if (type === 'square') c.out.push(`<rect x="${n(right - size * 0.2 - size * 0.15)}" y="${n(cy - size * 0.15)}" width="${n(size * 0.3)}" height="${n(size * 0.3)}"${L.paint(col, 'fill')}/>`);
    else {
      const p = el.parentElement;
      let idx = 1;
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === 'li') idx++;
      if (p && p.localName === 'ol') {
        const start = parseInt(p.getAttribute('start'), 10);
        if (p.hasAttribute('reversed')) {
          const total = Array.from(p.children).filter((x) => x.localName === 'li').length;
          idx = (isNaN(start) ? total : start) - (idx - 1);
        } else idx = (isNaN(start) ? 1 : start) + idx - 1;
      }
      const y = r.top + view.oy + (r.height - (fontMetrics(c, cs).asc + fontMetrics(c, cs).desc)) / 2 + fontMetrics(c, cs).asc;
      emitText(c, cs, null, L.counterText(type, idx), right + size * 0.1, y, { anchor: 'end' });
    }
  }

  /* ==================================================================== */
  /* images                                                                */
  /* ==================================================================== */
  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  function bgFetch(url, asText) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'w2f:fetch', url, asText: !!asText }, (r) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(r || { error: 'no response' });
        });
      } catch (e) { resolve({ error: String(e) }); }
    });
  }

  // Draw a decoded source (img element / ImageBitmap) into a (possibly smaller) JPEG or PNG data URL.
  async function encodeFromSource(c, source, nw, nh, wantW) {
    let scale = Math.min(1, wantW > 0 ? wantW / nw : 1, c.opts.maxImagePx / Math.max(nw, nh));
    if (!(scale > 0)) scale = 1;
    const w = Math.max(1, Math.round(nw * scale)), h = Math.max(1, Math.round(nh * scale));
    const probe = new OffscreenCanvas(32, 32).getContext('2d', { willReadFrequently: true });
    probe.drawImage(source, 0, 0, 32, 32);
    const pd = probe.getImageData(0, 0, 32, 32).data; // throws early if the canvas is tainted
    let alpha = false;
    for (let i = 3; i < pd.length; i += 4) if (pd[i] < 250) { alpha = true; break; }
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext('2d');
    if (!alpha) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(source, 0, 0, w, h);
    const jpeg = !alpha && w * h > 90000;
    const blob = await cv.convertToBlob(jpeg ? { type: 'image/jpeg', quality: c.opts.jpegQuality } : { type: 'image/png' });
    return { url: await blobToDataUrl(blob), w: nw, h: nh };
  }

  async function reencode(c, bytes, mime, wantW) {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
    try {
      const nw = bmp.width, nh = bmp.height;
      const target = Math.min(nw, Math.max(1, Math.round(wantW)), c.opts.maxImagePx);
      if ((mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif') && target >= nw * 0.8 && Math.max(nw, nh) <= c.opts.maxImagePx && bytes.length < 1500000) {
        return { url: `data:${mime};base64,${L.bytesToB64(bytes)}`, w: nw, h: nh };
      }
      return await encodeFromSource(c, bmp, nw, nh, wantW);
    } finally { bmp.close(); }
  }

  async function fetchBytes(url) {
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,([\s\S]*)$/);
      if (!m) throw new Error('bad data url');
      const bytes = m[3] ? L.b64ToBytes(m[4]) : new TextEncoder().encode(decodeURIComponent(m[4]));
      return { bytes, mime: m[1] || '' };
    }
    if (url.startsWith('blob:')) {
      const r = await fetch(url);
      return { bytes: new Uint8Array(await r.arrayBuffer()), mime: r.headers.get('content-type') || '' };
    }
    const res = await bgFetch(url);
    if (!res.error && res.base64 != null) return { bytes: L.b64ToBytes(res.base64), mime: res.mime || '' };
    // fall back to the page itself (cookies / same-origin)
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return { bytes: new Uint8Array(await r.arrayBuffer()), mime: r.headers.get('content-type') || '' };
  }

  const isSvgUrl = (u) => /^data:image\/svg/i.test(u || '') || /\.svg(?:[?#]|$)/i.test(u || '');

  async function getImage(c, spec) {
    const { el, url, wantW } = spec;
    if (el && el.complete && el.naturalWidth > 0 && !isSvgUrl(url)) {
      try { return await encodeFromSource(c, el, el.naturalWidth, el.naturalHeight, wantW); } catch (e) { /* tainted -> fetch */ }
    }
    if (!url) throw new Error('no image source');
    const key = url + '|' + Math.round(wantW / 50);
    if (c.imgCache.has(key)) return c.imgCache.get(key);
    const p = (async () => {
      const { bytes, mime } = await fetchBytes(url);
      const sniffed = L.sniffMime(bytes) || String(mime).split(';')[0].trim().toLowerCase();
      if (sniffed === 'image/svg+xml' || isSvgUrl(url)) return { svgText: new TextDecoder().decode(bytes) };
      return await reencode(c, bytes, sniffed || 'image/png', wantW);
    })();
    c.imgCache.set(key, p);
    return p;
  }

  function svgNatural(text) {
    try {
      const r = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
      if (!r || r.localName !== 'svg') return null;
      const num = (v) => (v && !/%$/.test(v) ? parseFloat(v) : NaN);
      let w = num(r.getAttribute('width')), h = num(r.getAttribute('height'));
      const vb = (r.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      if ((isNaN(w) || isNaN(h)) && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        if (isNaN(w) && isNaN(h)) { w = vb[2]; h = vb[3]; }
        else if (isNaN(w)) w = h * vb[2] / vb[3];
        else h = w * vb[3] / vb[2];
      }
      return w > 0 && h > 0 ? { w, h } : null;
    } catch (e) { return null; }
  }

  function objectFitRect(fit, posStr, cw, ch, nw, nh) {
    let w = cw, h = ch;
    if (nw > 0 && nh > 0) {
      if (fit === 'contain') { const s = Math.min(cw / nw, ch / nh); w = nw * s; h = nh * s; }
      else if (fit === 'cover') { const s = Math.max(cw / nw, ch / nh); w = nw * s; h = nh * s; }
      else if (fit === 'none') { w = nw; h = nh; }
      else if (fit === 'scale-down') { const s = Math.min(1, Math.min(cw / nw, ch / nh)); w = nw * s; h = nh * s; }
    }
    const p = L.splitTop(posStr || '50% 50%', ' ');
    return { x: L.bgAxis(p[0], cw, w), y: L.bgAxis(p[1] || '50%', ch, h), w, h };
  }

  function paintImg(el, cs, g, c) {
    const cb = contentBox(g);
    if (cb.w <= 0 || cb.h <= 0) return;
    let src = el.currentSrc || el.getAttribute('src') || '';
    const lazy = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original');
    if (lazy && (!src || el.naturalWidth <= 2)) src = lazy;
    if (!c.opts.embedImages || !src) { c.out.push(placeholder(cb)); return; }
    let abs = src;
    try { abs = new URL(src, c.view.doc.baseURI).href; } catch (e) { /* keep */ }
    const fit = objectFitRect(cs.objectFit, cs.objectPosition, cb.w, cb.h, el.naturalWidth, el.naturalHeight);
    const dest = { x: cb.x + fit.x, y: cb.y + fit.y, w: fit.w, h: fit.h };
    const needClip = dest.x < cb.x - 0.5 || dest.y < cb.y - 0.5 || dest.x + dest.w > cb.x + cb.w + 0.5 || dest.y + dest.h > cb.y + cb.h + 0.5 || cb.r.some((r) => r.x > 0);
    let clipAttr = '';
    if (needClip) {
      const cid = nid(c, '__imgclip');
      c.defs.push(`<clipPath id="${cid}">${L.shape(cb.x, cb.y, cb.w, cb.h, cb.r)}</clipPath>`);
      clipAttr = ` clip-path="url(#${cid})"`;
    }
    const slot = { s: '' };
    c.out.push(slot);
    c.jobs.push({
      slot, label: 'image',
      run: async () => {
        const data = await getImage(c, { el, url: abs, wantW: dest.w * c.opts.imageScale });
        const body = data.svgText ? svgTextToGroup(c, data.svgText, dest.x, dest.y, dest.w, dest.h) : imageTag(data.url, dest.x, dest.y, dest.w, dest.h);
        c.stats.images++;
        return clipAttr ? `<g${clipAttr}>${body}</g>` : body;
      },
      fallback: () => placeholder(cb),
    });
  }

  function paintVideo(el, cs, g, c) {
    const cb = contentBox(g);
    if (cb.w <= 0 || cb.h <= 0) return;
    if (!c.opts.embedImages) { c.out.push(placeholder(cb, '#1f2430')); return; }
    const fit = objectFitRect(cs.objectFit, cs.objectPosition, cb.w, cb.h, el.videoWidth, el.videoHeight);
    const dest = { x: cb.x + fit.x, y: cb.y + fit.y, w: fit.w, h: fit.h };
    try {
      if (el.readyState >= 2 && el.videoWidth) {
        const cv = document.createElement('canvas');
        const sc = Math.min(1, 1280 / el.videoWidth);
        cv.width = Math.round(el.videoWidth * sc); cv.height = Math.round(el.videoHeight * sc);
        cv.getContext('2d').drawImage(el, 0, 0, cv.width, cv.height);
        const url = cv.toDataURL('image/jpeg', c.opts.jpegQuality);
        c.out.push(imageTag(url, dest.x, dest.y, dest.w, dest.h));
        c.stats.images++;
        return;
      }
    } catch (e) { /* tainted */ }
    if (el.poster) {
      const poster = el.poster, slot = { s: '' };
      c.out.push(slot);
      c.jobs.push({
        slot, label: 'poster',
        run: async () => { const d = await getImage(c, { url: poster, wantW: cb.w * c.opts.imageScale }); c.stats.images++; return d.svgText ? '' : imageTag(d.url, cb.x, cb.y, cb.w, cb.h); },
        fallback: () => placeholder(cb, '#1f2430'),
      });
      return;
    }
    const vbg = L.parseColor(cs.backgroundColor);
    if (!vbg || vbg.a === 0) c.out.push(placeholder(cb, '#1f2430'));
  }

  function paintCanvas(el, cs, g, c) {
    const cb = contentBox(g);
    if (cb.w <= 0 || cb.h <= 0 || !c.opts.embedImages) return;
    try {
      const url = el.toDataURL('image/png');
      c.out.push(imageTag(url, cb.x, cb.y, cb.w, cb.h));
      c.stats.images++;
    } catch (e) { c.out.push(placeholder(cb, '#eef0f4')); c.warnings.push('A <canvas> could not be read (tainted).'); }
  }

  function paintIframe(el, cs, g, c, inh) {
    const cb = contentBox(g);
    if (cb.w <= 0 || cb.h <= 0) return;
    let idoc = null;
    try { idoc = el.contentDocument; } catch (e) { /* cross-origin */ }
    if (idoc && idoc.documentElement && el.contentWindow) {
      const prev = c.view;
      const cid = nid(c, '__iframe');
      c.defs.push(`<clipPath id="${cid}">${L.shape(cb.x, cb.y, cb.w, cb.h, cb.r)}</clipPath>`);
      c.out.push(`<g clip-path="url(#${cid})">`);
      const mark = c.out.length;
      c.view = { win: el.contentWindow, doc: idoc, ox: cb.x, oy: cb.y, range: null };
      try { paintSafe(idoc.documentElement, c, inh); } finally { c.view = prev; }
      if (c.out.length === mark) c.out.pop(); else c.out.push('</g>');
      return;
    }
    let host = '';
    try { host = new URL(el.src, location.href).hostname; } catch (e) { /* ignore */ }
    c.out.push(placeholder(cb, '#f1f2f5'));
    c.out.push(`<text x="${n(cb.x + cb.w / 2)}" y="${n(cb.y + cb.h / 2)}" text-anchor="middle" font-family="${esc(c.opts.fallbackSans)}" font-size="12" fill="#8a8f9a">${escText('iframe' + (host ? ' \u00b7 ' + host : ''))}</text>`);
  }

  /* ==================================================================== */
  /* inline SVG                                                            */
  /* ==================================================================== */
  const PAINT_PROPS = [['fill', 'fill'], ['fill-opacity', 'fillOpacity'], ['fill-rule', 'fillRule'], ['stroke', 'stroke'], ['stroke-width', 'strokeWidth'],
    ['stroke-opacity', 'strokeOpacity'], ['stroke-linecap', 'strokeLinecap'], ['stroke-linejoin', 'strokeLinejoin'], ['stroke-miterlimit', 'strokeMiterlimit'],
    ['stroke-dasharray', 'strokeDasharray'], ['stroke-dashoffset', 'strokeDashoffset'], ['clip-rule', 'clipRule']];
  const TEXT_PROPS = [['font-size', 'fontSize'], ['font-weight', 'fontWeight'], ['font-style', 'fontStyle'], ['letter-spacing', 'letterSpacing'], ['text-anchor', 'textAnchor']];
  const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath']);
  const NONRENDER = new Set(['defs', 'clippath', 'mask', 'marker', 'pattern', 'lineargradient', 'radialgradient', 'symbol', 'filter', 'stop', 'style', 'title', 'desc', 'metadata']);
  const STYLE_ATTRS = new Set(['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule', 'stop-color', 'stop-opacity']);

  const cleanVal = (v) => String(v).replace(/url\(\s*["']?(#[^"')]+)["']?\s*\)/g, 'url($1)');

  function bakeChildren(orig, clone, c, inDefs) {
    const oc = Array.from(orig.children), cc = Array.from(clone.children);
    for (let i = 0; i < oc.length; i++) if (cc[i]) bakeNode(oc[i], cc[i], c, inDefs);
  }

  function bakeNode(o, k, c, inDefs) {
    if (o.namespaceURI !== SVGNS) { k.remove(); return; }
    const lt = o.localName.toLowerCase();
    const cs = getComputedStyle(o);
    const nonrender = NONRENDER.has(lt);
    if (!inDefs && !nonrender && (cs.display === 'none')) { k.remove(); return; }
    if (lt === 'use') { replaceUse(o, k, c); return; }
    if (SHAPE_TAGS.has(lt)) {
      for (const [attr, prop] of PAINT_PROPS) { const v = cs[prop]; if (v !== '' && v != null) k.setAttribute(attr, cleanVal(v)); }
      if (lt === 'text' || lt === 'tspan' || lt === 'textpath') {
        k.setAttribute('font-family', pickFont(c, cs.fontFamily));
        for (const [attr, prop] of TEXT_PROPS) { const v = cs[prop]; if (v !== '' && v != null) k.setAttribute(attr, v); }
      }
    }
    if (lt === 'stop') { k.setAttribute('stop-color', cs.stopColor); k.setAttribute('stop-opacity', cs.stopOpacity); }
    if (!nonrender && parseFloat(cs.opacity) < 1) k.setAttribute('opacity', cs.opacity);
    if (!nonrender && cs.mixBlendMode && cs.mixBlendMode !== 'normal') k.setAttribute('style', 'mix-blend-mode:' + cs.mixBlendMode);
    else k.removeAttribute('style');
    k.removeAttribute('class');
    bakeChildren(o, k, c, inDefs || nonrender);
  }

  // Cloned <use> targets: keep their own attributes, resolve inline style + currentColor.
  function fixUseSubtree(root, color) {
    const all = [root].concat(Array.from(root.querySelectorAll('*')));
    for (const e of all) {
      const st = e.getAttribute && e.getAttribute('style');
      if (st) {
        st.split(';').forEach((d) => {
          const i = d.indexOf(':');
          if (i > 0) { const p = d.slice(0, i).trim(), v = d.slice(i + 1).trim(); if (STYLE_ATTRS.has(p)) e.setAttribute(p, v); }
        });
        e.removeAttribute('style');
      }
      e.removeAttribute('class');
      ['fill', 'stroke', 'stop-color'].forEach((a) => { const v = e.getAttribute(a); if (v && /^currentcolor$/i.test(v.trim())) e.setAttribute(a, color); });
    }
  }

  function replaceUse(o, k, c) {
    const href = o.getAttribute('href') || o.getAttributeNS(XLINK, 'href') || '';
    if (!href.startsWith('#')) { k.remove(); return; }
    const target = o.ownerDocument.getElementById(href.slice(1));
    if (!target) { k.remove(); return; }
    const cs = getComputedStyle(o);
    const g = document.createElementNS(SVGNS, 'g');
    const ux = parseFloat(o.getAttribute('x')) || 0, uy = parseFloat(o.getAttribute('y')) || 0;
    g.setAttribute('transform', `${o.getAttribute('transform') || ''} translate(${ux} ${uy})`.trim());
    for (const [attr, prop] of PAINT_PROPS) { const v = cs[prop]; if (v !== '' && v != null) g.setAttribute(attr, cleanVal(v)); }
    if (parseFloat(cs.opacity) < 1) g.setAttribute('opacity', cs.opacity);
    if (target.localName === 'symbol') {
      const inner = document.createElementNS(SVGNS, 'g');
      Array.from(target.childNodes).forEach((ch) => inner.appendChild(ch.cloneNode(true)));
      const vbAttr = target.getAttribute('viewBox');
      if (vbAttr) {
        const v = vbAttr.trim().split(/[\s,]+/).map(Number);
        const root = o.ownerSVGElement, rvb = root && root.viewBox && root.viewBox.baseVal;
        const uw = parseFloat(o.getAttribute('width')) || (rvb && rvb.width) || (root && root.clientWidth) || v[2];
        const uh = parseFloat(o.getAttribute('height')) || (rvb && rvb.height) || (root && root.clientHeight) || v[3];
        const f = L.fitViewBox({ x: v[0], y: v[1], w: v[2], h: v[3] }, uw, uh, target.getAttribute('preserveAspectRatio'));
        inner.setAttribute('transform', `translate(${n(f.tx)} ${n(f.ty)}) scale(${+f.sx.toFixed(5)} ${+f.sy.toFixed(5)})`);
      }
      g.appendChild(inner);
    } else {
      const t = target.cloneNode(true);
      t.removeAttribute('id');
      g.appendChild(t);
    }
    fixUseSubtree(g, cs.color);
    k.replaceWith(g);
  }

  // gradients / clip paths referenced from another <svg> in the page
  function attachExternalDefs(clone, orig, c) {
    const ids = new Set();
    const scan = (el) => {
      const html = el.outerHTML || '';
      html.replace(/url\(\s*['"]?#([^)'"\s]+)/g, (_, id) => ids.add(id));
      html.replace(/href="#([^"]+)"/g, (_, id) => ids.add(id));
    };
    scan(clone);
    const missing = Array.from(ids).filter((id) => { try { return !clone.querySelector(`[id="${CSS.escape(id)}"]`); } catch (e) { return false; } });
    if (!missing.length) return;
    let defs = clone.querySelector('defs');
    if (!defs) { defs = document.createElementNS(SVGNS, 'defs'); clone.insertBefore(defs, clone.firstChild); }
    for (const id of missing) {
      const src = orig.ownerDocument.getElementById(id);
      if (!src || src.namespaceURI !== SVGNS) continue;
      const cl = src.cloneNode(true);
      defs.appendChild(cl);
      bakeNode(src, cl, c, true); // bake paint onto the cloned def using the source's computed styles
    }
  }

  function svgElToGroup(svgEl, c, dest) {
    const clone = svgEl.cloneNode(true);
    bakeChildren(svgEl, clone, c, false);
    attachExternalDefs(clone, svgEl, c);
    clone.querySelectorAll('style,script,foreignObject').forEach((e) => e.remove());
    const s = new XMLSerializer().serializeToString(clone);
    const a = s.indexOf('>') + 1, b = s.lastIndexOf('</svg>');
    let inner = b > a ? s.slice(a, b) : '';
    const p = 'v' + (++c.uid) + '_';
    inner = inner
      .replace(/\bid="([^"]*)"/g, (m, id) => `id="${p}${id}"`)
      .replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g, (m, q, id) => `url(#${p}${id})`)
      .replace(/((?:xlink:)?href)="#([^"]*)"/g, (m, at, id) => `${at}="#${p}${id}"`);
    let vb = null;
    const vbb = svgEl.viewBox && svgEl.viewBox.baseVal;
    if (vbb && vbb.width > 0 && vbb.height > 0) vb = { x: vbb.x, y: vbb.y, w: vbb.width, h: vbb.height };
    const f = vb ? L.fitViewBox(vb, dest.w, dest.h, svgEl.getAttribute('preserveAspectRatio')) : { sx: 1, sy: 1, tx: 0, ty: 0 };
    const tfm = `translate(${n(dest.x + f.tx)} ${n(dest.y + f.ty)})` + (Math.abs(f.sx - 1) > 1e-4 || Math.abs(f.sy - 1) > 1e-4 ? ` scale(${+f.sx.toFixed(5)} ${+f.sy.toFixed(5)})` : '');
    return `<g transform="${tfm}">${inner}</g>`;
  }

  function sanitizeSvg(root) {
    root.querySelectorAll('script,foreignObject,iframe,object,embed').forEach((e) => e.remove());
    for (const e of [root].concat(Array.from(root.querySelectorAll('*')))) {
      for (const a of Array.from(e.attributes)) {
        if (/^on/i.test(a.name) || (/href$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) e.removeAttribute(a.name);
      }
    }
  }

  // SVG file contents (from <img src=x.svg> or background-image) -> vector group
  function svgTextToGroup(c, text, x, y, w, h) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) throw new Error('invalid svg');
    sanitizeSvg(root);
    const holder = document.createElement('div');
    holder.setAttribute('data-w2f-ignore', '');
    holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none';
    const imp = document.importNode(root, true);
    holder.appendChild(imp);
    document.documentElement.appendChild(holder);
    try { return svgElToGroup(imp, c, { x, y, w, h }); } finally { holder.remove(); }
  }

  function paintInlineSvg(el, cs, g, c) {
    const cb = contentBox(g);
    if (cb.w <= 0 || cb.h <= 0) return;
    c.out.push(svgElToGroup(el, c, cb));
  }

  /* ==================================================================== */
  /* form controls                                                         */
  /* ==================================================================== */
  function singleLine(c, cs, text, box, fillCol, align) {
    const m = fontMetrics(c, cs);
    const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0;
    const tw = c.measure.measureText(text).width + ls * text.length;
    let x = box.x;
    if (align === 'center') x = box.x + (box.w - tw) / 2;
    else if (align === 'right' || align === 'end') x = box.x + box.w - tw;
    const y = box.y + box.h / 2 - (m.asc + m.desc) / 2 + m.asc;
    emitTextColor(c, cs, text, x, y, fillCol);
  }
  // emitText variant with an explicit colour (placeholders etc.)
  function emitTextColor(c, cs, text, x, y, col) {
    if (!col || col.a <= 0) return;
    const id = uniqueName(c, text.slice(0, 28));
    c.stats.texts++;
    c.out.push(`<text id="${id}" x="${n(x)}" y="${n(y)}"${textStyle(c, cs)}${L.paint(col, 'fill')} xml:space="preserve">${escText(text)}</text>`);
  }

  function wrapLines(c, text, maxW) {
    const out = [];
    for (const para of String(text).split(/\r?\n/)) {
      const words = para.split(/(\s+)/);
      let line = '';
      for (const w of words) {
        const t = line + w;
        if (line && c.measure.measureText(t).width > maxW) { out.push(line.replace(/\s+$/, '')); line = w.replace(/^\s+/, ''); } else line = t;
      }
      out.push(line);
    }
    return out;
  }

  function paintControl(el, cs, g, c) {
    const tag = el.localName, cb = contentBox(g);
    const color = L.parseColor(cs.color);
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'hidden') return;
      if (type === 'checkbox' || type === 'radio') { paintCheck(el, cs, g, c, type); return; }
      if (type === 'color') {
        const col = L.parseColor(el.value) || { r: 0, g: 0, b: 0, a: 1 };
        c.out.push(L.shape(cb.x + 2, cb.y + 2, Math.max(0, cb.w - 4), Math.max(0, cb.h - 4), L.zeroRadii(), L.paint(col, 'fill').trim()));
        return;
      }
      if (type === 'range' || type === 'file' || type === 'image') return;
      let text = el.value, ph = false;
      if (!text && el.placeholder) { text = el.placeholder; ph = true; }
      if (type === 'password' && !ph) text = '\u2022'.repeat(text.length);
      if (!text) return;
      fontMetrics(c, cs);
      let col = color;
      if (ph) { try { col = L.parseColor(getComputedStyle(el, '::placeholder').color) || color; } catch (e) { /* ignore */ } }
      singleLine(c, cs, text, cb, col, cs.textAlign);
    } else if (tag === 'textarea') {
      let text = el.value, ph = false;
      if (!text && el.placeholder) { text = el.placeholder; ph = true; }
      if (!text) return;
      const m = fontMetrics(c, cs);
      let col = color;
      if (ph) { try { col = L.parseColor(getComputedStyle(el, '::placeholder').color) || color; } catch (e) { /* ignore */ } }
      const size = parseFloat(cs.fontSize) || 16;
      const lh = parseFloat(cs.lineHeight) || size * 1.2;
      let y = cb.y;
      for (const line of wrapLines(c, text, cb.w)) {
        if (y > cb.y + cb.h) break;
        if (line) emitTextColor(c, cs, line, cb.x, y + (lh - (m.asc + m.desc)) / 2 + m.asc, col);
        y += lh;
      }
    } else if (tag === 'select') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      fontMetrics(c, cs);
      if (opt && opt.text) singleLine(c, cs, opt.text, { x: cb.x + 4, y: cb.y, w: cb.w - 4, h: cb.h }, color, 'left');
      if (cs.appearance !== 'none' && cs.webkitAppearance !== 'none') {
        const cx = g.x + g.w - 12, cy = g.y + g.h / 2;
        c.out.push(`<path d="M${n(cx - 4)} ${n(cy - 2)}l4 4 4-4" fill="none"${L.paint(color || { r: 0, g: 0, b: 0, a: 1 }, 'stroke')} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`);
      }
    }
  }

  function paintCheck(el, cs, g, c, type) {
    if (cs.appearance === 'none' || cs.webkitAppearance === 'none') return;
    const sz = Math.min(g.w, g.h);
    if (sz <= 0) return;
    const x = g.x + (g.w - sz) / 2, y = g.y + (g.h - sz) / 2;
    const accent = cs.accentColor && cs.accentColor !== 'auto' ? L.parseColor(cs.accentColor) : { r: 0, g: 117, b: 255, a: 1 };
    const grey = { r: 118, g: 118, b: 118, a: 1 }, white = { r: 255, g: 255, b: 255, a: 1 };
    if (type === 'radio') {
      const r = sz / 2 - 0.5, cx = x + sz / 2, cy = y + sz / 2;
      if (el.checked) c.out.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="#fff"${L.paint(accent, 'stroke')} stroke-width="1"/><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(sz * 0.27)}"${L.paint(accent, 'fill')}/>`);
      else c.out.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="#fff"${L.paint(grey, 'stroke')} stroke-width="1"/>`);
    } else if (el.checked) {
      c.out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(sz)}" height="${n(sz)}" rx="2"${L.paint(accent, 'fill')}/><path d="M${n(x + sz * 0.24)} ${n(y + sz * 0.52)}l${n(sz * 0.2)} ${n(sz * 0.2)} ${n(sz * 0.34)} ${n(-sz * 0.4)}" fill="none"${L.paint(white, 'stroke')} stroke-width="${n(Math.max(1.2, sz * 0.14))}" stroke-linecap="round" stroke-linejoin="round"/>`);
    } else {
      c.out.push(`<rect x="${n(x + 0.5)}" y="${n(y + 0.5)}" width="${n(sz - 1)}" height="${n(sz - 1)}" rx="2" fill="#fff"${L.paint(grey, 'stroke')} stroke-width="1"/>`);
    }
  }

  /* ==================================================================== */
  /* capture orchestration                                                 */
  /* ==================================================================== */
  async function runJobs(c, onProgress) {
    const jobs = c.jobs;
    let idx = 0, done = 0;
    const worker = async () => {
      while (idx < jobs.length) {
        const j = jobs[idx++];
        try {
          j.slot.s = await Promise.race([j.run(), sleep(25000).then(() => { throw new Error('timeout'); })]);
        } catch (e) {
          j.slot.s = j.fallback();
          c.warnings.push(`${j.label} failed: ${e && e.message ? e.message : e}`);
        }
        onProgress && onProgress(++done, jobs.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
  }

  async function capture(target, mode, opts, onProgress, onWire) {
    const t0 = performance.now();
    const c = makeCtx(opts);
    const cleanups = [];
    const de = document.documentElement, body = document.body;
    const scrollX0 = window.scrollX, scrollY0 = window.scrollY;
    let box;
    try {
      await settle(1500);
      if (mode === 'page' && opts.scrollLazy) { onProgress && onProgress('Loading lazy content', 0.1); await autoScroll(); await settle(1500); }
      c.view = { win: window, doc: document, ox: window.scrollX, oy: window.scrollY, range: null };
      onProgress && onProgress('Reading the page', 0.3);
      await sleep(30);

      prepareDocument(c, cleanups, mode === 'element' ? target : de);

      if (mode === 'element') {
        for (let p = target.parentElement; p; p = p.parentElement) {
          const t = neutralizeTransform(p, getComputedStyle(p));
          if (t) cleanups.push(t.restore);
        }
        const r = target.getBoundingClientRect();
        box = { x: r.left + c.view.ox, y: r.top + c.view.oy, w: Math.max(1, Math.ceil(r.width)), h: Math.max(1, Math.ceil(r.height)) };
      } else if (mode === 'viewport') {
        box = { x: c.view.ox, y: c.view.oy, w: de.clientWidth, h: window.innerHeight };
        c.cull = { x: box.x - 50, y: box.y - 50, w: box.w + 100, h: box.h + 100 };
      } else {
        const bh = body ? Math.max(body.scrollHeight, body.getBoundingClientRect().bottom + c.view.oy) : 0;
        box = { x: 0, y: 0, w: de.clientWidth, h: Math.ceil(Math.max(de.scrollHeight, bh)) };
      }
      c.canvasBox = box;

      if (mode !== 'element') {
        if (opts.whiteBackground) c.out.push(`<rect id="page-background" x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" fill="#ffffff"/>`);
        const hasBg = (cs) => { const col = L.parseColor(cs.backgroundColor); return (col && col.a > 0) || (cs.backgroundImage && cs.backgroundImage !== 'none'); };
        const hcs = getComputedStyle(de);
        if (hasBg(hcs)) c.bgEl = de; else if (body && hasBg(getComputedStyle(body))) c.bgEl = body;
        if (c.bgEl) {
          const cg = { x: box.x, y: box.y, w: box.w, h: box.h, bt: 0, br: 0, bb: 0, bl: 0, pt: 0, pr: 0, pb: 0, pl: 0, r: L.zeroRadii() };
          const mark = c.out.length;
          paintBackground(getComputedStyle(c.bgEl), cg, c);
          if (c.out.length > mark) { c.out.splice(mark, 0, '<g id="canvas-background">'); c.out.push('</g>'); }
        }
      }

      onProgress && onProgress('Building layers', 0.4);
      paintSafe(target, c, {});
    } finally {
      cleanups.reverse().forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
      if (mode === 'page' && opts.scrollLazy) window.scrollTo({ top: scrollY0, left: scrollX0, behavior: 'instant' });
    }

    if (onWire) { try { onWire(c.wire); } catch (e) { /* cosmetic only */ } }

    if (c.jobs.length) await runJobs(c, (d, t) => onProgress && onProgress('Fetching images', 0.5 + 0.4 * (d / t), `${d} of ${t}`));

    onProgress && onProgress('Assembling SVG', 0.95);
    const W = Math.max(1, Math.round(box.w)), H = Math.max(1, Math.round(box.h));
    // Figma names the pasted frame / group after the SVG ids, so use the page address
    const urlName = (() => {
      let h = (location.hostname || '').replace(/^www\./, ''), p = location.pathname || '';
      if (!h) { h = decodeURIComponent((p.split('/').pop() || 'page')); p = ''; }
      if (p === '/') p = '';
      return ((h + p.replace(/\/$/, '')).replace(/[\s"'<>&]+/g, '-').slice(0, 120)) || 'page';
    })();
    const name = mode === 'element'
      ? uniqueName(c, target.id || (typeof target.className === 'string' && target.className.trim().split(/\s+/)[0]) || target.localName)
      : urlName;
    const fileName = name.replace(/[\\/:*?"<>|]+/g, '_');
    const defs = `<defs><clipPath id="__page"><rect x="${n(box.x)}" y="${n(box.y)}" width="${W}" height="${H}"/></clipPath>${c.defs.join('')}</defs>`;
    const bodySvg = c.out.map((x) => (typeof x === 'string' ? x : x.s)).join('');
    const svg = `<svg xmlns="${SVGNS}" xmlns:xlink="${XLINK}" id="${esc(name)}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}<g id="${esc(name)}" clip-path="url(#__page)" transform="translate(${n(-box.x)} ${n(-box.y)})">${bodySvg}</g></svg>`;
    const stats = {
      layers: c.stats.groups + c.stats.texts, groups: c.stats.groups, texts: c.stats.texts, images: c.stats.images,
      bytes: svg.length, width: W, height: H, ms: Math.round(performance.now() - t0),
    };
    return { svg, name, fileName, stats, warnings: c.warnings };
  }

  async function start(mode, userOpts) {
    if (state.busy) throw new Error('A capture is already running on this page.');
    const opts = Object.assign({}, DEFAULTS, userOpts || {});
    state.busy = true;
    try {
      let target = document.documentElement;
      if (mode === 'element') {
        UI.hide();
        target = await pickElement();
        if (!target) return { ok: false, cancelled: true };
      }
      const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const progress = (title, pct, sub) => { UI.progress(title, sub || '', pct); return tick(); };
      let last = 0;
      await progress('Capturing\u2026', 0.04);
      const res = await capture(target, mode, opts, (t, p, s) => { const now = performance.now(); if (now - last > 60) { last = now; UI.progress(t, s || '', p); } }, (rects) => UI.wire(rects));
      state.last = res;
      let copied = false;
      if (opts.autoCopy) copied = await copyText(res.svg);
      const st = res.stats;
      UI.done({
        copied, stats: st,
        title: copied ? 'Copied \u2014 paste into Figma' : 'Capture ready',
        warn: res.warnings.length ? `${res.warnings.length} warning${res.warnings.length > 1 ? 's' : ''}: ${res.warnings[0]}` : '',
      });
      return { ok: true, stats: st, copied };
    } catch (e) {
      UI.error(e && e.message ? e.message : String(e));
      return { ok: false, error: String(e && e.message ? e.message : e) };
    } finally {
      state.busy = false;
    }
  }

  window.__w2f.capture = (mode, opts, target) => capture(target || document.documentElement, mode || 'page', Object.assign({}, DEFAULTS, opts || {}));
  window.__w2f.DEFAULTS = DEFAULTS;
  window.__w2f.getLast = () => state.last; // isolated world only: not reachable from the page

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!window.__w2f || window.__w2f.token !== TOKEN) return false; // superseded by a newer injection
      if (msg && msg.type === 'w2f:start') {
        start(msg.mode, msg.options).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
        return true;
      }
      return false;
    });
  }
})();
