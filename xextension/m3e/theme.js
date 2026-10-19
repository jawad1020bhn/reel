/* AUTO-GENERATED — do not edit.
   Mirrored from dashboard/m3e/theme.js by tools/sync-shared.mjs.
   Edit the original and re-run:  node tools/sync-shared.mjs */
/* =============================================================================
   M3E · Theme Runtime
   Applies a dynamic colour scheme to --md-sys-color-* custom properties and
   owns the personalisation surface (seed / variant / contrast / scheme /
   density / motion).
   ============================================================================= */
(function (root, factory) {
  var color =
    root && root.M3EColor
      ? root.M3EColor
      : typeof module === "object" && module.exports
      ? require("./color.js")
      : null;
  var api = factory(color);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.M3ETheme = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this, function (M3EColor) {
  "use strict";

  const KEBAB = (s) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

  const DEFAULTS = {
    seed: M3EColor.DEFAULT_SEED,
    variant: M3EColor.DEFAULT_VARIANT,
    contrast: "standard",
    scheme: "system",
    density: "comfortable",
    reducedMotion: false,
  };

  const SEEDS = [
    { name: "Ultraviolet", hex: "#5B4CF5" },
    { name: "Signal", hex: "#1D9BF0" },
    { name: "Kelp", hex: "#0F7B6C" },
    { name: "Fern", hex: "#2E7D46" },
    { name: "Ember", hex: "#D2542B" },
    { name: "Orchid", hex: "#B0399B" },
  ];

  function seedPreview(seedHex, settings) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const built = M3EColor.scheme(seedHex, {
      dark: resolveDark(s),
      variant: s.variant,
      contrast: s.contrast,
    });
    return { primary: built.roles.primary, onPrimary: built.roles.onPrimary };
  }

  function prefersDark() {
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function prefersReducedMotion() {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  function prefersMoreContrast() {
    return typeof matchMedia === "function" && matchMedia("(prefers-contrast: more)").matches;
  }

  function resolveDark(settings) {
    if (settings.scheme === "dark") return true;
    if (settings.scheme === "light") return false;
    return prefersDark();
  }

  function apply(settings, target) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const el = target || (typeof document !== "undefined" ? document.documentElement : null);
    if (!el) return null;

    const dark = resolveDark(s);
    const contrast = s.contrast === "standard" && prefersMoreContrast() ? "medium" : s.contrast;

    const built = M3EColor.scheme(s.seed, { dark, variant: s.variant, contrast });

    for (const role in built.roles) {
      const hex = built.roles[role];
      el.style.setProperty("--md-sys-color-" + KEBAB(role), hex);
      const rgb = M3EColor.parseHex(hex);
      if (rgb) el.style.setProperty("--md-sys-color-" + KEBAB(role) + "-rgb", rgb.join(" "));
    }

    el.style.setProperty("--md-sys-color-scrim-overlay", dark ? "rgb(0 0 0 / 0.60)" : "rgb(0 0 0 / 0.40)");

    el.dataset.scheme = dark ? "dark" : "light";
    el.dataset.contrast = contrast;
    el.dataset.variant = s.variant;
    el.dataset.density = s.density;
    el.dataset.motion = s.reducedMotion || prefersReducedMotion() ? "reduced" : "full";
    el.style.colorScheme = dark ? "dark" : "light";

    return built;
  }

  function createController(initial, onChange) {
    let settings = Object.assign({}, DEFAULTS, initial || {});
    let built = apply(settings);
    const listeners = new Set();
    if (onChange) listeners.add(onChange);

    const repaint = () => {
      built = apply(settings);
      listeners.forEach((fn) => fn(settings, built));
    };

    if (typeof matchMedia === "function") {
      const bind = (query, guard) => {
        const mq = matchMedia(query);
        const handler = () => { if (guard()) repaint(); };
        if (mq.addEventListener) mq.addEventListener("change", handler);
        else if (mq.addListener) mq.addListener(handler);
      };
      bind("(prefers-color-scheme: dark)", () => settings.scheme === "system");
      bind("(prefers-reduced-motion: reduce)", () => true);
      bind("(prefers-contrast: more)", () => settings.contrast === "standard");
    }

    return {
      get settings() { return Object.assign({}, settings); },
      get current() { return built; },
      set(patch) {
        settings = Object.assign({}, settings, patch);
        repaint();
        return settings;
      },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      repaint,
    };
  }

  return { apply, createController, DEFAULTS, SEEDS, seedPreview, resolveDark, prefersDark, prefersReducedMotion };
});