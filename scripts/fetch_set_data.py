"""Snapshot a clean TFT Set 17 dataset into common/tft_data.py.

Pulls champions/traits/items/augments from Community Dragon and the most recent
patch numbers from Data Dragon, then writes a static Python module so the running
services have no network dependency. Re-run to refresh:

    .venv/bin/python scripts/fetch_set_data.py
"""
from __future__ import annotations

import json
import os
import urllib.request

SET = "17"
CDRAGON = "https://raw.communitydragon.org/latest/cdragon/tft/en_us.json"
DDRAGON_VERSIONS = "https://ddragon.leagueoflegends.com/api/versions.json"
OUT = os.path.join(os.path.dirname(__file__), "..", "common", "tft_data.py")


def get(url: str, timeout: int = 60):
    req = urllib.request.Request(url, headers={"User-Agent": "tft-analytics"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def recent_patches(n: int = 3) -> list[str]:
    versions = get(DDRAGON_VERSIONS)
    seen, out = set(), []
    for v in versions:  # newest first, e.g. "16.11.1"
        parts = v.split(".")
        if len(parts) >= 2 and parts[0].isdigit():
            mm = f"{parts[0]}.{parts[1]}"
            if mm not in seen:
                seen.add(mm)
                out.append(mm)
        if len(out) >= n:
            break
    out.reverse()  # oldest -> newest
    return out


def clean_traits(traits: list[str]) -> list[str]:
    out = []
    for t in traits or []:
        if t and t != "Choose Trait" and t not in out:
            out.append(t)
    return out


def cdn(path: str) -> str:
    """Convert a CDragon game asset path (.tex/.dds) to a public PNG URL."""
    if not path:
        return ""
    p = path.lower().replace(".tex", ".png").replace(".dds", ".png")
    return "https://raw.communitydragon.org/latest/game/" + p


COMPONENTS = {
    "TFT_Item_BFSword", "TFT_Item_RecurveBow", "TFT_Item_NeedlesslyLargeRod",
    "TFT_Item_TearOfTheGoddess", "TFT_Item_ChainVest", "TFT_Item_NegatronCloak",
    "TFT_Item_GiantsBelt", "TFT_Item_SparringGloves", "TFT_Item_Spatula",
    "TFT_Item_FryingPan",
}
_ITEM_EXCLUDE = ("GrabBag", "Tactician", "Crown", "Consumable", "Placeholder",
                 "Component", "Unstable", "Training", "Champion", "Garen",
                 "FakeItem", "_Free", "Random", "Market", "Anvil", "Lesser",
                 "Mirror", "Tutorial", "Test")
# Display order: basic components, normal items, radiant items, emblems,
# then artifacts & special items.
_ITEM_ORDER = {"component": 0, "completed": 1, "radiant": 2, "emblem": 3, "artifact": 4}


def build_items(data: dict) -> list[dict]:
    """Categorized, equippable item pool (components, completed, emblems,
    artifacts, radiant) with portrait icons — for the team builder."""
    out, seen = [], set()
    for i in data["items"]:
        api = i.get("apiName", "") or ""
        name = i.get("name") or ""
        icon = i.get("icon") or ""
        comp = i.get("composition") or []
        if not name or not icon or api in seen:
            continue
        if any(x in api for x in _ITEM_EXCLUDE):
            continue
        kind = None
        if api in COMPONENTS:
            kind = "component"
        elif api.startswith(f"TFT{SET}_Item_"):
            if "Emblem" in api:
                kind = "emblem"
            elif "Radiant" in api:
                kind = "radiant"  # set-specific radiant-tier items
        elif api.startswith("TFT_Item_"):
            if "Emblem" in api:
                kind = "emblem"
            elif "Radiant" in api:
                kind = "radiant"
            elif "Artifact" in api or "Ornn" in api:
                kind = "artifact"
            elif len(comp) == 2:
                kind = "completed"
        if not kind:
            continue
        seen.add(api)
        out.append({"id": api, "name": name, "icon": cdn(icon), "kind": kind,
                    "recipe": list(comp) if kind == "completed" and len(comp) == 2 else []})
    out.sort(key=lambda x: (_ITEM_ORDER.get(x["kind"], 9), x["name"]))
    return out


def build_traits(data: dict, trait_names: list[str]) -> list[dict]:
    """Trait metadata: icon + activation breakpoints (e.g. Vanguard 2/4/6)."""
    meta = {tr.get("name"): tr for tr in data["sets"][SET]["traits"]}
    out = []
    for name in trait_names:
        tr = meta.get(name, {})
        bps = sorted({e.get("minUnits") for e in (tr.get("effects") or []) if e.get("minUnits")})
        out.append({"name": name, "icon": cdn(tr.get("icon", "")), "breakpoints": bps})
    out.sort(key=lambda t: t["name"])
    return out


def build_augments(data: dict, augment_ids: list[str], tiers: dict) -> list[dict]:
    """Augments with icons for the builder's augment picker."""
    by = {i.get("apiName"): i for i in data["items"]}
    out = []
    for api in augment_ids:
        it = by.get(api, {})
        out.append({"id": api, "name": it.get("name", api),
                    "icon": cdn(it.get("icon", "")), "tier": tiers.get(api, "unknown")})
    out.sort(key=lambda a: a["name"])
    return out


def main():
    data = get(CDRAGON)
    s = data["sets"][SET]
    set_name = s.get("name", f"Set{SET}")

    champions = []
    champ_icons = {}
    for c in s["champions"]:
        api = c.get("apiName", "")
        cost = c.get("cost", 0)
        traits = clean_traits(c.get("traits"))
        if api.startswith(f"TFT{SET}_") and cost in (1, 2, 3, 4, 5) and traits:
            champions.append((api, cost, traits, c.get("name", api)))
            # Square splash-tile portrait; per-champion path numbers vary, so we
            # capture the exact CDragon path rather than deriving it.
            champ_icons[api] = cdn(c.get("squareIcon") or c.get("tileIcon") or "")
    champions.sort(key=lambda x: (x[1], x[0]))

    # Standard completed items (cross-set, 2-component recipes), capped for a
    # readable heatmap.
    items = []
    for i in data["items"]:
        api = i.get("apiName", "")
        comp = i.get("composition")
        if api.startswith("TFT_Item_") and isinstance(comp, list) and len(comp) == 2:
            items.append(api)
    items = sorted(dict.fromkeys(items))[:24]

    # The complete Set 17 augment pool. setData lists the exact augments active
    # this set — both the set-specific hero/trait augments AND the generic combat
    # augments reused from earlier sets — which is the full in-game pool. We drop
    # only templated sub-effects (names that are effect descriptions, e.g. the
    # god-augment quest steps) that aren't directly selectable.
    set_data = next(x for x in data["setData"]
                    if x.get("mutator") == f"TFTSet{SET}" or str(x.get("number")) == SET)
    by_api = {i.get("apiName"): i for i in data["items"]}
    augments = []
    for api in set_data.get("augments", []):
        name = (by_api.get(api, {}).get("name") or "")
        if "@" in name or not name:
            continue  # templated sub-effect, not a selectable augment
        augments.append(api)
    augments = sorted(dict.fromkeys(augments))

    traits = []
    for _, _, ts, _ in champions:
        for t in ts:
            if t not in traits:
                traits.append(t)

    patches = recent_patches(3)

    # Signal seeds for the synthetic generator: a few high-cost champions that
    # "over-perform" in high elo, and one augment flagged as a trap.
    high_elo = [api for api, cost, _, _ in champions if cost >= 4][:3]
    trap_aug = augments[0] if augments else ""

    # Compositions: common 2-trait cores (cosmetic; the processor derives the
    # real composition label per board from champion traits at runtime).
    comps = []
    for i in range(0, min(len(traits) - 1, 16), 2):
        comps.append(f"{traits[i]}_{traits[i+1]}".replace(" ", ""))

    render(champions, items, augments, traits, comps, patches, high_elo, trap_aug, set_name)
    print(f"Wrote {os.path.abspath(OUT)}")
    print(f"  Set {SET} ({set_name}): {len(champions)} champions, {len(items)} items, "
          f"{len(augments)} augments, {len(traits)} traits")
    print(f"  patches: {patches}  high-elo: {high_elo}  trap: {trap_aug}")


def render(champions, items, augments, traits, comps, patches, high_elo, trap_aug, set_name):
    def fmt_champs():
        lines = []
        for api, cost, ts, name in champions:
            lines.append(f"    ({api!r}, {cost}, {ts!r}),  # {name}")
        return "\n".join(lines)

    def fmt_list(xs):
        return "\n".join(f"    {x!r}," for x in xs)

    body = f'''"""Static TFT **{set_name}** reference data (snapshot).

Generated by scripts/fetch_set_data.py from Community Dragon + Data Dragon.
Used for synthetic ingestion and human-readable entity ids so the full pipeline
runs end-to-end without a live Riot API key.
"""
from __future__ import annotations

SET = {SET}
SET_NAME = {set_name!r}

# (champion_id, cost, traits) — cost biases synthetic placement strength.
CHAMPIONS = [
{fmt_champs()}
]

ITEMS = [
{fmt_list(items)}
]

AUGMENTS = [
{fmt_list(augments)}
]

TRAITS = [
{fmt_list(traits)}
]

# Named composition cores (cosmetic; the processor derives the real per-board
# composition label from champion traits at runtime).
COMPOSITIONS = [
{fmt_list(comps)}
]

TIERS = [
    "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM",
    "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER",
]

# Rank ordering for priority queues (lower number = higher priority).
TIER_RANK = {{t: i for i, t in enumerate(reversed(TIERS))}}

REGIONS = ["NA", "EUW", "KR", "BR"]

# Riot routing.
REGION_PLATFORM = {{"NA": "na1", "EUW": "euw1", "KR": "kr", "BR": "br1"}}
REGION_CLUSTER = {{"NA": "americas", "EUW": "europe", "KR": "asia", "BR": "americas"}}

CHAMPION_IDS = [c[0] for c in CHAMPIONS]
CHAMPION_COST = {{c[0]: c[1] for c in CHAMPIONS}}
CHAMPION_TRAITS = {{c[0]: c[2] for c in CHAMPIONS}}

# Champion portrait URLs (Community Dragon square splash tiles).
CHAMPION_ICONS = {{
{fmt_dict(champ_icons)}
}}

# Equippable item pool for the team builder: {{id, name, icon, kind, recipe}}.
# `recipe` lists the two component ids for completed items (empty otherwise).
BUILDER_ITEMS = [
{fmt_items(builder_items)}
]

# Trait metadata: {{name, icon, breakpoints}} — breakpoints are the activation
# thresholds (e.g. Vanguard 2/4/6).
TRAITS_DATA = [
{fmt_items(traits_data)}
]

# Augments for the builder's augment picker: {{id, name, icon, tier}}.
BUILDER_AUGMENTS = [
{fmt_items(builder_augments)}
]

# Recent Set {SET} patches, oldest -> newest. The last is the current patch.
PATCHES = {patches!r}
DEFAULT_PATCH = PATCHES[-1]

# Synthetic-signal seeds.
HIGH_ELO_FAVORITES = {high_elo!r}
TRAP_AUGMENT = {trap_aug!r}
'''
    with open(OUT, "w") as f:
        f.write(body)


if __name__ == "__main__":
    main()
