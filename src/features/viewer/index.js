/* features.viewer — the theatre overlay: modern Reels & Netflix style media player.
   Dynamically adapts to any media aspect ratio (portrait 9:16, landscape 16:9, square 1:1)
   with ZERO unwanted cropping or zooming. Information and actions float gracefully
   without eating valuable screen estate.
   Opened from anywhere through EV.VIEWER_OPEN { ids, index, label }. */
XR.define("features.viewer", ["ui.dom", "ui.icons", "ui.widgets", "ui.postMenu", "ui.tiles", "ui.keys", "app.catalog", "app.activity", "app.actions", "app.playback", "app.prefs", "app.media", "app.ports.platform", "core.events", "core.domain.events", "core.util"],
  function (dom, icons, W, postMenu, tiles, keys, catalog, activity, actions, playback, prefs, media, platform, events, EV, util) {
    "use strict";
    const h = dom.h;
    const S = {
      el: null,
      ids: [],
      index: 0,
      label: "",
      handle: null,
      mediaIndex: 0,
      fit: "contain", // contain | cover
      showInfo: false,
      captionExpanded: false,
      offs: [],
      tiles: [],
      els: {},
      wheelTimer: 0,
    };

    const SPEEDS = [1, 1.25, 1.5, 2];

    function open({ ids, index = 0, label = "" }) {
      if (!ids || !ids.length) return;
      if (S.el) close(false);
      S.ids = ids;
      S.index = util.clamp(index, 0, ids.length - 1);
      S.label = label;
      S.mediaIndex = 0;
      S.fit = prefs.get("viewerFit") || "contain";
      S.showInfo = false;
      S.captionExpanded = false;

      playback.pauseAll();

      S.el = h("div.viewer", { role: "dialog", "aria-modal": "true", "aria-label": "Media viewer", tabindex: "-1" },
        h("div.viewer-backdrop", { onclick: () => close() }),
        h("div.viewer-ambient"),

        /* Top bar (fit lives in the rail / keyboard) */
        h("header.viewer-top",
          h("div.viewer-top-left",
            h("button.viewer-close.btn.btn-icon", { title: "Close (Esc)", onclick: () => close() }, icons.icon("x", 22)),
            h("span.viewer-pos.badge.badge-dark"))),

        /* Vertical feed arrows (desktop ≥900px only — mobile/touch feeds use swipes, see viewer.css) */
        h("div.viewer-vnav",
          h("button.viewer-vnav-btn.viewer-vnav-up.btn.btn-icon", { title: "Previous post (↑)", onclick: () => step(-1) }, icons.icon("chevronUp", 24)),
          h("button.viewer-vnav-btn.viewer-vnav-down.btn.btn-icon", { title: "Next post (↓)", onclick: () => step(1) }, icons.icon("chevronDown", 24))),

        /* Central Theatre Stage */
        h("div.viewer-stage",
          h("div.viewer-frame",
            h("div.viewer-fill", { "aria-hidden": "true" }),
            h("div.viewer-media-box"),
            h("div.viewer-overlay",
              h("div.viewer-gradient"),
              h("div.viewer-controls")),
            h("div.viewer-strip"),
            h("div.viewer-info-card")),
          h("aside.viewer-rail")));

      document.body.appendChild(S.el);
      document.documentElement.classList.add("has-viewer");
      requestAnimationFrame(() => S.el && S.el.classList.add("in"));

      bindKeys();
      bindGestures();

      S.offs = [
        events.bus.on(EV.ACTIVITY_CHANGED, () => { refreshRail(); for (const t of S.tiles) t.update(); }),
        events.bus.on(EV.ROUTE_CHANGED, () => close(false)),
        events.bus.on(EV.PLAYBACK_CHANGED, () => syncPlaybackState()),
      ];
      render();
    }

    function close(animate = true) {
      if (!S.el) return;
      for (const off of S.offs) off();
      S.offs = [];
      keys.pop("viewer");
      keys.unbindScope("viewer");
      teardownStage();
      const el = S.el;
      S.el = null;
      document.documentElement.classList.remove("has-viewer");
      if (animate) {
        el.classList.remove("in");
        setTimeout(() => el.remove(), 180);
      } else {
        el.remove();
      }
      events.bus.emit(EV.VIEWER_CLOSED, {});
    }

    const current = () => catalog.post(S.ids[S.index]) || null;

    function step(d) {
      const n = S.index + d;
      if (n < 0 || n >= S.ids.length) return;
      S.index = n;
      S.mediaIndex = 0;
      S.captionExpanded = false;
      render();
    }

    function stepMedia(d) {
      const p = current();
      if (!p || p.media.length <= 1) return;
      S.mediaIndex = (S.mediaIndex + d + p.media.length) % p.media.length;
      render();
    }

    function toggleFit() {
      const m = current()?.media[S.mediaIndex];
      const aspect = Number(m?.aspect) || (m?.width && m?.height ? m.width / m.height : 1);
      if (platform.isMobileView() && m?.kind !== "photo" && aspect > 1.05 && S.handle?.video) {
        void platform.landscapeFullscreen(S.el, S.handle.video);
      }
      S.fit = S.fit === "contain" ? "cover" : "contain";
      if (S.el) {
        const frame = S.el.querySelector(".viewer-frame");
        if (frame) frame.dataset.fit = S.fit;
      }
    }

    function toggleInfo() {
      S.showInfo = !S.showInfo;
      if (S.el) {
        const card = S.el.querySelector(".viewer-info-card");
        const btn = S.el.querySelector(".viewer-rail-info");
        if (card) card.classList.toggle("on", S.showInfo);
        if (btn) btn.classList.toggle("on", S.showInfo);
      }
    }

    function teardownStage() {
      if (S.handle) {
        try { S.handle.destroy(); } catch { /* ignore */ }
        S.handle = null;
      }
      for (const t of S.tiles) t.destroy();
      S.tiles = [];
    }

    function render() {
      const post = current();
      if (!post) return close();
      teardownStage();

      const frame = S.el.querySelector(".viewer-frame");
      const mediaBox = S.el.querySelector(".viewer-media-box");
      const ambient = S.el.querySelector(".viewer-ambient");
      const controlsBox = S.el.querySelector(".viewer-controls");
      const stripBox = S.el.querySelector(".viewer-strip");
      const infoCard = S.el.querySelector(".viewer-info-card");
      const rail = S.el.querySelector(".viewer-rail");
      const posBadge = S.el.querySelector(".viewer-pos");

      dom.clear(mediaBox);
      dom.clear(controlsBox);
      dom.clear(stripBox);
      dom.clear(infoCard);
      dom.clear(rail);

      /* Update top counters & nav buttons */
      posBadge.replaceChildren(
        `${S.index + 1} / ${S.ids.length}`,
        S.label ? h("span.viewer-pos-label", " · " + S.label) : "");
      S.el.querySelector(".viewer-vnav-up").disabled = S.index === 0;
      S.el.querySelector(".viewer-vnav-down").disabled = S.index >= S.ids.length - 1;

      const m = post.media[S.mediaIndex] || post.media[0];

      /* Dynamic Aspect Ratio Calculation: adapts to every media size */
      let aspect = 1;
      if (m) {
        if (m.width && m.height && m.height > 0) {
          aspect = m.width / m.height;
        } else if (m.aspect && m.aspect > 0) {
          aspect = m.aspect;
        } else {
          aspect = m.kind === "photo" ? 1 : 0.5625;
        }
      }

      const isPortrait = aspect < 0.85;
      const isLandscape = aspect > 1.15;
      const aspectCategory = isPortrait ? "portrait" : (isLandscape ? "landscape" : "square");

      frame.dataset.aspect = aspectCategory;
      frame.dataset.fit = S.fit;
      frame.dataset.kind = m ? m.kind : "text";
      frame.style.setProperty("--ar", aspect.toFixed(4));

      /* Letterbox areas get a scaled, dimmed copy of the same frame so the
         stage never reads as a black hole around contain-fitted media. */
      let fill = frame.querySelector(".viewer-fill");
      if (!fill) { fill = h("div.viewer-fill", { "aria-hidden": "true" }); frame.insertBefore(fill, frame.firstChild); }
      fill.style.backgroundImage = m ? `url("${media.poster(m, 600)}")` : "none";

      /* Subtle ambient glow behind the player (not in foreground) */
      if (m) {
        ambient.style.backgroundImage = `url("${media.poster(m, 300)}")`;
        ambient.style.display = "block";
      } else {
        ambient.style.display = "none";
      }

      /* Render Media */
      if (m) {
        if (m.kind === "photo") {
          const img = h("img.viewer-img", {
            src: media.full(m),
            alt: m.alt || "",
            draggable: false,
            onclick: () => toggleFit(),
          });
          img.addEventListener("error", () => {
            if (!img.dataset.fb) {
              img.dataset.fb = "1";
              img.src = media.poster(m, 1200);
            }
          });
          mediaBox.appendChild(img);
        } else {
          /* Video / GIF */
          const video = h("video.viewer-video", {
            playsInline: true,
            disablePictureInPicture: true,
            preload: "auto",
            poster: media.poster(m, 1200),
          });
          video.setAttribute("playsinline", "");

          const glyph = h("div.viewer-playglyph", icons.icon("play", 48, { filled: true }));
          mediaBox.appendChild(video);
          mediaBox.appendChild(glyph);

          const triggerGlyph = (play) => {
            glyph.innerHTML = "";
            glyph.appendChild(icons.icon(play ? "play" : "pause", 48, { filled: true }));
            glyph.classList.remove("pop");
            void glyph.offsetWidth; // re-flow
            glyph.classList.add("pop");
          };

          video.addEventListener("click", () => {
            if (!S.handle) return;
            const willPlay = video.paused;
            triggerGlyph(willPlay);
            S.handle.toggle();
          });

          S.handle = playback.wire(video, m, {
            post,
            preload: "auto",
            loop: m.kind === "gif" || (prefs.get("loopShorts") && m.duration > 0 && m.duration <= 60),
            onEnded: () => {
              if (prefs.get("autoAdvance") && S.index < S.ids.length - 1 && post.media.length === 1) {
                step(1);
              }
            },
            onProgress: (cur, dur) => updateControlsProgress(cur, dur),
          });

          video.addEventListener("xr:unplayable", () => {
            frame.classList.add("is-unplayable");
            mediaBox.appendChild(
              h("div.viewer-unplayable",
                icons.icon("alert", 26),
                h("span", "Video cannot play in browser. "),
                h("a.link", { href: post.url, target: "_blank", rel: "noopener" }, "Open on X"))
            );
          });

          if (prefs.get("autoplay")) {
            S.handle.activate();
          } else {
            S.handle.attach();
          }

          /* Video Scrubber & Playback Controls */
          renderControls(controlsBox, video, m);
        }

        /* Carousel arrows for multi-media posts */
        if (post.media.length > 1) {
          mediaBox.appendChild(
            h("button.viewer-frame-arrow.viewer-frame-prev", {
              title: "Previous media",
              onclick: (e) => { e.stopPropagation(); stepMedia(-1); },
            }, icons.icon("chevronLeft", 22))
          );
          mediaBox.appendChild(
            h("button.viewer-frame-arrow.viewer-frame-next", {
              title: "Next media",
              onclick: (e) => { e.stopPropagation(); stepMedia(1); },
            }, icons.icon("chevronRight", 22))
          );
        }
      } else {
        mediaBox.appendChild(h("div.viewer-textonly", h("p", post.text)));
      }

      /* Multi-Media Strip (Carousel Thumbnails) */
      if (post.media.length > 1) {
        stripBox.style.display = "flex";
        dom.append(stripBox, [
          h("div.viewer-strip-thumbs", post.media.map((mm, i) =>
            h("button.viewer-thumb", {
              class: i === S.mediaIndex ? "on" : "",
              title: `Media ${i + 1}`,
              onclick: (e) => {
                e.stopPropagation();
                S.mediaIndex = i;
                render();
              },
            },
            h("img", { src: media.thumb(mm, 120), alt: "" }),
            mm.kind !== "photo" ? icons.icon("play", 12, { filled: true }) : null))),
          h("span.badge.badge-dark.viewer-strip-badge", `${S.mediaIndex + 1} / ${post.media.length}`),
        ]);
      } else {
        stripBox.style.display = "none";
      }


      /* Info Popover Card (details on demand) */
      renderInfoCard(infoCard, post, m);

      /* Floating Action Rail (Right) */
      renderRail(rail, post, m);

      activity.noteOpen(post);
    }

    function renderControls(host, video, m) {
      const playBtn = h("button.btn.btn-icon.viewer-ctrl-play", {
        title: "Play / Pause (Space)",
        onclick: (e) => { e.stopPropagation(); if (S.handle) S.handle.toggle(); },
      }, icons.icon("play", 18, { filled: true }));

      const seek = h("input.viewer-seek", { type: "range", min: 0, max: 100, step: 0.1, value: 0, disabled: true, "aria-label": "Seek video" });
      const scrub = h("div.viewer-scrub", h("div.viewer-scrub-buffer"), h("div.viewer-scrub-fill"), seek);

      const timeLabel = h("span.viewer-time", "0:00 / 0:00");

      const speedBtn = h("button.btn.btn-icon.viewer-ctrl-speed.speed-chip", {
        title: "Playback speed",
        onclick: (e) => {
          e.stopPropagation();
          cycleSpeed();
        },
      }, h("span.speed-chip-text", `${playback.speed}x`));

      const muteBtn = h("button.btn.btn-icon.viewer-ctrl-mute", {
        title: "Mute / Unmute (m)",
        onclick: (e) => { e.stopPropagation(); playback.toggleMuted(); },
      }, icons.icon(playback.muted ? "mute" : "volume", 18));

      /* Native range input handles mouse/touch/keyboard without global listeners
         that could outlive this stage when the post changes mid-drag. */
      seek.addEventListener("input", () => {
        const dur = video.duration || m.duration || 0;
        if (Number.isFinite(dur) && dur > 0) {
          try { video.currentTime = Number(seek.value) / 100 * dur; } catch { /* not yet seekable */ }
          updateControlsProgress(video.currentTime, dur);
        }
      });
      seek.addEventListener("keydown", (e) => {
        if (e.key === "Escape") return;
        e.stopPropagation();
        const delta = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[e.key];
        const dur = video.duration || m.duration || 0;
        if (!Number.isFinite(dur) || dur <= 0 || (delta === undefined && e.key !== "Home" && e.key !== "End")) return;
        e.preventDefault();
        try { video.currentTime = e.key === "Home" ? 0 : e.key === "End" ? dur : util.clamp(video.currentTime + delta, 0, dur); } catch { /* not yet seekable */ }
        updateControlsProgress(video.currentTime, dur);
      });
      const metadata = () => updateControlsProgress(video.currentTime, video.duration || m.duration);
      video.addEventListener("loadedmetadata", metadata);
      video.addEventListener("durationchange", metadata);
      video.addEventListener("progress", () => {
        if (video.buffered.length && Number.isFinite(video.duration) && video.duration > 0) {
          const buffer = scrub.querySelector(".viewer-scrub-buffer");
          buffer.style.width = video.buffered.end(video.buffered.length - 1) / video.duration * 100 + "%";
        }
      });

      video.addEventListener("play", () => {
        playBtn.innerHTML = "";
        playBtn.appendChild(icons.icon("pause", 18, { filled: true }));
      });
      video.addEventListener("pause", () => {
        playBtn.innerHTML = "";
        playBtn.appendChild(icons.icon("play", 18, { filled: true }));
      });

      dom.append(host, [playBtn, scrub, timeLabel, speedBtn, muteBtn]);
      playBtn.setAttribute("aria-label", video.paused ? "Play video" : "Pause video");
      video.addEventListener("play", () => playBtn.setAttribute("aria-label", "Pause video"));
      video.addEventListener("pause", () => playBtn.setAttribute("aria-label", "Play video"));
      metadata();
    }

    function updateControlsProgress(cur, dur) {
      if (!S.el) return;
      const fill = S.el.querySelector(".viewer-scrub-fill");
      const time = S.el.querySelector(".viewer-time");
      const seek = S.el.querySelector(".viewer-seek");
      if (seek) {
        seek.disabled = !(Number.isFinite(dur) && dur > 0);
        if (!seek.disabled) {
          seek.value = String(util.clamp(cur / dur * 100, 0, 100));
          seek.setAttribute("aria-valuetext", dom.duration(cur) + " of " + dom.duration(dur));
        }
      }
      if (fill && Number.isFinite(dur) && dur > 0) {
        const pct = util.clamp((cur / dur) * 100, 0, 100);
        fill.style.width = pct + "%";
      }
      if (time && dur > 0) {
        time.textContent = `${dom.duration(cur)} / ${dom.duration(dur)}`;
      }
    }

    function cycleSpeed() {
      const cur = playback.speed;
      const idx = SPEEDS.indexOf(cur);
      const next = SPEEDS[(idx + 1) % SPEEDS.length];
      playback.setSpeed(next);
      if (S.el) {
        const chip = S.el.querySelector(".viewer-ctrl-speed .speed-chip-text");
        if (chip) chip.textContent = `${next}x`;
      }
    }

    function syncPlaybackState() {
      if (!S.el) return;
      const muteBtn = S.el.querySelector(".viewer-ctrl-mute");
      const iconName = playback.muted ? "mute" : "volume";
      if (muteBtn) {
        muteBtn.innerHTML = "";
        muteBtn.appendChild(icons.icon(iconName, 18));
      }
      const chip = S.el.querySelector(".viewer-ctrl-speed .speed-chip-text");
      if (chip) chip.textContent = `${playback.speed}x`;
    }

    /* Floating Rail (TikTok / Reels Style Actions) */
    function renderRail(host, post, m) {
      if (!host) return;
      const starred = activity.isStarred(post.id);

      const creatorBtn = h("button.viewer-rail-btn.viewer-rail-creator", {
        title: "View profile",
        onclick: (e) => {
          e.stopPropagation();
          close();
          actions.goCreator(post.author.username);
        },
      },
        W.avatar(media.avatar(post, 46), post.author.name, 46),
        h("span.viewer-rail-label", "@" + post.author.username));

      const starBtn = h("button.viewer-rail-btn.viewer-rail-star", {
        class: starred ? "is-active" : "",
        title: "Star (s)",
        onclick: (e) => {
          e.stopPropagation();
          const on = actions.star(post);
          starBtn.classList.toggle("is-active", on);
        },
      }, icons.icon("star", 24, { filled: starred }), h("span.viewer-rail-label", "Star"));

      const watchBtn = h("button.viewer-rail-btn.viewer-rail-watch", {
        title: "Watch in feed (w)",
        onclick: (e) => {
          e.stopPropagation();
          close(false);
          actions.watch(S.ids, S.index, { label: S.label });
        },
      }, icons.icon("play", 24, { filled: true }), h("span.viewer-rail-label", "Watch"));

      const fitBtn = h("button.viewer-rail-btn.viewer-rail-fit", {
        title: "Fit mode (x)",
        onclick: (e) => {
          e.stopPropagation();
          toggleFit();
        },
      }, icons.icon("fit", 22), h("span.viewer-rail-label", "Fit"));

      const infoBtn = h("button.viewer-rail-btn.viewer-rail-info", {
        class: S.showInfo ? "on" : "",
        title: "Caption & details (i)",
        onclick: (e) => {
          e.stopPropagation();
          toggleInfo();
        },
      }, icons.icon("info", 22), h("span.viewer-rail-label", "Info"));

      const moreBtn = h("button.viewer-rail-btn.viewer-rail-more", {
        title: "More",
        onclick: (e) => {
          e.stopPropagation();
          postMenu.open(post, e.currentTarget, {
            ids: S.ids,
            index: S.index,
            label: S.label,
            noOpen: true,
            mediaIndex: S.mediaIndex,
          });
        },
      }, icons.icon("more", 22), h("span.viewer-rail-label", "More"));

      dom.append(host, [creatorBtn, starBtn, watchBtn, fitBtn, infoBtn, moreBtn]);
    }

    function refreshRail() {
      if (!S.el) return;
      const post = current();
      if (!post) return;
      const starBtn = S.el.querySelector(".viewer-rail-star");
      if (starBtn) {
        const on = activity.isStarred(post.id);
        starBtn.classList.toggle("is-active", on);
        starBtn.innerHTML = "";
        starBtn.appendChild(icons.icon("star", 24, { filled: on }));
        starBtn.appendChild(h("span.viewer-rail-label", "Star"));
      }
    }

    /* Info Popover Card — caption + details, displayed only on demand */
    function renderInfoCard(host, post, m) {
      if (!host) return;
      host.classList.toggle("on", S.showInfo);

      const colls = activity.collectionsOf(post.id);

      const caption = post.text ? (() => {
        const textWrap = h("div.viewer-caption", { class: S.captionExpanded ? "expanded" : "clamp" });
        textWrap.appendChild(dom.richText(post.rawText || post.text, {
          onTag: (t) => { close(); actions.goTag(t); },
          onUser: (u) => { close(); actions.goCreator(u); },
        }));
        if (post.text.length > 120 && !S.captionExpanded) {
          const moreBtn = h("button.viewer-caption-more", {
            onclick: (e) => {
              e.stopPropagation();
              S.captionExpanded = true;
              textWrap.classList.remove("clamp");
              textWrap.classList.add("expanded");
              moreBtn.remove();
            },
          }, " more");
          textWrap.appendChild(moreBtn);
        }
        return textWrap;
      })() : null;

      const quote = post.quoted ? h("blockquote.viewer-quote",
        h("b", post.quoted.author_name || "@" + post.quoted.author_username),
        h("span.muted", " @" + post.quoted.author_username),
        h("p", post.quoted.text || ""),
        post.quoted.url ? h("a.link.small", { href: post.quoted.url, target: "_blank", rel: "noopener" }, "quoted post") : null) : null;

      const tags = post.hashtags && post.hashtags.length ? h("div.viewer-tags", post.hashtags.slice(0, 5).map((t) =>
        W.chip({
          label: "#" + t,
          onClick: (e) => { e.stopPropagation(); close(); actions.goTag(t); },
        }))) : null;

      dom.append(host, [
        h("div.viewer-info-head",
          h("b", "Caption & details"),
          h("button.btn.btn-icon.viewer-info-close", {
            title: "Close info",
            onclick: () => toggleInfo(),
          }, icons.icon("x", 16))),

        caption,
        quote,
        tags,

        h("div.viewer-info-metrics",
          h("span", icons.icon("heart", 14), dom.compact(post.metrics.likes)),
          h("span", icons.icon("repeat", 14), dom.compact(post.metrics.reposts)),
          h("span", icons.icon("reply", 14), dom.compact(post.metrics.replies)),
          post.metrics.views ? h("span", icons.icon("eye", 14), dom.compact(post.metrics.views)) : null),

        h("dl.viewer-info-facts",
          h("div", h("dt", "Posted"), h("dd", dom.dateTime(post.createdAt))),
          h("div", h("dt", "Saved"), h("dd", dom.dateTime(post.savedAt))),
          m && m.kind !== "photo" ? h("div", h("dt", "Length"), h("dd", dom.duration(m.duration))) : null,
          m && m.width ? h("div", h("dt", "Size"), h("dd", `${m.width}×${m.height}`)) : null,
          post.flags.repostedBy ? h("div", h("dt", "Reposted by"), h("dd", "@" + post.flags.repostedBy)) : null,
          colls.length ? h("div", h("dt", "Collections"), h("dd", colls.map((c) => c.name).join(", "))) : null),
      ]);
    }

    /* Vertical feed gestures — the frame follows the finger (rubber-band),
       release springs back, or sweeps to the next / previous post. Touch only. */
    function bindGestures() {
      if (!S.el) return;
      const el = S.el;
      const clearInline = (f) => { f.style.transition = ""; f.style.transform = ""; f.style.opacity = ""; };
      const frame = el.querySelector(".viewer-frame");
      let startX = 0, startY = 0, startT = 0, active = false, axis = null;

      el.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) { active = false; return; }
        /* native scrolling stays native */
        if (e.target.closest(".viewer-info-card.on, .viewer-caption.expanded, .viewer-scrub")) { active = false; return; }
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startT = Date.now();
        active = true;
        axis = null;
      }, { passive: true });

      el.addEventListener("touchmove", (e) => {
        if (!active || e.touches.length !== 1) return;
        const x = e.touches[0].clientX, y = e.touches[0].clientY;
        const dx = x - startX, dy0 = y - startY;
        if (!axis) {
          if (Math.abs(dx) < 10 && Math.abs(dy0) < 10) return;
          /* vertical intent only — horizontal swipes stay free for the page/album */
          axis = Math.abs(dy0) > Math.abs(dx) * 1.2 ? "y" : null;
          if (!axis) { active = false; return; }
        }
        let dy = dy0;
        /* elastic resistance beyond the ends of the list */
        if ((dy > 0 && S.index === 0) || (dy < 0 && S.index >= S.ids.length - 1)) dy *= 0.25;
        frame.style.transition = "none";
        frame.style.transform = `translate3d(0, ${(dy * 0.75).toFixed(1)}px, 0) scale(${(1 - Math.min(0.04, Math.abs(dy) / 4000)).toFixed(3)})`;
        frame.style.opacity = (1 - Math.min(0.45, Math.abs(dy) / 1100)).toFixed(2);
      }, { passive: true });

      const springBack = () => {
        frame.style.transition = "transform 260ms cubic-bezier(.2,.8,.2,1), opacity 220ms ease";
        frame.style.transform = "";
        frame.style.opacity = "";
        setTimeout(() => clearInline(frame), 300);
      };

      el.addEventListener("touchend", (e) => {
        if (!active) return;
        active = false;
        if (!axis) return;
        axis = null;
        const dy = e.changedTouches[0].clientY - startY;
        const speed = Math.abs(dy) / Math.max(1, Date.now() - startT);
        const going = Math.abs(dy) > 80 || speed > 0.55;
        const dir = dy < 0 ? 1 : -1; /* swipe up = next, swipe down = previous */
        const atEdge = (dir > 0 && S.index >= S.ids.length - 1) || (dir < 0 && S.index === 0);
        /* At the very first post there is nothing above: a downward pull closes
           the viewer, the way a full-screen surface is expected to behave. */
        if (dy > 0 && S.index === 0 && going) {
          frame.style.transition = "transform 220ms cubic-bezier(.2,.8,.2,1), opacity 180ms ease";
          frame.style.transform = `translate3d(0, ${Math.max(120, dy)}px, 0) scale(0.96)`;
          frame.style.opacity = "0";
          setTimeout(() => { if (S.el) close(); }, 190);
          return;
        }
        if (!going || atEdge) {
          springBack();
          return;
        }
        /* sweep out → render next → sweep in from the opposite side */
        frame.style.transition = "transform 180ms cubic-bezier(.3,.1,.7,.4), opacity 160ms ease";
        frame.style.transform = `translate3d(0, ${(dy > 0 ? 24 : -24)}%, 0) scale(0.94)`;
        frame.style.opacity = "0";
        setTimeout(() => {
          step(dir);
          if (!S.el) return;
          const next = S.el.querySelector(".viewer-frame");
          next.style.transition = "none";
          next.style.transform = `translate3d(0, ${(dy > 0 ? -16 : 16)}%, 0) scale(0.97)`;
          next.style.opacity = "0.3";
          requestAnimationFrame(() => {
            next.style.transition = "transform 240ms cubic-bezier(.2,.8,.2,1), opacity 220ms ease";
            next.style.transform = "";
            next.style.opacity = "";
            setTimeout(() => clearInline(next), 260);
          });
        }, 180);
      }, { passive: true });

      /* A system gesture (notification shade, call, navigation) cancels the touch
         stream. Settle the frame instead of leaving it mid-transform. */
      el.addEventListener("touchcancel", () => {
        if (!active) return;
        active = false;
        axis = null;
        springBack();
      }, { passive: true });

      /* Mouse wheel on desktop — vertical only, one post per notch */
      el.addEventListener("wheel", (e) => {
        if (e.target.closest(".viewer-info-card, .viewer-caption.expanded, .viewer-strip")) return;
        const now = Date.now();
        if (now - S.wheelTimer < 320) return;
        if (Math.abs(e.deltaY) > 35) {
          S.wheelTimer = now;
          step(e.deltaY > 0 ? 1 : -1);
        }
      }, { passive: true });
    }

    function bindKeys() {
      const b = (k, fn, desc) => keys.bind("viewer", k, fn, { desc });
      b("escape", () => {
        if (S.showInfo) toggleInfo();
        else close();
      }, "Close viewer");
      b("arrowright", () => stepMedia(1), "Next media in album");
      b("arrowleft", () => stepMedia(-1), "Previous media in album");
      b("j", () => step(1), "");
      b("k", () => step(-1), "");
      b("arrowdown", () => step(1), "");
      b("arrowup", () => step(-1), "");
      b("s", () => { const p = current(); if (p) actions.star(p); }, "Star");
      b("c", () => { const p = current(); if (p) actions.addToCollection(p.id); }, "Add to collection");
      b("o", () => { const p = current(); if (p) actions.openOnX(p); }, "Open on X");
      b("w", () => { close(false); actions.watch(S.ids, S.index, { label: S.label }); }, "Watch from here");
      b("space", () => { if (S.handle) S.handle.toggle(); }, "Play / pause");
      b("m", () => playback.toggleMuted(), "Mute / unmute");
      b("x", () => toggleFit(), "Toggle fit mode");
      b("i", () => toggleInfo(), "Toggle details");
      b("tab", (e) => {
        if (current()?.media.length > 1) {
          if (e) e.preventDefault();
          stepMedia(1);
        }
      }, "Next image in post");
      keys.push("viewer");
    }

    return {
      id: "viewer",
      title: "Viewer",
      icon: "maximize",
      route: null,
      nav: false,
      order: 900,
      init() { events.bus.on(EV.VIEWER_OPEN, open); },
      open,
      close,
      commands: () => [],
    };
  });
