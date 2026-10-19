/* AUTO-GENERATED — do not edit.
   Mirrored from dashboard/m3e/interactions.js by tools/sync-shared.mjs.
   Edit the original and re-run:  node tools/sync-shared.mjs */
/* =============================================================================
   M3E · Interaction Runtime
   The behavioural half of the design system: ripples, focus management,
   scroll-linked chrome, snackbars, dialog/sheet lifecycle.
   ============================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.M3E = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const RIPPLE_TARGETS =
    ".m3e-button, .m3e-icon-button, .m3e-chip, .m3e-fab, .m3e-card--interactive," +
    " .m3e-segmented__item, .m3e-list-item, .m3e-menu__item, .m3e-fab-menu__item," +
    " .m3e-switch, .m3e-nav-bar__item, .m3e-rail__item";

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]),' +
    " select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

  const reducedMotion = () =>
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "reduced") ||
    (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);

  function bindRipple(scope) {
    const host = scope || document;
    host.addEventListener(
      "pointerdown",
      (event) => {
        if (reducedMotion()) return;
        if (event.button !== 0 && event.pointerType === "mouse") return;
        const target = event.target.closest && event.target.closest(RIPPLE_TARGETS);
        if (!target || target.disabled || target.getAttribute("aria-disabled") === "true") return;

        const rect = target.getBoundingClientRect();
        const diameter = Math.max(rect.width, rect.height) * 2;
        const ripple = document.createElement("span");
        ripple.className = "m3e-ripple";
        ripple.style.width = ripple.style.height = diameter + "px";
        ripple.style.left = event.clientX - rect.left - diameter / 2 + "px";
        ripple.style.top = event.clientY - rect.top - diameter / 2 + "px";

        const priorPosition = getComputedStyle(target).position;
        if (priorPosition === "static") target.style.position = "relative";
        if (getComputedStyle(target).overflow === "visible") target.style.overflow = "hidden";

        target.appendChild(ripple);
        ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
        setTimeout(() => ripple.remove(), 900);
      },
      { passive: true }
    );
  }

  function trapFocus(container) {
    let previouslyFocused = document.activeElement;

    const focusables = () =>
      Array.from(container.querySelectorAll(FOCUSABLE)).filter(
        (el) =>
          (el.offsetParent !== null || el === document.activeElement) &&
          !el.closest("[inert]")
      );

    const onKeydown = (event) => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKeydown);

    requestAnimationFrame(() => {
      const initial = container.querySelector("[data-autofocus]") || focusables()[0] || container;
      if (initial && initial.focus) initial.focus({ preventScroll: true });
    });

    return function release(restoreFocus) {
      container.removeEventListener("keydown", onKeydown);
      if (restoreFocus !== false && previouslyFocused && previouslyFocused.focus) {
        previouslyFocused.focus({ preventScroll: true });
      }
      previouslyFocused = null;
    };
  }

  function createOverlay(options) {
    const el = options.element;
    const scrim = options.scrim || null;
    const onClose = options.onClose || null;
    let release = null;
    let open = false;

    const close = () => {
      if (!open) return;
      open = false;
      el.dataset.open = "false";
      el.setAttribute("aria-hidden", "true");
      if (scrim) scrim.dataset.open = "false";
      if (release) { release(options.restoreFocus); release = null; }
      document.documentElement.style.removeProperty("overflow");
      if (onClose) onClose();
    };

    const show = () => {
      if (open) return;
      open = true;
      el.dataset.open = "true";
      el.setAttribute("aria-hidden", "false");
      if (scrim) scrim.dataset.open = "true";
      if (options.lockScroll !== false) document.documentElement.style.overflow = "hidden";
      release = trapFocus(el);
    };

    if (scrim && options.dismissOnScrim !== false) scrim.addEventListener("click", close);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) {
        event.stopPropagation(); close();
      }
    });

    return { open: show, close, get isOpen() { return open; } };
  }

  function createSnackbar(element) {
    const textEl = element.querySelector(".m3e-snackbar__text");
    const actionEl = element.querySelector(".m3e-snackbar__action");
    const queue = [];
    let timer = null;
    let showing = false;

    function next() {
      if (showing || !queue.length) return;
      const item = queue.shift();
      showing = true;

      textEl.textContent = item.message;
      element.classList.toggle("m3e-snackbar--error", !!item.error);
      element.setAttribute("aria-live", item.error ? "assertive" : "polite");

      if (item.action && item.onAction) {
        actionEl.hidden = false;
        actionEl.textContent = item.action;
        actionEl.onclick = () => { item.onAction(); dismiss(); };
      } else {
        actionEl.hidden = true;
        actionEl.onclick = null;
      }

      element.dataset.open = "true";
      clearTimeout(timer);
      timer = setTimeout(dismiss, item.duration || (item.action ? 8000 : 4500));
    }

    function dismiss() {
      clearTimeout(timer);
      element.dataset.open = "false";
      setTimeout(() => { showing = false; next(); }, 220);
    }

    return {
      show(message, opts) {
        queue.push(Object.assign({ message: String(message) }, opts || {}));
        next();
      },
      dismiss,
    };
  }

  function pulse(element) {
    if (!element || reducedMotion()) return;
    element.classList.remove("m3e-pulse");
    void element.offsetWidth;
    element.classList.add("m3e-pulse");
  }

  function debounce(fn, wait) {
    let t = null;
    return function debounced() {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  return {
    bindRipple,
    trapFocus,
    createOverlay,
    createSnackbar,
    pulse,
    debounce,
    escapeHtml,
    reducedMotion,
  };
});