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
   *      (decaying over 60 days), a mild popularity lift (log10 likes), unavailable ×0.05.
   *      Prolific creators are dampened (÷ 1 + log10 of their post count) so one account
   *      with 500 saves cannot crowd out everyone else before the spread pass even runs;
   *   2. exponential-race sampling (the numerically stable form of Efraimidis–Spirakis):
   *      key = −ln(1 − rnd) / w, ascending — heavier posts float up but nothing is ever
   *      pinned, so every new seed is a genuinely new deck;
   *   3. spread pass with O(1) checks (last-position maps, current kind-run): prefer no
   *      creator repeat within that creator's natural gap (SPREAD slots, tightened to
   *      total ÷ their post count for prolific accounts), no more than RUN posts of
   *      the same media kind in a row, and no shared lead hashtag within TAG_SPREAD
   *      slots. Each slot takes the cheapest candidate in a lookahead window under a
   *      penalty score that also paces creators against their fair share of the deck
   *      so far (see below), so when the remaining pool cannot satisfy every rule —
   *      one creator owning a third of the library, say — it breaks the least-bad one
   *      instead of abandoning the rest or stranding that creator in the tail.
   */
  function smartShuffle(items, seed, ctx) {
    const SPREAD = 4, RUN = 3, TAG_SPREAD = 3, LOOK = 64, now = Date.now();
    const rnd = util.seededRandom(seed || 1);
    const creatorCount = new Map();
    for (const p of items) creatorCount.set(p.author.username, (creatorCount.get(p.author.username) || 0) + 1);
    /* Each creator's natural spacing: an account with a third of the library cannot
       keep the same 4-slot gap as an account with ten posts — it would be throttled
       to the tail no matter its weight. Its target gap is total ÷ its count. */
    const creatorGap = new Map();
    for (const [user, count] of creatorCount) creatorGap.set(user, Math.min(SPREAD + 1, Math.max(1, items.length / count)));
    const weight = (p) => {
      let w = 1;
      if (ctx.isUnavailable?.(p.id)) w *= 0.05;
      if (!ctx.isSeen(p.id)) w *= 3;
      const pr = ctx.progressOf(p); if (pr > 0.03 && pr < 0.97) w *= 2;
      if (ctx.isStarred(p.id)) w *= 1.5;
      const ageDays = Math.max(0, (now - (p.savedAt || 0)) / 864e5);
      w *= 1 + 0.8 * Math.max(0, 1 - ageDays / 60);
      w *= 1 + 0.15 * Math.log10(1 + (p.metrics.likes || 0));
      w /= 1 + Math.log10(creatorCount.get(p.author.username) || 1);
      return w;
    };
    const keyed = items
      .map((p) => ({ p, k: -Math.log(1 - rnd()) / weight(p) }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.p);
    const kindOf = (p) => {
      if (ctx.kindOf) return ctx.kindOf(p);
      return p.media[0]?.kind === "photo" ? "photo" : "video";
    };
    const tagOf = (p) => (p.hashtags && p.hashtags[0]) || "";
    const out = [], rest = keyed, total = items.length;
    const lastCreator = new Map(), lastTag = new Map(), placedCreator = new Map();
    let tailKind = null, tailRun = 0;
    /* Soft-rule penalty for a candidate at the current tail: breaking a rule costs,
       breaking it worse costs more (a creator 1 slot back ≫ a creator 4 slots back),
       and an unbroken rule costs 0 — so the pick below trades rules off against each
       other instead of dropping them in a fixed order. Creators also pay for running
       ahead of their fair share of the deck so far, which paces a prolific account
       evenly through the order instead of letting it pile up wherever the weighted
       draw happened to cluster (or strand it all in the tail). */
    const penalty = (c) => {
      const pos = out.length;
      let cost = 0;
      const dc = pos - (lastCreator.get(c.author.username) ?? -Infinity);
      const gap = creatorGap.get(c.author.username) || SPREAD + 1;
      if (dc < gap) cost += (gap - dc) * 3;
      const placed = placedCreator.get(c.author.username) || 0;
      const ahead = (placed + 1) / (pos + 1) - (creatorCount.get(c.author.username) || 0) / total;
      cost += ahead * 30; /* negative when behind fair share: a lagging creator is pulled forward */
      if (tailRun >= RUN && kindOf(c) === tailKind) cost += 4;
      const tag = tagOf(c);
      if (tag) { const dt = pos - (lastTag.get(tag) ?? -Infinity); if (dt <= TAG_SPREAD) cost += TAG_SPREAD + 1 - dt; }
      return cost;
    };
    while (rest.length) {
      /* Cheapest candidate in the lookahead window; ties keep the weighted order.
         Costs can go negative (a creator behind fair share), so the whole window
         is scored — the first zero-cost candidate is not necessarily the best. */
      let pick = 0, best = Infinity;
      const lim = Math.min(LOOK, rest.length);
      for (let i = 0; i < lim; i++) {
        const cost = penalty(rest[i]);
        if (cost < best) { best = cost; pick = i; }
      }
      const [chosen] = rest.splice(pick, 1);
      out.push(chosen);
      lastCreator.set(chosen.author.username, out.length - 1);
      placedCreator.set(chosen.author.username, (placedCreator.get(chosen.author.username) || 0) + 1);
      if (tagOf(chosen)) lastTag.set(tagOf(chosen), out.length - 1);
      const k = kindOf(chosen);
      if (k === tailKind) tailRun++; else { tailKind = k; tailRun = 1; }
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
