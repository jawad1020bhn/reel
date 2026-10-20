/* app.activity — everything the user *does* to the archive: seen, starred,
   hidden, playback progress, collections, saved views. Kept separate from the
   dataset so re-importing posts never loses a star.

   Storage layout (one document, debounced writes):
     { seen: {postId: ms}, starred: {postId: ms}, hidden: {postId: ms},
       progress: {mediaId: {t, d, at}}, collections: [{id, name, createdAt, ids: []}],
       views: [{name, spec, createdAt}], opens: {postId: count}, creators: {username: score} } */
XR.define("app.activity", ["app.ports.storage", "core.events", "core.domain.events", "core.util"], function (storage, events, EV, util) {
  "use strict";
  const KEY = "xreels.activity.v1";
  const EMPTY = () => ({ seen: {}, starred: {}, hidden: {}, progress: {}, collections: [], views: [], opens: {}, creators: {}, unavailable: {}, notes: {} });

  let data = EMPTY();
  let dirty = false;

  const persist = util.debounce(() => {
    if (!dirty) return;
    dirty = false;
    storage.set(KEY, data).catch((err) => console.warn("[activity] persist failed", err));
  }, 400);
  function touch(kind, ids) {
    dirty = true; persist();
    events.bus.emit(EV.ACTIVITY_CHANGED, { kind, ids: Array.isArray(ids) ? ids : [ids] });
  }

  async function load() {
    try {
      const stored = await storage.get(KEY);
      if (stored && typeof stored === "object") data = { ...EMPTY(), ...stored };
    } catch (err) { console.warn("[activity] load failed", err); }
    /* One-time reset. Reddit saves are new in this release, so any "unavailable" mark on a
       Reddit save (id "t3_…") was written by a health check while Reddit's images were still
       blocked by the content policy. Clear those marks once; a later check re-marks real dead ones. */
    if (data.redditMarksReset !== "v3") {
      for (const id of Object.keys(data.unavailable || {})) if (String(id).startsWith("t3_")) delete data.unavailable[id];
      data.redditMarksReset = "v3";
      dirty = true; persist();
    }
    return data;
  }

  /* ----------------------------------------------------------------- seen -- */
  const isSeen = (id) => !!data.seen[id];
  function markSeen(id, on = true) {
    if (!!data.seen[id] === on) return;
    if (on) data.seen[id] = Date.now(); else delete data.seen[id];
    touch("seen", id);
  }
  /** Called when a post is opened; feeds "Jump back in" affinity. */
  function noteOpen(post) {
    if (!post) return;
    data.opens[post.id] = (data.opens[post.id] || 0) + 1;
    const u = post.author?.username;
    if (u) data.creators[u] = (data.creators[u] || 0) + 1;
    markSeen(post.id, true);
  }
  const creatorAffinity = () => new Map(Object.entries(data.creators));
  /** Post ids opened most recently (newest first); falls back to most-opened when no timestamps exist. */
  const recentOpens = (n = 12) => Object.entries(data.opens).sort((a, b) => (data.seen[b[0]] || 0) - (data.seen[a[0]] || 0) || b[1] - a[1]).slice(0, n).map(([id]) => id);

  /* ------------------------------------------------------------- starred -- */
  const isStarred = (id) => !!data.starred[id];
  function toggleStar(id, on = !data.starred[id]) {
    if (on) data.starred[id] = Date.now(); else delete data.starred[id];
    touch("star", id);
    return on;
  }
  const starredAt = (id) => data.starred[id] || 0;

  /* -------------------------------------------------------------- hidden -- */
  const isHidden = (id) => !!data.hidden[id];
  function toggleHidden(id, on = !data.hidden[id]) {
    if (on) data.hidden[id] = Date.now(); else delete data.hidden[id];
    touch("hide", id);
    return on;
  }

  /* --------------------------------------------------------- unavailable -- */
  /* posts whose media no longer loads from X (found by app.health or by the player) */
  const isUnavailable = (id) => !!data.unavailable[id];
  function markUnavailable(ids, on = true) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) { if (on) data.unavailable[id] = Date.now(); else delete data.unavailable[id]; }
    if (list.length) touch("unavailable", list);
  }
  const unavailableIds = () => Object.keys(data.unavailable);
  function clearUnavailable() { const ids = unavailableIds(); data.unavailable = {}; if (ids.length) touch("unavailable", ids); }

  /* ------------------------------------------------------------ progress -- */
  function saveProgress(mediaId, t, d) {
    if (!mediaId || !(d > 0)) return;
    const ratio = t / d;
    if (ratio < 0.02 || ratio > 0.985) { if (data.progress[mediaId]) { delete data.progress[mediaId]; touch("progress", mediaId.split(":")[0]); } return; }
    const prev = data.progress[mediaId];
    if (prev && Math.abs(prev.t - t) < 1) return;
    data.progress[mediaId] = { t: Math.round(t * 10) / 10, d: Math.round(d), at: Date.now() };
    touch("progress", mediaId.split(":")[0]);
  }
  const progressEntry = (mediaId) => data.progress[mediaId] || null;
  const clearProgress = (mediaId) => { if (data.progress[mediaId]) { delete data.progress[mediaId]; touch("progress", mediaId.split(":")[0]); } };
  /** Best progress ratio for a post (its longest in-progress clip). */
  function progressOf(post) {
    let best = 0;
    for (const m of post.media) { const e = data.progress[m.id]; if (e && e.d) best = Math.max(best, e.t / e.d); }
    return best;
  }
  function progressAt(post) {
    let at = 0;
    for (const m of post.media) { const e = data.progress[m.id]; if (e) at = Math.max(at, e.at || 0); }
    return at;
  }

  /* --------------------------------------------------------- collections -- */
  const collections = () => data.collections.slice();
  const collection = (id) => data.collections.find((c) => c.id === id) || null;
  function createCollection(name) {
    const c = { id: util.uid(), name: String(name || "Untitled").trim() || "Untitled", createdAt: Date.now(), ids: [] };
    data.collections.push(c);
    touch("collection", []);
    return c;
  }
  function renameCollection(id, name) { const c = collection(id); if (c) { c.name = String(name).trim() || c.name; touch("collection", c.ids); } }
  function deleteCollection(id) { const i = data.collections.findIndex((c) => c.id === id); if (i >= 0) { const [c] = data.collections.splice(i, 1); touch("collection", c.ids); } }
  function addToCollection(id, postIds) {
    const c = collection(id); if (!c) return false;
    const list = Array.isArray(postIds) ? postIds : [postIds];
    let changed = false;
    for (const pid of list) if (!c.ids.includes(pid)) { c.ids.push(pid); changed = true; }
    if (changed) touch("collection", list);
    return changed;
  }
  function removeFromCollection(id, postIds) {
    const c = collection(id); if (!c) return;
    const set = new Set(Array.isArray(postIds) ? postIds : [postIds]);
    c.ids = c.ids.filter((x) => !set.has(x));
    touch("collection", [...set]);
  }
  const inCollection = (id, postId) => !!collection(id)?.ids.includes(postId);
  const collectionsOf = (postId) => data.collections.filter((c) => c.ids.includes(postId));

  /* --------------------------------------------------------- saved views -- */
  const views = () => data.views.slice();
  function saveView(name, spec) {
    const clean = String(name).trim(); if (!clean) return;
    const existing = data.views.find((v) => v.name === clean);
    if (existing) existing.spec = spec; else data.views.push({ name: clean, spec, createdAt: Date.now() });
    touch("view", []);
  }
  function deleteView(name) { data.views = data.views.filter((v) => v.name !== name); touch("view", []); }

  /* ----------------------------------------------------------------- bulk -- */
  function bulk(fn) { fn(); touch("bulk", []); }
  function counts() {
    return { seen: Object.keys(data.seen).length, starred: Object.keys(data.starred).length, hidden: Object.keys(data.hidden).length, progress: Object.keys(data.progress).length, collections: data.collections.length };
  }
  const exportState = () => JSON.parse(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...data }));
  function importState(obj, { merge = true } = {}) {
    if (!obj || typeof obj !== "object") throw new Error("Not a saves backup");
    const incoming = { ...EMPTY(), ...obj };
    if (!merge) data = incoming;
    else {
      for (const k of ["seen", "starred", "hidden", "progress", "opens", "creators"]) data[k] = { ...data[k], ...incoming[k] };
      for (const c of incoming.collections || []) { const ex = collection(c.id); if (ex) { for (const id of c.ids) if (!ex.ids.includes(id)) ex.ids.push(id); } else data.collections.push(c); }
      for (const v of incoming.views || []) if (!data.views.find((x) => x.name === v.name)) data.views.push(v);
    }
    touch("bulk", []);
  }
  async function resetAll() { data = EMPTY(); dirty = false; await storage.remove(KEY); events.bus.emit(EV.ACTIVITY_CHANGED, { kind: "bulk", ids: [] }); }

  return {
    load, KEY,
    isSeen, markSeen, noteOpen, creatorAffinity, recentOpens,
    isStarred, toggleStar, starredAt,
    isHidden, toggleHidden,
    isUnavailable, markUnavailable, unavailableIds, clearUnavailable,
    saveProgress, progressEntry, clearProgress, progressOf, progressAt,
    collections, collection, createCollection, renameCollection, deleteCollection, addToCollection, removeFromCollection, inCollection, collectionsOf,
    views, saveView, deleteView,
    bulk, counts, exportState, importState, resetAll,
    flush: () => { if (dirty) { dirty = false; return storage.set(KEY, data); } return Promise.resolve(); },
  };
});
