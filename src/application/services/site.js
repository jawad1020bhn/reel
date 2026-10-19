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

   Honesty note (see DEPLOY.md): a client-side gate stops casual visitors.
   The static files of a deployment — including data/posts.json — are still
   public URLs. For real protection use a server-side gate (Vercel
   Authentication / Deployment Protection / WAF) and keep the export out of
   the deployment. */
XR.define("app.site", ["app.ports.platform"], function (platform) {
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

  async function verify(password) {
    if (!applies()) return true;
    const want = await expected();
    if (!want) return true;
    return same(await digest(password), want);
  }

  return { config, isEnabled, applies, isLocalFile, hint, title, salt, digest, expected, verify };
});
