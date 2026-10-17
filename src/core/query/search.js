/* core.query.search — the search language.

     word word        every word must appear (substring, case-insensitive)
     -word            must NOT appear
     "exact phrase"   literal phrase
     @creator         author username (prefix match)
     #tag             hashtag
     is:video|photo|gif|short|long|carousel|text|unseen|seen|starred|hidden|unavailable|dup
     dur:>3m  dur:<90s  dur:1m-5m     duration of the longest clip
     likes:>1000  views:>50k
     before:2026-01  after:2025-10-15 (post date)
     saved:>2026-08  (capture date)
*/
XR.define("core.query.search", ["core.util"], function (util) {
  "use strict";

  const FIELDS = new Set(["is", "dur", "likes", "views", "before", "after", "saved", "from", "has", "sort"]);

  function tokenize(input) {
    const tokens = [];
    const re = /(-?)(?:"([^"]+)"|(\S+))/g;
    let m;
    while ((m = re.exec(input || ""))) {
      const neg = m[1] === "-";
      if (m[2] != null) { tokens.push({ type: "phrase", value: m[2].toLowerCase(), neg }); continue; }
      const raw = m[3];
      if (raw.startsWith("@") && raw.length > 1) { tokens.push({ type: "from", value: raw.slice(1).toLowerCase(), neg }); continue; }
      if (raw.startsWith("#") && raw.length > 1) { tokens.push({ type: "tag", value: raw.slice(1).toLowerCase(), neg }); continue; }
      const idx = raw.indexOf(":");
      if (idx > 0) {
        const key = raw.slice(0, idx).toLowerCase(), value = raw.slice(idx + 1);
        if (FIELDS.has(key) && value) { tokens.push({ type: key, value: value.toLowerCase(), neg }); continue; }
      }
      tokens.push({ type: "term", value: raw.toLowerCase(), neg });
    }
    return tokens;
  }

  /** "k"/"m" suffixes: 50k → 50000 */
  function parseNumber(str) {
    const m = String(str).match(/^(\d+(?:\.\d+)?)([km])?$/i);
    if (!m) return NaN;
    const n = Number(m[1]);
    return m[2] ? n * (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : n;
  }
  /** ">3m", "<90s", "1m-5m", "=2m" → predicate over a number, using a value parser. */
  function rangePredicate(spec, parse) {
    const s = String(spec).trim();
    let m;
    if ((m = s.match(/^(>=|<=|>|<|=)(.+)$/))) {
      const v = parse(m[2]);
      if (Number.isNaN(v)) return null;
      return { ">": (x) => x > v, ">=": (x) => x >= v, "<": (x) => x < v, "<=": (x) => x <= v, "=": (x) => Math.abs(x - v) < 0.5 }[m[1]];
    }
    if ((m = s.match(/^([^-]+)-(.+)$/))) {
      const lo = parse(m[1]), hi = parse(m[2]);
      if (Number.isNaN(lo) || Number.isNaN(hi)) return null;
      return (x) => x >= lo && x <= hi;
    }
    const v = parse(s);
    return Number.isNaN(v) ? null : (x) => x >= v;
  }
  function datePredicate(kind, spec) {
    const t = util.parseDate(spec.length === 7 ? spec + "-01" : spec);
    if (!t) return null;
    const end = spec.length === 7 ? new Date(t).setMonth(new Date(t).getMonth() + 1) : t + 86400000;
    return kind === "before" ? (x) => x && x < t : (x) => x && x >= (kind === "after" ? end : t);
  }

  /**
   * Compile tokens into a predicate `(post, ctx) => boolean`.
   * ctx = { kindOf(post), isSeen(id), isStarred(id), isHidden(id), duration(post) }
   */
  function compile(input) {
    const tokens = tokenize(input);
    const tests = [];
    const hints = { sort: null, from: [] };
    for (const tk of tokens) {
      let test = null;
      switch (tk.type) {
        case "term":
        case "phrase": {
          const v = tk.value; test = (p) => p.haystack.includes(v); break;
        }
        case "from": {
          const v = tk.value; hints.from.push(v);
          test = (p) => p.author.username.toLowerCase().startsWith(v) || p.author.name.toLowerCase().includes(v); break;
        }
        case "tag": { const v = tk.value; test = (p) => p.hashtags.some((t) => t.startsWith(v)); break; }
        case "is": {
          const v = tk.value;
          test = (p, ctx) => {
            switch (v) {
              case "video": return p.media.some((m) => m.kind !== "photo");
              case "photo": case "image": return p.media.length > 0 && p.media.every((m) => m.kind === "photo");
              case "gif": return p.media.some((m) => m.kind === "gif");
              case "short": return ctx.kindOf(p) === "short";
              case "long": return ctx.kindOf(p) === "long";
              case "carousel": case "album": return p.media.length > 1;
              case "text": return p.media.length === 0;
              case "unseen": return !ctx.isSeen(p.id);
              case "seen": return ctx.isSeen(p.id);
              case "starred": case "liked": return ctx.isStarred(p.id);
              case "hidden": return ctx.isHidden(p.id);
              case "unavailable": case "dead": return !!ctx.isUnavailable?.(p.id);
              case "dup": case "duplicate": return !!ctx.isDuplicate?.(p.id);
              case "quote": return !!p.quoted;
              case "reply": return p.flags.reply;
              case "sensitive": return p.flags.sensitive;
              default: return true;
            }
          };
          break;
        }
        case "has": { const v = tk.value; test = (p) => (v === "link" || v === "links") ? p.links.length > 0 : v === "quote" ? !!p.quoted : true; break; }
        case "dur": { const pred = rangePredicate(tk.value, util.parseDurationSpec); if (pred) test = (p, ctx) => pred(ctx.duration(p)); break; }
        case "likes": { const pred = rangePredicate(tk.value, parseNumber); if (pred) test = (p) => pred(p.metrics.likes); break; }
        case "views": { const pred = rangePredicate(tk.value, parseNumber); if (pred) test = (p) => pred(p.metrics.views); break; }
        case "before": case "after": { const pred = datePredicate(tk.type, tk.value); if (pred) test = (p) => pred(p.createdAt); break; }
        case "saved": {
          const m = tk.value.match(/^(>|<)?(.+)$/);
          const pred = datePredicate(m[1] === "<" ? "before" : "after", m[2]);
          if (pred) test = (p) => pred(p.savedAt); break;
        }
        case "sort": hints.sort = tk.value; break;
      }
      if (test) tests.push(tk.neg ? (p, ctx) => !test(p, ctx) : test);
    }
    const predicate = tests.length ? (p, ctx) => tests.every((t) => t(p, ctx)) : () => true;
    return { predicate, tokens, hints, empty: tests.length === 0 };
  }

  return { tokenize, compile, parseNumber, rangePredicate };
});
