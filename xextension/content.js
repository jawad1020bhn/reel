const STATE_KEY = "xCaptureState";
const DEAD_KEY = "xDeadLetters";
const SESSION_KEY = "xCaptureSession";
const NORMALIZER_VERSION = "2026-10-19.1";
const SOURCE_TYPE = "graphql-bookmarks";
const pendingBeforeCapture = new Map();
const PENDING_CACHE_LIMIT = 5000;
const pendingBeforeCaptureStats = { timelineResponses: 0, pagesWithTweets: 0, emptyResponses: 0, schemaMismatchResponses: 0, observedOccurrences: 0, duplicateOccurrences: 0, dropped: 0 };

const config = {
  // Adaptive fast-lane scrolling: short RAF-friendly steps through rendered
  // content, then a slower approach around the pagination sentinel.
  fastStepDelayMs: 42,
  nearBottomStepDelayMs: 95,
  fastStepViewports: 1.2,
  nearBottomStepViewports: 0.58,
  responseWaitMs: 1450,
  maxScrollStepsPerPass: 800,
  maxPassDurationMs: 20000,
  maxScrollBatches: 5000,
  emptyScrollStop: 4,
  maxRuntimeMs: 2 * 60 * 60 * 1000,
  batchSize: 200,
  maxConsecutiveErrors: 3,
  backoffBaseMs: 5000,
  maxBackoffMs: 5 * 60 * 1000,
  maxBackoffRetries: 10,
  sessionPersistMs: 30000,
};

/**
 * @typedef {Object} TweetLegacy
 * @property {string} [full_text]
 * @property {string} [text]
 * @property {string} [created_at]
 * @property {number} [favorite_count]
 * @property {number} [retweet_count]
 * @property {number} [reply_count]
 * @property {string} [conversation_id_str]
 * @property {string} [in_reply_to_status_id_str]
 * @property {string} [in_reply_to_user_id_str]
 * @property {string} [quoted_status_id_str]
 * @property {Object} [retweeted_status_result]
 * @property {Object} [quoted_status_result]
 * @property {Object} [entities]
 * @property {Object} [extended_entities]
 * @property {number} [bookmark_count]
 * @property {string} [id_str]
 * @property {string} [user_id_str]
 * @property {string} [display_text_range]
 * @property {string} [lang]
 * @property {string} [source]
 */

/**
 * @typedef {Object} TweetCore
 * @property {Object} [user_results]
 */

/**
 * @typedef {Object} TweetViews
 * @property {number|string} count
 */

/**
 * @typedef {Object} TweetNoteTweet
 * @property {Object} [note_tweet_results]
 */

/**
 * @typedef {Object} Tweet
 * @property {string} rest_id
 * @property {"Tweet"|"TweetWithVisibilityResults"} __typename
 * @property {TweetCore} [core]
 * @property {TweetLegacy} [legacy]
 * @property {TweetViews} [views]
 * @property {TweetNoteTweet} [note_tweet]
 * @property {Object} [tweet]  // For TweetWithVisibilityResults wrapper
 */

/**
 * @typedef {Object} MediaEntity
 * @property {string} type
 * @property {string} [media_url_https]
 * @property {string} [media_url]
 * @property {Object} [sizes]
 * @property {Object} [original_info]
 * @property {Object} [video_info]
 * @property {string} [ext_alt_text]
 * @property {string} [alt_text]
 */

/**
 * @typedef {Object} UserResult
 * @property {string} [rest_id]
 * @property {string} [id_str]
 * @property {Object} [legacy]
 * @property {Object} [core]
 * @property {Object} [avatar]
 * @property {string} [profile_image]
 */

/**
 * @typedef {Object} NormalizedTweet
 * @property {string} tweet_id
 * @property {"available"|"unavailable"} state
 * @property {string} text
 * @property {"tweet"|"retweet"|"quote"|"reply"} type
 * @property {string} [author_id]
 * @property {string} [author_username]
 * @property {string} [author_username_at_capture]
 * @property {string} [author_name]
 * @property {string} [author_name_at_capture]
 * @property {string} [author_profile_image_url]
 * @property {string} [tweet_created_at]
 * @property {string} tweet_url
 * @property {string} canonical_url
 * @property {string} url
 * @property {number} like_count_at_capture
 * @property {number} retweet_count_at_capture
 * @property {number} reply_count_at_capture
 * @property {number} view_count_at_capture
 * @property {boolean} has_media
 * @property {boolean} has_links
 * @property {string[]} media_types
 * @property {Object[]} media_items
 * @property {string[]} urls_expanded
 * @property {string} [conversation_id]
 * @property {string} [in_reply_to_status_id]
 * @property {string} [in_reply_to_user_id]
 * @property {string} [original_tweet_id]
 * @property {string} [retweeted_by_username]
 * @property {string} [quoted_tweet_id]
 * @property {Object} [quoted_tweet]
 * @property {string} first_seen_at
 * @property {string} last_seen_at
 * @property {number} capture_order
 * @property {string} source_of_order
 * @property {string} normalizer_version
 * @property {string} captured_at
 * @property {string} source_type
 * @property {Tweet} raw
 */

/**
 * @typedef {Object} CaptureRun
 * @property {boolean} stop
 * @property {boolean} pause
 * @property {number} startedAt
 * @property {number} scrollBatches
 * @property {number} stableEmpty
 * @property {number} knownOnlyPages
 * @property {number} seenResponses
 * @property {number} seenTweets
 * @property {string} [lastTweetId]
 * @property {Map<string, NormalizedTweet>} buffer
 * @property {Object} breaker
 * @property {string} [reason]
 * @property {Object} backoff
 */

/**
 * @typedef {Object} CaptureSession
 * @property {number} startedAt
 * @property {number} scrollBatches
 * @property {number} stableEmpty
 * @property {number} knownOnlyPages
 * @property {number} seenResponses
 * @property {number} seenTweets
 * @property {string} [lastTweetId]
 * @property {Array<[string, NormalizedTweet]>} buffer
 * @property {Object} breaker
 * @property {string} [reason]
 * @property {Object} backoff
 * @property {boolean} paused
 * @property {boolean} stopped
 * @property {number} savedAt
 */

/**
 * @typedef {Object} CaptureState
 * @property {string} status
 * @property {string} [startedAt]
 * @property {string} [lastTweetId]
 * @property {string} [lastStopReason]
 * @property {string} [updatedAt]
 * @property {Object} stats
 */

let capture = null;
let queue = Promise.resolve();
let stateWriteQueue = Promise.resolve();

