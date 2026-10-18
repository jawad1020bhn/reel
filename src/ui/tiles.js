/* ui.tiles — glue between ui.tile and the application services, so features
   build tiles with one call and all respect the same preferences. */
XR.define("ui.tiles", ["ui.tile", "ui.postMenu", "app.media", "app.activity", "app.catalog", "app.actions", "app.prefs", "app.ports.mediaResolver", "app.ports.platform"],
  function (tile, postMenu, media, activity, catalog, actions, prefs, resolver, platform) {
    "use strict";
    const ctx = {
      thumb: (m, w) => media.thumb(m, w),
      avatar: (p, px) => media.avatar(p, px),
      lazy: (img, src) => media.lazy(img, src),
      unlazy: (img) => media.unlazy(img),
      isSeen: (id) => activity.isSeen(id),
      isStarred: (id) => activity.isStarred(id),
      progressOf: (p) => activity.progressOf(p),
      progressEntry: (id) => activity.progressEntry(id),
      kindOf: (p) => catalog.ctx.kindOf(p),
      sources: (m) => resolver.sources(m, { localDir: prefs.get("localMediaDir") }),
    };
    /**
     * make(post, { ids, index, label, width, shape, info, selectActive, onToggleSelect, isSelected })
     * ids/index/label describe the list the tile belongs to (for Watch/Viewer context).
     * selectActive()/onToggleSelect/isSelected opt the tile into library bulk-select mode.
     */
    function make(post, o = {}) {
      const ids = o.ids || [post.id];
      const index = o.index ?? 0;
      const meta = { label: o.label || "" };
      return tile.createTile(post, ctx, {
        width: o.width || 240, index,
        shape: o.shape || prefs.get("tileShape"),
        info: o.info || prefs.get("tileInfo"),
        blur: prefs.get("blur"), seenDim: prefs.get("seenDim"),
        hoverPreview: o.hoverPreview ?? (prefs.get("hoverPreview") && !platform.isTouch()),
        lazy: o.priority ? false : o.lazy !== false,
        priority: !!o.priority,
        onOpen: o.onOpen || ((p, e) => actions.open(ids, index, meta, e && (e.shiftKey || e.altKey) ? "watch" : prefs.get("tileOpens"))),
        onMenu: (p, e) => postMenu.open(p, e, { ids, index, label: meta.label }),
        onStar: (p) => actions.star(p),
        onHide: (p) => actions.hide(p),
        onCreator: (u) => actions.goCreator(u),
        tag: o.tag,
        vibrate: (ms) => platform.vibrate?.(ms),
        selectActive: o.selectActive,
        onToggleSelect: o.onToggleSelect,
        isSelected: o.isSelected,
      });
    }
    const aspectOf = (post) => tile.aspectFor(post, prefs.get("tileShape"));
    const infoHeight = () => (prefs.get("tileInfo") === "always" ? 54 : 0);
    return { make, ctx, aspectOf, infoHeight };
  });
