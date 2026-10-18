/* features.insights — numbers about the archive and your habits, as SVG charts. */
XR.define("features.insights", ["ui.dom", "ui.icons", "ui.widgets", "ui.charts", "app.catalog", "app.activity", "app.actions", "app.nav", "app.media", "core.util"],
  function (dom, icons, W, charts, catalog, activity, actions, nav, media, util) {
    "use strict";
    const h = dom.h;
    let host = null;

    function render() {
      dom.clear(host);
      if (!catalog.size) { host.appendChild(W.empty({ icon: "chart", title: "No data yet", action: { label: "Import", run: () => nav.go("import") } })); return; }
      const st = catalog.stats();
      const posts = catalog.posts.filter((p) => p.media.length);
      const page = h("div.insights", W.pageBar("Insights", `${dom.compact(st.withMedia)} media posts · ${dom.hours(st.seconds)} of video`));

      page.appendChild(recap(posts));
      page.appendChild(h("div.stat-grid",
        W.stat(dom.compact(st.posts), "posts", "bookmark"), W.stat(dom.compact(st.videos), "videos", "play"), W.stat(dom.compact(st.photos), "photos", "image"),
        W.stat(dom.compact(st.carousels), "albums", "layers"), W.stat(dom.compact(st.creators), "creators", "users"), W.stat(dom.hours(st.seconds), "footage", "clock"),
        W.stat(`${Math.round(st.seen / Math.max(1, st.withMedia) * 100)}%`, "seen", "eye"), W.stat(dom.compact(st.starred), "starred", "star"),
        (() => { const g = catalog.dupGroups.length; const el = W.stat(dom.compact(g), "duplicates", "copy"); if (g) { el.classList.add("stat-link"); el.title = "Open duplicates in Library"; el.onclick = () => actions.goLibrary({ q: "is:dup" }); } return el; })(),
        (() => { const n = activity.unavailableIds().length; const el = W.stat(dom.compact(n), "unavailable", "alert"); if (n) { el.classList.add("stat-link"); el.onclick = () => actions.goLibrary({ q: "is:unavailable" }); } return el; })()));

      /* kinds donut */
      const kinds = { short: 0, long: 0, gif: 0, photo: 0, carousel: 0 };
      for (const p of posts) { const k = catalog.ctx.kindOf(p); if (k in kinds) kinds[k]++; }
      const kindData = [["short", "Shorts", "#e50914"], ["long", "Long videos", "#8f8f8f"], ["gif", "GIFs", "#54b9c5"], ["photo", "Photos", "#46d488"], ["carousel", "Albums", "#ffc425"]].map(([k, label, color]) => ({ label, value: kinds[k], color, kind: k }));
      /* per month: posted (createdAt) and saved (captured) */
      const toSeries = (list) => list.slice().reverse().map((m) => ({ label: m.label, short: m.key.slice(2).replace("-", "/"), value: m.count, key: m.key }));
      const postedByMonth = toSeries(catalog.months.slice(0, 36));
      /* a single saved month is a fact, not a chart: only plot once there is a series */
      const savedByMonth = toSeries(catalog.savedMonths);
      /* duration buckets */
      const buckets = [["≤15s", 0, 15], ["15–60s", 15, 60], ["1–3m", 60, 180], ["3–10m", 180, 600], ["10–30m", 600, 1800], ["30m+", 1800, Infinity]].map(([label, lo, hi]) => ({ label, value: 0, lo, hi }));
      for (const p of posts) for (const m of p.media) if (m.kind === "video") { const b = buckets.find((x) => m.duration > x.lo && m.duration <= x.hi); if (b) b.value++; }
      /* posting hour heat */
      const hours = new Array(24).fill(0), days = new Array(7).fill(0);
      for (const p of posts) { if (!p.createdAt) continue; const d = new Date(p.createdAt); hours[d.getHours()]++; days[d.getDay()]++; }
      /* top creators / tags */
      const topCreators = catalog.creators("count").slice(0, 12).map((c) => ({ label: "@" + c.username, value: c.count, username: c.username }));
      const topTags = catalog.topHashtags(12).map(([t, n]) => ({ label: "#" + t, value: n, tag: t }));
      const topLiked = posts.slice().sort((a, b) => b.metrics.likes - a.metrics.likes).slice(0, 8);
      const affinity = [...activity.creatorAffinity().entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u, n]) => ({ label: "@" + u, value: n, username: u }));
      const aspects = { vertical: 0, square: 0, landscape: 0 };
      for (const p of posts) { const a = p.media[0].aspect; aspects[a < 0.9 ? "vertical" : a > 1.1 ? "landscape" : "square"]++; }

      const grid = h("div.insight-grid");
      dom.append(grid, [
        panel("What you save", h("div.row-flex", charts.donut(kindData, { size: 140 }), charts.legend(kindData)), "Choose a kind in Library to filter it."),
        panel("Posted per month", charts.bars(postedByMonth, { height: 120, onClick: (d) => actions.goLibrary({ month: d.key }) }), "When the posts were published (last 36 months). Click a bar to open that month."),
        savedByMonth.length > 1
          ? panel("Saved per month", charts.bars(savedByMonth, { height: 120, onClick: (d) => actions.goLibrary({ savedMonth: d.key }) }), "When you bookmarked them.")
          : savedByMonth.length === 1
            ? panel("Saved per month", h("div.saved-single", h("b", savedByMonth[0].value), h("span", `saved in ${savedByMonth[0].label}`)), "Add another import to see a trend.")
            : null,
        panel("Video length", charts.hbars(buckets, { onClick: (d) => actions.goLibrary({ q: d.hi === Infinity ? `dur:>${d.lo}s` : `dur:${d.lo}s-${d.hi}s` }), format: (v) => String(v) })),
        panel("Top creators", charts.hbars(topCreators, { onClick: (d) => actions.goCreator(d.username), format: (v) => String(v) })),
        topTags.length ? panel("Top hashtags", charts.hbars(topTags, { onClick: (d) => actions.goTag(d.tag), format: (v) => String(v) })) : null,
        affinity.length ? panel("Creators you open most", charts.hbars(affinity, { onClick: (d) => actions.goCreator(d.username), format: (v) => String(v) }), "Based on what you watched here.") : null,
        panel("When posts were published", h("div.stack", h("div.heat-wrap", h("span.small.muted", "Hour of day"), charts.heat(hours, hours.map((_, i) => `${i}:00`))), h("div.heat-wrap", h("span.small.muted", "Weekday"), charts.heat(days, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])))),
        panel("Orientation", charts.hbars([{ label: "Vertical", value: aspects.vertical }, { label: "Square", value: aspects.square }, { label: "Landscape", value: aspects.landscape }], { format: (v) => String(v) })),
        savingRhythmPanel(),
        panel("Most liked posts", h("ol.top-list", topLiked.map((p, i) => h("li", h("button.top-item", { onclick: () => actions.view(topLiked.map((x) => x.id), i, { label: "Most liked" }) }, h("img", { src: media.thumb(p.media[0], 80), alt: "", loading: "lazy", decoding: "async" }), h("span.top-text", h("b", "@" + p.author.username), h("span.muted", util.truncate(p.text || catalog.ctx.kindOf(p), 60))), h("span.top-num", icons.icon("heart", 12, { filled: true }), dom.compact(p.metrics.likes))))))),
      ]);
      page.appendChild(grid);
      host.appendChild(page);
    }
    const panel = (title, body, foot) => h("section.panel", h("h2.panel-title", title), body, foot ? h("p.panel-foot.muted.small", foot) : null);

    const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    /** last N calendar days ascending, each { date, value } = saves that day */
    function savingDays(weeks) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const n = weeks * 7;
      const start = new Date(today); start.setDate(start.getDate() - (n - 1 - today.getDay()));
      const counts = new Map();
      for (const p of catalog.posts) {
        if (!p.savedAt) continue;
        const d = new Date(p.savedAt); if (d < start || d > today) continue;
        const k = dayKey(d); counts.set(k, (counts.get(k) || 0) + 1);
      }
      const days = [];
      for (const t = new Date(start); t <= today; t.setDate(t.getDate() + 1)) days.push({ date: new Date(t), value: counts.get(dayKey(t)) || 0 });
      return days;
    }

    function savingRhythmPanel() {
      const days = savingDays(18);
      const total = days.reduce((a, d) => a + d.value, 0);
      const busiest = days.reduce((a, d) => (d.value > (a?.value || 0) ? d : a), null);
      let streak = 0;
      for (let i = days.length - 1; i >= 0 && days[i].value > 0; i--) streak++;
      const foot = busiest?.value
        ? `${dom.compact(total)} saved in 18 weeks · busiest day ${busiest.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} (${busiest.value})` + (streak > 1 ? ` · ${streak}-day streak` : "")
        : "Nothing saved in the last 18 weeks yet.";
      return panel("Saving rhythm", charts.calendar(days, { onClick: (d) => actions.goLibrary({ month: util.monthKey(+d.date) }) }), foot);
    }

    /** editorial recap strip: last-30-days stats, top creator, top pick (16:9 thumb) */
    function recap(posts) {
      const now = Date.now(), day = 864e5;
      const inWin = (p, from, to) => { const s = p.savedAt || 0; return s > from && s <= to && !!p.media.length; };
      const cur = posts.filter((p) => inWin(p, now - 30 * day, now));
      const prev = posts.filter((p) => inWin(p, now - 60 * day, now - 30 * day));
      if (!cur.length) return h("section.recap", h("div.recap-in", h("p.recap-kicker", "Last 30 days"), h("p.recap-title", "Nothing new saved"), h("p.recap-sub", "Drop a bookmarks export in Import and this strip lights up.")));
      const delta = prev.length ? Math.round(((cur.length - prev.length) / prev.length) * 100) : null;
      const byCreator = new Map();
      for (const p of cur) byCreator.set(p.author.username, (byCreator.get(p.author.username) || 0) + 1);
      const topCreator = [...byCreator.entries()].sort((a, b) => b[1] - a[1])[0];
      const top = cur.slice().sort((a, b) => b.metrics.likes - a.metrics.likes)[0];
      const bestMedia = top && top.media[0];
      const stat = (big, small) => h("div.recap-stat", h("b.recap-big", big), h("span.recap-small", small));
      return h("section.recap",
        h("div.recap-in",
          h("div.recap-head",
            h("p.recap-kicker", icons.icon("sparkles", 13), " Last 30 days in your archive"),
            delta === null ? null : h("span.recap-delta", { class: delta >= 0 ? "is-up" : "is-down" }, icons.icon(delta >= 0 ? "chevronUp" : "chevronDown", 11), `${Math.abs(delta)}% vs before`)),
          h("div.recap-row",
            stat("+" + cur.length, "saved this month"),
            topCreator ? stat(dom.compact(topCreator[1]), "from @" + topCreator[0]) : null,
            stat(String(cur.filter((p) => p.metrics.likes > 0).length), "with likes"),
            h("button.recap-pick", { title: top.text || "", onclick: () => actions.view(cur.map((p) => p.id), cur.indexOf(top), { label: "Top pick" }) },
              bestMedia ? h("img", { src: media.thumb(bestMedia, 160), alt: "", loading: "lazy", decoding: "async" }) : null,
              h("span.recap-pick-text",
                h("i", "Top pick"),
                h("b", "@" + (top?.author.username || "")),
                top?.metrics.likes ? h("span", icons.icon("heart", 11, { filled: true }), dom.compact(top.metrics.likes)) : null)))));
    }

    return {
      id: "insights", title: "Insights", icon: "chart", route: "/insights", nav: true, order: 60, key: "i",
      mount(outlet) { host = outlet; render(); },
      unmount() { host = null; },
      commands: () => [{ id: "insights.open", title: "Open Insights", icon: "chart", run: () => nav.go("insights") }],
    };
  });
