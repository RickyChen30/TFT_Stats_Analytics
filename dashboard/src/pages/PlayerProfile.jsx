import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";

const COST_COLORS = { 1: "#9aa3b2", 2: "#3fb950", 3: "#3b82f6", 4: "#b660e0", 5: "#f0b232" };
const STAR_COLORS = { 1: "#cd7f32", 2: "#cbd5e1", 3: "#ffd34d" };
const TIER_COLOR = {
  IRON: "#6b7280", BRONZE: "#cd7f32", SILVER: "#9aa3b2", GOLD: "#f0b232", PLATINUM: "#3fd0c9",
  EMERALD: "#2ecc71", DIAMOND: "#5b8cff", MASTER: "#9a5bff", GRANDMASTER: "#f85149", CHALLENGER: "#f0c040", UNRANKED: "#6b7280",
};
const prettyName = (id) => String(id).replace(/^TFT\d*_(Item_|Augment_)?/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
const SHORT_TIER = { IRON: "I", BRONZE: "B", SILVER: "S", GOLD: "G", PLATINUM: "P", EMERALD: "E", DIAMOND: "D", MASTER: "M", GRANDMASTER: "GM", CHALLENGER: "C" };
const isApex = (t) => t === "MASTER" || t === "GRANDMASTER" || t === "CHALLENGER";
const shortRank = (h) => (isApex(h.tier) ? `${SHORT_TIER[h.tier]} ${h.lp}LP` : `${SHORT_TIER[h.tier] || h.tier} ${h.division}`);
const placeColor = (p) => (p === 1 ? "#f0b232" : p === 2 ? "#6ec1e4" : p === 3 ? "#5b8cff"
  : p === 4 ? "#3fb950" : p <= 6 ? "#8a93a3" : "#f85149");
const placeTextDark = (p) => p === 1 || p === 4;

const KEY_LS = "tft_riot_key";
const RECENT_LS = "tft_recent_players";
const loadRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_LS)) || []; } catch { return []; } };
const pushRecent = (id) => {
  const r = loadRecent().filter((x) => x.toLowerCase() !== id.toLowerCase());
  r.unshift(id);
  localStorage.setItem(RECENT_LS, JSON.stringify(r.slice(0, 10)));
};

function dayLabel(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + "T00:00:00");
  const diff = Math.round((today - d) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function groupByDay(matches) {
  const map = new Map();
  matches.forEach((m) => { if (!map.has(m.date)) map.set(m.date, []); map.get(m.date).push(m); });
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, ms]) => {
    const places = ms.map((x) => x.placement);
    return {
      date, label: dayLabel(date), matches: ms, games: ms.length,
      top4: places.filter((p) => p <= 4).length, wins: places.filter((p) => p === 1).length,
      avg: (places.reduce((s, p) => s + p, 0) / places.length).toFixed(2),
    };
  });
}

// ---- Playstyle analysis from real match history ----
const GRADE_COLOR = { S: "#f0b232", A: "#3fb950", B: "#5b8cff", C: "#9aa3b2", D: "#f85149" };
const gradeOf = (x) => (x >= 85 ? "S" : x >= 72 ? "A" : x >= 58 ? "B" : x >= 44 ? "C" : "D");
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function computeAnalysis(matches) {
  if (!matches || matches.length < 2) return null;
  const n = matches.length;
  const avg = (f) => matches.reduce((s, m) => s + f(m), 0) / n;

  const avgLevel = avg((m) => m.level || 0);
  const carryItems = avg((m) => {
    const c = m.units.filter((u) => u.carry);
    return (c.length ? c : m.units.slice(-2)).reduce((s, u) => s + (u.items?.length || 0), 0);
  });
  const traitPts = avg((m) => (m.traits || []).reduce((s, t) => s + (t.tier || 0), 0));
  const avgDmg = avg((m) => m.damage || 0);
  const avgElim = avg((m) => m.eliminations || 0);
  const places = matches.map((m) => m.placement);
  const top4 = places.filter((p) => p <= 4).length / n;
  const mean = places.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(places.reduce((a, p) => a + (p - mean) ** 2, 0) / n);

  const raw = [
    { key: "econ", label: "Economy", score: clamp01((avgLevel - 6.8) / (9.2 - 6.8)) * 100, note: `avg level ${avgLevel.toFixed(2)}` },
    { key: "items", label: "Items", score: clamp01((carryItems - 2) / (6 - 2)) * 100, note: `${carryItems.toFixed(1)} items on carries` },
    { key: "comp", label: "Team Comp", score: clamp01(traitPts / 13) * 100, note: `${traitPts.toFixed(1)} trait tiers active` },
    { key: "combat", label: "Combat", score: (0.7 * clamp01((avgDmg - 40) / (130 - 40)) + 0.3 * clamp01(avgElim / 5)) * 100, note: `${avgDmg.toFixed(0)} dmg · ${avgElim.toFixed(1)} elim` },
    { key: "consistency", label: "Consistency", score: clamp01((top4 - 0.25) / (0.62 - 0.25)) * 100, note: `${(top4 * 100).toFixed(0)}% top-4 · ±${std.toFixed(1)}` },
  ];
  const axes = raw.map((a) => ({ ...a, score: Math.round(a.score), grade: gradeOf(a.score), color: GRADE_COLOR[gradeOf(a.score)] }));
  return { axes, overall: Math.round(axes.reduce((s, a) => s + a.score, 0) / axes.length) };
}

