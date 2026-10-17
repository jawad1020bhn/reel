/* ui.toast — non-blocking notifications. Any module can emit EV.TOAST
   { message, kind: info|success|error, action: {label, run}, timeout }. */
XR.define("ui.toast", ["ui.dom", "ui.icons", "core.events", "core.domain.events", "core.i18n"], function (dom, icons, events, EV, i18n) {
  "use strict";
  let host = null;
  function ensure() { if (!host) { host = dom.h("div.toast-host", { role: "status", "aria-live": "polite" }); document.body.appendChild(host); } return host; }
  function show({ message, kind = "info", action, timeout = 3200, icon } = {}) {
    const el = dom.h("div.toast", { class: "toast-" + kind },
      icons.icon(icon || (kind === "error" ? "alert" : kind === "success" ? "check" : "info"), 18),
      dom.h("span.toast-msg", typeof message === "string" ? i18n.t(message) : message),
      action ? dom.h("button.btn.btn-ghost.btn-sm", { onclick: () => { try { action.run(); } finally { dismiss(); } } }, i18n.t(action.label)) : null,
      dom.h("button.toast-x", { "aria-label": "Dismiss", onclick: () => dismiss() }, icons.icon("x", 14)));
    ensure().appendChild(el);
    requestAnimationFrame(() => el.classList.add("in"));
    let t = timeout > 0 ? setTimeout(dismiss, timeout) : 0;
    function dismiss() { clearTimeout(t); el.classList.remove("in"); el.classList.add("out"); setTimeout(() => el.remove(), 220); }
    return dismiss;
  }
  events.bus.on(EV.TOAST, (payload) => show(typeof payload === "string" ? { message: payload } : payload));
  const toast = (message, kind = "info", extra = {}) => events.bus.emit(EV.TOAST, { message, kind, ...extra });
  return { show, toast };
});
