/* shell.availability — keeps the opening hours honest while the app is open.

   The site gate decides whether the passcode works at the moment it is typed.
   This module takes over afterwards: it knows when the current window closes
   and, when it does, gives the visitor a short grace (site.config.js
   `graceMinutes`, default 5) with a visible countdown to finish what they are
   watching — then pauses playback and brings the gate back as "Closing time."
   The passcode is accepted again when the next window opens.

   Timers alone are not trusted: a closed laptop lid or a throttled background
   tab must not stretch a window, so the clock is re-read on every visibility
   change and every 30 seconds, and an overdue grace locks immediately. Nor is
   the wall clock alone: deadlines are measured against the LATER of the wall
   clock and a monotonic clock anchored at start, so setting the device clock
   back while inside does not buy time either (sleep, where the monotonic clock
   may pause, still counts through the wall clock). */
XR.define("shell.availability", ["ui.dom", "ui.toast", "app.site", "app.playback", "shell.siteGate"], function (dom, toast, site, playback, siteGate) {
  "use strict";
  const TICK = 30000;
  let closesAt = 0, graceUntil = 0;
  let warnTimer = 0, lockTimer = 0, countdown = 0, ticker = 0, dismissWarning = null, locking = false;

  const graceMs = () => site.graceMinutes() * 60000;
  let anchorWall = 0, anchorMono = 0;
  const mono = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : NaN);
  /** The session clock: never earlier than the monotonic clock says it must be. */
  function nowMs() {
    const wall = Date.now(), m = mono();
    return anchorWall && Number.isFinite(m) ? Math.max(wall, anchorWall + (m - anchorMono)) : wall;
  }
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  function clearTimers() {
    clearTimeout(warnTimer); clearTimeout(lockTimer); clearInterval(countdown);
    warnTimer = lockTimer = countdown = 0;
    if (dismissWarning) { dismissWarning(); dismissWarning = null; }
  }

  /** Read the clock and plan the next close. Called after every successful entry. */
  function arm() {
    clearTimers();
    const s = site.status();
    const now = nowMs();
    if (s.always) { closesAt = graceUntil = 0; return; }
    if (s.open && s.until) {
      closesAt = s.until.getTime();
      graceUntil = closesAt + graceMs();
      if (s.remaining <= 60) toast.toast(`Heads-up: this window closes in about ${Math.max(1, Math.round(s.remaining))} min.`, "info", { icon: "clock", timeout: 5000 });
    } else {
      /* Let in during a window that has closed since (clock jump, long sleep): the grace starts now. */
      closesAt = now;
      graceUntil = now + graceMs();
    }
    warnTimer = setTimeout(warn, Math.max(0, closesAt - now));
    lockTimer = setTimeout(lock, Math.max(0, graceUntil - now));
  }

  /** Sleep-proof re-check: overdue grace → lock now; past the close → make sure the countdown shows. */
  function tick() {
    if (!closesAt || locking) return;
    const now = nowMs();
    if (now >= graceUntil) { lock(); return; }
    if (now >= closesAt) warn();
  }

  function warn() {
    if (dismissWarning || locking || !closesAt) return;
    const label = dom.h("span");
    const update = () => { label.textContent = `Closing time — the library locks in ${mmss(graceUntil - nowMs())}.`; };
    update();
    countdown = setInterval(update, 1000);
    dismissWarning = toast.show({ message: label, kind: "info", icon: "clock", timeout: 0 });
  }

  async function lock() {
    if (locking) return;
    locking = true;
    clearTimers();
    try { playback.pauseAll(); } catch { /* nothing to pause */ }
    try { await siteGate.ensure({ reason: "closed" }); }
    finally { locking = false; }
    arm();
  }

  function start(doc = document) {
    if (!site.scheduled()) return false;
    anchorWall = Date.now(); anchorMono = mono();
    arm();
    ticker = setInterval(tick, TICK);
    doc.addEventListener("visibilitychange", () => { if (!doc.hidden) tick(); });
    return true;
  }
  function stop() { clearTimers(); clearInterval(ticker); ticker = 0; closesAt = graceUntil = 0; }

  return { start, stop, arm, tick, lock, nowMs, get closesAt() { return closesAt; }, get graceUntil() { return graceUntil; }, get locking() { return locking; } };
});
