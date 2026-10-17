/* ui.charts — dependency-free SVG charts for Insights: bars, sparkline, donut, heat strip. */
XR.define("ui.charts", ["ui.dom"], function (dom) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const s = (tag, attrs = {}, ...kids) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); for (const k of kids) el.appendChild(typeof k === "string" ? document.createTextNode(k) : k); return el; };

  /** bars([{label, value, hint}], {height, color, onClick}) — vertical bars with labels */
  function bars(data, { height = 140, color = "var(--accent)", onClick, maxLabels = 12, format = (v) => String(v), minBar = 5, grid = true } = {}) {
    /* a 2–6 point series is a comparison, not a time axis: cap the canvas so bars stay bars */
    const narrow = data.length <= 6;
    const w = narrow ? Math.max(180, data.length * 76) : Math.max(240, data.length * 28);
    const max = Math.max(1, ...data.map((d) => d.value));
    /* fill the panel; text is authored at 10px so scaling shrinks it sparingly */
    const svg = s("svg", { viewBox: `0 0 ${w} ${height + 22}`, class: "chart chart-bars" + (narrow ? " chart-bars-narrow" : ""), preserveAspectRatio: "none", style: narrow ? `max-width:${w}px` : null });
    const bw = w / data.length;
    /* a sparse series (19 months, 2 of them with saves) must not read as two giant slabs */
    const sparse = data.filter((d) => d.value > 0).length <= Math.max(2, data.length / 6);
    if (sparse && grid) {
      const steps = 3;
      for (let k = 1; k <= steps; k++) svg.appendChild(s("line", { x1: 0, x2: w, y1: (height - 8) * k / steps + 4, y2: (height - 8) * k / steps + 4, stroke: "rgb(255 255 255 / 0.07)", "stroke-width": 1, "stroke-dasharray": "2 4" }));
    }
    data.forEach((d, i) => {
      const bh = Math.round((d.value / max) * (height - 8));
      const g = s("g", { class: "bar" + (onClick ? " clickable" : ""), tabindex: onClick ? "0" : null });
      if (onClick) { g.addEventListener("click", () => onClick(d, i)); }
      const barW = Math.min(bw * 0.7, 56), bx = i * bw + (bw - barW) / 2;
      /* quiet track so bars read as bars, not a solid slab */
      if (!sparse) g.appendChild(s("rect", { x: bx, y: 4, width: barW, height: height - 4, rx: 3, fill: "rgb(255 255 255 / 0.05)" }));
      else g.appendChild(s("rect", { x: bx, y: height - 1, width: barW, height: 1, rx: 1, fill: "rgb(255 255 255 / 0.08)" }));
      const h = d.value > 0 ? Math.max(bh, minBar) : 0;
      if (h) g.appendChild(s("rect", { x: bx, y: height - h, width: barW, height: h, rx: 2, fill: color, opacity: d.muted ? 0.35 : 0.9 }));
      g.appendChild(s("title", {}, `${d.label}: ${format(d.value)}${d.hint ? " · " + d.hint : ""}`));
      svg.appendChild(g);
    });
    const step = Math.ceil(data.length / maxLabels);
    /* labels only where they fit: ~34px of room each, never overlapping */
    const labelEvery = Math.max(step, Math.ceil(data.length * 34 / w));
    data.forEach((d, i) => { if (i % labelEvery === 0) svg.appendChild(s("text", { x: i * bw + bw / 2, y: height + 16, "text-anchor": "middle", class: "chart-label" }, d.short || d.label)); });
    return svg;
  }
  /** hbars([{label, value, sub}], {max, color, onClick}) — horizontal bars as HTML (labels wrap nicely) */
  function hbars(data, { color = "var(--accent)", onClick, format = (v) => dom.compact(v) } = {}) {
    const max = Math.max(1, ...data.map((d) => d.value));
    return dom.h("div.hbars", data.map((d) => dom.h("button.hbar", { onclick: onClick ? () => onClick(d) : null, disabled: !onClick },
      dom.h("span.hbar-label", d.label), dom.h("span.hbar-track", dom.h("span.hbar-fill", { style: { width: (d.value / max * 100).toFixed(1) + "%", background: d.color || color } })), dom.h("span.hbar-value", format(d.value)))));
  }
  /** donut([{label, value, color}], {size}) */
  function donut(data, { size = 120, thickness = 14 } = {}) {
    const total = Math.max(1, data.reduce((a, d) => a + d.value, 0));
    const r = (size - thickness) / 2, c = 2 * Math.PI * r;
    const svg = s("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: "chart chart-donut" });
    let offset = 0;
    for (const d of data) {
      const len = (d.value / total) * c;
      const circle = s("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: d.color, "stroke-width": thickness, "stroke-dasharray": `${len} ${c - len}`, "stroke-dashoffset": -offset, transform: `rotate(-90 ${size / 2} ${size / 2})` });
      circle.appendChild(s("title", {}, `${d.label}: ${d.value} (${Math.round(d.value / total * 100)}%)`));
      svg.appendChild(circle);
      offset += len;
    }
    return svg;
  }
  /** heat(values[24] or [7]) — small strip of cells shaded by value */
  function heat(values, labels = [], { color = "var(--accent)" } = {}) {
    const max = Math.max(1, ...values);
    return dom.h("div.heat", values.map((v, i) => dom.h("span.heat-cell", { title: `${labels[i] ?? i}: ${v}`, style: { background: color, opacity: (0.08 + 0.92 * (v / max)).toFixed(2) } })));
  }
  /** calendar(days) — GitHub-style saving heatmap, current on crimson.
   *  days: [{ date: Date, value: n }] ascending, any length (gaps = {date} without value).
   *  Renders a 7-row (Sun→Sat) column grid; month labels above, weekday marks left.
   *  onClick({date,value}) receives a single day. Uses DOM (tooltips, :hover transitions). */
  function calendar(days, { onClick, color = "var(--accent)" } = {}) {
    const max = Math.max(1, ...days.map((d) => d.value));
    const root = dom.h("div.cal", { role: "img", "aria-label": "Saving activity heatmap" });
    let lastMonth = -1;
    const labels = [];
    days.forEach((d, i) => {
      const col = Math.floor(i / 7);
      const m = d.date.getMonth();
      if (i % 7 === 0 && m !== lastMonth) { labels.push(dom.h("span.cal-month", { style: { left: `calc(${col} * (var(--cal-cell) + var(--cal-gap)))` } }, d.date.toLocaleString(undefined, { month: "short" }))); lastMonth = m; }
    });
    if (labels.length) root.appendChild(dom.h("div.cal-months", labels));
    const body = dom.h("div.cal-body");
    const gutter = dom.h("div.cal-gutter", [0, 2, 4, 6].map((r) => dom.h("span.cal-dow", { style: { top: `calc(${r} * (var(--cal-cell) + var(--cal-gap)))` } }, ["S", "M", "T", "W", "T", "F", "S"][r])));
    body.appendChild(gutter);
    const grid = dom.h("div.cal-grid");
    let todayISO = new Date().toDateString();
    days.forEach((d) => {
      const lvl = d.value <= 0 ? 0 : 0.14 + 0.86 * (d.value / max);
      const cell = dom.h("button.cal-cell", { title: d.value ? `${d.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} — ${d.value} saved` : d.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }), style: { opacity: d.value ? lvl.toFixed(2) : "1" }, onclick: onClick ? () => onClick(d) : null });
      if (d.value) cell.style.background = color; else cell.classList.add("cal-empty");
      cell.disabled = !onClick;
      if (d.date.toDateString() === todayISO) cell.classList.add("cal-today");
      grid.appendChild(cell);
    });
    body.appendChild(grid);
    root.appendChild(body);
    return root;
  }
  /** legend([{label, value, color}]) */
  const legend = (data) => dom.h("ul.legend", data.map((d) => dom.h("li", dom.h("i", { style: { background: d.color } }), dom.h("span", d.label), dom.h("b", dom.compact(d.value)))));
  return { bars, hbars, donut, heat, calendar, legend };
});
