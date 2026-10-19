const STORAGE_KEY = "xBookmarks";
const STATE_KEY = "xCaptureState";
const DEAD_KEY = "xDeadLetters";
const SESSION_KEY = "xCaptureSession";  // For session persistence across tab refresh
const NORMALIZER_VERSION = "2026-08-16.3";
const SOURCE_TYPE = "graphql-bookmarks";

const config = {
  /* Deliberately slow. The run's job is COMPLETENESS, not speed: every pause
     is time X gets to answer the previous page before the next one is asked
     for, and a scrape that outruns the network is a scrape with holes in it.
     Delays are randomised inside the band so the cadence never looks — or
     behaves — like a metronome. */
  minScrollDelay: 4500,
  maxScrollDelay: 9000,
  /* Pause between the small viewport-sized steps that walk each batch down
     to the bottom of the rendered page (see scrollToBottomSlowly). */
  scrollStepDelay: 900,
  /* Safety cap only, not a target. 40 batches used to end a big library run
     mid-feed (~800 bookmarks); 400 clears any realistic library and the
     end-of-feed detector is what actually finishes a run. */
  maxScrollBatches: 400,
  /* How many consecutive quiet scrolls prove the feed truly ended. Raised
     from 5: a slow connection can serve nothing for three or four scrolls
     and still have more feed, and stopping early there skips the tail. */
  emptyScrollStop: 8,
  /* Pages of already-known bookmarks before an incremental pass declares
     itself complete. Raised from 3: X does not return bookmarks in a strict
     order, so a new item can hide several pages behind known ones. */
  knownOnlyPagesStop: 6,
  /* The slower cadence needs a bigger time budget or the clock becomes the
     thing that truncates the run. */
  maxRuntimeMs: 60 * 60 * 1000,
  batchSize: 100,
  maxConsecutiveErrors: 3,
  /* Exponential backoff for rate limits (429) and server errors (5xx).
     Base delay doubles each retry, capped at maxBackoffMs. Jitter added. */
  backoffBaseMs: 5000,
  maxBackoffMs: 5 * 60 * 1000,
  maxBackoffRetries: 10,
/* Periodic buffer flush to prevent memory buildup on long runs.
     Flush every flushIntervalBatches regardless of batchSize threshold. */
  flushIntervalBatches: 20,
  /* Similarity threshold for cross-run duplicate detection (edited tweets).
     0.85 = 85% similar text considered same tweet. Lower = more aggressive. */
  similarityThreshold: 0.85
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

const sleep = (ms) =>
  new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (!capture || capture.stop || capture.pause || Date.now() - start >= ms) {
        clearInterval(iv);
        resolve();
      }
    }, 250);
  });

const enqueue = (fn) => {
  queue = queue.then(fn);
  return queue;
};

/* Jaro-Winkler similarity for fuzzy duplicate detection (edited tweets).
   Returns 0-1 where 1 = identical. Optimized for short strings (tweets). */
function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1;
  if (!s1 || !s2) return 0;

  const len1 = s1.length, len2 = s2.length;
  const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, len2);
    for (let j = start; j < end; j++) {
      if (!s2Matches[j] && s1[i] === s2[j]) {
        s1Matches[i] = s2Matches[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;

  let k = 0, transpositions = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;

  // Winkler prefix bonus (up to 4 chars)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, len1, len2); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + 0.1 * prefix * (1 - jaro);
}

/* Normalize text for similarity comparison: lowercase, remove URLs, mentions, hashtags. */
function normalizeForSimilarity(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")      // URLs
    .replace(/@\w+/g, "")                // mentions
    .replace(/#\w+/g, "")                // hashtags
    .replace(/\s+/g, " ")                // collapse whitespace
    .trim();
};

async function getStored() {
  const d = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(d[STORAGE_KEY]) ? d[STORAGE_KEY] : [];
}

const setStored = (list) => chrome.storage.local.set({ [STORAGE_KEY]: list });

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
        responses: 0
      }
    }
  );
}

