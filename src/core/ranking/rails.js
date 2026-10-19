/* core.ranking.rails — the Discover page's editorial logic, as pure functions.

   Each rail = { id, family, title, params?, hint, hintParams?, items: Post[], spec: QuerySpec|null, watchable, layout }
   (`title`/`hint` are i18n keys; `{x}`/`{n}` placeholders are filled from params by the renderer)
   `spec` is what the rail's "Explore all" button opens in Library (and Watch), so the
   rail and its full list can never disagree.

   Composition: "Continue watching" is the only anchor. Everything else comes from a
   POOL of builders; each build picks COUNT of them with a seeded weighted draw (one per
   `family` first, then a second pass if the library is too small to fill the page),
   shuffles the order and limits how many shelves a post can sit on. The items inside a
   shelf rotate too: sorted shelves draw from a 2× window and reshuffle it per seed, so
   even the same shelf shows a different line-up on every shuffle (ranked and resume
   shelves keep their order). A different `seed` ⇒ a different page.
   New rails: add a builder to POOL. */
XR.define("core.ranking.rails", ["core.query.engine", "core.util"], function (engine, util) {
  "use strict";

  const LIMIT = 24;
  const COUNT = 22;          // shelves per page (anchor included when it exists)
  const PER_POST = 3;        // a post may sit on at most this many shelves per page
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
  /** Items for a sorted shelf: take a 2× window off the top of the ordering and reshuffle
      it, so the shelf stays "recent"/"popular" but its line-up rotates with the seed. */
  const windowed = (list, seed, limit) => util.shuffle(list.slice(0, limit * 2), seed).slice(0, limit);
  const HOUR = (ms) => new Date(ms).getHours();
  const primaryAspect = (p) => (p.media[0] && p.media[0].aspect) || 1;
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
    { id: "starred", family: "starred", weight: 2, build: (B) => ({ title: "My list", hint: "Posts you starred", items: B.qw({ state: "starred", sort: "saved" }), spec: { state: "starred" }, min: 4 }) },
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
    { id: "recent", family: "recent", weight: 4, build: (B) => ({ title: "Recently saved", hint: "Your newest bookmarks", items: B.qw({ sort: "saved" }), spec: { sort: "saved" } }) },
    { id: "fresh", family: "recent", weight: 2, build: (B) => {
      const items = B.posts.filter((p) => visible(B.ctx)(p) && B.now - (p.savedAt || 0) < WEEK).sort((a, b) => (B.ctx.isSeen(a.id) - B.ctx.isSeen(b.id)) || b.savedAt - a.savedAt);
      return { title: "New this week", hint: "Saved in the last 7 days, unseen first", items: windowed(items, B.seed, B.limit), spec: null, min: 4 };
    } },
    { id: "onthisday", family: "time", weight: 2, build: (B) => {
      const otd = B.posts.filter((p) => visible(B.ctx)(p) && (util.sameMonthDay(p.createdAt, B.now) || util.sameMonthDay(p.savedAt, B.now)));
      return { title: "On this day", hint: "Same date, earlier years", items: util.shuffle(otd, B.seed).slice(0, B.limit), spec: null, min: 2 };
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
    { id: "archive", family: "time", weight: 1, build: (B) => ({ title: "From the archive", hint: "The oldest posts in your library", items: B.qw({ sort: "oldest" }), spec: { sort: "oldest" } }) },

    /* ---- popularity ---- */
    { id: "top10", family: "popular", weight: 4, build: (B) => ({ title: "Top 10 in your library", hint: "What the crowd loved most", items: B.q({ sort: "likes" }).slice(0, 10), spec: { sort: "likes" }, layout: "rank", min: 5 }) },
    { id: "views", family: "popular", weight: 2, build: (B) => ({ title: "Most viewed", hint: "Biggest view counts", items: B.qw({ sort: "views" }), spec: { sort: "views" } }) },
    { id: "gems", family: "popular", weight: 2, build: (B) => {
      const pool = B.posts.filter((p) => visible(B.ctx)(p) && !B.ctx.isSeen(p.id)).sort((a, b) => a.metrics.likes - b.metrics.likes);
      const quiet = pool.slice(0, Math.max(10, Math.floor(pool.length / 2)));
      return { title: "Hidden gems", hint: "Unseen posts that never went viral", items: util.shuffle(quiet, B.seed + 5).slice(0, B.limit), spec: null, min: 5 };
    } },

    /* ---- entity spotlights ---- */
    { id: "creator", family: "creator", weight: 3, build: (B) => {
      const counts = [...byUser(B.posts.filter(visible(B.ctx))).entries()].filter(([u, n]) => n >= 5 && !B.used.creators.has(u));
      const c = pickWeighted(counts, ([, n]) => n, B.rnd); if (!c) return null;
      B.used.creators.add(c[0]);
      return { title: "From @{x}", params: { x: c[0] }, hint: "{n} posts by this creator", hintParams: { n: c[1] }, items: B.q({ creator: c[0], sort: "random", seed: B.seed }), spec: { creator: c[0] } };
    } },
    { id: "hashtag", family: "hashtag", weight: 3, build: (B) => {
      const tags = (B.ctx.hashtags ? B.ctx.hashtags(40) : []).filter(([t, n]) => n >= 4 && !B.used.tags.has(t));
      const tg = pickWeighted(tags, ([, n]) => n, B.rnd); if (!tg) return null;
      B.used.tags.add(tg[0]);
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
      const items = engine.run(B.posts, { kind: "video", state: "unseen", sort: "shortest", limit: B.limit * 3 }, B.ctx).items.filter((p) => B.ctx.duration(p) > 0 && B.ctx.duration(p) <= 20);
      return { title: "Quick hits", hint: "Under 20 seconds each", items: util.shuffle(items, B.seed).slice(0, B.limit), spec: { kind: "video", sort: "shortest" }, min: 5 };
    } },
    { id: "long", family: "long", weight: 2, build: (B) => ({ title: "Long form", hint: "Clips over 3 minutes", items: B.q({ kind: "long", sort: "random", seed: B.seed }), spec: { kind: "long" }, layout: "wide" }) },
    { id: "binge", family: "long", weight: 1, build: (B) => ({ title: "Settle in", hint: "The longest videos you saved", items: B.qw({ kind: "video", sort: "longest" }), spec: { kind: "video", sort: "longest" }, layout: "wide", min: 4 }) },
    { id: "albums", family: "photo", weight: 2, build: (B) => ({ title: "Photo stories", hint: "Multi-image posts", items: B.q({ kind: "carousel", sort: "random", seed: B.seed }), spec: { kind: "carousel" } }) },
    { id: "photos", family: "photo", weight: 3, build: (B) => ({ title: "Photos", hint: "Single stills", items: B.q({ kind: "photo", sort: "random", seed: B.seed + 7 }), spec: { kind: "photo", sort: "random", seed: B.seed + 7 } }) },
    { id: "gifs", family: "gif", weight: 1, build: (B) => ({ title: "GIFs", hint: "Loops", items: B.q({ kind: "gif", sort: "random", seed: B.seed }), spec: { kind: "gif" } }) },
    { id: "random", family: "random", weight: 3, build: (B) => ({ title: "Random picks", hint: "A fresh shuffle every time", items: B.q({ sort: "random", seed: B.seed + 99 }), spec: { sort: "random", seed: B.seed + 99 } }) },
    { id: "unseen", family: "random", weight: 2, build: (B) => ({ title: "Still unopened", hint: "You saved these and never looked", items: B.q({ state: "unseen", sort: "random", seed: B.seed + 11 }), spec: { state: "unseen", sort: "random", seed: B.seed + 11 } }) },

    /* ---- second spotlights (different entity than the first, see B.used) ---- */
    { id: "creator2", family: "creator2", weight: 2, build: (B) => POOL.find((d) => d.id === "creator").build(B) },
    { id: "hashtag2", family: "hashtag2", weight: 2, build: (B) => POOL.find((d) => d.id === "hashtag").build(B) },

    /* ---- shape ---- */
    { id: "vertical", family: "shape", weight: 2, build: (B) => {
      const items = B.posts.filter((p) => visible(B.ctx)(p) && primaryAspect(p) < 0.8 && p.media[0].kind !== "photo");
      return { title: "Vertical", hint: "Shot for a phone screen", items: util.shuffle(items, B.seed).slice(0, B.limit), spec: null, min: 5 };
    } },
    { id: "cinematic", family: "shape", weight: 2, build: (B) => {
      const items = B.posts.filter((p) => visible(B.ctx)(p) && primaryAspect(p) >= 1.6);
      return { title: "Widescreen", hint: "Landscape frames, best on a big display", items: util.shuffle(items, B.seed).slice(0, B.limit), spec: null, min: 5, layout: "wide" };
    } },

    /* ---- more popularity / discovery ---- */
    { id: "missed", family: "popular2", weight: 2, build: (B) => ({ title: "Popular, but you missed it", hint: "Unseen posts with the most likes", items: B.qw({ state: "unseen", sort: "likes" }, 21), spec: { state: "unseen", sort: "likes" }, min: 5 }) },
    { id: "deepcuts", family: "time2", weight: 1, build: (B) => ({ title: "Deep cuts", hint: "The oldest posts you never opened", items: B.qw({ state: "unseen", sort: "oldest" }, 22), spec: { state: "unseen", sort: "oldest" }, min: 5 }) },
    { id: "thisyear", family: "time2", weight: 2, build: (B) => {
      const y = new Date(B.now).getFullYear();
      const items = B.posts.filter((p) => visible(B.ctx)(p) && new Date(p.createdAt).getFullYear() === y);
      return { title: "Posted in {x}", params: { x: String(y) }, hint: "This year's posts", items: util.shuffle(items, B.seed).slice(0, B.limit), spec: null, min: 5 };
    } },
    { id: "yearago", family: "time2", weight: 2, build: (B) => {
      const lo = B.now - 395 * 864e5, hi = B.now - 335 * 864e5;
      const items = B.posts.filter((p) => visible(B.ctx)(p) && p.savedAt >= lo && p.savedAt <= hi);
      return { title: "A year ago", hint: "What you were saving twelve months back", items: util.shuffle(items, B.seed).slice(0, B.limit), spec: null, min: 4 };
    } },
    { id: "latenight", family: "mood", weight: 1, build: (B) => {
      const items = B.posts.filter((p) => visible(B.ctx)(p) && p.savedAt && HOUR(p.savedAt) < 5);
      return { title: "Late-night saves", hint: "Bookmarked between midnight and 5 am", items: util.shuffle(items, B.seed).slice(0, B.limit), spec: null, min: 5 };
    } },
    { id: "quoted", family: "mood", weight: 1, build: (B) => {
      const items = B.posts.filter((p) => visible(B.ctx)(p) && p.quoted);
      return { title: "With a quote", hint: "Posts that quote another post", items: util.shuffle(items, B.seed).slice(0, B.limit), spec: null, min: 4 };
    } },
    { id: "sampler", family: "sampler", weight: 3, build: (B) => {
      /* one random post per creator, creators in seeded order */
      const seen = new Set(), items = [];
      for (const p of util.shuffle(B.posts.filter(visible(B.ctx)), B.seed + 31)) { if (seen.has(p.author.username)) continue; seen.add(p.author.username); items.push(p); if (items.length >= B.limit) break; }
      return { title: "One from everyone", hint: "A single pick per creator", items, spec: null, min: 6 };
    } },
    { id: "newcreators", family: "creator3", weight: 2, build: (B) => {
      const aff = B.ctx.creatorAffinity ? B.ctx.creatorAffinity() : new Map();
      const items = B.posts.filter((p) => visible(B.ctx)(p) && !aff.has(p.author.username) && !B.ctx.isSeen(p.id));
      return { title: "Creators you haven't opened yet", hint: "Accounts in your library you never tapped", items: util.shuffle(items, B.seed + 41).slice(0, B.limit), spec: null, min: 5 };
    } },
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
    /* sorted shelves: 2× window, reshuffled per seed (see header) */
    const qw = (spec, salt = 0) => windowed(engine.run(posts, { ...spec, limit: limit * 2 }, ctx).items, seed + salt, limit);
    const used = { creators: new Set(), tags: new Set() };          // entity spotlights never repeat on one page
    const B = { posts, ctx, q, qw, rnd, seed, now, limit, used };

    const rails = [];
    const seenIds = new Map();                                 // postId → shelves it already sits in
    let postCap = PER_POST;                                    // relaxed by the last-chance pass below
    let minCap = Infinity;                                     // ditto: builders' minimum line-up size
    const finish = (def, rail) => {
      if (!rail) return false;
      /* a post may sit on at most postCap shelves per page; ranked rails keep their order intact */
      const items = rail.layout === "rank" ? rail.items : rail.items.filter((p) => (seenIds.get(p.id) || 0) < postCap);
      if (items.length < Math.min(rail.min ?? 3, minCap)) return false;
      for (const p of items) seenIds.set(p.id, (seenIds.get(p.id) || 0) + 1);
      rails.push({ id: def.id, family: def.family, watchable: true, layout: "", specDisabled: false, ...rail, items });
      return true;
    };

    /* Anchor — in-progress clips, most recent first. */
    const resume = engine.run(posts, { state: "progress" }, ctx).items.sort((a, b) => ctx.progressAt(b) - ctx.progressAt(a)).slice(0, limit);
    finish({ id: "continue", family: "anchor" }, { title: "Continue watching", hint: "Pick up where you stopped", items: resume, spec: { state: "progress" }, min: 1, layout: "wide" });

    /* Pool — seeded weighted draw without replacement. Pass 1: one rail per family.
       Pass 2 (small libraries): the families that lost out get another go so the page
       still reaches COUNT shelves whenever the data allows it. */
    const target = count - rails.length;
    const usedFamilies = new Set(), tried = new Set();
    let picked = 0;
    const attempt = (def) => {
      let rail = null;
      try { rail = def.build(B); } catch { rail = null; }
      return finish(def, rail);
    };
    for (let pass = 0; pass < 2 && picked < target; pass++) {
      const candidates = POOL.filter((d) => !tried.has(d.id));
      while (picked < target && candidates.length) {
        const def = pickWeighted(candidates, (d) => d.weight * d.weight, rnd);
        candidates.splice(candidates.indexOf(def), 1);
        if (pass === 0 && usedFamilies.has(def.family)) continue;
        tried.add(def.id);
        if (attempt(def)) { usedFamilies.add(def.family); picked++; }
      }
    }

    /* Last chance: on a small library the per-post cap starves late shelves (every
       post is already on PER_POST of them, so their line-ups filter down below the
       minimum and the page comes up short). Relax the cap — and, if that is still
       not enough, the minimum line-up size — and retry every builder that isn't
       already on the page. Entity spotlights pick a fresh creator/tag via B.used,
       so nothing repeats. */
    for (const relax of [{ cap: PER_POST + 2, min: 3 }, { cap: PER_POST + 5, min: 2 }]) {
      if (picked >= target) break;
      postCap = relax.cap;
      minCap = relax.min;
      const retry = POOL.filter((d) => !rails.some((r) => r.id === d.id));
      while (picked < target && retry.length) {
        const def = pickWeighted(retry, (d) => d.weight * d.weight, rnd);
        retry.splice(retry.indexOf(def), 1);
        if (attempt(def)) picked++;
      }
    }

    /* Order: anchor first, then a seeded shuffle; keep the ranked shelf out of the very first slot. */
    const anchor = rails.filter((r) => r.family === "anchor");
    const rest = util.shuffle(rails.filter((r) => r.family !== "anchor"), seed + 17);
    if (rest.length > 2 && rest[0].layout === "rank") rest.push(rest.shift());
    /* visual rhythm: give one plain shelf the wide layout when none has it */
    if (!rest.some((r) => r.layout === "wide")) { const c = rest.find((r) => !r.layout); if (c) c.layout = "wide"; }
    return [...anchor, ...rest];
  }

  /** The post to feature at the top: one of the newest unseen image-only posts, weighted by likes;
      falls back to the newest available image-only post. Deterministic for a seed. */
  function spotlight(posts, ctx, opts = {}) {
    const images = (spec) => engine.run(posts, { kind: "photo", ...spec }, ctx).items
      .filter((p) => !ctx.isUnavailable?.(p.id));
    const unseen = images({ state: "unseen", sort: "saved" });
    const pool = unseen.slice(0, 10);
    if (!pool.length) return images({ sort: "saved" })[0] || null;
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
