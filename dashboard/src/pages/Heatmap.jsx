import React, { useState, useRef, useEffect } from "react";
import * as d3 from "d3";
import { api } from "../api.js";
import { useFetch } from "../hooks.js";
import Filters from "../components/Filters.jsx";

// Champion × Item win-rate heatmap (D3). Cells colored by top-4 rate.
export default function Heatmap() {
  const [filters, setFilters] = useState({ tier: "CHALLENGER", region: "", patch: "" });
  const ref = useRef(null);
  const tipRef = useRef(null);
  const loader = () => api.heatmap({ tier: filters.tier, patch: filters.patch });
  const { data, loading, error } = useFetch(loader, [filters.tier, filters.patch]);

  useEffect(() => {
    if (!data || !data.cells) return;
    const { champions, items, cells } = data;
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    if (!champions.length || !items.length) return;

    const margin = { top: 110, right: 20, bottom: 20, left: 150 };
    const cw = 46, ch = 26;
    const width = margin.left + items.length * cw + margin.right;
    const height = margin.top + champions.length * ch + margin.bottom;

    const g = svg.attr("width", width).attr("height", height)
      .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand().domain(items).range([0, items.length * cw]);
    const y = d3.scaleBand().domain(champions).range([0, champions.length * ch]);
    const color = d3.scaleSequential(d3.interpolateRdYlGn).domain([0.4, 0.65]);

    const byKey = new Map(cells.map((c) => [`${c.champion}|${c.item}`, c]));
    const tip = d3.select(tipRef.current);

    champions.forEach((champ) => {
      items.forEach((item) => {
        const c = byKey.get(`${champ}|${item}`);
        g.append("rect")
          .attr("x", x(item)).attr("y", y(champ))
          .attr("width", cw - 2).attr("height", ch - 2)
          .attr("rx", 3)
          .attr("fill", c ? color(c.win_rate) : "#1e222e")
          .attr("stroke", "#0f1117")
          .on("mousemove", (event) => {
            if (!c) return;
            tip.style("opacity", 1)
              .style("left", event.pageX + 12 + "px")
              .style("top", event.pageY - 10 + "px")
              .html(`<b>${champ}</b> + ${item}<br/>Win: ${(c.win_rate * 100).toFixed(1)}%<br/>n=${c.sample_size}`);
          })
          .on("mouseleave", () => tip.style("opacity", 0));
      });
    });

    // row labels
    g.selectAll(".rl").data(champions).join("text")
      .attr("x", -8).attr("y", (d) => y(d) + ch / 2).attr("dy", "0.1em")
      .attr("text-anchor", "end").attr("fill", "#9aa3b2").attr("font-size", 11)
      .text((d) => d.replace("TFT_", ""));
    // column labels (rotated)
    g.selectAll(".cl").data(items).join("text")
      .attr("transform", (d) => `translate(${x(d) + cw / 2}, -8) rotate(-55)`)
      .attr("fill", "#9aa3b2").attr("font-size", 10)
      .text((d) => d.replace("TFT_Item_", ""));
  }, [data]);

  return (
    <div>
      <h1 className="page-title">Champion × Item Heatmap</h1>
      <p className="page-sub">Top-4 rate per champion/item pairing · green = strong</p>
      <Filters value={filters} onChange={setFilters} show={["tier", "patch"]} />
      <div className="panel" style={{ overflowX: "auto" }}>
        {loading && <div className="loading">Loading…</div>}
        {error && <div className="empty">API error: {error}</div>}
        {!loading && !error && (!data?.cells?.length) && <div className="empty">No pairings above sample threshold yet.</div>}
        <svg ref={ref} />
        <div className="tooltip" ref={tipRef} />
      </div>
    </div>
  );
}