async function setState(patch) {
  const s = await getState();
  const next = {
    ...s,
    ...patch,
    stats: { ...s.stats, ...(patch.stats || {}) },
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  chrome.runtime.sendMessage({ type: "state", state: next }).catch(() => {});
  return next;
}

/* Session persistence: save/restore capture run across tab refresh/navigation */
async function saveSession(run) {
  if (!run) {
    await chrome.storage.local.remove(SESSION_KEY);
    return;
  }
  const session = {
    startedAt: run.startedAt,
    scrollBatches: run.scrollBatches,
    stableEmpty: run.stableEmpty,
    knownOnlyPages: run.knownOnlyPages,
    seenResponses: run.seenResponses,
    seenTweets: run.seenTweets,
    lastTweetId: run.lastTweetId,
    buffer: Array.from(run.buffer.entries()),
    breaker: run.breaker,
    reason: run.reason,
    backoff: run.backoff,
    paused: run.pause,
    stopped: run.stop,
    savedAt: Date.now()
  };
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

async function loadSession() {
  const d = await chrome.storage.local.get(SESSION_KEY);
  return d[SESSION_KEY] || null;
}

async function clearSession() {
  await chrome.storage.local.remove(SESSION_KEY);
}

/* Resume a capture run from persisted session */
async function resumeFromSession(session) {
  if (!session) return null;

  /* Validate session isn't stale (older than maxRuntimeMs) */
  if (Date.now() - session.savedAt > config.maxRuntimeMs) {
    await clearSession();
    return null;
  }

  const run = {
    stop: session.stopped || false,
    pause: session.paused || false,
    startedAt: session.startedAt,
    scrollBatches: session.scrollBatches || 0,
    stableEmpty: session.stableEmpty || 0,
    knownOnlyPages: session.knownOnlyPages || 0,
    seenResponses: session.seenResponses || 0,
    seenTweets: session.seenTweets || 0,
    lastTweetId: session.lastTweetId || null,
    buffer: new Map(session.buffer || []),
    breaker: session.breaker || { consecutiveErrors: 0, tripped: false, reason: null },
    reason: session.reason || null,
    backoff: session.backoff || { retries: 0, until: 0 }
  };

  capture = run;
  await setState({ status: run.pause ? "paused" : "capturing", lastStopReason: null });
  runCaptureLoop(run).catch(() => {});

  /* Persist session periodically */
  const persistInterval = setInterval(async () => {
    if (!capture || capture.stop) {
      clearInterval(persistInterval);
      await clearSession();
    } else {
      await saveSession(capture);
    }
  }, 30000); // Every 30 seconds

  return { ok: true, resumed: true };
}

function extractTweets(json) {
  const found = [];
  const stack = [json];

  // Explicitly handle both bookmark_timeline_v2 and bookmark_timeline response paths
  // X switches between these; we try both to be resilient
  const instructions =
    (json.data?.bookmark_timeline_v2?.timeline?.instructions) ||
    (json.data?.bookmark_timeline?.timeline?.instructions) ||
    (json.data?.bookmark_collection_timeline?.timeline?.instructions) ||
    [];

  for (const instruction of instructions) {
    if (instruction.type === "TimelineAddEntries" && Array.isArray(instruction.entries)) {
      for (const entry of instruction.entries) {
        if (entry.entryId?.startsWith("tweet-")) {
          const itemContent = entry.content?.itemContent;
          if (itemContent?.tweet_results?.result) {
            const tweet = unwrapTweetResult(itemContent.tweet_results.result);
            if (tweet) found.push(tweet);
          }
        }
        // Also check TimelineTimelineModule entries (conversation threads)
        if (Array.isArray(entry.content?.items)) {
          for (const item of entry.content.items) {
            const moduleItemContent = item.item?.itemContent;
            if (moduleItemContent?.tweet_results?.result) {
              const tweet = unwrapTweetResult(moduleItemContent.tweet_results.result);
              if (tweet) found.push(tweet);
            }
          }
        }
      }
    }
  }

  // If we found tweets via explicit path, return them (avoids deep traversal false positives)
  if (found.length) return found;

  // Fallback: deep traversal for other response shapes
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;

    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }

    // Handle bookmark timeline structure: data.bookmark_timeline_v2.timeline.instructions[].entries[]
    if (node.entries && Array.isArray(node.entries)) {
      for (const entry of node.entries) {
        if (entry.entryId && typeof entry.entryId === "string" && entry.entryId.startsWith("tweet-")) {
          const itemContent = entry.content?.itemContent;
          if (itemContent && itemContent.tweet_results) {
            const result = itemContent.tweet_results.result;
            const tweet = unwrapTweetResult(result);
            if (tweet) found.push(tweet);
          }
        }
        // Also check TimelineTimelineModule entries
        if (entry.content?.items && Array.isArray(entry.content.items)) {
          for (const item of entry.content.items) {
            const moduleItemContent = item.item?.itemContent;
            if (moduleItemContent && moduleItemContent.tweet_results) {
              const result = moduleItemContent.tweet_results.result;
              const tweet = unwrapTweetResult(result);
              if (tweet) found.push(tweet);
            }
          }
        }
      }
      continue;
    }

    // Original deep traversal for other response shapes
    if (node.content && node.content.itemContent && node.content.itemContent.tweet_results) {
      const result = node.content.itemContent.tweet_results.result;
      const tweet = unwrapTweetResult(result);
      if (tweet) {
        found.push(tweet);
        continue;
      }
    }

    if (node.__typename === "Tweet" && node.rest_id) {
      found.push(node);
      continue;
    }

    // Handle TweetWithVisibilityResults at root level
    if (node.__typename === "TweetWithVisibilityResults" && node.tweet && node.tweet.rest_id) {
      found.push(node.tweet);
      continue;
    }

    for (const value of Object.values(node)) stack.push(value);
  }

  return found;
}

