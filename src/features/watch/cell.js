/* features.watch.cell — renders one post as a full-screen cell for the Watch feed.
   createCell(post, env) → { el, post, activate(), deactivate(), destroy(), fit(mode), carousel: {next, prev}|null, seekBy(s), togglePlay(), handle }
   env: { playback, media, prefs, catalog, onEnded(), onVideoEnded(), onProgress(t,d), onTap(), onOpenCreator(u), onTag(t), onUnplayable(), fitMode() } */
XR.define("features.watch.cell", ["ui.dom", "ui.icons", "ui.widgets", "core.util"], function (dom, icons, W, util) {
  "use strict";
  const h = dom.h;

  function createCell(post, env) {
    const { playback, media, prefs } = env;
    const kind = env.catalog.ctx.kindOf(post);
    const isCarousel = post.media.length > 1;
    const el = h("section.cell", { class: `cell-${kind}`, dataset: { id: post.id } });
    const stage = h("div.cell-stage");
    el.appendChild(stage);
    let handle = null, slides = [], slideIndex = 0, imageTimer = 0, active = false, destroyed = false, carousel = null;
    const bufferEl = h("div.cell-buffer", W.spinner());
    const progress = h("div.cell-progress", { role: "slider", "aria-label": "Seek" }, h("div.cell-progress-buffer"), h("div.cell-progress-fill"));
    const timeLabel = h("span.cell-time", h("span.cell-time-cur", "00:00"), h("span.cell-time-sep", " — "), h("span.cell-time-dur", "00:00"));

    /* ------------------------------------------------------------- media -- */
    function videoNode(m, { primary = true } = {}) {
      const video = h("video.cell-video", { preload: "none", disablePictureInPicture: false, controlsList: "nodownload" });
      const hd = playback.wire(video, m, {
        preload: "metadata",
        loop: prefs.get("loopShorts") && m.duration > 0 && m.duration <= 60 && !(isCarousel),
        onEnded: () => { if (!video.loop) env.onVideoEnded?.(); },
        onProgress: (t, d) => { updateProgress(t, d); env.onProgress?.(t, d); },
      });
      video.addEventListener("waiting", () => el.classList.add("is-buffering"));
      video.addEventListener("playing", () => { el.classList.remove("is-buffering"); el.classList.remove("is-paused"); });
      video.addEventListener("canplay", () => el.classList.remove("is-buffering"));
      video.addEventListener("pause", () => { if (active) el.classList.add("is-paused"); });
      video.addEventListener("play", () => el.classList.remove("is-paused"));
      video.addEventListener("progress", () => { try { if (video.buffered.length && video.duration) progress.firstChild.style.width = (video.buffered.end(video.buffered.length - 1) / video.duration * 100) + "%"; } catch { /* ignore */ } });
      video.addEventListener("xr:unplayable", () => {
        el.classList.add("is-unplayable");
        /* keep the frame's poster as a still so the stage reads as a lost clip,
           not a hole in the layout */
        if (!stage.querySelector(".cell-still")) {
          const still = media.poster(m, 1400);
          if (still) stage.appendChild(h("img.cell-still", { src: still, alt: m.alt || "", "aria-hidden": "true", draggable: false }));
        }
        env.onUnplayable?.(post, m);
      });
      if (primary) handle = hd;
      return { video, hd };
    }
    function imageNode(m) {
      const img = h("img.cell-img", { src: media.full(m), alt: m.alt || "", draggable: false, decoding: "async" });
      img.addEventListener("error", () => { if (!img.dataset.fb) { img.dataset.fb = "1"; img.src = media.poster(m, 1200); } });
      return img;
    }
    function backdrop(m) { const src = media.poster(m, 300); return h("div.cell-bg", { style: { backgroundImage: `url("${src}")` } }); }

    const fitBox = (m) => h("div.cell-fit", { style: { "--ar": (m.aspect || 1).toFixed(4) } });
    /* a 403/404 poster usually means the post is gone on X: show a visible placeholder instead of black */
    function probePoster(url) { if (!url) return; const probe = new Image(); probe.onerror = () => el.classList.add("is-posterless"); probe.src = url; }

    if (!isCarousel) {
      const m = post.media[0];
      stage.appendChild(backdrop(m));
      const box = fitBox(m);
      if (m.kind === "photo") box.appendChild(imageNode(m));
      else { const { video } = videoNode(m); video.poster = media.poster(m, 900); box.appendChild(video); probePoster(media.poster(m, 300)); }
      stage.appendChild(box);
      if (m.kind !== "photo") { stage.appendChild(bufferEl); stage.appendChild(h("div.cell-pauseglyph", icons.icon("play", 44, { filled: true }))); }
    } else {
      /* carousel: horizontal snap scroller of slides; only the visible slide's video plays */
      const scroller = h("div.carousel", { tabindex: "-1" });
      post.media.forEach((m, i) => {
        const slide = h("div.carousel-slide", { dataset: { index: i } });
        slide.appendChild(backdrop(m));
        const box = fitBox(m);
        let hd = null;
        if (m.kind === "photo") box.appendChild(imageNode(m));
        else { const v = videoNode(m, { primary: i === 0 }); v.video.poster = media.poster(m, 900); box.appendChild(v.video); hd = v.hd; }
        slide.appendChild(box);
        scroller.appendChild(slide);
        slides.push({ el: slide, media: m, hd });
      });
      stage.appendChild(scroller);
      const dots = h("div.carousel-dots", post.media.map((_, i) => h("i", { class: i === 0 ? "on" : "" })));
      const counter = h("span.badge.badge-dark.carousel-counter", `1 / ${post.media.length}`);
      stage.appendChild(dots); stage.appendChild(counter);
      stage.appendChild(h("button.carousel-arrow.carousel-prev", { "aria-label": "Previous image", onclick: (e) => { e.stopPropagation(); api.carousel.prev(); } }, icons.icon("chevronLeft", 24)));
      stage.appendChild(h("button.carousel-arrow.carousel-next", { "aria-label": "Next image", onclick: (e) => { e.stopPropagation(); api.carousel.next(); } }, icons.icon("chevronRight", 24)));
      if (slides.some((s) => s.hd)) { stage.appendChild(bufferEl); stage.appendChild(h("div.cell-pauseglyph", icons.icon("play", 44, { filled: true }))); }
      let scrollT = 0;
      scroller.addEventListener("scroll", () => { clearTimeout(scrollT); scrollT = setTimeout(() => setSlide(Math.round(scroller.scrollLeft / scroller.clientWidth), false), 80); }, { passive: true });
      function setSlide(i, scroll = true) {
        i = util.clamp(i, 0, slides.length - 1);
        if (scroll) scroller.scrollTo({ left: i * scroller.clientWidth, behavior: "smooth" });
        if (i === slideIndex && handle === (slides[i].hd || null)) return;
        const prev = slides[slideIndex];
        if (prev?.hd) prev.hd.deactivate();
        slideIndex = i;
        [...dots.children].forEach((d, k) => d.classList.toggle("on", k === i));
        counter.textContent = `${i + 1} / ${slides.length}`;
        handle = slides[i].hd || null;
        progress.style.display = handle ? "" : "none";
        if (active && handle) handle.activate();
      }
      carousel = { next: () => { if (slideIndex < slides.length - 1) setSlide(slideIndex + 1); else env.onCarouselEnd?.(); }, prev: () => { if (slideIndex > 0) setSlide(slideIndex - 1); else env.onCarouselStart?.(); }, get index() { return slideIndex; }, get length() { return slides.length; } };
      progress.style.display = handle ? "" : "none";
    }

    /* ----------------------------------------------------------- overlay -- */
    const m0 = post.media[0];
    const meta = h("div.cell-meta",
      h("button.cell-creator", { onclick: (e) => { e.stopPropagation(); env.onOpenCreator?.(post.author.username); } },
        W.avatar(media.avatar(post, 40), post.author.name, 40),
        h("span.cell-creator-text", h("b", post.author.name), h("span", "@" + post.author.username))));
    stage.appendChild(h("div.cell-gradient"));
    el.appendChild(meta);
    if (m0 && m0.kind !== "photo") {
      el.appendChild(h("div.cell-bar", progress, timeLabel));
      progress.addEventListener("pointerdown", (e) => { e.stopPropagation(); seekTo(e); const move = (ev) => seekTo(ev); const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); });
      progress.addEventListener("click", (e) => e.stopPropagation());
    }
    const unplayable = h("div.cell-unplayable", icons.icon("alert", 28), h("p", "This video can't be played — it may have been deleted on X."),
      h("div.cell-unplayable-actions",
        W.btn("Next", { icon: "arrowDown", kind: "primary", onClick: (e) => { e.stopPropagation(); env.onEnded?.(); } }),
        W.btn("Retry", { icon: "refresh", onClick: (e) => { e.stopPropagation(); el.classList.remove("is-unplayable"); env.onRetry?.(post); } }),
        W.btn("Open on X", { icon: "external", onClick: (e) => { e.stopPropagation(); env.onOpenX?.(post); } }),
        W.btn("Hide post", { icon: "eyeOff", onClick: (e) => { e.stopPropagation(); env.onHide?.(post); } })));
    stage.appendChild(unplayable);

    function seekTo(e) { if (!handle) return; const r = progress.getBoundingClientRect(); const ratio = util.clamp((e.clientX - r.left) / r.width, 0, 1); const d = handle.video.duration || handle.media.duration; handle.seek(ratio * d); updateProgress(ratio * d, d); }
    function updateProgress(t, d) { if (!d) return; progress.lastChild.style.width = (t / d * 100).toFixed(2) + "%"; timeLabel.firstChild.textContent = dom.duration(t); timeLabel.lastChild.textContent = dom.duration(d); }

    /* -------------------------------------------------------------- fit -- */
    function fit(mode) {
      const m = isCarousel ? slides[slideIndex].media : m0;
      /* auto collapses to contain: never crop by default; cover is opt-in via fit toggle (x) */
      /* aspect < 0.95 = reels-format portrait: never zoomed, by design */
      const ratio = m ? (m.width && m.height ? m.width / m.height : (m.aspect || 1)) : 1;
      const portrait = ratio > 0 && ratio < 0.95;
      el.dataset.fit = mode === "cover" && !portrait ? "cover" : "contain";
    }

    /* ---------------------------------------------------------- lifecycle -- */
    function activate() {
      if (destroyed) return;
      active = true;
      el.classList.add("is-active");
      fit(env.fitMode());
      if (handle) handle.activate();
      else if (m0?.kind === "photo" || (isCarousel && !slides[slideIndex].hd)) {
        env.markSeen?.(post);
        const secs = Number(prefs.get("imageSeconds")) || 0;
        if (secs > 0) imageTimer = setTimeout(() => env.onEnded?.(), secs * 1000);
      }
    }
    function deactivate() {
      active = false;
      el.classList.remove("is-active", "is-paused");
      clearTimeout(imageTimer);
      if (handle) handle.deactivate();
      for (const s of slides) s.hd?.deactivate();
    }
    function prepare() { // preload neighbour
      if (!prefs.get("preload")) return;
      if (handle) handle.attach();
    }
    function destroy() {
      if (destroyed) return; destroyed = true;
      deactivate();
      if (handle) handle.destroy();
      for (const s of slides) s.hd?.destroy();
      el.remove();
    }
    const api = {
      el, post, kind, isCarousel,
      get handle() { return handle; },
      get video() { return handle?.video || null; },
      carousel,
      activate, deactivate, prepare, destroy, fit,
      togglePlay() { if (handle) { handle.toggle(); } },
      seekBy(s) { handle?.seekBy(s); },
      setRate(r) { if (handle) handle.video.playbackRate = r; },
    };
    return api;
  }
  return { createCell };
});
