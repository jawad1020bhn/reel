/* features.watch.cell — renders one post as a full-screen cell for the Watch feed.
   createCell(post, env) → { el, post, activate(), deactivate(), destroy(), fit(mode), carousel: {next, prev}|null, seekBy(s), togglePlay(), handle }
   env: { playback, media, prefs, catalog, onEnded(), onVideoEnded(), onProgress(t,d), onTap(), onOpenCreator(u), onTag(t), onUnplayable(), fitMode() } */
XR.define("features.watch.cell", ["ui.dom", "ui.icons", "ui.widgets", "ui.menu", "ui.mediaFeedback", "core.util", "core.events", "core.domain.events", "core.domain.model"], function (dom, icons, W, menu, mediaFeedback, util, events, EV, model) {
  "use strict";
  const h = dom.h;

  function createCell(post, env) {
    const { playback, media, prefs } = env;
    const kind = env.catalog.ctx.kindOf(post);
    const isCarousel = post.media.length > 1;
    const el = h("section.cell", { inert: true, "aria-hidden": "true", class: `cell-${kind}`, dataset: { id: post.id } });
    const stage = h("div.cell-stage");
    el.appendChild(stage);
    let handle = null, slides = [], slideIndex = 0, imageTimer = 0, active = false, destroyed = false, carousel = null;
    const feedbacks = new Map();
    let selectedMediaEl = null;
    const failedVideos = new WeakSet();
    let scrubbing = false, resumeAfterSeek = false, scrollT = 0;
    const progressBuffer = h("div.cell-progress-buffer");
    const progressFill = h("div.cell-progress-fill");
    /* A native range brings keyboard, screen-reader and touch dragging semantics.
       No window-level drag listeners survive a virtualised cell. */
    const seek = h("input.cell-seek", { type: "range", min: 0, max: 100, step: 0.1, value: 0, disabled: true, "aria-label": "Seek video" });
    const progress = h("div.cell-progress", progressBuffer, progressFill, seek);
    const timeLabel = h("span.cell-time", h("span.cell-time-cur", "0:00"), h("span.cell-time-sep", " / "), h("span.cell-time-dur", "0:00"));
    const playBtn = W.iconBtn("play", "Play video", (e) => { e.stopPropagation(); handle?.toggle(); }, { cls: "cell-play" });
    const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const speedBtn = h("button.cell-speed", { type: "button", "aria-haspopup": "menu", "aria-label": "Playback speed, 1×", onclick: (e) => {
      e.stopPropagation();
      menu.open(speedBtn, SPEEDS.map((rate) => ({ label: rate === 1 ? "Normal · 1×" : rate + "×", checked: playback.speed === rate, run: () => playback.setSpeed(rate) })), { title: "Playback speed" });
    } }, "1×");
    const bar = h("div.cell-bar", playBtn, progress, timeLabel, speedBtn);
    const offPlayback = events.bus.on(EV.PLAYBACK_CHANGED, syncControls);

    function duration() {
      const d = handle?.video.duration || handle?.media.duration || 0;
      return Number.isFinite(d) && d > 0 ? d : 0;
    }
    /* Dragging the playhead fires an `input` for every pixel; seeking on each one makes
       the browser abandon a request and start another (the classic scrub freeze). The
       coalescer keeps at most one seek per frame and lands the last one on release. */
    const seeker = util.seekCoalescer((t) => { if (handle && !destroyed) handle.seek(t); });
    function endSeek(resume = true) {
      if (!scrubbing) return;
      scrubbing = false; el.classList.remove("is-scrubbing");
      seeker.flush();                       // the position the user let go of wins
      if (resume && resumeAfterSeek && active && !destroyed) handle?.play();
      resumeAfterSeek = false;
    }
    seek.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !handle || !duration()) return;
      e.stopPropagation(); scrubbing = true; resumeAfterSeek = !handle.video.paused;
      el.classList.add("is-scrubbing"); handle.pause();
    });
    seek.addEventListener("input", () => {
      if (!handle || !duration()) return;
      const t = Number(seek.value) / 100 * duration();
      updateProgress(t, duration());
      /* Scrubbing previews on every frame; a single tap (no drag) seeks immediately. */
      seeker.request(t);
      if (!scrubbing) seeker.flush();       // a tap seeks immediately; a drag waits for the frame
    });
    seek.addEventListener("change", () => endSeek());
    seek.addEventListener("pointerup", () => endSeek());
    seek.addEventListener("pointercancel", () => endSeek());
    seek.addEventListener("lostpointercapture", () => endSeek());
    seek.addEventListener("keydown", (e) => {
      if (e.key === "Escape") return;
      e.stopPropagation();
      const delta = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[e.key];
      if (!handle || !duration() || (delta === undefined && e.key !== "Home" && e.key !== "End")) return;
      e.preventDefault();
      const t = e.key === "Home" ? 0 : e.key === "End" ? duration() : util.clamp(handle.video.currentTime + delta, 0, duration());
      updateProgress(t, duration());
      seeker.request(t); seeker.flush();
    });

    function syncControls() {
      const video = handle?.video;
      const failed = feedbacks.get(selectedMediaEl)?.state.failed || (!!video && failedVideos.has(video));
      const playing = !!video && !video.paused && !video.ended;
      bar.hidden = !video;
      el.classList.toggle("is-unplayable", failed);
      el.classList.toggle("is-paused", active && !!video && video.paused && !failed);
      seek.disabled = !duration() || failed;
      const rate = String(playback.speed || 1) + "×";
      speedBtn.textContent = rate;
      speedBtn.setAttribute("aria-label", "Playback speed, " + rate);
      dom.replace(playBtn, icons.icon(playing ? "pause" : "play", 18, { filled: true }));
      playBtn.setAttribute("aria-label", playing ? "Pause video" : "Play video");
      playBtn.title = playing ? "Pause video" : "Play video";
    }

    /* ------------------------------------------------------------- media -- */
    function syncFeedback() {
      for (const [target, feedback] of feedbacks) feedback.setActive(active && target === selectedMediaEl);
    }
    function addFeedback(target, imageMedia = null) {
      const feedback = mediaFeedback.create(target, {
        image: !!imageMedia, fallback: imageMedia ? media.poster(imageMedia, 1200) : "",
        failureClass: "cell-unplayable", actionsClass: "cell-unplayable-actions",
        retry: () => env.onRetry?.(post), next: () => env.onNext?.(),
        open: () => env.onOpenX?.(post), openLabel: `Open on ${model.platformLabel(post)}`,
        hide: () => env.onHide?.(post),
        onChange(state) {
          if (!active || target !== selectedMediaEl) return;
          el.classList.toggle("has-media-feedback", state.phase !== "idle");
          if (target.tagName === "VIDEO") { if (state.failed) failedVideos.add(target); else failedVideos.delete(target); }
          syncControls();
        },
      });
      feedbacks.set(target, feedback); stage.appendChild(feedback.el);
      return feedback;
    }
    function videoNode(m, { primary = true } = {}) {
      const video = h("video.cell-video", { preload: "none", disablePictureInPicture: true, controlsList: "nodownload" });
      const hd = playback.wire(video, m, {
        preload: "metadata",
        loop: prefs.get("loopShorts") && m.duration > 0 && m.duration <= 60 && !(isCarousel),
        onEnded: () => { if (!video.loop) env.onVideoEnded?.(); },
        onProgress: (t, d) => { if (handle !== hd) return; if (!scrubbing) updateProgress(t, d); env.onProgress?.(t, d); },
      });
      video.addEventListener("playing", () => { el.classList.remove("is-paused"); syncControls(); env.onPlayState?.(true, el); });
      video.addEventListener("pause", () => { if (active) el.classList.add("is-paused"); syncControls(); env.onPlayState?.(false, el); });
      video.addEventListener("play", () => { el.classList.remove("is-paused"); syncControls(); });
      const metadata = () => { if (handle === hd) { updateProgress(video.currentTime, duration()); syncControls(); } };
      video.addEventListener("loadedmetadata", metadata);
      video.addEventListener("durationchange", metadata);
      video.addEventListener("progress", () => { try { if (handle === hd && video.buffered.length && Number.isFinite(video.duration) && video.duration > 0) progressBuffer.style.width = (video.buffered.end(video.buffered.length - 1) / video.duration * 100) + "%"; } catch { /* not buffered yet */ } });
      video.addEventListener("xr:unplayable", () => {
        failedVideos.add(video);
        if (handle !== hd) return;
        syncControls();
        /* keep the frame's poster as a still so the stage reads as a lost clip,
           not a hole in the layout */
        if (!stage.querySelector(".cell-still")) {
          const still = media.poster(m, 1400);
          if (still) stage.appendChild(h("img.cell-still", { src: still, alt: m.alt || "", "aria-hidden": "true", draggable: false }));
        }
        env.onUnplayable?.(post, m);
      });
      /* The silent-video path: Reddit blocked every audio candidate, playback continues muted. */
      video.addEventListener("xr:audio-unavailable", () => {
        if (handle !== hd) return;
        el.classList.add("is-quiet");
        if (!stage.querySelector(".cell-quiet")) {
          stage.appendChild(h("button.cell-quiet", { type: "button", title: "Open on Reddit for sound", onclick: (e) => { e.stopPropagation(); env.onOpenX?.(post); } },
            icons.icon("mute", 14), h("span", "Audio unavailable — playing without sound")));
        }
      });
      if (primary) { handle = hd; selectedMediaEl = video; }
      addFeedback(video);
      return { video, hd };
    }
    function imageNode(m, primary = true) {
      const img = h("img.cell-img", { src: media.full(m), alt: m.alt || "", draggable: false, decoding: "async" });
      if (primary) selectedMediaEl = img;
      addFeedback(img, m);
      return img;
    }
    function backdrop(m) { const src = media.poster(m, 300); return h("div.cell-bg", { style: { backgroundImage: `url("${src}")` } }); }

    const fitBox = (m) => h("div.cell-fit", { style: { "--ar": (m.aspect || 1).toFixed(4) } });
    /* A failed poster needs a visible fallback; it does not prove the post was deleted. */
    function probePoster(url) { if (!url) return; const probe = new Image(); probe.onerror = () => el.classList.add("is-posterless"); probe.src = url; }

    if (!isCarousel) {
      const m = post.media[0];
      stage.appendChild(backdrop(m));
      const box = fitBox(m);
      if (m.kind === "photo") box.appendChild(imageNode(m));
      else { const { video } = videoNode(m); video.poster = media.poster(m, 900); box.appendChild(video); probePoster(media.poster(m, 300)); }
      stage.appendChild(box);
      if (m.kind !== "photo") { stage.appendChild(h("div.cell-pauseglyph", icons.icon("play", 44, { filled: true }))); }
    } else {
      /* carousel: horizontal snap scroller of slides; only the visible slide's video plays */
      const scroller = h("div.carousel", { tabindex: "-1" });
      post.media.forEach((m, i) => {
        const slide = h("div.carousel-slide", { dataset: { index: i } });
        slide.appendChild(backdrop(m));
        const box = fitBox(m);
        let hd = null;
        if (m.kind === "photo") box.appendChild(imageNode(m, i === 0));
        else { const v = videoNode(m, { primary: i === 0 }); v.video.poster = media.poster(m, 900); box.appendChild(v.video); hd = v.hd; }
        slide.appendChild(box);
        scroller.appendChild(slide);
        slides.push({ el: slide, media: m, hd, target: box.querySelector("video, img") });
      });
      stage.appendChild(scroller);
      const dots = h("div.carousel-dots", post.media.map((_, i) => h("i", { class: i === 0 ? "on" : "" })));
      const counter = h("span.badge.badge-dark.carousel-counter", { role: "status", "aria-live": "polite", "aria-atomic": "true" }, `Media 1 / ${post.media.length}`);
      const prevMedia = h("button.carousel-arrow.carousel-prev", { "aria-label": "Previous media", disabled: true, onclick: (e) => { e.stopPropagation(); setSlide(slideIndex - 1); } }, icons.icon("chevronLeft", 22));
      const nextMedia = h("button.carousel-arrow.carousel-next", { "aria-label": "Next media", onclick: (e) => { e.stopPropagation(); setSlide(slideIndex + 1); } }, icons.icon("chevronRight", 22));
      stage.appendChild(dots);
      stage.appendChild(h("nav.carousel-navigation", { "aria-label": "Media in this post" }, prevMedia, counter, nextMedia));
      if (slides.some((s) => s.hd)) { stage.appendChild(h("div.cell-pauseglyph", icons.icon("play", 44, { filled: true }))); }
      scroller.addEventListener("scroll", () => { clearTimeout(scrollT); scrollT = setTimeout(() => setSlide(Math.round(scroller.scrollLeft / scroller.clientWidth), false), 80); }, { passive: true });
      function setSlide(i, scroll = true) {
        i = util.clamp(i, 0, slides.length - 1);
        if (scroll) scroller.scrollTo({ left: i * scroller.clientWidth, behavior: document.documentElement.dataset.motion === "reduce" ? "auto" : "smooth" });
        if (i === slideIndex && handle === (slides[i].hd || null)) return;
        endSeek(false); clearTimeout(imageTimer);
        const prev = slides[slideIndex];
        if (prev?.hd) prev.hd.deactivate();
        slideIndex = i;
        [...dots.children].forEach((d, k) => d.classList.toggle("on", k === i));
        counter.textContent = `Media ${i + 1} / ${slides.length}`;
        prevMedia.disabled = i === 0; nextMedia.disabled = i === slides.length - 1;
        handle = slides[i].hd || null;
        selectedMediaEl = slides[i].target;
        el.classList.remove("has-media-feedback");
        syncFeedback();
        updateProgress(handle?.video.currentTime || 0, duration());
        progressBuffer.style.width = "0%";
        syncControls(); fit(env.fitMode());
        if (active && handle) { feedbacks.get(selectedMediaEl)?.begin(); handle.activate(); }
      }
      carousel = { next: () => { if (slideIndex < slides.length - 1) setSlide(slideIndex + 1); else env.onCarouselEnd?.(); }, prev: () => { if (slideIndex > 0) setSlide(slideIndex - 1); else env.onCarouselStart?.(); }, get index() { return slideIndex; }, get length() { return slides.length; } };
    }

    /* ----------------------------------------------------------- overlay -- */
    const m0 = post.media[0];
    stage.appendChild(h("div.cell-gradient"));
    if (post.media.some((m) => m.kind !== "photo")) el.append(bar);
    syncControls();
    function updateProgress(t, d) {
      const elapsed = Number.isFinite(t) ? t : 0;
      const total = Number.isFinite(d) && d > 0 ? d : 0;
      const pct = total ? util.clamp(elapsed / total * 100, 0, 100) : 0;
      progressFill.style.width = pct.toFixed(2) + "%";
      seek.value = String(pct);
      seek.setAttribute("aria-valuetext", dom.duration(elapsed) + " of " + dom.duration(total));
      timeLabel.firstChild.textContent = dom.duration(elapsed);
      timeLabel.lastChild.textContent = dom.duration(total);
    }

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
      el.inert = false; el.removeAttribute("aria-hidden");
      el.classList.add("is-active");
      fit(env.fitMode());
      syncFeedback();
      if (handle) { feedbacks.get(selectedMediaEl)?.begin(); handle.activate(); }
      else if (m0?.kind === "photo" || (isCarousel && !slides[slideIndex].hd)) {
        env.markSeen?.(post);
        const secs = Number(prefs.get("imageSeconds")) || 0;
        if (secs > 0) imageTimer = setTimeout(() => env.onEnded?.(), secs * 1000);
      }
      syncControls();
    }
    function deactivate() {
      active = false;
      syncFeedback(); el.classList.remove("has-media-feedback");
      el.inert = true; el.setAttribute("aria-hidden", "true");
      endSeek(false);
      el.classList.remove("is-active", "is-paused");
      clearTimeout(imageTimer);
      if (handle) handle.deactivate();
      for (const s of slides) s.hd?.deactivate();
      syncControls();
    }
    /** Warm neighbours through the bounded queue, without also fetching metadata/HLS. */
    function prepare() { // preload neighbour
      if (!prefs.get("preload")) return;
      env.warm?.(post);
    }
    function destroy() {
      if (destroyed) return; destroyed = true;
      deactivate();
      offPlayback(); clearTimeout(scrollT);
      for (const feedback of feedbacks.values()) feedback.destroy(); feedbacks.clear();
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
