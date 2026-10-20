/* One live engine per site, not merely one per popup.
 * Browser-owned Web Locks release on tab close/crash and cannot race like a
 * read-then-write storage flag. Paused engines release their lease.
 *
 * Locks are scoped per origin by the browser, so the X lock and the Reddit
 * lock can never collide — but every engine on one site (capture, unfollow,
 * unsave) shares that site's single name. */
(() => {
  "use strict";
  const X_LOCK = "x-bookmarks-exclusive-engine";
  const REDDIT_LOCK = "xreels-reddit-exclusive-engine";
  globalThis.XEngineLock = {
    X_LOCK,
    REDDIT_LOCK,
    async acquire(name = X_LOCK) {
      if (!navigator.locks?.request) return null; // no unsafe fallback
      return new Promise((resolve, reject) => {
        navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
          if (!lock) { resolve(null); return; }
          await new Promise((release) => resolve(release));
        }).catch(reject);
      });
    },
  };
})();
