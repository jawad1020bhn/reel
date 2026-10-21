/* shell.siteGate — shown before the app or library data loads, and again when
   the opening hours close while the app is in use (see shell.availability).
   The deployment passcode is numeric; keep it a string so leading zeros survive.
   With opening hours on, the gate says whether the library is open right now
   and answers the right passcode at the wrong time calmly — no shake, no
   "wrong passcode" — with a coarse idea of when it opens again. */
XR.define("shell.siteGate", ["ui.dom", "ui.icons", "app.site"], function (dom, icons, site) {
  "use strict";
  const h = dom.h;
  let el = null, card = null, input = null, msg = null, submitBtn = null, revealBtn = null, sub = null, note = null;
  let release = null, busy = false, mode = "enter", refreshTimer = 0;

  /* Coarse on purpose: enough to stop refreshing, not enough to plan around. */
  const AGAIN = { soon: "it opens again within the hour.", hours: "it opens again in a few hours.", today: "it opens again later today.", tomorrow: "it opens again tomorrow.", later: "it opens again in a few days." };
  const again = (s) => AGAIN[site.phase(s)] || AGAIN.later;
  function statusCopy(s) {
    if (!site.scheduled()) return { open: true, sub: "Your library is one passcode away.", note: "Passcode required" };
    if (s.open) return { open: true, sub: mode === "closed" ? "That window has ended — but the library is open again. Your passcode works." : "The library is open right now. Your passcode works.", note: "Open now" };
    return { open: false, sub: `${mode === "closed" ? "That window has ended" : "The library is closed right now"} — ${again(s)}`, note: "Closed right now" };
  }
  /** Keep the status line true while the gate is up: refresh on every change (and after sleep). */
  function refreshStatus() {
    clearTimeout(refreshTimer); refreshTimer = 0;
    if (!el || !sub) return;
    const s = site.status();
    const copy = statusCopy(s);
    sub.textContent = copy.sub;
    sub.classList.toggle("is-closed", !copy.open);
    if (note) { note.replaceChildren(icons.icon(copy.open ? "lock" : "clock", 13), copy.note); note.classList.toggle("is-closed", !copy.open); }
    if (!s.always && s.until) {
      const wait = Math.min(30 * 60000, Math.max(1000, s.until.getTime() - Date.now() + 500));
      refreshTimer = setTimeout(refreshStatus, wait);
    }
  }
  const onVisible = () => { if (!document.hidden) refreshStatus(); };

  function fail(text, { calm = false } = {}) {
    if (!msg) return;
    msg.textContent = text;
    msg.classList.toggle("is-calm", calm);
    if (calm) { input.removeAttribute("aria-invalid"); return; }
    input.setAttribute("aria-invalid", "true");
    if (card) {
      const target = card;
      target.classList.remove("shake"); void target.offsetWidth;
      target.classList.add("shake");
      setTimeout(() => target.classList.remove("shake"), 450);
    }
  }

  function setBusy(value) {
    busy = value;
    input.readOnly = value;
    submitBtn.disabled = value;
    revealBtn.disabled = value;
    card.setAttribute("aria-busy", String(value));
    submitBtn.textContent = value ? "Opening library…" : "Enter library";
  }

  async function submit() {
    if (busy || !input) return;
    const value = input.value;
    if (!/^[0-9]+$/.test(value)) {
      fail(value ? "Use numbers only (0–9)." : "Enter your passcode to continue.");
      input.focus();
      return;
    }
    const activeGate = el;
    setBusy(true);
    msg.textContent = "Checking passcode…";
    let verdict;
    try { verdict = await site.check(value); }
    catch {
      if (el !== activeGate) return;
      setBusy(false);
      fail("Couldn't check your passcode. Please try again.");
      input.focus();
      return;
    }
    if (el !== activeGate) return;
    if (!verdict.ok) {
      setBusy(false);
      if (verdict.reason === "closed") {
        fail(`That's the right passcode, but the library is closed right now — ${again(verdict.status)}`, { calm: true });
        refreshStatus();
        input.focus();
      } else {
        fail("That passcode isn't right. Try again.");
        input.focus(); input.select();
      }
      return;
    }
    if (el !== activeGate) return;
    input.value = "";
    const done = release; release = null;
    hide();
    done?.(true);
  }

  /** opts.reason = "closed" → the re-lock after a window ended ("Closing time."). */
  function show(opts = {}) {
    if (el) return;
    busy = false;
    mode = opts.reason === "closed" ? "closed" : "enter";
    input = h("input.site-input#site-passcode", {
      type: "password", name: "site-passcode", inputmode: "numeric", pattern: "[0-9]+",
      // Ask the browser/password manager not to offer saving or autofilling it.
      autocomplete: "off", autocapitalize: "off", spellcheck: "false",
      placeholder: "Enter passcode", "aria-describedby": "site-code-help site-message",
      oninput: () => {
        input.removeAttribute("aria-invalid");
        msg.textContent = "";
        msg.classList.remove("is-calm");
      },
    });
    revealBtn = h("button.site-reveal", {
      type: "button", "aria-label": "Show passcode", "aria-pressed": "false",
      onclick: () => {
        const visible = input.type === "password";
        input.type = visible ? "text" : "password";
        revealBtn.setAttribute("aria-label", visible ? "Hide passcode" : "Show passcode");
        revealBtn.setAttribute("aria-pressed", String(visible));
        revealBtn.replaceChildren(icons.icon(visible ? "eyeOff" : "eye", 20));
      },
    }, icons.icon("eye", 20));
    msg = h("p.site-msg#site-message", { "aria-live": "polite", "aria-atomic": "true" });
    submitBtn = h("button.site-submit", { type: "submit" }, "Enter library");
    const form = h("form.site-form", { noValidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } },
      h("label.site-label", { htmlFor: "site-passcode" }, "Passcode"),
      h("div.site-field", input, revealBtn),
      h("p.site-help#site-code-help", site.hint() ? `Numbers only · Hint: ${site.hint()}` : "Numbers only. Your passcode stays hidden."),
      submitBtn, msg);
    sub = h("p.site-sub", { "aria-live": "polite" }, "Your library is one passcode away.");
    note = h("span.site-header-note", icons.icon("lock", 13), "Passcode required");
    card = h("section.site-card", { "aria-labelledby": "site-heading" },
      h("div.site-lock", { "aria-hidden": "true" }, icons.icon(mode === "closed" ? "clock" : "lock", 22)),
      h("h1.site-title#site-heading", mode === "closed" ? "Closing time." : "Welcome back."),
      sub, form);
    const brand = h("div.site-brand",
      h("span.site-wordmark", site.title()), h("span.site-edition", "PRIVATE CINEMA"));
    const intro = h("div.site-intro", { "aria-hidden": "true" },
      h("p.site-eyebrow", "SAVED BY YOU. JUST FOR YOU."),
      h("p.site-statement", "Good finds.", h("br"), "Great rewatches."),
      h("p.site-intro-note", "Your collection, ready when you are."));
    el = h("div.site-gate", { role: "dialog", "aria-modal": "true", "aria-labelledby": "site-heading", class: mode === "closed" ? "is-closing" : "" },
      h("header.site-header", brand, note),
      h("main.site-entry", intro, card),
      h("footer.site-footer", h("span", "YOUR COLLECTION. YOUR SPACE."), h("span", "SAVES")));
    // Keep keyboard focus inside the gate — and, when the app is running behind
    // it (re-lock), keep its shortcuts from reaching the document.
    el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Tab") return;
      const controls = [...el.querySelectorAll("input:not(:disabled), button:not(:disabled)")];
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
    document.body.appendChild(el);
    document.documentElement.classList.add("is-site-gated");
    refreshStatus();
    document.addEventListener("visibilitychange", onVisible);
    el.tabIndex = -1;
    // Do not summon the mobile keyboard until the user taps the field.
    if (typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches) input.focus();
    else el.focus({ preventScroll: true });
  }

  function hide() {
    if (!el) return;
    const node = el; el = null; sub = null; note = null;
    clearTimeout(refreshTimer); refreshTimer = 0;
    document.removeEventListener("visibilitychange", onVisible);
    node.classList.add("out");
    document.documentElement.classList.remove("is-site-gated");
    setTimeout(() => node.remove(), 260);
  }

  /* Asked on every load: the unlock is never persisted, so there is nothing to
     check first. The promise settles only when the passcode has been accepted.
     shell.availability calls it again with { reason: "closed" } when a window ends. */
  async function ensure(opts = {}) {
    if (!site.applies()) return true;
    if (el && release) return new Promise((resolve) => { const prev = release; release = (v) => { prev?.(v); resolve(v); }; });
    show(opts);
    return new Promise((resolve) => { release = resolve; });
  }

  const isShown = () => !!el;
  return { ensure, show, hide, isShown };
});
