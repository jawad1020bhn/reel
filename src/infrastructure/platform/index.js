/* infra.platform — PlatformPort: browser capabilities behind a flat API, with
   graceful fallbacks for file:// (where crypto.subtle may be unavailable in some
   browsers and clipboard access needs a user gesture). */
XR.define("infra.platform", [], function () {
  "use strict";
  const isFile = () => typeof location !== "undefined" && location.protocol === "file:";

  async function copy(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
  async function share(data) {
    try { if (navigator.share) { await navigator.share(data); return true; } } catch { /* cancelled */ }
    return false;
  }
  /** Download a Blob/string as a file (same-origin); remote URLs open in a new tab. */
  async function download(urlOrBlob, name = "download") {
    try {
      if (typeof urlOrBlob === "string" && /^https?:/.test(urlOrBlob)) { openExternal(urlOrBlob); return true; }
      const blob = urlOrBlob instanceof Blob ? urlOrBlob : new Blob([urlOrBlob], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return true;
    } catch (err) { console.warn("[platform] download failed", err); return false; }
  }
  function openExternal(url) { try { window.open(url, "_blank", "noopener,noreferrer"); } catch { location.href = url; } }

  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  async function fullscreen(el = document.documentElement) {
    try {
      if (fsEl()) { await exitFullscreen(); return false; }
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      return true;
    } catch { return false; }
  }
  async function exitFullscreen() { try { if (document.exitFullscreen) await document.exitFullscreen(); else if (document.webkitExitFullscreen) document.webkitExitFullscreen(); } catch { /* ignore */ } }
  const isFullscreen = () => !!fsEl();
  const isTouch = () => (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) || navigator.maxTouchPoints > 0;
  /* A touchscreen laptop has a fine pointer as well; hover UI should follow the
     pointer, not the presence of a touch digitizer. */
  const canHover = () => typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
  const canShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";
  const canPip = () => typeof document !== "undefined" && !!document.pictureInPictureEnabled && typeof HTMLVideoElement !== "undefined" && typeof HTMLVideoElement.prototype.requestPictureInPicture === "function";
  const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const prefersDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const dpr = () => (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  const vibrate = (ms = 10) => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* ignore */ } };

  /* ---- hashing: WebCrypto when available (secure contexts incl. file:// in Chromium), else a JS SHA-256 */
  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    try {
      if (crypto?.subtle?.digest) {
        const buf = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    } catch { /* fall back */ }
    return sha256js(bytes);
  }
  function randomId(bytes = 16) {
    const arr = new Uint8Array(bytes);
    if (crypto?.getRandomValues) crypto.getRandomValues(arr); else for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
    return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Compact SHA-256 (FIPS 180-4) for environments without SubtleCrypto.
  function sha256js(msg) {
    const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const l = msg.length, padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
    padded.set(msg); padded[l] = 0x80;
    const dv = new DataView(padded.buffer); dv.setUint32(padded.length - 4, l * 8 >>> 0); dv.setUint32(padded.length - 8, Math.floor(l * 8 / 2 ** 32));
    const w = new Uint32Array(64), rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) { const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0; }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return [...H].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
  }

  return { copy, share, download, openExternal, fullscreen, exitFullscreen, isFullscreen, isTouch, canHover, canShare, canPip, reducedMotion, prefersDark, dpr, vibrate, sha256, randomId, isFile };
});
