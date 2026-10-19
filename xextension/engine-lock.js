/* One live engine across x.com documents, not merely one per popup.
 * Browser-owned Web Locks release on tab close/crash and cannot race like a
 * read-then-write storage flag. Paused engines release their lease. */
(() => {
  "use strict";
  globalThis.XEngineLock = {
    async acquire() {
      if (!navigator.locks?.request) return null; // no unsafe fallback
      return new Promise((resolve, reject) => {
        navigator.locks.request("x-bookmarks-exclusive-engine", { ifAvailable: true }, async (lock) => {
          if (!lock) { resolve(null); return; }
          await new Promise((release) => resolve(release));
        }).catch(reject);
      });
    },
  };
})();
