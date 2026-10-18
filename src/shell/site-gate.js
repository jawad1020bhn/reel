/* shell.siteGate — the full-screen password prompt of a deployed build.

   Shown before anything else boots: while it is up, the app has not started,
   no dataset was fetched and no library was built. It appears only when
   site.config.js carries a site password (see app.site) and this browser has
   not been let in yet. */
XR.define("shell.siteGate", ["ui.dom", "ui.icons", "app.site"], function (dom, icons, site) {
  "use strict";
  const h = dom.h;
  let el = null, card = null, input = null, msg = null, submitBtn = null, rememberBox = null;
  let release = null, busy = false;

  function fail(text) {
    if (!msg) return;
    msg.textContent = text;
    if (card) { card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake"); setTimeout(() => card.classList.remove("shake"), 450); }
  }

  async function submit() {
    if (busy || !input) return;
    const value = input.value;
    if (!value) return fail("Enter the password");
    busy = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Checking…"; }
    let ok = false;
    try { ok = await site.verify(value); } catch { ok = false; }
    busy = false;
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Unlock"; }
    if (!ok) { fail("Wrong password — try again"); try { input.select(); } catch { /* ignore */ } input.focus(); return; }
    if (rememberBox?.checked) await site.remember();
    hide();
    release?.(true);
  }

  function show() {
    if (el) return;
    input = h("input.input.site-input", { type: "password", placeholder: "Password", autocomplete: "current-password", spellcheck: "false", "aria-label": "Site password" });
    msg = h("p.site-msg", site.hint() ? `Hint: ${site.hint()}` : "This deployment is protected.");
    rememberBox = h("input", { type: "checkbox", checked: true });
    submitBtn = h("button.btn.btn-primary.site-submit", { type: "submit" }, "Unlock");
    const form = h("form.site-form", { onsubmit: (e) => { e.preventDefault(); submit(); } },
      h("div.site-field", input),
      h("label.check.site-remember", rememberBox, h("span", "Remember this browser")),
      submitBtn);
    card = h("div.site-card",
      h("div.site-logo", icons.icon("lock", 28)),
      h("h1.site-title", site.title()),
      h("p.site-sub", "Enter the site password to open this library."),
      msg,
      form);
    el = h("div.site-gate", { role: "dialog", "aria-modal": "true", "aria-label": "Site password" }, card);
    document.body.appendChild(el);
    document.documentElement.classList.add("is-site-gated");
    el.tabIndex = -1;
    try { input.focus(); } catch { /* ignore */ }
  }

  function hide() {
    if (!el) return;
    const node = el; el = null;
    node.classList.add("out");
    document.documentElement.classList.remove("is-site-gated");
    setTimeout(() => node.remove(), 260);
  }

  /**
   * Resolves true when the deployment may open. Blocks (without booting the
   * app) while the visitor has to type the password.
   */
  async function ensure() {
    if (!site.applies()) return true;
    let unlocked = false;
    try { unlocked = await site.isUnlocked(); } catch { unlocked = false; }
    if (unlocked) return true;
    show();
    return new Promise((resolve) => { release = resolve; });
  }

  return { ensure, show, hide };
});
