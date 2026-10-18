/* ui.widgets — small reusable controls: chips, segmented control, toggle switch,
   select, field rows, empty state, spinner, stat cards, section headers, kbd. */
XR.define("ui.widgets", ["ui.dom", "ui.icons", "core.i18n"], function (dom, icons, i18n) {
  "use strict";
  const h = dom.h;
  const t = (s) => (typeof s === "string" ? i18n.t(s) : s);

  const chip = ({ label, icon, count, active = false, onClick, onRemove, cls = "", title }) =>
    h("button.chip", { class: (active ? "active " : "") + cls, onclick: onClick, title, "aria-pressed": active ? "true" : "false" },
      icon ? icons.icon(icon, 14) : null, h("span.chip-label", t(label)), count != null ? h("span.chip-count", dom.compact(count)) : null,
      onRemove ? h("span.chip-x", { onclick: (e) => { e.stopPropagation(); onRemove(); } }, icons.icon("x", 12)) : null);

  /** segmented([{value,label,icon}], value, onChange) */
  function segmented(options, value, onChange, { cls = "", size = "" } = {}) {
    const el = h("div.segmented", { class: cls + (size ? " segmented-" + size : ""), role: "radiogroup" });
    const render = () => dom.replace(el, options.map((o) => h("button.seg", { role: "radio", class: o.value === value ? "active" : "", "aria-checked": o.value === value ? "true" : "false", title: t(o.title || o.label), onclick: () => { if (o.value !== value) { value = o.value; render(); onChange(value); } } }, o.icon ? icons.icon(o.icon, 15) : null, o.label ? h("span", t(o.label)) : null)));
    render();
    el.set = (v) => { value = v; render(); };
    return el;
  }
  function toggle(checked, onChange, { label = "" } = {}) {
    const input = h("input", { type: "checkbox", checked: !!checked, onchange: () => onChange(input.checked) });
    const el = h("label.switch", input, h("span.switch-track", h("span.switch-thumb")), label ? h("span.switch-label", t(label)) : null);
    el.set = (v) => { input.checked = !!v; };
    return el;
  }
  function select(options, value, onChange, { cls = "" } = {}) {
    const el = h("select.select", { class: cls, onchange: () => onChange(el.value) }, options.map((o) => h("option", { value: o.value, selected: o.value === value }, t(o.label))));
    return el;
  }
  function numberInput(value, onChange, { min, max, step = 1, suffix = "" } = {}) {
    const input = h("input.input.input-num", { type: "number", value, min, max, step, onchange: () => onChange(Number(input.value)) });
    return suffix ? h("div.input-suffix", input, h("span", suffix)) : input;
  }
  /** A settings row: label + description + control. */
  const row = (label, description, control, { cls = "" } = {}) => h("div.row", { class: cls }, h("div.row-text", h("div.row-label", t(label)), description ? h("div.row-desc", t(description)) : null), h("div.row-control", control));
  const section = (title, description, ...children) => h("section.section", h("header.section-head", h("h2.section-title", t(title)), description ? h("p.section-desc", t(description)) : null), ...children);
  const empty = ({ icon = "inbox", title, text, action }) => h("div.empty", icons.icon(icon, 40), h("h3.empty-title", t(title)), text ? h("p.empty-text", t(text)) : null, action ? h("button.btn.btn-primary", { onclick: action.run }, action.icon ? icons.icon(action.icon, 16) : null, t(action.label)) : null);
  const spinner = (label = "") => h("div.spinner-wrap", h("span.spinner"), label ? h("span.muted", label) : null);
  const stat = (value, label, icon) => h("div.stat", icon ? icons.icon(icon, 18) : null, h("div.stat-value", value), h("div.stat-label", t(label)));
  const kbd = (keys) => h("span.kbds", String(keys).split(" ").map((k) => h("kbd", k)));
  /** Top-level pages: no display title (the nav already names the page) — a quiet mono
      info line on the left, the page's controls on the right. The h1 stays for assistive tech. */
  const pageBar = (title, subtitle, ...right) => h("header.page-head.page-bar",
    h("div.page-bar-text", h("h1.page-title.sr-only", t(title)), subtitle ? h("p.page-sub", t(subtitle)) : null),
    right.length ? h("div.page-actions", ...right) : null);
  const pageHead = (title, subtitle, ...right) => h("header.page-head", h("div", h("h1.page-title", t(title)), subtitle ? h("p.page-sub", t(subtitle)) : null), right.length ? h("div.page-actions", ...right) : null);
  const btn = (label, { icon, kind = "", size = "", onClick, title, cls = "", disabled = false } = {}) => h("button.btn", { class: `${kind ? "btn-" + kind : ""} ${size ? "btn-" + size : ""} ${cls}`, onclick: onClick, title: t(title) || (label ? undefined : ""), disabled, "aria-label": t(label || title) }, icon ? icons.icon(icon, size === "sm" ? 15 : 18) : null, label ? h("span", t(label)) : null);
  const iconBtn = (icon, title, onClick, { cls = "", size = 20 } = {}) => h("button.btn.btn-icon", { class: cls, title: t(title), "aria-label": t(title), onclick: onClick }, icons.icon(icon, size));
  /* A missing avatar is a visual decision, not an error: a mono initial for people and
     small chips, the brand wordmark for a creator's own page hero. */
  const avatar = (src, name, px = 40, opts = {}) => src
    ? h("img.avatar", { src, alt: "", width: px, height: px, loading: "lazy", style: { width: px + "px", height: px + "px" }, onerror: (e) => e.target.replaceWith(avatar("", name, px, opts)) })
    : opts.mark
      ? h("span.avatar.avatar-fallback.avatar-mark", { style: { width: px + "px", height: px + "px" }, "aria-hidden": "true" }, h("span.avatar-mark-x", "X"))
      : h("span.avatar.avatar-fallback", { style: { width: px + "px", height: px + "px", fontSize: Math.round(px / 2.4) + "px" } }, (name || "?")[0].toUpperCase());

  return { chip, segmented, toggle, select, numberInput, row, section, empty, spinner, stat, kbd, pageHead, pageBar, btn, iconBtn, avatar };
});