function wakeRun(run) {
  if (!run?.waiters) return;
  for (const wake of [...run.waiters]) wake();
}

function waitRun(run, ms) {
  if (!run || run.stop || run.pause || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.waiters?.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (!run.waiters) run.waiters = new Set();
    run.waiters.add(finish);
  });
}

const enqueue = (fn) => {
  queue = queue.then(fn).catch((error) => {
    console.error("[x-bookmarks] response queue failed", error);
  });
  return queue;
};

async function getState() {
  const d = await chrome.storage.local.get(STATE_KEY);
  return (
    d[STATE_KEY] || {
      status: "idle",
      startedAt: null,
      lastTweetId: null,
      lastStopReason: null,
      updatedAt: null,
      stats: {
        captured: 0,
        newItems: 0,
        duplicates: 0,
        failed: 0,
        emptyScrolls: 0,
        emptyResponses: 0,
        errors: 0,
        rateLimits: 0,
        authErrors: 0,
        responses: 0,
        timelineResponses: 0,
        pagesWithTweets: 0,
        scrollBatches: 0,
        postsPerMin: 0,
        maxScrollBatches: config.maxScrollBatches,
        mediaItems: 0,
        videos: 0
      },
      audit: null
    }
  );
}

function setState(patch) {
  const write = stateWriteQueue.then(async () => {
    const s = await getState();
    const resolved = typeof patch === "function" ? patch(s) : patch;
    const next = {
      ...s,
      ...resolved,
      stats: { ...(s.stats || {}), ...(resolved?.stats || {}) },
      updatedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [STATE_KEY]: next });
    chrome.runtime.sendMessage({ type: "state", state: next }).catch(() => {});
    return next;
  });
  stateWriteQueue = write.catch((error) => {
    console.warn("[x-bookmarks] state write failed", error);
  });
  return write;
}

/* Session persistence: durable chunks are already flushed independently; the
   session only needs the in-flight batch and traversal/audit counters. */
async function saveSession(run) {
  if (!run) {
    await chrome.storage.local.remove(SESSION_KEY);
    return;
  }
  const session = {
    startedAt: run.startedAt,
    scrollBatches: run.scrollBatches,
    stableEmpty: run.stableEmpty,
    timelineResponses: run.timelineResponses,
    pagesWithTweets: run.pagesWithTweets,
    emptyResponses: run.emptyResponses,
    schemaMismatchResponses: run.schemaMismatchResponses,
    seenTweets: run.seenTweets,
    normalizationFailures: run.normalizationFailures,
    preCaptureDropped: run.preCaptureDropped,
    observedOccurrences: run.observedOccurrences,
    observedIds: [...run.observedIds],
    failedIds: [...run.failedIds],
    duplicateOccurrences: run.duplicateOccurrences,
    cursorValues: [...run.cursorValues],
    cursorAdvances: run.cursorAdvances,
    repeatedCursors: run.repeatedCursors,
    bottomCursorSeen: run.bottomCursorSeen,
    lastBottomCursor: run.lastBottomCursor,
    lastTweetId: run.lastTweetId,
    newTotal: run.newTotal,
    duplicateTotal: run.duplicateTotal,
    failedTotal: run.failedTotal,
    buffer: Array.from(run.buffer.entries()),
    breaker: run.breaker,
    reason: run.reason,
    backoff: run.backoff,
    paused: run.pause,
    stopped: run.stop,
    savedAt: Date.now(),
  };
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

async function loadSession() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  return data[SESSION_KEY] || null;
}

async function clearSession() {
  await chrome.storage.local.remove(SESSION_KEY);
}

function createRun(store, saved = {}) {
  return {
    store,
    stop: false,
    pause: false,
    panic: false,
    startedAt: saved.startedAt || Date.now(),
    scrollBatches: Number(saved.scrollBatches) || 0,
    stableEmpty: Number(saved.stableEmpty) || 0,
    timelineResponses: Number(saved.timelineResponses) || 0,
    pagesWithTweets: Number(saved.pagesWithTweets) || 0,
    emptyResponses: Number(saved.emptyResponses) || 0,
    schemaMismatchResponses: Number(saved.schemaMismatchResponses) || 0,
    seenTweets: Number(saved.seenTweets) || 0,
    normalizationFailures: Number(saved.normalizationFailures) || 0,
    observedOccurrences: Number(saved.observedOccurrences) || 0,
    observedIds: new Set(saved.observedIds || []),
    failedIds: new Set(saved.failedIds || []),
    duplicateOccurrences: Number(saved.duplicateOccurrences) || 0,
    cursorValues: new Set(saved.cursorValues || []),
    cursorAdvances: Number(saved.cursorAdvances) || 0,
    repeatedCursors: Number(saved.repeatedCursors) || 0,
    bottomCursorSeen: !!saved.bottomCursorSeen,
    lastBottomCursor: saved.lastBottomCursor || "",
    lastTweetId: saved.lastTweetId || null,
    newTotal: Number(saved.newTotal) || 0,
    duplicateTotal: Number(saved.duplicateTotal) || 0,
    failedTotal: Number(saved.failedTotal) || 0,
    buffer: new Map(saved.buffer || []),
    breaker: saved.breaker || { consecutiveErrors: 0, tripped: false, reason: null },
    reason: saved.reason || null,
    backoff: saved.backoff || { retries: 0, until: 0 },
    activityVersion: 0,
    waiters: new Set(),
    lastFlushAt: Date.now(),
    postsPerMin: 0,
    preCaptureDropped: Number(saved.preCaptureDropped) || 0,
    primeAtTop: false,
    loopPromise: null,
  };
}

function launchCaptureLoop(run) {
  if (run.loopPromise) return run.loopPromise;
  const persistTimer = setInterval(() => {
    if (capture !== run || run.stop || run.pause) return;
    saveSession(run).catch((error) => console.warn("[x-bookmarks] session save failed", error));
  }, config.sessionPersistMs);

  run.loopPromise = runCaptureLoop(run)
    .catch(async (error) => {
      console.error("[x-bookmarks] capture loop failed", error);
      run.reason = run.reason || "capture-error";
      run.breaker.tripped = true;
      run.breaker.reason = run.breaker.reason || run.reason;
      try {
        await queue;
        if (!run.panic) await flushBuffer(run);
      } catch { /* keep the recoverable in-flight batch in the session */ }
      try { await setState({ status: "stopped_by_error", lastStopReason: run.reason }); }
      catch { /* local state may be unavailable too; retain the session if possible */ }
      if (capture === run) capture = null;
      saveSession(run).catch(() => {});
    })
    .finally(() => {
      clearInterval(persistTimer);
      run.loopPromise = null;
    });
  return run.loopPromise;
}

