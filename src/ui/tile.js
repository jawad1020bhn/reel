/* ui.tile — the post card used by rails and grids: a 10px-radius artwork card with an
   always-on readability scrim, dark meta chips, a crimson corner tag for fresh saves,
   and a 500ms hover-intent that opens the floating preview card (ui.preview) instead
   of scaling the tile.
   createTile(post, ctx, opts) → { el, post, update(), destroy() }

   ctx  : { thumb(media,width), avatar(post,px), isSeen(id), isStarred(id), progressOf(post), kindOf(post), sources(media) }
    opts : { width, shape: natural|portrait|poster|square, info: hover|always|never, blur, seenDim, hoverPreview, priority, vibrate(ms),
             tag, onOpen(post, e), onMenu(post, e), onStar(post), onHide(post), onCreator(username), index,
             selectActive(): bool, onToggleSelect(post, e), isSelected(post): bool } */
XR.define("ui.tile", ["ui.dom", "ui.icons", "ui.preview"], function (dom, icons, preview) {
  "use strict";
  const h = dom.h;

  function aspectFor(post, shape) {
    if (shape === "square") return 1;
    if (shape === "portrait") return 3 / 4;
    if (shape === "poster") return 2 / 3;
    if (shape === "wide") return 16 / 9;
    const m = post.media[0];
    const a = m ? m.aspect || 1 : 1;
    return Math.min(2.2, Math.max(0.5, a));
  }

  function createTile(post, ctx, opts = {}) {
    const media = post.media[0];
    const kind = ctx.kindOf(post);
    const width = opts.width || 240;
    const aspect = aspectFor(post, opts.shape || "natural");

    /* priority tiles (first row of the first shelves) skip lazy loading and fetch at high priority */
    const img = h("img.tile-img", { alt: media?.alt || "", loading: opts.priority ? "eager" : "lazy", decoding: "async", draggable: false, fetchpriority: opts.priority ? "high" : undefined });
    const reveal = () => img.classList.add("is-loaded");
    img.addEventListener("load", reveal, { once: true });
    if (media) {
      const src = ctx.thumb(media, width);
      if (opts.lazy && ctx.lazy) ctx.lazy(img, src); else img.src = src;
      if (img.complete && img.naturalWidth > 0) reveal();
      img.addEventListener("error", (e) => { if (!img.dataset.fallback && media.poster && media.poster !== media.thumb) { img.dataset.fallback = "1"; img.src = ctx.thumb({ ...media, thumb: media.poster }, width); } else { reveal(); el.classList.add("tile-broken"); } }, { once: false });
    } else reveal();

    /* dark meta chips, bottom-left over the scrim */
    const badges = h("div.tile-badges");
    if (kind === "gif") badges.appendChild(h("span.badge.badge-dark", "GIF"));
    else if (media && media.kind === "video" && media.duration) badges.appendChild(h("span.badge.badge-dark", icons.icon("play", 10, { filled: true }), dom.duration(media.duration)));
    if (post.media.length > 1) badges.appendChild(h("span.badge.badge-dark", icons.icon("layers", 11), String(post.media.length)));
    const flagBadge = h("span.badge.badge-flag", { style: { display: "none" } });
    badges.appendChild(flagBadge);
    if (media && media.posterOnly) { flagBadge.style.display = ""; flagBadge.replaceChildren(icons.icon("image", 10), "poster"); flagBadge.title = "Only the poster frame is available"; }

    const tag = opts.tag ? h("span.tile-tag", opts.tag) : null;
    const star = h("span.tile-star", icons.icon("star", 13, { filled: true }));
    const progress = h("div.tile-progress", h("i"));
    const more = h("button.tile-more", { "aria-label": "More", onclick: (e) => { e.stopPropagation(); opts.onMenu?.(post, e); } }, icons.icon("more", 15));
    const check = opts.onToggleSelect ? h("span.tile-check", { "aria-hidden": "true" }, icons.icon("check", 13)) : null;

    const info = opts.info === "never" ? null : h("div.tile-info",
      h("button.tile-creator", { onclick: (e) => { e.stopPropagation(); opts.onCreator?.(post.author.username); } },
        post.author.avatar ? h("img.avatar.avatar-xs", { src: ctx.avatar(post, 24), alt: "", loading: "lazy" }) : h("span.avatar.avatar-xs.avatar-fallback", post.author.username[0]?.toUpperCase()),
        h("span.tile-handle", "@" + post.author.username)),
      post.metrics.likes ? h("span.tile-likes", icons.icon("heart", 11, { filled: true }), dom.compact(post.metrics.likes)) : null,
      post.text ? h("p.tile-caption", post.text) : null);

    const el = h("article.tile", {
      class: `tile-${kind} ${opts.info === "always" ? "tile-info-always" : ""}`,
      dataset: { id: post.id, index: opts.index ?? "" },
      "aria-label": `${post.author.name}: ${post.text ? post.text.slice(0, 80) : kind}`,
      style: { "--aspect": aspect.toFixed(3) },
    }, h("div.tile-media", h("span.tile-skel", { "aria-hidden": "true" }), img, h("div.tile-scrim"), badges, tag, star, progress, more, check, kind === "short" || kind === "long" ? h("span.tile-play", icons.icon("play", 24, { filled: true })) : null), info);

    const opener = h("button.tile-open", { type: "button", "aria-label": `${post.author.name}: ${post.text ? post.text.slice(0, 80) : kind}` });
    el.querySelector(".tile-media").prepend(opener);
    /* Hover-only metadata is a closed supplementary interface, not invisible
       interactive content. Make it inert until pointer/keyboard focus reveals
       it. Compact phone rows and the explicit Always preference stay exposed. */
    let infoFocusFrame = 0;
    function syncInfo() {
      if (!info) return;
      const compact = document.documentElement.dataset.hover !== "on" || innerWidth < 768;
      const expanded = opts.info === "always" || compact || el.matches(":hover, :focus-within");
      info.inert = !expanded;
      info.setAttribute("aria-hidden", expanded ? "false" : "true");
    }
    el.addEventListener("pointerenter", syncInfo);
    el.addEventListener("pointerleave", syncInfo);
    el.addEventListener("focusin", syncInfo);
    el.addEventListener("focusout", () => { cancelAnimationFrame(infoFocusFrame); infoFocusFrame = requestAnimationFrame(syncInfo); });
    window.addEventListener("resize", syncInfo, { passive: true });
    syncInfo();
    const open = (e) => {
      if (opts.onToggleSelect && opts.selectActive?.()) { opts.onToggleSelect(post, e); return; }
      opts.onOpen?.(post, e);
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.target === opener && e.key === "s" && opts.onStar) { e.preventDefault(); opts.onStar(post); } });
    /* Android fires contextmenu for the same long-press that already opened the
       sheet at 450ms. Whichever arrives first wins; the other is swallowed. */
    let lastLongPress = 0;
    el.addEventListener("contextmenu", (e) => {
      if (!opts.onMenu) return;
      e.preventDefault();
      if (Date.now() - lastLongPress < 900) return;
      cancelPress();
      opts.onMenu(post, e);
    });

    /* touch long-press → the post sheet (iOS Safari does not fire contextmenu for touch);
       cancelled by any scroll/drag, and the click that follows the release is swallowed */
    let pressTimer = 0, pressed = false, px = 0, py = 0;
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = 0; };
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" || !opts.onMenu || opts.selectActive?.()) return;
      px = e.clientX; py = e.clientY; pressed = false;
      cancelPress();
      pressTimer = setTimeout(() => { pressTimer = 0; pressed = true; lastLongPress = Date.now(); opts.vibrate?.(12); opts.onMenu(post, e); }, 450);
    }, { passive: true });
    el.addEventListener("pointermove", (e) => { if (pressTimer && (Math.abs(e.clientX - px) > 10 || Math.abs(e.clientY - py) > 10)) cancelPress(); }, { passive: true });
    el.addEventListener("pointerup", cancelPress, { passive: true });
    el.addEventListener("pointercancel", cancelPress, { passive: true });
    el.addEventListener("click", (e) => { if (pressed) { pressed = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    if (opts.blur) el.classList.add("tile-blur");

    /* hover-intent → the floating preview card zooms out of this tile (desktop) */
    let hoverTimer = 0;
    if (opts.hoverPreview) {
      el.addEventListener("pointerenter", (e) => {
        if (e.pointerType === "touch" || opts.selectActive?.()) return;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
          if (!el.isConnected) return;
          preview.open({ el, post, ctx, opts: { ...opts, width } });
        }, 500);
      });
      el.addEventListener("pointerleave", () => { clearTimeout(hoverTimer); preview.scheduleHide(); });
    }

    const api = {
      el, post,
      update() {
        el.classList.toggle("is-seen", !!(opts.seenDim && ctx.isSeen(post.id)));
        el.classList.toggle("is-starred", ctx.isStarred(post.id));
        const dead = !!(ctx.isUnavailable && ctx.isUnavailable(post.id));
        el.classList.toggle("is-unavailable", dead);
        if (dead) { flagBadge.style.display = ""; flagBadge.replaceChildren(icons.icon("alert", 10), "gone"); flagBadge.title = "This media is no longer available on X"; }
        else if (!(media && media.posterOnly)) flagBadge.style.display = "none";
        const dup = ctx.isDuplicate && ctx.isDuplicate(post.id);
        el.classList.toggle("is-dup", !!dup);
        el.classList.toggle("is-selected", opts.isSelected ? !!opts.isSelected(post) : false);
        const p = ctx.progressOf(post);
        progress.style.display = p > 0 ? "" : "none";
        progress.firstChild.style.width = (p * 100).toFixed(1) + "%";
      },
      destroy() {
        clearTimeout(hoverTimer); cancelPress(); cancelAnimationFrame(infoFocusFrame);
        window.removeEventListener("resize", syncInfo);
        if (preview.isOpenFor(post.id)) preview.close();
        if (ctx.unlazy) ctx.unlazy(img);
        el.remove();
      },
    };
    api.update();
    return api;
  }
  return { createTile, aspectFor };
});
