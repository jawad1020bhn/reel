/* core.ranking.recommendations — local-only recommendation primitives for Discover.
   No network, model download, or account data leaves the browser. The profile is
   inferred from this library's recent opens/stars, then combined with content,
   recency, and local engagement signals. */
XR.define("core.ranking.recommendations", ["core.util"], function (util) {
  "use strict";

  const TAGS_PER_POST = 12;
  const MAX_SEED_TAGS = 12;
  const PRIOR_STRENGTH = 120;
  const clamp01 = (n) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);
  const usernameOf = (post) => String(post.author?.username || "");
  const tagsOf = (post) => [...new Set((post.hashtags || [])
    .map((tag) => String(tag || "").replace(/^#/, "").trim().toLowerCase())
    .filter(Boolean))].slice(0, TAGS_PER_POST);
  const orientationOf = (post) => {
    const aspect = post.media?.[0]?.aspect || 1;
    return aspect < 0.8 ? "vertical" : aspect > 1.35 ? "landscape" : "square";
  };
  function formatOf(post, ctx) {
    if (ctx.kindOf) return ctx.kindOf(post);
    if (post.media?.some((m) => m.kind === "gif")) return "gif";
    if (post.media?.some((m) => m.kind !== "photo")) return "short";
    return post.media?.length > 1 ? "carousel" : "photo";
  }
  function normalized(map) {
    let max = 0;
    for (const value of map.values()) max = Math.max(max, value);
    if (!(max > 0)) return new Map();
    return new Map([...map].map(([key, value]) => [key, clamp01(value / max)]));
  }

  /**
   * Build one evidence profile in a single corpus pass. Recent opens and explicit
   * stars seed a TF-IDF interest vector; creator/format preferences are smoothed,
   * and a seed-tag co-occurrence graph uses positive pointwise mutual information
   * (PPMI) to find adjacent topics without treating common tags as discoveries.
   */
  function buildProfile(posts, ctx) {
    const available = (post) => !!post?.media?.length && !ctx.isHidden?.(post.id) && !ctx.isUnavailable?.(post.id);
    const corpus = posts.filter(available);
    const evidence = new Map();
    const addEvidence = (post, weight) => {
      if (!available(post) || !(weight > 0)) return;
      const entry = evidence.get(post.id) || { post, weight: 0 };
      entry.weight = Math.min(4.5, entry.weight + weight);
      evidence.set(post.id, entry);
    };

    const recent = ctx.recentlyOpened ? ctx.recentlyOpened(40) : [];
    recent.forEach((post, index) => addEvidence(post, 1.8 * Math.exp(-index / 12)));
    const starred = corpus.filter((post) => ctx.isStarred?.(post.id))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 60);
    starred.forEach((post, index) => addEvidence(post, 2.2 * Math.exp(-index / 80)));

    const creators = new Map();
    const affinity = ctx.creatorAffinity ? ctx.creatorAffinity() : new Map();
    const affinityEntries = affinity instanceof Map ? affinity.entries() : Object.entries(affinity || {});
    const knownCreators = new Set();
    for (const [username, raw] of affinityEntries) {
      const count = Math.max(0, Number(raw) || 0);
      if (!username || !count) continue;
      knownCreators.add(String(username));
      creators.set(String(username), Math.log1p(count) * 0.7);
    }

    const tags = new Map(), formats = new Map(), orientations = new Map();
    for (const { post, weight } of evidence.values()) {
      const username = usernameOf(post);
      if (username) { knownCreators.add(username); add(creators, username, weight); }
      for (const tag of tagsOf(post)) add(tags, tag, weight);
      add(formats, formatOf(post, ctx), weight);
      add(orientations, orientationOf(post), weight);
    }

    const tagFrequency = new Map(), cooccurrence = new Map();
    const creatorCounts = new Map(), formatCounts = new Map();
    let totalViews = 0, totalEngagement = 0;
    const seedTags = [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_SEED_TAGS).map(([tag]) => tag);
    const seedSet = new Set(seedTags);

    for (const post of corpus) {
      const username = usernameOf(post);
      if (username) add(creatorCounts, username, 1);
      const format = formatOf(post, ctx);
      add(formatCounts, format, 1);
      const postTags = tagsOf(post);
      for (const tag of postTags) add(tagFrequency, tag, 1);
      if (seedSet.size && postTags.length > 1) {
        const presentSeeds = postTags.filter((tag) => seedSet.has(tag));
        for (const seed of presentSeeds) {
          let neighbours = cooccurrence.get(seed);
          if (!neighbours) { neighbours = new Map(); cooccurrence.set(seed, neighbours); }
          for (const tag of postTags) if (tag !== seed) add(neighbours, tag, 1);
        }
      }
      const metrics = post.metrics || {};
      totalViews += Math.max(0, Number(metrics.views) || 0);
      totalEngagement += Math.max(0,
        (Number(metrics.likes) || 0) + 1.5 * (Number(metrics.reposts) || 0) +
        (Number(metrics.replies) || 0) + 0.3 * (Number(metrics.bookmarks) || 0));
    }

    const weightedTags = new Map();
    for (const [tag, weight] of tags) {
      const df = tagFrequency.get(tag) || 0;
      const idf = Math.min(4, 1 + Math.log((corpus.length + 1) / (df + 1)));
      weightedTags.set(tag, weight * idf);
    }
    const tagInterest = normalized(weightedTags);
    const sideTags = new Map();
    for (const [seed, neighbours] of cooccurrence) {
      const dfSeed = tagFrequency.get(seed) || 0;
      const seedInterest = tagInterest.get(seed) || 0;
      for (const [tag, count] of neighbours) {
        if (tagInterest.has(tag)) continue; // keep this rail genuinely adjacent, not a duplicate of For You
        const dfTag = tagFrequency.get(tag) || 0;
        const pmi = Math.max(0, Math.log(((count + 0.5) * (corpus.length + 1)) / ((dfSeed + 0.5) * (dfTag + 0.5))));
        const confidence = count / (count + 2); // shrink one-off co-occurrences
        add(sideTags, tag, Math.min(4, pmi) * confidence * seedInterest);
      }
    }

    const priorRate = totalViews > 0
      ? Math.max(0.002, Math.min(0.25, (totalEngagement + 1) / (totalViews + PRIOR_STRENGTH)))
      : 0.02;
    return {
      corpusCount: corpus.length, sourceCount: evidence.size,
      creators: normalized(creators), knownCreators,
      tags: tagInterest, sideTags: normalized(sideTags),
      formats: normalized(formats), orientations: normalized(orientations),
      creatorCounts, formatCounts, priorRate,
      hasHistory: evidence.size > 0 || creators.size > 0,
    };
  }

  /** Content affinity combines TF-IDF tags with creator, format and frame preferences. */
  function fit(post, profile, ctx) {
    const postTags = tagsOf(post);
    let maxTag = 0, sumTag = 0;
    for (const tag of postTags) {
      const value = profile.tags.get(tag) || 0;
      maxTag = Math.max(maxTag, value);
      sumTag += value;
    }
    const tagFit = postTags.length ? 0.72 * maxTag + 0.28 * sumTag / postTags.length : 0;
    const creatorFit = profile.creators.get(usernameOf(post)) || 0;
    const formatFit = profile.formats.get(formatOf(post, ctx)) || 0;
    const frameFit = profile.orientations.get(orientationOf(post)) || 0;
    return clamp01(0.56 * tagFit + 0.25 * creatorFit + 0.13 * formatFit + 0.06 * frameFit);
  }

  /** PPMI-derived affinity to topics adjacent to, but not already in, the profile. */
  function sideFit(post, profile) {
    const postTags = tagsOf(post);
    let max = 0, sum = 0;
    for (const tag of postTags) {
      const value = profile.sideTags.get(tag) || 0;
      max = Math.max(max, value);
      sum += value;
    }
    return clamp01(postTags.length ? 0.72 * max + 0.28 * sum / postTags.length : 0);
  }

  function freshness(post, now, halfLifeDays = 90) {
    const savedAt = Number(post.savedAt) || Number(post.createdAt) || now;
    const ageDays = Math.max(0, (now - savedAt) / 864e5);
    return Math.exp(-Math.LN2 * ageDays / Math.max(1, halfLifeDays));
  }

  /** Empirical-Bayes engagement estimate; low-view posts shrink toward the archive rate. */
  function quality(post, profile) {
    const metrics = post.metrics || {};
    const likes = Math.max(0, Number(metrics.likes) || 0);
    const reposts = Math.max(0, Number(metrics.reposts) || 0);
    const replies = Math.max(0, Number(metrics.replies) || 0);
    const bookmarks = Math.max(0, Number(metrics.bookmarks) || 0);
    const views = Math.max(0, Number(metrics.views) || 0);
    const engagement = likes + 1.5 * reposts + replies + 0.3 * bookmarks;
    const posterior = (engagement + profile.priorRate * PRIOR_STRENGTH) / (views + PRIOR_STRENGTH);
    const lift = posterior / Math.max(0.001, profile.priorRate);
    const credibility = views / (views + PRIOR_STRENGTH);
    const relative = clamp01(Math.log1p(lift) / Math.log(8));
    const magnitude = clamp01(Math.log1p(engagement) / Math.log1p(5000));
    return clamp01(0.62 * relative * (0.5 + 0.5 * credibility) + 0.28 * magnitude + 0.10 * credibility);
  }

  function novelty(post, profile) {
    return clamp01(1 - 0.65 * (profile.creators.get(usernameOf(post)) || 0));
  }

  /** Seeded, small tie noise keeps equally scored items rotating without overriding relevance. */
  function scorePosts(posts, scoreOf, seed = 1) {
    const rnd = util.seededRandom(seed || 1);
    return posts.map((post) => ({ post, score: clamp01(Number(scoreOf(post)) || 0) + rnd() * 0.003 }))
      .sort((a, b) => b.score - a.score || String(a.post.id).localeCompare(String(b.post.id)));
  }

  /** Maximal marginal relevance (MMR): retain relevance while spreading creators, tags and formats. */
  function diversify(scored, limit, ctx, strength = 0.18) {
    const take = Math.max(0, Math.floor(limit) || 0);
    if (!take) return [];
    const shortlist = scored.slice(0, Math.min(scored.length, Math.max(64, take * 8))).map((entry) => ({
      ...entry,
      username: usernameOf(entry.post),
      tags: new Set(tagsOf(entry.post)),
      format: formatOf(entry.post, ctx),
    }));
    const chosen = [];
    while (chosen.length < take && shortlist.length) {
      let bestIndex = 0, bestScore = -Infinity;
      for (let i = 0; i < shortlist.length; i++) {
        const candidate = shortlist[i];
        let redundancy = 0;
        for (const previous of chosen) {
          let overlap = 0;
          for (const tag of candidate.tags) if (previous.tags.has(tag)) overlap++;
          const union = candidate.tags.size + previous.tags.size - overlap;
          const tagOverlap = union ? overlap / union : 0;
          const sameCreator = candidate.username && candidate.username === previous.username;
          const sameFormat = candidate.format === previous.format;
          redundancy = Math.max(redundancy, sameCreator ? 1 : 0, tagOverlap * 0.76 + (sameFormat ? 0.14 : 0));
        }
        const adjusted = candidate.score - strength * redundancy;
        if (adjusted > bestScore) { bestScore = adjusted; bestIndex = i; }
      }
      chosen.push(shortlist.splice(bestIndex, 1)[0]);
    }
    return chosen;
  }

  /** 0/1 knapsack for a bounded watch session; durations are rounded up to the step. */
  function budgetedSelection(scored, { seconds = 300, maxItems = 24, step = 5, durationOf } = {}) {
    const itemCap = Math.max(0, Math.floor(maxItems) || 0);
    const unitsCap = Math.floor(Math.max(0, seconds) / Math.max(1, step));
    if (!itemCap || !unitsCap || typeof durationOf !== "function") return [];
    const candidates = scored.slice(0, Math.min(scored.length, Math.max(72, itemCap * 6)));
    const dp = Array.from({ length: itemCap + 1 }, () => Array(unitsCap + 1).fill(null));
    dp[0][0] = { score: 0, items: [] };

    for (const entry of candidates) {
      const duration = Number(durationOf(entry.post)) || 0;
      if (!(duration > 0) || duration > seconds) continue;
      const cost = Math.max(1, Math.ceil(duration / Math.max(1, step)));
      if (cost > unitsCap) continue;
      for (let count = itemCap - 1; count >= 0; count--) {
        for (let used = unitsCap - cost; used >= 0; used--) {
          const current = dp[count][used];
          if (!current) continue;
          const nextUnits = used + cost;
          const nextScore = current.score + entry.score;
          const previous = dp[count + 1][nextUnits];
          if (!previous || nextScore > previous.score) {
            dp[count + 1][nextUnits] = { score: nextScore, items: [...current.items, entry] };
          }
        }
      }
    }

    let best = null;
    for (let count = 1; count <= itemCap; count++) for (const entry of dp[count]) {
      if (entry && (!best || entry.score > best.score || (entry.score === best.score && entry.items.length > best.items.length))) best = entry;
    }
    return best?.items || [];
  }

  return { buildProfile, fit, sideFit, freshness, quality, novelty, scorePosts, diversify, budgetedSelection, formatOf, tagsOf };
});