async function resumeFromSession(session) {
  if (!session) return null;
  if (Date.now() - Number(session.savedAt || 0) > config.maxRuntimeMs) {
    await clearSession();
    return null;
  }
  const store = await XBookmarkStore.open();
  const run = createRun(store, session);
  // Storage failures are recoverable: after the user frees space or reloads,
  // retry the in-flight batch instead of restoring a permanently tripped breaker.
  if (["storage-error", "capture-error"].includes(run.reason) || ["storage-error", "capture-error"].includes(run.breaker.reason)) {
    run.reason = null;
    run.breaker.tripped = false;
    run.breaker.reason = null;
  }
  // Commit an in-flight batch immediately on resume instead of rescanning for
  // a while with recovery data still only in the session record.
  await flushBuffer(run);
  // Reaching this path means the user pressed Start/Resume in the popup.
  run.pause = false;
  capture = run;
  await setState({ status: "capturing", lastStopReason: null, audit: null });
  launchCaptureLoop(run);
  return { ok: true, resumed: true };
}

function resolveUser(userResult) {
  if (!userResult || typeof userResult !== "object") {
    return { id: null, screen_name: null, name: null, profile_image_url_https: null };
  }
  const legacy = userResult.legacy || {};
  const core = userResult.core || {};
  return {
    id: userResult.rest_id || userResult.id_str || null,
    screen_name: legacy.screen_name || core.screen_name || null,
    name: legacy.name || core.name || null,
    profile_image_url_https:
      legacy.profile_image_url_https ||
      (userResult.avatar && userResult.avatar.image_url) ||
      (typeof userResult.profile_image === "string" ? userResult.profile_image : null) ||
      null
  };
}

/**
 * Normalise X's media payload into the shape the dashboard plays back.
 *
 * The dashboard is a media browser first, so this is the most load-bearing
 * function in the scraper. Three things it must get right, each of which was
 * previously lost:
 *
 *  1. EVERY mp4 variant, not just the best one. X publishes the same video at
 *     three or four bitrates (typically 320p / 480p / 720p / 1080p). Keeping
 *     the whole ladder lets the player choose by rendered size — a 180px-wide
 *     tile in a carousel has no business downloading a 1080p file, and a
 *     full-screen viewer should not be stuck with the 320p one. Only the
 *     winner was kept before, so it was always one or the other.
 *  2. A real poster. For a video, `media_url_https` IS the still frame, but
 *     naming it `url` and nothing else meant every consumer had to know that.
 *     It is emitted as `poster` too, explicitly.
 *
 * `mp4` (the best variant) is still emitted unchanged: it is what every
 * existing consumer and test reads.
 */
function buildMediaItems(media) {
  return (Array.isArray(media) ? media : [])
    .filter((m) => m && typeof m === "object")
    .map((m, index) => {
      const info = m.original_info || {};
      const size = (m.sizes && (m.sizes.large || m.sizes.medium)) || {};
      const width = Number(info.width) || Number(size.w) || 0;
      const height = Number(info.height) || Number(size.h) || 0;
      const ratio = m.video_info && Array.isArray(m.video_info.aspect_ratio)
        ? m.video_info.aspect_ratio[0] / m.video_info.aspect_ratio[1]
        : width && height ? width / height : 0;

      const variants = (m.video_info && m.video_info.variants) || [];

      /* The full ladder, best first. `bitrate` is the only quality signal X
         gives; the resolution is in the URL path but is not machine-readable
         in any documented way, so bitrate ordering is what we can trust. */
      const mp4Variants = variants
        .filter((v) => v && v.content_type === "video/mp4" && v.url)
        .map((v) => ({ url: v.url, bitrate: Number(v.bitrate) || 0 }))
        .sort((a, b) => b.bitrate - a.bitrate);

      const hls = variants.find((v) => v.content_type === "application/x-mpegURL" && v.url);
      const still = m.media_url_https || m.media_url || null;

      return {
        type: m.type || "photo",
        url: still,
        // For photos the still *is* the media; for video it is the poster
        // frame. Saying so removes a guess from every consumer downstream.
        poster: still,
        width, height,
        aspect: Number.isFinite(ratio) && ratio > 0 ? ratio : 0,
        mp4: (mp4Variants[0] && mp4Variants[0].url) || null,
        mp4_variants: mp4Variants,
        hls: (hls && hls.url) || null,
        duration: (m.video_info && Number(m.video_info.duration_millis)) || 0,
        alt: m.ext_alt_text || m.alt_text || null,
        // Media order inside a post is meaningful (a thread's screenshots are
        // sequential) and is lost the moment anything re-sorts the array.
        position: index + 1
      };
    });
}

