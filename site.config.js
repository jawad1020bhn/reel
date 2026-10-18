/* XReels — the password of this deployment.

   Empty salt + hash  → no site password: the app opens straight away
                         (this is what a local, double-clicked copy wants).
   Filled in           → every visitor of this deployment must type the
                         password before the app opens.

   Set it with:   npm run site:password -- "your password"
   Read more in:  DEPLOY.md

   Only the salted SHA-256 digest lives here — never the password itself.
   The digest is read by src/application/services/site.js and checked by
   src/shell/site-gate.js. */
window.XREELS_SITE = {
  salt: "",
  hash: "",
  hint: "",
  title: "XReels",
};
