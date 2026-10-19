/* shell.siteGate — shown before the app or library data loads.
   The deployment passcode is numeric; keep it a string so leading zeros survive. */
XR.define("shell.siteGate", ["ui.dom", "ui.icons", "app.site"], function (dom, icons, site) {
  "use strict";
  const h = dom.h;
  let el = null, card = null, input = null, msg = null, submitBtn = null, revealBtn = null;
  let release = null, busy = false;

  function fail(text) {
    if (!msg) return;
    msg.textContent = text;
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
    let ok;
    try { ok = await site.verify(value); }
    catch {
      if (el !== activeGate) return;
      setBusy(false);
      fail("Couldn't check your passcode. Please try again.");
      input.focus();
      return;
    }
    if (el !== activeGate) return;
    if (!ok) {
      setBusy(false);
      fail("That passcode isn't right. Try again.");
      input.focus(); input.select();
      return;
    }
    if (el !== activeGate) return;
    input.value = "";
    const done = release; release = null;
    hide();
    done?.(true);
  }

  function show() {
    if (el) return;
    busy = false;
    input = h("input.site-input#site-passcode", {
      type: "password", name: "site-passcode", inputmode: "numeric", pattern: "[0-9]+",
      // Ask the browser/password manager not to offer saving or autofilling it.
      autocomplete: "off", autocapitalize: "off", spellcheck: "false",
      placeholder: "Enter passcode", "aria-describedby": "site-code-help site-message",
      oninput: () => {
        input.removeAttribute("aria-invalid");
        msg.textContent = "";
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
    card = h("section.site-card", { "aria-labelledby": "site-heading" },
      h("div.site-lock", { "aria-hidden": "true" }, icons.icon("lock", 22)),
      h("h1.site-title#site-heading", "Welcome back."),
      h("p.site-sub", "Your library is one passcode away."), form);
    const brand = h("div.site-brand",
      h("span.site-wordmark", site.title()), h("span.site-edition", "PRIVATE CINEMA"));
    const intro = h("div.site-intro", { "aria-hidden": "true" },
      h("p.site-eyebrow", "SAVED BY YOU. JUST FOR YOU."),
      h("p.site-statement", "Good finds.", h("br"), "Great rewatches."),
      h("p.site-intro-note", "Your collection, ready when you are."));
    el = h("div.site-gate", { role: "dialog", "aria-modal": "true", "aria-labelledby": "site-heading" },
      h("header.site-header", brand, h("span.site-header-note", icons.icon("lock", 13), "Passcode required")),
      h("main.site-entry", intro, card),
      h("footer.site-footer", h("span", "YOUR COLLECTION. YOUR SPACE."), h("span", "SAVES")));
    // The app has not booted, but keep keyboard focus inside the gate as a guard.
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const controls = [...el.querySelectorAll("input:not(:disabled), button:not(:disabled)")];
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
    document.body.appendChild(el);
    document.documentElement.classList.add("is-site-gated");
    el.tabIndex = -1;
    // Do not summon the mobile keyboard until the user taps the field.
    if (typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches) input.focus();
    else el.focus({ preventScroll: true });
  }

  function hide() {
    if (!el) return;
    const node = el; el = null;
    node.classList.add("out");
    document.documentElement.classList.remove("is-site-gated");
    setTimeout(() => node.remove(), 260);
  }

  /* Asked on every load: the unlock is never persisted, so there is nothing to
     check first. The promise settles only when the passcode has been accepted. */
  async function ensure() {
    if (!site.applies()) return true;
    show();
    return new Promise((resolve) => { release = resolve; });
  }

  return { ensure, show, hide };
});
