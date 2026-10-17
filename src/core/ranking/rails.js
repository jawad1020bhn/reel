/* core.ranking.rails — the Discover page's editorial logic, as pure functions.

   Each rail = { id, title, hint, items: Post[], spec: QuerySpec|null, watchable }
   `spec` is what the rail's "All" button opens in Library (and Watch), so the
   rail and its full list can never disagree. New rails: add a builder to
   BUILDERS; the Discover feature renders whatever comes back. */
XR.define("core.ranking.rails", ["core.query.engine", "core.util"], function (engine, util) {
  "use strict";

  const LIMIT = 24;

  /**
   * @param {Post[]} posts            all posts in the catalog
   * @param {object} ctx              query ctx (+ ctx.recentlyWatched(): Post[] newest-first, ctx.creatorAffinity(): Map<username,score>)
   * @param {object} opts             { now, seed, limit }
   */
  function build(posts, ctx, opts = {}) {
    const now = opts.now || Date.now();
    const seed = opts.seed || util.daySeed(new Date(now));
    const limit = opts.limit || LIMIT;
    const q = (spec) => engine.run(posts, { ...spec, limit }, ctx).items;

    const rails = [];
    const add = (rail) => { if (rail.items.length >= (rail.min ?? 3)) rails.push(rail); };

    /* Continue watching — in-progress clips, most recent first. */
    const resume = engine.run(posts, { state: "progress" }, ctx).items
      .sort((a, b) => ctx.progressAt(b) - ctx.progressAt(a)).slice(0, limit);
    add({ id: "continue", title: "Continue watching", hint: "Pick up where you stopped", items: resume, spec: { state: "progress" }, watchable: true, min: 1, layout: "wide" });

    /* Jump back in — unseen posts from creators you actually watch. */
    const affinity = ctx.creatorAffinity ? ctx.creatorAffinity() : new Map();
    if (affinity.size) {
      const top = [...affinity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u]) => u);
      const pool = posts.filter((p) => top.includes(p.author.username) && p.media.length && !ctx.isSeen(p.id) && !ctx.isHidden(p.id));
      add({ id: "jump", title: "Jump back in", hint: "Unseen posts from creators you keep opening", items: util.shuffle(pool, seed).slice(0, limit), spec: { q: top.slice(0, 4).map((u) => "@" + u).join(" OR "), state: "unseen" }, specDisabled: true, watchable: true });
    }

    add({ id: "shorts", title: "Shorts for you", hint: "Unseen clips, shuffled daily", items: q({ kind: "short", state: "unseen", sort: "random", seed }), spec: { kind: "short", state: "unseen", sort: "random", seed }, watchable: true });
    add({ id: "recent", title: "Recently saved", hint: "Your newest bookmarks", items: q({ sort: "saved" }), spec: { sort: "saved" }, watchable: true });

    /* Top 10 — the ranked shelf with the giant numerals. */
    add({ id: "top10", title: "Top 10 in your library", hint: "What the crowd loved most", items: q({ sort: "likes" }).slice(0, 10), spec: { sort: "likes" }, watchable: true, layout: "rank", min: 5 });

    /* Starred — your list, when it has enough to show. */
    add({ id: "starred", title: "My list", hint: "Posts you starred", items: q({ state: "starred", sort: "saved" }), spec: { state: "starred" }, watchable: true, min: 4 });

    add({ id: "long", title: "Long form", hint: "Clips over 3 minutes", items: q({ kind: "long", sort: "saved" }), spec: { kind: "long" }, watchable: true, layout: "wide" });
    add({ id: "albums", title: "Photo stories", hint: "Multi-image posts", items: q({ kind: "carousel", sort: "saved" }), spec: { kind: "carousel" }, watchable: true });
    add({ id: "photos", title: "Photos", hint: "Single stills", items: q({ kind: "photo", sort: "random", seed: seed + 7 }), spec: { kind: "photo", sort: "random", seed: seed + 7 }, watchable: true });

    /* On this day — posted or saved on today's date in another year. */
    const otd = posts.filter((p) => p.media.length && !ctx.isHidden(p.id) && (util.sameMonthDay(p.createdAt, now) || util.sameMonthDay(p.savedAt, now)));
    add({ id: "onthisday", title: "On this day", hint: "Same date, earlier years", items: otd.slice(0, limit), spec: null, watchable: true, min: 1 });

    add({ id: "random", title: "Random picks", hint: "A fresh shuffle every day", items: q({ sort: "random", seed: seed + 99 }), spec: { sort: "random", seed: seed + 99 }, watchable: true });
    add({ id: "gifs", title: "GIFs", hint: "Loops", items: q({ kind: "gif", sort: "saved" }), spec: { kind: "gif" }, watchable: true });

    return rails;
  }

  /** The one post to feature at the top: newest unseen, else newest. */
  function spotlight(posts, ctx) {
    const pool = engine.run(posts, { state: "unseen", sort: "saved" }, ctx).items;
    return pool[0] || engine.run(posts, { sort: "saved" }, ctx).items[0] || null;
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
