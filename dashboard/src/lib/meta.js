// Shared meta-ranking helpers used by the Meta Tier List and the analysis pages,
// so champions / items / augments are all bucketed into the same S→D tiers and
// open the same detail guide.

export const TIERS = [
  { id: "S", cut: 0.10 },
  { id: "A", cut: 0.30 },
  { id: "B", cut: 0.62 },
  { id: "C", cut: 0.88 },
  { id: "D", cut: 1.01 },
];

export const COST_COLORS = { 1: "#9aa3b2", 2: "#3fb950", 3: "#3b82f6", 4: "#b660e0", 5: "#f0b232" };

export const prettyName = (id) =>
  String(id)
    .replace(/^TFT\d*_(Item_|Augment_)?/, "")
    .replace(/^TFT_Item_/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2");

// Composite meta score: top-4 rate, nudged by average placement (lower = better),
// lightly shrunk toward the field mean when the sample is thin (low confidence).
export function metaScore(r, meanWin) {
  const base = r.win_rate - (r.avg_placement - 4.5) * 0.05;
  const conf = Math.min(1, r.sample_size / 400);
  return meanWin + (base - meanWin) * (0.4 + 0.6 * conf);
}

// Rank rows by meta score and bucket them into S→D by percentile so the list
// always reads as a clean pyramid. Mutates rows with `_score` and `metaTier`.
export function rankIntoTiers(rows) {
  const list = Array.isArray(rows) ? [...rows] : [];
  const byTier = Object.fromEntries(TIERS.map((t) => [t.id, []]));
  if (!list.length) return { sorted: [], byTier };
  const meanWin = list.reduce((s, r) => s + r.win_rate, 0) / list.length;
  list.forEach((r) => (r._score = metaScore(r, meanWin)));
  list.sort((a, b) => b._score - a._score);
  const n = list.length;
  list.forEach((r, i) => {
    const p = (i + 0.5) / n;
    r.metaTier = (TIERS.find((t) => p <= t.cut) || TIERS[TIERS.length - 1]).id;
    byTier[r.metaTier].push(r);
  });
  return { sorted: list, byTier };
}

// Lookup tables / derived maps from /meta/roster + /meta/heatmap, for guides.
export function guideContext(roster, heatmap) {
  const champById = Object.fromEntries((roster?.champions || []).map((c) => [c.id, c]));
  const traitByName = Object.fromEntries((roster?.traits || []).map((t) => [t.name, t]));
  const itemById = Object.fromEntries((roster?.items || []).map((i) => [i.id, i]));
  const augMetaById = Object.fromEntries((roster?.augments || []).map((a) => [a.id, a]));
  const champByShort = {};
  const champsByTrait = {};
  (roster?.champions || []).forEach((c) => {
    champByShort[c.id.replace(/^TFT\d*_/, "")] = c;
    (c.traits || []).forEach((t) => (champsByTrait[t] || (champsByTrait[t] = [])).push(c));
  });
  return { champById, traitByName, itemById, augMetaById, champByShort, champsByTrait, cells: heatmap?.cells || [] };
}

// The champion an augment id belongs to, or null. Champion-augment ids look like
// TFT##_Augment_[Invader]<Champion>[Minion]Carry.
export function augmentChampion(augId, champByShort) {
  const m = String(augId).match(/Augment_(.+)$/);
  if (!m) return null;
  const short = m[1].replace(/^Invader/, "").replace(/Minion/, "").replace(/Carry$/, "");
  return champByShort?.[short] || null;
}

const compTraits = (id) => String(id).split("_").filter(Boolean);

// Condense the trait-pair compositions into archetypes. Each comp is assigned to
// its defining trait — the rarer of its two traits by total play. Ubiquitous
// traits (Meeple, Conduit…) are flex splashes that appear everywhere, so the
// rarer trait is the comp's real identity (e.g. every *_Mecha comp lands under
// Mecha). Variants sharing that trait merge into one sample-weighted archetype.
export function condenseCompositions(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const weight = {};
  list.forEach((r) => compTraits(r.entity_id).forEach((t) => (weight[t] = (weight[t] || 0) + r.sample_size)));
  const groups = {};
  list.forEach((r) => {
    const ts = compTraits(r.entity_id);
    if (!ts.length) return;
    const primary = ts.slice().sort((a, b) => (weight[a] || 0) - (weight[b] || 0))[0];
    (groups[primary] || (groups[primary] = [])).push(r);
  });
  return Object.entries(groups).map(([trait, variants]) => {
    const n = variants.reduce((s, r) => s + r.sample_size, 0) || 1;
    const vs = variants.slice().sort((a, b) => b.sample_size - a.sample_size);
    return {
      entity_id: `arch:${trait}`,
      _archetype: true,
      _trait: trait,
      _variants: vs,
      _histId: vs[0].entity_id, // representative variant for trend / by-rank fetches
      win_rate: variants.reduce((s, r) => s + r.win_rate * r.sample_size, 0) / n,
      avg_placement: variants.reduce((s, r) => s + r.avg_placement * r.sample_size, 0) / n,
      play_rate: variants.reduce((s, r) => s + r.play_rate, 0), // each is a board fraction → sum
      sample_size: n,
      tiers: [...new Set(variants.flatMap((r) => r.tiers || []))],
      regions: [...new Set(variants.flatMap((r) => r.regions || []))],
      patch: vs[0].patch,
    };
  });
}

function bestItemsForChamps(champIds, ctx) {
  const set = new Set(champIds);
  const agg = {};
  ctx.cells.filter((c) => set.has(c.champion)).forEach((c) => {
    const e = agg[c.item] || (agg[c.item] = { w: 0, n: 0 });
    e.w += c.win_rate * c.sample_size; e.n += c.sample_size;
  });
  return Object.entries(agg)
    .map(([id, { w, n }]) => ({ id, name: prettyName(id), icon: ctx.itemById[id]?.icon, win: w / n, n }))
    .sort((a, b) => b.win - a.win).slice(0, 6);
}

function champCard(c, carry = false) {
  return { id: c.id, name: prettyName(c.id), icon: c.icon, cost: c.cost, carry };
}

// Build the detail-guide payload for any entity type.
export function buildGuide(type, row, ctx) {
  if (type === "composition" && row._archetype) {
    const t = ctx.traitByName[row._trait] || { name: row._trait, icon: "", breakpoints: [] };
    const pool = (ctx.champsByTrait[row._trait] || []).slice().sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id));
    const carrySet = new Set(pool.filter((c) => c.cost >= 4).slice(0, 2).map((c) => c.id));
    const units = pool.slice(0, 10).map((c) => champCard(c, carrySet.has(c.id)));
    const recItems = bestItemsForChamps([...carrySet], ctx);
    const carryNames = units.filter((u) => u.carry).map((u) => u.name).join(" & ") || units[0]?.name || "your strongest unit";
    const itemNames = recItems.slice(0, 3).map((i) => i.name).join(", ");
    const variants = row._variants.map((v) => ({
      id: v.entity_id, name: compTraits(v.entity_id).join(" + "),
      win: v.win_rate, place: v.avg_placement, n: v.sample_size,
    }));
    return {
      title: t.name, subtitle: `${row._variants.length} comps · ${row.sample_size.toLocaleString()} games`,
      traits: [t], champs: units, recItems, variants,
      howTo: `The ${t.name} archetype centers on ${carryNames}. Flex your second trait by lobby (see variants below), hit your ${t.name}${t.breakpoints?.length ? ` (${t.breakpoints.join("/")})` : ""} breakpoints, and itemize ${itemNames || "core items"} onto the carry. Strongest in ${row.tiers?.join(", ") || "all"} lobbies.`,
    };
  }

  if (type === "composition") {
    const ts = compTraits(row.entity_id).map((name) => ctx.traitByName[name] || { name, icon: "", breakpoints: [] });
    const seen = new Set();
    const champs = [];
    compTraits(row.entity_id).forEach((t) => (ctx.champsByTrait[t] || []).forEach((c) => {
      if (!seen.has(c.id)) { seen.add(c.id); champs.push(c); }
    }));
    champs.sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id));
    const carrySet = new Set(champs.filter((c) => c.cost >= 4).slice(0, 2).map((c) => c.id));
    const units = champs.slice(0, 8).map((c) => champCard(c, carrySet.has(c.id)));
    const recItems = bestItemsForChamps([...carrySet], ctx);
    const carryNames = units.filter((u) => u.carry).map((u) => u.name).join(" & ") || units[0]?.name || "your strongest unit";
    const traitNames = ts.map((t) => `${t.name}${t.breakpoints?.length ? ` (${t.breakpoints.join("/")})` : ""}`).join(" + ");
    const itemNames = recItems.slice(0, 3).map((i) => i.name).join(", ");
    return {
      title: ts.map((t) => t.name).join(" + "),
      subtitle: `${units.length} core units · ${row.sample_size.toLocaleString()} games`,
      traits: ts, champs: units, recItems,
      howTo: `Build around ${carryNames} as your main carry. Hit your ${traitNames} breakpoints, then itemize ${itemNames || "core items"} onto the carry. This composition performs best in ${row.tiers?.join(", ") || "all"} lobbies.`,
    };
  }

  if (type === "champion") {
    const c = ctx.champById[row.entity_id];
    const traits = (c?.traits || []).map((name) => ctx.traitByName[name] || { name, icon: "", breakpoints: [] });
    const recItems = ctx.cells.filter((x) => x.champion === row.entity_id)
      .sort((a, b) => b.win_rate - a.win_rate).slice(0, 6)
      .map((x) => ({ id: x.item, name: prettyName(x.item), icon: ctx.itemById[x.item]?.icon, win: x.win_rate, n: x.sample_size }));
    const itemNames = recItems.slice(0, 3).map((i) => i.name).join(", ");
    return {
      title: prettyName(row.entity_id), subtitle: c?.cost ? `${c.cost}-cost champion` : "Champion",
      traits, champs: c ? [champCard(c, true)] : [], recItems,
      howTo: `${prettyName(row.entity_id)} is a ${c?.cost ? `${c.cost}-cost ` : ""}unit${traits.length ? ` (${traits.map((t) => t.name).join(", ")})` : ""}. Best itemized with ${itemNames || "its core items"} based on current-patch win rate.`,
    };
  }

  if (type === "augment") {
    const champ = row._champ || augmentChampion(row.entity_id, ctx.champByShort);
    const name = row._augName || ctx.augMetaById[row.entity_id]?.name || prettyName(row.entity_id);
    if (champ) {
      const traits = (champ.traits || []).map((n) => ctx.traitByName[n] || { name: n, icon: "", breakpoints: [] });
      const recItems = bestItemsForChamps([champ.id], ctx);
      const itemNames = recItems.slice(0, 3).map((i) => i.name).join(", ");
      const cname = prettyName(champ.id);
      return {
        title: name, subtitle: `${cname} champion augment`, traits, champs: [champCard(champ, true)], recItems,
        howTo: `${name} is ${cname}'s champion augment. Commit to ${cname} as your main carry${traits.length ? ` (${traits.map((t) => t.name).join(", ")})` : ""}, then itemize ${itemNames || "its core items"}. Strongest in ${row.tiers?.join(", ") || "all"} lobbies.`,
      };
    }
    const tierWord = row.augment_tier ? `${row.augment_tier} augment` : "Augment";
    return {
      title: name, subtitle: tierWord, traits: [], champs: [], recItems: [],
      howTo: `${name} is a ${row.augment_tier || ""} augment with a ${(row.win_rate * 100).toFixed(1)}% top-4 rate and ${row.avg_placement.toFixed(2)} average placement this patch. Strongest in ${row.tiers?.join(", ") || "all"} lobbies.`,
    };
  }

  // item
  const bestChamps = ctx.cells.filter((x) => x.item === row.entity_id)
    .sort((a, b) => b.win_rate - a.win_rate).slice(0, 8)
    .map((x) => { const c = ctx.champById[x.champion]; return { id: x.champion, name: prettyName(x.champion), icon: c?.icon, cost: c?.cost, carry: false }; });
  const it = ctx.itemById[row.entity_id];
  return {
    title: it?.name || prettyName(row.entity_id), subtitle: it?.kind ? `${it.kind} item` : "Item",
    traits: [], champs: bestChamps, recItems: [],
    howTo: `${it?.name || prettyName(row.entity_id)} performs best on the units above. Prioritize it on carries that fit your board.`,
  };
}
