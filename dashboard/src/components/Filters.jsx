import React, { useEffect, useState } from "react";
import { api, TIERS, REGIONS } from "../api.js";

// Shared tier/region/patch filter bar. `show` selects which controls appear.
// The patch list is fetched live from /meta/patch-history so it always reflects
// whatever patches the pipeline has ingested (newest first).
export default function Filters({ value, onChange, show = ["tier", "region", "patch"] }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  const [patches, setPatches] = useState([]);

  useEffect(() => {
    if (!show.includes("patch")) return;
    let alive = true;
    api
      .patchHistory({})
      .then((d) => {
        if (!alive) return;
        const list = (d.patches || []).slice().sort((a, b) => cmpPatch(b, a)); // newest first
        setPatches(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [show]);

  return (
    <div className="filters">
      {show.includes("tier") && (
        <label>
          Tier
          <select value={value.tier || ""} onChange={set("tier")}>
            <option value="">All tiers</option>
            {TIERS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
      )}
      {show.includes("region") && (
        <label>
          Region
          <select value={value.region || ""} onChange={set("region")}>
            <option value="">All regions</option>
            {REGIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
      )}
      {show.includes("patch") && (
        <label>
          Patch
          <select value={value.patch || ""} onChange={set("patch")}>
            <option value="">All patches</option>
            {patches.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

// Compare "16.10" vs "16.9" numerically so 16.10 sorts above 16.9.
function cmpPatch(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
