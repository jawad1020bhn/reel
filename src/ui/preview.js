/* ui.preview — the Netflix-style hover card: after 500ms of hover intent on a tile,
   a fixed card zooms out of the thumbnail (FLIP, 380ms expo), plays a muted video
   preview when one exists, and offers play / star / hide / more actions.
   Everything app-specific arrives through ctx + opts, so this stays a pure ui module. */
XR.define("ui.preview", ["ui.dom", "ui.icons"], function (dom, icons) {
  "use strict";
  const h = dom.h;
  let card = null, hideTimer = 0, videoTimer = 0, currentKey = "";
  const MARGIN = 14, TOP_GUARD = 84, BOTTOM_GUARD = 20;

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

  /* tooltip buttons: white bubble above, css triangle */
  function tipBtn(cls, iconName, label, onClick, size = 17) {
    return h("button.pv-btn" + (cls ? "." + cls : ""), { "data-tip": label, "aria-label": label, onclick: (e) => { e.stopPropagation(); onClick?.(e); } },
      icons.icon(iconName, size));
  }

  /**
   * open({ el, post, ctx, opts })
   *   ctx : { thumb, poster, avatar, sources, isStarred, progressOf, progressEntry, kindOf }
   *   opts: { onOpen(post,e), onStar(post), onMenu(post,e), onHide(post), width }
   */
  function open({ el, post, ctx, opts = {} }) {
    close();
    const media = post.media[0];
    if (!media) return;
    const key = post.id;
    currentKey = key;
    const kind = ctx.kindOf(post);
    const starred = !!ctx.isStarred(post.id);

    /* ---- head: artwork, delayed muted video, scrim ---- */
    const art = h("img.preview-art", { src: ctx.thumb(media, 480) || ctx.poster(media, 480), alt: media.alt || "", loading: "eager", decoding: "async", draggable: false });
    const videoSlot = h("div.preview-videoslot");
    const head = h("div.preview-head", art, videoSlot,
      h("div.preview-head-scrim"),
      kind === "photo" || kind === "carousel" ? null : h("span.preview-kindchip", kind === "gif" ? "GIF" : kind === "long" ? "LONG" : "SHORT"));

    /* ---- action row ---- */
    const starBtn = tipBtn("", starred ? "star" : "star", starred ? "Remove from starred" : "Add to starred", () => {
      opts.onStar?.(post);
      const now = !!ctx.isStarred(post.id);
      dom.replace(starBtn, icons.icon("star", 17, { filled: now }));
      starBtn.classList.toggle("pv-on", now);
      starBtn.dataset.tip = now ? "Remove from starred" : "Add to starred";
    });
    dom.replace(starBtn, icons.icon("star", 17, { filled: starred }));
    if (starred) starBtn.classList.add("pv-on");

    const actions = h("div.pv-actions",
      h("button.pv-btn.pv-play", { "data-tip": "Play", "aria-label": "Play", onclick: (e) => { e.stopPropagation(); opts.onOpen?.(post, e); } }, icons.icon("play", 16, { filled: true })),
      starBtn,
      tipBtn("", "eyeOff", "Not for me — hide", () => { opts.onHide?.(post); close(); }),
      h("span.pv-actions-gap"),
      tipBtn("", "more", "More", (e) => opts.onMenu?.(post, { ...e, currentTarget: card, clientX: undefined, clientY: undefined })));

    /* ---- meta chips ---- */
    const chips = [];
    if (media.kind !== "photo" && media.duration) chips.push(h("span.pv-chip", dom.duration(media.duration)));
    if (post.metrics.likes) chips.push(h("span.pv-chip.pv-chip-likes", icons.icon("heart", 11, { filled: true }), dom.compact(post.metrics.likes)));
    if (media.kind !== "photo" && media.duration > 60) chips.push(h("span.pv-chip.pv-chip-hd", "HD"));

    /* ---- caption + tags: the tags live in their own line, never twice ---- */
    const captionText = String(post.text || "").replace(/#[\p{L}\p{N}_]+/gu, "").replace(/\s+/g, " ").trim();
    const clippedText = captionText.length > 220 ? captionText.slice(0, 220) + "…" : captionText;
    const caption = clippedText ? h("p.pv-caption", dom.richText(clippedText)) : null;
    const tags = post.hashtags.length ? h("p.pv-tags", post.hashtags.slice(0, 4).map((t) => "#" + t).join(" • ")) : null;

    /* ---- progress ---- */
    const progress = ctx.progressOf(post);
    const progressRow = progress > 0 && progress < 0.98
      ? h("div.pv-progress", h("div.pv-progress-track", h("i", { style: { width: (progress * 100).toFixed(1) + "%" } })), h("span.pv-progress-label", remaining(post, progress)))
      : null;

    const body = h("div.pv-body",
      h("div.pv-creator", { onclick: (e) => { e.stopPropagation(); opts.onCreator?.(post.author.username); } },
        ctx.avatar(post, 30) ? h("img.avatar.pv-avatar", { src: ctx.avatar(post, 30), alt: "", loading: "lazy" }) : h("span.avatar.pv-avatar.avatar-fallback", post.author.username[0]?.toUpperCase()),
        h("span.pv-handle", "@" + post.author.username),
        h("span.pv-date", dom.relative(post.savedAt))),
      actions,
      h("div.pv-meta", chips),
      caption, tags, progressRow);

    card = h("div.preview-card", { role: "dialog", "aria-label": "Preview" }, head, body);
    card.addEventListener("pointerenter", cancelHide);
    card.addEventListener("pointerleave", scheduleHide);
    card.addEventListener("click", (e) => { if (!e.target.closest("button")) opts.onOpen?.(post, e); });
    document.body.appendChild(card);

    /* ---- position + FLIP zoom-out-of-the-tile ---- */
    const rect = el.getBoundingClientRect();
    const w = Math.round(Math.min(420, Math.max(300, rect.width * 1.4)));
    card.style.width = w + "px";
    card.style.visibility = "hidden";
    const ch = card.offsetHeight;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(MARGIN, Math.min(left, innerWidth - w - MARGIN));
    let top = rect.top + rect.height / 2 - ch / 2;
    top = Math.max(TOP_GUARD, Math.min(top, innerHeight - ch - BOTTOM_GUARD));
    card.style.left = left + "px";
    card.style.top = top + "px";
    const startScale = Math.max(0.4, Math.min(1, rect.width / w));
    card.style.transform = `scale(${startScale})`;
    card.style.opacity = "0";
    card.style.visibility = "";
    void card.offsetWidth;                       // flush, then animate to rest
    requestAnimationFrame(() => { if (card) { card.style.transform = "scale(1)"; card.style.opacity = "1"; } });

    /* ---- muted video preview after a beat ---- */
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
        videoSlot.appendChild(v);
        v.play().then(() => attachScrub(head, v)).catch(() => v.remove());
      }, 1200);
    }

    window.addEventListener("pointerdown", onDoc, true);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey, true);
    scheduleHide();                              // unless the pointer moves onto the card
  }

  function remaining(post, p) {
    const m = post.media[0];
    const left = Math.max(1, Math.round((m?.duration || 0) * (1 - p) / 60));
    return `${left} min left`;
  }

  /* hover-scrub: the playing preview video seeks to the pointer, rail + timestamp */
  function attachScrub(head, v) {
    let vf = 0, scrubbing = false, pending = null, raf = 0;
    const scrub = h("div.pv-scrub", h("i.pv-scrub-fill"), h("span.pv-scrub-time"));
    const fill = scrub.children[0], time = scrub.children[1];
    const paint = (f) => { fill.style.transform = `scaleX(${Math.max(0.001, Math.min(1, f)).toFixed(4)})`; };
    const seek = () => {
      raf = 0;
      if (!vf || pending == null) return;
      const t = Math.max(0, Math.min(vf - 0.2, pending * vf));
      pending = null;
      try { v.currentTime = t; } catch { /* stream not seekable yet */ }
      paint(t / vf);
      time.textContent = dom.duration(t);
    };
    head.addEventListener("pointermove", (e) => {
      if (!vf) return;
      scrubbing = true;
      scrub.classList.add("is-scrub");
      const r = head.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      pending = x;
      time.style.left = Math.max(26, Math.min(r.width - 26, x * r.width)).toFixed(0) + "px";
      if (!raf) raf = requestAnimationFrame(seek);
    });
    head.addEventListener("pointerleave", () => { scrubbing = false; scrub.classList.remove("is-scrub"); });
    v.addEventListener("loadedmetadata", () => { if (Number.isFinite(v.duration)) { vf = v.duration; scrub.classList.add("is-live"); paint(v.duration ? v.currentTime / vf : 0); } });
    v.addEventListener("timeupdate", () => { if (vf && !scrubbing) paint(v.currentTime / vf); });
    head.appendChild(scrub);
  }

  return { open, close, scheduleHide, cancelHide, isOpenFor };
});
