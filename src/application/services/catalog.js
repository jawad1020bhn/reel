/* app.catalog — the in-memory library: posts, media, creators, indexes, queries.
   It owns nothing about *where* data comes from (see app.importer) or what the
   user did with it (see app.activity); it composes both into query results.

   Two lists: `all` holds every loaded post (X and Reddit); `posts` is the shown subset,
   after the Settings toggles Show X posts / Show Reddit posts. Every query, rail and
   count reads `posts`, so hiding a source is one filter here. Toggling rebuilds the
   indexes from `all`, so nothing is re-imported or lost. */
XR.define("app.catalog", ["core.domain.model", "core.query.engine", "core.ranking.rails", "core.util", "core.events", "core.domain.events", "app.activity", "app.prefs"],
  function (model, engine, rails, util, events, EV, activity, prefs) {
    "use strict";

    const state = {
      all: /** @type {Post[]} */ ([]),
      posts: /** @type {Post[]} */ ([]),
      byId: new Map(),
      mediaById: new Map(),
      creators: /** @type {Map<string, Creator>} */ (new Map()),
      months: /** @type {{key:string,count:number,label:string}[]} */ ([]),
      savedMonths: [],
      hashtags: new Map(),
      dupOf: /** @type {Map<string, string[]>} postId → ids sharing the same media */ (new Map()),
      dupGroups: /** @type {string[][]} */ ([]),
      source: { id: "none", label: "No data", count: 0, loadedAt: 0, fingerprint: "" },
      ready: false,
    };

    /* ------------------------------------------------------------- ctx -- */
    /** The context object core.query needs to evaluate user state. */
    const ctx = {
      kindOf: (p) => model.kindOf(p, prefs.get("shortMaxSeconds")),
      duration: (p) => model.duration(p),
      isSeen: (id) => activity.isSeen(id),
      isStarred: (id) => activity.isStarred(id),
      isHidden: (id) => activity.isHidden(id) || (prefs.get("hideSensitive") && !!state.byId.get(id)?.flags.sensitive),
      inCollection: (cid, id) => activity.inCollection(cid, id),
      isUnavailable: (id) => activity.isUnavailable(id),
      isDuplicate: (id) => state.dupOf.has(id),
      progressOf: (p) => activity.progressOf(p),
      progressAt: (p) => activity.progressAt(p),
      creatorAffinity: () => activity.creatorAffinity(),
      /* editorial signals for the Discover rail builder */
      collections: () => activity.collections(),
      hashtags: (n) => topHashtags(n),
      months: () => state.months,
      savedMonths: () => state.savedMonths,
      recentlyOpened: (n = 12) => activity.recentOpens(n).map((id) => state.byId.get(id)).filter(Boolean),
      related: (id, n) => related(id, n),
    };

    /* ----------------------------------------------------------- index -- */
    let loadVersion = 0;
    const INDEX_CHUNK = 800;
    const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));

    /** Build indexes off to the side, then publish them atomically. Very large libraries
        yield between chunks so the browser can paint the splash and process input; if a
        newer library load starts, the older build quietly abandons its partial maps. */
    /** Whether a post's site is switched on in Settings. Only an explicit `false` hides it.
        Reddit has one sub-switch: "Images only" keeps its photos and galleries and drops
        every Reddit post that carries a video. X is never affected by it. */
    const isShown = (p) => {
      if (p.platform !== "reddit") return prefs.get("showX") !== false;
      if (prefs.get("showReddit") === false) return false;
      return !(prefs.get("redditImagesOnly") === true && model.hasVideo(p));
    };

    async function load(input, source) {
      const version = ++loadVersion;
      const posts = input.filter(isShown);
      const shouldYield = posts.length >= 3000;
      const byId = new Map(), mediaById = new Map(), creators = new Map(), hashtags = new Map();
      const months = new Map(), savedMonths = new Map();
      for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        if (!p.haystack) p.haystack = model.haystack(p);
        byId.set(p.id, p);
        for (const m of p.media) mediaById.set(m.id, m);
        const u = p.author.username;
        let c = creators.get(u);
        if (!c) { c = { username: u, name: p.author.name, avatar: p.author.avatar, id: p.author.id, platform: p.platform || "x", count: 0, videos: 0, photos: 0, lastSavedAt: 0, likes: 0, ids: [] }; creators.set(u, c); }
        c.count++; c.ids.push(p.id); c.likes += p.metrics.likes;
        if (c.platform !== (p.platform || "x")) c.platform = "x";  // same handle on both sites: profile link falls back to X
        if (model.hasVideo(p)) c.videos++; else if (p.media.length) c.photos++;
        if (p.savedAt > c.lastSavedAt) { c.lastSavedAt = p.savedAt; c.avatar = p.author.avatar || c.avatar; c.name = p.author.name || c.name; }
        for (const t of p.hashtags) hashtags.set(t, (hashtags.get(t) || 0) + 1);
        const mk = util.monthKey(p.createdAt); if (mk) months.set(mk, (months.get(mk) || 0) + 1);
        const sk = util.monthKey(p.savedAt); if (sk) savedMonths.set(sk, (savedMonths.get(sk) || 0) + 1);
        if (shouldYield && (i + 1) % INDEX_CHUNK === 0 && i + 1 < posts.length) {
          await yieldToMain();
          if (version !== loadVersion) return null;
        }
      }
      const toList = (map) => [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([key, count]) => ({ key, count, label: monthLabel(key) }));
      const duplicates = await indexDuplicates(posts, version, shouldYield);
      if (!duplicates || version !== loadVersion) return null;
      Object.assign(state, {
        all: input, posts, byId, mediaById, creators, hashtags,
        months: toList(months), savedMonths: toList(savedMonths),
        dupOf: duplicates.dupOf, dupGroups: duplicates.dupGroups,
        source: { ...source, count: posts.length, loadedAt: Date.now() }, ready: true,
      });
      events.bus.emit(EV.DATASET_CHANGED, { source: state.source, count: posts.length });
      return state.source;
    }
    /** Duplicate = different posts carrying the same media (reposts/quotes of the same clip). */
    async function indexDuplicates(posts, version, shouldYield) {
      const byMedia = new Map();
      const keyOf = (m) => (m.sources?.[0]?.url || m.thumb || m.poster || "").replace(/\?.*$/, "").replace(/\/\d+x\d+\//, "/");
      for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        for (const m of p.media) { const k = keyOf(m); if (!k) continue; if (!byMedia.has(k)) byMedia.set(k, new Set()); byMedia.get(k).add(p.id); }
        if (shouldYield && (i + 1) % INDEX_CHUNK === 0 && i + 1 < posts.length) {
          await yieldToMain();
          if (version !== loadVersion) return null;
        }
      }
      const dupOf = new Map(), dupGroups = [];
      let i = 0;
      for (const set of byMedia.values()) {
        if (set.size >= 2) {
          const ids = [...set];
          dupGroups.push(ids);
          for (const id of ids) dupOf.set(id, ids);
        }
        i++;
        if (shouldYield && i % INDEX_CHUNK === 0 && i < byMedia.size) {
          await yieldToMain();
          if (version !== loadVersion) return null;
        }
      }
      return { dupOf, dupGroups };
    }
    const shuffle = (posts, opts) => rails.weightedShuffle(posts, ctx, opts);
    const duplicatesOf = (id) => (state.dupOf.get(id) || []).filter((x) => x !== id);
    function monthLabel(key) {
      const [y, m] = key.split("-").map(Number);
      return `${util.MONTHS[m - 1]} ${y}`;
    }

    /* --------------------------------------------------------- queries -- */
    const query = (spec) => engine.run(state.posts, spec, ctx);
    const facets = () => engine.facets(state.posts, ctx);
    const describe = (spec) => engine.describe(spec);
    const post = (id) => state.byId.get(String(id)) || null;
    const media = (id) => state.mediaById.get(id) || null;
    const postsByIds = (ids) => ids.map((id) => state.byId.get(id)).filter(Boolean);
    const creator = (username) => state.creators.get(String(username || "").replace(/^@/, "")) || null;
    function creators(sort = "count") {
      const list = [...state.creators.values()];
      if (sort === "recent") list.sort((a, b) => b.lastSavedAt - a.lastSavedAt);
      else if (sort === "name") list.sort((a, b) => a.username.localeCompare(b.username));
      else list.sort((a, b) => b.count - a.count || b.lastSavedAt - a.lastSavedAt);
      return list;
    }
    const topHashtags = (n = 30) => [...state.hashtags.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    const buildRails = (opts) => rails.build(state.posts, ctx, opts);
    const spotlight = (opts) => rails.spotlight(state.posts, ctx, opts);

    /** Loaded posts per site, ignoring the Settings toggles (for Settings counts). */
    function countByPlatform() {
      let x = 0, reddit = 0;
      for (const p of state.all) { if (p.platform === "reddit") reddit++; else x++; }
      return { x, reddit };
    }

    /** Headline numbers for Discover footer and Insights. */
    function stats() {
      let videos = 0, photos = 0, gifs = 0, carousels = 0, seconds = 0, textOnly = 0, likes = 0, shorts = 0, longs = 0;
      for (const p of state.posts) {
        if (!p.media.length) { textOnly++; continue; }
        if (p.media.length > 1) carousels++;
        const k = ctx.kindOf(p);
        if (k === "short") shorts++; if (k === "long") longs++;
        for (const m of p.media) {
          if (m.kind === "video") { videos++; seconds += m.duration; }
          else if (m.kind === "gif") gifs++;
          else photos++;
        }
        likes += p.metrics.likes;
      }
      const a = activity.counts();
      return { posts: state.posts.length, withMedia: state.posts.length - textOnly, textOnly, videos, photos, gifs, carousels, shorts, longs, seconds, likes, creators: state.creators.size, seen: a.seen, starred: a.starred, hidden: a.hidden, progress: a.progress, collections: a.collections };
    }

    /** Neighbouring posts of the same media kind for "more like this". */
    function related(postId, limit = 12) {
      const p = post(postId); if (!p) return [];
      const kind = ctx.kindOf(p);
      const same = state.posts.filter((x) => x.id !== p.id && x.media.length && !ctx.isHidden(x.id) && (x.author.username === p.author.username || x.hashtags.some((t) => p.hashtags.includes(t))));
      const sameKind = same.filter((x) => ctx.kindOf(x) === kind);
      return util.uniq([...sameKind, ...same]).slice(0, limit);
    }

    /* Re-filter when a site is switched on or off in Settings, or Reddit's "Images only"
       sub-switch changes. Only those three keys matter. */
    const visibilityKey = () => `${prefs.get("showX") !== false}|${prefs.get("showReddit") !== false}|${prefs.get("redditImagesOnly") === true}`;
    let shownKey = visibilityKey();
    events.bus.on(EV.PREFS_CHANGED, () => {
      const key = visibilityKey();
      if (key === shownKey) return;
      shownKey = key;
      if (state.ready) load(state.all, state.source).catch(() => {});
    });

    return {
      load, query, facets, describe, post, media, postsByIds, creator, creators, topHashtags, buildRails, spotlight, stats, related, ctx, duplicatesOf, shuffle, countByPlatform,
      get dupGroups() { return state.dupGroups; },
      /** Shown posts (after the Settings toggles). */
      get posts() { return state.posts; },
      /** Every loaded post, including hidden sites. Used for imports, exports and deletes. */
      get all() { return state.all; },
      get months() { return state.months; },
      get savedMonths() { return state.savedMonths; },
      get source() { return state.source; },
      get ready() { return state.ready; },
      get size() { return state.posts.length; },
    };
  });
