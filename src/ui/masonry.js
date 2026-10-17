/* ui.masonry — windowed masonry layout (absolute positioning + column packing).
   Only tiles near the viewport exist in the DOM, so a 10k-post library scrolls fine.

   createMasonry(host, {
     scroller,                 // scrolling element (default: nearest overflow ancestor or window)
     colMin: 170, gap: 10,     // px
     overscan: 900,            // px above/below the viewport to keep mounted
     aspectOf(item) → number,  // width / height of the media box
     extraHeight(item) → px,   // e.g. an always-visible info strip
     render(item, index, colWidth) → { el, update?, destroy? }
   }) → { setItems, relayout, scrollToIndex, each(fn), mounted(), destroy, get items }
*/
XR.define("ui.masonry", ["ui.dom"], function (dom) {
  "use strict";

  function findScroller(el) {
    let p = el.parentElement;
    while (p && p !== document.body) { const o = getComputedStyle(p).overflowY; if (o === "auto" || o === "scroll") return p; p = p.parentElement; }
    return window;
  }

  function createMasonry(host, opts) {
    const o = { colMin: 170, gap: 10, overscan: 900, aspectOf: () => 1, extraHeight: () => 0, ...opts };
    const scroller = o.scroller || findScroller(host);
    const isWin = scroller === window;
    host.classList.add("masonry");
    let items = [], pos = [], order = [], cols = 1, colWidth = 0, hostWidth = 0;
    const mounted = new Map(); // index → api
    let destroyed = false, raf = 0;
    const KEYS = { ArrowDown: "down", ArrowUp: "up", ArrowRight: "right", ArrowLeft: "left" };
    function onKey(e) {
      if (!KEYS[e.key] || e.altKey || e.metaKey || e.ctrlKey) return;
      const tile = e.target.closest?.("[data-index]"); if (!tile || tile.parentNode !== host) return;
      const i = Number(tile.dataset.index); if (!Number.isFinite(i)) return;
      const rtl = getComputedStyle(host).direction === "rtl";
      let dir = KEYS[e.key]; if (rtl && (dir === "left" || dir === "right")) dir = dir === "left" ? "right" : "left";
      const j = api.neighbour(i, dir);
      if (j >= 0) { e.preventDefault(); api.focusIndex(j); }
    }
    host.addEventListener("keydown", onKey);

    const viewportTop = () => (isWin ? scrollY : scroller.scrollTop);
    const viewportH = () => (isWin ? innerHeight : scroller.clientHeight);
    function hostOffset() { // host top in scroller coordinates
      const hr = host.getBoundingClientRect();
      if (isWin) return hr.top + scrollY;
      return hr.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    }

    function layout() {
      hostWidth = host.clientWidth;
      if (!hostWidth) return;
      cols = Math.max(1, Math.floor((hostWidth + o.gap) / (o.colMin + o.gap)));
      colWidth = (hostWidth - o.gap * (cols - 1)) / cols;
      const heights = new Array(cols).fill(0);
      pos = new Array(items.length);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const hgt = Math.round(colWidth / Math.min(2.2, Math.max(0.5, o.aspectOf(it) || 1))) + (o.extraHeight(it) || 0);
        let c = 0; for (let k = 1; k < cols; k++) if (heights[k] < heights[c] - 0.5) c = k;
        pos[i] = { x: Math.round(c * (colWidth + o.gap)), y: Math.round(heights[c]), w: Math.round(colWidth), h: hgt };
        heights[c] += hgt + o.gap;
      }
      host.style.height = Math.max(0, Math.max(...heights, 0) - o.gap) + "px";
      order = pos.map((_, i) => i).sort((a, b) => pos[a].y - pos[b].y);
      for (const [i, api] of mounted) place(api.el, pos[i]);
    }
    function place(el, p) { el.style.transform = `translate(${p.x}px, ${p.y}px)`; el.style.width = p.w + "px"; }

    function lowerBound(y) { let lo = 0, hi = order.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (pos[order[mid]].y < y) lo = mid + 1; else hi = mid; } return lo; }
    function update() {
      raf = 0;
      if (destroyed || !pos.length) { for (const [i, api] of mounted) { api.destroy ? api.destroy() : api.el.remove(); mounted.delete(i); } return; }
      const off = hostOffset();
      const top = viewportTop() - off - o.overscan, bottom = viewportTop() - off + viewportH() + o.overscan;
      const want = new Set();
      // items are column-packed so a tile can start above `top` yet still be visible: scan back a bit
      let start = lowerBound(top - 1600); if (start < 0) start = 0;
      for (let k = start; k < order.length; k++) {
        const i = order[k], p = pos[i];
        if (p.y > bottom) break;
        if (p.y + p.h >= top) want.add(i);
      }
      for (const [i, api] of mounted) if (!want.has(i)) { api.destroy ? api.destroy() : api.el.remove(); mounted.delete(i); }
      const frag = document.createDocumentFragment();
      for (const i of want) {
        if (mounted.has(i)) continue;
        const api = o.render(items[i], i, Math.round(colWidth));
        api.el.classList.add("masonry-item");
        api.el.style.setProperty("--i", i % 8);
        place(api.el, pos[i]);
        mounted.set(i, api);
        frag.appendChild(api.el);
      }
      if (frag.childNodes.length) host.appendChild(frag);
    }
    const schedule = () => { if (!raf && !destroyed) raf = requestAnimationFrame(update); };

    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", onResize);
    let ro = null;
    if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(() => { if (host.clientWidth !== hostWidth) onResize(); }); ro.observe(host); }
    let resizeTimer = 0;
    function onResize() { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { layout(); update(); }, 60); }

    const api = {
      get items() { return items; },
      setItems(list) { items = list || []; for (const [i, a] of mounted) { a.destroy ? a.destroy() : a.el.remove(); mounted.delete(i); } layout(); update(); },
      relayout() { layout(); update(); },
      refresh() { update(); },
      each(fn) { for (const [i, a] of mounted) fn(a, i); },
      mounted: () => mounted.size,
      positionOf: (i) => pos[i] || null,
      scrollToIndex(i, { behavior = "auto" } = {}) {
        const p = pos[i]; if (!p) return;
        const y = hostOffset() + p.y - 80;
        if (isWin) scrollTo({ top: y, behavior }); else scroller.scrollTo({ top: y, behavior });
      },
      /** Spatial keyboard navigation: arrows move between tiles by geometry (column-aware). */
      neighbour(i, dir) {
        const p = pos[i]; if (!p) return -1;
        const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
        let best = -1, bestScore = Infinity;
        for (let j = 0; j < pos.length; j++) {
          if (j === i) continue;
          const q = pos[j]; const qx = q.x + q.w / 2, qy = q.y + q.h / 2;
          const dx = qx - cx, dy = qy - cy;
          const ok = dir === "down" ? dy > 2 && Math.abs(dx) < p.w : dir === "up" ? dy < -2 && Math.abs(dx) < p.w : dir === "right" ? dx > 2 && Math.abs(dy) < Math.max(p.h, q.h) : dx < -2 && Math.abs(dy) < Math.max(p.h, q.h);
          if (!ok) continue;
          const score = (dir === "up" || dir === "down") ? Math.abs(dy) * 1 + Math.abs(dx) * 0.5 : Math.abs(dx) + Math.abs(dy) * 0.5;
          if (score < bestScore) { bestScore = score; best = j; }
        }
        return best;
      },
      focusIndex(i) {
        if (i < 0 || i >= items.length) return;
        if (!mounted.has(i)) { api.scrollToIndex(i); update(); }
        const a = mounted.get(i);
        if (a) { a.el.focus({ preventScroll: true }); a.el.scrollIntoView({ block: "nearest", inline: "nearest" }); }
      },
      destroy() {
        destroyed = true; cancelAnimationFrame(raf); clearTimeout(resizeTimer);
        host.removeEventListener("keydown", onKey);
        scroller.removeEventListener("scroll", schedule); window.removeEventListener("resize", onResize); ro?.disconnect();
        for (const [, a] of mounted) a.destroy ? a.destroy() : a.el.remove();
        mounted.clear(); host.style.height = ""; dom.clear(host);
      },
    };
    return api;
  }
  return { createMasonry };
});
