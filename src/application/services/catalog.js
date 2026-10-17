/* app.catalog — the in-memory library: posts, media, creators, indexes, queries.
   It owns nothing about *where* data comes from (see app.importer) or what the
   user did with it (see app.activity); it composes both into query results. */
XR.define("app.catalog", ["core.domain.model", "core.query.engine", "core.ranking.rails", "core.util", "core.events", "core.domain.events", "app.activity", "app.prefs"],
  function (model, engine, rails, util, events, EV, activity, prefs) {
    "use strict";

    const state = {
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
    };

    /* ----------------------------------------------------------- index -- */
    function load(posts, source) {
      state.posts = posts;
      state.byId = new Map();
      state.mediaById = new Map();
      state.creators = new Map();
      state.hashtags = new Map();
      const months = new Map(), savedMonths = new Map();
      for (const p of posts) {
        if (!p.haystack) p.haystack = model.haystack(p);
        state.byId.set(p.id, p);
        for (const m of p.media) state.mediaById.set(m.id, m);
        const u = p.author.username;
        let c = state.creators.get(u);
        if (!c) { c = { username: u, name: p.author.name, avatar: p.author.avatar, id: p.author.id, count: 0, videos: 0, photos: 0, lastSavedAt: 0, likes: 0, ids: [] }; state.creators.set(u, c); }
        c.count++; c.ids.push(p.id); c.likes += p.metrics.likes;
        if (model.hasVideo(p)) c.videos++; else if (p.media.length) c.photos++;
        if (p.savedAt > c.lastSavedAt) { c.lastSavedAt = p.savedAt; c.avatar = p.author.avatar || c.avatar; c.name = p.author.name || c.name; }
        for (const t of p.hashtags) state.hashtags.set(t, (state.hashtags.get(t) || 0) + 1);
        const mk = util.monthKey(p.createdAt); if (mk) months.set(mk, (months.get(mk) || 0) + 1);
        const sk = util.monthKey(p.savedAt); if (sk) savedMonths.set(sk, (savedMonths.get(sk) || 0) + 1);
      }
      const toList = (map) => [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([key, count]) => ({ key, count, label: monthLabel(key) }));
      state.months = toList(months);
      state.savedMonths = toList(savedMonths);
      indexDuplicates(posts);
      state.source = { ...source, count: posts.length, loadedAt: Date.now() };
      state.ready = true;
      events.bus.emit(EV.DATASET_CHANGED, { source: state.source, count: posts.length });
    }
    /** Duplicate = different posts carrying the same media (reposts/quotes of the same clip). */
    function indexDuplicates(posts) {
      const byMedia = new Map();
      const keyOf = (m) => (m.sources?.[0]?.url || m.thumb || m.poster || "").replace(/\?.*$/, "").replace(/\/\d+x\d+\//, "/");
      for (const p of posts) for (const m of p.media) { const k = keyOf(m); if (!k) continue; if (!byMedia.has(k)) byMedia.set(k, new Set()); byMedia.get(k).add(p.id); }
      state.dupOf = new Map(); state.dupGroups = [];
      for (const set of byMedia.values()) {
        if (set.size < 2) continue;
        const ids = [...set];
        state.dupGroups.push(ids);
        for (const id of ids) state.dupOf.set(id, ids);
      }
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
    /* Discover draws its shelves from a per-visit seed; collections ride along
       so a "collection" shelf can be part of the draw. */
    const buildRails = (opts) => rails.build(state.posts, ctx, { ...opts, collections: activity.collections() });
    const spotlight = (seed) => rails.spotlight(state.posts, ctx, { seed });

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

    return {
      load, query, facets, describe, post, media, postsByIds, creator, creators, topHashtags, buildRails, spotlight, stats, related, ctx, duplicatesOf, shuffle,
      get dupGroups() { return state.dupGroups; },
      get posts() { return state.posts; },
      get months() { return state.months; },
      get savedMonths() { return state.savedMonths; },
      get source() { return state.source; },
      get ready() { return state.ready; },
      get size() { return state.posts.length; },
    };
  });
