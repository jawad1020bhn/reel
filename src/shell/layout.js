/* shell.layout — the application frame: a fixed cinematic header (brand wordmark,
   sliding-pill text nav, expanding search, utility icons) with a frosted chip rail
   on mobile, and the outlet where features mount. */
XR.define("shell.layout", ["ui.dom", "ui.icons", "ui.widgets", "app.features", "app.nav", "app.playback", "app.catalog", "app.lock", "core.events", "core.domain.events", "core.i18n"],
  function (dom, icons, W, features, nav, playback, catalog, lock, events, EV, i18n) {
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

    /* The frosted pill that slides behind the active nav link (500ms expo). */
    function movePill(animate = true) {
      if (!els) return;
      const pill = els.pill;
      const active = els.nav.querySelector(".hdr-link[data-feature].is-active");
      if (!active) { pill.style.opacity = "0"; return; }
      if (!animate) pill.style.transition = "none";
      pill.style.left = active.offsetLeft + "px";
      pill.style.width = active.offsetWidth + "px";
      pill.style.opacity = "1";
      if (!animate) { void pill.offsetWidth; pill.style.transition = ""; }
    }

    /* -------------------------------------------------------------- search -- */
    function buildSearch() {
      const input = h("input.hdr-search-input", {
        type: "search", placeholder: i18n.t("Search titles, creators, #tags") + "  ( / )", "aria-label": "Search",
        autocomplete: "off", spellcheck: false,
        onkeydown: (e) => {
          if (e.key === "Enter") { nav.go("library", {}, { q: input.value.trim() }); closeSearch(); }
          else if (e.key === "Escape") { e.stopPropagation(); closeSearch(); }
        },
      });
      const form = h("form.hdr-search", { onsubmit: (e) => { e.preventDefault(); nav.go("library", {}, { q: input.value.trim() }); closeSearch(); } },
        icons.icon("search", 19), input,
        h("button.hdr-search-close", { type: "button", "aria-label": "Close search", onclick: () => closeSearch() }, icons.icon("x", 15)));
      const btn = h("button.hdr-icon.hdr-search-btn", { title: "Search ( / )", "aria-label": "Open search", onclick: () => openSearch() }, icons.icon("search", 21));
      function openSearch() { form.classList.add("open"); setTimeout(() => input.focus(), 180); }
      function closeSearch() { form.classList.remove("open"); input.value = ""; input.blur(); els?.searchBtn.focus({ preventScroll: true }); }
      return { form, btn, input, openSearch, closeSearch };
    }

    /* --------------------------------------------------------------- build -- */
    function build() {
      const items = features.navItems();
      const primary = items.filter((m) => m.order < 100);
      const secondary = items.filter((m) => m.order >= 100);

      const search = buildSearch();
      const muteBtn = W.iconBtn(playback.muted ? "mute" : "volume", "Mute / unmute (m)", () => playback.toggleMuted(), { cls: "hdr-icon" });
      const source = h("button.src-chip", { title: "Data source · open Import", onclick: () => nav.go("import") },
        icons.icon("database", 14), h("span.src-chip-text", "…"));

      const pill = h("span.hdr-pill", { "aria-hidden": "true" });
      const navEl = h("nav.hdr-nav", { "aria-label": "Primary" }, pill, primary.map((m) => navLink(m)));
      const chips = h("nav.hdr-chips", { "aria-label": "Primary" },
        primary.map((m) => chipLink(m)),
        secondary.map((m) => chipLink(m)));

      const brand = h("a.brand", { href: "#/discover", onclick: (e) => { e.preventDefault(); nav.go("discover"); }, "aria-label": "XReels home" },
        h("span.brand-word", "X"), h("span.brand-word.brand-word-rest", "REELS"));
      const back = h("button.hdr-icon.hdr-back", { title: "Back", "aria-label": "Back", onclick: () => nav.back() }, icons.icon("arrowLeft", 20));

      const actions = h("div.hdr-actions",
        source,
        h("span.hdr-spacer"),
        search.form, search.btn,
        muteBtn,
        W.iconBtn("command", "Command palette (⌘K)", () => events.bus.emit(EV.PALETTE_OPEN, {}), { cls: "hdr-icon" }),
        secondary.filter((m) => m.id !== "import").map((m) => W.iconBtn(m.icon, m.title, () => nav.go(m.id), { cls: "hdr-icon", size: 19 })));

      const inner = h("div.hdr-in", h("div.hdr-left", back, brand, navEl), actions);
      const header = h("header.hdr", inner, chips);
      const outlet = h("div.outlet", { id: "outlet", tabindex: "-1" });
      const main = h("main.main", header, outlet);
      const app = h("div.app", { id: "app" }, main);
      document.body.appendChild(app);

      els = { app, header, nav: navEl, chips, pill, outlet, main, search: search.input, searchBtn: search.btn, openSearch: search.openSearch, muteBtn, source, back };

      /* header reacts to the outlet scroll: scrim at top, solid once you move */
      outlet.addEventListener("scroll", dom.rafThrottle(() => {
        header.classList.toggle("is-solid", outlet.scrollTop > 14);
      }), { passive: true });
      window.addEventListener("resize", dom.rafThrottle(() => movePill(false)), { passive: true });

      events.bus.on(EV.PLAYBACK_CHANGED, ({ muted }) => dom.replace(muteBtn, icons.icon(muted ? "mute" : "volume", 20)));
      events.bus.on(EV.ROUTE_CHANGED, ({ route }) => setActive(route));
      events.bus.on(EV.DATASET_CHANGED, updateSource);
      updateSource();
      requestAnimationFrame(() => movePill(false));
      return els;
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
      for (const a of els.app.querySelectorAll("[data-feature]")) a.classList.toggle("is-active", a.dataset.feature === route.name);
      els.app.dataset.feature = route.name;
      els.app.classList.toggle("app-immersive", !!(f && f.layout === "immersive"));
      els.header.classList.toggle("has-back", !!(f && f.back));
      movePill(true);
      if (route.name === "library" && route.query.q !== undefined) els.search.value = route.query.q; else if (route.name !== "library") els.search.value = "";
    }

    const focusSearch = () => { els?.openSearch(); };
    return { build, setActive, focusSearch, get els() { return els; }, get outlet() { return els?.outlet; } };
  });
