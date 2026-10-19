/* ui.menu — popover menus anchored to an element or a pointer position.
   menu.open(anchorOrEvent, [{label, icon, run, danger, disabled, checked, sep}]) */
XR.define("ui.menu", ["ui.dom", "ui.icons", "ui.overlayHistory", "core.i18n"], function (dom, icons, overlay, i18n) {
  /* On touch devices / narrow screens the menu renders as a bottom sheet (native-app feel). */
  "use strict";
  let currentBackdrop = null;
  const isSheetMode = () => document.documentElement.dataset.touch === "on" || innerWidth <= 700;
  let current = null, trigger = null, onClosed = null, historyEntry = null;
  function close() {
    const restore = current?.contains(document.activeElement);
    const previousTrigger = trigger, callback = onClosed;
    trigger = null; onClosed = null;
    if (currentBackdrop) { currentBackdrop.remove(); currentBackdrop = null; }
    if (current) { current.remove(); current = null; }
    if (historyEntry) { overlay.release(historyEntry); historyEntry = null; }
    document.removeEventListener("pointerdown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("scroll", close, true);
    callback?.();
    if (restore && previousTrigger?.isConnected) previousTrigger.focus({ preventScroll: true });
  }
  function onDoc(e) { if (current && !current.contains(e.target)) close(); }
  function onKey(e) {
    if (!current) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    const items = [...current.querySelectorAll(".menu-item:not([disabled])")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Tab") {
      e.preventDefault();
      items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
    } else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  }
  /* Sheets close by dragging their head down, the page dimming in step.
     Pointer events cover touch, pen and mouse; a short flick counts too. */
  function attachSheetDrag(sheet, handle, backdrop) {
    let pointerId = null, startY = 0, dy = 0, startedAt = 0;
    const reduced = () => document.documentElement.dataset.motion === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches;
    const settle = (dismiss) => {
      if (pointerId === null) return;
      pointerId = null;
      handle.classList.remove("is-dragging");
      sheet.classList.remove("is-dragging");
      if (dismiss) {
        const exit = reduced() ? 0 : 170;
        sheet.style.transition = exit ? "transform 170ms var(--ease-soft), opacity 140ms linear" : "none";
        backdrop.style.transition = exit ? "opacity 140ms linear" : "none";
        sheet.style.transform = `translateY(${sheet.offsetHeight}px)`;
        sheet.style.opacity = "0";
        backdrop.style.opacity = "0";
        setTimeout(() => { if (current === sheet) close(); }, exit);
      } else {
        sheet.style.transition = "";
        backdrop.style.transition = "";
        sheet.style.transform = "";
        sheet.style.opacity = "";
        backdrop.style.opacity = "";
      }
      dy = 0;
    };
    handle.addEventListener("pointerdown", (e) => {
      if (!e.isPrimary || (e.button !== undefined && e.button !== 0)) return;
      if (e.target.closest("button, a, input, select, textarea")) return;
      pointerId = e.pointerId; startY = e.clientY; dy = 0; startedAt = performance.now();
      handle.classList.add("is-dragging");
      sheet.classList.add("is-dragging");
      try { handle.setPointerCapture(pointerId); } catch { /* synthetic pointers */ }
    });
    handle.addEventListener("pointermove", (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      dy = Math.max(0, e.clientY - startY);
      if (dy > 0 && e.cancelable) e.preventDefault();
      sheet.style.transform = `translateY(${dy}px)`;
      backdrop.style.opacity = String(Math.max(0, 1 - dy / Math.max(160, sheet.offsetHeight * 0.9)));
    });
    const release = (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const speed = dy / Math.max(1, performance.now() - startedAt);
      settle(dy > Math.min(132, sheet.offsetHeight * 0.32) || speed > 0.55);
    };
    handle.addEventListener("pointerup", release);
    handle.addEventListener("pointercancel", () => settle(false));
  }

  function open(anchor, items, { title = "", align = "start", className = "", onClose = null } = {}) {
    close();
    trigger = anchor instanceof Element ? anchor : document.activeElement;
    onClosed = onClose;
    const sheet = isSheetMode();
    const el = dom.h("div.menu", { role: "menu", class: (sheet ? "menu-sheet " : "") + className, "aria-label": title ? i18n.t(title) : i18n.t("Actions") });
    let dragArea = null;
    if (sheet) {
      /* The grip is a handle, not decoration: the whole head drags the sheet. */
      dragArea = dom.h("div.sheet-drag", dom.h("div.sheet-grip"));
      if (title) dragArea.appendChild(dom.h("div.menu-title", i18n.t(title)));
      el.appendChild(dragArea);
    }
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { el.appendChild(dom.h("div.menu-sep")); continue; }
      el.appendChild(dom.h("button.menu-item", { role: "menuitem", class: (it.danger ? "danger " : "") + (it.checked ? "checked" : ""), disabled: !!it.disabled, onclick: (e) => { e.stopPropagation(); close(); it.run?.(e); } },
        it.icon ? icons.icon(it.icon, 16) : dom.h("span.menu-icon-gap"),
        dom.h("span.menu-label", i18n.t(it.label)),
        it.hint ? dom.h("span.menu-hint", i18n.t(it.hint)) : null,
        it.checked ? icons.icon("check", 14) : null));
    }
    if (sheet) {
      /* Sheets get a labelled exit at the end, the way a native action sheet does:
         drag and backdrop are gestures, this is the explicit way out. */
      el.appendChild(dom.h("div.menu-sep"));
      el.appendChild(dom.h("button.menu-item.menu-cancel", { role: "menuitem", onclick: (e) => { e.stopPropagation(); close(); } },
        icons.icon("x", 16), dom.h("span.menu-label", i18n.t("Cancel"))));
    }
    let backdrop = null;
    if (sheet) { backdrop = dom.h("div.sheet-backdrop", { onclick: close }); document.body.appendChild(backdrop); }
    document.body.appendChild(el);
    current = el; currentBackdrop = backdrop;
    historyEntry = overlay.register(close);
    if (sheet) {
      attachSheetDrag(el, dragArea, backdrop);
      requestAnimationFrame(() => {
        if (current !== el) return;
        el.classList.add("in"); backdrop.classList.add("in");
        el.querySelector(".menu-item:not([disabled])")?.focus({ preventScroll: true });
      });
      setTimeout(() => { if (current !== el) return; document.addEventListener("keydown", onKey, true); }, 0);
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
    requestAnimationFrame(() => { if (current !== el) return; el.classList.add("in"); el.querySelector(".menu-item:not([disabled])")?.focus({ preventScroll: true }); });
    setTimeout(() => { if (current !== el) return; document.addEventListener("pointerdown", onDoc, true); document.addEventListener("keydown", onKey, true); window.addEventListener("resize", close); window.addEventListener("scroll", close, true); }, 0);
    return { el, close };
  }
  return { open, close, get isOpen() { return !!current; } };
});
