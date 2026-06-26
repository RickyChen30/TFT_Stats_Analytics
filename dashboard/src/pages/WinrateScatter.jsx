import React, { useState } from "react";
import * as d3 from "d3";
import { api, TIERS } from "../api.js";
import { useFetch } from "../hooks.js";
import Filters from "../components/Filters.jsx";
import Scatter from "../components/Scatter.jsx";

// Color each tier along the Turbo gradient (low elo -> high elo).
const tierColor = d3
  .scaleOrdinal()
  .domain(TIERS)
  .range(TIERS.map((_, i) => d3.interpolateTurbo(0.1 + (0.8 * i) / (TIERS.length - 1))));

// Win rate vs play rate bubble chart for compositions, colored by tier.
export default function WinrateScatter() {
  const [filters, setFilters] = useState({ tier: "", region: "", patch: "" });
  const loader = () => api.compositions({ ...filters, limit: 60 });
  const { data, loading, error } = useFetch(loader, [filters.tier, filters.region, filters.patch]);

  const rows = Array.isArray(data) ? data : [];
  const points = rows.map((r) => ({
    x: r.play_rate,
    y: r.win_rate,
    r: 5 + Math.sqrt(r.sample_size) / 6,
    color: tierColor(r.tiers[0] || "GOLD"),
    label: r.entity_id,
  }));

  return (
    <div>
      <h1 className="page-title">Win Rate vs Play Rate</h1>
      <p className="page-sub">Each bubble is a composition · size = sample count · color = tier</p>
      <Filters value={filters} onChange={setFilters} />
      <div className="panel">
        {loading && <div className="loading">Loading…</div>}
        {error && <div className="empty">API error: {error}</div>}
        {!loading && !error && (
          <>
            <Scatter points={points} xLabel="Play Rate" yLabel="Win Rate (top-4)" />
            <div className="legend">
              <span><span className="dot" style={{ background: tierColor("IRON") }} />Low tiers</span>
              <span><span className="dot" style={{ background: tierColor("CHALLENGER") }} />High tiers</span>
              <span>Upper-right quadrant = strong & popular</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
