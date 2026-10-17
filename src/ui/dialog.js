/* ui.dialog — modal surfaces with focus trapping, Escape/backdrop close, and
   promise-based helpers: confirm(), prompt(), choose(). Uses a plain <div role=dialog>
   so it behaves the same on file:// across browsers. */
XR.define("ui.dialog", ["ui.dom", "ui.icons", "core.i18n"], function (dom, icons, i18n) {
  "use strict";
  const stack = [];
  const FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";

  /**
   * open({ title, body: Node|string, actions: [{label, kind, run, close}], size: sm|md|lg|full, cls, onClose, dismissable })
   * returns { el, close(result) , body }
   */
  function open(opts = {}) {
    const prevFocus = document.activeElement;
    const panel = dom.h("div.dialog", { role: "dialog", "aria-modal": "true", class: `dialog-${opts.size || "md"} ${opts.cls || ""}`, tabindex: "-1" });
    const backdrop = dom.h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop && opts.dismissable !== false) close(undefined); } }, panel);
    const body = dom.h("div.dialog-body");
    if (opts.title !== false) panel.appendChild(dom.h("header.dialog-head", dom.h("h2.dialog-title", i18n.t(opts.title || "")), opts.dismissable !== false ? dom.h("button.btn.btn-icon.btn-ghost", { "aria-label": "Close", onclick: () => close(undefined) }, icons.icon("x", 18)) : null));
    panel.appendChild(body);
    if (typeof opts.body === "string") body.innerHTML = opts.body; else if (opts.body) body.appendChild(opts.body);
    let footer = null;
    if (opts.actions?.length) {
      footer = dom.h("footer.dialog-foot");
      for (const a of opts.actions) footer.appendChild(dom.h("button.btn", { class: a.kind ? "btn-" + a.kind : "", onclick: async () => { const r = a.run ? await a.run(api) : a.value; if (a.close !== false) close(r === undefined ? a.value : r); } }, i18n.t(a.label)));
      panel.appendChild(footer);
    }
    let resolved = false;
    const api = {
      el: panel, body, footer,
      close(result) {
        if (resolved) return; resolved = true;
        backdrop.classList.add("out");
        setTimeout(() => backdrop.remove(), 160);
        stack.splice(stack.indexOf(api), 1);
        document.removeEventListener("keydown", onKey, true);
        if (!stack.length) document.documentElement.classList.remove("has-dialog");
        if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
        opts.onClose?.(result);
        api.resolve(result);
      },
      promise: null, resolve: null,
    };
    api.promise = new Promise((res) => { api.resolve = res; });
    const close = api.close;
    function onKey(e) {
      if (stack[stack.length - 1] !== api) return;
      /* Capture only what the dialog owns. Swallowing the rest here would stop
         keydown before it ever reaches an input inside the dialog, which breaks
         Enter-to-submit; app shortcuts are muted by ui.keys via .has-dialog. */
      if (e.key === "Escape" && opts.dismissable !== false) { e.preventDefault(); e.stopPropagation(); close(undefined); }
      else if (e.key === "Tab") {
        const f = [...panel.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);
    document.documentElement.classList.add("has-dialog");
    stack.push(api);
    requestAnimationFrame(() => {
      backdrop.classList.add("in");
      const f = panel.querySelector("[autofocus]") || panel.querySelector(FOCUSABLE) || panel;
      f.focus({ preventScroll: true });
    });
    return api;
  }

  function confirm(message, { title = "Are you sure?", ok = "Confirm", cancel = "Cancel", danger = false } = {}) {
    const d = open({ title, size: "sm", body: dom.h("p.dialog-text", i18n.t(message)), actions: [{ label: cancel, kind: "ghost", value: false }, { label: ok, kind: danger ? "danger" : "primary", value: true }] });
    return d.promise.then((r) => !!r);
  }
  function prompt(message, { title = "", value = "", placeholder = "", ok = "Save", type = "text", hint = "" } = {}) {
    const input = dom.h("input.input", { type, value, placeholder: i18n.t(placeholder), autofocus: true, onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); d.close(input.value); } } });
    const d = open({ title, size: "sm", body: dom.h("div.stack", message ? dom.h("p.dialog-text", i18n.t(message)) : null, input, hint ? dom.h("p.muted.small", i18n.t(hint)) : null), actions: [{ label: "Cancel", kind: "ghost", value: null }, { label: ok, kind: "primary", run: () => input.value }] });
    return d.promise.then((r) => (r == null ? null : String(r)));
  }
  /** choose(title, [{id,label,hint,icon,checked}]) → id | null */
  function choose(title, items, { multi = false, ok = "Done", empty = "Nothing here yet", extra = null } = {}) {
    const list = dom.h("div.choice-list");
    if (!items.length) list.appendChild(dom.h("p.muted", empty));
    for (const it of items) {
      list.appendChild(dom.h("button.choice", { class: it.checked ? "checked" : "", dataset: { id: it.id }, onclick: (e) => { if (multi) e.currentTarget.classList.toggle("checked"); else d.close(it.id); } },
        it.icon ? icons.icon(it.icon, 18) : null,
        dom.h("span.choice-label", it.label),
        it.hint ? dom.h("span.choice-hint", it.hint) : null,
        multi ? dom.h("span.choice-check", icons.icon("check", 16)) : null));
    }
    const d = open({ title, size: "sm", body: dom.h("div.stack", list, extra), actions: multi ? [{ label: "Cancel", kind: "ghost", value: null }, { label: ok, kind: "primary", run: () => [...list.querySelectorAll(".choice.checked")].map((x) => x.dataset.id) }] : [] });
    return d.promise;
  }
  const closeAll = () => { for (const d of [...stack]) d.close(undefined); };
  return { open, confirm, prompt, choose, closeAll, get depth() { return stack.length; } };
});
