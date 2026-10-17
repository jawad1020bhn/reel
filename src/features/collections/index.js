/* features.collections — user-made playlists of posts. */
XR.define("features.collections", ["ui.dom", "ui.icons", "ui.widgets", "ui.dialog", "ui.menu", "ui.masonry", "ui.tiles", "app.catalog", "app.activity", "app.actions", "app.nav", "app.media", "core.events", "core.domain.events", "core.util"],
  function (dom, icons, W, dialog, menu, masonryUI, tiles, catalog, activity, actions, nav, media, events, EV, util) {
    "use strict";
    const h = dom.h;
    const S = { host: null, grid: null, offs: [], id: "" };

    function mount(outlet, route) {
      S.host = outlet; S.id = route.params.id || "";
      render();
      S.offs = [events.bus.on(EV.ACTIVITY_CHANGED, ({ kind, ids }) => { if (kind === "collection" || kind === "bulk" || kind === "hide") render(); else S.grid?.each((t) => { if (!ids.length || ids.includes(t.post.id)) t.update(); }); }), events.bus.on(EV.DATASET_CHANGED, render)];
    }
    function unmount() { for (const off of S.offs) off(); S.offs = []; S.grid?.destroy(); S.grid = null; S.host = null; }
    function update(route) { S.id = route.params.id || ""; render(); }
    function render() { S.grid?.destroy(); S.grid = null; dom.clear(S.host); if (S.id) renderOne(); else renderList(); }

    async function create() { const name = await dialog.prompt("", { title: "New collection", placeholder: "Name", ok: "Create" }); if (name) { const c = activity.createCollection(name); nav.go("collections", { id: c.id }); } }

    function renderList() {
      const colls = activity.collections();
      const starred = catalog.query({ state: "starred", sort: "saved" }).items;
      const progress = catalog.query({ state: "progress" }).items;
      const page = h("div.collections", W.pageHead("Collections", "Starred, in progress, and your own lists", W.btn("New collection", { icon: "plus", kind: "primary", onClick: create })));
      const cards = h("div.coll-cards",
        smartCard("Starred", starred, "star", "Everything you starred, newest first", () => actions.goLibrary({ state: "starred" })),
        smartCard("Continue watching", progress, "clock", "Pick up the clips you left unfinished", () => actions.goLibrary({ state: "progress" })),
        colls.map((c) => {
          const posts = catalog.postsByIds(c.ids);
          return h("button.coll-card", { onclick: () => nav.go("collections", { id: c.id }), oncontextmenu: (e) => { e.preventDefault(); collMenu(c, e); }, "aria-label": `${c.name} — ${posts.length} posts` },
            cover(posts), h("div.coll-card-text", h("b", icons.icon("layers", 13), h("span", c.name)), h("span.muted", `${posts.length} ${posts.length === 1 ? "post" : "posts"} · ${dom.relative(c.createdAt)}`)),
            h("span.coll-card-more", { role: "button", "aria-label": `Actions for ${c.name}`, onclick: (e) => { e.stopPropagation(); collMenu(c, e.currentTarget); } }, icons.icon("more", 18)));
        }));
      page.appendChild(cards);
      if (!colls.length) page.appendChild(h("p.muted.coll-hint", "Tip: ", h("span.kbd-tip", "press ", W.kbd("c"), " on any post, or "), "use the ⋯ menu to add it to a collection."));
      S.host.appendChild(page);
    }
    function smartCard(title, posts, icon, emptyText, run) {
      return h("button.coll-card.coll-smart", { class: posts.length ? "" : "is-empty", onclick: run, "aria-label": `${title} — ${posts.length} posts` },
        cover(posts, emptyText), h("div.coll-card-text", h("b", icons.icon(icon, 14), " ", h("span", title)), h("span.muted", `${posts.length} ${posts.length === 1 ? "post" : "posts"}`)));
    }
    function cover(posts, emptyText) {
      const withMedia = posts.filter((p) => p.media.length).slice(0, 4);
      if (!withMedia.length) {
        return h("div.coll-cover.n0",
          h("div.coll-cover-empty", icons.icon("folder", 26), h("span", emptyText || "Nothing here yet")));
      }
      return h("div.coll-cover", { class: "n" + withMedia.length },
        withMedia.map((p) => h("img", { src: media.thumb(p.media[0], 240), alt: "", loading: "lazy" })),
        posts.length > 4 ? h("span.coll-cover-count", `+${posts.length - 4}`) : null);
    }
    function collMenu(c, anchor) {
      menu.open(anchor, [
        { label: "Watch", icon: "play", run: () => { const ids = c.ids.filter((id) => catalog.post(id)); if (ids.length) actions.watch(ids, 0, { label: c.name }); } },
        { label: "Rename…", icon: "edit", run: async () => { const name = await dialog.prompt("", { title: "Rename collection", value: c.name }); if (name) activity.renameCollection(c.id, name); } },
        { label: "Open in Library", icon: "grid", run: () => actions.goLibrary({ collection: c.id }) },
        { sep: true },
        { label: "Delete", icon: "trash", danger: true, run: async () => { if (await dialog.confirm(`Delete “${c.name}”? Posts stay in your library.`, { ok: "Delete", danger: true })) { activity.deleteCollection(c.id); if (S.id === c.id) nav.go("collections"); } } },
      ], { title: c.name });
    }
    function renderOne() {
      const c = activity.collection(S.id);
      if (!c) { S.host.appendChild(W.empty({ icon: "folder", title: "Collection not found", action: { label: "All collections", run: () => nav.go("collections") } })); return; }
      const posts = catalog.postsByIds(c.ids);
      const ids = posts.map((p) => p.id);
      const gridHost = h("div.coll-grid");
      S.host.appendChild(h("div.coll-page",
        h("button.btn.btn-ghost.btn-sm.back-link", { onclick: () => nav.go("collections") }, icons.icon("arrowLeft", 14), " Collections"),
        W.pageHead(c.name, `${posts.length} posts · created ${dom.date(c.createdAt)}`,
          W.btn("Watch", { icon: "play", kind: "primary", onClick: () => ids.length && actions.watch(ids, 0, { label: c.name }) }),
          W.btn("Shuffle", { icon: "shuffle", onClick: () => ids.length && actions.watch(util.shuffle(ids, Date.now()), 0, { label: c.name }) }),
          W.btn("", { icon: "more", title: "More", onClick: (e) => collMenu(c, e.currentTarget) })),
        gridHost));
      S.grid = masonryUI.createMasonry(gridHost, { scroller: S.host, colMin: 180, gap: 10, minCols: 2, aspectOf: (p) => tiles.aspectOf(p), extraHeight: () => tiles.infoHeight(), render: (post, i, w) => tiles.make(post, { ids, index: i, label: c.name, width: w }) });
      S.grid.setItems(posts);
      if (!posts.length) gridHost.appendChild(W.empty({ icon: "folder", title: "Empty collection", text: "Add posts from any tile's ⋯ menu, or press c while watching." }));
    }
    return {
      id: "collections", title: "Collections", icon: "folder", route: "/collections/:id?", nav: true, order: 50, key: "o", back: true,
      mount, unmount, update,
      pageTitle: (route) => (route.params.id ? activity.collection(route.params.id)?.name || "Collection" : "Collections"),
      commands: () => [{ id: "collections.new", title: "New collection", icon: "plus", run: create }, ...activity.collections().map((c) => ({ id: "coll:" + c.id, title: "Collection: " + c.name, hint: `${c.ids.length} posts`, icon: "folder", run: () => nav.go("collections", { id: c.id }) }))],
    };
  });
