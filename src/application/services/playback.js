/* app.playback — one place that knows how <video> elements should behave:
   source attachment through the PlayerEngine port, global mute/speed,
   resume positions, progress persistence, "seen" bookkeeping, and the rule
   that only one video plays at a time. Features own the DOM; this owns the policy. */
XR.define("app.playback", ["app.ports.playerEngine", "app.ports.mediaResolver", "app.activity", "app.prefs", "core.events", "core.domain.events", "core.util"],
  function (engine, resolver, activity, prefs, events, EV, util) {
    "use strict";
    const state = { muted: prefs.get("startMuted"), speed: prefs.get("speed") || 1, active: null /* handle */, userUnmuted: false };
    const handles = new Set();
    const MIN_PROGRESS_SECONDS = 45;

    const emit = () => events.bus.emit(EV.PLAYBACK_CHANGED, { muted: state.muted, speed: state.speed, active: state.active?.media.id || null });
    prefs.onChange(({ patch }) => { if ("speed" in patch) setSpeed(patch.speed); });

    function setMuted(on) { state.muted = !!on; if (!on) state.userUnmuted = true; for (const h of handles) { h.video.muted = state.muted; h.syncAudioTrack?.(); } emit(); }
    const toggleMuted = () => setMuted(!state.muted);
    function setSpeed(s) { state.speed = util.clamp(Number(s) || 1, 0.25, 3); for (const h of handles) { h.video.playbackRate = state.speed; h.syncAudioTrack?.(); } emit(); }

    /**
     * Prepare a <video> for a media item. Returns a handle:
     *   { video, media, play(), pause(), toggle(), seek(sec), seekBy(sec), activate(), deactivate(), destroy(), get isActive() }
     * @param {HTMLVideoElement} video
     * @param {Media} media
     * @param {{post?: Post, loop?: boolean, onEnded?: Function, onProgress?: Function, resume?: boolean}} opts
     */
    function wire(video, media, opts = {}) {
      video.muted = state.muted;
      video.playbackRate = state.speed;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.preload = opts.preload || "metadata";
      video.loop = opts.loop ?? (prefs.get("loopShorts") && media.duration > 0 && media.duration <= 60);
      if (media.poster) video.poster = resolver.poster(media, opts.posterSize || "medium");

      let attached = false, destroyed = false, lastSave = 0, seenTimer = 0, playPromise = null, engineAttachment = null;
      const h = {
        video, media, post: opts.post || null,
        get isActive() { return state.active === h; },
        attach() {
          if (destroyed) return null;
          if (attached) return engineAttachment;
          attached = true;
          engineAttachment = engine.attach(video, media, { localDir: prefs.get("localMediaDir") });
          if (opts.resume !== false && prefs.get("rememberProgress")) {
            const e = activity.progressEntry(media.id);
            if (e && e.t > 3) {
              const apply = () => { try { video.currentTime = e.t; } catch { /* not seekable yet */ } };
              if (video.readyState >= 1) apply(); else video.addEventListener("loadedmetadata", apply, { once: true });
            }
          }
          return engineAttachment;
        },
        play() {
          if (destroyed) return Promise.resolve();
          const attachment = h.attach();
          const attemptPlay = () => {
            if (destroyed) return Promise.resolve();
            return video.play().catch((err) => {
              if (err && err.name === "NotAllowedError" && !video.muted) { // autoplay with sound blocked → retry muted
                state.muted = true; video.muted = true; emit();
                return video.play().catch(() => {});
              }
            });
          };
          const ready = attachment && attachment.ready;
          playPromise = ready && typeof ready.then === "function"
            ? ready.then((canPlay) => canPlay === false ? undefined : attemptPlay())
            : attemptPlay();
          return playPromise;
        },
        pause() { if (!destroyed) { const p = playPromise; if (p) p.then(() => video.pause(), () => {}); else video.pause(); } },
        toggle() { return video.paused ? h.play() : h.pause(); },
        seek(sec) { try { video.currentTime = util.clamp(sec, 0, video.duration || media.duration || sec); } catch { /* ignore */ } },
        seekBy(delta) { h.seek((video.currentTime || 0) + delta); },
        activate() {
          if (state.active && state.active !== h) state.active.deactivate();
          state.active = h;
          clearTimeout(seenTimer);
          if (h.post) seenTimer = setTimeout(() => activity.noteOpen(h.post), 1500);
          emit();
          return h.play();
        },
        deactivate() {
          clearTimeout(seenTimer);
          if (state.active === h) { state.active = null; emit(); }
          h.pause();
          saveNow(true);
        },
        destroy() {
          if (destroyed) return;
          destroyed = true;
          h.deactivate();
          handles.delete(h);
          video.removeEventListener("timeupdate", onTime);
          video.removeEventListener("ended", onEnded);
          engine.detach(video);
        },
      };
      function saveNow(force) {
        if (!prefs.get("rememberProgress")) return;
        const d = video.duration || media.duration;
        if (!(d >= MIN_PROGRESS_SECONDS)) return;
        const now = Date.now();
        if (!force && now - lastSave < 4000) return;
        lastSave = now;
        activity.saveProgress(media.id, video.currentTime, d);
      }
      function onTime() { saveNow(false); if (opts.onProgress) opts.onProgress(video.currentTime, video.duration || media.duration); }
      function onEnded() { activity.clearProgress(media.id); if (opts.onEnded) opts.onEnded(h); }

      /* ---- Reddit CMAF: the playable files are silent; a separate <audio> carries the
         sound. The element is created here and appended to <body> (muted with the video)
         — it is a track, not a node the features must know about.
         Candidates: the file the extension downloaded (local media folder), then the remote
         audio URL. When every candidate fails the video keeps playing muted, and the feature
         learns why through "xr:audio-unavailable" on the video element. */
      const audioCandidates = media.kind === "video" && resolver.audio ? resolver.audio(media, { localDir: prefs.get("localMediaDir") }) : [];
      let audioEl = null, audioIdx = 0;
      const killAudio = (notify) => {
        if (!audioEl) return;
        const dead = audioEl; audioEl = null;
        try { dead.pause(); dead.removeAttribute("src"); dead.load(); dead.remove(); } catch { /* ignore */ }
        if (notify) video.dispatchEvent(new CustomEvent("xr:audio-unavailable", { detail: { media: media.id, url: audioCandidates[Math.min(audioIdx, audioCandidates.length - 1)]?.url || "" } }));
      };
      function onAudioError() {
        if (!audioEl) return;
        audioIdx++;
        if (audioIdx >= audioCandidates.length) return killAudio(true);
        audioEl.src = audioCandidates[audioIdx].url;
        runAudio();
      }
      function runAudio() {
        if (!audioEl || video.paused) return;
        /* When the ladder fell all the way back to the (master) HLS stream, that stream
           carries its own sound — the side track must not double it. */
        const nowOnHls = engine.currentSource?.(video)?.type === "hls" || /\.m3u8(\?|$)/i.test(video.currentSrc || "");
        if (nowOnHls) return killAudio(false);
        audioEl.muted = state.muted;
        audioEl.playbackRate = state.speed;
        try { audioEl.currentTime = video.currentTime; } catch { /* not seekable yet */ }
        audioEl.play().catch(() => { /* blocked: the video handle's muted retry covers it */ });
      }
      const onAudioSeeked = () => { if (audioEl) { try { audioEl.currentTime = video.currentTime; } catch { /* ignore */ } } };
      const onAudioDrift = () => {
        if (!audioEl || video.paused || audioEl.muted) return;
        if (Math.abs((audioEl.currentTime || 0) - video.currentTime) > 0.35) onAudioSeeked();
      };
      const onAudioPause = () => audioEl?.pause();
      if (audioCandidates.length && typeof document !== "undefined") {
        audioEl = document.createElement("audio");
        audioEl.preload = "auto";
        audioEl.muted = state.muted;
        audioEl.playbackRate = state.speed;
        audioEl.loop = video.loop;
        audioEl.addEventListener("error", onAudioError);
        video.addEventListener("play", runAudio);
        video.addEventListener("pause", onAudioPause);
        video.addEventListener("ended", onAudioPause);
        video.addEventListener("seeked", onAudioSeeked);
        video.addEventListener("timeupdate", onAudioDrift);
        audioEl.src = audioCandidates[0].url;
        document.body.appendChild(audioEl); /* a detached element would play, but an attached one is visible to devtools and dies with the page */
      }
      /* The handle grows audio awareness without the features knowing. */
      h.syncAudioTrack = () => { if (audioEl) { audioEl.muted = state.muted; audioEl.playbackRate = state.speed; } };
      const plainDestroy = h.destroy;
      h.destroy = () => {
        video.removeEventListener("play", runAudio);
        video.removeEventListener("pause", onAudioPause);
        video.removeEventListener("ended", onAudioPause);
        video.removeEventListener("seeked", onAudioSeeked);
        video.removeEventListener("timeupdate", onAudioDrift);
        killAudio(false);
        plainDestroy();
      };

      video.addEventListener("timeupdate", onTime);
      video.addEventListener("ended", onEnded);
      handles.add(h);
      return h;
    }

    /** Pause everything (route change, lock, tab hidden). */
    function pauseAll() { for (const h of handles) h.pause(); if (state.active) { state.active = null; emit(); } }
    function resumeActive() { if (state.active) state.active.play(); }

    return { wire, pauseAll, resumeActive, setMuted, toggleMuted, setSpeed, get muted() { return state.muted; }, get speed() { return state.speed; }, get active() { return state.active; }, MIN_PROGRESS_SECONDS };
  });
