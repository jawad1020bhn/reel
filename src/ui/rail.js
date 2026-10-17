/* ui.rail — a horizontal shelf: heading bar with hover-revealed actions and pager
   ticks, a full-bleed snap-scrolling track, and edge-fade arrows that page by
   one viewport. Native momentum is preserved; scrollbars stay hidden.
   createRail({ id, title, hint, icon, actions: [{label, icon, run, title}], items, render(item, i) → {el}, size, rank }) */
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
      h("header.rail-head", h("div.rail-titles", title, opts.hint ? h("p.rail-hint", i18n.t(opts.hint)) : null, actions), ticks),
      h("div.rail-body", left, track, right));

    const apis = [];
    const onScrollThrottled = dom.rafThrottle(onScroll);
    function nudge(dir) { track.scrollBy({ left: dir * Math.max(240, track.clientWidth * 0.92), behavior: "smooth" }); }

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

    const api = {
      el, track, items: [],
      setItems(items) {
        for (const a of apis) a.destroy ? a.destroy() : a.el.remove();
        apis.length = 0; api.items = items;
        const frag = document.createDocumentFragment();
        items.forEach((it, i) => { const a = opts.render(it, i); a.el.classList.add("rail-item"); a.el.style.setProperty("--i", i % 8); a.el.setAttribute("role", "listitem"); apis.push(a); frag.appendChild(a.el); });
        track.appendChild(frag);
        requestAnimationFrame(onScroll);
      },
      each(fn) { apis.forEach(fn); },
      destroy() { for (const a of apis) a.destroy ? a.destroy() : a.el.remove(); el.remove(); window.removeEventListener("resize", onScrollThrottled); },
    };
    if (opts.items) api.setItems(opts.items);
    return api;
  }
  return { createRail };
});
