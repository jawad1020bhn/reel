/* features.library — the full archive as a filterable, windowed masonry grid.
   State lives in the URL (#/library?kind=short&state=unseen&q=…) so views are
   shareable between sessions and the back button just works. */
XR.define("features.library", ["ui.dom", "ui.icons", "ui.widgets", "ui.masonry", "ui.tiles", "ui.menu", "ui.dialog", "ui.keys", "app.catalog", "app.activity", "app.actions", "app.prefs", "app.nav", "app.ports.platform", "core.query.engine", "core.events", "core.domain.events", "core.util"],
  function (dom, icons, W, masonryUI, tiles, menu, dialog, keys, catalog, activity, actions, prefs, nav, platform, engine, events, EV, util) {
    "use strict";
    const h = dom.h;
    const S = { host: null, spec: engine.normalizeSpec({}), result: { items: [], total: 0 }, grid: null, els: {}, offs: [], queryTimer: 0, empty: null, sel: { on: false, set: new Set(), last: -1 } };

    const KIND_CHIPS = [["all", "All", "grid"], ["video", "Videos", "play"], ["short", "Shorts", "zap"], ["long", "Long", "film"], ["photo", "Photos", "image"], ["carousel", "Albums", "layers"], ["gif", "GIFs", "gif"]];
    const STATE_CHIPS = [["unseen", "Unseen", "eye"], ["starred", "Starred", "star"], ["progress", "In progress", "clock"], ["seen", "Seen", "check"], ["hidden", "Hidden", "eyeOff"]];
    const SORT_OPTIONS = [["saved", "Recently saved"], ["newest", "Newest posted"], ["oldest", "Oldest posted"], ["likes", "Most liked"], ["views", "Most viewed"], ["longest", "Longest"], ["shortest", "Shortest"], ["creator", "By creator"], ["random", "Shuffled"]];
    /* Filters that have no chip of their own: they only exist in the Filters sheet,
       so the badge counts exactly these and nothing else. */
    const SHEET_FILTERS = ["creator", "collection", "month", "savedMonth"];

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
      const head = h("header.page-head", h("div", h("h1.page-title", "Library"),
        h("p.page-sub.lib-count", h("span.lib-count-n"), h("span.lib-sort-note"))));
      page.append(head, toolbar, chips, gridHost);
      outlet.appendChild(page);
      /* The bar is fixed to the viewport, so it cannot live under the page's
         entry animation: that transform would make it a page-height anchor. */
      document.body.appendChild(bulkBar);
      S.els = { page, head, toolbar, chips, gridHost, bulkBar };
      renderToolbar();
      S.grid = masonryUI.createMasonry(gridHost, {
        scroller: outlet, colMin: colMin(), gap: gapPx(), overscan: 900,
        minCols: innerWidth < 700 ? 2 : 1,
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
      return masonryUI.createMasonry(S.els.gridHost, { scroller: S.host, colMin: colMin(), gap: gapPx(), overscan: 900, minCols: innerWidth < 700 ? 2 : 1, aspectOf: (p) => tiles.aspectOf(p), extraHeight: () => tiles.infoHeight(), render: (post, i, w) => tiles.make(post, { ids: S.ids, index: i, label: label(), width: w, ...selectOpts() }) });
    }
    const colMin = () => ({ compact: 140, cozy: 180, comfortable: 230 }[prefs.get("density")] || 180);
    const gapPx = () => ({ compact: 6, cozy: 10, comfortable: 14 }[prefs.get("density")] || 10);
    const label = () => engine.describe(S.spec);

    function unmount() {
      for (const off of S.offs) off(); S.offs = [];
      keys.pop("library"); keys.unbindScope("library");
      S.els.bulkBar?.remove();
      S.sel = { on: false, set: new Set(), last: -1 };
      S.grid?.destroy(); S.grid = null; S.host = null; S.ids = [];
    }
    function update(route) {
      const next = engine.fromParams(route.query);
      const changed = JSON.stringify(next) !== JSON.stringify(S.spec);
      S.spec = next;
      if (changed) { syncToolbar(); runQuery(); }
    }

    /* The toolbar is built once; typing must never lose focus to a re-render.
       One control, one home, one hierarchy: search leads, ordering and filters
       narrow the deck, and the three grid actions sit behind a hairline. */
    function renderToolbar() {
      const { toolbar } = S.els;
      const narrow = innerWidth < 900;
      const q = h("input.input.lib-search", {
        type: "search", placeholder: narrow ? "Search…" : "Search… @user #tag is:short dur:>5m",
        value: S.spec.q, autocomplete: "off", spellcheck: false, "aria-label": "Search library",
        oninput: () => { clearTimeout(S.queryTimer); S.queryTimer = setTimeout(() => setSpec({ q: q.value.trim() }), 260); },
        onkeydown: (e) => { if (e.key === "Escape") { q.value = ""; setSpec({ q: "" }); q.blur(); } if (e.key === "Enter") { clearTimeout(S.queryTimer); setSpec({ q: q.value.trim() }); } },
      });
      const sort = W.select(SORT_OPTIONS.map(([value, label]) => ({ value, label })), S.spec.sort, (v) => setSpec({ sort: v, seed: v === "random" ? util.daySeed() : 0 }), { cls: "lib-sort" });
      sort.setAttribute("aria-label", "Sort order");
      const filterCount = h("span.lib-filter-count", { hidden: true });
      const filterBtn = h("button.btn.lib-filter", { "aria-haspopup": "dialog", onclick: () => openFilters() },
        icons.icon("sliders", 16), h("span.lib-act-label", "Filters"), filterCount);
      const selectBtn = W.btn("Select", { icon: "check", kind: "ghost", title: "Select posts (v)", cls: "lib-act", onClick: () => toggleBulk() });
      const shuffleBtn = W.btn("", { icon: "shuffle", kind: "ghost", title: "Shuffle (r)", cls: "lib-act", onClick: shuffle });
      const viewsBtn = W.btn("", { icon: "bookmark", kind: "ghost", title: "Saved views", cls: "lib-act", onClick: (e) => viewsMenu(e.currentTarget) });
      const moreBtn = W.iconBtn("more", "More actions", (e) => moreMenu(e.currentTarget), { cls: "lib-more" });
      viewsBtn.setAttribute("aria-haspopup", "menu");
      moreBtn.setAttribute("aria-haspopup", "menu");
      dom.replace(toolbar,
        h("div.lib-search-wrap", icons.icon("search", 16), q,
          h("button.btn.btn-icon.btn-ghost.lib-help", { title: "Search syntax", "aria-label": "Search syntax help", onclick: showSyntax }, icons.icon("info", 16))),
        h("div.lib-controls",
          h("div.lib-sort-wrap", icons.icon("sort", 15), sort),
          filterBtn,
          h("div.lib-act-group", selectBtn, shuffleBtn, viewsBtn),
          moreBtn));
      S.els.search = q; S.els.sort = sort; S.els.filterBtn = filterBtn; S.els.filterCount = filterCount;
      syncToolbar();
    }

    /** Badge = filters that are only visible inside the sheet. Kind, state and the
        query each show their own state on the page, so they never inflate it. */
    const filterCount = () => SHEET_FILTERS.filter((k) => S.spec[k]).length;
    const hasFilters = () => ["q", "kind", "state", ...SHEET_FILTERS].some((k) => S.spec[k] && S.spec[k] !== "all");

    /** Clear what narrows the list, and keep how it is ordered. */
    function clearFilters() {
      setSpec({ q: "", kind: "all", state: "all", creator: "", collection: "", month: "", savedMonth: "" });
      S.els.filterBtn?.focus({ preventScroll: true });
    }

    /** Reflect spec changes without rebuilding inputs. */
    function syncToolbar() {
      const { sort, search, filterCount: badge, filterBtn } = S.els;
      if (sort && sort.value !== (S.spec.sort || "saved")) sort.value = S.spec.sort || "saved";
      if (search && document.activeElement !== search && search.value !== (S.spec.q || "")) search.value = S.spec.q || "";
      const n = filterCount();
      if (badge) {
        const was = badge.hidden ? 0 : Number(badge.textContent);
        badge.hidden = n === 0;
        badge.textContent = String(n);
        if (n && n !== was) { badge.classList.remove("is-bump"); void badge.offsetWidth; badge.classList.add("is-bump"); }
      }
      if (filterBtn) filterBtn.setAttribute("aria-label", n ? `Filters, ${n} applied` : "Filters");
    }

    function field(label, control) {
      return h("label.filter-field", h("span.filter-label", label), control);
    }

    /** The rest of the filters live in one sheet: the facets the chips cannot show.
        Ordering joins them on phones, where the toolbar keeps only search + filters. */
    function openFilters() {
      const narrow = innerWidth < 700;
      const sort = narrow ? W.select(SORT_OPTIONS.map(([value, label]) => ({ value, label })), S.spec.sort, (v) => setSpec({ sort: v, seed: v === "random" ? util.daySeed() : 0 }), { cls: "filter-control" }) : null;
      const creator = W.select([{ value: "", label: "Any creator" }, ...catalog.creators().map((c) => ({ value: c.username, label: `@${c.username} · ${c.count}` }))], S.spec.creator, (v) => setSpec({ creator: v }), { cls: "filter-control" });
      const collection = W.select([{ value: "", label: "Any collection" }, ...activity.collections().map((c) => ({ value: c.id, label: `${c.name} · ${c.ids.length}` }))], S.spec.collection, (v) => setSpec({ collection: v }), { cls: "filter-control" });
      const month = W.select([{ value: "", label: "Any month posted" }, ...catalog.months.map((m) => ({ value: m.key, label: `${m.label} · ${m.count}` }))], S.spec.month, (v) => setSpec({ month: v }), { cls: "filter-control" });
      const saved = W.select([{ value: "", label: "Any month saved" }, ...catalog.savedMonths.map((m) => ({ value: m.key, label: `${m.label} · ${m.count}` }))], S.spec.savedMonth, (v) => setSpec({ savedMonth: v }), { cls: "filter-control" });
      const body = h("div.filter-sheet",
        sort ? field("Sort by", sort) : null,
        field("Creator", creator),
        field("Collection", collection),
        h("div.filter-pair", field("Month posted", month), field("Month saved", saved)),
        h("p.muted.small", "Media type and state are the chips above the grid."));
      dialog.open({
        title: narrow ? "Sort & filter" : "Filters", size: "sm", body,
        actions: [
          hasFilters() ? { label: "Clear filters", kind: "ghost", run: () => clearFilters() } : null,
          { label: "Done", kind: "primary" },
        ].filter(Boolean),
      });
    }

    const chipFor = (key, el) => { el.dataset.chip = key; return el; };
    const chipGroup = (label, list) => h("div.chip-row", { role: "group", "aria-label": label + " filters" },
      h("span.chip-row-label", { "aria-hidden": "true" }, label), h("div.chip-row-body", list));

    /** Counts read as "what would I get if I switched", with the rest of the
        query applied — a filter never advertises results it cannot reach. */
    const chipCounts = (key, list) => {
      const out = {};
      for (const [value] of list) out[value] = catalog.query({ ...S.spec, [key]: value }).total;
      return out;
    };

    function renderChips() {
      const { chips } = S.els;
      const focusKey = chips.contains(document.activeElement) ? document.activeElement.dataset.chip : null;
      const kc = chipCounts("kind", KIND_CHIPS);
      const sc = chipCounts("state", STATE_CHIPS);
      const kindRow = chipGroup("Type", KIND_CHIPS.map(([value, label, icon]) =>
        chipFor("kind:" + value, W.chip({ label, icon, count: kc[value], active: S.spec.kind === value, onClick: () => setSpec({ kind: S.spec.kind === value ? "all" : value }) }))));
      const stateRow = chipGroup("State", STATE_CHIPS.map(([value, label, icon]) =>
        chipFor("state:" + value, W.chip({ label, icon, count: sc[value], active: S.spec.state === value, onClick: () => setSpec({ state: S.spec.state === value ? "all" : value }) }))));
      const applied = [];
      if (S.spec.creator) applied.push(chipFor("creator", W.chip({ label: "@" + S.spec.creator, icon: "users", active: true, onRemove: () => setSpec({ creator: "" }) })));
      if (S.spec.collection) { const c = activity.collection(S.spec.collection); applied.push(chipFor("collection", W.chip({ label: c ? c.name : "Collection", icon: "folder", active: true, onRemove: () => setSpec({ collection: "" }) }))); }
      if (S.spec.month) applied.push(chipFor("month", W.chip({ label: "Posted " + S.spec.month, icon: "calendar", active: true, onRemove: () => setSpec({ month: "" }) })));
      if (S.spec.savedMonth) applied.push(chipFor("savedMonth", W.chip({ label: "Saved " + S.spec.savedMonth, icon: "bookmark", active: true, onRemove: () => setSpec({ savedMonth: "" }) })));
      if (S.spec.q) applied.push(chipFor("q", W.chip({ label: `“${util.truncate(S.spec.q, 30)}”`, icon: "search", active: true, onRemove: () => setSpec({ q: "" }) })));
      if (applied.length) applied.push(W.chip({ label: "Clear filters", icon: "x", cls: "chip-ghost", onClick: clearFilters }));
      dom.replace(chips, kindRow, stateRow, applied.length ? chipGroup("Applied", applied) : null);
      /* Replacing the row would drop keyboard focus with it; put it back. */
      if (focusKey) chips.querySelector(`[data-chip="${focusKey}"]`)?.focus({ preventScroll: true });
    }

    function runQuery(resetScroll = true) {
      if (!S.host) return;
      S.result = catalog.query(S.spec);
      S.ids = S.result.items.map((p) => p.id);
      renderChips();
      const countEl = S.els.page.querySelector(".lib-count");
      if (countEl) {
        /* Say the number once. When filters are on, the second number is the
           whole archive, so "1 of 41" explains what the filters cost. */
        const n = S.result.total, all = catalog.query({}).total;
        const narrowed = hasFilters() && n !== all;
        const countN = countEl.querySelector(".lib-count-n");
        if (countN) countN.textContent = narrowed ? `${dom.compact(n)} of ${dom.compact(all)} ${all === 1 ? "post" : "posts"}` : `${dom.compact(n)} ${n === 1 ? "post" : "posts"}`;
        /* Phones fold sorting into the sheet, so the order needs a visible home. */
        const note = countEl.querySelector(".lib-sort-note");
        if (note) note.textContent = S.spec.sort && S.spec.sort !== "saved" ? (SORT_OPTIONS.find(([v]) => v === S.spec.sort) || [])[1] || "" : "";
        countEl.title = engine.describe(S.spec);
      }
      if (resetScroll) S.host.scrollTop = 0;
      S.grid.setItems(S.result.items);
      if (S.empty) { S.empty.remove(); S.empty = null; }
      if (!S.result.items.length) {
        const emptyLib = !catalog.posts.length;
        S.empty = W.empty({
          icon: emptyLib ? "inbox" : S.spec.state === "hidden" ? "eyeOff" : "search",
          title: emptyLib ? "Your library is empty" : "No posts match",
          text: emptyLib ? "Import an X bookmarks export to start your private cinema." : S.spec.q ? "Try fewer words, or open the search syntax guide." : "Try another filter — or clear them all to see everything.",
          action: { label: emptyLib ? "Import posts" : "Clear filters", icon: emptyLib ? "upload" : "refresh", run: () => (emptyLib ? nav.go("import") : clearFilters()) },
        });
        S.els.gridHost.appendChild(S.empty);
      }
      syncToolbar();
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

    async function copyLinks() {
      const ids = [...S.sel.set];
      const links = ids.map((id) => catalog.post(id)?.url).filter(Boolean).join("\n");
      const ok = links && await platform.copy(links);
      actions.toast(ok ? `${ids.length} link${ids.length === 1 ? "" : "s"} copied` : "Couldn't copy links", ok ? "success" : "error");
    }

    /** Phones keep the four actions that matter and fold the rest in here. */
    function bulkMenu(anchor) {
      menu.open(anchor, [
        { label: "Hide from library", icon: "eyeOff", run: () => bulkApply((id) => activity.toggleHidden(id, true), { msg: "Hidden from library", undo: (ids) => activity.bulk(() => { for (const id of ids) activity.toggleHidden(id, false); }) }) },
        { label: "Add to collection", icon: "folder", run: () => actions.addToCollection([...S.sel.set]) },
        { label: "Copy links", icon: "copy", run: copyLinks },
      ], { title: `${S.sel.set.size} selected`, align: "end" });
    }

    function syncBulkBar() {
      if (!S.els.bulkBar) return;
      S.els.bulkBar.classList.toggle("is-on", S.sel.on);
      for (const id of [...S.sel.set]) if (!S.ids.includes(id)) S.sel.set.delete(id);
      const n = S.sel.set.size;
      const narrow = innerWidth < 700;
      const allStarred = n > 0 && [...S.sel.set].every((id) => activity.isStarred(id));
      const watch = W.btn("", { icon: "play", title: "Watch selection", onClick: () => { const ids = [...S.sel.set]; toggleBulk(false); actions.watch(ids, 0, { label: "Selection" }); } });
      const more = narrow ? W.iconBtn("more", "More selection actions", (e) => bulkMenu(e.currentTarget)) : null;
      if (more) more.setAttribute("aria-haspopup", "menu");
      dom.replace(S.els.bulkBar,
        n
          ? [h("span.bulk-count", narrow ? null : icons.icon("check", 13), h("b", String(n)), ` selected`),
            narrow ? null : h("button.btn.btn-icon.btn-ghost.bulk-x", { "aria-label": "Clear selection", title: "Clear selection", onClick: () => { S.sel.set.clear(); S.sel.last = -1; S.grid.each((t) => t.update()); syncBulkBar(); } }, icons.icon("x", 14)),
            W.btn("", { icon: "star", title: allStarred ? "Unstar all" : "Star all", onClick: () => bulkApply((id) => activity.toggleStar(id, !allStarred), { keep: true, msg: allStarred ? "Stars removed" : "Starred" }) }),
            narrow ? watch : W.btn("Hide", { icon: "eyeOff", title: "Hide from library", onClick: () => bulkApply((id) => activity.toggleHidden(id, true), { msg: "Hidden from library", undo: (ids) => activity.bulk(() => { for (const id of ids) activity.toggleHidden(id, false); }) }) }),
            narrow ? more : W.btn("", { icon: "folder", title: "Add to collection", onClick: () => actions.addToCollection([...S.sel.set]) }),
            narrow ? null : W.btn("", { icon: "copy", title: "Copy links", onClick: copyLinks }),
            narrow ? null : watch,
            W.btn("Done", { icon: "check", kind: "primary", onClick: () => toggleBulk(false) })]
          : [h("span.bulk-hint", narrow ? "Tap posts to select" : "Click posts to select · Shift-click for a range"),
            W.btn("All", { icon: "check", title: "Select all shown", onClick: () => { S.ids.forEach((id) => S.sel.set.add(id)); S.grid.each((t) => t.update()); syncBulkBar(); } }),
            W.btn("Cancel", { icon: "x", onClick: () => toggleBulk(false) })]);
    }

    /* ------------------------------------------------------------ misc -- */
    function onActivity({ kind, ids }) {
      if (kind === "bulk" || kind === "hide" || (kind === "star" && S.spec.state === "starred") || (kind === "seen" && (S.spec.state === "seen" || S.spec.state === "unseen")) || kind === "collection" && S.spec.collection) runQuery(false);
      else { S.grid.each((t) => { if (!ids.length || ids.includes(t.post.id)) t.update(); }); renderChips(); }
    }
    function shuffle() { setSpec({ sort: "random", seed: Math.floor(Math.random() * 99999) + 1 }); }
    /** Phones have no room for the three grid actions; they share one sheet. */
    function moreMenu(anchor) {
      menu.open(anchor, [
        { label: "Select posts", icon: "check", hint: "V", run: () => toggleBulk(true) },
        { label: "Shuffle", icon: "shuffle", hint: "R", run: shuffle },
        { label: "Saved views", icon: "bookmark", run: () => viewsMenu(anchor) },
        { sep: true },
        { label: "Search syntax", icon: "info", run: showSyntax },
      ], { title: "Library actions", align: "end" });
    }
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
