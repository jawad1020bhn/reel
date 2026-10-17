/* ui.charts — dependency-free SVG charts for Insights: bars, sparkline, donut, heat strip. */
XR.define("ui.charts", ["ui.dom"], function (dom) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const s = (tag, attrs = {}, ...kids) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); for (const k of kids) el.appendChild(typeof k === "string" ? document.createTextNode(k) : k); return el; };

  /** bars([{label, value, hint}], {height, color, onClick}) — vertical bars with labels */
  function bars(data, { height = 140, color = "var(--accent)", onClick, maxLabels = 12, format = (v) => String(v) } = {}) {
    const w = Math.max(240, data.length * 28), max = Math.max(1, ...data.map((d) => d.value));
    const svg = s("svg", { viewBox: `0 0 ${w} ${height + 22}`, class: "chart chart-bars", preserveAspectRatio: "none" });
    const bw = w / data.length;
    data.forEach((d, i) => {
      const bh = Math.round((d.value / max) * (height - 8));
      const g = s("g", { class: "bar" + (onClick ? " clickable" : ""), tabindex: onClick ? "0" : null });
      if (onClick) { g.addEventListener("click", () => onClick(d, i)); }
      /* quiet track so bars read as bars, not a solid slab */
      g.appendChild(s("rect", { x: i * bw + bw * 0.15, y: 4, width: bw * 0.7, height: height - 4, rx: 3, fill: "rgb(255 255 255 / 0.05)" }));
      g.appendChild(s("rect", { x: i * bw + bw * 0.15, y: height - bh, width: bw * 0.7, height: bh, rx: 3, fill: color, opacity: d.muted ? 0.35 : 0.88 }));
      g.appendChild(s("title", {}, `${d.label}: ${format(d.value)}${d.hint ? " · " + d.hint : ""}`));
      svg.appendChild(g);
    });
    const step = Math.ceil(data.length / maxLabels);
    data.forEach((d, i) => { if (i % step === 0) svg.appendChild(s("text", { x: i * bw + bw / 2, y: height + 16, "text-anchor": "middle", class: "chart-label" }, d.short || d.label)); });
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
