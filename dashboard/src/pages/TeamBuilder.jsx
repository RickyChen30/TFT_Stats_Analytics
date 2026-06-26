import React, { useMemo, useState } from "react";
import { api } from "../api.js";
import { useFetch } from "../hooks.js";

const ROWS = 4;
const COLS = 7;
const N = ROWS * COLS;
const MAX_ITEMS = 3;
const MAX_AUGMENTS = 3;
const COST_COLORS = { 1: "#9aa3b2", 2: "#3fb950", 3: "#3b82f6", 4: "#b660e0", 5: "#f0b232" };
const STAR_MULT = { 1: 1, 2: 3, 3: 9 }; // gold-value multiplier per star level

// ---- Win predictor model (Lanchester square law / Bradley–Terry) ----
// TFT combat is exponential, not linear: surviving units keep dealing damage, so
// a modest edge in board power compounds into a lopsided result. We therefore
// (1) build each board's effective combat power multiplicatively, and (2) map the
// two powers to a win probability via P = Sy^k / (Sy^k + Sf^k). That makes an
// empty board win 0%, a board vs an empty enemy win 100%, and the curve in
// between steep around an even matchup.

// Base kit strength by tier — super-linear (5-costs are far stronger than 1s).
const COST_BASE = { 1: 1, 2: 1.6, 3: 2.5, 4: 4, 5: 6 };
// Convex combat value per star level (a 3★ is ~6× a 1★, not 3×).
const STAR_POWER = { 1: 1, 2: 2.5, 3: 6 };
// Per-item multiplicative boost to a unit's power (added to a base of 1).
const ITEM_POWER = { component: 0.12, completed: 0.35, radiant: 0.55, emblem: 0.25, artifact: 0.4 };
// Steepness of the win-probability curve (Lanchester ≈ square law → ~2).
const COMBAT_EXP = 2.6;
// A full board fields a limited number of units (≈ player level). Only the
// strongest BOARD_CAP units fight, so flooding cheap units can't out-scale a
// real team that has fewer, stronger units.
const BOARD_CAP = 10;
// Trait families used to reward a balanced frontline/backline composition.
const FRONTLINE = new Set(["Bastion", "Vanguard", "Brawler", "Sentinel", "Knight", "Bulwark"]);
const BACKLINE = new Set(["Sniper", "Sorcerer", "Gunner", "Rogue", "Assassin", "Marauder", "Challenger", "Eradicator"]);

// A dominant high-cost 3-star is a force multiplier on the whole board — it hard-
// carries the fight, not just adds one unit's stats. Returns a multiplier on board
// power; the best carry on the board applies. Ordering encodes "or better":
// 3★5 > 3★4 > 3★3 > 2★5 … With COMBAT_EXP, a ×3.2 edge ⇒ ~95% and ×6 ⇒ ~99%.
function carryMult(cost, star) {
  if (star >= 3) {
    if (cost >= 5) return 6.0;  // 3-star 5-cost: essentially always wins
    if (cost === 4) return 3.2; // 3-star 4-cost: almost always wins
    if (cost === 3) return 2.0;
    if (cost === 2) return 1.5;
    return 1.3;                 // 3-star 1-cost
  }
  if (star === 2) {
    if (cost >= 5) return 1.5;  // 2-star 5-cost: strong, not decisive
    if (cost === 4) return 1.2;
  }
  return 1.0;
}

function cmpPatch(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d) return d;
  }
  return 0;
}

