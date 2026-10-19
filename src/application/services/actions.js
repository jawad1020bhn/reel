/* app.actions — the verbs every surface shares (tile menus, viewer, watch, palette).
   Keeping them here means a feature never needs to know how another feature works:
   "watch these" just sets the feed context and navigates. */
XR.define("app.actions", ["app.activity", "app.catalog", "app.feedContext", "app.nav", "app.media", "app.ports.platform", "core.domain.model", "core.events", "core.domain.events"],
  function (activity, catalog, feed, nav, media, platform, model, events, EV) {
    "use strict";
    const toast = (message, kind = "info", extra) => events.bus.emit(EV.TOAST, { message, kind, ...extra });

    function star(post) { const on = activity.toggleStar(post.id); toast(on ? "Starred" : "Star removed", "success", { icon: "star", timeout: 1400 }); return on; }
    function hide(post) {
      const on = activity.toggleHidden(post.id);
      toast(on ? "Hidden from your library" : "Post restored", "info", { timeout: 4000, action: on ? { label: "Undo", run: () => activity.toggleHidden(post.id, false) } : undefined });
      return on;
    }
    const openOnX = (post) => platform.openExternal(post.url);
    async function copyLink(post) { const ok = await platform.copy(post.url); toast(ok ? "Link copied" : "Couldn't copy — " + post.url, ok ? "success" : "error"); }
    async function copyText(post) { const ok = await platform.copy(post.rawText || post.text); toast(ok ? "Caption copied" : "Couldn't copy", ok ? "success" : "error"); }
    const canShare = () => typeof platform.canShare === "function" ? platform.canShare() : false;
    async function share(post) {
      const url = post.url || "";
      const data = { title: post.author?.name ? `${post.author.name} on X` : "XReels", text: post.text ? post.text.slice(0, 280) : "", url };
      const ok = await platform.share(data);
      /* A cancelled share sheet also resolves false; only fall back when the API is absent. */
      if (!ok && !canShare()) { const copied = await platform.copy(url); toast(copied ? "Link copied" : "Couldn't share", copied ? "success" : "error"); }
      return ok;
    }
    function download(post, index = 0) { const m = post.media[index] || post.media[0]; if (m) media.open(m); }

    /** Watch a list starting at index: feed context + navigate. */
    function watch(ids, index = 0, meta = {}) { feed.set(ids, index, meta); nav.go("watch"); }
    function view(ids, index = 0, meta = {}) { events.bus.emit(EV.VIEWER_OPEN, { ids, index, ...meta }); }
    /** Opens a tile: "viewer" | "watch" | "auto". Auto = each player gets what it is
        best for: video posts (short, long, gif) continue into the Watch feed;
        photos and albums open the Viewer theatre for browsing. */
    function open(ids, index = 0, meta = {}, prefOpens) {
      const pref = prefOpens || "auto";
      if (pref === "watch") return watch(ids, index, meta);
      if (pref === "viewer") return view(ids, index, meta);
      const post = catalog.post(Array.isArray(ids) ? ids[index] : ids);
      const kind = post ? model.kindOf(post) : "photo";
      return (kind === "short" || kind === "long" || kind === "gif") ? watch(ids, index, meta) : view(ids, index, meta);
    }

    const goCreator = (username) => nav.go("creators", { user: username });
    const goTag = (tag) => nav.go("library", {}, { q: "#" + tag });
    const goCollection = (id) => nav.go("collections", { id });
    const goLibrary = (query = {}) => nav.go("library", {}, query);

    /** Ask the user which collection(s) to add posts to. Emits COLLECTION_PICK for the UI to answer. */
    function addToCollection(postIds) { events.bus.emit(EV.COLLECTION_PICK, { ids: Array.isArray(postIds) ? postIds : [postIds] }); }

    function shufflePlay(limit = 200, spec = {}) {
      const pool = catalog.query({ kind: "all", ...spec }).items;
      const picked = catalog.shuffle(pool, { limit });
      if (!picked.length) return toast("Nothing to play yet");
      watch(picked.map((p) => p.id), 0, { label: "Shuffle" });
    }

    return { star, hide, openOnX, copyLink, copyText, canShare, share, download, watch, view, open, goCreator, goTag, goCollection, goLibrary, addToCollection, shufflePlay, toast };
  });