function unwrapTweetResult(result) {
  if (!result || typeof result !== "object") return null;

  // Handle TweetWithVisibilityResults wrapper
  if (result.__typename === "TweetWithVisibilityResults" && result.tweet) {
    return result.tweet;
  }

  // Regular Tweet
  if (result.__typename === "Tweet" && result.rest_id) {
    return result;
  }

  return null;
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
    tweet_id: tweetId,
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
    raw: tweet
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
  const d = await chrome.storage.local.get(DEAD_KEY);
  const list = Array.isArray(d[DEAD_KEY]) ? d[DEAD_KEY] : [];
  list.push({
    tweet_id: raw && raw.rest_id,
    error: String((error && error.message) || error),
    raw,
    at: new Date().toISOString(),
    normalizer_version: NORMALIZER_VERSION
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
  const s = await getState();
  const stats = {};
  for (const [k, v] of Object.entries(inc)) {
    stats[k] = (Number(s.stats && s.stats[k]) || 0) + v;
  }
  await setState({ stats });

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
    await setState({ status: "stopped_by_error", lastStopReason: reason });
    return;
  }
  capture.breaker.consecutiveErrors++;
  if (capture.breaker.consecutiveErrors >= config.maxConsecutiveErrors) {
    capture.breaker.tripped = true;
    capture.breaker.reason = "too-many-errors";
    capture.stop = true;
    await setState({ status: "stopped_by_error", lastStopReason: "too-many-errors" });
  }
}

async function flushBuffer() {
  if (!capture || !capture.buffer.size) return;
  const stored = await getStored();
  const map = new Map(stored.map((b) => [b.tweet_id, b]));

  for (const [id, item] of capture.buffer) {
    const existing = map.get(id);
    if (existing) {
      // Update live fields, preserve user-owned / first-seen / identity fields.
      existing.last_seen_at = item.last_seen_at;
      existing.like_count_at_capture = item.like_count_at_capture;
      existing.retweet_count_at_capture = item.retweet_count_at_capture;
      existing.reply_count_at_capture = item.reply_count_at_capture;
      existing.view_count_at_capture = item.view_count_at_capture;
    } else {
      item.capture_order = map.size + 1;
      map.set(id, item);
    }
  }

  const list = Array.from(map.values());
  await setStored(list);

  const lastTweetId =
    capture.lastTweetId ||
    (list[list.length - 1] && list[list.length - 1].tweet_id) ||
    null;

  capture.buffer.clear();
  await setState({ lastTweetId, stats: { captured: list.length } });
}

async function handleResponse(payload) {
  if (!capture) return;

  /* Respect backoff window: if we're in a backoff period, pause capture
     and wait until it expires before continuing. */
  if (capture.backoff.until && Date.now() < capture.backoff.until) {
    const waitMs = capture.backoff.until - Date.now();
    await setState({
      status: "paused",
      lastStopReason: `rate-limited-backoff (retry in ${Math.ceil(waitMs / 1000)}s)`
    });
    await sleep(waitMs);
    await setState({ status: "capturing", lastStopReason: null });
  }

  if (!payload || payload.ok === false) {
    const status = payload && payload.status;
    let reason = null;
    if (status === 429) reason = "rate-limited";
    else if (status === 401 || status === 403) reason = "auth-error";
    else if (status >= 500) reason = "server-error";

    await bumpError(reason, status);
    return;
  }

  /* Successful response resets backoff */
  if (capture.backoff.retries > 0) {
    capture.backoff.retries = 0;
    capture.backoff.until = 0;
  }

  const contentType = payload.contentType || "";
  const json = payload.json;

  if (typeof json !== "object" || json === null) {
    await bumpError("bad-response");
    return;
  }

  if (contentType && !contentType.includes("json")) {
    await bumpError("non-json");
    return;
  }

  capture.seenResponses = (capture.seenResponses || 0) + 1;

  const tweets = extractTweets(json);
  if (!tweets.length) {
    await setState({ stats: { emptyResponses: 1 } });
    capture.breaker.consecutiveErrors = 0;
    return;
  }

  capture.seenTweets = (capture.seenTweets || 0) + 1;
  capture.breaker.consecutiveErrors = 0;

  const stored = await getStored();
  const storedIds = new Set(stored.map((b) => b.tweet_id));
  let newCount = 0;
  let dupCount = 0;
  let failCount = 0;

  for (const tweet of tweets) {
    let normalized;
    try {
      normalized = normalizeTweet(tweet);
    } catch (e) {
      await addDeadLetter(tweet, e);
      failCount++;
      continue;
    }

    const validation = validateItem(normalized);
    if (!validation.valid) {
      await addDeadLetter(tweet, new Error(validation.errors.join("; ")));
      failCount++;
      continue;
    }

    if (storedIds.has(normalized.tweet_id) || capture.buffer.has(normalized.tweet_id)) {
      capture.buffer.set(normalized.tweet_id, normalized);
      dupCount++;
      continue;
    }

    /* Cross-run fuzzy duplicate detection: check if this tweet is an edited
       version of an already-captured tweet (same author, similar text). */
    const normText = normalizeForSimilarity(normalized.text);
    let isFuzzyDup = false;
    for (const existing of stored) {
      if (existing.author_id === normalized.author_id && existing.text) {
        const existingNorm = normalizeForSimilarity(existing.text);
        const sim = jaroWinkler(normText, existingNorm);
        if (sim >= config.similarityThreshold) {
          /* Update the existing tweet with new content (edited version) */
          existing.text = normalized.text;
          existing.last_seen_at = normalized.last_seen_at;
          existing.like_count_at_capture = normalized.like_count_at_capture;
          existing.retweet_count_at_capture = normalized.retweet_count_at_capture;
          existing.reply_count_at_capture = normalized.reply_count_at_capture;
          existing.view_count_at_capture = normalized.view_count_at_capture;
          existing.has_media = normalized.has_media;
          existing.media_types = normalized.media_types;
          existing.media_items = normalized.media_items;
          existing.urls_expanded = normalized.urls_expanded;
          isFuzzyDup = true;
          break;
        }
      }
    }
    if (isFuzzyDup) {
      dupCount++;
      continue;
    }

    capture.buffer.set(normalized.tweet_id, normalized);
    newCount++;
  }

  if (newCount) {
    capture.stableEmpty = 0;
    capture.knownOnlyPages = 0;
    capture.lastTweetId = tweets[0].rest_id;
  } else if (tweets.length) {
    capture.knownOnlyPages++;
  }

  await setState({
    stats: { newItems: newCount, duplicates: dupCount, failed: failCount, captured: stored.length + capture.buffer.size }
  });

  if (capture.buffer.size >= config.batchSize) {
    await flushBuffer();
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
    await setState({ status: "stopped_by_error", lastStopReason: "max-backoff-retries" });
    return 0;
  }

  /* Exponential backoff with jitter: base * 2^retries ± 25% */
  const expDelay = base * Math.pow(2, capture.backoff.retries - 1);
  const jitter = expDelay * (0.75 + Math.random() * 0.5);
  const delay = Math.min(jitter, max);

  capture.backoff.until = Date.now() + delay;

  await setState({
    status: "paused",
    lastStopReason: `backoff-${status} (attempt ${capture.backoff.retries}/${maxRetries}, ${Math.ceil(delay / 1000)}s)`
  });

  await sleep(delay);

  await setState({ status: "capturing", lastStopReason: null });
  return delay;
}

/**
 * Walk to the bottom of the rendered page in viewport-sized steps rather
 * than teleporting there in one jump.
 *
 * Why: X's timeline is virtualised. A single `scrollTo(scrollHeight)` skips
 * past everything between here and the bottom faster than the list can
 * mount it, which can leave the pagination trigger unfired and — worse —
 * lets one giant leap stand in for the many small movements the feed
 * actually paginates on. Stepping through the whole distance is slower on
 * purpose: every intermediate viewport gets its chance to render and to
 * request the next page, so nothing between the top and the bottom is
 * skipped over.
 */
async function scrollToBottomSlowly(run) {
  let guard = 0;
  // The page grows underneath us as responses land, so re-read the target
  // every step instead of computing it once.
  while (!run.stop && !run.pause && guard++ < 80) {
    const bottom = document.body.scrollHeight - window.innerHeight;
    if (window.scrollY >= bottom - 4) break;
    window.scrollBy(0, Math.max(240, Math.round(window.innerHeight * 0.75)));
    await sleep(config.scrollStepDelay);
  }
  // Land exactly at the end so the "load more" sentinel is definitely on
  // screen while the long between-batch pause runs.
  window.scrollTo(0, document.body.scrollHeight);
}

async function runCaptureLoop(run) {
  let previousTotal = (await getStored()).length;
  let previousHeight = 0;
  /* Capture rate tracking */
  let lastRateUpdate = run.startedAt;
  let lastCapturedCount = previousTotal;

  while (!run.stop && !run.pause && !run.breaker.tripped) {
    const elapsed = Date.now() - run.startedAt;
    if (elapsed > config.maxRuntimeMs) { run.reason = "max-runtime"; break; }
    if (run.scrollBatches >= config.maxScrollBatches) { run.reason = "max-batches"; break; }
    if (run.stableEmpty >= config.emptyScrollStop) { run.reason = "end-of-feed"; break; }
    if (run.knownOnlyPages >= config.knownOnlyPagesStop) { run.reason = "incremental-complete"; break; }

    await scrollToBottomSlowly(run);
    const delay = config.minScrollDelay + Math.random() * (config.maxScrollDelay - config.minScrollDelay);
    await sleep(delay);
    run.scrollBatches++;

    /* Periodic buffer flush to prevent memory buildup on long runs.
       Flush every flushIntervalBatches regardless of batchSize threshold. */
    if (run.scrollBatches % config.flushIntervalBatches === 0 && run.buffer.size > 0) {
      await flushBuffer();
    }

    /* "Empty" must mean the feed genuinely gave nothing — measured on TWO
       channels, not one. The item count alone misses the incremental case
       where a page of already-known bookmarks arrives (total unchanged, feed
       very much alive), which used to tick the end-of-feed counter while
       there was plenty of page left. Page growth catches that: if the
       document got taller, content loaded, and the run is not at the end. */
    const total = (await getStored()).length + run.buffer.size;
    const height = document.body.scrollHeight;
    if (total > previousTotal || height > previousHeight) {
      run.stableEmpty = 0;
      previousTotal = Math.max(previousTotal, total);
      previousHeight = Math.max(previousHeight, height);
    } else {
      run.stableEmpty++;
    }

    /* Calculate capture rate (posts/min) */
    const now = Date.now();
    const timeSinceLastRate = (now - lastRateUpdate) / 60000; // minutes
    if (timeSinceLastRate >= 0.5) { // Update every 30 seconds
      const capturedSinceLastRate = total - lastCapturedCount;
      const postsPerMin = timeSinceLastRate > 0 ? Math.round(capturedSinceLastRate / timeSinceLastRate) : 0;
      lastRateUpdate = now;
      lastCapturedCount = total;
      run.postsPerMin = postsPerMin;
    }

    let etaMinutes = null;
    if (run.postsPerMin && run.postsPerMin > 0 && run.scrollBatches > 0) {
      const batchesLeft = Math.max(0, config.maxScrollBatches - run.scrollBatches);
      const avgPostsPerBatch = total / run.scrollBatches;
      const estimatedRemainingPosts = batchesLeft * avgPostsPerBatch;
      const remainingMinutes = estimatedRemainingPosts / run.postsPerMin;
      const avgBatchDelayMinutes = (config.minScrollDelay + config.maxScrollDelay) / 2 / 60000;
      etaMinutes = Math.round(remainingMinutes + batchesLeft * avgBatchDelayMinutes);
    }

    // Broadcast state every scroll batch for instant UI updates
    const stored = await getStored();
    await setState({
      stats: {
        emptyScrolls: run.stableEmpty,
        captured: stored.length + run.buffer.size,
        postsPerMin: run.postsPerMin || 0,
        scrollBatches: run.scrollBatches,
        maxScrollBatches: config.maxScrollBatches,
        etaMinutes
      }
    });
  }

  await flushBuffer();

  let status;
  if (run.pause) status = "paused";
  else if (run.breaker.tripped) status = "stopped_by_error";
  else if (run.stop) status = "stopped_by_user";
  else status = "completed";

  if (!run.pause && !run.breaker.tripped && !run.stop && !run.reason) {
    const total = (await getStored()).length;
    if (total === 0) {
      if (!run.seenResponses) {
        run.reason = "no-responses-seen";
        status = "stopped_by_error";
      } else if (!run.seenTweets) {
        run.reason = "schema-mismatch";
        status = "stopped_by_error";
      }
    }
  }

  const stopReason = run.reason || (run.breaker.tripped ? run.breaker.reason : null);
  await setState({ status, lastStopReason: stopReason });

  if (status === "paused") {
    capture = run;
    await saveSession(capture);
  } else {
    capture = null;
    await clearSession();
  }
}

async function startCapture() {
  if (capture) {
    if (capture.pause) {
      capture.pause = false;
      setState({ status: "capturing", lastStopReason: null });
      runCaptureLoop(capture).catch(() => {});
      return { ok: true, resumed: true };
    }
    return { ok: false, reason: "already-running" };
  }

  /* Check for persisted session from tab refresh/navigation */
  const session = await loadSession();
  if (session) {
    return await resumeFromSession(session);
  }

  const run = {
    stop: false,
    pause: false,
    startedAt: Date.now(),
    scrollBatches: 0,
    stableEmpty: 0,
    knownOnlyPages: 0,
    seenResponses: 0,
    seenTweets: 0,
    lastTweetId: null,
    buffer: new Map(),
    breaker: { consecutiveErrors: 0, tripped: false, reason: null },
    reason: null,
    /* Exponential backoff state for 429/5xx */
    backoff: { retries: 0, until: 0 }
  };
  capture = run;

  await setState({ status: "capturing", startedAt: new Date().toISOString(), lastStopReason: null });
  runCaptureLoop(run).catch(() => {});
  return { ok: true };
}

async function pauseCapture() {
  if (capture && !capture.pause && !capture.stop) {
    capture.pause = true;
    await saveSession(capture);
    return { ok: true };
  }
  return { ok: false, reason: "not-capturing" };
}

async function stopCapture() {
  if (!capture) return { ok: false, reason: "idle" };
  capture.stop = true;
  await clearSession();
  return { ok: true };
}

async function resetAll() {
  await chrome.storage.local.remove([STORAGE_KEY, STATE_KEY, DEAD_KEY, SESSION_KEY]);
  capture = null;
  return { ok: true };
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.source !== "x-bookmark-exporter") return;

  if (data.type === "bookmarks-response") {
    enqueue(async () => {
      await setState({ stats: { responses: 1 } });
      await handleResponse(data.payload);
    }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case "start":
      startCapture().then(sendResponse);
      return true;
    case "pause":
      pauseCapture().then(sendResponse);
      return true;
    case "stop":
      stopCapture().then(sendResponse);
      return true;
    case "panic":
      stopCapture().then(sendResponse);
      return true;
    case "get-state":
      getState().then(sendResponse);
      return true;
    case "reset":
      resetAll().then(sendResponse);
      return true;
  }
});