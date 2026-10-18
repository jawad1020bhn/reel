/* ui.rail — a horizontal shelf: heading bar with hover-revealed actions and pager
   ticks, a full-bleed snap-scrolling track, and edge-fade arrows that page by
   one viewport. Native momentum is preserved; scrollbars stay hidden.

   createRail({ id, title, hint, icon, actions: [{label, icon, run, title}], items,
                render(item, i) → {el}, size, rank,
                lazy, skeleton })
   `lazy` paints shimmer cards sized like real items and builds the DOM only when the
   shelf approaches the viewport (IntersectionObserver, 700px ahead). */
XR.define("ui.rail", ["ui.dom", "ui.icons", "core.i18n"], function (dom, icons, i18n) {
  "use strict";
  const h = dom.h;
  function createRail(opts) {
    const track = h("div.rail-track", { role: "list" });
    const left = h("button.rail-arrow.rail-prev", { "aria-label": "Scroll left", onclick: () => nudge(-1) }, icons.icon("chevronLeft", 26));
    const right = h("button.rail-arrow.rail-next", { "aria-label": "Scroll right", onclick: () => nudge(1) }, icons.icon("chevronRight", 26));
    const ticks = h("div.rail-ticks", { "aria-hidden": "true" });

    /* heading actions: quiet until the row is hovered */
    const actions = h("div.rail-actions");
    for (const a of opts.actions || []) {
      actions.appendChild(h("button.rail-act", { onclick: a.run, title: a.title || a.label, "aria-label": a.title || a.label },
        a.icon ? icons.icon(a.icon, 15) : null, a.label ? h("span", i18n.t(a.label)) : null));
    }
    const title = h("h2.rail-title", h("span.rail-title-text", i18n.t(opts.title)));
    const el = h("section.rail", { class: opts.size ? "rail-" + opts.size : "", dataset: { rail: opts.id || "" } },
      h("header.rail-head",
        h("div.rail-titles", title, opts.hint ? h("p.rail-hint", i18n.t(opts.hint)) : null),
        actions, ticks),
      h("div.rail-body", left, track, right));

    const apis = [];
    let io = null, revealed = false, dead = false;
    /* building a shelf is a few dozen tile nodes: do it when the main thread is
       idle, not mid-scroll. requestIdleCallback is missing in Safari → short timer. */
    const idle = typeof requestIdleCallback === "function"
      ? (fn) => requestIdleCallback(fn, { timeout: 260 })
      : (fn) => setTimeout(fn, 60);
    const onScrollThrottled = dom.rafThrottle(onScroll);
    function nudge(dir) { track.scrollBy({ left: dir * Math.max(240, track.clientWidth * 0.92), behavior: "smooth" }); }

    /** The nearest vertical scroller (the outlet). IO with the viewport as root
        clips below-the-fold shelves away, so a 700px "look ahead" needs the
        scroller as the root to work. */
    function scrollRoot() {
      let p = el.parentElement;
      while (p && p !== document.body) {
        const oy = getComputedStyle(p).overflowY;
        if (oy === "auto" || oy === "scroll") return p;
        p = p.parentElement;
      }
      return null;
    }

    function updateArrows() {
      const max = track.scrollWidth - track.clientWidth - 2;
      left.classList.toggle("hidden", track.scrollLeft <= 2);
      right.classList.toggle("hidden", track.scrollLeft >= max);
    }
    function updateTicks() {
      if (innerWidth < 768) { ticks.replaceChildren(); return; }
      const pages = Math.max(1, Math.ceil(track.scrollWidth / Math.max(1, track.clientWidth)));
      const active = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      if (ticks.childElementCount !== pages) {
        ticks.replaceChildren(...Array.from({ length: pages }, (_, i) => h("i", { class: i === active ? "on" : "" })));
      } else {
        [...ticks.children].forEach((t, i) => t.classList.toggle("on", i === active));
      }
    }
    function onScroll() { updateArrows(); updateTicks(); }
    track.addEventListener("scroll", onScrollThrottled, { passive: true });
    track.addEventListener("wheel", (e) => { if (Math.abs(e.deltaX) < Math.abs(e.deltaY) && e.shiftKey) { e.preventDefault(); track.scrollBy({ left: e.deltaY }); } }, { passive: false });
    window.addEventListener("resize", onScrollThrottled, { passive: true });

    /** Shimmer placeholders shaped like the real cards, so the shelf never jumps. */
    function setSkeleton(n) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < n; i++) {
        frag.appendChild(h("div.rail-item.rail-skel", { "aria-hidden": "true" },
          h("span.sk.rail-skel-card", { style: { "--i": i % 8 } })));
      }
      track.replaceChildren(frag);
      el.classList.add("is-loading");
      el.setAttribute("aria-busy", "true");
    }

    const api = {
      el, track, items: [],
      setSkeleton,
      setItems(items) {
        for (const a of apis) a.destroy ? a.destroy() : a.el.remove();
        apis.length = 0; api.items = items;
        const frag = document.createDocumentFragment();
        items.forEach((it, i) => { const a = opts.render(it, i); a.el.classList.add("rail-item"); a.el.style.setProperty("--i", i % 8); a.el.setAttribute("role", "listitem"); apis.push(a); frag.appendChild(a.el); });
        track.replaceChildren(frag);
        el.classList.remove("is-loading");
        el.removeAttribute("aria-busy");
        requestAnimationFrame(onScroll);
      },
      reveal() {
        if (revealed || !opts.items) return;
        revealed = true;
        if (io) { io.disconnect(); io = null; }
        if (opts.lazy) api.setItemsProgressively(opts.items);
        else api.setItems(opts.items);
      },
      /* build a shelf in small idle slices: the first cards land immediately, the
         rest fill in before the ghosts while the main thread stays free */
      setItemsProgressively(items, chunk = 8) {
        api.items = items;
        let i = 0;
        const build = () => {
          if (dead) return;
          const frag = document.createDocumentFragment();
          const end = Math.min(items.length, i + chunk);
          for (; i < end; i++) {
            const a = opts.render(items[i], i);
            a.el.classList.add("rail-item");
            a.el.style.setProperty("--i", i % 8);
            a.el.setAttribute("role", "listitem");
            apis.push(a); frag.appendChild(a.el);
          }
          // Consume placeholders as cards arrive, rather than extending the shelf
          // by a full ghost row until the last idle slice finishes.
          const ghosts = [...track.querySelectorAll(".rail-skel")];
          const count = frag.childElementCount;
          if (ghosts[0]) track.insertBefore(frag, ghosts[0]); else track.appendChild(frag);
          ghosts.slice(0, count).forEach((ghost) => ghost.remove());
          requestAnimationFrame(onScroll);
          if (i < items.length) { idle(build); return; }
          for (const g of track.querySelectorAll(".rail-skel")) g.remove();
          el.classList.remove("is-loading");
          el.removeAttribute("aria-busy");
        };
        build();
      },
      each(fn) { apis.forEach(fn); },
      destroy() {
        dead = true;
        if (io) { io.disconnect(); io = null; }
        for (const a of apis) a.destroy ? a.destroy() : a.el.remove();
        el.remove(); window.removeEventListener("resize", onScrollThrottled);
      },
    };

    if (opts.lazy && opts.items) {
      /* keep a full shelf of ghosts even when the shelf holds fewer real cards */
      setSkeleton(Math.max(4, Math.min(opts.skeleton ?? 6, opts.items.length || 6)));
      el.setAttribute("aria-busy", "true");
      if (typeof IntersectionObserver === "undefined") api.reveal();
      else requestAnimationFrame(() => {
        /* the shelf is connected by now, so its scroll parent exists */
        if (dead || revealed) return;
        const root = scrollRoot();
        io = new IntersectionObserver((entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          if (io) { io.disconnect(); io = null; }
          /* a shelf already on screen is revealed now; one that is still ahead
             of the viewport waits for an idle slice so scrolling stays smooth */
          const box = el.getBoundingClientRect();
          const rootBox = root ? root.getBoundingClientRect() : { top: 0, bottom: innerHeight };
          const onScreen = box.top < rootBox.bottom && box.bottom > rootBox.top;
          if (onScreen) api.reveal();
          else idle(() => { if (!dead) api.reveal(); });
        }, { root, rootMargin: "700px 0px" });
        io.observe(el);
      });
    } else if (opts.items) api.setItems(opts.items);
    return api;
  }
  return { createRail };
});
