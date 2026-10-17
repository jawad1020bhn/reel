/* core.adapters.registry — format detection and normalisation.

   An adapter is { id, label, score(json) → 0..1, normalize(json) → Post[] }.
   `detect` picks the highest score. Adding a new export format = one new file
   under src/core/adapters/ that calls registry.register(); nothing else changes.
*/
XR.define("core.adapters.registry", ["core.domain.model"], function (model) {
  "use strict";

  /** @type {Map<string, {id:string,label:string,score:Function,normalize:Function}>} */
  const adapters = new Map();

  function register(adapter) {
    if (!adapter?.id || typeof adapter.score !== "function" || typeof adapter.normalize !== "function") {
      throw new Error("adapter needs {id, score(), normalize()}");
    }
    adapters.set(adapter.id, adapter);
    return adapter;
  }

  /** Accepts a parsed object/array or JSON text (optionally wrapped as `window.X = {...};`). */
  function parseInput(input) {
    if (input == null) throw new Error("No data");
    if (typeof input !== "string") return input;
    let text = input.trim();
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    // Tolerate a data/posts.js style wrapper.
    text = text.replace(/^\/\*[\s\S]*?\*\/\s*/, "").replace(/^(\/\/[^\n]*\n\s*)+/, "");
    text = text.replace(/^(?:window\.|globalThis\.|var |let |const )?[\w$]+\s*=\s*/, "");
    text = text.replace(/;\s*$/, "");
    if (!text) throw new Error("The file is empty");
    try { return JSON.parse(text); }
    catch (err) { throw new Error("Not valid JSON: " + (err.message || err)); }
  }

  function detect(json) {
    let best = null, bestScore = 0;
    for (const adapter of adapters.values()) {
      let s = 0;
      try { s = Number(adapter.score(json)) || 0; } catch { s = 0; }
      if (s > bestScore) { best = adapter; bestScore = s; }
    }
    return bestScore > 0 ? { adapter: best, score: bestScore } : null;
  }

  /**
   * Full pipeline: parse → detect → normalise → dedupe.
   * @returns {{posts: Post[], adapter: string, label: string, dropped: number, textOnly: number}}
   */
  function normalize(input, options = {}) {
    const json = parseInput(input);
    const found = detect(json);
    if (!found) throw new Error("Unrecognised format. Expected an X bookmarks export (see docs/DATA-FORMATS.md).");
    const raw = found.adapter.normalize(json) || [];
    const seen = new Set();
    const posts = [];
    let dropped = 0, textOnly = 0;
    for (const partial of raw) {
      if (!partial || !partial.id) { dropped++; continue; }
      const post = model.createPost({ ...partial, source: found.adapter.id });
      if (seen.has(post.id)) { dropped++; continue; }
      seen.add(post.id);
      if (!post.media.length) {
        textOnly++;
        if (options.keepTextOnly === false) continue;
      }
      posts.push(post);
    }
    return { posts, adapter: found.adapter.id, label: found.adapter.label, dropped, textOnly };
  }

  /**
   * Same pipeline, but builds posts in chunks and yields between them so the UI
   * (splash/progress) stays responsive on very large exports. onProgress(done, total).
   */
  async function normalizeAsync(input, options = {}, onProgress = null) {
    const json = parseInput(input);
    const found = detect(json);
    if (!found) throw new Error("Unrecognised format. Expected an X bookmarks export (see docs/DATA-FORMATS.md).");
    const raw = found.adapter.normalize(json) || [];
    const chunk = options.chunk || 400;
    const seen = new Set();
    const posts = [];
    let dropped = 0, textOnly = 0;
    for (let i = 0; i < raw.length; i += chunk) {
      for (const partial of raw.slice(i, i + chunk)) {
        if (!partial || !partial.id) { dropped++; continue; }
        const post = model.createPost({ ...partial, source: found.adapter.id });
        if (seen.has(post.id)) { dropped++; continue; }
        seen.add(post.id);
        if (!post.media.length) { textOnly++; if (options.keepTextOnly === false) continue; }
        posts.push(post);
      }
      if (onProgress) onProgress(Math.min(i + chunk, raw.length), raw.length);
      if (i + chunk < raw.length) await new Promise((r) => setTimeout(r, 0));
    }
    return { posts, adapter: found.adapter.id, label: found.adapter.label, dropped, textOnly };
  }

  return { register, detect, normalize, normalizeAsync, parseInput, list: () => [...adapters.values()] };
});
