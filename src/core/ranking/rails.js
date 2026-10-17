/* core.ranking.rails — the Discover page's editorial logic, as pure functions.

   Each rail = { id, title, hint, items: Post[], spec: QuerySpec|null, watchable }
   `spec` is what the rail's "All" button opens in Library (and Watch), so the
   rail and its full list can never disagree. New rails: add a builder to the
   flex pool; the Discover feature renders whatever comes back.

   The pool is drawn with a per-visit seed: which shelves appear, in what order,
   which topic/creator/month/collection they follow and which posts fill them is
   different every time Discover mounts. `continue` and `jump` stay pinned —
   they answer "what was I doing?", so they lead the page whatever the seed. */
XR.define("core.ranking.rails", ["core.query.engine", "core.util"], function (engine, util) {
  "use strict";

  const LIMIT = 24;
  const MAX_RAILS = 12;      /* how many shelves a visit draws from the pool */
  const SPOTLIGHT_DEPTH = 6; /* the hero rotates across the newest unseen */

  /** n consecutive entries from a random offset — a different slice per seed. */
  function rotated(list, n, rnd) {
    if (list.length <= n) return list.slice();
    const start = Math.floor(rnd() * list.length);
    return Array.from({ length: n }, (_, i) => list[(start + i) % list.length]);
  }

  /**
   * @param {Post[]} posts            all posts in the catalog
   * @param {object} ctx              query ctx (+ ctx.recentlyWatched(): Post[] newest-first, ctx.creatorAffinity(): Map<username,score>)
   * @param {object} opts             { now, seed, limit, maxRails, collections }
   */
  function build(posts, ctx, opts = {}) {
    const now = opts.now || Date.now();
    const seed = opts.seed || util.daySeed(new Date(now));
    const limit = opts.limit || LIMIT;
    const maxRails = opts.maxRails || MAX_RAILS;
    const q = (spec) => engine.run(posts, { ...spec, limit }, ctx).items;
    const rnd = util.seededRandom(seed);
    const weekAgo = new Date(now - 7 * 864e5).toISOString().slice(0, 10);

    const pinned = []; /* time-sensitive shelves, always at the top */
    const pool = [];   /* everything else competes for a spot on each visit */
    const add = (list, rail) => { if (rail.items.length >= (rail.min ?? 3)) list.push(rail); };

    /* Continue watching — in-progress clips, most recent first. */
    const resume = engine.run(posts, { state: "progress" }, ctx).items
      .sort((a, b) => ctx.progressAt(b) - ctx.progressAt(a)).slice(0, limit);
    add(pinned, { id: "continue", title: "Continue watching", hint: "Pick up where you stopped", items: resume, spec: { state: "progress" }, watchable: true, min: 1, layout: "wide" });

    /* Jump back in — unseen posts from creators you actually watch. */
    const affinity = ctx.creatorAffinity ? ctx.creatorAffinity() : new Map();
    if (affinity.size) {
      const top = [...affinity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u]) => u);
      const jumpPool = posts.filter((p) => top.includes(p.author.username) && p.media.length && !ctx.isSeen(p.id) && !ctx.isHidden(p.id));
      add(pinned, { id: "jump", title: "Jump back in", hint: "Unseen posts from creators you keep opening", items: util.shuffle(jumpPool, seed + 3).slice(0, limit), spec: { q: top.slice(0, 4).map((u) => "@" + u).join(" OR "), state: "unseen" }, specDisabled: true, watchable: true });
    }

    /* ---------------------------------------------------------- the pool -- */
    add(pool, { id: "shorts", title: "Shorts for you", hint: "Unseen clips, reshuffled every visit", items: q({ kind: "short", state: "unseen", sort: "random", seed: seed + 5 }), spec: { kind: "short", state: "unseen", sort: "random", seed: seed + 5 }, watchable: true });
    add(pool, { id: "recent", title: "Recently saved", hint: "Your newest bookmarks", items: q({ sort: "saved" }), spec: { sort: "saved" }, watchable: true });
    add(pool, { id: "top10", title: "Top 10 in your library", hint: "What the crowd loved most", items: q({ sort: "likes" }).slice(0, 10), spec: { sort: "likes" }, watchable: true, layout: "rank", min: 5 });
    add(pool, { id: "starred", title: "My list", hint: "Posts you starred", items: q({ state: "starred", sort: "saved" }), spec: { state: "starred" }, watchable: true, min: 4 });
    add(pool, { id: "long", title: "Long form", hint: "Clips over 3 minutes", items: q({ kind: "long", sort: "saved" }), spec: { kind: "long" }, watchable: true, layout: "wide" });
    add(pool, { id: "albums", title: "Photo stories", hint: "Multi-image posts", items: q({ kind: "carousel", sort: "saved" }), spec: { kind: "carousel" }, watchable: true });
    add(pool, { id: "photos", title: "Photos", hint: "Single stills", items: q({ kind: "photo", sort: "random", seed: seed + 7 }), spec: { kind: "photo", sort: "random", seed: seed + 7 }, watchable: true });
    add(pool, { id: "gifs", title: "GIFs", hint: "Loops", items: q({ kind: "gif", sort: "saved" }), spec: { kind: "gif" }, watchable: true });
    add(pool, { id: "views", title: "Most viewed", hint: "The most played in your library", items: q({ sort: "views" }), spec: { sort: "views" }, watchable: true });
    add(pool, { id: "newest", title: "Newest posts", hint: "By post date", items: q({ sort: "newest" }), spec: { sort: "newest" }, watchable: true });
    add(pool, { id: "oldest", title: "Deep cuts", hint: "The oldest posts you kept", items: q({ sort: "oldest" }), spec: { sort: "oldest" }, watchable: true });
    add(pool, { id: "quick", title: "Quick hits", hint: "Short clips, back to back", items: q({ kind: "video", sort: "shortest" }), spec: { kind: "video", sort: "shortest" }, watchable: true });
    add(pool, { id: "queue", title: "Unseen queue", hint: "Everything you haven't watched yet", items: q({ state: "unseen", sort: "random", seed: seed + 13 }), spec: { state: "unseen", sort: "random", seed: seed + 13 }, watchable: true });
    add(pool, { id: "fresh", title: "Saved this week", hint: "Your newest captures", items: q({ q: "saved:>" + weekAgo, sort: "saved" }), spec: { q: "saved:>" + weekAgo, sort: "saved" }, watchable: true });
    add(pool, { id: "dups", title: "Saved twice", hint: "The same clip, bookmarked again", items: q({ q: "is:dup", sort: "saved" }), spec: { q: "is:dup", sort: "saved" }, watchable: true });

    /* On this day — posted or saved on today's date in another year. */
    const otd = posts.filter((p) => p.media.length && !ctx.isHidden(p.id) && (util.sameMonthDay(p.createdAt, now) || util.sameMonthDay(p.savedAt, now)));
    add(pool, { id: "onthisday", title: "On this day", hint: "Same date, earlier years", items: otd.slice(0, limit), spec: null, watchable: true, min: 1 });
    add(pool, { id: "random", title: "Random picks", hint: "A fresh shuffle every visit", items: q({ sort: "random", seed: seed + 99 }), spec: { sort: "random", seed: seed + 99 }, watchable: true });

    /* Topic shelves — the library's own hashtags, a different pair each visit. */
    const tagCount = new Map();
    for (const p of posts) {
      if (!p.media.length || ctx.isHidden(p.id)) continue;
      for (const tg of p.hashtags) tagCount.set(tg, (tagCount.get(tg) || 0) + 1);
    }
    const tags = [...tagCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([tg]) => tg);
    for (const [i, tg] of rotated(tags, 2, rnd).entries()) {
      const spec = { q: "#" + tg, sort: "random", seed: seed + 21 + i };
      add(pool, { id: "topic-" + tg, title: "#" + tg, hint: "Tagged in your library", items: q(spec), spec, watchable: true });
    }

    /* Creator shelves — a different pair of regulars each visit. */
    const byCreator = util.groupBy(posts.filter((p) => p.media.length && !ctx.isHidden(p.id)), (p) => p.author.username);
    const regulars = [...byCreator.entries()].filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length).map(([u]) => u);
    for (const [i, u] of rotated(regulars, 2, rnd).entries()) {
      const spec = { creator: u, sort: "random", seed: seed + 31 + i };
      add(pool, { id: "creator-" + u, title: "From @" + u, hint: "Their saved posts", items: q(spec), spec, watchable: true });
    }

    /* A month shelf — a different chapter of the library each visit. */
    const byMonth = util.groupBy(posts.filter((p) => p.media.length && !ctx.isHidden(p.id)), (p) => util.monthKey(p.createdAt));
    const months = [...byMonth.entries()].filter(([k, v]) => k && v.length >= 3);
    if (months.length) {
      const [mk] = months[Math.floor(rnd() * months.length)];
      const [y, m] = mk.split("-").map(Number);
      const spec = { month: mk, sort: "random", seed: seed + 41 };
      add(pool, { id: "month-" + mk, title: "From " + util.MONTHS[m - 1] + " " + y, hint: "That month, in your library", items: q(spec), spec, watchable: true });
    }

    /* A collection shelf — one of the reader's own groupings, when they exist. */
    const collections = (opts.collections || []).filter((c) => c.ids.length >= 2);
    if (collections.length) {
      const c = collections[Math.floor(rnd() * collections.length)];
      const spec = { collection: c.id, sort: "saved" };
      add(pool, { id: "coll-" + c.id, title: "“" + c.name + "”", hint: "From your collections", items: q(spec), spec, watchable: true, min: 2 });
    }

    /* Draw the page: a fresh order and a fresh subset on every visit. */
    const drawn = util.shuffle(pool, seed + 1).slice(0, maxRails);
    return [...pinned, ...drawn];
  }

  /** The one post to feature at the top: one of the newest unseen, rotating each visit. */
  function spotlight(posts, ctx, opts = {}) {
    const pool = engine.run(posts, { state: "unseen", sort: "saved" }, ctx).items;
    if (!pool.length) return engine.run(posts, { sort: "saved" }, ctx).items[0] || null;
    const seed = opts.seed || util.daySeed(new Date());
    return pool[seed % Math.min(pool.length, SPOTLIGHT_DEPTH)];
  }

  /**
   * Weighted shuffle for "Shuffle play": unseen posts are 3× as likely as seen ones, starred
   * posts get a small boost, unavailable ones are skipped, and the result is spread so the
   * same creator never plays twice in a row when it can be avoided. Deterministic for a seed.
   */
  function weightedShuffle(posts, ctx, { seed = Date.now() % 1e6, limit = 200 } = {}) {
    const rnd = util.seededRandom(seed);
    const weight = (p) => (ctx.isUnavailable?.(p.id) ? 0 : 1) * (ctx.isSeen(p.id) ? 1 : 3) * (ctx.isStarred(p.id) ? 1.5 : 1);
    /* Efraimidis–Spirakis: key = rnd^(1/w), take the largest keys */
    const keyed = posts.map((p) => { const w = weight(p); return w > 0 ? { p, k: Math.pow(rnd(), 1 / w) } : null; }).filter(Boolean);
    keyed.sort((a, b) => b.k - a.k);
    const picked = keyed.slice(0, limit).map((x) => x.p);
    /* spread creators: greedy pass that pushes an immediate repeat further down */
    const out = [];
    const rest = picked.slice();
    while (rest.length) {
      let i = 0;
      if (out.length) { const last = out[out.length - 1].author.username; while (i < rest.length && rest[i].author.username === last && i < 8) i++; if (i >= rest.length) i = 0; }
      out.push(rest.splice(i, 1)[0]);
    }
    return out;
  }

  return { build, spotlight, weightedShuffle, LIMIT };
});
