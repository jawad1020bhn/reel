/* ui.preview — the hover card. After 500ms of hover intent on a tile, the
   artwork itself zooms out of the thumbnail (FLIP, 380ms expo) at its own
   aspect ratio: no caption, no actions, no badges. Desktop only — touch
   devices never fire pointerenter, so phones keep the plain grid. */
XR.define("ui.preview", ["ui.dom"], function (dom) {
  "use strict";
  const h = dom.h;
  let card = null, hideTimer = 0, videoTimer = 0, currentKey = "";

  const MARGIN = 14;        // breathing room from the viewport edge
  const TOP_GUARD = 84;     // clears the sticky header
  const BOTTOM_GUARD = 16;
  const MAX_W = 520;        // the card never grows past this
  const MAX_H = 640;        // nor past this tall
  const VIDEO_DELAY = 900;  // beat before the muted preview takes over

  function isOpenFor(key) { return !!card && currentKey === key; }
  function cancelHide() { clearTimeout(hideTimer); }
  function scheduleHide() { cancelHide(); hideTimer = setTimeout(close, 220); }

  function close() {
    cancelHide(); clearTimeout(videoTimer);
    if (!card) return;
    const node = card; card = null; currentKey = "";
    node.classList.add("out");
    const v = node.querySelector("video");
    if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
    setTimeout(() => node.remove(), 200);
    window.removeEventListener("pointerdown", onDoc, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("keydown", onKey, true);
  }
  function onDoc(e) { if (card && !card.contains(e.target) && !e.target.closest(".tile")) close(); }
  function onScroll() { close(); }
  function onResize() { close(); }
  function onKey(e) { if (e.key === "Escape" && card) { e.stopPropagation(); close(); } }

  /** The media's own aspect ratio, from its intrinsic size when known. */
  function aspectOf(m) {
    if (m.width > 0 && m.height > 0) return m.width / m.height;
    if (m.aspect > 0) return m.aspect;
    return m.kind === "photo" ? 1 : 16 / 9;
  }

  /**
   * open({ el, post, ctx, opts })
   *   ctx : { thumb, poster, sources, progressEntry }
   *   opts: { onOpen(post,e) }
   *
   * The card is exactly the artwork: its width and height are derived from the
   * media ratio inside the viewport budget, and the still is requested at the
   * rendered size so nothing is upscaled or cropped.
   */
  function open({ el, post, ctx, opts = {} }) {
    close();
    const media = post.media && post.media[0];
    if (!media) return;
    const key = post.id;
    currentKey = key;

    /* size: a focused zoom out of the tile, never a full-screen takeover */
    const rect = el.getBoundingClientRect();
    const ar = aspectOf(media);
    const budgetW = Math.max(200, Math.min(MAX_W, innerWidth - MARGIN * 2));
    const budgetH = Math.max(180, Math.min(MAX_H, innerHeight - TOP_GUARD - BOTTOM_GUARD));
    let w = Math.min(budgetW, Math.max(300, rect.width * 1.55));
    let hgt = w / ar;
    if (hgt > budgetH) { hgt = budgetH; w = hgt * ar; }
    w = Math.round(w); hgt = Math.round(hgt);

    const src = ctx.thumb ? ctx.thumb(media, Math.round(w * 1.4)) : "";
    const art = h("img.preview-art", {
      alt: media.alt || post.text?.slice(0, 90) || "",
      loading: "eager", decoding: "async", draggable: false,
    });
    if (src) art.src = src;
    const videoSlot = h("div.preview-videoslot");

    card = h("div.preview-card", {
      role: "dialog",
      "aria-label": `Preview — ${post.author?.name || "post"}`,
      style: { width: `${w}px`, height: `${hgt}px` },
    }, art, videoSlot);
    card.addEventListener("pointerenter", cancelHide);
    card.addEventListener("pointerleave", scheduleHide);
    card.addEventListener("click", (e) => { if (!e.target.closest("button")) opts.onOpen?.(post, e); });
    document.body.appendChild(card);

    /* ---- position + FLIP zoom out of the tile ---- */
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(MARGIN, Math.min(left, innerWidth - w - MARGIN));
    let top = rect.top + rect.height / 2 - hgt / 2;
    top = Math.max(TOP_GUARD, Math.min(top, innerHeight - hgt - BOTTOM_GUARD));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    const startScale = Math.max(0.45, Math.min(1, rect.width / w));
    card.style.transform = `scale(${startScale})`;
    card.style.opacity = "0";
    void card.offsetWidth;                       // flush, then animate to rest
    requestAnimationFrame(() => { if (card) { card.style.transform = "scale(1)"; card.style.opacity = "1"; } });

    /* ---- muted video preview after a beat (the media, not a player UI) ---- */
    if (media.kind !== "photo" && media.sources?.length) {
      videoTimer = setTimeout(() => {
        if (!card || currentKey !== key) return;
        const srcs = ctx.sources ? ctx.sources(media) : media.sources;
        const low = [...srcs].filter((s) => !s.local && /^https?:/.test(s.url)).sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))[0];
        if (!low) return;
        const v = h("video.preview-video", { muted: true, loop: true, playsInline: true, preload: "metadata", src: low.url });
        v.muted = true;
        const entry = ctx.progressEntry ? ctx.progressEntry(media.id) : null;
        if (entry?.t) { try { v.currentTime = entry.t; } catch { /* not seekable yet */ } }
        videoSlot.replaceChildren(v);
        v.play().catch(() => v.remove());
      }, VIDEO_DELAY);
    }

    window.addEventListener("pointerdown", onDoc, true);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey, true);
    scheduleHide();                              // unless the pointer moves onto the card
  }

  return { open, close, scheduleHide, cancelHide, isOpenFor };
});
