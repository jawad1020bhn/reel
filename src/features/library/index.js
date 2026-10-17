/* features.library — the full archive as a filterable, windowed masonry grid.
   State lives in the URL (#/library?kind=short&state=unseen&q=…) so views are
   shareable between sessions and the back button just works. */
XR.define("features.library", ["ui.dom", "ui.icons", "ui.widgets", "ui.masonry", "ui.tiles", "ui.menu", "ui.dialog", "ui.keys", "app.catalog", "app.activity", "app.actions", "app.prefs", "app.nav", "app.ports.platform", "core.query.engine", "core.events", "core.domain.events", "core.util"],
  function (dom, icons, W, masonryUI, tiles, menu, dialog, keys, catalog, activity, actions, prefs, nav, platform, engine, events, EV, util) {
    "use strict";
    const h = dom.h;
    const S = { host: null, spec: engine.normalizeSpec({}), result: { items: [], total: 0 }, grid: null, els: {}, offs: [], queryTimer: 0, sel: { on: false, set: new Set(), last: -1 } };

    const KIND_CHIPS = [["all", "All", "grid"], ["video", "Videos", "play"], ["short", "Shorts", "zap"], ["long", "Long", "film"], ["photo", "Photos", "image"], ["carousel", "Albums", "layers"], ["gif", "GIFs", "gif"]];
    const STATE_CHIPS = [["unseen", "Unseen", "eye"], ["starred", "Starred", "star"], ["progress", "In progress", "clock"], ["seen", "Seen", "check"], ["hidden", "Hidden", "eyeOff"]];
    const SORT_OPTIONS = [["saved", "Recently saved"], ["newest", "Newest posted"], ["oldest", "Oldest posted"], ["likes", "Most liked"], ["views", "Most viewed"], ["longest", "Longest"], ["shortest", "Shortest"], ["creator", "By creator"], ["random", "Shuffled"]];

    const setSpec = (patch, { replace = true } = {}) => nav.setQuery(engine.toParams({ ...S.spec, ...patch }), { replace });

    /* ------------------------------------------------------------ render -- */
    function mount(outlet, route) {
      S.host = outlet;
      S.spec = engine.fromParams(route.query);
      const page = h("div.library");
      const toolbar = h("div.lib-toolbar");
      const chips = h("div.lib-chips");
      const gridHost = h("div.lib-grid");
      const bulkBar = buildBulkBar();
      const head = h("header.page-head", h("div", h("h1.page-title", "Library"), h("p.page-sub.lib-count", "")));
      page.append(head, toolbar, chips, gridHost, bulkBar);
      outlet.appendChild(page);
      S.els = { page, head, toolbar, chips, gridHost, bulkBar };
      renderToolbar();
      S.grid = masonryUI.createMasonry(gridHost, {
        scroller: outlet, colMin: colMin(), gap: gapPx(), overscan: 900,
        aspectOf: (p) => tiles.aspectOf(p), extraHeight: () => tiles.infoHeight(),
        render: (post, i, w) => tiles.make(post, { ids: S.ids, index: i, label: label(), width: w, ...selectOpts() }),
      });
      runQuery();
      S.offs = [
        events.bus.on(EV.ACTIVITY_CHANGED, onActivity),
        events.bus.on(EV.DATASET_CHANGED, () => runQuery()),
        events.bus.on(EV.PREFS_CHANGED, ({ patch }) => { if (["tileShape", "tileInfo", "blur", "seenDim", "density", "hoverPreview"].some((k) => k in patch)) { S.grid.setItems([]); S.grid = recreateGrid(); runQuery(false); } if ("shortMaxSeconds" in patch || "hideSensitive" in patch) runQuery(false); }),
      ];
      keys.bind("library", "r", () => shuffle(), { desc: "Reshuffle" });
      keys.bind("library", "v", () => toggleBulk(), { desc: "Select mode" });
      keys.bind("library", "escape", () => { if (S.sel.on) toggleBulk(false); });
      keys.push("library");
    }
    function recreateGrid() {
      S.grid.destroy();
      return masonryUI.createMasonry(S.els.gridHost, { scroller: S.host, colMin: colMin(), gap: gapPx(), overscan: 900, aspectOf: (p) => tiles.aspectOf(p), extraHeight: () => tiles.infoHeight(), render: (post, i, w) => tiles.make(post, { ids: S.ids, index: i, label: label(), width: w, ...selectOpts() }) });
    }
    const colMin = () => ({ compact: 140, cozy: 180, comfortable: 230 }[prefs.get("density")] || 180);
    const gapPx = () => ({ compact: 6, cozy: 10, comfortable: 14 }[prefs.get("density")] || 10);
    const label = () => engine.describe(S.spec);

    function unmount() {
      for (const off of S.offs) off(); S.offs = [];
      keys.pop("library"); keys.unbindScope("library");
      S.sel = { on: false, set: new Set(), last: -1 };
      S.grid?.destroy(); S.grid = null; S.host = null; S.ids = [];
    }
    function update(route) {
      const next = engine.fromParams(route.query);
      const changed = JSON.stringify(next) !== JSON.stringify(S.spec);
      S.spec = next;
      if (changed) { renderToolbar(); runQuery(); }
    }

    function renderToolbar() {
      const { toolbar } = S.els;
      const q = h("input.input.lib-search", { type: "search", placeholder: "Search… @user #tag is:short dur:>5m", value: S.spec.q, autocomplete: "off", spellcheck: false,
        oninput: () => { clearTimeout(S.queryTimer); S.queryTimer = setTimeout(() => setSpec({ q: q.value.trim() }), 260); },
        onkeydown: (e) => { if (e.key === "Escape") { q.value = ""; setSpec({ q: "" }); q.blur(); } if (e.key === "Enter") { clearTimeout(S.queryTimer); setSpec({ q: q.value.trim() }); } } });
      const sort = W.select(SORT_OPTIONS.map(([value, label]) => ({ value, label })), S.spec.sort, (v) => setSpec({ sort: v, seed: v === "random" ? util.daySeed() : 0 }));
      const monthSel = W.select([{ value: "", label: "Any month posted" }, ...catalog.months.map((m) => ({ value: m.key, label: `${m.label} (${m.count})` }))], S.spec.month, (v) => setSpec({ month: v }));
      const savedSel = W.select([{ value: "", label: "Any month saved" }, ...catalog.savedMonths.map((m) => ({ value: m.key, label: `${m.label} (${m.count})` }))], S.spec.savedMonth, (v) => setSpec({ savedMonth: v }));
      dom.replace(toolbar,
        h("div.lib-search-wrap", icons.icon("search", 16), q, h("button.btn.btn-icon.btn-ghost.lib-help", { title: "Search syntax", onclick: showSyntax }, icons.icon("info", 16))),
        h("div.lib-controls",
          sort, monthSel, savedSel,
          W.btn("Select", { icon: "check", title: "Select mode (v)", onClick: () => toggleBulk() }),
          W.btn("", { icon: "shuffle", title: "Shuffle (r)", onClick: shuffle }),
          W.btn("", { icon: "bookmark", title: "Saved views", onClick: (e) => viewsMenu(e.currentTarget) })));
    }
    function renderChips() {
      const f = catalog.facets();
      const { chips } = S.els;
      const kindRow = h("div.chip-row.lib-kinds", KIND_CHIPS.map(([value, label, icon]) => W.chip({ label, icon, count: f[value], active: S.spec.kind === value, onClick: () => setSpec({ kind: value }) })));
      const stateRow = h("div.chip-row.lib-states", STATE_CHIPS.map(([value, label, icon]) => W.chip({ label, icon, count: f[value], active: S.spec.state === value, onClick: () => setSpec({ state: S.spec.state === value ? "all" : value }) })));
      const active = [];
      if (S.spec.creator) active.push(W.chip({ label: "@" + S.spec.creator, icon: "users", active: true, onRemove: () => setSpec({ creator: "" }) }));
      if (S.spec.collection) { const c = activity.collection(S.spec.collection); active.push(W.chip({ label: c ? c.name : "Collection", icon: "folder", active: true, onRemove: () => setSpec({ collection: "" }) })); }
      if (S.spec.month) active.push(W.chip({ label: "Posted " + S.spec.month, icon: "calendar", active: true, onRemove: () => setSpec({ month: "" }) }));
      if (S.spec.savedMonth) active.push(W.chip({ label: "Saved " + S.spec.savedMonth, icon: "bookmark", active: true, onRemove: () => setSpec({ savedMonth: "" }) }));
      if (S.spec.q) active.push(W.chip({ label: `“${util.truncate(S.spec.q, 30)}”`, icon: "search", active: true, onRemove: () => setSpec({ q: "" }) }));
      dom.replace(chips, kindRow, stateRow, active.length ? h("div.chip-row.chip-row-active", active, W.chip({ label: "Clear all", icon: "x", cls: "chip-ghost", onClick: () => nav.setQuery({}) })) : null);
    }

    function runQuery(resetScroll = true) {
      if (!S.host) return;
      S.result = catalog.query(S.spec);
      S.ids = S.result.items.map((p) => p.id);
      renderChips();
      const countEl = S.els.page.querySelector(".lib-count");
      if (countEl) countEl.textContent = `${dom.compact(S.result.total)} ${S.result.total === 1 ? "post" : "posts"} · ${engine.describe(S.spec)}${S.spec.sort === "random" ? " · seed " + S.spec.seed : ""}`;
      if (resetScroll) S.host.scrollTop = 0;
      S.grid.setItems(S.result.items);
      if (!S.result.items.length) S.els.gridHost.appendChild(W.empty({ icon: S.spec.state === "hidden" ? "eyeOff" : "search", title: "No posts match", text: S.spec.q ? "Try fewer words, or check the search syntax (ⓘ)." : "Try another filter.", action: { label: "Clear filters", run: () => nav.setQuery({}) } }));
      syncBulkBar();
    }

    /* ---------------------------------------------------------- select -- */
    const toggleSelection = (id) => (S.sel.set.has(id) ? S.sel.set.delete(id) : S.sel.set.add(id));
    const selectOpts = () => ({
      selectActive: () => S.sel.on,
      isSelected: (p) => S.sel.set.has(p.id),
      onToggleSelect: toggleSel,
    });

    function toggleSel(post, e) {
      const idx = S.ids.indexOf(post.id);
      if (e?.shiftKey && S.sel.last >= 0 && idx >= 0) {
        const a = Math.min(S.sel.last, idx), b = Math.max(S.sel.last, idx);
        for (let i = a; i <= b; i++) S.sel.set.add(S.ids[i]);
      } else toggleSelection(post.id);
      S.sel.last = idx;
      S.grid.each((t) => t.update());
      syncBulkBar();
    }

    function toggleBulk(force) {
      const on = force === undefined ? !S.sel.on : !!force;
      if (on === S.sel.on) return;
      S.sel.on = on;
      if (!on) { S.sel.set.clear(); S.sel.last = -1; }
      S.els.gridHost.classList.toggle("is-selecting", on);
      S.grid.each((t) => t.update());
      syncBulkBar();
    }

    function bulkApply(fn, { keep = false, msg = "", undo } = {}) {
      const ids = [...S.sel.set];
      if (!ids.length) return;
      activity.bulk(() => { for (const id of ids) fn(id); });
      if (msg) actions.toast(msg, "success", undo ? { timeout: 6000, action: { label: "Undo", run: () => undo(ids) } } : undefined);
      if (!keep) toggleBulk(false);
    }

    function buildBulkBar() {
      return h("div.bulk-bar", { role: "toolbar", "aria-label": "Bulk actions" });
    }

    function syncBulkBar() {
      if (!S.els.bulkBar) return;
      S.els.bulkBar.classList.toggle("is-on", S.sel.on);
      for (const id of [...S.sel.set]) if (!S.ids.includes(id)) S.sel.set.delete(id);
      const n = S.sel.set.size;
      const allStarred = n > 0 && [...S.sel.set].every((id) => activity.isStarred(id));
      dom.replace(S.els.bulkBar,
        n
          ? [h("span.bulk-count", icons.icon("check", 13), h("b", String(n)), ` selected`),
            h("button.btn.btn-icon.btn-ghost.bulk-x", { "aria-label": "Clear selection", title: "Clear selection", onClick: () => { S.sel.set.clear(); S.sel.last = -1; S.grid.each((t) => t.update()); syncBulkBar(); } }, icons.icon("x", 14)),
            W.btn("", { icon: "star", title: allStarred ? "Unstar all" : "Star all", onClick: () => bulkApply((id) => activity.toggleStar(id, !allStarred), { keep: true, msg: allStarred ? "Stars removed" : "Starred" }) }),
            W.btn("Hide", { icon: "eyeOff", title: "Hide from library", onClick: () => bulkApply((id) => activity.toggleHidden(id, true), { msg: "Hidden from library", undo: (ids) => activity.bulk(() => { for (const id of ids) activity.toggleHidden(id, false); }) }) }),
            W.btn("", { icon: "play", title: "Watch selection", onClick: () => { const ids = [...S.sel.set]; toggleBulk(false); actions.watch(ids, 0, { label: "Selection" }); } }),
            W.btn("", { icon: "folder", title: "Add to collection", onClick: () => actions.addToCollection([...S.sel.set]) }),
            W.btn("", { icon: "copy", title: "Copy links", onClick: async () => { const links = [...S.sel.set].map((id) => catalog.post(id)?.url).filter(Boolean).join("\n"); const ok = links && await platform.copy(links); actions.toast(ok ? `${n} link${n === 1 ? "" : "s"} copied` : "Couldn't copy links", ok ? "success" : "error"); } }),
            W.btn("Done", { icon: "check", kind: "primary", onClick: () => toggleBulk(false) })]
          : [h("span.bulk-hint", "Click posts to select · Shift-click for a range"),
            W.btn("All", { icon: "check", title: "Select all shown", onClick: () => { S.ids.forEach((id) => S.sel.set.add(id)); S.grid.each((t) => t.update()); syncBulkBar(); } }),
            W.btn("Cancel", { icon: "x", onClick: () => toggleBulk(false) })]);
    }

    /* ------------------------------------------------------------ misc -- */
    function onActivity({ kind, ids }) {
      if (kind === "bulk" || kind === "hide" || (kind === "star" && S.spec.state === "starred") || (kind === "seen" && (S.spec.state === "seen" || S.spec.state === "unseen")) || kind === "collection" && S.spec.collection) runQuery(false);
      else { S.grid.each((t) => { if (!ids.length || ids.includes(t.post.id)) t.update(); }); renderChips(); }
    }
    function shuffle() { setSpec({ sort: "random", seed: Math.floor(Math.random() * 99999) + 1 }); }
    function viewsMenu(anchor) {
      const views = activity.views();
      menu.open(anchor, [
        { label: "Save current view…", icon: "save", run: async () => { const name = await dialog.prompt("", { title: "Save this view", placeholder: "e.g. Unseen shorts", value: engine.describe(S.spec) }); if (name) { activity.saveView(name, engine.toParams(S.spec)); actions.toast("View saved", "success"); } } },
        views.length ? { sep: true } : null,
        ...views.map((v) => ({ label: v.name, icon: "view", run: () => nav.setQuery(v.spec, { replace: false }), hint: "" })),
        views.length ? { sep: true } : null,
        views.length ? { label: "Delete a view…", icon: "trash", danger: true, run: async () => { const id = await dialog.choose("Delete which view?", views.map((v) => ({ id: v.name, label: v.name, icon: "view" }))); if (id) activity.deleteView(id); } } : null,
      ], { title: "Saved views", align: "end" });
    }
    function showSyntax() {
      dialog.open({ title: "Search syntax", size: "md", body: h("div.syntax",
        h("p", "Words match the caption, creator name and handle. All words must match; use OR between groups."),
        h("table.syntax-table", [
          ["@user", "posts by a creator"], ["#tag", "hashtag"], ["\"exact phrase\"", "phrase match"], ["-word", "exclude"],
          ["is:short · is:long · is:video · is:photo · is:carousel · is:gif", "media kind"], ["is:unseen · is:seen · is:starred", "your state"],
          ["dur:>5m · dur:<30s · dur:1m-3m", "video duration"], ["likes:>10k · views:>1m", "metrics"], ["before:2025-01 · after:2024-06", "posted date"], ["saved:2025-10", "month bookmarked"],
          ["has:quote · has:link · has:text", "attributes"], ["sort:likes · sort:random · sort:oldest", "sort inside the query"],
        ].map(([k, v]) => h("tr", h("td", h("code", k)), h("td", v))))) });
    }

    return {
      id: "library", title: "Library", icon: "grid", route: "/library", nav: true, order: 20, key: "l",
      mount, unmount, update,
      pageTitle: () => "Library",
      commands: () => [
        { id: "library.unseen", title: "Library: unseen posts", icon: "eye", run: () => nav.go("library", {}, { state: "unseen" }) },
        { id: "library.starred", title: "Library: starred", icon: "star", run: () => nav.go("library", {}, { state: "starred" }) },
        { id: "library.shorts", title: "Library: shorts", icon: "zap", run: () => nav.go("library", {}, { kind: "short" }) },
        { id: "library.photos", title: "Library: photos", icon: "image", run: () => nav.go("library", {}, { kind: "photo" }) },
        { id: "library.shuffle", title: "Library: shuffle order", icon: "shuffle", run: () => nav.go("library", {}, { sort: "random", seed: Date.now() % 99999 }) },
        ...activity.views().map((v) => ({ id: "view:" + v.name, title: "View: " + v.name, icon: "view", run: () => nav.go("library", {}, v.spec) })),
      ],
    };
  });
