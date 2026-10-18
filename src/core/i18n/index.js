/* core.i18n — tiny translation layer. Keys ARE the English strings, so untranslated text
   falls back to English automatically and call sites stay readable:
       t("Shuffle play")            t("{n} posts", { n: 12 })
   Widgets (ui.widgets, ui.toast, ui.dialog, ui.menu, ui.rail, shell.layout) translate their
   labels themselves, so most feature code needs no t() at all. Dictionaries register with
   i18n.register(code, { "English": "translation" }, { dir: "ltr", name: "English" }).
   Locale comes from prefs ("auto" = navigator.language). The app ships English only —
   a dictionary is added by dropping a file in src/core/i18n/ and listing it in the manifest. */
XR.define("core.i18n", [], function () {
  "use strict";
  const dicts = new Map();      // code → { strings, meta }
  let current = "en";
  const listeners = new Set();

  function register(code, strings, meta = {}) {
    const prev = dicts.get(code);
    /* A dictionary declares its own direction; anything without one reads left to right. */
    dicts.set(code, { strings: { ...(prev?.strings || {}), ...strings }, meta: { name: code, dir: "ltr", ...(prev?.meta || {}), ...meta } });
  }
  register("en", {}, { name: "English", dir: "ltr" });

  const detect = () => { const l = (typeof navigator !== "undefined" && (navigator.language || "")).slice(0, 2).toLowerCase(); return dicts.has(l) ? l : "en"; };
  function setLocale(code) {
    const next = !code || code === "auto" ? detect() : (dicts.has(code) ? code : "en");
    if (next === current) return current;
    current = next;
    for (const fn of listeners) { try { fn(current); } catch { /* ignore */ } }
    return current;
  }
  const interpolate = (s, params) => params ? s.replace(/\{(\w+)\}/g, (_, k) => (params[k] == null ? "" : String(params[k]))) : s;
  /** Translate; unknown keys return the key itself (English). */
  function t(key, params) {
    if (key == null) return "";
    const d = dicts.get(current);
    const s = (d && d.strings[key]) || key;
    return interpolate(s, params);
  }
  /** Plural-aware: tn(n, "one post", "{n} posts") — dictionaries may override both forms. */
  const tn = (n, one, many) => t(n === 1 ? one : many, { n });
  const dir = () => (dicts.get(current)?.meta.dir) || "ltr";
  const isRTL = () => dir() === "rtl";
  const locales = () => [...dicts.entries()].map(([code, d]) => ({ code, name: d.meta.name, dir: d.meta.dir }));
  const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  /* locale-aware formatting helpers (Intl falls back gracefully) */
  const intlLocale = () => current;
  const number = (n) => { try { return new Intl.NumberFormat(intlLocale()).format(n); } catch { return String(n); } };
  const date = (ms, opts = { year: "numeric", month: "short", day: "numeric" }) => { try { return new Intl.DateTimeFormat(intlLocale(), opts).format(new Date(ms)); } catch { return new Date(ms).toLocaleDateString(); } };
  return { t, tn, register, setLocale, get locale() { return current; }, dir, isRTL, locales, onChange, number, date, has: (code) => dicts.has(code) };
});
