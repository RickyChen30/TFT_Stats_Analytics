import React, { useState } from "react";
import { api } from "../api.js";
import { useFetch } from "../hooks.js";
import Filters from "../components/Filters.jsx";
import Scatter from "../components/Scatter.jsx";

// Augment analysis: pick rate vs win rate. "Trap" augments are popular but
// underperform — highlighted in red (high play rate, below-median win rate).
export default function Augments() {
  const [filters, setFilters] = useState({ tier: "", region: "", patch: "" });
  // High limit so every augment is shown (Set 17 has ~270 augments).
  const loader = () => api.augments({ ...filters, limit: 500 });
  const { data, loading, error } = useFetch(loader, [filters.tier, filters.region, filters.patch]);

  const rows = Array.isArray(data) ? data : [];
  const medWin = rows.length ? [...rows].sort((a, b) => a.win_rate - b.win_rate)[Math.floor(rows.length / 2)].win_rate : 0.5;
  const medPlay = rows.length ? [...rows].sort((a, b) => a.play_rate - b.play_rate)[Math.floor(rows.length / 2)].play_rate : 0;

  const points = rows.map((r) => {
    const trap = r.play_rate >= medPlay && r.win_rate < medWin;
    return {
      x: r.play_rate,
      y: r.win_rate,
      r: 6,
      color: trap ? "#f85149" : r.win_rate >= medWin ? "#3fb950" : "#5b8cff",
      label: r.entity_id + (trap ? " (trap)" : ""),
    };
  });
  const traps = rows.filter((r) => r.play_rate >= medPlay && r.win_rate < medWin);

  return (
    <div>
      <h1 className="page-title">Augment Analysis</h1>
      <p className="page-sub">Pick rate vs win rate · red = trap augment (popular but weak)</p>
      <Filters value={filters} onChange={setFilters} />
      <div className="panel">
        {loading && <div className="loading">Loading…</div>}
        {error && <div className="empty">API error: {error}</div>}
        {!loading && !error && <Scatter points={points} xLabel="Play Rate" yLabel="Win Rate (top-4)" />}
        <div className="legend">
          <span><span className="dot" style={{ background: "#3fb950" }} />Strong</span>
          <span><span className="dot" style={{ background: "#5b8cff" }} />Niche</span>
          <span><span className="dot" style={{ background: "#f85149" }} />Trap</span>
        </div>
      </div>
      {traps.length > 0 && (
        <div className="panel">
          <b>Flagged trap augments</b>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Augment</th><th className="num">Win Rate</th><th className="num">Play Rate</th><th className="num">Samples</th></tr></thead>
            <tbody>
              {traps.map((t) => (
                <tr key={t.entity_id}>
                  <td>{t.entity_id} <span className="pill bad">trap</span></td>
                  <td className="num">{(t.win_rate * 100).toFixed(1)}%</td>
                  <td className="num">{(t.play_rate * 100).toFixed(1)}%</td>
                  <td className="num">{t.sample_size.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
