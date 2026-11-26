/* ui.mediaFeedback — observed loading state, not a connectivity or download promise.
   A browser offline hint matters only when media is waiting/failed. Never infer
   deletion, host refusal, or offline availability from a media error. */
XR.define("ui.mediaFeedback", ["ui.dom", "ui.widgets"], function (dom, W) {
  "use strict";
  const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

  function observe(target, { image = false, fallback = "", onChange = () => {} } = {}) {
    let active = false, destroyed = false, requested = false, failed = false;
    let pending = image && !(target.complete && target.naturalWidth > 0);
    let played = !image && target.currentTime > 0, revealed = false, slow = false;
    let offlineSeen = false, triedFallback = false, revealTimer = 0, slowTimer = 0;
    const offs = [];
    let state = { phase: "idle", failed: false };
    const on = (node, event, fn) => { node.addEventListener(event, fn); offs.push(() => node.removeEventListener(event, fn)); };
    function clearTimers() { clearTimeout(revealTimer); clearTimeout(slowTimer); revealTimer = slowTimer = 0; }
    function publish() {
      if (destroyed) return;
      const waiting = pending || failed;
      if (active && waiting && offline()) offlineSeen = true;
      if (active && pending && !failed && !revealTimer && !revealed) {
        revealTimer = setTimeout(() => { revealTimer = 0; revealed = true; publish(); }, 450);
      }
      if (active && pending && !failed && !slowTimer && !slow) {
        slowTimer = setTimeout(() => { slowTimer = 0; slow = true; publish(); }, 8000);
      }
      let phase = "idle";
      if (active && waiting) {
        if (offline()) phase = "offline";
        else if (offlineSeen) phase = "reconnect";
        else if (failed) phase = "error";
        else if (slow) phase = "slow";
        else if (revealed) phase = played ? "buffering" : "loading";
      }
      if (state.phase !== phase || state.failed !== failed) {
        state = { phase, failed }; onChange(state);
      }
    }
    function wait() {
      if (destroyed || (!image && !requested && target.paused)) return;
      pending = true; publish();
    }
    function ready() {
      pending = failed = offlineSeen = revealed = slow = false;
      clearTimers(); publish();
    }
    function fail() {
      failed = true; pending = false; clearTimers(); publish();
    }
    if (image) {
      on(target, "load", ready);
      on(target, "error", () => {
        if (!triedFallback && fallback && fallback !== target.getAttribute("src")) {
          triedFallback = true; pending = true; target.src = fallback; publish();
        } else fail();
      });
    } else {
      on(target, "play", () => { requested = true; if (target.readyState < 3) wait(); });
      on(target, "waiting", wait);
      // A stalled network can still leave plenty of playable buffered data.
      on(target, "stalled", () => { if (!target.paused && target.readyState < 3) wait(); });
      on(target, "playing", () => { played = true; ready(); });
      on(target, "canplay", ready);
      on(target, "pause", () => { requested = false; pending = false; clearTimers(); revealed = slow = false; publish(); });
      on(target, "ended", ready);
      // The engine owns source fallback; native `error` alone is not exhaustion.
      on(target, "xr:unplayable", fail);
    }
    if (typeof window !== "undefined") {
      on(window, "online", publish); on(window, "offline", publish);
    }
    return {
      get state() { return state; },
      begin() { requested = true; if (image ? !(target.complete && target.naturalWidth > 0) : target.readyState < 3) wait(); },
      setActive(value) {
        active = !!value;
        if (!active) { clearTimers(); revealed = slow = false; }
        publish();
      },
      destroy() { destroyed = true; clearTimers(); for (const off of offs) off(); },
    };
  }

  function create(target, options = {}) {
    const { image = false, retry, next, open, openLabel = "Open original", hide, onChange, failureClass = "", actionsClass = "" } = options;
    const noun = image ? "image" : "video";
    const title = dom.h("b.media-feedback-title");
    const note = dom.h("p.media-feedback-note");
    const message = dom.h("div.media-feedback-message", { role: "status", "aria-live": "polite", "aria-atomic": "true" }, title, note);
    const spinner = W.spinner(); spinner.setAttribute("aria-hidden", "true");
    function button(label, run, kind = "") {
      if (!run) return null;
      const btn = W.btn(label, { kind, onClick: (e) => { e.stopPropagation(); run(); } });
      return btn;
    }
    const nextBtn = button("Next", next, "primary");
    const retryBtn = button("Retry", retry);
    const openBtn = button(openLabel, open);
    const hideBtn = button("Hide post", hide);
    const actions = dom.h("div.media-feedback-actions", { class: actionsClass }, nextBtn, retryBtn, openBtn, hideBtn);
    const el = dom.h("div.media-feedback", { hidden: true, onclick: (e) => e.stopPropagation() }, spinner, message, actions);
    const control = observe(target, { ...options, onChange(state) {
      const { phase, failed } = state;
      el.hidden = phase === "idle";
      el.dataset.state = phase;
      if (failureClass) el.classList.toggle(failureClass, failed);
      const recovery = ["offline", "reconnect", "slow", "error"].includes(phase);
      spinner.hidden = recovery;
      actions.hidden = !recovery;
      if (openBtn) openBtn.hidden = !failed;
      if (hideBtn) hideBtn.hidden = !failed;
      const copy = {
        loading: [`Loading ${noun}…`, ""],
        buffering: ["Buffering…", "Waiting for more video data."],
        slow: ["Taking longer than usual", `You can keep waiting, retry${next ? ", or go to the next item" : ""}.`],
        offline: ["You're offline", "More media data is needed. A post in your Library isn't necessarily downloaded. Reconnect and retry."],
        reconnect: ["Connection detected", `Retry if this ${noun} doesn't resume. Being online doesn't guarantee the source is reachable.`],
        error: [`Couldn't load this ${noun}`, "The source may be unreachable or the format unsupported. Retry or open the original post."],
        idle: ["", ""],
      };
      const text = copy[phase];
      title.textContent = text[0]; note.textContent = text[1]; note.hidden = !text[1];
      onChange?.(state);
    } });
    return { ...control, get state() { return control.state; }, el };
  }
  return { observe, create };
});
