/* features.settings — preferences, privacy (PIN, blur), data management, about. */
XR.define("features.settings", ["ui.dom", "ui.icons", "ui.widgets", "ui.dialog", "ui.keys", "app.prefs", "app.lock", "app.activity", "app.catalog", "app.importer", "app.actions", "app.nav", "app.ports.storage", "app.ports.platform", "app.ports.playerEngine", "core.domain.model"],
  function (dom, icons, W, dialog, keys, prefs, lock, activity, catalog, importer, actions, nav, storage, platform, player, model) {
    "use strict";
    const h = dom.h;
    let host = null;
    const P = (key) => prefs.get(key);
    const set = (key) => (v) => prefs.set({ [key]: v });

    const SECTIONS = [
      ["appearance", "Appearance", "grid"],
      ["playback", "Playback", "play"],
      ["privacy", "Privacy", "shield"],
      ["data", "Data", "database"],
      ["about", "About & shortcuts", "keyboard"],
    ];

    function render() {
      dom.clear(host);
      const page = h("div.settings", W.pageBar("Settings", `Local-first · ${storage.kind} · ${catalog.size} posts in this browser`));
      const nav = h("nav.settings-nav", { "aria-label": "Settings sections" },
        h("p.settings-nav-title", "On this page"),
        SECTIONS.map(([id, label, icon]) => h("a.settings-nav-link", { href: "#set-" + id, dataset: { section: id }, onclick: (e) => { e.preventDefault(); scrollToSection(id); } }, icons.icon(icon, 14), h("span", label))),
        h("div.settings-nav-foot",
          W.btn("Reset preferences", { size: "sm", onClick: async () => { if (await dialog.confirm("Reset all preferences to defaults?")) { prefs.reset(); render(); } } }),
          h("p.muted.small", "Changes save instantly in this browser.")));
      const body = h("div.settings-body", mark(appearance(), "appearance"), mark(playback(), "playback"), mark(privacy(), "privacy"), mark(data(), "data"), mark(about(), "about"));
      page.append(h("div.settings-cols", nav, body));
      host.appendChild(page);
      observeSections(body, nav);
    }
    function mark(section, id) {
      section.id = "set-" + id;
      section.dataset.section = id;
      section.classList.add("settings-section");
      return section;
    }
    function scrollToSection(id) {
      const target = host.querySelector("#set-" + id);
      if (!target) return;
      const top = target.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop - 96;
      host.scrollTo({ top, behavior: "smooth" });
      setNavActive(id);
    }
    function setNavActive(id) {
      for (const a of host.querySelectorAll(".settings-nav-link")) a.classList.toggle("is-active", a.dataset.section === id);
    }
    let spy = null;
    function observeSections(body, nav) {
      spy?.disconnect();
      const links = nav.querySelectorAll(".settings-nav-link");
      const tops = () => [...body.querySelectorAll(".settings-section")].map((el) => ({ id: el.dataset.section, top: el.getBoundingClientRect().top }));
      const onScroll = () => {
        const list = tops();
        const mark = list.filter((x) => x.top <= host.getBoundingClientRect().top + 160).pop() || list[0];
        if (mark) for (const a of links) a.classList.toggle("is-active", a.dataset.section === mark.id);
      };
      host.addEventListener("scroll", onScroll, { passive: true });
      spy = { disconnect: () => host.removeEventListener("scroll", onScroll) };
      onScroll();
    }
    function appearance() {
      return W.section("Appearance", "Cinematic dark — tuned so the artwork does the talking",
        W.row("Language", "Follows the browser language", W.segmented([{ value: "auto", label: "Auto" }, { value: "en", label: "English" }, { value: "ar", label: "العربية" }], P("language"), (v) => { prefs.set({ language: v }); setTimeout(render, 0); })),
        W.row("Density", "Tile size in grids", W.segmented([{ value: "compact", label: "Compact" }, { value: "cozy", label: "Cozy" }, { value: "comfortable", label: "Roomy" }], P("density"), set("density"))),
        W.row("Tile shape", "", W.segmented([{ value: "natural", label: "Natural" }, { value: "portrait", label: "Portrait" }, { value: "square", label: "Square" }], P("tileShape"), set("tileShape"))),
        W.row("Tile details", "Creator and caption on tiles", W.segmented([{ value: "hover", label: "On hover" }, { value: "always", label: "Always" }, { value: "never", label: "Never" }], P("tileInfo"), set("tileInfo"))),
        W.row("Dim seen posts", "", W.toggle(P("seenDim"), set("seenDim"))),
        W.row("Hover preview", "Play a muted preview when the mouse rests on a video tile", W.toggle(P("hoverPreview"), set("hoverPreview"))),
        W.row("Reduce motion", "", W.segmented([{ value: "system", label: "System" }, { value: "on", label: "On" }, { value: "off", label: "Off" }], P("reduceMotion"), set("reduceMotion"))),
        W.row("Start on", "", W.segmented([{ value: "discover", label: "Discover" }, { value: "library", label: "Library" }, { value: "watch", label: "Watch" }], P("landing"), set("landing"))));
    }
    function playback() {
      return W.section("Playback", "How the feed behaves while you watch",
        W.row("Tiles open in", "Auto sends videos to the Watch feed, photos & albums to the Viewer", W.segmented([{ value: "auto", label: "Auto" }, { value: "viewer", label: "Viewer" }, { value: "watch", label: "Watch feed" }], P("tileOpens"), set("tileOpens"))),
        W.row("Start muted", "Browsers block autoplay with sound until you interact", W.toggle(P("startMuted"), set("startMuted"))),
        W.row("Loop short clips", "Clips up to 60 s repeat instead of advancing", W.toggle(P("loopShorts"), set("loopShorts"))),
        W.row("Auto-advance", "Move to the next post when a video ends", W.toggle(P("autoAdvance"), set("autoAdvance"))),
        W.row("Images auto-advance", "Seconds before the feed moves past a photo (0 = never)", W.numberInput(P("imageSeconds"), set("imageSeconds"), { min: 0, max: 60, suffix: "s" })),
        W.row("Fit", "Auto = fill the screen for vertical clips on phones, letterbox elsewhere", W.segmented([{ value: "auto", label: "Auto" }, { value: "contain", label: "Fit" }, { value: "cover", label: "Fill" }], P("fit"), set("fit"))),
        W.row("Remember position", "Resume long videos where you left them", W.toggle(P("rememberProgress"), set("rememberProgress"))),
        W.row("Preload neighbours", "Warm up the next clip while you watch", W.toggle(P("preload"), set("preload"))),
        W.row("One post per wheel notch", "Off = free scrolling with a mouse wheel", W.toggle(P("wheelStep"), set("wheelStep"))),
        W.row("“Short” means up to", "Threshold between Shorts and Long videos", W.numberInput(P("shortMaxSeconds"), (v) => prefs.set({ shortMaxSeconds: Math.max(10, v || model.SHORT_MAX_SECONDS) }), { min: 10, max: 3600, suffix: "s" })),
        W.row("HLS engine", player.canHls() ? "hls.js loaded — streams fall back to HLS when MP4 fails" : "hls.js loads on demand for HLS streams; MP4 plays without it", null));
    }
    function privacy() {
      const pinRow = W.row("PIN lock", lock.isEnabled() ? "A PIN is required when the app opens" : "Ask for a PIN when the app opens", h("div.row-btns",
        lock.isEnabled() ? W.btn("Change", { icon: "edit", onClick: changePin }) : null,
        lock.isEnabled() ? W.btn("Remove", { icon: "unlock", kind: "danger", onClick: removePin }) : W.btn("Set PIN", { icon: "lock", kind: "primary", onClick: setPin })));
      return W.section("Privacy", "Everything stays in this browser. Nothing is sent anywhere.",
        pinRow,
        W.row("Auto-lock", "Lock again after the tab has been hidden for this long (0 = only on launch)", W.numberInput(P("lockMinutes"), set("lockMinutes"), { min: 0, max: 600, suffix: "min" })),
        W.row("Blur thumbnails", "Grids and rails are blurred until you hover or tap (shift+B)", W.toggle(P("blur"), set("blur"))),
        W.row("Discreet tab", "Neutral title and icon in the browser tab", W.toggle(P("discreet"), set("discreet"))),
        W.row("Hide sensitive posts", "Posts X marked as sensitive are kept out of every list", W.toggle(P("hideSensitive"), set("hideSensitive"))));
    }
    async function setPin() {
      const pin = await dialog.prompt("Choose a PIN (4–8 digits). There is no recovery: forgetting it means erasing local data.", { title: "Set a PIN", type: "password", placeholder: "••••", ok: "Next" });
      if (!pin) return;
      if (!/^\d{4,8}$/.test(pin)) return actions.toast("PIN must be 4–8 digits", "error");
      const again = await dialog.prompt("Type it again.", { title: "Confirm PIN", type: "password", ok: "Set PIN" });
      if (again !== pin) return actions.toast("PINs didn't match", "error");
      const hint = await dialog.prompt("Optional hint shown on the lock screen.", { title: "Hint", placeholder: "e.g. the usual", ok: "Save" });
      await lock.enable(pin, hint || "");
      actions.toast("PIN enabled", "success"); render();
    }
    async function changePin() { const old = await dialog.prompt("Current PIN", { title: "Change PIN", type: "password" }); if (old == null) return; if (!(await lock.verify(old))) return actions.toast("Wrong PIN", "error"); await setPin(); }
    async function removePin() { const old = await dialog.prompt("Enter your PIN to remove the lock.", { title: "Remove PIN", type: "password", ok: "Remove" }); if (old == null) return; if (await lock.disable(old)) { actions.toast("PIN removed", "success"); render(); } else actions.toast("Wrong PIN", "error"); }

    function data() {
      const c = activity.counts();
      const src = catalog.source;
      const est = h("span.muted.small", "…");
      storage.estimate().then((e) => { est.textContent = e ? `${dom.bytes(e.used)} used of ${dom.bytes(e.quota)}` : ""; });
      const libs = h("div.lib-list", W.spinner());
      importer.libraries().then((items) => dom.replace(libs, items.map((d) => libraryRow(d, d.id === (src?.id === "auto" ? "auto" : src?.library?.id || src?.id)))));
      const dead = activity.unavailableIds().length;
      return W.section("Data", "Libraries, backups and the storage this browser gives us",
        W.row("Libraries", "Switch, rename or remove the libraries stored in this browser", h("div.stack", libs, h("div.row-btns",
          W.btn("Import / replace", { icon: "upload", kind: "primary", size: "sm", onClick: () => nav.go("import") }),
          W.btn("Re-read file", { icon: "refresh", size: "sm", title: "Clear the cache of data/posts.js and read it again", onClick: async () => { await importer.reload(); actions.toast("Posts reloaded", "success"); render(); } }),
          W.btn("Load the sample library", { icon: "sparkles", size: "sm", onClick: async () => { try { await importer.loadSample(); actions.toast("Sample library loaded", "success"); render(); } catch (e) { actions.toast(e.message, "error"); } } })))),
        src?.error ? W.row("Last error", src.error, null, { cls: "row-error" }) : null,
        W.row("Keep text-only posts", "Show bookmarks without media (hidden by default)", W.toggle(P("keepTextOnly"), async (v) => { prefs.set({ keepTextOnly: v }); await importer.boot(); })),
        W.row("Local media folder", "Optional: a folder next to index.html holding <postId>_<n>.mp4/.jpg; played before the CDN", h("input.input", { value: P("localMediaDir"), placeholder: "media", onchange: (e) => prefs.set({ localMediaDir: e.target.value.trim() }) })),
        W.row("Media availability", "Check which posts still load from X. Dead ones are marked and can be hidden in one go.", healthControl(dead)),
        W.row("Your activity", `${c.seen} seen · ${c.starred} starred · ${c.hidden} hidden · ${c.collections} collections · ${c.progress} in progress`, h("div.row-btns",
          W.btn("Export", { icon: "download", title: "Save stars, collections, history as JSON", onClick: () => platform.download(JSON.stringify(activity.exportState(), null, 1), `xreels-activity-${new Date().toISOString().slice(0, 10)}.json`) }),
          W.btn("Restore", { icon: "upload", onClick: restoreActivity }))),
        W.row("Export library", "The normalised posts as JSON (re-importable) or as a ready data/posts.js", h("div.row-btns",
          W.btn("JSON", { icon: "download", onClick: () => platform.download(importer.exportPosts(catalog.posts), "posts.xreels.json") }),
          W.btn("posts.js", { icon: "download", onClick: () => platform.download(importer.exportPosts(catalog.posts, { asScript: true }), "posts.js") }))),
        W.row("Storage", est, h("div.row-btns",
          W.btn("Reset preferences", { onClick: async () => { if (await dialog.confirm("Reset all preferences to defaults?")) { prefs.reset(); render(); } } }),
          W.btn("Erase everything", { icon: "trash", kind: "danger", onClick: async () => { if (await dialog.confirm("Erase stars, collections, history, PIN, imported posts and preferences from this browser? data/posts.js is not affected.", { ok: "Erase", danger: true })) { await lock.forceReset(); await activity.resetAll(); await storage.clear(); location.reload(); } } }))),
        W.row("Debug panel", "Environment, boot timings and the last events — handy when reporting a problem", W.btn("Open", { icon: "info", onClick: debugPanel })));
    }
    function libraryRow(d, active) {
      const when = d.at ? new Date(d.at).toLocaleDateString() : "";
      return h("div.lib-row", { class: active ? "active" : "" },
        h("button.lib-main", { onclick: async () => { if (!active) { try { await importer.switchTo(d.id); render(); } catch (e) { actions.toast(e.message, "error"); } } } },
          icons.icon(d.builtin ? "database" : "layers", 16),
          h("div.lib-text", h("div.lib-name", d.label), h("div.lib-meta", `${dom.compact(d.count || 0)} posts${d.adapter ? " · " + d.adapter : ""}${when ? " · " + when : ""}`)),
          active ? h("span.badge.badge-accent", "Active") : null),
        d.builtin ? null : h("div.row-btns",
          W.iconBtn("edit", "Rename…", async () => { const name = await dialog.prompt("", { title: "Rename library", value: d.label, ok: "Save" }); if (name) { await importer.renameLibrary(d.id, name); render(); } }, { size: 16 }),
          W.iconBtn("trash", "Remove", async () => { if (await dialog.confirm(`Remove “${d.label}” from this browser?`, { ok: "Remove", danger: true })) { await importer.removeLibrary(d.id); actions.toast("Library removed", "success"); render(); } }, { size: 16, cls: "btn-danger-ghost" })));
    }
    function healthControl(dead) {
      const health = XR.resolve("app.health");
      const status = h("span.muted.small", dead ? `${dead} marked unavailable` : "");
      const bar = h("div.progress-line", h("span"));
      const run = W.btn("Check now", { icon: "zap", size: "sm", onClick: async () => {
        if (health.isRunning) { health.cancel(); return; }
        run.querySelector("span") && (run.querySelector("span").textContent = XR.resolve("core.i18n").t("Stop"));
        bar.classList.add("on");
        const res = await health.run({ concurrency: 6, onProgress: (p) => { bar.firstChild.style.width = Math.round((p.done / Math.max(1, p.total)) * 100) + "%"; status.textContent = `${p.done}/${p.total} · ${p.dead} dead`; } });
        bar.classList.remove("on");
        status.textContent = res.cancelled ? `Stopped · ${res.dead} dead so far` : `${res.checked} checked · ${res.dead} unavailable · ${res.unknown} unknown`;
        run.querySelector("span") && (run.querySelector("span").textContent = XR.resolve("core.i18n").t("Check now"));
      } });
      return h("div.stack", h("div.row-btns", run,
        W.btn("Hide all unavailable", { size: "sm", onClick: async () => { const ids = activity.unavailableIds(); for (const id of ids) activity.toggleHidden(id, true); actions.toast(`${ids.length} posts hidden`, "success"); } }),
        W.btn("Clear marks", { size: "sm", onClick: () => { activity.clearUnavailable(); status.textContent = ""; } })), bar, status);
    }
    async function debugPanel() {
      const diag = XR.resolve("app.diagnostics");
      const snap = await diag.snapshot();
      const pre = h("pre.debug-pre", JSON.stringify(snap, null, 1));
      dialog.open({ title: "Debug panel", size: "lg", body: h("div.stack", h("p.muted.small", `${snap.env.version} · ${snap.env.protocol} · storage: ${snap.env.storage} · ${snap.env.viewport}`), pre),
        actions: [{ label: "Copy report", kind: "primary", close: false, run: () => { platform.copy(JSON.stringify(snap, null, 1)); actions.toast("Copied", "success"); } }, { label: "Done", kind: "ghost" }] });
    }
    function restoreActivity() {
      const input = h("input", { type: "file", accept: ".json,application/json", style: { display: "none" }, onchange: async () => {
        const f = input.files[0]; if (!f) return;
        try { const obj = JSON.parse(await f.text()); const merge = await dialog.confirm("Merge with the current activity? (Cancel = replace it entirely)", { ok: "Merge", cancel: "Replace" }); activity.importState(obj, { merge }); actions.toast("Activity restored", "success"); render(); }
        catch (err) { actions.toast("Not a valid backup: " + err.message, "error"); }
      } });
      document.body.appendChild(input); input.click(); setTimeout(() => input.remove(), 60000);
    }
    function about() {
      const list = keys.list().filter((k) => k.desc);
      const groups = {};
      for (const k of list) (groups[k.scope] ||= []).push(k);
      return W.section("About & shortcuts", "XReels — a local-first viewer for your X bookmarks. Open-source, no server, no tracking.",
        h("div.shortcut-cols", Object.entries(groups).map(([scope, items]) => h("div.shortcut-group", h("h4", scope === "global" ? "Everywhere" : scope[0].toUpperCase() + scope.slice(1)), items.map((k) => h("div.shortcut", W.kbd(k.combo.replace("mod", platform.isTouch() ? "ctrl" : navigator.platform?.includes("Mac") ? "⌘" : "ctrl").replace("arrow", "")), h("span", k.desc)))))),
        h("p.muted.small", "Watch gestures: swipe or wheel to move · tap to pause · double-tap to star · hold for 2× · drag sideways to seek."));
    }
    return {
      id: "settings", title: "Settings", icon: "settings", route: "/settings", nav: true, order: 110, key: "s",
      mount(outlet) { host = outlet; render(); }, unmount() { host = null; },
      commands: () => [
        { id: "settings.open", title: "Open Settings", icon: "settings", run: () => nav.go("settings") },
        { id: "settings.blur", title: "Toggle privacy blur", icon: "eyeOff", run: () => prefs.set({ blur: !prefs.get("blur") }) },
        { id: "settings.discreet", title: "Toggle discreet tab title", icon: "shield", run: () => prefs.set({ discreet: !prefs.get("discreet") }) },
        { id: "settings.lock", title: lock.isEnabled() ? "Lock now" : "Set a PIN", icon: "lock", run: () => (lock.isEnabled() ? lock.lock() : nav.go("settings")) },
      ],
    };
  });
