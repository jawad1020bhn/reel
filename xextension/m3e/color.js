/* AUTO-GENERATED — do not edit.
   Mirrored from dashboard/m3e/color.js by tools/sync-shared.mjs.
   Edit the original and re-run:  node tools/sync-shared.mjs */
/* =============================================================================
   M3E · Colour Engine
   Implements Material 3 colour system (tonal palettes, dynamic scheme).
   Based on the official Material Design 3 colour algorithm.
   ============================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.M3EColor = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_SEED = "#5B4CF5"; // Ultraviolet
  const DEFAULT_VARIANT = "vibrant"; // 'vibrant' | 'expressive'

  /* ---------------------------------------------------------------------------
     Helpers
     --------------------------------------------------------------------------- */
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function srgbToLinear(c) {
    c = c / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c) {
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1/2.4) - 0.055));
  }
  function rgbToXyz(r, g, b) {
    r = srgbToLinear(r); g = srgbToLinear(g); b = srgbToLinear(b);
    return [
      0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
      0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
      0.0193339 * r + 0.1191920 * g + 0.9503041 * b
    ];
  }
  function xyzToLab(x, y, z) {
    const ref = [0.95047, 1.0, 1.08883];
    const f = t => t > 0.008856 ? Math.pow(t, 1/3) : 7.787 * t + 16/116;
    const fx = f(x / ref[0]), fy = f(y / ref[1]), fz = f(z / ref[2]);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function labToLch(l, a, b) {
    const c = Math.sqrt(a*a + b*b);
    const h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    return [l, c, h];
  }
  function lchToLab(l, c, h) {
    const rad = h * Math.PI / 180;
    return [l, c * Math.cos(rad), c * Math.sin(rad)];
  }
  function labToXyz(l, a, b) {
    const ref = [0.95047, 1.0, 1.08883];
    const fy = (l + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;
    const ft = t => t > 0.206893 ? t*t*t : (t - 16/116) / 7.787;
    return [
      ref[0] * ft(fx),
      ref[1] * ft(fy),
      ref[2] * ft(fz)
    ];
  }
  function xyzToRgb(x, y, z) {
    const r =  3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    const g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
    const b =  0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
    return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)] : null;
  }
  function rgbToHex(r, g, b) {
    return "#" + [r,g,b].map(v => clamp(v,0,255).toString(16).padStart(2,"0")).join("");
  }

  function parseHex(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)] : null;
  }

  /* ---------------------------------------------------------------------------
     Tonal palette (M3)
     --------------------------------------------------------------------------- */
  function tonalPalette(hue, chroma) {
    const palette = new Array(101);
    /* Tones ARE L*: 0 is black, 100 is white, and the role table below picks
       the tone that matches the theme (40 for light primaries, 80 for dark).
       Chroma peaks in the mid-tones and falls to zero at both ends, so a
       palette never produces a neon white or a fully saturated black. */
    const maxChroma = Math.min(chroma, 48);
    for (let tone = 0; tone <= 100; tone++) {
      const l = tone;
      const c = maxChroma * Math.sin((Math.PI * tone) / 100);
      const [l3, a, b_lch] = lchToLab(l, c, hue);
      const [x, y, z] = labToXyz(l3, a, b_lch);
      const [r, g, b_rgb] = xyzToRgb(x, y, z);
      palette[tone] = rgbToHex(r, g, b_rgb);
    }
    return palette;
  }

  function seedToHueChroma(seedHex) {
    const rgb = parseHex(seedHex);
    if (!rgb) return { hue: 268, chroma: 48 };
    const [x, y, z] = rgbToXyz(rgb[0], rgb[1], rgb[2]);
    const [l, a, b] = xyzToLab(x, y, z);
    const [l2, c, h] = labToLch(l, a, b);
    return { hue: h, chroma: c };
  }

  /* ---------------------------------------------------------------------------
     Scheme construction (M3)
     --------------------------------------------------------------------------- */
  function scheme(seedHex, { dark, variant, contrast } = {}) {
    const { hue, chroma } = seedToHueChroma(seedHex);
    /* A vivid seed can carry ~100 chroma; scale every palette by the same
       factor so the primary lands at the M3 ceiling without flattening the
       secondary/tertiary relationship to it. */
    const chromaScale = Math.min(1, 48 / Math.max(chroma, 1));
    const primaryPalette = tonalPalette(hue, chroma * chromaScale);
    const secondaryPalette = tonalPalette(hue, chroma * 0.5 * chromaScale);
    const tertiaryPalette = tonalPalette((hue + 60) % 360, chroma * 0.5 * chromaScale);
    const neutralPalette = tonalPalette(hue, chroma * 0.12 * chromaScale);
    const neutralVariantPalette = tonalPalette(hue, chroma * 0.16 * chromaScale);
    const errorPalette = tonalPalette(25, 84);

    const isExpressive = variant === "expressive";
    const primaryHue = isExpressive ? (hue + 240) % 360 : hue;

    const roles = {};
    roles.primary = dark ? primaryPalette[80] : primaryPalette[40];
    roles.onPrimary = dark ? primaryPalette[20] : primaryPalette[100];
    roles.primaryContainer = dark ? primaryPalette[30] : primaryPalette[90];
    roles.onPrimaryContainer = dark ? primaryPalette[90] : primaryPalette[10];
    roles.secondary = dark ? secondaryPalette[80] : secondaryPalette[40];
    roles.onSecondary = dark ? secondaryPalette[20] : secondaryPalette[100];
    roles.secondaryContainer = dark ? secondaryPalette[30] : secondaryPalette[90];
    roles.onSecondaryContainer = dark ? secondaryPalette[90] : secondaryPalette[10];
    roles.tertiary = dark ? tertiaryPalette[80] : tertiaryPalette[40];
    roles.onTertiary = dark ? tertiaryPalette[20] : tertiaryPalette[100];
    roles.tertiaryContainer = dark ? tertiaryPalette[30] : tertiaryPalette[90];
    roles.onTertiaryContainer = dark ? tertiaryPalette[90] : tertiaryPalette[10];
    roles.error = dark ? errorPalette[80] : errorPalette[40];
    roles.onError = dark ? errorPalette[20] : errorPalette[100];
    roles.errorContainer = dark ? errorPalette[30] : errorPalette[90];
    roles.onErrorContainer = dark ? errorPalette[90] : errorPalette[10];
    /* Dark surfaces start at tone 6, not 10: the container ladder below needs
       headroom, and a surface sitting on the same tone as surfaceContainerLow
       erases every card and tile drawn on it. */
    roles.background = dark ? neutralPalette[6] : neutralPalette[99];
    roles.onBackground = dark ? neutralPalette[90] : neutralPalette[10];
    roles.surface = dark ? neutralPalette[6] : neutralPalette[99];
    roles.onSurface = dark ? neutralPalette[90] : neutralPalette[10];
    roles.surfaceVariant = dark ? neutralVariantPalette[30] : neutralVariantPalette[90];
    roles.onSurfaceVariant = dark ? neutralVariantPalette[80] : neutralVariantPalette[30];
    roles.outline = dark ? neutralVariantPalette[60] : neutralVariantPalette[50];
    roles.outlineVariant = dark ? neutralVariantPalette[30] : neutralVariantPalette[80];
    roles.shadow = "#000000";
    roles.scrim = "#000000";
    roles.inverseSurface = dark ? neutralPalette[90] : neutralPalette[20];
    roles.inverseOnSurface = dark ? neutralPalette[20] : neutralPalette[90];
    roles.inversePrimary = dark ? primaryPalette[40] : primaryPalette[80];
    roles.primaryFixed = primaryPalette[90];
    roles.onPrimaryFixed = primaryPalette[10];
    roles.primaryFixedDim = primaryPalette[80];
    roles.onPrimaryFixedVariant = primaryPalette[30];
    roles.secondaryFixed = secondaryPalette[90];
    roles.onSecondaryFixed = secondaryPalette[10];
    roles.secondaryFixedDim = secondaryPalette[80];
    roles.onSecondaryFixedVariant = secondaryPalette[30];
    roles.tertiaryFixed = tertiaryPalette[90];
    roles.onTertiaryFixed = tertiaryPalette[10];
    roles.tertiaryFixedDim = tertiaryPalette[80];
    roles.onTertiaryFixedVariant = tertiaryPalette[30];
    roles.surfaceDim = dark ? neutralPalette[6] : neutralPalette[87];
    roles.surfaceBright = dark ? neutralPalette[24] : neutralPalette[98];
    roles.surfaceContainerLowest = dark ? neutralPalette[4] : neutralPalette[100];
    roles.surfaceContainerLow = dark ? neutralPalette[10] : neutralPalette[96];
    roles.surfaceContainer = dark ? neutralPalette[12] : neutralPalette[94];
    roles.surfaceContainerHigh = dark ? neutralPalette[17] : neutralPalette[92];
    roles.surfaceContainerHighest = dark ? neutralPalette[22] : neutralPalette[90];

    return { roles, palettes: { primary: primaryPalette, secondary: secondaryPalette, tertiary: tertiaryPalette, neutral: neutralPalette, neutralVariant: neutralVariantPalette, error: errorPalette } };
  }

  return { scheme, DEFAULT_SEED, DEFAULT_VARIANT, parseHex, tonalPalette, seedToHueChroma };
});