// Current-patch meta strength of a single entity (champion / item) as a
// multiplier centered on 1.0, combining all three tracked signals:
//   • avg_placement (1–8, lower = better) — the strongest signal, dominant weight
//   • win_rate (top-4 finish rate, ~0.5 baseline) — secondary
//   • play_rate (popularity / meta presence) — light, capped nudge
// Missing stats → 1.0 (neutral). Clamped to a sane band so one noisy entity
// can't dominate the board score.
function metaStrength(s) {
  if (!s) return 1;
  const place = s.avg_placement, wr = s.win_rate, play = s.play_rate;
  let m = 1;
  if (place !== undefined && place !== null) m += (4.5 - place) * 0.12; // 3.5→+.12, 5.5→-.12
  if (wr !== undefined && wr !== null) m += (wr - 0.5) * 0.6;           // 0.65→+.09
  if (play !== undefined && play !== null) m += clamp((play - 0.05) * 0.3, -0.05, 0.1);
  return clamp(m, 0.6, 1.6);
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Effective combat power for one board, grounded in current-patch stats (avg
// placement, win rate, play rate for champions, items and traits). Power is
// built multiplicatively: raw unit power × trait multiplier × balance
// multiplier × best-carry multiplier. Returns the multipliers too for display.
function scoreBoard(cells, champMeta, itemMeta, traitMeta, traitStrength) {
  const placed = cells.filter(Boolean);
  const empty = { total: 0, units: 0, unitPow: 0, carry: 1, traitMult: 1, balanceMult: 1 };
  if (!placed.length) return empty;

  let front = 0, back = 0, carry = 1;
  const traitCount = {}, seen = new Set();
  const contributions = [];                         // per-unit combat power
  placed.forEach((c) => {
    const cost = c.cost || 1, star = c.star || 1;
    const metaTilt = metaStrength(champMeta[c.id]);  // current-patch champion strength
    let itemFactor = 1;
    (c.items || []).forEach((it) => {
      const eff = (ITEM_POWER[it.kind] ?? 0.3) * metaStrength(itemMeta[it.id]); // item meta strength
      itemFactor += (cost >= 4 ? 1.15 : 1) * eff;    // items matter more on carries
    });
    contributions.push((COST_BASE[cost] || cost) * STAR_POWER[star] * metaTilt * itemFactor);
    carry = Math.max(carry, carryMult(cost, star));  // dominant carry = board force multiplier

    const traits = c.traits || [];
    if (traits.some((t) => FRONTLINE.has(t))) front++;
    if (traits.some((t) => BACKLINE.has(t))) back++;
    if (!seen.has(c.id)) { seen.add(c.id); traits.forEach((t) => (traitCount[t] = (traitCount[t] || 0) + 1)); }
  });

  // Only the strongest BOARD_CAP units fight (board-size cap).
  const unitPow = contributions.sort((a, b) => b - a).slice(0, BOARD_CAP).reduce((s, x) => s + x, 0);

  // Traits are force multipliers: each active breakpoint tier adds ~8%, scaled
  // by how strong that trait is in the current patch (traitStrength ≈ 0.6–1.6).
  let traitBoost = 0;
  Object.entries(traitCount).forEach(([name, count]) => {
    const bps = traitMeta[name]?.breakpoints || [];
    const tiers = bps.filter((b) => count >= b).length;
    traitBoost += tiers * 0.08 * (traitStrength?.[name] ?? 1);
  });
  const traitMult = 1 + traitBoost;
  // A balanced frontline+backline (tanks soak, carries deal) is worth up to +15%.
  const balanceMult = 1 + Math.min(0.15, Math.min(front, back) * 0.04);

  const total = unitPow * traitMult * balanceMult * carry;
  return { total, units: placed.length, unitPow, carry, traitMult, balanceMult };
}

const ITEM_KINDS = [
  { key: "all", label: "All items" },
  { key: "component", label: "Basic Components" },
  { key: "completed", label: "Normal Items" },
  { key: "radiant", label: "Radiant Items" },
  { key: "emblem", label: "Emblems" },
  { key: "artifact", label: "Artifacts & Special" },
];

const prettyName = (id) => id.replace(/^TFT\d*_/, "").replace(/([a-z])([A-Z])/g, "$1 $2");

// One 7x4 hex board (pointy-top). `mirror` flips the row offset so the enemy
// board on top reads as the symmetric mirror of the player board below.
const STAR_COLORS = { 1: "#cd7f32", 2: "#cbd5e1", 3: "#ffd34d" };

function HexBoard({ side, label, board, mirror, dragOver, setDragOver, onDrop, onDragStartCell, onClickCell, onRemoveCell, onRemoveItem }) {
  return (
    <div className="board-half">
      <div className="board-side-label">{label}</div>
      <div className="board">
        {Array.from({ length: ROWS }).map((_, r) => {
          const offset = mirror ? r % 2 === 0 : r % 2 === 1;
          return (
            <div className={`hex-row ${offset ? "offset" : ""}`} key={r}>
              {Array.from({ length: COLS }).map((_, c) => {
                const idx = r * COLS + c;
                const cell = board[idx];
                const over = dragOver.side === side && dragOver.idx === idx;
                return (
                  <div
                    key={idx}
                    className={`hex ${cell ? "filled" : ""} ${over ? "drag-over" : ""}`}
                    style={cell ? { "--cost": COST_COLORS[cell.cost] || "#9aa3b2" } : undefined}
                    onDragOver={(e) => { e.preventDefault(); if (!over) setDragOver({ side, idx }); }}
                    onDragLeave={() => over && setDragOver({ side: null, idx: -1 })}
                    onDrop={(e) => onDrop(e, side, idx)}
                    draggable={!!cell}
                    onDragStart={(e) => cell && onDragStartCell(e, side, idx, cell)}
                    onClick={() => cell && onClickCell(side, idx)}
                    onContextMenu={(e) => { if (cell) { e.preventDefault(); onRemoveCell(side, idx); } }}
                    title={cell ? `${prettyName(cell.id)} ${"★".repeat(cell.star || 1)} — left-click: star up · right-click: remove` : ""}
                  >
                    <div className="hex-inner">
                      {cell && (cell.icon
                        ? <img className="hex-img" src={cell.icon} alt={prettyName(cell.id)} draggable={false} />
                        : <span className="hex-label">{prettyName(cell.id)}</span>)}
                    </div>
                    {cell && (
                      <div className="hex-stars" style={{ color: STAR_COLORS[cell.star || 1] }}>
                        {"★".repeat(cell.star || 1)}
                      </div>
                    )}
                    {cell && (cell.items || []).length > 0 && (
                      <div className="hex-items">
                        {cell.items.map((it, k) => (
                          <img key={k} className="hex-item" src={it.icon} alt={it.name}
                            title={`${it.name} — click to remove`} draggable={false}
                            onClick={(e) => onRemoveItem(e, side, idx, k)} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AugmentPicker({ augments, onPick, onClose }) {
  const [q, setQ] = useState("");
  const list = augments.filter((a) => a.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Choose an augment</strong>
          <input autoFocus placeholder="Search augment…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        <div className="aug-grid">
          {list.map((a) => (
            <div key={a.id} className={`aug-pick tier-${a.tier}`} title={a.name} onClick={() => onPick(a)}>
              <img src={a.icon} alt={a.name} />
              <span>{a.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function TeamBuilder() {
  const { data, loading, error } = useFetch(() => api.roster(), []);
  const champions = data?.champions || [];
  const items = data?.items || [];
  const augmentPool = data?.augments || [];
  const traitMeta = useMemo(
    () => Object.fromEntries((data?.traits || []).map((t) => [t.name, t])), [data]);
  const componentMeta = useMemo(
    () => Object.fromEntries((data?.items || []).filter((i) => i.kind === "component").map((i) => [i.id, i])), [data]);

  // Current-patch stats for champions and items (avg placement, win rate, play
  // rate) — the meta-strength inputs to the predictor.
  const { data: stats } = useFetch(async () => {
    const ph = await api.patchHistory({});
    const patch = (ph.patches || []).slice().sort(cmpPatch).pop() || "";
    const [champs, its] = await Promise.all([
      api.champions({ patch, limit: 300 }),
      api.items({ patch, limit: 300 }),
    ]);
    const pick = (e) => ({ win_rate: e.win_rate, avg_placement: e.avg_placement, play_rate: e.play_rate });
    return {
      patch,
      champMeta: Object.fromEntries((champs || []).map((c) => [c.entity_id, pick(c)])),
      itemMeta: Object.fromEntries((its || []).map((i) => [i.entity_id, pick(i)])),
    };
  }, []);

  // Per-trait current-patch strength: average meta-strength of the champions
  // that carry each trait (traits aren't tracked as standalone entities, so we
  // proxy from their units). Centered ~1.0; feeds the trait force multiplier.
  const traitStrength = useMemo(() => {
    const champMeta = stats?.champMeta;
    if (!champMeta || !champions.length) return {};
    const acc = {};
    champions.forEach((c) => {
      const m = metaStrength(champMeta[c.id]);
      (c.traits || []).forEach((t) => {
        (acc[t] || (acc[t] = { sum: 0, n: 0 }));
        acc[t].sum += m; acc[t].n += 1;
      });
    });
    return Object.fromEntries(Object.entries(acc).map(([t, { sum, n }]) => [t, sum / n]));
  }, [stats, champions]);

  const [boards, setBoards] = useState({ player: Array(N).fill(null), enemy: Array(N).fill(null) });
  const [augments, setAugments] = useState([null, null, null]);
  const [pickerSlot, setPickerSlot] = useState(-1);
  const [dragOver, setDragOver] = useState({ side: null, idx: -1 });
  const [champSearch, setChampSearch] = useState("");
  const [costFilter, setCostFilter] = useState(0);
  const [itemSearch, setItemSearch] = useState("");
  const [itemKind, setItemKind] = useState("all");

  const setCell = (side, idx, fn) =>
    setBoards((b) => ({ ...b, [side]: b[side].map((c, i) => (i === idx ? fn(c) : c)) }));
  const clearAll = () => { setBoards({ player: Array(N).fill(null), enemy: Array(N).fill(null) }); setAugments([null, null, null]); };

  const onDrop = (e, side, idx) => {
    e.preventDefault();
    setDragOver({ side: null, idx: -1 });
    const champRaw = e.dataTransfer.getData("champ");
    const itemRaw = e.dataTransfer.getData("item");
    if (champRaw) {
      const champ = JSON.parse(champRaw);
      if (champ._from !== undefined) {
        setBoards((prev) => {
          const next = { player: [...prev.player], enemy: [...prev.enemy] };
          next[side][idx] = prev[champ._side][champ._from];
          next[champ._side][champ._from] = prev[side][idx];
          return next;
        });
      } else {
        setCell(side, idx, () => ({ ...champ, items: [], star: 1 }));
      }
    } else if (itemRaw) {
      const item = JSON.parse(itemRaw);
      setCell(side, idx, (c) => (!c || (c.items || []).length >= MAX_ITEMS ? c : { ...c, items: [...(c.items || []), item] }));
    }
  };
  const onDragStartCell = (e, side, idx, cell) =>
    e.dataTransfer.setData("champ", JSON.stringify({ ...cell, _from: idx, _side: side }));
  // Left-click cycles the star level 1 → 2 → 3 → 1.
  const onClickCell = (side, idx) => setCell(side, idx, (c) => (c ? { ...c, star: ((c.star || 1) % 3) + 1 } : c));
  const onRemoveCell = (side, idx) => setCell(side, idx, () => null);
  const onRemoveItem = (e, side, idx, k) => {
    e.stopPropagation();
    setCell(side, idx, (c) => ({ ...c, items: c.items.filter((_, i) => i !== k) }));
  };

  const playerPlaced = boards.player.filter(Boolean);
  // Board value: a 2★ unit costs 3× and a 3★ unit 9× the base (gold to make).
  const totalCost = playerPlaced.reduce((s, c) => s + (c.cost || 0) * STAR_MULT[c.star || 1], 0);

  // Win predictor: score both boards, then map the power ratio to a win
  // probability via Bradley–Terry with a Lanchester exponent. An empty board
  // wins 0%; a non-empty board vs an empty enemy wins 100%; the curve is steep
  // (exponential) around an even matchup.
  const prediction = useMemo(() => {
    const champMeta = stats?.champMeta || {}, itemMeta = stats?.itemMeta || {};
    const you = scoreBoard(boards.player, champMeta, itemMeta, traitMeta, traitStrength);
    const foe = scoreBoard(boards.enemy, champMeta, itemMeta, traitMeta, traitStrength);
    const sy = you.total, sf = foe.total;
    let pct;
    if (sy <= 0 && sf <= 0) pct = 50;
    else if (sf <= 0) pct = 100;            // enemy has nothing
    else if (sy <= 0) pct = 0;              // you have nothing
    else {
      const a = Math.pow(sy, COMBAT_EXP), b = Math.pow(sf, COMBAT_EXP);
      pct = (100 * a) / (a + b);
    }
    return { pct: Math.round(pct), you, foe, ready: !!stats };
  }, [boards, stats, traitMeta, traitStrength]);

  // Traits with activation breakpoints (e.g. Vanguard 2/4/6). Each *unique*
  // champion contributes to its traits only once — duplicate copies of the same
  // unit on the board do not raise the trait count (TFT rule).
  const traitRows = useMemo(() => {
    const counts = {};
    const seen = new Set();
    playerPlaced.forEach((c) => {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      (c.traits || []).forEach((t) => (counts[t] = (counts[t] || 0) + 1));
    });
    return Object.entries(counts).map(([name, count]) => {
      const meta = traitMeta[name] || { breakpoints: [], icon: "" };
      const bps = meta.breakpoints || [];
      const active = bps.filter((b) => count >= b);
      return { name, count, icon: meta.icon, bps, isActive: bps.length ? count >= bps[0] : false, tier: active.length };
    }).sort((a, b) => (b.isActive - a.isActive) || b.tier - a.tier || b.count - a.count);
  }, [boards, traitMeta]);

  // Components required to build every completed item on the player board.
  const componentsNeeded = useMemo(() => {
    const tally = {};
    playerPlaced.forEach((c) => (c.items || []).forEach((it) => (it.recipe || []).forEach((cid) => (tally[cid] = (tally[cid] || 0) + 1))));
    return Object.entries(tally)
      .map(([cid, n]) => ({ id: cid, count: n, ...(componentMeta[cid] || {}) }))
      .filter((c) => c.icon)
      .sort((a, b) => b.count - a.count);
  }, [boards, componentMeta]);

  const champPalette = champions.filter(
    (c) => (costFilter === 0 || c.cost === costFilter) && prettyName(c.id).toLowerCase().includes(champSearch.toLowerCase()));
  const itemPalette = items.filter(
    (it) => (itemKind === "all" || it.kind === itemKind) && it.name.toLowerCase().includes(itemSearch.toLowerCase()));

  const boardProps = { dragOver, setDragOver, onDrop, onDragStartCell, onClickCell, onRemoveCell, onRemoveItem };

  return (
    <div>
      <h1 className="page-title">Team Builder</h1>
      <p className="page-sub">Drag champions onto either board, then drag items onto them · your board: {playerPlaced.length}/{N} · {data?.set_name || "Set"}</p>

      <div className="builder-top">
        <div className="panel board-panel dark">
          <div className="board-arena">
            <HexBoard side="enemy" label="Enemy board" board={boards.enemy} mirror {...boardProps} />
            <div className="board-divider"><span>VS</span></div>
            <HexBoard side="player" label="Your board" board={boards.player} mirror={false} {...boardProps} />
          </div>
          <div className="board-actions">
            <button className="btn" onClick={clearAll} disabled={!playerPlaced.length && !boards.enemy.some(Boolean)}>Clear</button>
            <span className="hint">Left-click a unit to star up (1★→2★→3★) · right-click to remove · drag items onto a unit (max 3)</span>
          </div>
        </div>

        {/* Right column: cost & traits, augments, components */}
        <div className="builder-side">
          {/* Win predictor: your board vs the enemy board, from current-patch stats */}
          <div className="side-card predictor">
            <div className="side-card-head">
              <span>Win Predictor</span>
              <span className="muted">{stats?.patch ? `patch ${stats.patch}` : "…"}</span>
            </div>
            <div className="predict-pct" style={{ color: prediction.pct >= 50 ? "var(--good)" : "var(--bad)" }}>
              {prediction.pct}%
            </div>
            <div className="predict-sub">to win vs enemy board</div>
            <div className="predict-bar">
              <div className="predict-fill you" style={{ width: `${prediction.pct}%` }} />
              <div className="predict-fill foe" style={{ width: `${100 - prediction.pct}%` }} />
            </div>
            <div className="predict-legend">
              <span><span className="dot" style={{ background: "var(--good)" }} />You {prediction.you.total.toFixed(0)}</span>
              <span><span className="dot" style={{ background: "var(--bad)" }} />Enemy {prediction.foe.total.toFixed(0)}</span>
            </div>
            <div className="predict-factors">
              power {prediction.you.unitPow.toFixed(0)} · carry ×{prediction.you.carry.toFixed(1)} · traits ×{prediction.you.traitMult.toFixed(2)} · balance ×{prediction.you.balanceMult.toFixed(2)}
            </div>
          </div>

          <div className="side-card">
            <div className="side-card-head">
              <span>Board</span>
              <span className="cost-pill"><span className="coin">◆</span> {totalCost} · {playerPlaced.length} units</span>
            </div>
            <div className="trait-list">
              {traitRows.length === 0 && <div className="empty" style={{ padding: 16 }}>Place champions to see traits.</div>}
              {traitRows.map((t) => (
                <div className={`trait-item ${t.isActive ? "on" : "off"}`} key={t.name}>
                  {t.icon ? <img className="trait-icon" src={t.icon} alt="" /> : <span className="trait-icon ph" />}
                  <span className="trait-name">{t.name}</span>
                  <span className="trait-count">{t.count}</span>
                  <span className="bp-pips">
                    {t.bps.map((b) => (
                      <span key={b} className={`bp-pip ${t.count >= b ? "met" : ""}`}>{b}</span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="side-card">
            <div className="side-card-head"><span>Augments</span><span className="muted">{augments.filter(Boolean).length}/{MAX_AUGMENTS}</span></div>
            <div className="aug-slots">
              {augments.map((a, i) => (
                <div key={i} className="aug-slot" title={a ? a.name : "Add augment"}
                  onClick={() => (a ? setAugments((s) => s.map((x, k) => (k === i ? null : x))) : setPickerSlot(i))}>
                  {a ? <img src={a.icon} alt={a.name} /> : <span className="aug-plus">+</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="side-card">
            <div className="side-card-head"><span>Components</span><span className="muted">{componentsNeeded.reduce((s, c) => s + c.count, 0)}</span></div>
            {componentsNeeded.length === 0 && <div className="empty" style={{ padding: 16 }}>Add items to see the components needed.</div>}
            <div className="comp-list">
              {componentsNeeded.map((c) => (
                <div className="comp-chip" key={c.id} title={c.name}>
                  <img src={c.icon} alt={c.name} />
                  <span className="comp-count">{c.count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="side-card">
            <div className="side-card-head"><span>Items</span><span className="muted">{itemPalette.length}</span></div>
            <div className="item-controls">
              <select value={itemKind} onChange={(e) => setItemKind(e.target.value)}>
                {ITEM_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
              <input placeholder="Search item…" value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} />
            </div>
            <div className="palette item-grid">
              {itemPalette.map((it) => (
                <div key={it.id} className={`item-tile kind-${it.kind}`}
                  draggable onDragStart={(e) => e.dataTransfer.setData("item", JSON.stringify(it))}
                  title={`${it.name} (${it.kind})`}>
                  <img className="item-img" src={it.icon} alt={it.name} draggable={false} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Champions — vertical rail right next to the panels for quick dragging */}
        <div className="panel champ-rail">
          <div className="rail-controls">
            <strong className="palette-title">Champions</strong>
            <input placeholder="Search…" value={champSearch} onChange={(e) => setChampSearch(e.target.value)} />
            <div className="segment-control" style={{ margin: 0 }}>
              <button className={`segment-button ${costFilter === 0 ? "active" : ""}`} onClick={() => setCostFilter(0)}>All</button>
              {[1, 2, 3, 4, 5].map((c) => (
                <button key={c} className={`segment-button ${costFilter === c ? "active" : ""}`} onClick={() => setCostFilter(c)}>
                  <span style={{ color: COST_COLORS[c] }}>●</span> {c}
                </button>
              ))}
            </div>
          </div>
          {loading && <div className="loading">Loading…</div>}
          {error && <div className="empty">API error: {error}</div>}
          <div className="palette rail-palette">
            {champPalette.map((c) => (
              <div key={c.id} className="champ-tile" style={{ "--cost": COST_COLORS[c.cost] || "#9aa3b2" }}
                draggable onDragStart={(e) => e.dataTransfer.setData("champ", JSON.stringify(c))}
                title={`${prettyName(c.id)} (${c.cost})\n${(c.traits || []).join(" · ")}`}>
                {c.icon ? <img className="champ-img" src={c.icon} alt={prettyName(c.id)} draggable={false} />
                  : <span className="champ-name">{prettyName(c.id)}</span>}
                <span className="champ-cost-badge">{c.cost}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {pickerSlot >= 0 && (
        <AugmentPicker
          augments={augmentPool}
          onPick={(a) => { setAugments((s) => s.map((x, k) => (k === pickerSlot ? a : x))); setPickerSlot(-1); }}
          onClose={() => setPickerSlot(-1)}
        />
      )}
    </div>
  );
}
