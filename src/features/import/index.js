/* features.import — getting posts in: drop/pick a file, paste JSON, or put the
   file at data/posts.js. Shows a preview (format, counts) before committing. */
XR.define("features.import", ["ui.dom", "ui.icons", "ui.widgets", "app.importer", "app.catalog", "app.actions", "app.media", "app.nav", "app.ports.platform", "app.ports.dataSources", "core.events", "core.domain.events", "app.activity", "core.i18n"],
  function (dom, icons, W, importer, catalog, actions, media, nav, platform, sources, events, EV, activity, i18n) {
    "use strict";
    const h = dom.h;
    let host = null, offs = [], preview = null, pendingFile = null;

    function render() {
      dom.clear(host);
      const src = catalog.source;
      const page = h("div.import",
        W.pageHead(catalog.size ? "Import posts" : "Welcome to XReels", catalog.size ? `Currently showing ${src.count} posts from ${src.label}` : "Your X bookmarks, as a private video & photo feed. Let's load them."),
        h("div.import-grid",
          card("upload", "Upload a file", "Drop it anywhere in the app, or pick it.", h("div.stack",
            h("label.dropzone", { for: "xr-file", ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("over"); }, ondragleave: (e) => e.currentTarget.classList.remove("over"), ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) analyzeFile(f); } },
              icons.icon("upload", 28), h("span", "Drop .json or .js here"), h("span.muted.small", "or click to choose"),
              h("input", { id: "xr-file", type: "file", accept: ".json,.js,.txt,application/json,text/javascript", style: { display: "none" }, onchange: (e) => { const f = e.target.files[0]; if (f) analyzeFile(f); } })),
            h("p.muted.small", "Formats: xdash POSTS.json · twitter-web-exporter · X bookmark Chrome extensions · X API v2 · XReels export · any JSON with tweet-like objects. ", h("a.link", { href: "docs/DATA-FORMATS.md", target: "_blank" }, "Details")))),
          card("paste", "Paste JSON", "Copy the export's content and paste it here.", (() => {
            const ta = h("textarea.input.import-paste", { placeholder: '{"export_version":1,"bookmarks":[…]}  or  window.XREELS_DATA = {…};', rows: 6, spellcheck: false });
            return h("div.stack", ta, h("div.row-btns", W.btn("Analyse", { icon: "search", kind: "primary", onClick: () => { if (ta.value.trim()) analyzeText(ta.value, "Pasted JSON"); } }), W.btn("Paste from clipboard", { icon: "paste", onClick: async () => { try { ta.value = await navigator.clipboard.readText(); analyzeText(ta.value, "Clipboard"); } catch { actions.toast("Clipboard not available — paste manually (Ctrl+V)", "error"); } } })));
          })()),
          card("database", "Put the file in the project", "The zero-click way: XReels reads data/posts.js every time it opens.", h("div.stack",
            h("ol.steps",
              h("li", "Open ", h("code", "data/posts.template.js"), " for the exact format."),
              h("li", "Save your export as ", h("code", "data/posts.js"), " starting with ", h("code", "window.XREELS_DATA = "), " and ending with ", h("code", ";")),
              h("li", "Reload. The file is cached until its content changes.")),
            h("div.row-btns",
              W.btn("Re-read data/posts.js", { icon: "refresh", onClick: async () => { splashless(async () => { await importer.reload(); }); } }),
              catalog.size ? W.btn("Download current as posts.js", { icon: "download", title: "Writes a ready-to-use data/posts.js from what is loaded now", onClick: () => platform.download(importer.exportPosts(catalog.posts, { asScript: true }), "posts.js") }) : null),
            sources.get("url")?.available() ? h("div.row-btns", (() => { const inp = h("input.input", { placeholder: "https://…/posts.json", style: { flex: 1 } }); return h("div.url-row", inp, W.btn("Fetch", { icon: "download", onClick: () => inp.value && analyze(() => importer.importUrl(inp.value.trim())) })); })()) : h("p.muted.small", "URL import is unavailable on file:// — use upload or paste."))),
        ),
        h("div.import-preview"));
      host.appendChild(page);
      if (pendingFile) { const f = pendingFile; pendingFile = null; analyzeFile(f); }
    }
    const card = (icon, title, text, body) => h("section.import-card", h("div.import-card-head", icons.icon(icon, 20), h("h2", title)), h("p.muted", text), body);

    async function splashless(fn) { try { await fn(); actions.toast(`Loaded ${catalog.size} posts`, "success"); render(); } catch (err) { actions.toast(err.message, "error"); } }
    const analyzeFile = (file) => analyze(() => importer.importFile(file));
    const analyzeText = (text, label) => analyze(() => importer.importText(text, label));
    async function analyze(fn) {
      const box = host.querySelector(".import-preview");
      dom.replace(box, W.spinner("Reading…"));
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
      try { preview = await fn(); renderPreview(); }
      catch (err) { console.error(err); dom.replace(box, h("div.import-error", icons.icon("alert", 20), h("div", h("b", "Couldn't read that"), h("p.muted", err.message), h("p.small.muted", "Supported shapes are documented in docs/DATA-FORMATS.md. If this is a new exporter, the file name + first lines would be enough to add an adapter.")))); }
    }
    function renderPreview() {
      const box = host.querySelector(".import-preview");
      const an = preview, d = an.diff || {}, t = i18n.t;
      const sample = an.posts.filter((p) => p.media.length).slice(0, 12);
      const hasLib = catalog.size > 0 && catalog.source.id !== "none";
      let mode = hasLib && !d.empty && d.same > 0 ? "replace" : (hasLib ? "new" : "replace");
      const keepGone = h("input", { type: "checkbox", checked: false });
      const nameInput = h("input.input", { value: an.label || "", placeholder: t("Name"), style: { maxWidth: "260px" } });
      const modeSeg = hasLib ? W.segmented([
        { value: "replace", label: "Replace", title: "Replace the active library with this file" },
        { value: "merge", label: "Merge", title: "Keep posts missing from the file, add the new ones" },
        { value: "new", label: "New library", title: "Store it as a separate library you can switch to" }], mode, (v) => { mode = v; nameInput.style.display = v === "new" ? "" : "none"; goneRow.style.display = v === "replace" && d.missing ? "" : "none"; }) : null;
      nameInput.style.display = mode === "new" ? "" : "none";
      const goneRow = h("label.check", keepGone, h("span", t("Keep the {n} posts that disappeared as a collection “Gone from X bookmarks”", { n: d.missing || 0 })));
      goneRow.style.display = mode === "replace" && d.missing ? "" : "none";
      const diffCard = hasLib && !d.empty ? h("div.diff-card",
        h("div.diff-head", icons.icon("sliders", 16), h("b", t("What changed")), h("span.muted.small", ` · ${t("compared with")} ${catalog.source.label}`)),
        h("div.diff-row",
          h("span.diff-pill.add", `+${d.added} ${t("new")}`),
          h("span.diff-pill.gone", `−${d.missing} ${t("gone")}`),
          h("span.diff-pill.chg", `~${d.changed} ${t("changed")}`),
          h("span.diff-pill", `=${d.same} ${t("unchanged")}`))) : null;
      dom.replace(box, h("section.panel.import-result",
        h("h3.panel-title", icons.icon("check", 18), " ", t("Ready to import")),
        h("div.stat-grid.compact", W.stat(an.posts.length, "posts"), W.stat(an.withMedia, "with media"), W.stat(an.videos, "videos"), W.stat(an.creators, "creators"), W.stat(an.dropped || 0, "unreadable"), W.stat(an.adapter, "format")),
        sample.length ? h("div.import-sample", sample.map((p) => h("img", { src: media.thumb(p.media[0], 90), alt: "", loading: "lazy" }))) : h("p.muted", t("No media posts found in this file.")),
        diffCard,
        modeSeg ? h("div.stack", h("div.row-btns", modeSeg, nameInput), goneRow) : null,
        h("div.row-btns",
          W.btn("Import", { icon: "upload", kind: "primary", onClick: async () => {
            try {
              const goneIds = (mode === "replace" && keepGone.checked && d.missingIds?.length) ? d.missingIds.slice() : null;
              const gonePosts = goneIds ? catalog.postsByIds(goneIds) : [];
              await importer.commit(an, { mode, name: mode === "new" ? nameInput.value.trim() || an.label : undefined });
              if (goneIds) {
                const c = activity.createCollection(t("Gone from X bookmarks"));
                activity.addToCollection(c.id, goneIds);
                if (gonePosts.length) actions.toast(t("{n} posts kept in the collection", { n: gonePosts.length }), "success");
              }
              actions.toast(t("Imported {n} posts", { n: catalog.size }), "success"); nav.go("discover");
            } catch (err) { actions.toast(err.message, "error"); }
          } }),
          W.btn("Cancel", { kind: "ghost", onClick: () => { preview = null; dom.clear(box); } }))));
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    return {
      id: "import", title: "Import", icon: "upload", route: "/import", nav: true, order: 120, key: "m",
      mount(outlet) {
        host = outlet; render();
        offs = [events.bus.on(EV.DATASET_PROGRESS, ({ phase, file }) => { if (phase === "dropped" && file) { if (host) analyzeFile(file); else pendingFile = file; } })];
      },
      unmount() { for (const off of offs) off(); offs = []; host = null; preview = null; },
      commands: () => [{ id: "import.open", title: "Import posts", icon: "upload", run: () => nav.go("import") }],
    };
  });
