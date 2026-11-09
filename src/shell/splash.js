/* shell.splash — boot screen: crimson wordmark that zooms out of the black,
   live progress messages until the catalog is ready. Pure CSS, skippable,
   and completely static when reduce-motion is on. */
XR.define("shell.splash", ["ui.dom", "ui.icons", "core.events", "core.domain.events"], function (dom, icons, events, EV) {
  "use strict";
  let el = null, mark = null, msg = null, shownAt = 0;
  /* index.html paints a markup-only splash before any script runs (see #boot-splash): the
     first frame is the app's background, not white, even on a cold, slow connection. The
     real splash adopts that node instead of stacking a second one on top of it. */
  function adopt() {
    const boot = document.getElementById("boot-splash");
    if (!boot) return;
    boot.classList.add("is-done");
    setTimeout(() => boot.remove(), 260);
  }
  function show(discreet = false) {
    if (el) return;
    adopt();
    shownAt = Date.now();
    msg = dom.h("p.splash-msg", "Starting…");
    mark = dom.h("h1.splash-word.splash-saves", dom.h("span.splash-icon", icons.icon("bookmark", 28)), dom.h("span", "saves"));
    el = dom.h("div.splash",
      dom.h("div.splash-stage", mark),
      discreet ? null : msg,
      dom.h("div.splash-bar", dom.h("i")));
    document.body.appendChild(el);
    events.bus.on(EV.DATASET_PROGRESS, ({ message }) => { if (msg) msg.textContent = message; });
  }
  function set(text) { if (msg) msg.textContent = text; }
  function hide() {
    if (!el) return;
    const node = el; el = null;
    const wait = Math.max(0, 300 - (Date.now() - shownAt));
    setTimeout(() => {
      node.classList.add("out");                       /* wordmark bursts away */
      setTimeout(() => node.remove(), 900);
    }, wait);
  }
  function fail(error) {
    if (!el) show();
    el.classList.add("splash-error");
    dom.replace(msg, dom.h("span", "Something went wrong while starting. "), dom.h("code", String(error && error.message || error)), dom.h("br"), dom.h("button.btn.btn-primary", { onclick: () => location.reload(), style: { marginTop: "14px" } }, "Reload"));
  }
  return { show, set, hide, fail };
});
