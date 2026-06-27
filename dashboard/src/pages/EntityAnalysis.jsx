import React, { useMemo, useState } from "react";
import { api } from "../api.js";
import { useFetch } from "../hooks.js";
import Filters from "../components/Filters.jsx";
import GuideModal from "../components/GuideModal.jsx";
import { TIERS, COST_COLORS, prettyName, rankIntoTiers, guideContext, buildGuide } from "../lib/meta.js";

const LOADERS = {
  champion: api.champions,
  item: api.items,
  augment: api.augments,
};

const AUGMENT_GROUPS = [
  { key: "silver", label: "Silver" },
  { key: "gold", label: "Gold" },
  { key: "prismatic", label: "Prismatic" },
];

function tierClass(tier) {
  if (tier === "silver") return "silver";
  if (tier === "gold") return "gold";
  if (tier === "prismatic") return "prismatic";
  return "warn";
}

function augmentCategoryFor(row) {
  return row.augment_category || (row.entity_id.includes("GodAugment") ? "god" : "standard");
}

// Generic analysis page: champions / augments / items ranked into the same S→D
// meta tiers as the Meta Tier List. Click any card for a full detail guide.
export default function EntityAnalysis({
  entityType,
  title,
  subtitle,
  highlightTraps = false,
  augmentCategory = "",
}) {
  const [filters, setFilters] = useState({ tier: "", region: "", patch: "" });
  const [augmentTier, setAugmentTier] = useState("all");
  const [selected, setSelected] = useState(null);

  // High limit so every entity is shown (Set 17 has ~270 augments).
  const loader = () => LOADERS[entityType]({ ...filters, category: augmentCategory, limit: 500 });
  const { data, loading, error } = useFetch(
    loader,
    [entityType, augmentCategory, filters.tier, filters.region, filters.patch],
    60000
  );

  // Roster + heatmap drive the icons and the detail guides.
  const { data: roster } = useFetch(() => api.roster(), []);
  const { data: heatmap } = useFetch(() => api.heatmap({}), []);
  const ctx = useMemo(() => guideContext(roster, heatmap), [roster, heatmap]);

  const fetchedRows = Array.isArray(data) ? [...data] : [];
  const rawRows = entityType === "augment" && augmentCategory
    ? fetchedRows.filter((r) => augmentCategoryFor(r) === augmentCategory)
    : fetchedRows;
  const canFilterAugmentTier = entityType === "augment" && augmentCategory === "standard";
  const rows = canFilterAugmentTier && augmentTier !== "all"
    ? rawRows.filter((r) => r.augment_tier === augmentTier)
    : rawRows;

  const tierCounts = canFilterAugmentTier
    ? AUGMENT_GROUPS.reduce((acc, g) => {
        acc[g.key] = rawRows.filter((r) => (r.augment_tier || "unknown") === g.key).length;
        return acc;
      }, { all: rawRows.length })
    : {};

  // Trap detection (augments): popular but below-median win rate.
  const medWin = rows.length ? [...rows].sort((a, b) => a.win_rate - b.win_rate)[Math.floor(rows.length / 2)].win_rate : 0.5;
  const medPlay = rows.length ? [...rows].sort((a, b) => a.play_rate - b.play_rate)[Math.floor(rows.length / 2)].play_rate : 0;
  const isTrap = (r) => highlightTraps && r.play_rate >= medPlay && r.win_rate < medWin;

  const { byTier } = useMemo(() => rankIntoTiers(rows), [rows]);

  const augName = (row) => ctx.augMetaById[row.entity_id]?.name || prettyName(row.entity_id);
  const augIcon = (row) => ctx.augMetaById[row.entity_id]?.icon;

  const renderCard = (row) => {
    const stats = (
      <div className="comp-card-stats">
        <span className="good">{(row.win_rate * 100).toFixed(1)}%</span>
        <span className="muted">{row.avg_placement.toFixed(2)}</span>
      </div>
    );
    if (entityType === "champion") {
      const c = ctx.champById[row.entity_id];
      const traitIcon = ctx.traitByName[(c?.traits || [])[0]]?.icon;
      return (
        <div className="comp-card champ" key={row.entity_id} onClick={() => setSelected(row)}>
          <div className="mini-hex big" style={{ "--cost": COST_COLORS[c?.cost] || "#9aa3b2" }}>
            {c?.icon ? <img src={c.icon} alt="" draggable={false} /> : <span>{prettyName(row.entity_id).slice(0, 2)}</span>}
            {traitIcon && <img className="hex-trait-badge" src={traitIcon} alt="" draggable={false} />}
          </div>
          <div className="comp-card-title">{prettyName(row.entity_id)}</div>
          {stats}
        </div>
      );
    }
    if (entityType === "item") {
      const it = ctx.itemById[row.entity_id];
      return (
        <div className="comp-card item" key={row.entity_id} onClick={() => setSelected(row)}>
          <div className="item-thumb">
            {it?.icon ? <img src={it.icon} alt="" draggable={false} /> : <span>{prettyName(row.entity_id).slice(0, 2)}</span>}
          </div>
          <div className="comp-card-title">{it?.name || prettyName(row.entity_id)}</div>
          {stats}
        </div>
      );
    }
    // augment
    const trap = isTrap(row);
    return (
      <div className="comp-card aug-card" key={row.entity_id} onClick={() => setSelected(row)}>
        <div className="item-thumb">
          {augIcon(row) ? <img src={augIcon(row)} alt="" draggable={false} /> : <span>{augName(row).slice(0, 2)}</span>}
        </div>
        <div className="comp-card-title">{augName(row)}</div>
        <div className="aug-pills">
          {row.augment_tier && <span className={`pill ${tierClass(row.augment_tier)}`}>{row.augment_tier}</span>}
          {trap && <span className="pill bad">trap</span>}
        </div>
        {stats}
      </div>
    );
  };

  return (
    <div>
      <h1 className="page-title">{title}</h1>
      <p className="page-sub">{subtitle} · ranked into tiers · {rows.length} entities · click any card for a guide · updates every 60s</p>

      <Filters value={filters} onChange={setFilters} />
      {canFilterAugmentTier && (
        <div className="segment-control" aria-label="Augment tier">
          <button className={`segment-button ${augmentTier === "all" ? "active" : ""}`} onClick={() => setAugmentTier("all")} type="button">
            All <span>{tierCounts.all || 0}</span>
          </button>
          {AUGMENT_GROUPS.map((g) => (
            <button className={`segment-button ${augmentTier === g.key ? "active" : ""}`} key={g.key} onClick={() => setAugmentTier(g.key)} type="button">
              {g.label} <span>{tierCounts[g.key] || 0}</span>
            </button>
          ))}
        </div>
      )}

      {loading && <div className="panel"><div className="loading">Loading…</div></div>}
      {error && <div className="panel"><div className="empty">API error: {error}</div></div>}
      {!loading && !error && rows.length === 0 && <div className="panel"><div className="empty">No data yet — let the pipeline run.</div></div>}

      {rows.length > 0 && (
        <div className="tierlist">
          {TIERS.map((t) => (
            <div className={`tier-row tier-${t.id}`} key={t.id}>
              <div className={`tier-badge tier-${t.id}`}>
                <span className="tier-badge-letter">{t.id}</span>
                <span className="tier-badge-label">{t.id} TIER</span>
              </div>
              <div className="tier-cards">
                {byTier[t.id].length === 0
                  ? <div className="tier-empty">No {t.id} tier {entityType}s this patch.</div>
                  : byTier[t.id].map(renderCard)}
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <GuideModal type={entityType} row={selected} guide={buildGuide(entityType, selected, ctx)} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
