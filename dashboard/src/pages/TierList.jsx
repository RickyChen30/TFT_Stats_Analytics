import React, { useMemo, useState } from "react";
import { api } from "../api.js";
import { useFetch } from "../hooks.js";
import Filters from "../components/Filters.jsx";
import GuideModal from "../components/GuideModal.jsx";
import { TIERS, COST_COLORS, prettyName, metaScore, rankIntoTiers, guideContext, buildGuide, augmentChampion, condenseCompositions } from "../lib/meta.js";

const TYPES = [
  { id: "composition", label: "Compositions" },
  { id: "champion", label: "Champions" },
  { id: "item", label: "Items" },
];

// Split a composition id ("Mecha_Space Groove") into its two trait names.
const compTraits = (id) => String(id).split("_").filter(Boolean);

export default function TierList() {
  const [filters, setFilters] = useState({ tier: "", region: "", patch: "" });
  const [type, setType] = useState("composition");
  const [grouped, setGrouped] = useState(true); // condense comps into trait archetypes
  const [selected, setSelected] = useState(null);

  const loader = () =>
    api[type === "composition" ? "compositions" : type === "champion" ? "champions" : "items"]({ ...filters, limit: 60 });
  const { data, loading, error } = useFetch(loader, [type, filters.tier, filters.region, filters.patch], 60000);

  // Roster (champion/trait/item metadata) and the champion×item heatmap power the guides.
  const { data: roster } = useFetch(() => api.roster(), []);
  const { data: heatmap } = useFetch(() => api.heatmap({}), []);
  // Augments (for the special "X" tier of champion / hero augments).
  const { data: augData } = useFetch(
    () => api.augments({ ...filters, limit: 600 }), [filters.tier, filters.region, filters.patch]);

  const ctx = useMemo(() => guideContext(roster, heatmap), [roster, heatmap]);

  // Special "X" tier: champion (hero) augments, auto-detected from their ids and
  // ranked by performance.
  const champAugs = useMemo(() => {
    const rows = Array.isArray(augData) ? augData : [];
    const out = [];
    rows.forEach((r) => {
      const champ = augmentChampion(r.entity_id, ctx.champByShort);
      if (!champ) return;
      const meta = ctx.augMetaById[r.entity_id] || {};
      out.push({ ...r, metaTier: "X", _champ: champ, _augName: meta.name || prettyName(r.entity_id), _augIcon: meta.icon || "" });
    });
    if (out.length) {
      const meanWin = out.reduce((s, r) => s + r.win_rate, 0) / out.length;
      out.forEach((r) => (r._score = metaScore(r, meanWin)));
      out.sort((a, b) => b._score - a._score);
    }
    return out;
  }, [augData, ctx]);

  const { byTier } = useMemo(() => {
    let rows = Array.isArray(data) ? [...data] : [];
    if (type === "composition" && grouped) rows = condenseCompositions(rows);
    return rankIntoTiers(rows);
  }, [data, type, grouped]);
  const hasRows = Array.isArray(data) && data.length > 0;

  // Signature champions of a comp: champions sharing its traits, priciest first.
  const compChamps = (id) => {
    const seen = new Set();
    const out = [];
    compTraits(id).forEach((t) => (ctx.champsByTrait[t] || []).forEach((c) => { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } }));
    out.sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id));
    return out;
  };

  const renderCard = (row) => {
    if (type === "composition" && row._archetype) {
      const t = ctx.traitByName[row._trait];
      const champs = (ctx.champsByTrait[row._trait] || []).slice()
        .sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id)).slice(0, 4);
      return (
        <div className="comp-card arch" key={row.entity_id} onClick={() => setSelected({ row, type })}>
          <div className="comp-hexes">
            {champs.map((c) => (
              <div className="mini-hex" key={c.id} style={{ "--cost": COST_COLORS[c.cost] || "#9aa3b2" }} title={prettyName(c.id)}>
                {c.icon ? <img src={c.icon} alt="" draggable={false} /> : <span>{prettyName(c.id).slice(0, 2)}</span>}
              </div>
            ))}
          </div>
          <div className="comp-card-title arch-title">
            {t?.icon && <img className="arch-trait-icon" src={t.icon} alt="" />}
            {row._trait}
          </div>
          <div className="comp-card-stats">
            <span className="good">{(row.win_rate * 100).toFixed(1)}%</span>
            <span className="muted">{row.avg_placement.toFixed(2)}</span>
            <span className="muted">· {row._variants.length} comps</span>
          </div>
        </div>
      );
    }
    if (type === "composition") {
      const champs = compChamps(row.entity_id).slice(0, 4);
      return (
        <div className="comp-card" key={row.entity_id} onClick={() => setSelected({ row, type })}>
          <div className="comp-hexes">
            {champs.map((c) => (
              <div className="mini-hex" key={c.id} style={{ "--cost": COST_COLORS[c.cost] || "#9aa3b2" }} title={prettyName(c.id)}>
                {c.icon ? <img src={c.icon} alt="" draggable={false} /> : <span>{prettyName(c.id).slice(0, 2)}</span>}
              </div>
            ))}
          </div>
          <div className="comp-card-title">{compTraits(row.entity_id).join(" + ")}</div>
          <div className="comp-card-stats">
            <span className="good">{(row.win_rate * 100).toFixed(1)}%</span>
            <span className="muted">{row.avg_placement.toFixed(2)} avg</span>
          </div>
        </div>
      );
    }
    if (type === "champion") {
      const c = ctx.champById[row.entity_id];
      return (
        <div className="comp-card champ" key={row.entity_id} onClick={() => setSelected({ row, type })}>
          <div className="mini-hex big" style={{ "--cost": COST_COLORS[c?.cost] || "#9aa3b2" }}>
            {c?.icon ? <img src={c.icon} alt="" draggable={false} /> : <span>{prettyName(row.entity_id).slice(0, 2)}</span>}
          </div>
          <div className="comp-card-title">{prettyName(row.entity_id)}</div>
          <div className="comp-card-stats">
            <span className="good">{(row.win_rate * 100).toFixed(1)}%</span>
            <span className="muted">{row.avg_placement.toFixed(2)}</span>
          </div>
        </div>
      );
    }
    const it = ctx.itemById[row.entity_id];
    return (
      <div className="comp-card item" key={row.entity_id} onClick={() => setSelected({ row, type })}>
        <div className="item-thumb">
          {it?.icon ? <img src={it.icon} alt="" draggable={false} /> : <span>{prettyName(row.entity_id).slice(0, 2)}</span>}
        </div>
        <div className="comp-card-title">{it?.name || prettyName(row.entity_id)}</div>
        <div className="comp-card-stats">
          <span className="good">{(row.win_rate * 100).toFixed(1)}%</span>
          <span className="muted">{row.avg_placement.toFixed(2)}</span>
        </div>
      </div>
    );
  };

  return (
    <div>
      <h1 className="page-title">Meta Tier List</h1>
      <p className="page-sub">Ranked S→D by top-4 rate &amp; average placement · special X tier for champion augments · click any card for a full guide · updates every 60s</p>

      <div className="filters">
        <label>
          Type
          <select value={type} onChange={(e) => { setType(e.target.value); setSelected(null); }}>
            {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        {type === "composition" && (
          <label>
            Grouping
            <select value={grouped ? "grouped" : "all"} onChange={(e) => { setGrouped(e.target.value === "grouped"); setSelected(null); }}>
              <option value="grouped">Archetypes</option>
              <option value="all">All comps</option>
            </select>
          </label>
        )}
      </div>
      <Filters value={filters} onChange={setFilters} />

      {loading && <div className="panel"><div className="loading">Loading…</div></div>}
      {error && <div className="panel"><div className="empty">API error: {error}</div></div>}
      {!loading && !error && !hasRows && champAugs.length === 0 && <div className="panel"><div className="empty">No data yet — is the pipeline running?</div></div>}

      {(hasRows || champAugs.length > 0) && (
        <div className="tierlist">
          {/* Special X tier — champion (hero) augments, ranked by performance. */}
          {champAugs.length > 0 && (
            <div className="tier-row tier-X">
              <div className="tier-badge tier-X">
                <span className="tier-badge-letter">X</span>
                <span className="tier-badge-label">CHAMP AUGS</span>
              </div>
              <div className="tier-cards">
                {champAugs.map((a) => (
                  <div className="comp-card aug" key={a.entity_id} onClick={() => setSelected({ row: a, type: "augment" })}>
                    <div className="aug-hex-wrap">
                      <div className="mini-hex big" style={{ "--cost": COST_COLORS[a._champ.cost] || "#9aa3b2" }} title={prettyName(a._champ.id)}>
                        {a._champ.icon ? <img src={a._champ.icon} alt="" draggable={false} /> : <span>{prettyName(a._champ.id).slice(0, 2)}</span>}
                      </div>
                      {a._augIcon && <img className="aug-badge" src={a._augIcon} alt="" draggable={false} />}
                    </div>
                    <div className="comp-card-title">{a._augName}</div>
                    <div className="comp-card-stats">
                      <span className="good">{(a.win_rate * 100).toFixed(1)}%</span>
                      <span className="muted">{a.avg_placement.toFixed(2)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {TIERS.map((t) => (
            <div className={`tier-row tier-${t.id}`} key={t.id}>
              <div className={`tier-badge tier-${t.id}`}>
                <span className="tier-badge-letter">{t.id}</span>
                <span className="tier-badge-label">{t.id} TIER</span>
              </div>
              <div className="tier-cards">
                {byTier[t.id].length === 0
                  ? <div className="tier-empty">—</div>
                  : byTier[t.id].map(renderCard)}
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <GuideModal type={selected.type} row={selected.row} guide={buildGuide(selected.type, selected.row, ctx)} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
