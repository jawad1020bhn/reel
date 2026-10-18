/* features.creators — list of creators and a creator page (their posts as a grid). */
XR.define("features.creators", ["ui.dom", "ui.icons", "ui.widgets", "ui.masonry", "ui.tiles", "app.catalog", "app.activity", "app.actions", "app.prefs", "app.nav", "app.media", "core.events", "core.domain.events", "core.util"],
  function (dom, icons, W, masonryUI, tiles, catalog, activity, actions, prefs, nav, media, events, EV, util) {
    "use strict";
    const h = dom.h;
    const S = { host: null, grid: null, offs: [], sort: "count", filter: "", user: "", kind: "all" };

    function mount(outlet, route) {
      S.host = outlet;
      S.user = route.params.user || "";
      S.kind = route.query.kind || "all";
      if (S.user) renderCreator(); else renderList();
      S.offs = [
        events.bus.on(EV.ACTIVITY_CHANGED, ({ ids }) => { S.grid?.each((t) => { if (!ids.length || ids.includes(t.post.id)) t.update(); }); }),
        events.bus.on(EV.DATASET_CHANGED, () => (S.user ? renderCreator() : renderList())),
      ];
    }
    function unmount() { for (const off of S.offs) off(); S.offs = []; S.grid?.destroy(); S.grid = null; S.host = null; }
    function update(route) { S.user = route.params.user || ""; S.kind = route.query.kind || "all"; S.grid?.destroy(); S.grid = null; if (S.user) renderCreator(); else renderList(); }

    /* ---------------------------------------------------------------- list -- */
    function renderList() {
      dom.clear(S.host);
      const all = catalog.creators(S.sort);
      const q = S.filter.toLowerCase();
      const list = q ? all.filter((c) => c.username.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) : all;
      const search = h("input.input.creator-search", { type: "search", placeholder: "Filter creators…", value: S.filter, "aria-label": "Filter creators", oninput: () => { S.filter = search.value; renderCards(); } });
      const page = h("div.creators",
        W.pageBar("Creators", `${all.length} accounts in your library`, search,
          W.segmented([{ value: "count", label: "Most saved" }, { value: "recent", label: "Recent" }, { value: "name", label: "A–Z" }], S.sort, (v) => { S.sort = v; renderList(); })),
        h("div.creator-cards"));
      S.host.appendChild(page);
      const cards = page.querySelector(".creator-cards");
      function renderCards() {
        const q2 = S.filter.toLowerCase();
        const l2 = q2 ? all.filter((c) => c.username.toLowerCase().includes(q2) || c.name.toLowerCase().includes(q2)) : all;
        dom.replace(cards, l2.slice(0, 400).map(card));
        if (l2.length > 400) cards.appendChild(h("p.muted.small", `Showing 400 of ${l2.length} — type to narrow down.`));
      }
      renderCards();
      void list;
    }
    function card(c) {
      const posts = catalog.postsByIds(c.ids).filter((p) => p.media.length);
      const thumbs = posts.slice(0, 3);
      const affinity = activity.creatorAffinity().get(c.username) || 0;
      return h("button.creator-card", { onclick: () => nav.go("creators", { user: c.username }), "aria-label": `@${c.username} — ${c.count} posts` },
        h("div.creator-thumbs", { "aria-hidden": "true" },
          thumbs.map((p) => h("img", { src: media.thumb(p.media[0], 220), alt: "", loading: "lazy", decoding: "async", class: prefs.get("blur") ? "blurred" : "" })),
          h("span.creator-thumbs-scrim"),
          h("span.creator-thumbs-glyph", icons.icon("play", 16, { filled: true }))),
        h("div.creator-row",
          W.avatar(media.avatar({ author: { avatar: c.avatar } }, 48), c.name, 40),
          h("div.creator-names", h("b", c.name), h("span.muted", "@" + c.username)),
          h("span.creator-go", icons.icon("chevronRight", 16))),
        h("div.creator-counts",
          h("span", icons.icon("bookmark", 12), dom.compact(c.count), " saved"),
          c.videos ? h("span", icons.icon("play", 12), c.videos, " videos") : null,
          c.photos ? h("span", icons.icon("image", 12), c.photos, " photos") : null,
          affinity ? h("span.affinity", { title: "Times you opened their posts" }, icons.icon("eye", 12), affinity, " opened") : null));
    }

    /* ------------------------------------------------------------- creator -- */
    function renderCreator() {
      dom.clear(S.host);
      const c = catalog.creator(S.user);
      if (!c) { S.host.appendChild(W.empty({ icon: "users", title: "Creator not found", text: `@${S.user} isn't in this library. It may not have been imported yet.`, action: { label: "All creators", run: () => nav.go("creators") } })); return; }
      const spec = { creator: c.username, kind: S.kind, sort: "newest" };
      const res = catalog.query(spec);
      const ids = res.items.map((p) => p.id);
      const seen = c.ids.filter((id) => activity.isSeen(id)).length;
      const heroArt = catalog.query({ creator: c.username, sort: "likes" }).items.find((p) => p.media.length) || res.items.find((p) => p.media.length);
      const head = h("header.creator-head",
        /* the hero wash is blurred 22px and dimmed: a small still is indistinguishable from a 900px one */
        heroArt ? h("div.creator-hero-art", { style: { backgroundImage: `url("${media.placeholder(heroArt.media[0])}")` }, "aria-hidden": "true" }) : null,
        W.avatar(media.avatar({ author: { avatar: c.avatar } }, 120), c.name, 88),
        h("div.creator-head-text",
          h("h1.page-title", c.name),
          h("p.muted", "@" + c.username, " · ", h("a.link.creator-x", { href: `https://x.com/${c.username}`, target: "_blank", rel: "noopener" }, "profile on X", icons.icon("external", 12))),
          h("div.creator-stats", W.stat(c.count, "saved"), W.stat(c.videos, "videos"), W.stat(c.photos, "photos"), W.stat(dom.compact(c.likes), "likes total"), W.stat(`${Math.round(seen / Math.max(1, c.count) * 100)}%`, "seen"), W.stat(dom.relative(c.lastSavedAt), "last saved"))),
        h("div.creator-actions",
          W.btn("Watch all", { icon: "play", kind: "primary", onClick: () => actions.watch(ids, 0, { label: "@" + c.username, spec }) }),
          W.btn("Shuffle", { icon: "shuffle", onClick: () => actions.watch(util.shuffle(ids, Date.now()), 0, { label: "@" + c.username + " shuffled" }) }),
          W.btn("In Library", { icon: "grid", onClick: () => actions.goLibrary({ creator: c.username }) })));
      const seg = W.segmented([{ value: "all", label: `All ${c.count}` }, { value: "video", label: `Videos ${c.videos}` }, { value: "photo", label: `Photos ${c.photos}` }], S.kind, (v) => nav.setQuery(v === "all" ? {} : { kind: v }));
      const gridHost = h("div.creator-grid");
      S.host.append(h("div.creator-page", h("button.btn.btn-ghost.btn-sm.back-link", { onclick: () => nav.go("creators") }, icons.icon("arrowLeft", 14), " All creators"), head, seg, gridHost));
      S.grid = masonryUI.createMasonry(gridHost, { scroller: S.host, colMin: 180, gap: 10, minCols: 2, aspectOf: (p) => tiles.aspectOf(p), extraHeight: () => tiles.infoHeight(), render: (post, i, w) => tiles.make(post, { ids, index: i, label: "@" + c.username, width: w }) });
      S.grid.setItems(res.items);
      if (!res.items.length) gridHost.appendChild(W.empty({ icon: "image", title: "No posts of this kind" }));
    }

    return {
      id: "creators", title: "Creators", icon: "users", route: "/creators/:user?", nav: true, order: 40, key: "c", back: true,
      mount, unmount, update,
      pageTitle: (route) => (route.params.user ? "@" + route.params.user : "Creators"),
      commands: () => catalog.creators("count").slice(0, 40).map((c) => ({ id: "creator:" + c.username, title: `@${c.username} · ${c.name}`, hint: `${c.count} posts`, icon: "users", run: () => nav.go("creators", { user: c.username }) })),
    };
  });
