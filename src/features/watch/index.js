/* features.watch — the vertical, one-post-at-a-time feed (TikTok style).
   Virtualised: only the current cell ±2 exist. Navigation is transform based so
   wheel notches, swipes and keys all move exactly one post. */
XR.define("features.watch", ["features.watch.cell", "ui.dom", "ui.icons", "ui.widgets", "ui.menu", "ui.postMenu", "ui.keys", "app.catalog", "app.activity", "app.actions", "app.feedContext", "app.playback", "app.prefs", "app.media", "app.nav", "app.ports.platform", "core.events", "core.domain.events", "core.util"],
  function (cellUI, dom, icons, W, menu, postMenu, keys, catalog, activity, actions, feed, playback, prefs, media, nav, platform, events, EV, util) {
    "use strict";
    const h = dom.h;
    const WINDOW = 2;
    const S = { host: null, root: null, track: null, ids: [], index: 0, cells: new Map(), label: "", spec: null, fitOverride: null, offs: [], seenTimer: 0, lastNav: 0, wheelAcc: 0, wheelTimer: 0, els: {}, endCard: null, infoOpen: false, nextCancelled: false, nextT: 0, nextEnd: 0, idleT: 0, lastAct: 0, posAt: 0 };

    /* ------------------------------------------------------------ context -- */
    function resolveContext(route) {
      let ctx = feed.get();
      const want = route.query.post;
      if (want && (!ctx || !ctx.ids.includes(want))) {
        const all = catalog.query({ sort: "saved" }).items.map((p) => p.id);
        const i = Math.max(0, all.indexOf(want));
        ctx = feed.set(all, i, { label: "Everything", origin: "deeplink" });
      } else if (want && ctx) { ctx.index = ctx.ids.indexOf(want); }
      if (!ctx || !ctx.ids.length) {
        let list = catalog.query({ kind: "short", state: "unseen", sort: "random", seed: util.daySeed() }).items;
        let label = "Unseen shorts";
        if (list.length < 5) { list = catalog.query({ state: "unseen", sort: "random", seed: util.daySeed() }).items; label = "Unseen"; }
        if (list.length < 5) { list = catalog.query({ sort: "random", seed: Date.now() % 99999 }).items; label = "Shuffle"; }
        ctx = feed.set(list.map((p) => p.id), 0, { label, origin: "auto" });
      }
      // drop ids that no longer exist (dataset replaced)
      const ids = ctx.ids.filter((id) => catalog.post(id));
      S.ids = ids; S.index = util.clamp(ctx.index || 0, 0, Math.max(0, ids.length - 1)); S.label = ctx.label || "Watch"; S.spec = ctx.spec || null;
    }

    /* -------------------------------------------------------------- mount -- */
    function mount(outlet, route) {
      S.host = outlet;
      resolveContext(route);
      S.fitOverride = null;
      const track = h("div.watch-track");
      const top = h("div.watch-top",
        W.iconBtn("arrowLeft", "Back (Esc)", () => nav.back("discover"), { cls: "watch-back" }),
        h("div.watch-title", h("b.watch-label", S.label), h("span.watch-counter")),
        h("div.watch-top-actions",
          W.iconBtn("fit", "Fit / fill (x)", () => cycleFit(), { cls: "watch-fit" }),
          W.iconBtn("sliders", "Player options", () => playerOptions(), { cls: "watch-options" })));
      const side = h("div.watch-side",
        h("button.side-btn.side-mute", { "aria-label": "Mute / unmute", title: "Mute (m)", onclick: () => playback.toggleMuted() }, icons.icon(playback.muted ? "mute" : "volume", 26), h("span.side-label", "Sound")),
        h("button.side-btn.side-info", { "aria-label": "Caption and details", title: "Caption & details (i)", onclick: (e) => { e.stopPropagation(); toggleInfo(); } }, icons.icon("info", 26), h("span.side-label", "Info")),
        h("button.side-btn.side-options", { "aria-label": "Player options", title: "Player options", onclick: (e) => { e.stopPropagation(); playerOptions(); } }, icons.icon("sliders", 26), h("span.side-label", "Options")),
        h("button.side-btn", { "aria-label": "Post actions", title: "More", onclick: (e) => { const p = current(); if (p) postMenu.open(p, e.currentTarget, { ids: S.ids, index: S.index, label: S.label, noWatch: true, noOpen: true }); } }, icons.icon("more", 26), h("span.side-label", "More")));
      const arrows = h("div.watch-arrows", W.iconBtn("chevronUp", "Previous (↑)", () => go(-1), { cls: "watch-arrow watch-arrow-up", size: 24 }), W.iconBtn("chevronDown", "Next (↓)", () => go(1), { cls: "watch-arrow watch-arrow-down", size: 24 }));
      const hud = h("div.watch-hud");
      const upnext = h("button.watch-upnext", { title: "Up next (↓)", onclick: () => go(1) });
      const info = h("div.watch-info-card");
      const nextup = h("div.watch-nextup",
        h("div.nextup-progress", h("div.nextup-fill")),
        h("div.nextup-row",
          h("img.nextup-thumb", { alt: "" }),
          h("div.nextup-text", h("i", "Up next"), h("b.nextup-creator"), h("span.nextup-count"))),
        h("div.nextup-actions",
          W.btn("Next", { icon: "chevronDown", kind: "primary", onClick: (e) => { e.stopPropagation(); fireNext(); } }),
          W.btn("Cancel", { icon: "x", onClick: (e) => { e.stopPropagation(); cancelNext(); } })));
      const root = h("div.watch", { tabindex: "-1" }, track, top, side, arrows, hud, upnext, info, nextup, h("div.watch-heart", icons.icon("heart", 96, { filled: true })), h("div.watch-seekflash"));
      outlet.appendChild(root);
      S.root = root; S.track = track; S.els = { top, side, arrows, hud, upnext, info, nextup, counter: top.querySelector(".watch-counter"), label: top.querySelector(".watch-label") };
      S.infoOpen = false; S.nextCancelled = false;
      const unbindGestures = bindGestures();
      bindKeys();
      armIdle();
      renderWindow(true);
      bindMediaSession();
      syncMediaSession();
      S.offs = [
        unbindGestures,
        events.bus.on(EV.ACTIVITY_CHANGED, () => { if (S.infoOpen) renderInfo(); }),
        events.bus.on(EV.PLAYBACK_CHANGED, ({ muted }) => dom.replace(side.querySelector(".side-mute"), icons.icon(muted ? "mute" : "volume", 26), h("span.side-label", muted ? "Muted" : "Sound"))),
        events.bus.on(EV.PREFS_CHANGED, ({ patch }) => { if ("fit" in patch) { S.fitOverride = null; S.cells.forEach((c) => c.fit(fitMode())); } }),
        dom.on(window, "resize", dom.rafThrottle(() => S.cells.forEach((c) => c.fit(fitMode())))),
        dom.on(window, "keydown", () => { S.lastAct = Date.now(); }),
        dom.on(document, "visibilitychange", () => {
          if (document.hidden) { setWake(false); return; }
          const c = S.cells.get(S.index);
          if (c?.video && !c.video.paused) setWake(true);
        }),
      ];
      if (!S.ids.length) dom.replace(root, W.empty({ icon: "play", title: "Nothing to watch", text: "Import posts or pick a list from Discover or Library.", action: { label: "Go to Library", run: () => nav.go("library") } }));
      root.focus({ preventScroll: true });
    }
    function unmount() {
      for (const off of S.offs) off(); S.offs = [];
      setWake(false);
      const ms = mediaApi();
      if (ms) {
        for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekbackward", "seekforward"]) {
          try { ms.setActionHandler(action, null); } catch { /* action unsupported */ }
        }
        try { ms.metadata = null; ms.playbackState = "none"; } catch { /* unsupported */ }
      }
      keys.pop("watch"); keys.unbindScope("watch");
      clearTimeout(S.seenTimer); clearTimeout(S.wheelTimer); clearTimeout(flashTimer);
      menu.close();
      for (const c of S.cells.values()) c.destroy(); S.cells.clear();
      feed.setIndex(S.index);
      S.endCard?.remove(); S.endCard = null;
      S.root = null; S.host = null; S.track = null;
      clearInterval(S.idleT); S.idleT = 0;
      killNextup(); S.infoOpen = false;
    }
    function update(route) { if (route.query.post && S.ids[S.index] !== route.query.post) { const i = S.ids.indexOf(route.query.post); if (i >= 0) jump(i); else { const host = S.host; unmount(); mount(host, route); } } }

    const current = () => catalog.post(S.ids[S.index]) || null;
    const fitMode = () => S.fitOverride || prefs.get("fit");

    /* ------------------------------------------------------------- window -- */
    function cellEnv() {
      return {
        playback, media, prefs, catalog, fitMode,
        onEnded: () => { if (prefs.get("autoAdvance")) go(1); },
        onVideoEnded: () => { if (prefs.get("autoAdvance")) armUpNext(); },
        onOpenCreator: (u) => actions.goCreator(u),
        onTag: (t) => actions.goTag(t),
        onOpenX: (p) => actions.openOnX(p),
        onNext: () => go(1),
        onRetry: () => { const c = S.cells.get(S.index); if (c) { c.destroy(); S.cells.delete(S.index); renderWindow(); } },
        onHide: (p) => { actions.hide(p); if (!go(1)) go(-1); },
        onUnplayable: () => { S.els?.upnext?.classList.remove("on"); },
        onPlayState: (playing, el) => {
          const cell = S.cells.get(S.index);
          if (cell?.el !== el) return;
          const ms = mediaApi(); if (ms) ms.playbackState = playing ? "playing" : "paused";
          if (cell.video) syncMediaPosition(cell.video);
          setWake(playing);
        },
        onProgress: () => {
          const cell = S.cells.get(S.index);
          if (!cell?.video) return;
          const now = Date.now();
          if (now - S.posAt < 900) return;
          S.posAt = now;
          syncMediaPosition(cell.video);
        },
        onCarouselEnd: () => {}, onCarouselStart: () => {},
        markSeen: () => {},
      };
    }
    function renderWindow(initial = false) {
      if (!S.track) return;
      const lo = Math.max(0, S.index - WINDOW), hi = Math.min(S.ids.length - 1, S.index + WINDOW);
      for (const [i, c] of S.cells) if (i < lo || i > hi) { c.destroy(); S.cells.delete(i); }
      for (let i = lo; i <= hi; i++) {
        if (S.cells.has(i)) continue;
        const post = catalog.post(S.ids[i]);
        if (!post) continue;
        const c = cellUI.createCell(post, cellEnv());
        c.el.style.transform = `translate3d(0, ${(i - S.index) * 100}%, 0)`;
        c.el.classList.add("no-anim");
        S.cells.set(i, c);
        S.track.appendChild(c.el);
        requestAnimationFrame(() => c.el.classList.remove("no-anim"));
      }
      // end card as a pseudo cell
      if (S.index >= S.ids.length - 1 - WINDOW && S.ids.length) {
        if (!S.endCard) { S.endCard = endCard(); S.track.appendChild(S.endCard); }
        S.endCard.inert = true; S.endCard.setAttribute("aria-hidden", "true"); S.endCard.classList.remove("is-active");
        S.endCard.style.transform = `translate3d(0, ${(S.ids.length - S.index) * 100}%, 0)`;
      } else if (S.endCard) { S.endCard.remove(); S.endCard = null; }
      position(0, initial);
      for (const [i, c] of S.cells) {
        if (i === S.index) c.activate();
        else { c.deactivate(); if (Math.abs(i - S.index) === 1) c.prepare(); }
      }
      S.els.counter.textContent = S.ids.length ? `${S.index + 1} / ${S.ids.length}` : "";
      renderUpNext();
      S.els.arrows.querySelector(".watch-arrow-up").disabled = S.index <= 0;
      S.els.arrows.querySelector(".watch-arrow-down").disabled = S.index >= S.ids.length;
      scheduleSeen();
      feed.setIndex(S.index);
      syncMediaSession();
      /* A swipe between posts may land on a photo or an unstarted clip; the
         wake lock follows the active cell, not the previous one's events. */
      const active = S.cells.get(S.index);
      setWake(!!(active?.video && !active.video.paused));
    }
    function position(dragPx = 0, instant = false) {
      S.track.classList.toggle("is-dragging", dragPx !== 0);
      for (const [i, c] of S.cells) c.el.style.transform = `translate3d(0, calc(${(i - S.index) * 100}% + ${dragPx}px), 0)`;
      if (S.endCard) S.endCard.style.transform = `translate3d(0, calc(${(S.ids.length - S.index) * 100}% + ${dragPx}px), 0)`;
    }
    function go(delta) {
      const moving = S.infoOpen || S.els.nextup.classList.contains("on");
      const next = S.index + delta;
      if (next < 0) { bounce(); return false; }
      if (next > S.ids.length) return false;
      if (next === S.ids.length && !S.endCard) return false;
      S.lastNav = Date.now();
      if (moving) { S.infoOpen = false; S.els.info.classList.remove("on"); killNextup(); }
      S.index = next;
      if (S.index === S.ids.length) { // end card
        for (const c of S.cells.values()) c.deactivate();
        S.endCard.inert = false; S.endCard.removeAttribute("aria-hidden"); S.endCard.classList.add("is-active");
        position(0);
        S.els.counter.textContent = `${S.ids.length} / ${S.ids.length}`;
        syncMediaSession();
        return true;
      }
      renderWindow();
      return true;
    }
    function jump(i) { S.index = util.clamp(i, 0, S.ids.length - 1); for (const c of S.cells.values()) c.destroy(); S.cells.clear(); renderWindow(true); }
    function bounce() { const track = S.track; track?.classList.add("bounce"); setTimeout(() => track?.classList.remove("bounce"), 300); }
    function endCard() {
      return h("section.cell.cell-end", h("div.end-card", icons.icon("check", 40), h("h2", "You're all caught up"), h("p.muted", `${S.ids.length} posts · ${S.label}`),
        h("div.end-actions", W.btn("Shuffle more", { icon: "shuffle", kind: "primary", onClick: () => actions.shufflePlay() }), W.btn("Unseen shorts", { icon: "zap", onClick: () => { const list = catalog.query({ kind: "short", state: "unseen", sort: "random", seed: Date.now() % 9999 }).items.map((p) => p.id); if (list.length) { feed.set(list, 0, { label: "Unseen shorts" }); jump(0); S.label = "Unseen shorts"; S.els.label.textContent = S.label; } else actions.toast("No unseen shorts left"); } }), W.btn("Back", { icon: "arrowLeft", onClick: () => nav.back("discover") }))));
    }
    function scheduleSeen() {
      clearTimeout(S.seenTimer);
      const p = current(); if (!p) return;
      S.seenTimer = setTimeout(() => { if (current() === p) activity.noteOpen(p); }, 1500);
    }
    /* ----------------------------------------------------- info & rail -- */
    function toggleInfo() { if (S.infoOpen) closeInfo(); else openInfo(); }
    function openInfo() {
      S.infoOpen = true;
      renderInfo();
      S.els.info.classList.add("on");
      S.lastAct = Date.now();
    }
    function closeInfo() {
      S.infoOpen = false;
      if (S.els?.info) S.els.info.classList.remove("on");
    }
    function renderInfo() {
      const p = current(); if (!p || !S.els.info) return;
      const card = S.els.info;
      dom.clear(card);
      const m = p.media[0];
      const colls = activity.collectionsOf(p.id);
      card.appendChild(h("div.wi-head", h("b", "Caption & details"),
        h("button.btn.btn-icon.wi-close", { title: "Close", onclick: (e) => { e.stopPropagation(); closeInfo(); } }, icons.icon("x", 16))));
      /* the account circle (was on the side rail): avatar + name/handle, tap for profile */
      card.appendChild(h("button.wi-creator", { title: "View profile", onclick: (e) => { e.stopPropagation(); actions.goCreator(p.author.username); } },
        h("span.wi-creator-avatar", W.avatar(media.avatar(p, 64), p.author.name, 40)),
        h("span.wi-creator-text",
          h("b", p.author.name || p.author.username),
          h("span.wi-creator-handle", "@" + p.author.username))));
      if (p.text) {
        card.appendChild(h("div.wi-caption",
          dom.richText(p.rawText || p.text, { onTag: (t) => actions.goTag(t), onUser: (u) => actions.goCreator(u) })));
      }
      if (p.quoted) {
        card.appendChild(h("blockquote.wi-quote",
          h("b", p.quoted.author_name || "@" + p.quoted.author_username),
          h("span", " @" + p.quoted.author_username),
          h("p", p.quoted.text || "")));
      }
      if (p.hashtags && p.hashtags.length) {
        card.appendChild(h("div.wi-tags", p.hashtags.slice(0, 5).map((t) =>
          W.chip({ label: "#" + t, onClick: (e) => { e.stopPropagation(); actions.goTag(t); } }))));
      }
      card.appendChild(h("div.wi-metrics",
        p.metrics.likes ? h("span", icons.icon("heart", 14, { filled: true }), dom.compact(p.metrics.likes)) : null,
        p.metrics.reposts ? h("span", icons.icon("repeat", 14), dom.compact(p.metrics.reposts)) : null,
        p.metrics.replies ? h("span", icons.icon("message", 14), dom.compact(p.metrics.replies)) : null,
        p.metrics.views ? h("span", icons.icon("eye", 14), dom.compact(p.metrics.views)) : null));
      card.appendChild(h("dl.wi-facts",
        h("div", h("dt", "Posted"), h("dd", dom.dateTime(p.createdAt))),
        h("div", h("dt", "Saved"), h("dd", dom.dateTime(p.savedAt))),
        m && m.kind === "video" ? h("div", h("dt", "Length"), h("dd", dom.duration(m.duration))) : null,
        m && m.width ? h("div", h("dt", "Size"), h("dd", `${m.width}×${m.height}`)) : null,
        p.flags.repostedBy ? h("div", h("dt", "Reposted by"), h("dd", "@" + p.flags.repostedBy)) : null,
        colls.length ? h("div", h("dt", "Collections"), h("dd", colls.map((c) => c.name).join(", "))) : null));
    }

    /* ---------------------------------------------- up next overlay -- */
    function armUpNext() {
      const next = catalog.post(S.ids[S.index + 1]);
      const card = S.els.nextup;
      if (!next || !next.media.length || !card) return;
      if (S.nextCancelled) { S.nextCancelled = false; flash("Auto-advance skipped"); return; }
      if (card.classList.contains("on")) return;
      card.querySelector(".nextup-thumb").src = media.thumb(next.media[0], 200);
      card.querySelector(".nextup-creator").textContent = "@" + next.author.username;
      card.classList.add("on");
      const secs = 6;
      S.nextEnd = Date.now() + secs * 1000;
      card.querySelector(".nextup-fill").style.width = "0%";
      card.querySelector(".nextup-count").textContent = `starts in ${secs}s`;
      clearInterval(S.nextT);
      S.nextT = setInterval(() => {
        if (!S.els?.nextup) { clearInterval(S.nextT); return; }
        const left = S.nextEnd - Date.now();
        if (left <= 0) { fireNext(); return; }
        const cardEl = S.els.nextup;
        cardEl.querySelector(".nextup-fill").style.width = `${Math.min(100, (1 - left / (secs * 1000)) * 100).toFixed(1)}%`;
        cardEl.querySelector(".nextup-count").textContent = `starts in ${Math.max(1, Math.ceil(left / 1000))}s`;
      }, 150);
    }
    function fireNext() { killNextup(false); go(1); }
    function cancelNext() { killNextup(true); flash("Auto-advance skipped"); }
    function killNextup(consume = false) {
      clearInterval(S.nextT); S.nextT = 0;
      if (S.els?.nextup) S.els.nextup.classList.remove("on");
      if (consume) S.nextCancelled = true;
    }

    /* -------------------------------------------------------------- idle -- */
    /* ------------------------------------------------ lock screen & wake -- */
    let wakeLock = null;
    async function setWake(on) {
      if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
      if (on) {
        if (wakeLock) return;
        try {
          wakeLock = await navigator.wakeLock.request("screen");
          wakeLock.addEventListener("release", () => { wakeLock = null; });
        } catch { wakeLock = null; }
        return;
      }
      if (!wakeLock) return;
      try { await wakeLock.release(); } catch { /* already gone */ }
      wakeLock = null;
    }

    const mediaApi = () => { try { return navigator.mediaSession || null; } catch { return null; } };

    function mediaArtwork(post) {
      const m = post && post.media && post.media[0];
      const src = m && (m.poster || m.thumb);
      return src ? [{ src, sizes: "512x512" }] : [];
    }

    function syncMediaSession() {
      const ms = mediaApi(); if (!ms) return;
      const post = current();
      if (!post) { try { ms.metadata = null; ms.playbackState = "none"; } catch { /* unsupported */ } return; }
      try {
        ms.metadata = new MediaMetadata({
          title: post.text ? post.text.slice(0, 90) : S.label,
          artist: "@" + (post.author?.username || "X"),
          album: S.label || "XReels",
          artwork: mediaArtwork(post),
        });
      } catch { /* MediaMetadata unavailable */ }
      const v = S.cells.get(S.index)?.video;
      ms.playbackState = v && !v.paused ? "playing" : "paused";
    }

    function syncMediaPosition(video) {
      const ms = mediaApi(); if (!ms || !ms.setPositionState || !video) return;
      const d = video.duration;
      if (!(d > 0) || !Number.isFinite(d)) return;
      try { ms.setPositionState({ duration: d, playbackRate: video.playbackRate || 1, position: Math.min(video.currentTime || 0, d) }); } catch { /* ignore */ }
    }

    function bindMediaSession() {
      const ms = mediaApi(); if (!ms) return;
      const set = (name, fn) => { try { ms.setActionHandler(name, fn); } catch { /* action unsupported */ } };
      set("play", () => { const v = S.cells.get(S.index)?.video; if (v) v.play(); });
      set("pause", () => { const v = S.cells.get(S.index)?.video; if (v) v.pause(); });
      set("previoustrack", () => go(-1));
      set("nexttrack", () => go(1));
      set("seekbackward", () => S.cells.get(S.index)?.seekBy(-10));
      set("seekforward", () => S.cells.get(S.index)?.seekBy(10));
    }
    function armIdle() {
      clearInterval(S.idleT);
      S.lastAct = Date.now();
      S.idleT = setInterval(() => {
        if (!S.root) { clearInterval(S.idleT); return; }
        const c = S.cells.get(S.index);
        const playing = c?.video && !c.video.paused && !c.video.ended;
        const upOpen = S.els.nextup.classList.contains("on");
        const focusedControl = document.activeElement !== S.root && S.root.contains(document.activeElement) && document.activeElement.matches(":focus-visible");
        const scrubbing = c?.el.classList.contains("is-scrubbing");
        const idle = Date.now() - S.lastAct > 3500 && playing && !S.infoOpen && !upOpen && !menu.isOpen && !focusedControl && !scrubbing;
        S.root.classList.toggle("is-idle", Boolean(idle));
      }, 700);
    }
    function toggleStar() { const p = current(); if (!p) return; const on = actions.star(p); if (on) heart(); }
    function heart() { const el = S.root.querySelector(".watch-heart"); el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); platform.vibrate(12); }
    /** double-tap feedback: a pill at the finger, pointing where the video went */
    function seekFlash(text, x, y, side) {
      const el = S.root?.querySelector(".watch-seekflash");
      if (!el) return;
      el.textContent = text;
      el.style.left = util.clamp(x, 58, S.root.clientWidth - 58) + "px";
      el.style.top = util.clamp(y, 74, S.root.clientHeight - 74) + "px";
      el.dataset.side = side;
      el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
      clearTimeout(seekFlashTimer); seekFlashTimer = setTimeout(() => el.classList.remove("pop"), 700);
    }
    let seekFlashTimer = 0;
    function playerOptions() {
      const items = [
        { label: "Fit / fill", icon: "fit", run: cycleFit },
        { label: "Up next", icon: "list", run: () => queueSheet() },
      ];
      /* Anchor on the control that is actually visible for this input mode. */
      menu.open(S.root?.querySelector(platform.canHover() ? ".watch-options" : ".side-options"), items, { title: "Player options" });
    }
    function cycleFit() {
      const cell = S.cells.get(S.index);
      const mediaItem = cell?.post.media[cell.carousel?.index ?? 0];
      const aspect = Number(mediaItem?.aspect) || (mediaItem?.width && mediaItem?.height ? mediaItem.width / mediaItem.height : 1);
      if (platform.isMobileView() && mediaItem?.kind !== "photo" && aspect > 1.05 && cell?.video) {
        void platform.landscapeFullscreen(S.root, cell.video);
      }
      const order = ["auto", "cover", "contain"];
      const cur = fitMode();
      S.fitOverride = order[(order.indexOf(cur) + 1) % order.length];
      S.cells.forEach((c) => c.fit(S.fitOverride));
      flash(S.fitOverride === "cover" ? "Fill" : S.fitOverride === "contain" ? "Fit" : "Auto");
    }
    function renderUpNext() {
      const el = S.els?.upnext; if (!el) return;
      const next = catalog.post(S.ids[S.index + 1]);
      if (!next || !next.media.length) { el.classList.remove("on"); return; }
      const m = next.media[0];
      dom.replace(el, h("img", { src: media.thumb(m, 120), alt: "" }), h("span.upnext-text", h("i", XR.resolve("core.i18n").t("Up next")), h("b", "@" + next.author.username)));
      el.classList.add("on");
    }
    function queueSheet(anchor = null) {
      const t = XR.resolve("core.i18n").t;
      const items = [];
      for (let i = Math.max(0, S.index - 2); i < Math.min(S.ids.length, S.index + 12); i++) {
        const p = catalog.post(S.ids[i]); if (!p) continue;
        items.push({ label: `${i + 1}. @${p.author.username} — ${(p.text || "").slice(0, 48) || p.media[0]?.kind || ""}`, checked: i === S.index, icon: i < S.index ? "check" : (p.media[0]?.kind === "video" ? "play" : "image"), run: () => jump(i) });
      }
      menu.open(anchor, items, { title: t("Up next") + ` · ${S.index + 1}/${S.ids.length}` });
    }
    let flashTimer = 0;
    function flash(text, sticky = false) { const hud = S.els.hud; hud.textContent = text; hud.classList.add("on"); clearTimeout(flashTimer); if (!sticky) flashTimer = setTimeout(() => hud.classList.remove("on"), 700); }
    const hideFlash = () => { clearTimeout(flashTimer); S.els.hud.classList.remove("on"); };

    /* ----------------------------------------------------------- gestures -- */
    function bindGestures() {
      const root = S.root;
      root.addEventListener("pointermove", () => { S.lastAct = Date.now(); }, { passive: true });
      root.addEventListener("pointerdown", () => { S.lastAct = Date.now(); }, { passive: true });
      // wheel: one post per notch, with a cooldown so trackpad inertia doesn't skip
      root.addEventListener("wheel", (e) => {
        if (e.target.closest(".watch-info-card")) return;
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal → carousel scroller
        e.preventDefault();
        if (!prefs.get("wheelStep")) { if (Math.abs(e.deltaY) > 30 && Date.now() - S.lastNav > 300) go(e.deltaY > 0 ? 1 : -1); return; }
        if (Date.now() - S.lastNav < 450) { S.wheelAcc = 0; return; }
        S.wheelAcc += e.deltaY;
        clearTimeout(S.wheelTimer); S.wheelTimer = setTimeout(() => { S.wheelAcc = 0; }, 160);
        if (Math.abs(S.wheelAcc) >= 40) { const d = S.wheelAcc > 0 ? 1 : -1; S.wheelAcc = 0; go(d); }
      }, { passive: false });

      let drag = null, lastTap = null, tapTimer = 0, holdTimer = 0, holding = false;
      const H = () => root.clientHeight || innerHeight;
      root.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest("button, a, .cell-bar, .watch-top, .watch-side, .watch-arrows, .watch-info-card, .watch-nextup, .carousel-arrow, .cell-unplayable")) return;
        const cell = S.cells.get(S.index);
        drag = { x0: e.clientX, y0: e.clientY, t0: Date.now(), axis: null, id: e.pointerId, type: e.pointerType, cell, seekFrom: 0, dur: 0, moved: false, carousel: e.target.closest(".carousel"), wasIdle: root.classList.contains("is-idle") };
        root.classList.remove("is-idle", "chrome-hidden");
        holding = false;
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => { if (drag && !drag.moved && cell?.video) { holding = true; cell.setRate(Math.max(2, playback.speed)); flash("2×", true); root.classList.add("is-holding"); } }, 450);
      });
      root.addEventListener("pointermove", (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
        if (!drag.axis) {
          if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
          drag.moved = true; clearTimeout(holdTimer);
          if (holding) return;
          drag.axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
          if (drag.axis === "x") {
            if (drag.carousel) {
              drag.scrollFrom = drag.carousel.scrollLeft;
              root.classList.add("is-carousel-dragging");
            } else {
              if (!drag.cell?.video) { drag = null; return; }
              const v = drag.cell.video; drag.seekFrom = v.currentTime; drag.dur = v.duration || drag.cell.handle.media.duration;
              if (!Number.isFinite(drag.dur) || drag.dur <= 0) { drag = null; return; }
            }
            root.setPointerCapture?.(e.pointerId);
          } else root.setPointerCapture?.(e.pointerId);
        }
        if (drag.axis === "y") { position(dy * 0.9); }
        else if (drag.axis === "x" && drag.carousel) {
          drag.carousel.scrollLeft = drag.scrollFrom - dx;
        } else if (drag.axis === "x") {
          const w = root.clientWidth || innerWidth;
          const t = util.clamp(drag.seekFrom + (dx / w) * drag.dur, 0, drag.dur);
          drag.seekTo = t;
          flash(`${dom.duration(t)} / ${dom.duration(drag.dur)}`, true);
          if (!drag.seekRaf) drag.seekRaf = requestAnimationFrame(() => { drag && drag.cell.handle.seek(drag.seekTo); if (drag) drag.seekRaf = 0; });
        }
      });
      const end = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag; drag = null;
        clearTimeout(holdTimer); cancelAnimationFrame(d.seekRaf);
        if (root.hasPointerCapture?.(e.pointerId)) root.releasePointerCapture(e.pointerId);
        if (holding) { holding = false; d.cell?.setRate(playback.speed); hideFlash(); root.classList.remove("is-holding"); return; }
        const dx = e.clientX - d.x0, dy = e.clientY - d.y0, dt = Date.now() - d.t0;
        if (d.axis === "y") {
          const v = Math.abs(dy) / Math.max(1, dt);
          if (Math.abs(dy) > Math.min(90, H() * 0.15) || v > 0.6) { if (!go(dy < 0 ? 1 : -1)) position(0); }
          else position(0);
        } else if (d.axis === "x" && d.carousel) {
          const w = d.carousel.clientWidth;
          const from = Math.round(d.scrollFrom / w);
          const advance = Math.abs(dx) > w * 0.15 || Math.abs(dx) / Math.max(1, dt) > 0.5;
          const to = util.clamp(from + (advance ? (dx < 0 ? 1 : -1) : 0), 0, d.cell.carousel.length - 1);
          root.classList.remove("is-carousel-dragging");
          d.carousel.scrollTo({ left: to * w, behavior: document.documentElement.dataset.motion === "reduce" ? "auto" : "smooth" });
        } else if (d.axis === "x") { hideFlash(); d.cell.handle.seek(d.seekTo ?? d.seekFrom); }
        else if (!d.moved && dt < 350) { // tap
          const now = Date.now();
          if (lastTap && now - lastTap.at < 280 && lastTap.cell === d.cell && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 44) {
            clearTimeout(tapTimer); lastTap = null;
            const cell = S.cells.get(S.index);
            const r = root.getBoundingClientRect();
            const x = (e.clientX - r.left) / Math.max(1, r.width);
            /* double-tap on the flanks skips, double-tap in the middle stars —
               the gesture a phone expects, without losing the like */
            if (cell?.video && d.type === "touch" && x < 0.4) { cell.seekBy(-10); seekFlash("−10s", e.clientX - r.left, e.clientY - r.top, "left"); }
            else if (cell?.video && d.type === "touch" && x > 0.6) { cell.seekBy(10); seekFlash("+10s", e.clientX - r.left, e.clientY - r.top, "right"); }
            else { const p = current(); if (p && !activity.isStarred(p.id)) actions.star(p); heart(); }
          }
          else {
            clearTimeout(tapTimer);
            lastTap = { at: now, x: e.clientX, y: e.clientY, cell: d.cell };
            tapTimer = setTimeout(() => {
              lastTap = null;
              if (S.root !== root || S.cells.get(S.index) !== d.cell || d.wasIdle) return;
              if (d.cell?.video) d.cell.togglePlay(); else root.classList.toggle("chrome-hidden");
            }, 280);
          }
        }
      };
      root.addEventListener("pointerup", end);
      function cancelGesture() {
        clearTimeout(holdTimer); clearTimeout(tapTimer); lastTap = null;
        if (drag) cancelAnimationFrame(drag.seekRaf);
        if (holding) { holding = false; drag?.cell?.setRate(playback.speed); hideFlash(); }
        drag = null; root.classList.remove("is-holding", "is-carousel-dragging");
        if (S.root === root) position(0);
      }
      root.addEventListener("pointercancel", cancelGesture);
      root.addEventListener("focusin", () => { S.lastAct = Date.now(); root.classList.remove("is-idle"); });
      root.addEventListener("contextmenu", (e) => { if (e.target.closest(".cell-stage")) e.preventDefault(); });
      root.addEventListener("dblclick", (e) => e.preventDefault());
      return () => { cancelGesture(); clearTimeout(seekFlashTimer); };
    }
    function bindKeys() {
      const b = (k, fn, desc) => keys.bind("watch", k, fn, { desc });
      b("arrowdown", () => go(1), "Next post"); b("j", () => go(1), "Next post"); b("pagedown", () => go(1), "");
      b("arrowup", () => go(-1), "Previous post"); b("k", () => go(-1), "Previous post"); b("pageup", () => go(-1), "");
      b("space", () => S.cells.get(S.index)?.togglePlay(), "Play / pause");
      b("arrowright", () => { const c = S.cells.get(S.index); if (!c) return; if (c.carousel) c.carousel.next(); else { c.seekBy(5); flash("+5s"); } }, "Next image / seek +5s");
      b("arrowleft", () => { const c = S.cells.get(S.index); if (!c) return; if (c.carousel) c.carousel.prev(); else { c.seekBy(-5); flash("−5s"); } }, "Previous image / seek −5s");
      b("l", () => { S.cells.get(S.index)?.seekBy(10); flash("+10s"); }, "Seek +10s");
      b("q", () => queueSheet(), "Up next list");
      b("h", () => { S.cells.get(S.index)?.seekBy(-10); flash("−10s"); }, "Seek −10s");
      b("s", () => toggleStar(), "Star");
      b("c", () => { const p = current(); if (p) actions.addToCollection(p.id); }, "Add to collection");
      b("o", () => { const p = current(); if (p) actions.openOnX(p); }, "Open on X");
      b("m", () => playback.toggleMuted(), "Mute / unmute");
      b("i", () => toggleInfo(), "Caption & details");
      b("x", () => cycleFit(), "Fit / fill");
      b("escape", () => { if (S.infoOpen) closeInfo(); else nav.back("discover"); }, "Back");
      b("home", () => jump(0), ""); b("end", () => jump(S.ids.length - 1), "");
      b("shift+.", () => { const r = Math.min(3, playback.speed + 0.25); playback.setSpeed(r); flash(r + "×"); }, "Faster");
      b("shift+,", () => { const r = Math.max(0.25, playback.speed - 0.25); playback.setSpeed(r); flash(r + "×"); }, "Slower");
      keys.push("watch");
    }

    return {
      id: "watch", title: "Watch", icon: "play", route: "/watch", nav: true, order: 30, key: "w", layout: "immersive",
      mount, unmount, update,
      pageTitle: () => "Watch",
      commands: () => [
        { id: "watch.resume", title: "Watch: resume last feed", icon: "play", run: () => nav.go("watch") },
        { id: "watch.unseen", title: "Watch: unseen shorts", icon: "zap", run: () => { const ids = catalog.query({ kind: "short", state: "unseen", sort: "random", seed: Date.now() % 9999 }).items.map((p) => p.id); if (ids.length) actions.watch(ids, 0, { label: "Unseen shorts" }); } },
        { id: "watch.continue", title: "Watch: continue watching", icon: "clock", run: () => { const ids = catalog.query({ state: "progress" }).items.sort((a, b) => activity.progressAt(b) - activity.progressAt(a)).map((p) => p.id); if (ids.length) actions.watch(ids, 0, { label: "Continue watching" }); else actions.toast("Nothing in progress"); } },
      ],
    };
  });
