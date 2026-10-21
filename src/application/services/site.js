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

   Honesty note (see DEPLOY.md): a client-side gate stops casual visitors.
   The static files of a deployment — including data/x-posts.json — are still
   public URLs. For real protection use a server-side gate (Vercel
   Authentication / Deployment Protection / WAF) and keep the export out of
   the deployment. */
XR.define("app.site", ["app.ports.platform", "core.availability"], function (platform, availability) {
  "use strict";

  const config = () => (typeof window !== "undefined" && window.XREELS_SITE) || {};
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
    return availability.status(seed(), now);
  }
  const phase = (s = status()) => (s.always ? "open" : availability.phase(s));

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

  /** The full verdict: { ok, reason: null | "wrong" | "closed", status }.
      The passcode is checked first, the clock second — a wrong passcode is
      "wrong" at any hour; the right one outside the opening hours is "closed". */
  async function check(password, now = new Date()) {
    if (!applies()) return { ok: true, reason: null, status: status(now) };
    const want = await expected();
    if (!want) return { ok: true, reason: null, status: status(now) };
    if (!same(await digest(password), want)) return { ok: false, reason: "wrong", status: null };
    const s = status(now);
    return s.open ? { ok: true, reason: null, status: s } : { ok: false, reason: "closed", status: s };
  }
  async function verify(password, now) { return (await check(password, now)).ok; }

  return { config, isEnabled, applies, isLocalFile, hint, title, salt, digest, expected, check, verify, schedule, scheduled, seed, graceMinutes, status, phase };
});
