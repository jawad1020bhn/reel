/* core.util — pure helpers shared by every layer. No DOM, no storage. */
XR.define("core.util", [], function () {
  "use strict";

  /* ------------------------------------------------------------ hashing -- */
  /** FNV-1a 32-bit over a string → 8 hex chars. Fast enough for 20 MB. */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  /* ------------------------------------------------------------- random -- */
  /** Mulberry32 — small seeded PRNG so "shuffle" is stable within a session. */
  function seededRandom(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(list, seed) {
    const rnd = seed === undefined ? Math.random : seededRandom(seed);
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  function daySeed(date = new Date()) {
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  }

  /* --------------------------------------------------------------- time -- */
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /** "Sun Oct 19 10:50:47 +0000 2025" | ISO | epoch → ms (0 when unknown). */
  function parseDate(value) {
    if (!value) return 0;
    if (typeof value === "number") return value > 1e12 ? value : value * 1000;
    const str = String(value).trim();
    if (/^\d{13}$/.test(str)) return Number(str);
    if (/^\d{10}$/.test(str)) return Number(str) * 1000;
    let t = Date.parse(str);
    if (!Number.isNaN(t)) return t;
    // Twitter legacy format: "Sun Oct 19 10:50:47 +0000 2025"
    const m = str.match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/);
    if (m) {
      const month = MONTHS.indexOf(m[1]);
      t = Date.UTC(+m[7], month, +m[2], +m[3], +m[4], +m[5]);
      const sign = m[6][0] === "-" ? -1 : 1;
      const offMin = sign * (Number(m[6].slice(1, 3)) * 60 + Number(m[6].slice(3)));
      return t - offMin * 60000;
    }
    return 0;
  }
  function monthKey(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  function sameMonthDay(ms, ref = Date.now()) {
    if (!ms) return false;
    const a = new Date(ms), b = new Date(ref);
    return a.getMonth() === b.getMonth() && a.getDate() === b.getDate() && a.getFullYear() !== b.getFullYear();
  }
  /** "3m", "90s", "1h30m", "2:15" → seconds. */
  function parseDurationSpec(str) {
    if (!str) return NaN;
    const s = String(str).trim().toLowerCase();
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(s)) {
      return s.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);
    }
    let total = 0, matched = false;
    s.replace(/(\d+(?:\.\d+)?)\s*(h|m|s)/g, (_, n, u) => {
      matched = true;
      total += Number(n) * (u === "h" ? 3600 : u === "m" ? 60 : 1);
      return "";
    });
    return matched ? total : NaN;
  }

  /* --------------------------------------------------------------- text -- */
  const HASHTAG_RE = /(^|[^\w&])#([\p{L}\p{N}_]+)/gu;
  function extractHashtags(text) {
    const out = [];
    if (!text) return out;
    for (const m of String(text).matchAll(HASHTAG_RE)) out.push(m[2].toLowerCase());
    return [...new Set(out)];
  }
  /** Removes the trailing "https://t.co/..." media link X appends to every post. */
  function cleanText(text) {
    return String(text || "")
      .replace(/\s*https?:\/\/t\.co\/\w+\s*$/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .trim();
  }
  function truncate(str, n = 140) {
    const s = String(str || "");
    return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
  }
  function slug(str) {
    return String(str || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  }
  const toNumber = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  function uniq(list, keyFn) {
    if (!keyFn) return [...new Set(list)];
    const seen = new Set(), out = [];
    for (const item of list) { const k = keyFn(item); if (!seen.has(k)) { seen.add(k); out.push(item); } }
    return out;
  }
  function groupBy(list, keyFn) {
    const map = new Map();
    for (const item of list) {
      const k = keyFn(item);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(item);
    }
    return map;
  }
  function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }
  function throttle(fn, ms) {
    let last = 0, timer;
    return function (...args) {
      const now = Date.now(), rest = ms - (now - last);
      if (rest <= 0) { last = now; fn.apply(this, args); }
      else { clearTimeout(timer); timer = setTimeout(() => { last = Date.now(); fn.apply(this, args); }, rest); }
    };
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  return {
    fnv1a, seededRandom, shuffle, daySeed,
    parseDate, monthKey, sameMonthDay, parseDurationSpec, MONTHS,
    extractHashtags, cleanText, truncate, slug, toNumber, clamp, uniq, groupBy, debounce, throttle, uid,
  };
});
