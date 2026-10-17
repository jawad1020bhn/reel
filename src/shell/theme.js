/* shell.theme — applies appearance preferences to <html> as data-attributes so
   CSS tokens can react: data-theme, data-accent, data-density, data-motion, data-blur.
   Also handles the "discreet" tab title/icon. */
XR.define("shell.theme", ["app.prefs", "app.ports.platform", "core.i18n"], function (prefs, platform, i18n) {
  "use strict";
  const root = document.documentElement;
  const APP_TITLE = "XReels";
  let mq = null;

  function resolvedTheme() {
    /* 2026 cinematic design: dark-only. The artwork is authored for black;
       a light mode would break every scrim, so the pref is intentionally ignored. */
    return "dark";
  }
  function apply() {
    root.dataset.theme = "dark";
    root.dataset.density = prefs.get("density");
    const rm = prefs.get("reduceMotion");
    root.dataset.motion = rm === "system" ? (platform.reducedMotion() ? "reduce" : "full") : rm === "on" ? "reduce" : "full";
    root.dataset.blur = prefs.get("blur") ? "on" : "off";
    root.dataset.touch = platform.isTouch() ? "on" : "off";
    root.dataset.file = platform.isFile() ? "on" : "off";
    i18n.setLocale(prefs.get("language"));
    root.lang = i18n.locale; root.dir = i18n.dir();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = "#141414";
    setTitle();
  }
  let currentTitle = "";
  function setTitle(section = currentTitle) {
    currentTitle = section;
    const discreet = prefs.get("discreet");
    document.title = discreet ? "Notes" : section ? `${section} · ${APP_TITLE}` : APP_TITLE;
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.href = discreet ? ICON_NEUTRAL : ICON_APP;
  }
  const ICON_APP = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#101012"/><path d="M22 18l26 28M48 18L22 46" stroke="#e50914" stroke-width="8" stroke-linecap="round"/></svg>');
  const ICON_NEUTRAL = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#e5e7eb"/><path d="M18 22h28M18 32h28M18 42h18" stroke="#6b7280" stroke-width="5" stroke-linecap="round"/></svg>');

  function start() {
    XR.resolveAll("core.i18n.");   // instantiate every registered dictionary (core.i18n.ar, …)
    apply();
    prefs.onChange(({ patch }) => { if (["density", "reduceMotion", "blur", "discreet", "language"].some((k) => k in patch)) apply(); });
    if (typeof matchMedia === "function" && platform.prefersDark) {
      mq = matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener?.("change", () => { /* dark-only */ });
    }
  }
  return { start, apply, setTitle, resolvedTheme, APP_TITLE };
});
