/* ui.menu — popover menus anchored to an element or a pointer position.
   menu.open(anchorOrEvent, [{label, icon, run, danger, disabled, checked, sep}]) */
XR.define("ui.menu", ["ui.dom", "ui.icons", "core.i18n"], function (dom, icons, i18n) {
  /* On touch devices / narrow screens the menu renders as a bottom sheet (native-app feel). */
  "use strict";
  let currentBackdrop = null;
  const isSheetMode = () => document.documentElement.dataset.touch === "on" || innerWidth <= 700;
  let current = null;
  function close() { if (currentBackdrop) { currentBackdrop.remove(); currentBackdrop = null; } if (current) { current.remove(); current = null; document.removeEventListener("pointerdown", onDoc, true); document.removeEventListener("keydown", onKey, true); window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); } }
  function onDoc(e) { if (current && !current.contains(e.target)) close(); }
  function onKey(e) {
    if (!current) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    const items = [...current.querySelectorAll(".menu-item:not([disabled])")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  }
  function open(anchor, items, { title = "", align = "start" } = {}) {
    close();
    const sheet = isSheetMode();
    const el = dom.h("div.menu", { role: "menu", class: sheet ? "menu-sheet" : "" });
    if (sheet) el.appendChild(dom.h("div.sheet-grip"));
    if (title) el.appendChild(dom.h("div.menu-title", i18n.t(title)));
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { el.appendChild(dom.h("div.menu-sep")); continue; }
      el.appendChild(dom.h("button.menu-item", { role: "menuitem", class: (it.danger ? "danger " : "") + (it.checked ? "checked" : ""), disabled: !!it.disabled, onclick: (e) => { e.stopPropagation(); close(); it.run?.(e); } },
        it.icon ? icons.icon(it.icon, 16) : dom.h("span.menu-icon-gap"),
        dom.h("span.menu-label", i18n.t(it.label)),
        it.hint ? dom.h("span.menu-hint", i18n.t(it.hint)) : null,
        it.checked ? icons.icon("check", 14) : null));
    }
    let backdrop = null;
    if (sheet) { backdrop = dom.h("div.sheet-backdrop", { onclick: close }); document.body.appendChild(backdrop); }
    document.body.appendChild(el);
    current = el; currentBackdrop = backdrop;
    if (sheet) {
      requestAnimationFrame(() => { el.classList.add("in"); backdrop.classList.add("in"); });
      setTimeout(() => { document.addEventListener("keydown", onKey, true); }, 0);
      return { el, close };
    }
    // position
    let x, y;
    if (anchor && typeof anchor.clientX === "number") { x = anchor.clientX; y = anchor.clientY; }
    else if (anchor instanceof Element) { const r = anchor.getBoundingClientRect(); x = align === "end" ? r.right : r.left; y = r.bottom + 4; if (align === "end") x -= el.offsetWidth; }
    else { x = innerWidth / 2 - el.offsetWidth / 2; y = innerHeight / 2 - el.offsetHeight / 2; }
    const w = el.offsetWidth, hgt = el.offsetHeight;
    x = Math.max(8, Math.min(x, innerWidth - w - 8));
    y = Math.max(8, Math.min(y, innerHeight - hgt - 8));
    el.style.left = x + "px"; el.style.top = y + "px";
    requestAnimationFrame(() => { el.classList.add("in"); el.querySelector(".menu-item:not([disabled])")?.focus({ preventScroll: true }); });
    setTimeout(() => { document.addEventListener("pointerdown", onDoc, true); document.addEventListener("keydown", onKey, true); window.addEventListener("resize", close); window.addEventListener("scroll", close, true); }, 0);
    return { el, close };
  }
  return { open, close, get isOpen() { return !!current; } };
});
