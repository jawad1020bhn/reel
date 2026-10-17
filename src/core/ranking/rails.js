/* core.ranking.rails — the Discover page's editorial logic, as pure functions.

   Each rail = { id, family, title, params?, hint, hintParams?, items: Post[], spec: QuerySpec|null, watchable, layout }
   (`title`/`hint` are i18n keys; `{x}`/`{n}` placeholders are filled from params by the renderer)
   `spec` is what the rail's "Explore all" button opens in Library (and Watch), so the
   rail and its full list can never disagree.

   Composition: "Continue watching" is the only anchor. Everything else comes from a
   POOL of builders; each build picks ~COUNT of them with a seeded weighted draw, never
   two of the same `family`, shuffles the order and de-duplicates posts across shelves.
   A different `seed` ⇒ a different page. New rails: add a builder to POOL. */
XR.define("core.ranking.rails", ["core.query.engine", "core.util"], function (engine, util) {
  "use strict";

  const LIMIT = 24;
  const COUNT = 11;          // pool rails per page (+ the anchor ≈ 12)
  const WEEK = 7 * 864e5;

  /* ------------------------------------------------------------- helpers -- */
  const monthLabel = (key) => { const [y, m] = key.split("-").map(Number); return `${util.MONTHS[m - 1]} ${y}`; };
  const pick = (list, rnd) => list.length ? list[Math.floor(rnd() * list.length)] : undefined;
  /** Weighted pick: bigger `w` ⇒ more likely, small ones still surface. */
  function pickWeighted(list, w, rnd) {
    const ws = list.map((x) => Math.sqrt(Math.max(1, w(x))));
    let r = rnd() * ws.reduce((a, b) => a + b, 0);
    for (let i = 0; i < list.length; i++) { r -= ws[i]; if (r <= 0) return list[i]; }
    return list[list.length - 1];
  }
  const visible = (ctx) => (p) => p.media.length > 0 && !ctx.isHidden(p.id);
  const byUser = (posts) => { const m = new Map(); for (const p of posts) { const u = p.author.username; m.set(u, (m.get(u) || 0) + 1); } return m; };

  /* ---------------------------------------------------------------- pool -- */
  /* A builder gets (B) = { posts, ctx, q, rnd, seed, now, limit } and returns a rail or null.
     `family` groups builders that would feel repetitive together; `weight` biases the draw. */
  const POOL = [
    /* ---- personal signals ---- */
    { id: "jump", family: "creator", weight: 3, build: (B) => {
      const aff = B.ctx.creatorAffinity ? B.ctx.creatorAffinity() : new Map();
      if (!aff.size) return null;
      const top = [...aff.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u]) => u);
      const pool = B.posts.filter((p) => top.includes(p.author.username) && visible(B.ctx)(p) && !B.ctx.isSeen(p.id));
      return { title: "Jump back in", hint: "Unseen posts from creators you keep opening", items: util.shuffle(pool, B.seed).slice(0, B.limit), spec: { q: top.slice(0, 4).map((u) => "@" + u).join(" OR "), state: "unseen" }, specDisabled: true };
    } },
    { id: "because", family: "related", weight: 3, build: (B) => {
      const recent = B.ctx.recentlyOpened ? B.ctx.recentlyOpened(10).filter(visible(B.ctx)) : [];
      const src = pick(recent, B.rnd); if (!src || !B.ctx.related) return null;
      const items = B.ctx.related(src.id, 60).filter((p) => visible(B.ctx)(p) && !B.ctx.isSeen(p.id));
      return { title: "Because you watched @{x}", params: { x: src.author.username }, hint: util.truncate((src.text || "").replace(/\s+/g, " ").trim(), 60) || "More like something you opened", items: util.shuffle(items, B.seed).slice(0, B.limit), spec: null, min: 4 };
    } },
    { id: "starred", family: "starred", weight: 2, build: (B) => ({ title: "My list", hint: "Posts you starred", items: B.q({ state: "starred", sort: "saved" }), spec: { state: "starred" }, min: 4 }) },
    { id: "again", family: "starred", weight: 1, build: (B) => {
      const items = B.posts.filter((p) => visible(B.ctx)(p) && B.ctx.isSeen(p.id) && B.ctx.isStarred(p.id));
      return { title: "Watch again", hint: "Starred and already seen — worth a replay", items: util.shuffle(items, B.seed + 3).slice(0, B.limit), spec: { state: "starred" }, min: 4 };
    } },
    { id: "collection", family: "collection", weight: 2, build: (B) => {
      const cols = (B.ctx.collections ? B.ctx.collections() : []).filter((c) => c.ids.length >= 3);
      const c = pickWeighted(cols, (x) => x.ids.length, B.rnd); if (!c) return null;
      return { title: "From {x}", params: { x: c.name }, hint: "One of your collections", items: B.q({ collection: c.id, sort: "random", seed: B.seed }), spec: { collection: c.id }, layout: "wide" };
    } },

    /* ---- freshness / time ---- */
    { id: "recent", family: "recent", weight: 4, build: (B) => ({ title: "Recently saved", hint: "Your newest bookmarks", items: B.q({ sort: "saved" }), spec: { sort: "saved" } }) },
    { id: "fresh", family: "recent", weight: 2, build: (B) => {
      const items = B.posts.filter((p) => visible(B.ctx)(p) && B.now - (p.savedAt || 0) < WEEK).sort((a, b) => (B.ctx.isSeen(a.id) - B.ctx.isSeen(b.id)) || b.savedAt - a.savedAt);
      return { title: "New this week", hint: "Saved in the last 7 days, unseen first", items: items.slice(0, B.limit), spec: null, min: 4 };
    } },
    { id: "onthisday", family: "time", weight: 2, build: (B) => {
      const otd = B.posts.filter((p) => visible(B.ctx)(p) && (util.sameMonthDay(p.createdAt, B.now) || util.sameMonthDay(p.savedAt, B.now)));
      return { title: "On this day", hint: "Same date, earlier years", items: otd.slice(0, B.limit), spec: null, min: 2 };
    } },
    { id: "month", family: "time", weight: 3, build: (B) => {
      const months = (B.ctx.months ? B.ctx.months() : []).filter((m) => m.count >= 6);
      const m = pickWeighted(months, (x) => x.count, B.rnd); if (!m) return null;
      return { title: "Back in {x}", params: { x: monthLabel(m.key) }, hint: "Posted that month", items: B.q({ month: m.key, sort: "random", seed: B.seed }), spec: { month: m.key } };
    } },
    { id: "savedmonth", family: "time", weight: 2, build: (B) => {
      const months = (B.ctx.savedMonths ? B.ctx.savedMonths() : []).filter((m) => m.count >= 6);
      const m = pickWeighted(months, (x) => x.count, B.rnd); if (!m) return null;
      return { title: "You saved these in {x}", params: { x: monthLabel(m.key) }, hint: "A bookmarking spree", items: B.q({ savedMonth: m.key, sort: "random", seed: B.seed + 1 }), spec: { savedMonth: m.key } };
    } },
    { id: "archive", family: "time", weight: 1, build: (B) => ({ title: "From the archive", hint: "The oldest posts in your library", items: B.q({ sort: "oldest" }), spec: { sort: "oldest" } }) },

    /* ---- popularity ---- */
    { id: "top10", family: "popular", weight: 4, build: (B) => ({ title: "Top 10 in your library", hint: "What the crowd loved most", items: B.q({ sort: "likes" }).slice(0, 10), spec: { sort: "likes" }, layout: "rank", min: 5 }) },
    { id: "views", family: "popular", weight: 2, build: (B) => ({ title: "Most viewed", hint: "Biggest view counts", items: B.q({ sort: "views" }), spec: { sort: "views" } }) },
    { id: "gems", family: "popular", weight: 2, build: (B) => {
      const pool = B.posts.filter((p) => visible(B.ctx)(p) && !B.ctx.isSeen(p.id)).sort((a, b) => a.metrics.likes - b.metrics.likes);
      const quiet = pool.slice(0, Math.max(10, Math.floor(pool.length / 2)));
      return { title: "Hidden gems", hint: "Unseen posts that never went viral", items: util.shuffle(quiet, B.seed + 5).slice(0, B.limit), spec: null, min: 5 };
    } },

    /* ---- entity spotlights ---- */
    { id: "creator", family: "creator", weight: 3, build: (B) => {
      const counts = [...byUser(B.posts.filter(visible(B.ctx))).entries()].filter(([, n]) => n >= 5);
      const c = pickWeighted(counts, ([, n]) => n, B.rnd); if (!c) return null;
      return { title: "From @{x}", params: { x: c[0] }, hint: "{n} posts by this creator", hintParams: { n: c[1] }, items: B.q({ creator: c[0], sort: "random", seed: B.seed }), spec: { creator: c[0] } };
    } },
    { id: "hashtag", family: "hashtag", weight: 3, build: (B) => {
      const tags = (B.ctx.hashtags ? B.ctx.hashtags(40) : []).filter(([, n]) => n >= 4);
      const tg = pickWeighted(tags, ([, n]) => n, B.rnd); if (!tg) return null;
      const tag = String(tg[0]).replace(/^#/, "");
      return { title: "#" + tag, hint: "Posts carrying this tag", items: B.q({ q: "#" + tag, sort: "random", seed: B.seed }), spec: { q: "#" + tag } };
    } },
    { id: "lang", family: "lang", weight: 1, build: (B) => {
      const counts = new Map();
      for (const p of B.posts) if (visible(B.ctx)(p) && p.lang && p.lang !== "und" && p.lang !== "zxx") counts.set(p.lang, (counts.get(p.lang) || 0) + 1);
      const langs = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      if (langs.length < 2) return null;
      const [code] = pickWeighted(langs.slice(1).filter(([, n]) => n >= 5), ([, n]) => n, B.rnd) || [];
      if (!code) return null;
      let name = code; try { name = new Intl.DisplayNames([code, "en"], { type: "language" }).of(code) || code; } catch { /* keep code */ }
      const items = B.posts.filter((p) => p.lang === code && visible(B.ctx)(p));
      return { title: "In {x}", params: { x: name }, hint: "Posts in another language", items: util.shuffle(items, B.seed).slice(0, B.limit), spec: { q: "lang:" + code }, specDisabled: true };
    } },

    /* ---- format ---- */
    { id: "shorts", family: "video", weight: 4, build: (B) => ({ title: "Shorts for you", hint: "Unseen clips, freshly shuffled", items: B.q({ kind: "short", state: "unseen", sort: "random", seed: B.seed }), spec: { kind: "short", state: "unseen", sort: "random", seed: B.seed } }) },
    { id: "quick", family: "video", weight: 2, build: (B) => {
      const items = B.q({ kind: "video", state: "unseen", sort: "shortest" }).filter((p) => B.ctx.duration(p) > 0 && B.ctx.duration(p) <= 20);
      return { title: "Quick hits", hint: "Under 20 seconds each", items: util.shuffle(items, B.seed).slice(0, B.limit), spec: { kind: "video", sort: "shortest" }, min: 5 };
    } },
    { id: "long", family: "long", weight: 2, build: (B) => ({ title: "Long form", hint: "Clips over 3 minutes", items: B.q({ kind: "long", sort: "random", seed: B.seed }), spec: { kind: "long" }, layout: "wide" }) },
    { id: "binge", family: "long", weight: 1, build: (B) => ({ title: "Settle in", hint: "The longest videos you saved", items: B.q({ kind: "video", sort: "longest" }), spec: { kind: "video", sort: "longest" }, layout: "wide", min: 4 }) },
    { id: "albums", family: "photo", weight: 2, build: (B) => ({ title: "Photo stories", hint: "Multi-image posts", items: B.q({ kind: "carousel", sort: "random", seed: B.seed }), spec: { kind: "carousel" } }) },
    { id: "photos", family: "photo", weight: 3, build: (B) => ({ title: "Photos", hint: "Single stills", items: B.q({ kind: "photo", sort: "random", seed: B.seed + 7 }), spec: { kind: "photo", sort: "random", seed: B.seed + 7 } }) },
    { id: "gifs", family: "gif", weight: 1, build: (B) => ({ title: "GIFs", hint: "Loops", items: B.q({ kind: "gif", sort: "random", seed: B.seed }), spec: { kind: "gif" } }) },
    { id: "random", family: "random", weight: 3, build: (B) => ({ title: "Random picks", hint: "A fresh shuffle every time", items: B.q({ sort: "random", seed: B.seed + 99 }), spec: { sort: "random", seed: B.seed + 99 } }) },
    { id: "unseen", family: "random", weight: 2, build: (B) => ({ title: "Still unopened", hint: "You saved these and never looked", items: B.q({ state: "unseen", sort: "random", seed: B.seed + 11 }), spec: { state: "unseen", sort: "random", seed: B.seed + 11 } }) },
  ];

  /**
   * @param {Post[]} posts   all posts in the catalog
   * @param {object} ctx     query ctx (+ optional editorial signals, see catalog.ctx)
   * @param {object} opts    { now, seed, limit, count }
   */
  function build(posts, ctx, opts = {}) {
    const now = opts.now || Date.now();
    const seed = opts.seed || util.daySeed(new Date(now));
    const limit = opts.limit || LIMIT;
    const count = opts.count || COUNT;
    const rnd = util.seededRandom(seed);
    const q = (spec) => engine.run(posts, { ...spec, limit }, ctx).items;
    const B = { posts, ctx, q, rnd, seed, now, limit };

    const rails = [];
    const seenIds = new Map();                                 // postId → shelves it already sits in
    const finish = (def, rail) => {
      if (!rail) return false;
      /* a post may sit on at most two shelves per page; ranked rails keep their order intact */
      const items = rail.layout === "rank" ? rail.items : rail.items.filter((p) => (seenIds.get(p.id) || 0) < 2);
      if (items.length < (rail.min ?? 3)) return false;
      for (const p of items) seenIds.set(p.id, (seenIds.get(p.id) || 0) + 1);
      rails.push({ id: def.id, family: def.family, watchable: true, layout: "", specDisabled: false, ...rail, items });
      return true;
    };

    /* Anchor — in-progress clips, most recent first. */
    const resume = engine.run(posts, { state: "progress" }, ctx).items.sort((a, b) => ctx.progressAt(b) - ctx.progressAt(a)).slice(0, limit);
    finish({ id: "continue", family: "anchor" }, { title: "Continue watching", hint: "Pick up where you stopped", items: resume, spec: { state: "progress" }, min: 1, layout: "wide" });

    /* Pool — seeded weighted draw without replacement, one rail per family. */
    const candidates = POOL.slice();
    const usedFamilies = new Set();
    let picked = 0;
    while (picked < count && candidates.length) {
      const def = pickWeighted(candidates, (d) => d.weight * d.weight, rnd);
      candidates.splice(candidates.indexOf(def), 1);
      if (usedFamilies.has(def.family)) continue;
      let rail = null;
      try { rail = def.build(B); } catch { rail = null; }
      if (finish(def, rail)) { usedFamilies.add(def.family); picked++; }
    }

    /* Order: anchor first, then a seeded shuffle; keep the ranked shelf out of the very first slot. */
    const anchor = rails.filter((r) => r.family === "anchor");
    const rest = util.shuffle(rails.filter((r) => r.family !== "anchor"), seed + 17);
    if (rest.length > 2 && rest[0].layout === "rank") rest.push(rest.shift());
    /* visual rhythm: give one plain shelf the wide layout when none has it */
    if (!rest.some((r) => r.layout === "wide")) { const c = rest.find((r) => !r.layout); if (c) c.layout = "wide"; }
    return [...anchor, ...rest];
  }

  /** The post to feature at the top: one of the newest unseen posts, weighted by likes;
      falls back to the newest post. Deterministic for a seed. */
  function spotlight(posts, ctx, opts = {}) {
    const unseen = engine.run(posts, { state: "unseen", sort: "saved" }, ctx).items;
    const pool = unseen.slice(0, 10).filter((p) => !ctx.isUnavailable?.(p.id));
    if (!pool.length) return unseen[0] || engine.run(posts, { sort: "saved" }, ctx).items[0] || null;
    const rnd = util.seededRandom(opts.seed || util.daySeed());
    /* weight: recency rank (newest = 10 … oldest = 1) × log-likes, so a loved post can beat a newer one */
    return pickWeighted(pool, (p) => (10 - pool.indexOf(p)) * (1 + Math.log10(1 + (p.metrics.likes || 0))), rnd);
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

  return { build, spotlight, weightedShuffle, LIMIT, COUNT, POOL };
});
