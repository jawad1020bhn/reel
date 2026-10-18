/* core.query.engine — turns a serialisable QuerySpec into an ordered list of posts.

   QuerySpec (every field optional, all URL-safe strings):
     q          free text in the search language (core.query.search)
     kind       all | video | short | long | photo | carousel | gif | text
     state      all | unseen | seen | starred | hidden | progress
     creator    username
     collection collection id
     month      YYYY-MM (post date)   savedMonth YYYY-MM (capture date)
     sort       saved | newest | oldest | likes | views | longest | shortest | random | smart | creator
                ("smart" = weighted, creator-spread shuffle — see smartShuffle)
     seed       number used by random sort
     limit      max results

   ctx = { kindOf, isSeen, isStarred, isHidden, inCollection, progressOf, duration }
*/
XR.define("core.query.engine", ["core.query.search", "core.util"], function (search, util) {
  "use strict";

  const KINDS = ["all", "video", "short", "long", "photo", "carousel", "gif", "text"];
  const STATES = ["all", "unseen", "seen", "starred", "hidden", "progress"];
  const SORTS = ["saved", "newest", "oldest", "likes", "views", "longest", "shortest", "random", "smart", "creator"];

  const DEFAULT = Object.freeze({ q: "", kind: "all", state: "all", creator: "", collection: "", month: "", savedMonth: "", sort: "saved", seed: 0, limit: 0 });

  function normalizeSpec(spec = {}) {
    const out = { ...DEFAULT };
    for (const k of Object.keys(DEFAULT)) if (spec[k] != null && spec[k] !== "") out[k] = spec[k];
    if (!KINDS.includes(out.kind)) out.kind = "all";
    if (!STATES.includes(out.state)) out.state = "all";
    if (!SORTS.includes(out.sort)) out.sort = "saved";
    out.seed = util.toNumber(out.seed);
    out.limit = util.toNumber(out.limit);
    out.creator = String(out.creator || "").replace(/^@/, "").toLowerCase();
    return out;
  }

  function kindTest(kind, ctx) {
    switch (kind) {
      case "video": return (p) => p.media.some((m) => m.kind !== "photo");
      case "short": return (p) => ctx.kindOf(p) === "short";
      case "long": return (p) => ctx.kindOf(p) === "long";
      case "photo": return (p) => p.media.length > 0 && p.media.every((m) => m.kind === "photo");
      case "carousel": return (p) => p.media.length > 1;
      case "gif": return (p) => p.media.some((m) => m.kind === "gif");
      case "text": return (p) => p.media.length === 0;
      default: return null;
    }
  }
  function stateTest(state, ctx) {
    switch (state) {
      case "unseen": return (p) => !ctx.isSeen(p.id);
      case "seen": return (p) => ctx.isSeen(p.id);
      case "starred": return (p) => ctx.isStarred(p.id);
      case "hidden": return (p) => ctx.isHidden(p.id);
      case "progress": return (p) => { const pr = ctx.progressOf(p); return pr > 0.03 && pr < 0.97; };
      default: return null;
    }
  }

  function comparator(sort, seed, ctx) {
    switch (sort) {
      case "newest": return (a, b) => b.createdAt - a.createdAt || a.order - b.order;
      case "oldest": return (a, b) => a.createdAt - b.createdAt || a.order - b.order;
      case "likes": return (a, b) => b.metrics.likes - a.metrics.likes || b.createdAt - a.createdAt;
      case "views": return (a, b) => b.metrics.views - a.metrics.views || b.metrics.likes - a.metrics.likes;
      case "longest": return (a, b) => ctx.duration(b) - ctx.duration(a);
      case "shortest": return (a, b) => ctx.duration(a) - ctx.duration(b);
      case "creator": return (a, b) => a.author.username.localeCompare(b.author.username) || b.createdAt - a.createdAt;
      case "saved":
      default: return (a, b) => (b.savedAt - a.savedAt) || (a.order - b.order) || (b.createdAt - a.createdAt);
    }
  }

  /**
   * Smart shuffle — a deterministic (per seed) order that feels curated rather than random:
   *   1. weight each post: unseen ×3, in progress ×2, starred ×1.5, fresh saves up to ×1.8
   *      (decaying over 60 days), a mild popularity lift (log10 likes), unavailable ×0.05;
   *   2. Efraimidis–Spirakis sampling: key = rnd^(1/w), sort by key — heavier posts float up
   *      but nothing is ever pinned, so every refresh is a genuinely new deck;
   *   3. spread pass: no creator repeats within SPREAD slots and no more than RUN posts of
   *      the same media kind in a row (looks ahead up to 12 slots; falls back when it can't).
   */
  function smartShuffle(items, seed, ctx) {
    const SPREAD = 4, RUN = 3, LOOK = 12, now = Date.now();
    const rnd = util.seededRandom(seed || 1);
    const weight = (p) => {
      let w = 1;
      if (ctx.isUnavailable?.(p.id)) w *= 0.05;
      if (!ctx.isSeen(p.id)) w *= 3;
      const pr = ctx.progressOf(p); if (pr > 0.03 && pr < 0.97) w *= 2;
      if (ctx.isStarred(p.id)) w *= 1.5;
      const ageDays = Math.max(0, (now - (p.savedAt || 0)) / 864e5);
      w *= 1 + 0.8 * Math.max(0, 1 - ageDays / 60);
      w *= 1 + 0.15 * Math.log10(1 + (p.metrics.likes || 0));
      return w;
    };
    const keyed = items.map((p) => ({ p, k: Math.pow(rnd(), 1 / weight(p)) })).sort((a, b) => b.k - a.k).map((x) => x.p);
    const kindOf = (p) => (p.media[0]?.kind === "photo" ? "photo" : "video");
    const out = [], rest = keyed;
    while (rest.length) {
      let pick = -1;
      for (let i = 0; i < Math.min(LOOK, rest.length); i++) {
        const c = rest[i];
        const recent = out.slice(-SPREAD);
        if (recent.some((o) => o.author.username === c.author.username)) continue;
        const tail = out.slice(-RUN);
        if (tail.length === RUN && tail.every((o) => kindOf(o) === kindOf(c))) continue;
        pick = i; break;
      }
      if (pick < 0) { pick = 0; for (let i = 0; i < Math.min(LOOK, rest.length); i++) if (!out.slice(-1).some((o) => o.author.username === rest[i].author.username)) { pick = i; break; } }
      out.push(rest.splice(pick, 1)[0]);
    }
    return out;
  }

  /**
   * @param {Post[]} posts
   * @param {object} rawSpec
   * @param {object} ctx
   * @returns {{items: Post[], total: number, spec: object}}
   */
  function run(posts, rawSpec, ctx) {
    const spec = normalizeSpec(rawSpec);
    const tests = [];
    const compiled = search.compile(spec.q);
    if (!compiled.empty) tests.push(compiled.predicate);
    const kt = kindTest(spec.kind, ctx); if (kt) tests.push(kt);
    const st = stateTest(spec.state, ctx); if (st) tests.push(st);
    // Hidden posts stay out of every list unless explicitly asked for.
    if (spec.state !== "hidden") tests.push((p) => !ctx.isHidden(p.id));
    // Text-only posts only show when asked for.
    if (spec.kind !== "text" && !/\bis:text\b/.test(spec.q)) tests.push((p) => p.media.length > 0);
    if (spec.creator) tests.push((p) => p.author.username.toLowerCase() === spec.creator);
    if (spec.collection) tests.push((p) => ctx.inCollection(spec.collection, p.id));
    if (spec.month) tests.push((p) => util.monthKey(p.createdAt) === spec.month);
    if (spec.savedMonth) tests.push((p) => util.monthKey(p.savedAt) === spec.savedMonth);

    let items = posts.filter((p) => tests.every((t) => t(p, ctx)));
    const sort = compiled.hints.sort && SORTS.includes(compiled.hints.sort) ? compiled.hints.sort : spec.sort;
    if (sort === "random") items = util.shuffle(items, spec.seed || 1);
    else if (sort === "smart") items = smartShuffle(items, spec.seed, ctx);
    else items.sort(comparator(sort, spec.seed, ctx));
    const total = items.length;
    if (spec.limit > 0) items = items.slice(0, spec.limit);
    return { items, total, spec: { ...spec, sort } };
  }

  /** Counts per facet for a base list (ignores kind/state of the spec itself). */
  function facets(posts, ctx) {
    const c = { all: 0, video: 0, short: 0, long: 0, photo: 0, carousel: 0, gif: 0, text: 0, unseen: 0, seen: 0, starred: 0, hidden: 0, progress: 0, unavailable: 0, dup: 0 };
    for (const p of posts) {
      if (ctx.isHidden(p.id)) { c.hidden++; continue; }
      if (!p.media.length) { c.text++; continue; }
      c.all++;
      const k = ctx.kindOf(p);
      if (k === "short" || k === "long") { c.video++; c[k]++; }
      if (k === "gif") { c.gif++; c.video++; }
      if (p.media.every((m) => m.kind === "photo")) c.photo++;
      if (p.media.length > 1) c.carousel++;
      if (ctx.isSeen(p.id)) c.seen++; else c.unseen++;
      if (ctx.isStarred(p.id)) c.starred++;
      if (ctx.isUnavailable?.(p.id)) c.unavailable++;
      if (ctx.isDuplicate?.(p.id)) c.dup++;
      const pr = ctx.progressOf(p); if (pr > 0.03 && pr < 0.97) c.progress++;
    }
    return c;
  }

  /** QuerySpec ↔ URL params (only non-default fields travel). */
  function toParams(spec) {
    const n = normalizeSpec(spec), out = {};
    for (const k of Object.keys(DEFAULT)) if (n[k] !== DEFAULT[k] && n[k] !== "" && n[k] !== 0) out[k] = String(n[k]);
    return out;
  }
  const fromParams = (params) => normalizeSpec(params || {});

  /** Human label for a spec, used by page titles and the Watch top bar. */
  function describe(spec) {
    const s = normalizeSpec(spec);
    const parts = [];
    const kindLabel = { video: "Videos", short: "Shorts", long: "Long videos", photo: "Photos", carousel: "Carousels", gif: "GIFs", text: "Text posts" }[s.kind];
    if (kindLabel) parts.push(kindLabel);
    const stateLabel = { unseen: "unseen", seen: "seen", starred: "starred", hidden: "hidden", progress: "in progress" }[s.state];
    if (stateLabel) parts.push(stateLabel);
    if (s.creator) parts.push("@" + s.creator);
    if (s.month) parts.push(s.month);
    if (s.q) parts.push(`“${s.q}”`);
    const sortLabel = { newest: "newest", oldest: "oldest", likes: "most liked", views: "most viewed", longest: "longest", shortest: "shortest", random: "shuffled", smart: "smart shuffle", creator: "by creator" }[s.sort];
    const head = parts.length ? parts.join(" · ") : "Everything";
    return sortLabel ? `${head} · ${sortLabel}` : head;
  }

  return { run, facets, normalizeSpec, toParams, fromParams, describe, smartShuffle, KINDS, STATES, SORTS, DEFAULT };
});
