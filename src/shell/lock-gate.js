/* shell.lockGate — full-screen PIN prompt shown while app.lock is locked. */
XR.define("shell.lockGate", ["ui.dom", "ui.icons", "ui.dialog", "app.lock", "app.playback", "app.activity", "app.prefs", "app.ports.storage", "core.events", "core.domain.events"],
  function (dom, icons, dialog, lock, playback, activity, prefs, storage, events, EV) {
    "use strict";
    const h = dom.h;
    let el = null;

    function show() {
      if (el) return;
      playback.pauseAll();
      let pin = "";
      const dots = h("div.pin-dots", [0, 1, 2, 3, 4, 5].map(() => h("i")));
      const msg = h("p.pin-msg", lock.hint() ? `Hint: ${lock.hint()}` : "Enter your PIN");
      const render = () => { [...dots.children].forEach((d, i) => { d.classList.toggle("on", i < pin.length); d.style.display = i < Math.max(4, pin.length) || i < 6 ? "" : "none"; }); };
      async function submit() {
        if (pin.length < 4) return;
        const ok = await lock.unlock(pin);
        if (ok) hide();
        else { pad.classList.add("shake"); setTimeout(() => pad.classList.remove("shake"), 500); pin = ""; render(); msg.textContent = "Wrong PIN, try again"; }
      }
      const press = (k) => { if (k === "⌫") pin = pin.slice(0, -1); else if (k === "OK") return submit(); else if (pin.length < 8) pin += k; render(); if (pin.length >= 4 && k !== "⌫" && pin.length === (lockLen || 0)) submit(); };
      const lockLen = 0;
      const pad = h("div.pin-pad", ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"].map((k) => h("button.pin-key", { class: k === "OK" ? "pin-ok" : k === "⌫" ? "pin-del" : "", onclick: () => press(k) }, k)));
      el = h("div.lock-gate", { role: "dialog", "aria-modal": "true", "aria-label": "Locked" },
        h("div.lock-card",
          h("div.lock-logo", icons.icon("lock", 28)),
          h("h1.lock-title", prefs.get("discreet") ? "Locked" : "XReels is locked"),
          msg, dots, pad,
          h("button.btn.btn-ghost.btn-sm.lock-forgot", { onclick: forgot }, "Forgot PIN?")));
      document.body.appendChild(el);
      document.documentElement.classList.add("is-locked");
      el.tabIndex = -1; el.focus();
      el.addEventListener("keydown", (e) => {
        if (/^\d$/.test(e.key)) press(e.key); else if (e.key === "Backspace") press("⌫"); else if (e.key === "Enter") submit();
        e.stopPropagation();
      });
      render();
    }
    function hide() { if (!el) return; el.classList.add("out"); const node = el; el = null; setTimeout(() => node.remove(), 250); document.documentElement.classList.remove("is-locked"); }
    async function forgot() {
      const ok = await dialog.confirm("A PIN cannot be recovered. The only way back in is to erase this browser's local XReels data (stars, collections, history, imported posts). Your data/posts.js file is not touched.", { title: "Reset local data?", ok: "Erase & unlock", danger: true });
      if (!ok) return;
      await lock.forceReset();
      await activity.resetAll();
      await storage.clear();
      location.reload();
    }
    function start() {
      events.bus.on(EV.LOCKED, show);
      events.bus.on(EV.UNLOCKED, hide);
      if (lock.isLocked()) show();
      lock.watch(document);
    }
    return { start, show, hide };
  });
