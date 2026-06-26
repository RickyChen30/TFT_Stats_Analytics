// REST client for the FastAPI backend. The base URL is configurable at build
// time via VITE_API_BASE; it falls back to localhost:8000 for local dev.
const BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

async function get(path, params = {}, headers = {}) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 429) throw new Error("Rate limited — too many requests, slow down");
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const api = {
  champions: (f) => get("/meta/champions", f),
  champion: (id, f) => get(`/meta/champions/${id}`, f),
  compositions: (f) => get("/meta/compositions", f),
  composition: (id, f) => get(`/meta/compositions/${id}`, f),
  items: (f) => get("/meta/items", f),
  augments: (f) => get("/meta/augments", f),
  anomalies: (f) => get("/meta/anomalies", f),
  tierComparison: (id, f) => get(`/meta/tier-comparison/${id}`, f),
  rankGap: (f) => get("/meta/rank-gap", f),
  heatmap: (f) => get("/meta/heatmap", f),
  patchHistory: (f) => get("/meta/patch-history", f),
  roster: (f) => get("/meta/roster", f),
  // The Riot key goes in the X-Riot-Key header (never the URL) so it can't leak
  // into server logs or browser history.
  player: (name, { key } = {}) =>
    get(`/player/${encodeURIComponent(name)}`, {}, key ? { "X-Riot-Key": key } : {}),
  playerSuggest: (q) => get(`/players/suggest`, { q }),
};

export const TIERS = [
  "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM",
  "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER",
];
export const REGIONS = ["NA", "EUW", "KR", "BR"];