function normalizeTweet(tweet) {
  const now = new Date().toISOString();
  const tweetId = tweet.rest_id;

  const userResult = tweet.core && tweet.core.user_results && tweet.core.user_results.result;
  const user = resolveUser(userResult);
  const authorId = user.id;
  const outerUsername = user.screen_name;

  const legacy = tweet.legacy || {};
  const type =
    legacy.retweeted_status_result
      ? "retweet"
      : legacy.quoted_status_id_str
      ? "quote"
      : legacy.in_reply_to_status_id_str
      ? "reply"
      : "tweet";

  // For retweets, prefer the original tweet's content for display/search.
  let display = { legacy, user, authorId, type };
  let originalTweetId = null;
  let retweetedBy = null;
  let quoted = null;

  if (type === "retweet" && legacy.retweeted_status_result) {
    const orig = legacy.retweeted_status_result.result;
    if (orig && orig.__typename === "Tweet") {
      const origUserResult = orig.core && orig.core.user_results && orig.core.user_results.result;
      const origUser = resolveUser(origUserResult);
      display = {
        legacy: orig.legacy || {},
        user: origUser,
        authorId: origUser.id
      };
      originalTweetId = orig.rest_id;
      retweetedBy = user.name || user.screen_name || null;
    }
  }

  if (type === "quote") {
    const quotedResult = legacy.quoted_status_result && legacy.quoted_status_result.result;
    const quotedLegacy = quotedResult && quotedResult.legacy;
    const quotedUserResult = quotedResult && quotedResult.core && quotedResult.core.user_results && quotedResult.core.user_results.result;
    const quotedUser = resolveUser(quotedUserResult);
    const quotedId = legacy.quoted_status_id_str || (quotedResult && quotedResult.rest_id) || null;
    if (quotedId) {
      quoted = {
        tweet_id: quotedId,
        text: (quotedLegacy && quotedLegacy.full_text) || "",
        author_username: quotedUser.screen_name || null,
        author_name: quotedUser.name || null,
        author_id: quotedUser.id,
        tweet_created_at: (quotedLegacy && quotedLegacy.created_at) || null,
        url: quotedUser.screen_name
          ? `https://x.com/${quotedUser.screen_name}/status/${quotedId}`
          : `https://x.com/i/status/${quotedId}`
      };
    }
  }

  const l = display.legacy;
  const u = display.user;
  const username = u.screen_name || null;

  // Prefer note_tweet for long tweets (over 280 chars)
  const noteTweet = tweet.note_tweet;
  const noteTweetText = noteTweet && noteTweet.note_tweet_results && noteTweet.note_tweet_results.result && noteTweet.note_tweet_results.result.text;
  const fullText = noteTweetText || l.full_text || l.text || "";

  const media =
    l.extended_entities && l.extended_entities.media
      ? l.extended_entities.media
      : l.entities && l.entities.media
      ? l.entities.media
      : [];

  const urls = (l.entities && l.entities.urls) || [];
  const urlsExpanded = urls
    .map((x) => x.expanded_url || x.url || x.display_url)
    .filter(Boolean);

  const views = tweet.views && typeof tweet.views.count === "number" ? tweet.views.count : 0;

  const base = {
    tweet_id: String(tweetId || ""),
    state: "available",
    text: fullText,
    type,
    author_id: display.authorId || null,
    author_username: username,
    author_username_at_capture: username,
    author_name: u.name || null,
    author_name_at_capture: u.name || null,
    author_profile_image_url: u.profile_image_url_https || null,
    tweet_created_at: l.created_at || null,
    tweet_url: username
      ? `https://x.com/${username}/status/${tweetId}`
      : `https://x.com/i/status/${tweetId}`,
    canonical_url: username
      ? `https://x.com/${username}/status/${tweetId}`
      : `https://x.com/i/status/${tweetId}`,
    url: username
      ? `https://x.com/${username}/status/${tweetId}`
      : `https://x.com/i/status/${tweetId}`,
    like_count_at_capture: l.favorite_count ?? 0,
    retweet_count_at_capture: l.retweet_count ?? 0,
    reply_count_at_capture: l.reply_count ?? 0,
    view_count_at_capture: views,
    has_media: media.length > 0,
    has_links: urls.length > 0,
    media_types: media.map((m) => m.type),
    media_items: buildMediaItems(media),
    urls_expanded: urlsExpanded,
    conversation_id: l.conversation_id_str || null,
    in_reply_to_status_id: l.in_reply_to_status_id_str || null,
    in_reply_to_user_id: l.in_reply_to_user_id_str || null,
    original_tweet_id: originalTweetId,
    retweeted_by_username: retweetedBy,
    quoted_tweet_id: quoted ? quoted.tweet_id : null,
    quoted_tweet: quoted,
    first_seen_at: now,
    last_seen_at: now,
    capture_order: 0,
    source_of_order: "feed-order",
    normalizer_version: NORMALIZER_VERSION,
    captured_at: now,
    source_type: SOURCE_TYPE,
    // Keep only the legacy metadata XReels reads from `raw`; retaining the full
    // GraphQL tweet duplicates every video variant and can bloat exports 5–10×.
    raw: {
      legacy: {
        created_at: l.created_at || null,
        lang: l.lang || null,
        possibly_sensitive: !!l.possibly_sensitive,
        bookmark_count: Number(l.bookmark_count) || 0
      },
      views: { count: views }
    }
  };

  // Unavailable / deleted tweets: keep identity, no content.
  if (!l.full_text && !l.text && !Object.keys(l).length) {
    base.state = "unavailable";
    base.text = "";
  }

  return base;
}

