/* app.shuffle — one place that deals and explains a smart-shuffle deck.

   The engine (core.query.engine smartShuffle) knows why each post landed where it did, but
   only when it is asked for `explain`. Two surfaces want that answer: Settings ("Explain my
   deck") and the command palette ("Why is my deck in this order?"). Keeping the deck/seed
   and the table-building here means both show the same thing, and neither re-implements the
   weights. This module owns no state: it deals a fresh deck on every call. */
XR.define("app.shuffle", ["app.catalog", "app.activity"], function (catalog, activity) {
  "use strict";

  const newSeed = () => 1 + Math.floor(Math.random() * 2147483646);

  /**
   * Deal a deck the same way the Library would, and return the reason table.
   * @param {{limit?: number, spec?: object, seed?: number, remember?: boolean}} opts
   *   remember (default true) stores the deck's opening so the next shuffle demotes it —
   *   asking "why?" should not change the deck you would otherwise have seen... but it is
   *   a real deck, so by default it is remembered like any other.
   * @returns {{seed: number, total: number, items: Post[], rows: Array, explain: Map|null}}
   */
  function explain({ limit = 12, spec = {}, seed = newSeed(), remember = true } = {}) {
    const res = catalog.query({ kind: "all", ...spec, sort: "smart", seed, limit, explain: true });
    if (remember && res.items.length) activity.rememberDeck(seed, res.items.map((p) => p.id));
    const rows = res.items.map((post, i) => {
      const e = res.explain?.get(post.id) || {};
      /* reasons in the order they matter: what moved the weight, then what had to give */
      const notes = Array.isArray(e.notes) ? e.notes : [];
      const broke = Array.isArray(e.broke) ? e.broke : [];
      return {
        rank: i + 1,
        id: post.id,
        post,
        creator: post.author?.username || "",
        kind: catalog.ctx.kindOf(post),
        weight: Number(e.weight) || 0,
        lead: !!e.lead,
        notes,
        broke,
      };
    });
    return { seed, total: res.total, items: res.items, rows, explain: res.explain || null };
  }

  /** Human-readable one-liner for a row (used by the palette's inline preview). */
  function describeRow(row) {
    if (!row) return "";
    const bits = [];
    if (row.lead) bits.push("lead slot");
    bits.push(...row.notes);
    if (row.broke.length) bits.push("broke: " + row.broke.join(", "));
    return bits.join(" · ") || "neutral weight";
  }

  return { explain, describeRow, newSeed };
});