function Radar({ axes }) {
  const W = 360, H = 300, cx = 180, cy = 148, R = 100, N = axes.length;
  const ang = (i) => (-90 + (i * 360) / N) * Math.PI / 180;
  const pt = (i, r) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];
  const ringPts = (frac) => axes.map((_, i) => pt(i, R * frac).join(",")).join(" ");
  const area = axes.map((a, i) => pt(i, R * a.score / 100).join(",")).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="radar" preserveAspectRatio="xMidYMid meet">
      {[0.25, 0.5, 0.75, 1].map((f) => <polygon key={f} className="radar-grid" points={ringPts(f)} />)}
      {axes.map((_, i) => { const [x, y] = pt(i, R); return <line key={i} className="radar-spoke" x1={cx} y1={cy} x2={x} y2={y} />; })}
      <polygon className="radar-area" points={area} />
      {axes.map((a, i) => { const [x, y] = pt(i, R * a.score / 100); return <circle key={i} cx={x} cy={y} r="3.5" fill={a.color} />; })}
      {axes.map((a, i) => {
        const [x, y] = pt(i, R + 26);
        const c = Math.cos(ang(i));
        const anchor = c > 0.3 ? "start" : c < -0.3 ? "end" : "middle";
        return (
          <g key={i}>
            <text x={x} y={y} textAnchor={anchor} className="radar-label">{a.label}</text>
            <text x={x} y={y + 14} textAnchor={anchor} className="radar-grade" fill={a.color}>{a.grade}</text>
          </g>
        );
      })}
    </svg>
  );
}

