/* ui.dom — tiny DOM toolkit: h() hyperscript, formatting helpers, event helpers.
   No framework: the app renders real elements and keeps references. */
XR.define("ui.dom", ["core.util"], function (util) {
  "use strict";

  /**
   * h("div.card.active#main", { onclick, dataset:{}, style:{}, attrs… }, ...children)
   * Children: Node | string | number | null | false | array (flattened).
   */
  function h(spec, props, ...children) {
    if (props && (props instanceof Node || typeof props !== "object" || Array.isArray(props))) { children.unshift(props); props = null; }
    const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec) || [];
    const el = document.createElement(m[1] || "div");
    if (m[2]) for (const part of m[2].match(/[.#][\w-]+/g) || []) { if (part[0] === ".") el.classList.add(part.slice(1)); else el.id = part.slice(1); }
    if (props) applyProps(el, props);
    append(el, children);
    return el;
  }
  function applyProps(el, props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class" || k === "className") { for (const c of String(v).split(/\s+/)) if (c) el.classList.add(c); }
      else if (k === "style" && typeof v === "object") { for (const [sk, sv] of Object.entries(v)) { if (sv == null) continue; if (sk.startsWith("--")) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "html") el.innerHTML = v;
      else if (k === "text") el.textContent = v;
      else if (k === "ref") v(el);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "aria") { for (const [ak, av] of Object.entries(v)) el.setAttribute("aria-" + ak, av); }
      else if (k in el && typeof el[k] !== "object" && k !== "list" && k !== "form") { try { el[k] = v; } catch { el.setAttribute(k, v); } }
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  function append(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false || c === true) continue;
      if (Array.isArray(c)) append(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
    return el;
  }
  const frag = (...children) => append(document.createDocumentFragment(), children);
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function replace(el, ...children) { clear(el); return append(el, children); }
  function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); return () => target.removeEventListener(type, fn, opts); }
  /** Event delegation: on(parent, "click", "[data-action]", (e, matchedEl) => …) */
  function delegate(parent, type, selector, fn, opts) {
    return on(parent, type, (e) => { const t = e.target instanceof Element ? e.target.closest(selector) : null; if (t && parent.contains(t)) fn(e, t); }, opts);
  }
  const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ----------------------------------------------------------- formats -- */
  const nf = typeof Intl !== "undefined" ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }) : null;
  const compact = (n) => (n == null ? "" : nf ? nf.format(n) : String(n));
  function duration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }
  function hours(sec) { const h = sec / 3600; return h >= 10 ? `${Math.round(h)} h` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(sec / 60)} min`; }
  function relative(ts, now = Date.now()) {
    if (!ts) return "";
    const d = Math.round((now - ts) / 1000);
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
    if (d < 86400 * 365) return `${Math.floor(d / (86400 * 30))}mo ago`;
    return `${Math.floor(d / (86400 * 365))}y ago`;
  }
  const dateFmt = typeof Intl !== "undefined" ? new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;
  const date = (ts) => (ts ? (dateFmt ? dateFmt.format(new Date(ts)) : new Date(ts).toDateString()) : "");
  const dateTimeFmt = typeof Intl !== "undefined" ? new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  const dateTime = (ts) => (ts ? (dateTimeFmt ? dateTimeFmt.format(new Date(ts)) : new Date(ts).toLocaleString()) : "");
  function bytes(n) { if (!n) return "0 B"; const u = ["B", "KB", "MB", "GB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; }
  function greeting(d = new Date()) { const hr = d.getHours(); return hr < 5 ? "Night owl" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"; }

  /** Linkify @mentions, #hashtags and URLs in post text into a fragment. */
  function richText(text, { onTag, onUser } = {}) {
    const out = document.createDocumentFragment();
    const re = /(https?:\/\/[^\s]+)|([@#][\p{L}\p{N}_]+)/gu;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) out.appendChild(h("a", { href: m[1], target: "_blank", rel: "noopener noreferrer", class: "link" }, util.truncate(m[1].replace(/^https?:\/\//, ""), 40)));
      else {
        const isTag = m[2][0] === "#";
        const a = h("a", { href: "#", class: "link link-" + (isTag ? "tag" : "user"), onclick: (e) => { e.preventDefault(); (isTag ? onTag : onUser)?.(m[2].slice(1)); } }, m[2]);
        out.appendChild(a);
      }
      last = re.lastIndex;
    }
    if (last < text.length) out.appendChild(document.createTextNode(text.slice(last)));
    return out;
  }

  /** requestAnimationFrame-throttled callback. */
  function rafThrottle(fn) { let id = 0, args; return (...a) => { args = a; if (!id) id = requestAnimationFrame(() => { id = 0; fn(...args); }); }; }
  const isEditable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  return { h, frag, clear, replace, append, on, delegate, escape, compact, duration, hours, relative, date, dateTime, bytes, greeting, richText, rafThrottle, isEditable };
});
