/* app.site — the password of a *deployed* build.

   The PIN in Settings (app.lock) is per browser: it lives in this browser's
   IndexedDB/localStorage, so a fresh origin (a Vercel URL, another laptop, a
   phone) has no PIN and the app opens straight away. That is why a deployment
   "opens without password".

   app.site is the other half: ONE password for the deployment itself, read
   from site.config.js (shipped next to index.html). It is shared by every
   visitor, it is not stored anywhere, and only its salted SHA-256 digest
   lives in the file:

       window.XREELS_SITE = { salt, hash, hint };

   The browser hashes what the visitor types and compares it with the digest.
   Nothing is stored: every load of the page asks for the password again.

   Opening hours: with `availability: { enabled: true }` in site.config.js the
   passcode is only accepted inside the windows computed by core.availability
   (a seeded calendar of working days and 30-minute-max windows — see that
   module). The right passcode at the wrong time is refused with the reason
   "closed"; nothing is stored, the clock alone decides.

   Forcing it open: the one way through a closed door is the right passcode
   entered `forceTries` times in a row (default 7). A wrong passcode, or a
   window opening in between, starts the count over. The 7th entry opens a
   *forced window* of `forceMinutes` (default 30) that behaves like any other
   window: it closes, the grace runs, "Closing time." comes back. The forced
   window is remembered on this device (localStorage) for its own duration
   only, so a reload or a PWA relaunch inside it asks for the passcode once,
   not seven times.

   Honesty note (see DEPLOY.md): a client-side gate stops casual visitors.
   The static files of a deployment — including data/x-posts.json — are still
   public URLs. For real protection use a server-side gate (Vercel
   Authentication / Deployment Protection / WAF) and keep the export out of
   the deployment. */
XR.define("app.site", ["app.ports.platform", "core.availability"], function (platform, availability) {
  "use strict";

  const config = () => (typeof window !== "undefined" && window.XREELS_SITE) || {};
  /* ------------------------------------------------------------- closed -- */
  /** `closed: true` in site.config.js: the library is closed by its owner.
      Nothing boots, no passcode is asked, no data is fetched — everywhere,
      including a local file:// copy. There is no passcode that reopens it;
      reopening means editing the file, setting a password and adding data again. */
  const isClosed = () => config().closed === true;
  const closedNotice = () => String(config().closedNotice || "This library has been closed by its owner.");
  const salt = () => String(config().salt || "");
  const isEnabled = () => { const c = config(); return !!(c.hash || c.password); };
  /** A local file:// copy is private by definition — the gate is for deployments. */
  const isLocalFile = () => { try { return platform.isFile(); } catch { return false; } };
  /** Does the gate apply here (configured AND not a local file)? */
  const applies = () => isEnabled() && !isLocalFile();
  const hint = () => String(config().hint || "");
  const title = () => String(config().title || "saves");

  /* ----------------------------------------------------- opening hours -- */
  /** The normalized `availability` block of site.config.js. */
  const schedule = () => availability.normalize(config().availability);
  /** The calendar seed: an explicit `seed`, else the passcode digest (so a new passcode = a new calendar). */
  const seed = () => schedule().seed || String(config().hash || config().password || title());
  /** Do opening hours apply here (gate applies AND the schedule is switched on)? */
  const scheduled = () => applies() && schedule().enabled;
  const graceMinutes = () => schedule().graceMinutes;
  /** Where the clock stands right now: { open, working, until, remaining, … } — always open without a schedule. */
  function status(now = new Date()) {
    if (!scheduled()) return { open: true, always: true, working: true, window: null, until: null, remaining: Infinity, daysAhead: 0 };
    const s = availability.status(seed(), now);
    const f = forced(now);
    if (!f) return s;
    // Both open: whichever lasts longer decides when "Closing time." comes.
    return s.open && s.until && s.until.getTime() >= f.until.getTime() ? s : f;
  }
  const phase = (s = status()) => (s.always ? "open" : availability.phase(s));

  /* --------------------------------------------------- forcing it open -- */
  const FORCED_KEY = "xreels.site.forcedUntil";
  const forceTries = () => schedule().forceTries;
  const forceMinutes = () => schedule().forceMinutes;
  let streak = 0;                    // right passcodes in a row refused for closure
  let forcedUntil = 0;               // ms since epoch; 0 = no forced window on this device
  const store = () => { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; } };
  function readForced() {
    if (forcedUntil) return forcedUntil;
    try { forcedUntil = Number(store()?.getItem(FORCED_KEY)) || 0; } catch { forcedUntil = 0; }
    return forcedUntil;
  }
  function writeForced(until) {
    forcedUntil = until;
    try { if (until) store()?.setItem(FORCED_KEY, String(until)); else store()?.removeItem(FORCED_KEY); } catch { /* private mode */ }
  }
  /** The forced window if it is running right now, else null. A stored deadline further
      away than a forced window can be (clock set back) is not trusted and is dropped. */
  function forced(now = new Date()) {
    const until = readForced(), t = now.getTime();
    if (!until) return null;
    const left = until - t;
    if (left <= 0 || left > forceMinutes() * 60000 + 1000) { writeForced(0); return null; }
    return { open: true, forced: true, working: false, window: null, until: new Date(until), remaining: left / 60000, daysAhead: 0 };
  }
  /** Open a forced window starting now. */
  function forceOpen(now = new Date()) {
    writeForced(now.getTime() + forceMinutes() * 60000);
    streak = 0;
    return forced(now);
  }
  const streakOf = () => streak;

  /** Same digest shape as app.lock: sha256("<salt>:<password>"). */
  async function digest(password) { return platform.sha256(`${salt()}:${String(password ?? "")}`); }

  /** The digest the deployment expects. Plain passwords are hashed on the fly. */
  async function expected() {
    const c = config();
    if (c.hash) return String(c.hash);
    if (c.password) return digest(c.password);
    return "";
  }

  /** Length-independent, content constant-time compare. */
  function same(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /** The full verdict: { ok, reason: null | "wrong" | "closed", status, streak?, tries?, forced? }.
      The passcode is checked first, the clock second — a wrong passcode is
      "wrong" at any hour; the right one outside the opening hours is "closed"
      and counts towards forcing the door: the `tries`-th right passcode in a
      row opens a forced window (`forced: true`). A wrong passcode resets the count. */
  async function check(password, now = new Date()) {
    if (!applies()) return { ok: true, reason: null, status: status(now) };
    const want = await expected();
    if (!want) return { ok: true, reason: null, status: status(now) };
    if (!same(await digest(password), want)) { streak = 0; return { ok: false, reason: "wrong", status: null }; }
    const s = status(now);
    if (s.open) { streak = 0; return { ok: true, reason: null, status: s }; }
    const tries = forceTries();
    streak++;
    if (tries > 0 && streak >= tries) return { ok: true, reason: null, forced: true, status: forceOpen(now) };
    return { ok: false, reason: "closed", status: s, streak, tries };
  }
  async function verify(password, now) { return (await check(password, now)).ok; }

  return { config, isClosed, closedNotice, isEnabled, applies, isLocalFile, hint, title, salt, digest, expected, check, verify, schedule, scheduled, seed, graceMinutes, status, phase, forceTries, forceMinutes, forced, streak: streakOf };
});
