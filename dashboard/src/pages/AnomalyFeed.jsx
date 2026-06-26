import React, { useState } from "react";
import { api } from "../api.js";
import { useFetch } from "../hooks.js";

// Live ticker of rising/falling entities. Polls every 5 seconds.
export default function AnomalyFeed() {
  const [hours, setHours] = useState(24);
  const { data, loading, error } = useFetch(() => api.anomalies({ window_hours: hours }), [hours], 5000);
  const items = Array.isArray(data) ? data : [];

  return (
    <div>
      <h1 className="page-title">Anomaly Feed</h1>
      <p className="page-sub">Win-rate spikes detected by z-score · live · {items.length} in window</p>
      <div className="filters">
        <label>
          Window
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={1}>Last 1h</option>
            <option value={6}>Last 6h</option>
            <option value={24}>Last 24h</option>
            <option value={168}>Last 7d</option>
          </select>
        </label>
      </div>
      <div className="panel">
        {loading && !items.length && <div className="loading">Listening…</div>}
        {error && <div className="empty">API error: {error}</div>}
        {!loading && !items.length && <div className="empty">No anomalies in this window. The detector needs several observation cycles to build a baseline.</div>}
        {items.map((a, i) => (
          <div className="feed-item" key={i}>
            <div>
              <b>{a.entity_id}</b>{" "}
              <span className="pill warn">{a.entity_type}</span>{" "}
              <span className={`pill ${a.classification === "cross_rank" ? "bad" : "good"}`}>
                {a.classification}
              </span>
              <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>
                {a.tier} · {a.region} · patch {a.patch}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className={a.direction === "rising" ? "pill good" : "pill bad"}>
                {a.direction === "rising" ? "▲" : "▼"} z={a.z_score}
              </div>
              <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>
                win {(a.win_rate * 100).toFixed(1)}% · n={a.sample_size}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
