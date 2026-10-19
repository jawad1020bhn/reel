/* shell.layout — the application frame: a fixed cinematic header (brand wordmark,
   sliding-pill text nav, expanding search, utility icons) with a chip rail on tablets and thumb-reachable navigation
   on phones, and the outlet where features mount. */
XR.define("shell.layout", ["ui.dom", "ui.icons", "ui.widgets", "ui.menu", "app.features", "app.nav", "app.playback", "app.catalog", "app.lock", "core.events", "core.domain.events", "core.i18n"],
  function (dom, icons, W, menu, features, nav, playback, catalog, lock, events, EV, i18n) {
    "use strict";
    const h = dom.h;
    let els = null;

    /* ----------------------------------------------------------------- nav -- */
    function navLink(m) {
      return h("a.hdr-link", { href: "#" + nav.build(m.id), dataset: { feature: m.id }, title: m.title, onclick: (e) => { e.preventDefault(); nav.go(m.id); } },
        h("span", i18n.t(m.title)));
    }
    function chipLink(m) {
      return h("a.chipnav-link", { href: "#" + nav.build(m.id), dataset: { feature: m.id }, onclick: (e) => { e.preventDefault(); nav.go(m.id); } },
        i18n.t(m.title));
    }

    /* One moving surface per navigation. Transform-only travel keeps the
       active marker smooth without moving labels or changing their weight. */
    function movePill(animate = true) {
      if (!els) return;
      for (const [track, pill, selector] of [
        [els.nav, els.pill, ".hdr-link.is-active"],
        [els.mobileNav, els.mobilePill, ".mobile-nav-link.is-active"],
      ]) {
        const active = track.querySelector(selector);
        if (!active || !track.getClientRects().length) { pill.style.opacity = "0"; continue; }
        if (!animate) pill.style.transition = "none";
        pill.style.transform = `translateX(${active.offsetLeft}px)`;
        pill.style.width = active.offsetWidth + "px";
        pill.style.opacity = "1";
        if (!animate) { void pill.offsetWidth; pill.style.transition = ""; }
      }
    }

    /* -------------------------------------------------------------- search -- */
    function buildSearch() {
      const input = h("input.hdr-search-input", {
        type: "search", placeholder: i18n.t("Search titles, creators, #tags"), "aria-label": "Search your library",
        autocomplete: "off", spellcheck: false, enterkeyhint: "search",
        onkeydown: (e) => {
          if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); nav.go("library", {}, { q: input.value.trim() }); closeSearch({ instant: true }); }
          else if (e.key === "Escape") { e.stopPropagation(); closeSearch(); }
        },
      });
      let focusTimer = 0, hideTimer = 0;
      const cancel = h("button.hdr-search-cancel", { type: "button", onclick: () => closeSearch() }, i18n.t("Cancel"));
      const form = h("form.hdr-search", { hidden: true, role: "search", id: "hdr-search-form", onsubmit: (e) => { e.preventDefault(); nav.go("library", {}, { q: input.value.trim() }); closeSearch({ instant: true }); } },
        icons.icon("search", 19), input, cancel);
      const btn = h("button.hdr-icon.hdr-search-btn", { title: "Search ( / )", "aria-label": "Open search", "aria-expanded": "false", "aria-controls": "hdr-search-form", onclick: () => (form.classList.contains("open") ? closeSearch() : openSearch()) }, icons.icon("search", 20), h("span.hdr-search-label", i18n.t("Search")), h("kbd.hdr-search-key", { "aria-hidden": "true" }, "/"));
      const isOpen = () => !form.hidden && form.classList.contains("open");
      /* On phones the bar covers the app bar's own controls. They stay painted
         underneath, but leave the tab order and pointer surface while it is open. */
      const phoneOnly = () => typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;
      function setChromeInert(on) {
        if (!els || !phoneOnly()) return;
        const covered = [els.header.querySelector(".hdr-left"), ...els.header.querySelectorAll(".hdr-actions > .hdr-icon, .hdr-actions > .src-chip"), els.mobileNav];
        for (const el of covered) if (el) el.inert = on;
      }
      /* Escape leaves search from anywhere inside the bar, not just the field. */
      function onDocKey(e) {
        if (e.key !== "Escape" || !isOpen()) return;
        e.preventDefault(); e.stopPropagation();
        closeSearch();
      }
      function openSearch() {
        clearTimeout(hideTimer);
        /* Phones get the short label; the long one is clipped in a 44px bar. */
        const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;
        input.placeholder = narrow ? i18n.t("Search your library") : i18n.t("Search titles, creators, #tags");
        form.hidden = false;
        void form.offsetWidth;              /* commit the closed style so the bar actually expands */
        form.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
        document.documentElement.classList.add("is-searching");
        setChromeInert(true);
        document.addEventListener("keydown", onDocKey, true);
        focusTimer = setTimeout(() => { if (isOpen()) input.focus({ preventScroll: true }); }, 0);
      }
      function closeSearch({ instant = false, restore = true } = {}) {
        clearTimeout(focusTimer); clearTimeout(hideTimer);
        const wasOpen = isOpen();
        form.classList.remove("open");
        btn.setAttribute("aria-expanded", "false");
        document.documentElement.classList.remove("is-searching");
        setChromeInert(false);
        document.removeEventListener("keydown", onDocKey, true);
        const land = () => {
          /* Hiding the form blurs whatever it held, so hand focus back to the
             action that opened it — unless the user already moved on. */
          const held = form.contains(document.activeElement) || document.activeElement === document.body;
          form.hidden = true; input.value = "";
          if (restore && wasOpen && held) btn.focus({ preventScroll: true });
        };
        const reduce = document.documentElement.dataset.motion === "reduce" ||
          (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
        if (instant || reduce) land();
        else hideTimer = setTimeout(land, 180);
        if (restore && wasOpen && form.contains(document.activeElement)) btn.focus({ preventScroll: true });
      }
      return { form, btn, input, openSearch, closeSearch, isOpen };
    }

    /* --------------------------------------------------------------- build -- */
    function build() {
      const items = features.navItems();
      const primary = items.filter((m) => m.order < 100);
      const secondary = items.filter((m) => m.order >= 100);

      const search = buildSearch();
      const muteBtn = W.iconBtn(playback.muted ? "mute" : "volume", "Mute / unmute (m)", () => playback.toggleMuted(), { cls: "hdr-icon hdr-mute" });
      const source = h("button.src-chip", { title: "Data source · open Import", onclick: () => nav.go("import") },
        icons.icon("database", 14), h("span.src-chip-text", "…"));

      const pill = h("span.hdr-pill", { "aria-hidden": "true" });
      const navEl = h("nav.hdr-nav", { "aria-label": "Primary" }, pill, primary.map((m) => navLink(m)));
      const chips = h("nav.hdr-chips", { "aria-label": "Primary" },
        primary.map((m) => chipLink(m)),
        /* Settings lives on the corner gear; a chip for it would be a duplicate */
        secondary.filter((m) => m.id !== "settings").map((m) => chipLink(m)));

      const brand = h("a.brand", { href: "#/discover", onclick: (e) => { e.preventDefault(); nav.go("discover"); }, "aria-label": "saves home" },
        h("span.brand-icon", icons.icon("bookmark", 16)), h("span.brand-word", "saves"));
      const back = h("button.hdr-icon.hdr-back", { title: "Back", "aria-label": "Back", onclick: () => nav.back() }, icons.icon("arrowLeft", 20));
      /* Phones only: the destination name takes the bar once the page scrolls.
         It is a duplicate of the page heading, so assistive tech skips it. */
      const context = h("span.hdr-context", { "aria-hidden": "true" });
      const scrim = h("div.hdr-scrim", { "aria-hidden": "true", onclick: () => search.closeSearch() });

      const actions = h("div.hdr-actions",
        source,
        h("span.hdr-spacer"),
        search.form, search.btn,
        muteBtn,
        W.iconBtn("command", "Command palette (⌘K)", () => events.bus.emit(EV.PALETTE_OPEN, {}), { cls: "hdr-icon hdr-command" }),
        secondary.filter((m) => m.id !== "import").map((m) => {
          const btn = W.iconBtn(m.icon, m.title, () => nav.go(m.id), { cls: "hdr-icon hdr-secondary", size: 19 });
          btn.dataset.feature = m.id;            // so setActive can light the gear
          return btn;
        }));

      const inner = h("div.hdr-in", h("div.hdr-left", back, brand, context, navEl), actions);
      const header = h("header.hdr", scrim, inner, chips);
      const outlet = h("div.outlet", { id: "outlet", tabindex: "-1", "aria-label": "Content" });
      const skip = h("a.skip-link", { href: "#outlet", onclick: (e) => { e.preventDefault(); outlet.focus({ preventScroll: true }); } }, i18n.t("Skip to content"));
      /* Four stable destinations, then the complete page list. Watch remains
         immersive; its Back control returns to the same navigation context.
         Tapping the current destination again returns the page to the top. */
      const phoneIds = ["discover", "library", "watch", "collections"];
      const goTab = (id) => {
        if (nav.current?.name !== id) { nav.go(id); return; }
        const reduce = document.documentElement.dataset.motion === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches;
        outlet.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      };
      const phoneLinks = phoneIds.map((id) => {
        const m = items.find((item) => item.id === id);
        if (!m) return null;
        return h("a.mobile-nav-link", { href: "#" + nav.build(id), dataset: { feature: id }, onclick: (e) => { e.preventDefault(); goTab(id); } },
          icons.icon(m.icon, 21), h("span", i18n.t(m.title)));
      });
      const moreBtn = h("button.mobile-nav-link.mobile-nav-more", { type: "button", "aria-label": "More pages", "aria-haspopup": "menu", "aria-expanded": "false", onclick: () => {
        if (moreBtn.getAttribute("aria-expanded") === "true") { menu.close(); return; }
        menu.open(moreBtn, [
          ...items.filter((m) => !phoneIds.includes(m.id)).map((m) => ({ label: m.title, icon: m.icon, checked: nav.current?.name === m.id, run: () => nav.go(m.id) })),
          { sep: true },
          { label: "Command palette", icon: "command", run: () => events.bus.emit(EV.PALETTE_OPEN, {}) },
          /* Playback is global, so sound lives with the other preferences rather
             than competing with Search in the 56px bar. */
          { label: playback.muted ? "Unmute sound" : "Mute sound", icon: playback.muted ? "volume" : "mute", run: () => playback.toggleMuted() },
        ], { title: "More", className: "navigation-menu", onClose: () => moreBtn.setAttribute("aria-expanded", "false") });
        moreBtn.setAttribute("aria-expanded", "true");
      } }, icons.icon("more", 21), h("span", i18n.t("More")));
      const mobilePill = h("span.mobile-nav-pill", { "aria-hidden": "true" });
      const mobileNav = h("nav.mobile-nav", { "aria-label": "Primary" }, mobilePill, phoneLinks, moreBtn);
      const main = h("main.main", header, outlet, mobileNav);
      const app = h("div.app", { id: "app" }, skip, main);
      document.body.appendChild(app);

      els = { app, header, nav: navEl, chips, pill, outlet, main, mobileNav, mobilePill, moreBtn, context, scrim, phoneIds, search: search.input, searchBtn: search.btn, searchIsOpen: search.isOpen, closeSearch: search.closeSearch, source, back };

      /* header reacts to the outlet scroll: scrim at top, solid once you move,
         and the compact page name after the content has travelled a little */
      outlet.addEventListener("scroll", dom.rafThrottle(() => {
        const y = outlet.scrollTop;
        header.classList.toggle("is-solid", y > 14);
        header.classList.toggle("is-scrolled", y > 44);
      }), { passive: true });
      window.addEventListener("resize", dom.rafThrottle(() => { movePill(false); syncHeaderChrome(false); }), { passive: true });
      if (typeof ResizeObserver === "function") new ResizeObserver(() => syncHeaderChrome()).observe(header);
      document.fonts?.ready?.then(() => { movePill(false); syncHeaderChrome(false); }).catch(() => {});
      syncHeaderChrome(false);

      events.bus.on(EV.PLAYBACK_CHANGED, ({ muted }) => dom.replace(muteBtn, icons.icon(muted ? "mute" : "volume", 20)));
      events.bus.on(EV.ROUTE_CHANGED, ({ route }) => setActive(route));
      events.bus.on(EV.DATASET_CHANGED, updateSource);
      updateSource();
      requestAnimationFrame(() => movePill(false));
      return els;
    }

    /** Publish the real chrome height (bar + mobile chip rail) so page offsets follow it. */
    let chromeRaf = 0;
    function syncHeaderChrome(animate = true) {
      if (!els) return;
      cancelAnimationFrame(chromeRaf);
      chromeRaf = requestAnimationFrame(() => {
        if (!els) return;
        const hgt = Math.round(els.header.getBoundingClientRect().height);
        if (hgt > 0) document.documentElement.style.setProperty("--hdr-offset", hgt + "px");
        if (animate) movePill(false);
      });
    }

    function updateSource() {
      if (!els) return;
      const s = catalog.source;
      dom.replace(els.source.querySelector(".src-chip-text"), s.count ? `${dom.compact(s.count)} posts` : "No data");
      els.source.title = `${s.label || "No data"} · ${s.count || 0} posts · click to manage`;
    }

    function setActive(route) {
      if (!els) return;
      const f = features.get(route.name);
      els.context.textContent = f ? i18n.t(f.title) : "";
      for (const a of els.app.querySelectorAll("[data-feature]")) {
        const active = a.dataset.feature === route.name;
        a.classList.toggle("is-active", active);
        if (a.matches("a")) { if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
      }
      const moreActive = !els.phoneIds.includes(route.name);
      els.moreBtn.classList.toggle("is-active", moreActive);
      els.moreBtn.setAttribute("aria-label", moreActive && f ? `More pages, current page: ${i18n.t(f.title)}` : "More pages");
      menu.close();
      /* Close unconditionally: it also clears a pending hide timer, so the query
         this route is about to publish can't be wiped by that timer a beat later. */
      els.closeSearch({ instant: true, restore: false });
      els.app.dataset.feature = route.name;
      els.app.classList.toggle("app-immersive", !!(f && f.layout === "immersive"));
      /* back only exists where there is somewhere to go back to (detail pages) */
      const detail = Object.keys(route.params || {}).length > 0 || [].concat(route.query?.q || [], route.query?.state || []).some(Boolean);
      els.header.classList.toggle("has-back", !!(f && f.back && detail));
      els.back.setAttribute("aria-hidden", f && f.back && detail ? "false" : "true");
      /* The outlet restores its own scroll a moment later; re-read once it has,
         so the phone bar doesn't show the previous page's scroll state. */
      els.header.classList.toggle("is-scrolled", els.outlet.scrollTop > 44);
      requestAnimationFrame(() => {
        if (els) els.header.classList.toggle("is-scrolled", els.outlet.scrollTop > 44);
      });
      movePill(true);
      syncHeaderChrome(false);
      const activeChip = els.chips.querySelector(".chipnav-link.is-active");
      if (activeChip) {
        const left = activeChip.offsetLeft - (els.chips.clientWidth - activeChip.offsetWidth) / 2;
        els.chips.scrollTo({ left: Math.max(0, left), behavior: document.documentElement.dataset.motion === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
      if (route.name === "library" && route.query.q !== undefined) els.search.value = route.query.q; else if (route.name !== "library") els.search.value = "";
    }

    const focusSearch = () => { els?.openSearch(); };
    return { build, setActive, focusSearch, get els() { return els; }, get outlet() { return els?.outlet; } };
  });
