import React, { useRef, useEffect } from "react";
import * as d3 from "d3";
import { api } from "../api.js";
import { useFetch } from "../hooks.js";

// True patch timeline: win-rate per patch for the top compositions, from
// /meta/patch-history. The x-axis walks the ingested Set patches oldest→newest.
export default function PatchTimeline() {
  const ref = useRef(null);

  const loader = async () => {
    const comps = await api.compositions({ limit: 8 });
    const series = await Promise.all(
      comps.map(async (c) => ({
        id: c.entity_id,
        points: (await api.patchHistory({ entity_id: c.entity_id })).series || [],
      }))
    );
    return series.filter((s) => s.points.length > 1);
  };
  const { data, loading, error } = useFetch(loader, [], 60000);

  useEffect(() => {
    if (!data) return;
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    if (!data.length) return;

    const width = 820, height = 460;
    const margin = { top: 20, right: 160, bottom: 40, left: 50 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;
    const g = svg.attr("width", width).attr("height", height)
      .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const allPts = data.flatMap((s) => s.points);
    const patches = [...new Set(allPts.map((p) => p.patch))].sort(cmpPatch);
    const x = d3.scalePoint().domain(patches).range([0, w]).padding(0.5);
    const y = d3.scaleLinear().domain(d3.extent(allPts, (p) => p.win_rate)).nice().range([h, 0]);
    const color = d3.scaleOrdinal(d3.schemeTableau10).domain(data.map((s) => s.id));

    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x));
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickFormat(d3.format(".0%")));
    g.append("text").attr("x", w / 2).attr("y", h + 36).attr("text-anchor", "middle")
      .attr("fill", "#9aa3b2").attr("font-size", 12).text("Patch");

    const line = d3.line().x((p) => x(p.patch)).y((p) => y(p.win_rate));
    data.forEach((s) => {
      const pts = [...s.points].sort((a, b) => cmpPatch(a.patch, b.patch));
      g.append("path").datum(pts).attr("fill", "none")
        .attr("stroke", color(s.id)).attr("stroke-width", 2).attr("d", line);
      g.selectAll(null).data(pts).join("circle")
        .attr("cx", (p) => x(p.patch)).attr("cy", (p) => y(p.win_rate)).attr("r", 3)
        .attr("fill", color(s.id));
    });

    const lg = g.append("g").attr("transform", `translate(${w + 16}, 0)`);
    data.forEach((s, i) => {
      const row = lg.append("g").attr("transform", `translate(0, ${i * 20})`);
      row.append("rect").attr("width", 12).attr("height", 12).attr("fill", color(s.id));
      row.append("text").attr("x", 18).attr("y", 10).attr("fill", "#9aa3b2").attr("font-size", 11).text(s.id);
    });
  }, [data]);

  return (
    <div>
      <h1 className="page-title">Patch Timeline</h1>
      <p className="page-sub">Win-rate per patch for top compositions · updates every 60s</p>
      <div className="panel" style={{ overflowX: "auto" }}>
        {loading && <div className="loading">Loading…</div>}
        {error && <div className="empty">API error: {error}</div>}
        {!loading && !error && !data?.length && (
          <div className="empty">Need at least two patches with enough samples — let the pipeline run.</div>
        )}
        <svg ref={ref} />
      </div>
    </div>
  );
}

function cmpPatch(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
