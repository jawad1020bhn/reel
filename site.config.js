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
  salt: "32c3d98620c3cf3248d9338a3679bf9e",
  hash: "a512804f1371c3ecd8a4e9fa011de83b3991f848d78f2648d70babfc01ac0e54",
  hint: "",
  title: "XReels",
};
