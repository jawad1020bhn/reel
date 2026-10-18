/* features.discover — the home screen: a cinematic billboard (spotlight post as a
   full-bleed hero with double vignette, Bebas title treatment, pill CTAs), editorial
   rails (incl. the ranked Top-10 row with giant gradient numerals) and a quiet footer. */
XR.define("features.discover", ["ui.dom", "ui.icons", "ui.widgets", "ui.rail", "ui.tiles", "ui.postMenu", "ui.keys", "app.ports.platform", "app.catalog", "app.activity", "app.actions", "app.prefs", "app.media", "app.nav", "core.query.engine", "core.events", "core.domain.events", "core.util", "core.i18n"],
  function (dom, icons, W, railUI, tiles, postMenu, keys, platform, catalog, activity, actions, prefs, media, nav, engine, events, EV, util, i18n) {
    "use strict";
    const t = i18n.t;
    const h = dom.h;
    let host = null, rails = [], offs = [], refreshTimer = 0;

    /* The page mix is seeded once per page load: a refresh deals a new mix (new
       shelves, new spotlight, new line-ups inside the shelves that stay), while
       browsing away and coming back within the same load keeps the mix you left.
       The Shuffle button (or pressing R, or pull-to-shuffle) reseeds on demand. */
    const newSeed = () => 1 + Math.floor(Math.random() * 2147483646);
    let loadSeed = newSeed();
    function sessionSeed() { return loadSeed; }
    function reseed() { loadSeed = newSeed(); return loadSeed; }
    function shuffle() {
      platform.vibrate?.(10);
      reseed();
      render();
      if (host) host.scrollTo?.({ top: 0, behavior: "smooth" });
      actions.toast("Discover reshuffled");
    }

    const KIND_LABEL = { photo: "Photo", carousel: "Album", short: "Short", long: "Long video", gif: "GIF", text: "Post" };
    const isFresh = (p) => Date.now() - (p.savedAt || 0) < 7 * 864e5;

    function render() {
      if (!host) return;
      for (const r of rails) r.destroy(); rails = [];
      dom.clear(host);
      if (!catalog.size) { host.appendChild(W.empty({ icon: catalog.source.error ? "alert" : "inbox", title: catalog.source.error ? "Couldn't read data/posts.js" : "Your library is empty", text: catalog.source.error ? catalog.source.error : "Import your X bookmarks export to get started.", action: { label: "Import posts", icon: "upload", run: () => nav.go("import") } })); return; }

      const stats = catalog.stats();
      const page = h("div.discover");
      const seed = sessionSeed();
      const spot = catalog.spotlight({ seed });
      if (spot) page.appendChild(billboard(spot));

      const built = catalog.buildRails({ limit: 24, seed });
      page.appendChild(shelfBar(built.length));
      built.forEach((r, i) => page.appendChild(rail(r, i)));
      page.appendChild(foot(stats));
      host.appendChild(page);
    }

    /* ----------------------------------------------------------- billboard -- */
    /** Fade the hero artwork in once it has pixels (avoids an empty frame flash). */
    function artReveal(img) {
      const reveal = () => img.classList.add("is-loaded");
      img.addEventListener("load", reveal, { once: true });
      img.addEventListener("error", reveal, { once: true });
      if (img.complete && img.naturalWidth > 0) reveal();
      return img;
    }
    function billboard(post) {
      const m = post.media[0];
      const kind = catalog.ctx.kindOf(post);
      const hasVideo = m && m.kind !== "photo" && m.sources?.length;
      const bg = m ? media.poster(m, 1200) : "";

      /* title treatment: a short headline (first sentence, hashtags stripped) in Bebas */
      const headline = headlineOf(post) || KIND_LABEL[kind] || "Spotlight";

      /* meta line: @creator • kind • duration • date • likes — crimson dots */
      const meta = h("div.billboard-meta",
        h("b", "@" + post.author.username),
        h("i.dot", "•"), h("span", KIND_LABEL[kind] || "Post"),
        m?.duration && m.kind !== "photo" ? [h("i.dot", "•"), h("span", dom.duration(m.duration))] : [],
        post.createdAt ? [h("i.dot", "•"), h("span", dom.date(post.createdAt))] : [],
        post.metrics.likes ? [h("i.dot", "•"), h("span.billboard-likes", icons.icon("heart", 12, { filled: true }), dom.compact(post.metrics.likes))] : []);

      /* description: only the part the headline did not already say */
      const descText = (post.text || "").trim();
      const title = headlineOf(post);
      const descBody = descBodyOf(post, title);
      const clipped = descBody.length > 160;
      const desc = descBody ? h("p.billboard-desc", clipped ? descBody.slice(0, 160).trimEnd() + "…" : descBody) : null;
      const moreBtn = clipped ? h("button.billboard-more", { onclick: () => {
        const open = document.body.contains(desc) && desc.classList.toggle("is-open");
        desc.textContent = open ? descBody : descBody.slice(0, 160).trimEnd() + "…";
        moreBtn.firstChild.textContent = open ? t(" Less") : t(" Read more");
      } }, " Read more") : null;

      const open = (mode) => actions.open([post.id], 0, { label: "Spotlight" }, mode || prefs.get("tileOpens"));
      const starBtn = h("button.btn.btn-icon.billboard-star", { title: "Star", "aria-label": "Star", onclick: () => actions.star(post) }, icons.icon("star", 20, { filled: true }));
      const actions_ = h("div.billboard-actions",
        W.btn(kind === "photo" || kind === "carousel" ? "View" : "Play", { icon: "play", kind: "light", onClick: () => open() }),
        W.btn("More info", { icon: "info", kind: "glass", onClick: () => actions.view([post.id], 0, { label: "Spotlight" }) }),
        starBtn);

      /* a genuine state marker instead of a decorative eyebrow: this is the newest unseen post */
      const slate = h("p.billboard-slate",
        h("span.billboard-slate-dot", { "aria-hidden": "true" }),
        h("span", t("Spotlight")),
        h("i", { "aria-hidden": "true" }, "·"),
        h("span.billboard-slate-soft", t("newest unseen")));
      const content = h("div.billboard-content",
        h("h1.billboard-title", headline),
        meta,
        desc ? h("div.billboard-desc-wrap", desc, moreBtn) : null,
        actions_);

      /* callout, bottom right: when it entered your library (the like count now lives in the meta row) */
      const callout = h("div.billboard-callout", icons.icon("bookmark", 14),
        h("span", post.savedAt ? `${t("Saved")} ${dom.relative(post.savedAt)}` : t("In your library")));

      /* mute control for the trailer (desktop) */
      let video = null, muteBtn = null;
      if (hasVideo) {
        video = h("video.billboard-video", { muted: true, loop: true, playsInline: true, preload: "metadata", poster: bg || undefined, "aria-hidden": "true" });
        const best = [...(catalog.ctx.sources ? catalog.ctx.sources(m) : m.sources)].filter((s) => /^https?:/.test(s.url)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (best) video.src = best.url;
        video.play().catch(() => { video = null; });
        muteBtn = h("button.billboard-mute", { title: "Unmute trailer", "aria-label": "Unmute trailer", onclick: () => {
          if (!video) return;
          video.muted = !video.muted;
          dom.replace(muteBtn, icons.icon(video.muted ? "mute" : "volume", 18));
          muteBtn.title = video.muted ? "Unmute trailer" : "Mute trailer";
        } }, icons.icon("mute", 18));
      }

      const frame = h("div.billboard-frame",
        video || (bg ? artReveal(h("img.billboard-art", { src: bg, alt: m?.alt || "", draggable: false, fetchpriority: "high", decoding: "async" })) : h("div.billboard-art")),
        h("div.billboard-scrim-x"),
        h("div.billboard-vignette"),
        slate, content, callout, muteBtn);

      /* mobile: portrait poster card with stacked pills */
      const mobile = h("div.bb-mobile",
        h("div.bb-mobile-card",
          bg ? artReveal(h("img.bb-mobile-art", { src: bg, alt: m?.alt || "", draggable: false, decoding: "async" })) : h("div.bb-mobile-art"),
          h("div.bb-mobile-scrim"),
          h("p.bb-mobile-slate", h("span.bb-dot", { "aria-hidden": "true" }), t("Spotlight"), h("i", "·"), h("span.bb-slate-soft", t("Newest unseen"))),
          h("div.bb-mobile-info",
            h("h2.bb-mobile-title", headline),
            h("div.bb-mobile-meta", h("b", "@" + post.author.username), h("i.dot", "•"), h("span", KIND_LABEL[kind] || "Post"), m?.duration && m.kind !== "photo" ? [h("i.dot", "•"), h("span", dom.duration(m.duration))] : []),
            descBody ? h("p.bb-mobile-desc", descBody) : null,
            h("div.bb-mobile-actions",
              W.btn(kind === "photo" || kind === "carousel" ? "View" : "Play", { icon: "play", kind: "light", onClick: () => open() }),
              W.btn("More info", { icon: "info", kind: "glass", onClick: () => actions.view([post.id], 0, { label: "Spotlight" }) })))));

      const section = h("section.billboard", frame, mobile);
      if (bg) dominantColor(bg).then((rgb) => { if (rgb) section.style.setProperty("--dom", rgb); });
      return section;
    }

    /** The part of the caption the headline did not already say; a bare tag is not a caption. */
    function descBodyOf(post, title) {
      const text = (post.text || "").trim();
      const base = String(title || "").replace(/…$/, "").trim();
      let body = text;
      if (base && body.toLowerCase().startsWith(base.toLowerCase())) body = body.slice(base.length).trim();
      body = body.replace(/^[-—–:;,.\s]+/, "").trim();
      return body.length >= 24 ? body : "";
    }

    /** First sentence of the caption (hashtags stripped), trimmed to a headline. */
    function headlineOf(post) {
      const clean = (post.text || "").replace(/#[\p{L}\p{N}_]+/gu, "").replace(/\s+/g, " ").trim();
      if (!clean) return "";
      const sentence = clean.split(/(?<=[.!?])\s/)[0] || clean;
      const base = sentence.length >= 12 ? sentence : clean;
      return util.truncate(base, 96);
    }

    /** Average colour of the artwork, pulled deep and desaturated for the hero gradient. */
    function dominantColor(url) {
      return new Promise((resolve) => {
        try {
          const im = new Image();
          im.crossOrigin = "anonymous";
          im.onload = () => {
            try {
              const c = document.createElement("canvas"); c.width = 10; c.height = 7;
              const x = c.getContext("2d", { willReadFrequently: true });
              x.drawImage(im, 0, 0, 10, 7);
              const d = x.getImageData(0, 0, 10, 7).data;
              let r = 0, g = 0, b = 0, n = 0;
              for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
              r /= n; g /= n; b /= n;
              const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              const dark = (v) => Math.round(v * 0.42 + l * 0.08);
              resolve(`rgb(${dark(r)},${dark(g)},${dark(b)})`);
            } catch { resolve(""); }
          };
          im.onerror = () => resolve("");
          im.src = url;
        } catch { resolve(""); }
      });
    }

    /* ---------------------------------------------------------------- rails -- */
    /** Thin bar above the shelves: how many are on this mix, and the Shuffle control. */
    function shelfBar(n) {
      return h("div.discover-bar",
        h("p.discover-bar-note", t("{n} shelves picked for this visit", { n })),
        W.btn("Shuffle", { icon: "shuffle", kind: "ghost", onClick: shuffle, title: t("New shelves and a new spotlight") }));
    }

    function startList(spec, label) {
      const ids = catalog.query(spec).items.map((p) => p.id);
      if (!ids.length) return actions.toast("Nothing matches right now");
      actions.watch(ids, 0, { label, spec });
    }

    function rail(r, railIndex = 99) {
      const ids = r.items.map((p) => p.id);
      /* above the fold: the first row of the first two shelves fetches at high priority
         so thumbnails land before the billboard trailer starts streaming */
      const hot = railIndex < 2;
      const title = t(r.title, r.params), hint = r.hint ? t(r.hint, r.hintParams) : "";
      const acts = [];
      if (r.watchable) acts.push({ label: "Watch", icon: "play", run: () => actions.watch(ids, 0, { label: title, spec: r.spec }) });
      if (r.spec && !r.specDisabled) acts.push({ label: "Explore all", icon: "grid", run: () => actions.goLibrary(engine.toParams(r.spec)), title: "Open in Library" });
      const ranked = r.layout === "rank";

      const api = railUI.createRail({
        id: r.id, title, hint, size: r.layout === "wide" ? "wide" : ranked ? "rank" : "",
        actions: acts,
        /* shelves build their tiles when they approach the viewport: Discover mounts
           in one frame instead of allocating ~200 cards up front */
        items: r.items, lazy: true, skeleton: ranked ? 5 : 7,
        render: (post, i) => ranked ? rankCard(post, i, { ids, label: title })
          : tiles.make(post, {
            ids, index: i, label: title,
            width: r.layout === "wide" ? 320 : 260,
            shape: "wide",
            tag: (r.id === "recent" || r.id === "fresh") && isFresh(post) ? "NEW" : "",
            priority: hot && i < 5,
          }),
      });
      rails.push(api);
      return api.el;
    }

    /* ranked Top-10 card: giant gradient numeral + portrait poster */
    function rankCard(post, i, { ids, label }) {
      const tone = i === 0 ? "1" : i < 3 ? "2" : "3";
      const tile = tiles.make(post, { ids, index: i, label, width: 167, shape: "poster", priority: i < 5 });
      return { el: h("div.rank-card", h("span.rank-num", { "data-tone": tone, "aria-hidden": "true" }, String(i + 1)), h("div.rank-tile", tile.el)), post, update: tile.update.bind(tile), destroy: () => tile.destroy() };
    }

    /* --------------------------------------------------------------- footer -- */
    function foot(stats) {
      return h("footer.foot",
        h("div.foot-hairline"),
        h("div.foot-in",
          h("div.foot-brand", h("span.foot-word", "X"), h("span.foot-word-rest", "REELS")),
          h("p.foot-meta",
            `${dom.compact(stats.posts)} ${t("posts")} · ${dom.compact(stats.videos)} ${t("videos")} · ${dom.hours(stats.seconds)} ${t("of footage")} · ${stats.collections} ${t("collections")}`),
          h("p.foot-note", t("Local-first — everything stays in this browser. Nothing is sent anywhere.")),
          h("p.foot-copy", "XReels © 2026")));
    }

    /* ------------------------------------------------------ pull to shuffle -- */
    /** Touch: drag the page down from the very top past the threshold to reshuffle.
        The outlet has overscroll-behavior: contain, so this never fights the browser. */
    function pullToShuffle(scroller) {
      const THRESHOLD = 72, MAX = 110;
      let startY = 0, pulling = false, armed = false, dy = 0;
      const pill = h("div.discover-pull", { "aria-hidden": "true" }, icons.icon("shuffle", 18), h("span", t("Release to shuffle")));
      const reset = () => { pulling = false; armed = false; dy = 0; pill.classList.remove("is-armed", "is-pulling"); pill.style.removeProperty("--pull"); };
      const onStart = (e) => { if (!host || scroller.scrollTop > 0 || e.touches.length !== 1) return; startY = e.touches[0].clientY; pulling = true; dy = 0; };
      const onMove = (e) => {
        if (!pulling) return;
        dy = e.touches[0].clientY - startY;
        if (dy <= 0 || scroller.scrollTop > 0) { if (dy <= 0) reset(); return; }
        if (!pill.isConnected) document.body.appendChild(pill);
        const eased = Math.min(MAX, dy * 0.55);
        pill.style.setProperty("--pull", eased + "px");
        pill.classList.add("is-pulling");
        const nowArmed = eased >= THRESHOLD * 0.55;
        if (nowArmed !== armed) { armed = nowArmed; pill.classList.toggle("is-armed", armed); if (armed) platform.vibrate?.(8); }
      };
      const onEnd = () => { const fire = armed; reset(); if (fire) shuffle(); };
      scroller.addEventListener("touchstart", onStart, { passive: true });
      scroller.addEventListener("touchmove", onMove, { passive: true });
      scroller.addEventListener("touchend", onEnd, { passive: true });
      scroller.addEventListener("touchcancel", reset, { passive: true });
      return () => { scroller.removeEventListener("touchstart", onStart); scroller.removeEventListener("touchmove", onMove); scroller.removeEventListener("touchend", onEnd); scroller.removeEventListener("touchcancel", reset); pill.remove(); };
    }

    function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (host) { for (const r of rails) r.each((t2) => t2.update && t2.update()); } }, 150); }

    return {
      id: "discover", title: "Discover", icon: "sparkles", route: "/discover", nav: true, order: 10, key: "d",
      mount(outlet) {
        host = outlet;
        render();
        keys.bind("discover", "r", () => shuffle(), { desc: "Shuffle Discover" });
        keys.push("discover");
        offs = [
          pullToShuffle(outlet),
          events.bus.on(EV.ACTIVITY_CHANGED, ({ kind }) => { if (kind === "bulk" || kind === "hide") render(); else scheduleRefresh(); }),
          events.bus.on(EV.DATASET_CHANGED, render),
          events.bus.on(EV.PREFS_CHANGED, ({ patch }) => { if (["tileShape", "tileInfo", "blur", "seenDim", "shortMaxSeconds", "hideSensitive"].some((k) => k in patch)) render(); }),
        ];
      },
      unmount() { for (const off of offs) off(); offs = []; keys.pop("discover"); keys.unbindScope("discover"); for (const r of rails) r.destroy(); rails = []; host = null; },
      commands: () => [
        { id: "discover.shuffle", title: "Shuffle play", hint: "Random posts in Watch", icon: "shuffle", run: () => actions.shufflePlay() },
        { id: "discover.refresh", title: "Reshuffle Discover", hint: "New shelves and a new spotlight", icon: "shuffle", run: shuffle },
      ],
    };
  });