function MatchCard({ m }) {
  return (
    <div className="mh-card" style={{ "--pc": placeColor(m.placement) }}>
      <div className="mh-top">
        <span className="mh-queue">{m.queue || "Ranked"}</span>
        <span className="mh-meta">⏱ {m.round}</span>
        <span className="mh-meta">◆ {m.gold_left}</span>
        {m.damage != null && <span className="mh-meta">⚔ {m.damage}</span>}
        {m.eliminations != null && <span className="mh-meta">💀 {m.eliminations}</span>}
        <div className="mh-traits">
          {m.traits.slice(0, 9).map((t) => (
            <span className={`mh-trait sty-${t.style}`} key={t.name} title={`${t.name} ${t.count}`}>
              {t.icon && <img src={t.icon} alt="" />}{t.count}
            </span>
          ))}
        </div>
      </div>
      <div className="mh-body">
        <div className="mh-place" style={{ background: placeColor(m.placement), color: placeTextDark(m.placement) ? "#15161c" : "#fff" }}>
          {m.placement}
        </div>
        <div className="mh-level">{m.level}</div>
        <div className="mh-board">
          {m.units.map((u, i) => (
            <div className="mh-unit" key={i}>
              <div className="mh-stars" style={{ color: STAR_COLORS[u.star] }}>{"★".repeat(u.star)}</div>
              <div className="mh-portrait" style={{ "--cost": COST_COLORS[u.cost] || "#9aa3b2" }} title={`${prettyName(u.champion)} ${u.star}★`}>
                {u.icon ? <img src={u.icon} alt="" /> : <span>{prettyName(u.champion).slice(0, 2)}</span>}
              </div>
              <div className="mh-unit-items">
                {u.items.map((it, k) => <img key={k} className="mh-item" src={it.icon} alt="" title={prettyName(it.name)} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Player profile — real Riot data: current rank, statistics and match boards.
export default function PlayerProfile() {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [showSug, setShowSug] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(KEY_LS) || "");
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const inputRef = useRef(null);

  // Lookup (re-runs if the saved key changes, e.g. right after pasting one).
  useEffect(() => {
    if (!query) return;
    let alive = true;
    setLoading(true); setError(null);
    api.player(query, apiKey ? { key: apiKey } : {})
      .then((res) => { if (!alive) return; setData(res); if (res.status === "ok") pushRecent(query); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [query, apiKey]);

  // Debounced Riot-id autocomplete: recent searches + server suggestions.
  useEffect(() => {
    const n = name.trim();
    const recent = loadRecent().filter((x) => !n || x.toLowerCase().includes(n.toLowerCase()));
    let alive = true;
    const t = setTimeout(() => {
      api.playerSuggest(n).then((r) => {
        if (!alive) return;
        const merged = [...new Set([...recent, ...(r.suggestions || [])])].slice(0, 8);
        setSuggestions(merged);
      }).catch(() => { if (alive) setSuggestions(recent.slice(0, 8)); });
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [name]);

  const search = (id) => { const n = (id ?? name).trim(); if (n) { setName(n); setQuery(n); setShowSug(false); } };
  const saveKey = () => { const k = keyInput.trim(); localStorage.setItem(KEY_LS, k); setApiKey(k); setShowKey(false); };
  const s = data?.stats;
  const rs = data?.recent_summary;
  const groups = useMemo(() => groupByDay(data?.recent_matches || []), [data]);
  const analysis = useMemo(() => computeAnalysis(data?.recent_matches), [data]);
  const maxDist = data?.placement_distribution ? Math.max(1, ...data.placement_distribution.map((d) => d.count)) : 1;
  const tierCol = data?.current_rank ? (TIER_COLOR[data.current_rank.tier] || "#5b8cff") : "#5b8cff";
  const wl = data?.current_rank ? (data.current_rank.wins + data.current_rank.losses) : 0;
  const winPct = wl ? Math.round((data.current_rank.wins / wl) * 100) : 0;
  const history = data?.rank_history || [];
  const peakRating = history.length ? Math.max(...history.map((h) => h.rating)) : -1;
  const statusMsg = data && data.status && data.status !== "ok" ? data : null;

  return (
    <div>
      <h1 className="page-title">Player Search</h1>
      <p className="page-sub">Live Riot data · current rank, statistics and full match boards · enter a Riot id (name#tag)</p>

      <div className="player-search">
        <div className="ps-autocomplete">
          <input ref={inputRef} value={name} placeholder="Riot id (e.g. hyperick#NA1)" autoComplete="off"
            onChange={(e) => { setName(e.target.value); setShowSug(true); }}
            onFocus={() => setShowSug(true)}
            onBlur={() => setTimeout(() => setShowSug(false), 150)}
            onKeyDown={(e) => e.key === "Enter" && search()} />
          {showSug && suggestions.length > 0 && (
            <div className="ps-suggestions">
              {suggestions.map((sug) => (
                <div className="ps-suggestion" key={sug} onMouseDown={() => search(sug)}>
                  <span className="ps-sug-icon">⌕</span>{sug}
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="player-search-btn" onClick={() => search()}>Search</button>
        <button className="player-key-btn" onClick={() => { setKeyInput(apiKey); setShowKey((v) => !v); }} title="Riot API key">
          🔑{apiKey ? " ✓" : ""}
        </button>
      </div>

      {(showKey || data?.status === "needs_api_key") && (
        <div className="key-box">
          <input type="password" placeholder="Paste your Riot API key (RGAPI-…)" value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveKey()} />
          <button className="player-search-btn" onClick={saveKey}>Save key</button>
          <span className="muted">
            Real Riot stats need a key (only you can generate one). Get a free one in ~30s at <b>developer.riotgames.com</b> →
            paste it here. It's stored only in your browser and sent to your local API.
          </span>
        </div>
      )}

      {loading && <div className="loading">Loading from Riot…</div>}
      {error && <div className="empty">API error: {error}</div>}
      {!loading && !query && <div className="empty">Enter a Riot id (e.g. hyperick#NA1) to look up a player.</div>}
      {statusMsg && !loading && (
        <div className="panel"><div className="empty">{statusMsg.message || `Lookup failed (${statusMsg.status}).`}</div></div>
      )}

      {data && !loading && data.status === "ok" && (
        <>
          {/* Season chips (only if available) */}
          {data.seasons?.length > 0 && (
            <div className="season-chips">
              {data.seasons.map((sn, i) => (
                <div className={`season-chip ${i === 0 ? "current" : ""}`} key={sn.season}>
                  <span className="season-dot" style={{ background: TIER_COLOR[sn.tier] || "#5b8cff" }} />
                  <span className="season-name">{sn.season}</span>
                  <span className="season-rank">{sn.short}</span>
                </div>
              ))}
            </div>
          )}

          {/* Header: identity + recent matches */}
          <div className="profile-top">
            <div className="profile-identity" style={{ "--tc": tierCol }}>
              <div className="rank-emblem">
                {data.top_carry?.icon
                  ? <img className="emblem-carry" src={data.top_carry.icon} alt="" />
                  : <span>{data.current_rank.tier.slice(0, 1)}</span>}
              </div>
              <div>
                <div className="player-name">
                  {data.game_name || data.summoner_name}
                  {data.tag_line && <span className="player-tag">#{data.tag_line}</span>}
                </div>
                <div className="player-rank-line" style={{ color: tierCol }}>{data.current_rank.label}</div>
                <div className="player-region">
                  {data.region}
                  {(data.current_rank.wins || data.current_rank.losses) ? ` · ${data.current_rank.wins}W ${data.current_rank.losses}L` : ""}
                </div>
                {data.top_carry && <div className="player-topcarry">Top carry · {prettyName(data.top_carry.name)}</div>}
              </div>
            </div>

            {rs && (
              <div className="recent20">
                <div className="recent20-head">Recent {data.recent_matches.length} Matches <span className="muted">(Ranked)</span></div>
                <div className="recent20-strip">
                  {data.recent_matches.map((m, i) => (
                    <span className="r20-chip" key={i} style={{ background: placeColor(m.placement), color: placeTextDark(m.placement) ? "#15161c" : "#fff" }}>
                      {m.placement}
                    </span>
                  ))}
                </div>
                <div className="recent20-summary">
                  <div className="r20-box"><span className="r20-val">{rs.avg}</span><span className="r20-lbl">Avg</span></div>
                  <div className="r20-box"><span className="r20-val">{rs.top4}</span><span className="r20-lbl">Top 4</span></div>
                  <div className="r20-box"><span className="r20-val">{rs.wins}</span><span className="r20-lbl">Won</span></div>
                  <div className="r20-box"><span className="r20-val">🔥 {rs.streak}</span><span className="r20-lbl">Streak</span></div>
                </div>
              </div>
            )}
          </div>

          {/* Ranked season + recorded rank history */}
          <div className="panel">
            <div className="group-heading"><span>Ranked</span><span>current TFT season</span></div>
            <div className="ranked-row">
              <div className="ranked-now" style={{ "--tc": tierCol }}>
                <div className="rank-emblem sm"><span>{data.current_rank.tier.slice(0, 1)}</span></div>
                <div>
                  <div className="ranked-now-rank" style={{ color: tierCol }}>{data.current_rank.label}</div>
                  <div className="muted small">
                    {wl ? `${data.current_rank.wins}W ${data.current_rank.losses}L · ${winPct}% win` : "Unranked this season"}
                    {peakRating >= 0 ? ` · peak ${data.peak_rank.label}` : ""}
                  </div>
                </div>
              </div>
              {history.length > 0 && (
                <div className="rank-timeline">
                  {history.slice().reverse().map((h, i) => (
                    <div className={`rank-snap ${h.rating === peakRating ? "peak" : ""}`} key={i}
                      style={{ "--rc": TIER_COLOR[h.tier] || "#5b8cff" }} title={`${h.date} · ${h.label}`}>
                      <span className="rank-snap-rank">{shortRank(h)}</span>
                      <span className="rank-snap-date">{h.date.slice(5)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {history.length <= 1 && (
              <div className="muted small ranked-note">
                Riot's API exposes only the <b>current</b> TFT season — there's no endpoint for past seasons. Rank is recorded on every lookup, so this history builds up over time.
              </div>
            )}
          </div>

          {data.no_matches && <div className="panel"><div className="empty">No recent ranked TFT matches found for this player.</div></div>}

          {s && (
            <>
              {/* Compact grouped statistics + placement distribution */}
              <div className="profile-grid">
                <div className="panel">
                  <div className="group-heading"><span>Statistics</span><span>last {s.sample} games</span></div>
                  <div className="stat-groups">
                    <div className="stat-group">
                      <div className="sg-title">Performance</div>
                      <div className="sg-row"><span>Avg place</span><b>{s.avg_placement}</b></div>
                      <div className="sg-row"><span>Top 4</span><b>{s.top4} · <span style={{ color: "var(--good)" }}>{s.top4_pct}%</span></b></div>
                      <div className="sg-row"><span>1st</span><b>{s.firsts} · <span style={{ color: "var(--accent)" }}>{s.won_pct}%</span></b></div>
                    </div>
                    <div className="stat-group">
                      <div className="sg-title">Composition</div>
                      <div className="sg-row"><span>Avg level</span><b>{s.avg_level}</b></div>
                      <div className="sg-row"><span>Avg star</span><b>{s.avg_star_level}</b></div>
                      <div className="sg-row"><span>Team cost</span><b>{s.avg_team_cost}</b></div>
                    </div>
                    <div className="stat-group">
                      <div className="sg-title">Ranked</div>
                      <div className="sg-row"><span>Games</span><b>{s.games.toLocaleString()}</b></div>
                      <div className="sg-row"><span>Record</span><b>{s.wins}W {s.losses}L</b></div>
                      <div className="sg-row"><span>Win rate</span><b>{winPct}%</b></div>
                    </div>
                  </div>
                </div>
                <div className="panel">
                  <div className="group-heading"><span>Placements</span><span>last {s.sample}</span></div>
                  <div className="place-dist">
                    {data.placement_distribution.map((d) => (
                      <div className="place-col" key={d.place}>
                        <div className="place-bar-track">
                          <div className="place-bar" style={{ height: `${(d.count / maxDist) * 100}%`, background: placeColor(d.place) }} />
                        </div>
                        <span className="place-count">{d.count}</span>
                        <span className="place-num">{d.place}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Playstyle analysis (radar) from real match history */}
              {analysis && (
                <div className="panel">
                  <div className="group-heading"><span>Playstyle analysis</span><span>overall {analysis.overall} · last {data.recent_matches.length}</span></div>
                  <div className="analysis-wrap">
                    <Radar axes={analysis.axes} />
                    <div className="analysis-list">
                      {analysis.axes.map((a) => (
                        <div className="analysis-row" key={a.key}>
                          <span className="agrade" style={{ background: a.color }}>{a.grade}</span>
                          <div className="ainfo">
                            <div className="aname">{a.label}</div>
                            <div className="anote">{a.note}</div>
                          </div>
                          <div className="abar"><div className="abar-fill" style={{ width: `${a.score}%`, background: a.color }} /></div>
                          <span className="ascore">{a.score}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="muted small analysis-note">
                    Derived from your last {data.recent_matches.length} real matches. Riot's Set 17 match API exposes no board positions or augment picks, so <b>positioning</b> and <b>augment selection</b> can't be graded — <b>Combat</b> (damage / eliminations) and <b>Consistency</b> (top-4 reliability) are the measurable equivalents.
                  </div>
                </div>
              )}

              {/* Match history grouped by day */}
              <div className="panel">
                <div className="group-heading"><span>Matches</span><span>{data.recent_matches.length} recent</span></div>
                {groups.map((g) => (
                  <div className="day-group" key={g.date}>
                    <div className="day-head">
                      <span className="day-label">{g.label}</span>
                      <span className="day-summary">{g.games} games · {g.top4} top4 · {g.wins} won · {g.avg} avg</span>
                    </div>
                    {g.matches.map((m, i) => <MatchCard m={m} key={i} />)}
                  </div>
                ))}
              </div>

              {/* Most played */}
              {data.most_played?.length > 0 && (
                <div className="panel">
                  <div className="group-heading"><span>Most played</span><span>last {s.sample}</span></div>
                  <table style={{ marginTop: 6 }}>
                    <thead><tr><th>Champion</th><th className="num">Games</th><th className="num">Your Avg Place</th></tr></thead>
                    <tbody>
                      {data.most_played.map((m) => (
                        <tr key={m.champion}>
                          <td>{prettyName(m.champion)}</td>
                          <td className="num">{m.games}</td>
                          <td className="num">{m.your_avg_placement}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