function validateItem(n) {
  const errors = [];
  if (!n.tweet_id || typeof n.tweet_id !== "string") errors.push("tweet_id missing/not string");
  for (const k of ["like_count_at_capture", "retweet_count_at_capture", "reply_count_at_capture", "view_count_at_capture"]) {
    if (!Number.isFinite(n[k]) || n[k] < 0) errors.push(`${k} not a non-negative number`);
  }
  if (n.url && !/^https?:\/\//.test(n.url)) errors.push("url not http(s)");
  return { valid: errors.length === 0, errors };
}

async function addDeadLetter(raw, error) {
  const data = await chrome.storage.local.get(DEAD_KEY);
  const list = Array.isArray(data[DEAD_KEY]) ? data[DEAD_KEY] : [];
  const legacy = raw?.legacy || {};
  list.push({
    tweet_id: String(raw?.rest_id || "") || null,
    error: String((error && error.message) || error),
    raw: raw ? {
      typename: raw.__typename || null,
      rest_id: raw.rest_id || null,
      created_at: legacy.created_at || null,
      lang: legacy.lang || null,
      text_length: String(legacy.full_text || legacy.text || "").length,
    } : null,
    at: new Date().toISOString(),
    normalizer_version: NORMALIZER_VERSION,
  });
  if (list.length > 500) list.splice(0, list.length - 500);
  await chrome.storage.local.set({ [DEAD_KEY]: list });
}

async function bumpError(reason, status) {
  if (!capture) return;
  /* The error/rate-limit/auth counters are CUMULATIVE across a run. Each patch
     below increments the stored value; passing a literal `1` would overwrite
     the total and every later read would report "1" forever. */
  const inc = {};
  if (reason === "rate-limited") inc.rateLimits = 1;
  else if (reason === "auth-error") inc.authErrors = 1;
  else inc.errors = 1;
  /* A response that wasn't usable JSON is also an "empty" response for the
     end-of-feed heuristics and the diagnostics panel. */
  if (reason === "bad-response" || reason === "non-json") inc.emptyResponses = 1;
  await setState((state) => {
    const stats = {};
    for (const [key, value] of Object.entries(inc)) {
      stats[key] = (Number(state.stats?.[key]) || 0) + value;
    }
    return { stats };
  });

  /* For rate limits and server errors, apply exponential backoff instead of
     stopping immediately. Auth errors still stop the run. */
  if (reason === "rate-limited" || reason === "server-error") {
    await applyBackoff(status);
    return;
  }
  if (reason === "auth-error") {
    capture.breaker.tripped = true;
    capture.breaker.reason = reason;
    capture.stop = true;
    wakeRun(capture);
    await setState({ status: "stopped_by_error", lastStopReason: reason });
    return;
  }
  capture.breaker.consecutiveErrors++;
  if (capture.breaker.consecutiveErrors >= config.maxConsecutiveErrors) {
    capture.breaker.tripped = true;
    capture.breaker.reason = "too-many-errors";
    capture.stop = true;
    wakeRun(capture);
    await setState({ status: "stopped_by_error", lastStopReason: "too-many-errors" });
  }
}

function projectedStoreStats(run) {
  let count = run.store.total;
  let mediaItems = run.store.mediaItems;
  let videos = run.store.videos;
  for (const [id, item] of run.buffer) {
    const existing = run.store.get(id);
    const media = Array.isArray(item.media_items) ? item.media_items : [];
    const itemVideos = media.reduce((n, mediaItem) => n + (mediaItem && (mediaItem.type === "video" || mediaItem.type === "animated_gif") ? 1 : 0), 0);
    if (existing) {
      const oldMedia = Array.isArray(existing.media_items) ? existing.media_items : [];
      const oldVideos = oldMedia.reduce((n, mediaItem) => n + (mediaItem && (mediaItem.type === "video" || mediaItem.type === "animated_gif") ? 1 : 0), 0);
      mediaItems += media.length - oldMedia.length;
      videos += itemVideos - oldVideos;
    } else {
      count++;
      mediaItems += media.length;
      videos += itemVideos;
    }
  }
  return { count, mediaItems, videos };
}

async function flushBuffer(run = capture) {
  if (!run || run.panic || (!run.buffer.size && !run.store.needsFlush)) return;
  try {
    for (const item of run.buffer.values()) run.store.upsert(item);
    await run.store.flush();
    run.buffer.clear();
    run.lastFlushAt = Date.now();
    const stats = projectedStoreStats(run);
    await setState({
      lastTweetId: run.lastTweetId || null,
      stats: {
        captured: run.store.total,
        mediaItems: run.store.mediaItems,
        videos: run.store.videos,
        newItems: run.newTotal,
        duplicates: run.duplicateTotal,
        failed: run.failedTotal,
      },
    });
    return stats;
  } catch (error) {
    run.reason = "storage-error";
    run.breaker.tripped = true;
    run.breaker.reason = "storage-error";
    run.stop = true;
    wakeRun(run);
    saveSession(run).catch(() => {});
    await setState({ status: "stopped_by_error", lastStopReason: "storage-error" });
    throw error;
  }
}

async function waitForBackoff(run) {
  while (!run.stop && !run.pause && run.backoff.until && Date.now() < run.backoff.until) {
    const remaining = run.backoff.until - Date.now();
    await waitRun(run, Math.min(remaining, 1000));
  }
  if (!run.stop && !run.pause && run.backoff.until) {
    run.backoff.until = 0;
    await setState({ status: "capturing", lastStopReason: null });
  }
}

function recordCursors(run, page) {
  for (const cursor of page.cursors || []) {
    if (!/bottom/i.test(cursor.type)) continue;
    run.bottomCursorSeen = true;
    const value = String(cursor.value || "");
    if (!value) continue;
    if (run.cursorValues.has(value)) run.repeatedCursors++;
    else {
      if (run.lastBottomCursor && run.lastBottomCursor !== value) run.cursorAdvances++;
      run.cursorValues.add(value);
    }
    run.lastBottomCursor = value;
  }
}

async function cacheBeforeCapture(page) {
  pendingBeforeCaptureStats.timelineResponses++;
  if (page.tweets.length) pendingBeforeCaptureStats.pagesWithTweets++;
  else pendingBeforeCaptureStats.emptyResponses++;
  if (page.entryCount > 0 && !page.tweets.length && !page.cursors.length) {
    pendingBeforeCaptureStats.schemaMismatchResponses++;
  }
  pendingBeforeCaptureStats.observedOccurrences += page.tweets.length;
  for (const tweet of page.tweets) {
    const id = String(tweet?.rest_id || "");
    if (!id) continue;
    if (pendingBeforeCapture.has(id)) {
      pendingBeforeCaptureStats.duplicateOccurrences++;
      pendingBeforeCapture.delete(id);
    }
    // Defer normalization until the user starts capture. This keeps the
    // pre-capture page hook light and retains malformed entries for auditing.
    pendingBeforeCapture.set(id, tweet);
  }
  while (pendingBeforeCapture.size > PENDING_CACHE_LIMIT) {
    const oldest = pendingBeforeCapture.keys().next().value;
    pendingBeforeCapture.delete(oldest);
    pendingBeforeCaptureStats.dropped++;
  }
}

async function handleResponse(payload) {
  if (!payload) return;
  if (payload.ok === false) {
    if (!capture) return;
    const status = Number(payload.status) || 0;
    const reason = status === 429 ? "rate-limited"
      : status === 401 || status === 403 ? "auth-error"
        : status >= 500 ? "server-error" : "bad-response";
    await bumpError(reason, status);
    return;
  }

  const json = payload.json;
  if (!json || typeof json !== "object") {
    if (capture) await bumpError("bad-response");
    return;
  }
  const contentType = String(payload.contentType || "").toLowerCase();
  if (contentType && !contentType.includes("json")) {
    if (capture) await bumpError("non-json");
    return;
  }

  const page = XBookmarkTimeline.extractPage(json);
  if (!page.recognized) return; // Never ingest unrelated GraphQL recommendations.
  const run = capture;
  if (!run) {
    await cacheBeforeCapture(page);
    return;
  }

  run.timelineResponses++;
  if (page.entryCount > 0 && !page.tweets.length && !page.cursors.length) {
    run.schemaMismatchResponses++;
  }
  run.activityVersion++;
  run.lastActivityAt = Date.now();
  run.seenTweets += page.tweets.length;
  if (page.tweets.length) run.pagesWithTweets++;
  recordCursors(run, page);
  wakeRun(run);
  run.breaker.consecutiveErrors = 0;
  if (run.backoff.until && Date.now() < run.backoff.until) await waitForBackoff(run);

  let newOnPage = 0, failedOnPage = 0;
  for (const tweet of page.tweets) {
    const id = String(tweet?.rest_id || "");
    if (id) {
      run.observedOccurrences++;
      if (run.observedIds.has(id)) run.duplicateOccurrences++;
      else run.observedIds.add(id);
    }

    let normalized;
    try {
      normalized = normalizeTweet(tweet);
    } catch (error) {
      if (id) run.failedIds.add(id);
      try { await addDeadLetter(tweet, error); }
      catch (saveError) { console.warn("[x-bookmarks] dead-letter save failed", saveError); }
      failedOnPage++;
      continue;
    }

    const validation = validateItem(normalized);
    if (!validation.valid) {
      if (id) run.failedIds.add(id);
      try { await addDeadLetter(tweet, new Error(validation.errors.join("; "))); }
      catch (saveError) { console.warn("[x-bookmarks] dead-letter save failed", saveError); }
      failedOnPage++;
      continue;
    }

    const alreadyBuffered = run.buffer.has(normalized.tweet_id);
    const alreadyStored = run.store.has(normalized.tweet_id);
    if (alreadyBuffered || alreadyStored) {
      run.duplicateTotal++;
    } else {
      newOnPage++;
      run.newTotal++;
    }
    run.failedIds.delete(normalized.tweet_id);
    run.buffer.set(normalized.tweet_id, normalized);
    run.lastTweetId = normalized.tweet_id;
  }

  if (newOnPage) run.stableEmpty = 0;
  if (!page.tweets.length) run.emptyResponses++;
  run.failedTotal += failedOnPage;
  if (failedOnPage) run.normalizationFailures += failedOnPage;

  const projected = projectedStoreStats(run);
  await setState({
    stats: {
      responses: run.timelineResponses,
      timelineResponses: run.timelineResponses,
      pagesWithTweets: run.pagesWithTweets,
      captured: projected.count,
      mediaItems: projected.mediaItems,
      videos: projected.videos,
      newItems: run.newTotal,
      duplicates: run.duplicateTotal,
      failed: run.failedTotal,
      emptyResponses: run.emptyResponses,
    },
  });

  if (run.buffer.size >= config.batchSize || Date.now() - run.lastFlushAt > 5000) {
    await flushBuffer(run);
  }
}

/* Exponential backoff for 429/5xx errors.
   Returns the delay applied (ms), or 0 if no backoff triggered. */
async function applyBackoff(status) {
  if (!capture) return 0;

  const isRetryable = status === 429 || (status >= 500 && status < 600);
  if (!isRetryable) return 0;

  capture.backoff.retries++;
  const base = config.backoffBaseMs;
  const max = config.maxBackoffMs;
  const maxRetries = config.maxBackoffRetries;

  if (capture.backoff.retries > maxRetries) {
    capture.breaker.tripped = true;
    capture.breaker.reason = "max-backoff-retries";
    capture.stop = true;
    wakeRun(capture);
    await setState({ status: "stopped_by_error", lastStopReason: "max-backoff-retries" });
    return 0;
  }

  /* Exponential backoff with jitter: base * 2^retries ± 25% */
  const expDelay = base * Math.pow(2, capture.backoff.retries - 1);
  const jitter = expDelay * (0.75 + Math.random() * 0.5);
  const delay = Math.min(jitter, max);

  capture.backoff.until = Date.now() + delay;

  await setState({
    status: "capturing",
    lastStopReason: `backoff-${status} (attempt ${capture.backoff.retries}/${maxRetries}, ${Math.ceil(delay / 1000)}s)`,
  });

  await waitForBackoff(capture);
  return delay;
}

function scrollMetrics() {
  const root = document.scrollingElement || document.documentElement || document.body;
  const height = Math.max(
    Number(root?.scrollHeight) || 0,
    Number(document.body?.scrollHeight) || 0,
    Number(document.documentElement?.scrollHeight) || 0,
  );
  const viewport = Math.max(1, Number(window.innerHeight) || Number(document.documentElement?.clientHeight) || 800);
  const y = Math.max(Number(window.scrollY) || 0, Number(root?.scrollTop) || 0);
  return { height, viewport, y, bottom: Math.max(0, height - viewport) };
}

async function scrollToBottomAdaptive(run) {
  const started = Date.now();
  let steps = 0;
  while (!run.stop && !run.pause && !run.breaker.tripped &&
    steps < config.maxScrollStepsPerPass && Date.now() - started < config.maxPassDurationMs) {
    if (run.backoff.until && Date.now() < run.backoff.until) {
      await waitForBackoff(run);
      continue;
    }
    const { viewport, y, bottom } = scrollMetrics();
    const remaining = bottom - y;
    if (remaining <= 5) break;

    // Cruise quickly through mounted rows; brake near the infinite-scroll
    // trigger so X has time to mount the next page and issue its cursor query.
    const nearBottom = remaining <= viewport * 2.25;
    const multiplier = nearBottom ? config.nearBottomStepViewports : config.fastStepViewports;
    const step = Math.min(remaining, Math.max(300, Math.round(viewport * multiplier)));
    window.scrollTo(0, y + step);
    steps++;
    await waitRun(run, nearBottom ? config.nearBottomStepDelayMs : config.fastStepDelayMs);
  }

  const { y, bottom } = scrollMetrics();
  // Do not force-jump to the bottom when the safety time/step budget expires:
  // that can bypass X's intermediate pagination triggers. The outer loop will
  // continue the adaptive sweep from this position on its next pass.
  return { steps, reachedBottom: bottom - y <= 5 };
}

function captureAudit(run) {
  const missingIds = [];
  for (const id of run.observedIds) {
    if (!run.store.has(id)) missingIds.push(id);
  }
  const missingCount = missingIds.length;
  return {
    version: 1,
    verifiedAt: new Date().toISOString(),
    timelineResponses: run.timelineResponses,
    pagesWithTweets: run.pagesWithTweets,
    emptyResponses: run.emptyResponses,
    schemaMismatchResponses: run.schemaMismatchResponses,
    observedOccurrences: run.observedOccurrences,
    observedUniqueIds: run.observedIds.size,
    coveredUniqueIds: Math.max(0, run.observedIds.size - missingCount),
    missingUniqueIds: missingCount,
    missingIds: missingIds.slice(0, 100),
    normalizationFailures: run.normalizationFailures,
    failedUniqueIds: run.failedIds.size,
    duplicateOccurrences: run.duplicateOccurrences,
    cursorAdvances: run.cursorAdvances,
    repeatedCursors: run.repeatedCursors,
    bottomCursorSeen: run.bottomCursorSeen,
    preCaptureDropped: run.preCaptureDropped || 0,
    endReached: run.reason === "end-of-feed",
    endReason: run.reason || (run.breaker.tripped ? run.breaker.reason : run.stop ? "stopped-by-user" : null),
  };
}

async function runCaptureLoop(run) {
  let lastRateCount = run.newTotal;
  let lastRateAt = Date.now();

  if (run.primeAtTop && !run.stop && !run.pause) {
    window.scrollTo(0, 0);
    await waitRun(run, 120);
    run.primeAtTop = false;
  }

  while (!run.stop && !run.pause && !run.breaker.tripped) {
    if (Date.now() - run.startedAt > config.maxRuntimeMs) {
      run.reason = "max-runtime";
      break;
    }
    if (run.scrollBatches >= config.maxScrollBatches) {
      run.reason = "max-batches";
      break;
    }
    if (run.backoff.until && Date.now() < run.backoff.until) {
      await waitForBackoff(run);
      continue;
    }

    const activityBefore = run.activityVersion;
    const newItemsBefore = run.newTotal;
    const cursorAdvancesBefore = run.cursorAdvances;
    const heightBefore = scrollMetrics().height;
    const scrollResult = await scrollToBottomAdaptive(run);
    if (run.stop || run.pause || run.breaker.tripped) break;
    run.scrollBatches++;

    if (!scrollResult.reachedBottom) {
      // A very tall feed may outlast one pass's time/step budget. Keep sweeping
      // from the current position; only a true bottom visit counts as a quiet
      // end-of-feed check.
      run.stableEmpty = 0;
      await queue;
      const projected = projectedStoreStats(run);
      await setState({
        stats: {
          captured: projected.count,
          mediaItems: projected.mediaItems,
          videos: projected.videos,
          timelineResponses: run.timelineResponses,
          pagesWithTweets: run.pagesWithTweets,
          scrollBatches: run.scrollBatches,
          maxScrollBatches: config.maxScrollBatches,
          newItems: run.newTotal,
          duplicates: run.duplicateTotal,
          failed: run.failedTotal,
        },
      });
      continue;
    }

    // Wait only at the pagination boundary. Fast scrolls through already
    // rendered rows do not incur a per-row sleep; the response/DOM signal wakes
    // this wait immediately when X has delivered the next page.
    await waitRun(run, config.responseWaitMs);
    const heightAfter = scrollMetrics().height;
    const significantGrowth = heightAfter - heightBefore > scrollMetrics().viewport * 1.25;
    const responseMadeProgress = run.activityVersion > activityBefore &&
      (run.newTotal > newItemsBefore || run.cursorAdvances > cursorAdvancesBefore);
    const progressed = responseMadeProgress || significantGrowth;
    if (progressed) run.stableEmpty = 0;
    else run.stableEmpty++;

    if (run.buffer.size && Date.now() - run.lastFlushAt >= 2500) {
      await flushBuffer(run);
    }

    const now = Date.now();
    if (now - lastRateAt >= 5000) {
      const minutes = Math.max((now - run.startedAt) / 60000, 1 / 60);
      run.postsPerMin = Math.round(run.newTotal / minutes);
      lastRateAt = now;
      lastRateCount = run.newTotal;
    } else if (run.newTotal > lastRateCount) {
      const minutes = Math.max((now - lastRateAt) / 60000, 1 / 60);
      run.postsPerMin = Math.round((run.newTotal - lastRateCount) / minutes);
    }

    const projected = projectedStoreStats(run);
    await setState({
      stats: {
        emptyScrolls: run.stableEmpty,
        captured: projected.count,
        mediaItems: projected.mediaItems,
        videos: projected.videos,
        timelineResponses: run.timelineResponses,
        pagesWithTweets: run.pagesWithTweets,
        postsPerMin: run.postsPerMin || 0,
        scrollBatches: run.scrollBatches,
        maxScrollBatches: config.maxScrollBatches,
        newItems: run.newTotal,
        duplicates: run.duplicateTotal,
        failed: run.failedTotal,
      },
    });

    if (run.stableEmpty >= config.emptyScrollStop) {
      run.reason = !run.timelineResponses ? "no-responses-seen"
        : !run.observedIds.size && run.schemaMismatchResponses ? "schema-mismatch"
          : "end-of-feed";
      break;
    }
  }

  // Finish any in-flight API response before finalizing. On Panic, handlers
  // will see the run flag and the pending buffer is discarded without a flush.
  await queue;
  if (!run.panic) await flushBuffer(run);
  else run.buffer.clear();

  let status;
  if (run.pause) status = "paused";
  else if (run.breaker.tripped) status = "stopped_by_error";
  else if (run.stop || run.panic) status = "stopped_by_user";
  else if (run.reason === "end-of-feed") status = "completed";
  else if (["no-responses-seen", "schema-mismatch"].includes(run.reason)) status = "stopped_by_error";
  else if (run.reason) status = "incomplete";
  else status = "completed";

  if (!run.pause && !run.panic && !run.breaker.tripped && !run.stop && !run.timelineResponses) {
    run.reason = "no-responses-seen";
    status = "stopped_by_error";
  } else if (!run.pause && !run.panic && !run.breaker.tripped && !run.stop &&
    !run.observedIds.size && run.schemaMismatchResponses) {
    run.reason = "schema-mismatch";
    status = "stopped_by_error";
  }

  const audit = captureAudit(run);
  const stopReason = run.reason || (run.breaker.tripped ? run.breaker.reason : run.panic ? "panic-stop" : null);
  await setState({
    status,
    lastStopReason: stopReason,
    lastTweetId: run.lastTweetId || null,
    audit,
    stats: {
      captured: run.store.total,
      mediaItems: run.store.mediaItems,
      videos: run.store.videos,
      timelineResponses: run.timelineResponses,
      pagesWithTweets: run.pagesWithTweets,
      scrollBatches: run.scrollBatches,
      emptyScrolls: run.stableEmpty,
      postsPerMin: run.postsPerMin || 0,
      newItems: run.newTotal,
      duplicates: run.duplicateTotal,
      failed: run.failedTotal,
    },
  });

  if (status === "paused") {
    capture = run;
    await saveSession(run);
  } else {
    if (capture === run) capture = null;
    await clearSession();
  }
}

async function startCapture() {
  /* The unfollow engine owns the Following route; two engines scrolling and
     issuing requests from one profile would fight each other's pacing. */
  const { xUnfollowState = null } = await chrome.storage.local.get("xUnfollowState");
  if (xUnfollowState?.status === "running") return { ok: false, reason: "unfollow-running" };

  if (capture) {
    if (capture.pause) {
      const run = capture;
      if (run.loopPromise) await run.loopPromise;
      if (capture !== run) return { ok: false, reason: "capture-ended" };
      run.pause = false;
      await setState({ status: "capturing", lastStopReason: null });
      wakeRun(run);
      launchCaptureLoop(run);
      return { ok: true, resumed: true };
    }
    return { ok: false, reason: "already-running" };
  }

  const session = await loadSession();
  if (session) {
    const resumed = await resumeFromSession(session);
    if (resumed) return resumed;
  }

  const store = await XBookmarkStore.open();
  // Drain any pre-start response cache before switching new responses into the
  // live run, so the first timeline page cannot fall into a gap between modes.
  await queue;
  const run = createRun(store);
  run.primeAtTop = true;
  run.preCaptureDropped = pendingBeforeCaptureStats.dropped;
  run.timelineResponses = pendingBeforeCaptureStats.timelineResponses;
  run.emptyResponses = pendingBeforeCaptureStats.emptyResponses;
  run.schemaMismatchResponses = pendingBeforeCaptureStats.schemaMismatchResponses;
  run.observedOccurrences = pendingBeforeCaptureStats.observedOccurrences;
  run.duplicateOccurrences = pendingBeforeCaptureStats.duplicateOccurrences;
  run.seenTweets = pendingBeforeCaptureStats.observedOccurrences;
  run.pagesWithTweets = pendingBeforeCaptureStats.pagesWithTweets;
  // Switch responses into the live run before any asynchronous normalization or
  // dead-letter write, so a response arriving during setup cannot be lost.
  capture = run;

  for (const [id, rawTweet] of pendingBeforeCapture) {
    run.observedIds.add(id);
    let item;
    try {
      item = normalizeTweet(rawTweet);
      const validation = validateItem(item);
      if (!validation.valid) throw new Error(validation.errors.join("; "));
    } catch (error) {
      run.failedIds.add(id);
      run.failedTotal++;
      run.normalizationFailures++;
      try { await addDeadLetter(rawTweet, error); }
      catch (saveError) { console.warn("[x-bookmarks] dead-letter save failed", saveError); }
      continue;
    }
    run.buffer.set(id, item);
    if (store.has(id)) run.duplicateTotal++;
    else run.newTotal++;
  }
  pendingBeforeCapture.clear();
  pendingBeforeCaptureStats.timelineResponses = 0;
  pendingBeforeCaptureStats.emptyResponses = 0;
  pendingBeforeCaptureStats.schemaMismatchResponses = 0;
  pendingBeforeCaptureStats.observedOccurrences = 0;
  pendingBeforeCaptureStats.duplicateOccurrences = 0;
  pendingBeforeCaptureStats.pagesWithTweets = 0;
  pendingBeforeCaptureStats.dropped = 0;

  // Drain events that arrived during setup; later events continue through the
  // live queue and are covered by the sweep's response/activity counters.
  await queue;
  const projected = projectedStoreStats(run);
  await setState({
    status: "capturing",
    startedAt: new Date().toISOString(),
    lastStopReason: null,
    audit: null,
    stats: {
      captured: projected.count,
      mediaItems: projected.mediaItems,
      videos: projected.videos,
      newItems: run.newTotal,
      duplicates: run.duplicateTotal,
      failed: 0,
      emptyScrolls: 0,
      emptyResponses: 0,
      errors: 0,
      rateLimits: 0,
      authErrors: 0,
      responses: run.timelineResponses,
      timelineResponses: run.timelineResponses,
      pagesWithTweets: run.pagesWithTweets,
      scrollBatches: 0,
      maxScrollBatches: config.maxScrollBatches,
      postsPerMin: 0,
    },
  });
  launchCaptureLoop(run);
  return { ok: true };
}

async function pauseCapture() {
  if (!capture || capture.pause || capture.stop) return { ok: false, reason: "not-capturing" };
  const run = capture;
  run.pause = true;
  wakeRun(run);
  if (!run.loopPromise) launchCaptureLoop(run);
  await run.loopPromise;
  return { ok: true };
}

async function stopCapture() {
  if (!capture) return { ok: false, reason: "idle" };
  const run = capture;
  run.stop = true;
  run.pause = false;
  wakeRun(run);
  if (!run.loopPromise) launchCaptureLoop(run);
  await run.loopPromise;
  return { ok: true };
}

async function panicCapture() {
  if (!capture) return { ok: false, reason: "idle" };
  const run = capture;
  run.panic = true;
  run.stop = true;
  run.pause = false;
  run.buffer.clear();
  wakeRun(run);
  if (!run.loopPromise) launchCaptureLoop(run);
  await run.loopPromise;
  return { ok: true };
}

async function resetAll() {
  if (capture) {
    const run = capture;
    run.panic = true;
    run.stop = true;
    run.pause = false;
    run.buffer.clear();
    wakeRun(run);
    if (!run.loopPromise) launchCaptureLoop(run);
    await run.loopPromise;
  }
  capture = null;
  pendingBeforeCapture.clear();
  pendingBeforeCaptureStats.timelineResponses = 0;
  pendingBeforeCaptureStats.emptyResponses = 0;
  pendingBeforeCaptureStats.schemaMismatchResponses = 0;
  pendingBeforeCaptureStats.observedOccurrences = 0;
  pendingBeforeCaptureStats.duplicateOccurrences = 0;
  pendingBeforeCaptureStats.pagesWithTweets = 0;
  pendingBeforeCaptureStats.dropped = 0;
  await XBookmarkStore.clear();
  await chrome.storage.local.remove([STATE_KEY, DEAD_KEY, SESSION_KEY]);
  return { ok: true };
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.source !== "x-bookmark-exporter" || data.type !== "bookmarks-response") return;

  const payload = data.payload;
  if (payload?.ok !== false && !XBookmarkTimeline.findTimeline(payload?.json)) return;
  if (capture) {
    capture.incomingResponses = (capture.incomingResponses || 0) + 1;
    wakeRun(capture);
  }
  enqueue(() => handleResponse(payload));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (promise) => {
    promise.then(sendResponse).catch((error) => {
      console.error("[x-bookmarks] command failed", error);
      sendResponse({ ok: false, reason: String(error?.message || error) });
    });
    return true;
  };
  switch (msg?.type) {
    case "start": return reply(startCapture());
    case "pause": return reply(pauseCapture());
    case "stop": return reply(stopCapture());
    case "panic": return reply(panicCapture());
    case "get-state": return reply(getState());
    case "reset": return reply(resetAll());
    default: return false;
  }
});