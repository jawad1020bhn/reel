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

   ctx = { kindOf, isSeen, isStarred, isHidden, inCollection, progressOf, duration,
          signals: { attentionOf, skipRateOf, affinityOf, lastDeck, sessionSeen } }   // all optional
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
   *   3. video rule (hard, when possible): no more than five videos (short or long) in a
   *      row while a photo, carousel, GIF or text post is left, and non-videos are paced
   *      across the whole deck so they are not all used up at the start;
   *   4. spread pass with O(1) checks (last-position maps, current kind-run): prefer no
   *      creator repeat within that creator's natural gap (SPREAD slots, tightened to
   *      total ÷ their post count for prolific accounts), no more than RUN posts of
   *      the same media kind in a row, and no shared lead hashtag within TAG_SPREAD
   *      slots. Each slot takes the cheapest candidate in a lookahead window under a
   *      penalty score that also paces creators against their fair share of the deck
   *      so far (see below), so when the remaining pool cannot satisfy every rule —
   *      one creator owning a third of the library, say — it breaks the least-bad one
   *      instead of abandoning the rest or stranding that creator in the tail.
   *
   * Weighting is learned, not fixed. `ctx.signals` (optional, see catalog.ctx) adds:
   *   · attentionOf(id)  0–1 — how long the post actually held the user (dwell minus skips):
   *                      a clip swiped past in under a second loses nearly all its weight,
   *                      a clip watched to the end gains up to ×1.9;
   *   · skipRateOf(id)   a post skipped 3+ times is demoted even when it is starred;
   *   · affinityOf(user) a SIGNED creator score (opens decayed over time, minus skipped
   *                      deals); mapped through tanh to ×0.68–×1.28. A creator the user keeps
   *                      passing over drops below ×1 instead of keeping a click's boost;
   *   · lastDeck         the previous deck's opening (ids) — those posts, and the creators
   *                      that filled it, are pushed back so two shuffles never look alike;
   *   · sessionSeen      ids the Library already showed this session — demoted, not hidden.
   *
   * Explain mode: pass `{ explain: true }` and the deck carries an `explain` map — one entry
   * per post id listing what moved its weight, whether it filled the reserved lead block,
   * and which spread rule it broke on placement.
   */
  function smartShuffle(items, seed, ctx, options = {}) {
    const SPREAD = 4, RUN = 3, TAG_SPREAD = 3, LOOK = 64, VIDEO_RUN = 5, now = Date.now();
    const explain = !!options.explain;
    const why = explain ? new Map() : null;
    const rnd = util.seededRandom(seed || 1);
    const creatorCount = new Map();
    for (const p of items) creatorCount.set(p.author.username, (creatorCount.get(p.author.username) || 0) + 1);
    /* Each creator's natural spacing: an account with a third of the library cannot
       keep the same 4-slot gap as an account with ten posts — it would be throttled
       to the tail no matter its weight. Its target gap is total ÷ its count. */
    const creatorGap = new Map();
    for (const [user, count] of creatorCount) creatorGap.set(user, Math.min(SPREAD + 1, Math.max(1, items.length / count)));
    /* ---- learned signals (all optional; a missing ctx.signals = the old behaviour) ---- */
    const sig = ctx.signals || null;
    /* mode tunes the same machine, it does not swap algorithms:
         fresh     — favour what was just saved, widen the unseen boost, shorten the freshness window
         balanced  — the default
         discovery — mute creator affinity and dampen prolific accounts harder, so the deck wanders */
    const mode = sig?.mode || "balanced";
    const unseenMul = mode === "fresh" ? 4.5 : 3;
    const freshWindow = mode === "fresh" ? 30 : 60;
    const affScale = mode === "discovery" ? 0.4 : 1;
    const creatorDamp = mode === "discovery" ? 1.4 : 1;
    /* Affinity is a SIGNED score per creator (opens that decay over time, minus the times
       the feed dealt them and the user swiped past — see activity.creatorSignalOf). It is
       mapped through tanh so the pull saturates: +1 open ≈ ×1.05, +4 ≈ ×1.2, negative
       skips push below ×1 (down to ×0.6). A missing signal leaves the creator neutral. */
    const creatorMul = new Map();
    /* How much of the deck a creator is entitled to. The spread pass pulls a creator forward
       when it is behind its fair share — which would drag a demoted account right back up.
       So the fair share itself follows the learned score: a skipped account is owed less of
       the deck (×0.55), one the user keeps returning to is owed more (up to ×1.3). */
    const creatorShare = new Map();
    if (sig?.affinityOf) {
      for (const user of creatorCount.keys()) {
        const raw = Number(sig.affinityOf(user)) || 0;
        if (!raw) continue;
        creatorMul.set(user, 0.68 + 0.6 * (0.5 + 0.5 * Math.tanh(raw / 3)));
        creatorShare.set(user, Math.min(1.3, Math.max(0.4, 1 + 0.16 * raw)));
      }
    }
    /* The previous deck's opening: those exact posts, and the creators that filled it,
       are pushed back. Nothing is banned — a fresh seed can still deal them, later. */
    /* lastDeck may be the list itself or a zero-arg getter (the catalog exposes a getter so
       the deck is only read when a shuffle actually runs) */
    const lastDeck = typeof sig?.lastDeck === "function" ? sig.lastDeck() : sig?.lastDeck;
    const deckIds = new Set(Array.isArray(lastDeck) ? lastDeck.slice(0, 24) : []);
    const deckCreators = new Map();
    /* If the last deck was full of one creator but the user watched those posts to the end,
       that creator was not crowding anything out — so the penalty is scaled by how much of
       their share was actually skipped (see `deckCreators` use in weight()). */
    const deckHeld = new Map();
    for (const p of items) {
      if (!deckIds.has(p.id)) continue;
      const u = p.author.username;
      deckCreators.set(u, (deckCreators.get(u) || 0) + 1);
      const pull = sig?.attentionOf ? Math.min(1, Math.max(0, Number(sig.attentionOf(p.id)) || 0)) : 0;
      deckHeld.set(u, (deckHeld.get(u) || 0) + pull);
    }
    const sessionSeen = sig?.sessionSeen ? new Set(sig.sessionSeen) : null;
    const weight = (p) => {
      const notes = explain ? [] : null;
      let w = 1;
      if (ctx.isUnavailable?.(p.id)) { w *= 0.05; notes?.push("unavailable ×0.05"); }
      if (!ctx.isSeen(p.id)) { w *= unseenMul; notes?.push(`unseen ×${unseenMul}`); }
      const pr = ctx.progressOf(p); if (pr > 0.03 && pr < 0.97) { w *= 2; notes?.push("in progress ×2"); }
      if (ctx.isStarred(p.id)) { w *= 1.5; notes?.push("starred ×1.5"); }
      const ageDays = Math.max(0, (now - (p.savedAt || 0)) / 864e5);
      const fresh = 1 + 0.8 * Math.max(0, 1 - ageDays / freshWindow);
      if (fresh > 1.05) notes?.push(`fresh save ×${fresh.toFixed(2)}`);
      w *= fresh;
      w *= 1 + 0.15 * Math.log10(1 + (p.metrics.likes || 0));
      w /= 1 + creatorDamp * Math.log10(creatorCount.get(p.author.username) || 1);
      /* dwell: did the post hold attention or get swiped past? */
      if (sig?.attentionOf) {
        const a = Math.min(1, Math.max(0, Number(sig.attentionOf(p.id)) || 0));
        if (a > 0) { const mul = 0.55 + 1.35 * a; w *= mul; notes?.push(`attention ${(a * 100) | 0}% ×${mul.toFixed(2)}`); }
      }
      const skip = sig?.skipRateOf ? Number(sig.skipRateOf(p.id)) || 0 : 0;
      if (skip > 0) {
        const mul = Math.max(0.25, 1 - 1.4 * skip);
        w *= mul; notes?.push(`skipped ${(skip * 100) | 0}% ×${mul.toFixed(2)}`);
      }
      const aff0 = creatorMul.get(p.author.username);
      if (aff0) { const aff = 1 + (aff0 - 1) * affScale; w *= aff; if (Math.abs(aff - 1) > 0.02) notes?.push(`creator affinity ×${aff.toFixed(2)}`); }
      /* Novelty pressure is real, but it must not bury a post that earns attention:
         the demotion fades as the post's attention rises (×0.35 → ×0.85 shown-this-session,
         ×0.30 → ×0.80 last-deck), so a clip watched to the end can still come back while
         the rest of the opening stays out of the way. */
      const dwellPull = sig?.attentionOf ? Math.min(1, Math.max(0, Number(sig.attentionOf(p.id)) || 0)) : 0;
      if (sessionSeen?.has(p.id)) {
        const mul = 0.35 + 0.5 * dwellPull;
        w *= mul; notes?.push(`shown this session ×${mul.toFixed(2)}`);
      }
      if (deckIds.has(p.id)) {
        const mul = 0.3 + 0.5 * dwellPull;
        w *= mul; notes?.push(`opened the last deck ×${mul.toFixed(2)}`);
      }
      const dc = deckCreators.get(p.author.username);
      if (dc) {
        const held = (deckHeld.get(p.author.username) || 0) / dc;      // 0 = all swiped past, 1 = all watched
        const mul = 1 / (1 + 0.45 * dc * (1 - held));
        w *= mul; notes?.push(`filled the last deck ×${mul.toFixed(2)}`);
      }
      if (notes) why.set(p.id, { weight: w, notes });
      return w;
    };
    const keyed = items
      .map((p) => ({ p, k: -Math.log(1 - rnd()) / weight(p) }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.p);
    const kindOf = (p) => {
      if (ctx.kindOf) return ctx.kindOf(p);
      if (!p.media.length) return "text";
      return p.media.some((m) => m.kind === "video") ? "video" : "photo";
    };
    /* "Video" means a playable clip (short or long). Photos, carousels, GIFs and text posts are all non-video. */
    const isVideo = (p) => { const k = kindOf(p); return k === "short" || k === "long" || k === "video"; };
    const imageTotal = items.filter((p) => !isVideo(p)).length;
    const tagOf = (p) => (p.hashtags && p.hashtags.length ? p.hashtags[0] : "");
    /* Lead slot: the first few positions are the ones the user actually judges the deck by.
       A short "best of" block is reserved there from the head of the weighted order, then the
       spread pass runs on what is left — so the top of the deck reads as curated, and the
       rest keeps its rules. Block size scales with the library (never more than the deck). */
    const total = items.length;
    const leadSize = total < 8 ? 0 : Math.min(5, Math.max(2, Math.round(total * 0.02)));
    /* The lead block still respects "no creator twice" when it reasonably can. */
    const out = [], rest = [];
    {
      const leadPool = keyed.slice();
      /* A lead slot is a promise that these are good posts. The weighted draw can put a
         light post first by luck, so a candidate also has to clear a share of the deck's
         heaviest weight — otherwise the slot goes to the best inside the window. */
      let maxWeight = 0;
      for (const p of items) maxWeight = Math.max(maxWeight, weight(p));
      const leadFloor = maxWeight * 0.45;
      const leadUsers = new Set(), leadKinds = [];
      while (out.length < leadSize && leadPool.length) {
        let pick = 0;
        for (let i = 0; i < leadPool.length && i < 16; i++) {
          const c = leadPool[i], u = c.author.username;
          if ((why?.get(c.id)?.weight ?? weight(c)) < leadFloor) continue;
          if (leadUsers.has(u)) continue;
          /* no three of the same kind in the lead: gifs and text posts count as kinds too */
          if (leadKinds.length >= 2 && leadKinds[leadKinds.length - 1] === kindOf(c) && leadKinds[leadKinds.length - 2] === kindOf(c)) continue;
          pick = i; break;
        }
        const [chosen] = leadPool.splice(pick, 1);
        leadUsers.add(chosen.author.username); leadKinds.push(kindOf(chosen));
        out.push(chosen);
        if (explain) why.get(chosen.id).lead = true;
      }
      rest.push(...leadPool);
    }
    const lastCreator = new Map(), lastTag = new Map(), placedCreator = new Map();
    let tailKind = null, tailRun = 0;
    /* seed the spread state from the lead block so its rules carry into the main pass */
    for (let i = 0; i < out.length; i++) {
      const p = out[i];
      lastCreator.set(p.author.username, i);
      placedCreator.set(p.author.username, (placedCreator.get(p.author.username) || 0) + 1);
      if (tagOf(p)) lastTag.set(tagOf(p), i);
      const k = kindOf(p);
      if (k === tailKind) tailRun++; else { tailKind = k; tailRun = 1; }
    }
    let leadVideoRun = 0;
    for (const p of out) leadVideoRun = isVideo(p) ? leadVideoRun + 1 : 0;
    let videoRun = leadVideoRun, imagesPlaced = out.filter((p) => !isVideo(p)).length;
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
      const shareMul = creatorShare.get(c.author.username) || 1;
      const ahead = (placed + 1) / (pos + 1) - ((creatorCount.get(c.author.username) || 0) * shareMul) / total;
      cost += ahead * 30; /* negative when behind fair share: a lagging creator is pulled forward */
      if (tailRun >= RUN && kindOf(c) === tailKind) cost += 4;
      const tag = tagOf(c);
      if (tag) { const dt = pos - (lastTag.get(tag) ?? -Infinity); if (dt <= TAG_SPREAD) cost += TAG_SPREAD + 1 - dt; }
      return cost;
    };
    /* First non-video in the deck (beyond the lookahead window), or -1 when none is left. */
    const firstImage = () => { for (let i = 0; i < rest.length; i++) if (!isVideo(rest[i])) return i; return -1; };
    while (rest.length) {
      /* Cheapest candidate in the lookahead window; ties keep the weighted order.
         Costs can go negative (a creator behind fair share), so the whole window
         is scored — the first zero-cost candidate is not necessarily the best. */
      const imagesLeft = imagesPlaced < imageTotal;
      /* images owed so far at this point of the deck: one is due when this reaches 1, which spreads
         the non-videos evenly over the whole deck instead of bunching them at the start */
      const behind = imageTotal ? (out.length * imageTotal) / total - imagesPlaced : 0;
      const mustImage = imagesLeft && (videoRun >= VIDEO_RUN || behind >= 1);
      /* ahead of the quota: keep the remaining non-videos for later, so the last images still reach the end of the deck */
      const ahead = !mustImage && behind < 0;
      let pick = -1, best = Infinity;
      const lim = Math.min(LOOK, rest.length);
      for (let pass = 0; pass < 2 && pick < 0; pass++) {
        for (let i = 0; i < lim; i++) {
          const c = rest[i];
          if (mustImage && isVideo(c)) continue;
          if (pass === 0 && ahead && !isVideo(c)) continue;   // second pass: nothing else fits, so allow it
          const cost = penalty(c);
          if (cost < best) { best = cost; pick = i; }
        }
      }
      /* The window may hold no non-video while one is owed: take the first non-video in the deck. */
      if (mustImage) {
        const fi = firstImage();
        if (fi >= lim) { const cost = penalty(rest[fi]); if (cost < best) { best = cost; pick = fi; } }
      }
      if (pick < 0) pick = 0;
      const [chosen] = rest.splice(pick, 1);
      if (explain) {
        const e = why.get(chosen.id) || { weight: 1, notes: [] };
        e.lead = false;
        e.broke = [];
        const dc = out.length - (lastCreator.get(chosen.author.username) ?? -Infinity);
        const gap = creatorGap.get(chosen.author.username) || SPREAD + 1;
        if (dc < gap) e.broke.push(`same creator after ${dc} slot${dc === 1 ? "" : "s"}`);
        if (tailRun >= RUN && kindOf(chosen) === tailKind) e.broke.push(`${tailRun} ${tailKind} posts in a row`);
        const tag = tagOf(chosen);
        if (tag && out.length - (lastTag.get(tag) ?? -Infinity) <= TAG_SPREAD) e.broke.push(`#${tag} repeated`);
        why.set(chosen.id, e);
      }
      out.push(chosen);
      lastCreator.set(chosen.author.username, out.length - 1);
      placedCreator.set(chosen.author.username, (placedCreator.get(chosen.author.username) || 0) + 1);
      if (tagOf(chosen)) lastTag.set(tagOf(chosen), out.length - 1);
      const k = kindOf(chosen);
      if (k === tailKind) tailRun++; else { tailKind = k; tailRun = 1; }
      if (isVideo(chosen)) videoRun++; else { videoRun = 0; imagesPlaced++; }
    }
    if (explain) {
      /* the reason table travels beside the deck: one entry per post id */
      Object.defineProperty(out, "explain", { value: why, enumerable: false });
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
    else if (sort === "smart") items = smartShuffle(items, spec.seed, ctx, { explain: !!rawSpec.explain });
    else items.sort(comparator(sort, spec.seed, ctx));
    const total = items.length;
    /* explain mode travels with the result, before the limit trims the array */
    const explain = sort === "smart" && rawSpec.explain ? items.explain || null : null;
    if (spec.limit > 0) items = items.slice(0, spec.limit);
    return { items, total, spec: { ...spec, sort }, explain };
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
