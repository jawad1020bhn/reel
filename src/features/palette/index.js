/* features.palette — command palette (⌘K / Ctrl+K): navigation, feature commands,
   creators, collections, saved views and a free-text library search. Also the "?" shortcut sheet. */
XR.define("features.palette", ["ui.dom", "ui.icons", "ui.widgets", "ui.keys", "ui.dialog", "app.features", "app.nav", "app.catalog", "app.actions", "core.events", "core.domain.events", "core.util", "core.i18n"],
  function (dom, icons, W, keys, dialog, features, nav, catalog, actions, events, EV, util, i18n) {
    "use strict";
    const h = dom.h;
    let el = null, input = null, list = null, items = [], cursor = 0, baseCommands = [];

    function collect() {
      const cmds = [];
      for (const f of features.navItems()) cmds.push({ id: "go:" + f.id, title: i18n.t("Go to ") + i18n.t(f.title), icon: f.icon, keys: f.key ? "g " + f.key : "", run: () => nav.go(f.id) });
      cmds.push(...features.commands());
      cmds.push({ id: "help", title: "Keyboard shortcuts", icon: "keyboard", keys: "?", run: () => showShortcuts() });
      return util.uniq(cmds, (c) => c.id);
    }
    function open({ query = "" } = {}) {
      if (el) { input.value = query; filter(); input.focus(); return; }
      if (query === "?") return showShortcuts();
      baseCommands = collect();
      input = h("input.palette-input", { type: "text", placeholder: "Type a command, a creator, #tag, or search…", value: query, autocomplete: "off", spellcheck: false, oninput: filter,
        onkeydown: (e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
          else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
          else if (e.key === "Enter") { e.preventDefault(); run(items[cursor]); }
          else if (e.key === "Escape") { e.preventDefault(); close(); }
          e.stopPropagation();
        } });
      list = h("div.palette-list", { role: "listbox" });
      el = h("div.palette-backdrop", { onclick: (e) => { if (e.target === el) close(); } }, h("div.palette", { role: "dialog", "aria-label": "Command palette" }, h("div.palette-head", icons.icon("command", 18), input, W.kbd("esc")), list, h("div.palette-foot.muted.small", "↑↓ navigate · ↵ run · type to search posts, @creator, #tag, >command")));
      document.body.appendChild(el);
      requestAnimationFrame(() => { el.classList.add("in"); input.focus(); });
      filter();
    }
    function close() { if (!el) return; const node = el; el = null; node.classList.remove("in"); setTimeout(() => node.remove(), 150); }
    function filter() {
      const q = input.value.trim();
      const ql = q.toLowerCase();
      items = [];
      if (!q) items = baseCommands.slice(0, 14);
      else if (q.startsWith(">")) items = baseCommands.filter((c) => c.title.toLowerCase().includes(ql.slice(1).trim()));
      else {
        const scored = baseCommands.map((c) => ({ c, s: score(c.title.toLowerCase(), ql) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8).map((x) => x.c);
        items.push(...scored);
        if (q.startsWith("@")) { const u = q.slice(1).toLowerCase(); for (const c of catalog.creators("count")) { if (c.username.toLowerCase().startsWith(u) || c.name.toLowerCase().includes(u)) items.push({ id: "c:" + c.username, title: `@${c.username} · ${c.name}`, hint: `${c.count} posts`, icon: "users", run: () => nav.go("creators", { user: c.username }) }); if (items.length > 18) break; } }
        else if (q.startsWith("#")) { for (const [t, n] of catalog.topHashtags(400)) if (t.toLowerCase().startsWith(ql.slice(1))) { items.push({ id: "t:" + t, title: "#" + t, hint: `${n} posts`, icon: "hash", run: () => actions.goTag(t) }); if (items.length > 18) break; } }
        else {
          const res = catalog.query({ q, limit: 6 });
          items.push({ id: "search", title: `Search library for “${q}”`, hint: `${res.total} results`, icon: "search", run: () => nav.go("library", {}, { q }) });
          if (res.total) items.push({ id: "watch-search", title: `Watch results for “${q}”`, hint: `${res.total}`, icon: "play", run: () => { const ids = catalog.query({ q }).items.map((p) => p.id); actions.watch(ids, 0, { label: q }); } });
          for (const p of res.items) items.push({ id: "p:" + p.id, title: `@${p.author.username}: ${util.truncate(p.text || catalog.ctx.kindOf(p), 70)}`, hint: dom.date(p.createdAt), icon: p.media[0]?.kind === "photo" ? "image" : "play", run: () => actions.view([p.id], 0, { label: "Search" }) });
        }
      }
      items = util.uniq(items, (it) => it.title.toLowerCase());
      cursor = 0;
      renderList();
    }
    function score(title, q) { if (title.includes(q)) return 10 - title.indexOf(q) / 100; let i = 0; for (const ch of title) if (ch === q[i]) i++; return i === q.length ? 1 : 0; }
    function renderList() {
      dom.replace(list, items.length ? items.map((it, i) => h("button.palette-item", { role: "option", class: i === cursor ? "active" : "", "aria-selected": i === cursor ? "true" : "false", onclick: () => run(it), onmousemove: () => { if (cursor !== i) { cursor = i; renderList(); } } },
        icons.icon(it.icon || "sparkles", 16), h("span.palette-title", i18n.t(it.title)), it.hint ? h("span.palette-hint", it.hint) : null, it.keys ? W.kbd(it.keys) : null)) : h("p.muted.palette-empty", "No matches"));
      list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
    }
    function move(d) { if (!items.length) return; cursor = (cursor + d + items.length) % items.length; renderList(); }
    function run(it) { if (!it) return; close(); try { it.run(); } catch (err) { console.error(err); actions.toast(String(err.message || err), "error"); } }
    function showShortcuts() {
      close();
      const groups = {};
      for (const k of keys.list()) (groups[k.scope] ||= []).push(k);
      const body = h("div.shortcut-cols", Object.entries(groups).map(([scope, items2]) => h("div.shortcut-group", h("h4", scope === "global" ? "Everywhere" : scope[0].toUpperCase() + scope.slice(1)), items2.map((k) => h("div.shortcut", W.kbd(k.combo.replace("mod", "ctrl").replace("arrow", "")), h("span", k.desc))))));
      dialog.open({ title: "Keyboard shortcuts", size: "lg", body });
    }
    return {
      id: "palette", title: "Command palette", icon: "command", route: null, nav: false, order: 910,
      init() { events.bus.on(EV.PALETTE_OPEN, (p) => open(p || {})); events.bus.on(EV.ROUTE_CHANGED, () => close()); },
      commands: () => [],
    };
  });
