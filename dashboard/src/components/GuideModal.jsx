import React from "react";
import { api } from "../api.js";
import { useFetch } from "../hooks.js";

const COST_COLORS = { 1: "#9aa3b2", 2: "#3fb950", 3: "#3b82f6", 4: "#b660e0", 5: "#f0b232" };
const TIER_RANK_ORDER = ["CHALLENGER", "GRANDMASTER", "MASTER", "DIAMOND", "PLATINUM", "GOLD", "SILVER", "BRONZE", "IRON"];

function cmpPatch(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d) return d;
  }
  return 0;
}

// Tiny inline win-rate sparkline across patches.
function Sparkline({ points }) {
  if (!points || points.length < 2) return <div className="muted small">Not enough patches yet.</div>;
  const w = 240, h = 56, pad = 6;
  const xs = points.map((p) => p.patch);
  const ys = points.map((p) => p.win_rate);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(0.0001, maxY - minY);
  const x = (i) => pad + (i * (w - 2 * pad)) / (points.length - 1);
  const y = (v) => h - pad - ((v - minY) / span) * (h - 2 * pad);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.win_rate).toFixed(1)}`).join(" ");
  const up = ys[ys.length - 1] >= ys[0];
  const col = up ? "var(--good)" : "var(--bad)";
  return (
    <div>
      <svg width={w} height={h} className="sparkline">
        <path d={d} fill="none" stroke={col} strokeWidth="2" />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.win_rate)} r="2.5" fill={col} />
        ))}
      </svg>
      <div className="spark-labels">
        {xs.map((p) => <span key={p}>{p}</span>)}
      </div>
    </div>
  );
}

// Win-rate-by-rank bars (from /meta/tier-comparison).
function TierBars({ series }) {
  if (!series || !series.length) return <div className="muted small">No per-rank data yet.</div>;
  const sorted = [...series].sort((a, b) => TIER_RANK_ORDER.indexOf(a.tier) - TIER_RANK_ORDER.indexOf(b.tier));
  const max = Math.max(...sorted.map((s) => s.win_rate));
  return (
    <div className="tier-bars">
      {sorted.map((s) => (
        <div className="tier-bar" key={s.tier} title={`${s.tier}: ${(s.win_rate * 100).toFixed(1)}% top-4`}>
          <div className="tier-bar-track">
            <div className="tier-bar-fill" style={{ height: `${(s.win_rate / max) * 100}%` }} />
          </div>
          <span className="tier-bar-val">{(s.win_rate * 100).toFixed(0)}</span>
          <span className="tier-bar-lbl">{s.tier.slice(0, 3)}</span>
        </div>
      ))}
    </div>
  );
}

// Static positioned board for a comp guide: tanks front, carries back, with the
// recommended items shown on the main carry / tank hexes.
function CompBoard({ board }) {
  if (!board?.placed?.length) return null;
  const { rows, cols, placed } = board;
  const at = (r, c) => placed.find((p) => p.row === r && p.col === c);
  return (
    <div className="g-board">
      <span className="g-board-line back">backline · carries</span>
      <div className="g-board-grid">
        {Array.from({ length: rows }).map((_, r) => (
          <div className={`g-board-row ${r % 2 ? "offset" : ""}`} key={r}>
            {Array.from({ length: cols }).map((_, c) => {
              const u = at(r, c);
              return (
                <div className={`g-board-hex ${u ? "filled" : ""} ${u?.carry ? "carry" : ""}`} key={c}
                  style={u ? { "--cost": COST_COLORS[u.cost] || "#9aa3b2" } : undefined} title={u?.name || ""}>
                  {u && (u.icon ? <img className="g-board-img" src={u.icon} alt={u.name} draggable={false} />
                    : <span className="g-board-ph">{u.name?.slice(0, 2)}</span>)}
                  {u?.carry && <span className="g-board-star">★</span>}
                  {u?.items?.length > 0 && (
                    <div className="g-board-items">
                      {u.items.map((it, k) => (it.icon
                        ? <img key={k} src={it.icon} alt={it.name} title={it.name} />
                        : null))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <span className="g-board-line front">frontline · tanks</span>
    </div>
  );
}

function Hex({ icon, name, cost, carry }) {
  return (
    <div className={`g-hex ${carry ? "carry" : ""}`} style={{ "--cost": COST_COLORS[cost] || "#9aa3b2" }} title={name}>
      <div className="g-hex-inner">
        {icon ? <img src={icon} alt={name} draggable={false} /> : <span className="g-hex-ph">{name?.slice(0, 3)}</span>}
      </div>
      <span className="g-hex-name">{name}</span>
      {carry && <span className="g-hex-tag">carry</span>}
    </div>
  );
}

// Rich detail guide for a comp / champion / item, opened from the tier list.
export default function GuideModal({ type, row, guide, onClose }) {
  // Archetypes aren't a backend entity, so trend / by-rank use a representative variant.
  const fetchId = row._histId || row.entity_id;
  const { data: hist } = useFetch(() => api.patchHistory({ entity_id: fetchId }), [fetchId]);
  const { data: tc } = useFetch(() => api.tierComparison(fetchId), [fetchId]);
  const series = (hist?.series || []).slice().sort((a, b) => cmpPatch(a.patch, b.patch));

  const pct = (v) => (v * 100).toFixed(1) + "%";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal guide-modal" onClick={(e) => e.stopPropagation()}>
        <div className="guide-head">
          <span className={`g-tier tier-${row.metaTier}`}>{row.metaTier}</span>
          <div className="guide-title-wrap">
            <h2 className="guide-title">{guide.title}</h2>
            <div className="guide-subtitle">{guide.subtitle}</div>
          </div>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>

        <div className="guide-body">
          {/* Stat strip */}
          <div className="guide-stats">
            <div className="stat-box"><span className="stat-val good">{pct(row.win_rate)}</span><span className="stat-lbl">Top-4 rate</span></div>
            <div className="stat-box"><span className="stat-val">{row.avg_placement.toFixed(2)}</span><span className="stat-lbl">Avg place</span></div>
            <div className="stat-box"><span className="stat-val">{pct(row.play_rate)}</span><span className="stat-lbl">Play rate</span></div>
            <div className="stat-box"><span className="stat-val">{row.sample_size.toLocaleString()}</span><span className="stat-lbl">Games</span></div>
          </div>

          {/* Traits (comp only) */}
          {guide.traits?.length > 0 && (
            <div className="guide-section">
              <div className="guide-section-head">Traits</div>
              <div className="guide-traits">
                {guide.traits.map((t) => (
                  <div className="g-trait" key={t.name} title={t.count != null ? `${t.count} units${t.breakpoints?.length ? ` · tiers ${t.breakpoints.join("/")}` : ""}` : undefined}>
                    {t.icon && <img src={t.icon} alt="" />}
                    <span>{t.name}</span>
                    {/* Comps: the threshold actually hit. Other guides: the trait's tiers. */}
                    {t.tier != null
                      ? <span className="g-trait-bp">{t.count}/{t.tier}</span>
                      : (t.breakpoints?.length > 0 && <span className="g-trait-bp">{t.breakpoints.join("/")}</span>)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Suggested board (comps): tanks front, carries back, items on key units */}
          {guide.board?.placed?.length > 0 && (
            <div className="guide-section">
              <div className="guide-section-head">Suggested board</div>
              <CompBoard board={guide.board} />
            </div>
          )}

          {/* Core units (champions / items / augments — comps show the board above) */}
          {guide.champs?.length > 0 && !guide.board && (
            <div className="guide-section">
              <div className="guide-section-head">{type === "item" ? "Best on" : "Core units"}</div>
              <div className="guide-units">
                {guide.champs.map((c) => <Hex key={c.id} {...c} />)}
              </div>
            </div>
          )}

          {/* Recommended / best items */}
          {guide.recItems?.length > 0 && (
            <div className="guide-section">
              <div className="guide-section-head">{type === "item" ? "Pairs with" : "Recommended items"}</div>
              <div className="rec-items">
                {guide.recItems.map((it) => (
                  <div className="rec-item" key={it.id} title={`${it.name} · ${pct(it.win)} top-4 · ${it.n.toLocaleString()} games`}>
                    {it.icon ? <img src={it.icon} alt={it.name} /> : <span className="rec-ph">{it.name.slice(0, 2)}</span>}
                    <span className="rec-win">{(it.win * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* How to play */}
          {guide.howTo && (
            <div className="guide-section">
              <div className="guide-section-head">How to play</div>
              <p className="guide-howto">{guide.howTo}</p>
            </div>
          )}

          {/* Variants (archetype guides) */}
          {guide.variants?.length > 0 && (
            <div className="guide-section">
              <div className="guide-section-head">Variants ({guide.variants.length})</div>
              <div className="variant-list">
                {guide.variants.map((v) => (
                  <div className="variant-row" key={v.id}>
                    <span className="variant-name">{v.name}</span>
                    <span className="variant-stat good">{(v.win * 100).toFixed(1)}%</span>
                    <span className="variant-stat muted">{v.place.toFixed(2)} avg</span>
                    <span className="variant-stat muted">{v.n.toLocaleString()} games</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Trends */}
          <div className="guide-grid2">
            <div className="guide-section">
              <div className="guide-section-head">Win-rate trend</div>
              <Sparkline points={series} />
            </div>
            <div className="guide-section">
              <div className="guide-section-head">By rank</div>
              <TierBars series={tc?.series} />
            </div>
          </div>

          <div className="guide-footer muted small">
            Played in {row.tiers?.join(", ") || "—"} · {row.regions?.join(", ") || "—"} · patch {row.patch}
          </div>
        </div>
      </div>
    </div>
  );
}
