/* core.domain.events — every event name the system emits, in one place.
   Payload contracts are documented next to each name. */
XR.define("core.domain.events", [], function () {
  "use strict";
  return Object.freeze({
    /** {source, count, label} — the catalog was (re)loaded from a dataset. */
    DATASET_CHANGED: "dataset:changed",
    /** {phase, message, progress?} — long running import/index work. */
    DATASET_PROGRESS: "dataset:progress",
    /** {error} — a dataset could not be read. */
    DATASET_ERROR: "dataset:error",
    /** {kind: 'seen'|'star'|'hide'|'progress'|'collection'|'view'|'bulk', ids: string[]} */
    ACTIVITY_CHANGED: "activity:changed",
    /** {prefs, patch} */
    PREFS_CHANGED: "prefs:changed",
    /** {path, params, prev} */
    ROUTE_CHANGED: "route:changed",
    /** {ids: string[], index: number, label?: string} — open the theatre viewer on a post list. */
    VIEWER_OPEN: "viewer:open",
    VIEWER_CLOSED: "viewer:closed",
    /** {message, kind?: 'info'|'ok'|'warn'|'error', action?: {label, onClick}} */
    TOAST: "ui:toast",
    /** {} — ask the command palette to open. */
    PALETTE_OPEN: "palette:open",
    /** {muted, speed, active} */
    PLAYBACK_CHANGED: "playback:changed",
    /** {} — PIN gate engaged / released. */
    LOCKED: "lock:locked",
    UNLOCKED: "lock:unlocked",
    /** {postId} — a feature asks whoever owns the collection picker to show it. */
    COLLECTION_PICK: "collection:pick",
    /** {width, height} — throttled window resize. */
    RESIZE: "ui:resize",
  });
});
