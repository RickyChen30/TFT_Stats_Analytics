"""Real Riot Games TFT player lookup for the Player Search page.

Everything returned here comes from the official Riot API — current rank
(LEAGUE-V1), and per-match boards/placements (MATCH-V1) — plus static set
metadata (champion cost/icon, item/trait icons) for display. No stats are
synthesized: aggregates (avg placement, top-4 %, win %, etc.) are computed from
the real match history.

Requires a valid RIOT_API_KEY. Synchronous (urllib) so it runs fine inside the
FastAPI threadpool.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from common import tft_data as td

# tagLine (upper-cased) -> (platform host, regional cluster). Covers the live
# Riot routing values; unknown tags fall back to NA / americas.
# tagLine -> (platform, account-v1 cluster, match-v1 cluster). account-v1 only
# accepts americas/asia/europe; match-v1 also has sea — so they can differ.
_ROUTING = {
    "NA1": ("na1", "americas", "americas"), "NA": ("na1", "americas", "americas"),
    "BR1": ("br1", "americas", "americas"), "BR": ("br1", "americas", "americas"),
    "LAN": ("la1", "americas", "americas"), "LA1": ("la1", "americas", "americas"),
    "LAS": ("la2", "americas", "americas"), "LA2": ("la2", "americas", "americas"),
    "OCE": ("oc1", "americas", "sea"), "OC1": ("oc1", "americas", "sea"),
    "EUW": ("euw1", "europe", "europe"), "EUW1": ("euw1", "europe", "europe"),
    "EUNE": ("eun1", "europe", "europe"), "EUN1": ("eun1", "europe", "europe"),
    "EUNE1": ("eun1", "europe", "europe"), "TR": ("tr1", "europe", "europe"),
    "TR1": ("tr1", "europe", "europe"), "RU": ("ru", "europe", "europe"),
    "KR": ("kr", "asia", "asia"), "KR1": ("kr", "asia", "asia"),
    "JP": ("jp1", "asia", "asia"), "JP1": ("jp1", "asia", "asia"),
    "VN2": ("vn2", "asia", "sea"), "SG2": ("sg2", "asia", "sea"),
    "TW2": ("tw2", "asia", "sea"), "TH2": ("th2", "asia", "sea"), "PH2": ("ph2", "asia", "sea"),
}

_MAX_RESPONSE_BYTES = 8 * 1024 * 1024  # hard cap on any single Riot API response
_APEX = {"MASTER", "GRANDMASTER", "CHALLENGER"}
_QUEUES = {1100: "Ranked", 1090: "Normal", 1130: "Hyper Roll", 1160: "Double Up", 1170: "Double Up"}
_TRAIT_STYLES = {0: "none", 1: "bronze", 2: "silver", 3: "gold", 4: "prismatic", 5: "prismatic"}
# Riot unit "rarity" -> gold cost.
_RARITY_COST = {0: 1, 1: 2, 2: 3, 3: 4, 4: 4, 5: 5, 6: 5, 7: 6}

# Static lookups for display (set-data, not player stats).
_ITEM_ICON = {i["id"]: i.get("icon", "") for i in getattr(td, "BUILDER_ITEMS", [])}
_ITEM_NAME = {i["id"]: i.get("name", "") for i in getattr(td, "BUILDER_ITEMS", [])}
_norm = lambda s: re.sub(r"[^a-z0-9]", "", str(s).lower())
_TRAIT_BY_NORM = {_norm(t["name"]): t for t in getattr(td, "TRAITS_DATA", [])}

# Riot id autocomplete. Riot has no name-search API, so suggestions come from a
# small seed plus every id we successfully resolve (so it grows as players are
# searched). Frontend also keeps the user's own recent searches.
_KNOWN_IDS = {"Hyperick#NA1"}


def register(riot_id: str):
    if riot_id and "#" in riot_id:
        _KNOWN_IDS.add(riot_id)


def suggest(q: str, limit: int = 8) -> list[str]:
    ql = (q or "").strip().lower()
    ids = sorted(_KNOWN_IDS, key=str.lower)
    if ql:
        starts = [r for r in ids if r.lower().startswith(ql)]
        contains = [r for r in ids if ql in r.lower() and r not in starts]
        ids = starts + contains
    return ids[:limit]


# Rank snapshots over time. Riot's API exposes only the *current* TFT season, so
# we record each looked-up player's rank with a date (exactly how trackers build
# rank graphs) and the history grows on every lookup. Persisted to DATA_DIR.
_STORE_PATH = os.path.join(os.environ.get("DATA_DIR", "/tmp"), "player_ranks.json")
_LADDER_T = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"]
_DIV_V = {"IV": 0, "III": 1, "II": 2, "I": 3, "": 0}
_APEX_BASE = {"MASTER": 2800, "GRANDMASTER": 3300, "CHALLENGER": 3800}


def rank_value(tier: str, division: str, lp: int) -> int:
    if tier in _APEX_BASE:
        return _APEX_BASE[tier] + int(lp)
    if tier in _LADDER_T:
        return _LADDER_T.index(tier) * 400 + _DIV_V.get(division, 0) * 100 + int(lp)
    return 0


def _load_store() -> dict:
    try:
        with open(_STORE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_store(store: dict):
    try:
        tmp = _STORE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(store, f)
        os.replace(tmp, _STORE_PATH)
    except Exception:
        pass


def record_rank(puuid: str, rank: dict) -> list[dict]:
    """Append today's rank snapshot for a player (one per day, latest wins) and
    return the chronological history."""
    store = _load_store()
    hist = store.get(puuid, [])
    if not rank or rank.get("tier") in (None, "UNRANKED"):
        return hist
    today = datetime.date.today().isoformat()
    snap = {
        "date": today, "tier": rank["tier"], "division": rank.get("division", ""),
        "lp": rank["lp"], "rating": rank_value(rank["tier"], rank.get("division", ""), rank["lp"]),
        "wins": rank.get("wins", 0), "losses": rank.get("losses", 0), "label": rank["label"],
    }
    sig = (snap["tier"], snap["division"], snap["lp"])
    if hist and hist[-1]["date"] == today:
        hist[-1] = snap
    elif not hist or (hist[-1]["tier"], hist[-1]["division"], hist[-1]["lp"]) != sig:
        hist.append(snap)
    hist = hist[-120:]
    store[puuid] = hist
    _save_store(store)
    return hist


class RiotError(Exception):
    pass


class RiotTFT:
    def __init__(self, api_key: str, timeout: float = 8.0):
        self.key = api_key
        self.timeout = timeout

    def route(self, tag: str):
        """Returns (platform, account_cluster, match_cluster)."""
        return _ROUTING.get((tag or "").upper(), ("na1", "americas", "americas"))

    def _get(self, host: str, path: str, _retried: bool = False):
        url = f"https://{host}.api.riotgames.com{path}"
        # A non-default User-Agent is required: Riot's Cloudflare edge blocks the
        # stock "Python-urllib" UA with a 403 (error 1010) before reaching the API.
        req = urllib.request.Request(url, headers={
            "X-Riot-Token": self.key,
            "User-Agent": "TFT-Analytics/1.0 (https://github.com/tft-analytics)",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                # Cap the read so a malformed/hostile upstream response can't
                # exhaust memory. Real TFT match payloads are well under this.
                raw = r.read(_MAX_RESPONSE_BYTES + 1)
                if len(raw) > _MAX_RESPONSE_BYTES:
                    raise RiotError("Riot API response too large")
                return json.loads(raw.decode())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429 and not _retried:
                time.sleep(float(e.headers.get("Retry-After", "1")) + 0.2)
                return self._get(host, path, _retried=True)
            if e.code in (401, 403):
                raise RiotError("invalid or expired RIOT_API_KEY (401/403)")
            raise RiotError(f"Riot API {e.code} {e.reason}")
        except (urllib.error.URLError, TimeoutError) as e:
            raise RiotError(f"network error reaching Riot: {e}")

    def account(self, game_name: str, tag: str):
        _, acct_cluster, _ = self.route(tag)
        gn = urllib.parse.quote(game_name)
        tl = urllib.parse.quote(tag)
        return self._get(acct_cluster, f"/riot/account/v1/accounts/by-riot-id/{gn}/{tl}")

    def league(self, puuid: str, platform: str):
        return self._get(platform, f"/tft/league/v1/by-puuid/{urllib.parse.quote(puuid)}") or []

    def match_ids(self, puuid: str, cluster: str, count: int = 20):
        count = max(1, min(int(count), 50))  # clamp: never request an unbounded page
        return self._get(cluster, f"/tft/match/v1/matches/by-puuid/{urllib.parse.quote(puuid)}/ids?count={count}") or []

    def match(self, match_id: str, cluster: str):
        return self._get(cluster, f"/tft/match/v1/matches/{urllib.parse.quote(match_id)}")


def _stage_round(last_round: int) -> str:
    """Riot's sequential last_round -> 'stage-round' (stage 1 = 3 rounds, then 7/stage)."""
    if last_round <= 3:
        return f"1-{max(1, last_round)}"
    r = last_round - 3
    return f"{2 + (r - 1) // 7}-{(r - 1) % 7 + 1}"


def _rank_from_league(e: dict | None) -> dict:
    if not e:
        return {"tier": "UNRANKED", "division": "", "lp": 0, "label": "Unranked", "wins": 0, "losses": 0}
    tier = e.get("tier", "UNRANKED")
    div = e.get("rank", "")
    lp = e.get("leaguePoints", 0)
    apex = tier in _APEX
    label = f"{tier.title()} · {lp} LP" if apex else f"{tier.title()} {div} · {lp} LP"
    return {"tier": tier, "division": "" if apex else div, "lp": lp, "label": label,
            "wins": e.get("wins", 0), "losses": e.get("losses", 0)}


def _unit_cost(u: dict) -> int:
    c = td.CHAMPION_COST.get(u.get("character_id", ""))
    if c:
        return c
    return _RARITY_COST.get(u.get("rarity", 0), 1)


def _parse_match(raw: dict, puuid: str) -> dict | None:
    info = raw.get("info") or {}
    me = next((p for p in info.get("participants", []) if p.get("puuid") == puuid), None)
    if not me:
        return None

    units = []
    for u in me.get("units", []):
        cid = u.get("character_id", "")
        items = []
        for it in (u.get("itemNames") or []):
            items.append({"name": _ITEM_NAME.get(it, re.sub(r"^TFT\d*_Item_", "", it)), "icon": _ITEM_ICON.get(it, "")})
        units.append({
            "champion": cid, "icon": td.CHAMPION_ICONS.get(cid, ""),
            "cost": _unit_cost(u), "star": int(u.get("tier", 1)), "items": items,
        })
    cost_sorted = sorted(range(len(units)), key=lambda i: -units[i]["cost"])
    carry_ids = set(cost_sorted[:2])
    for i, un in enumerate(units):
        un["carry"] = i in carry_ids and un["cost"] >= 3
    units.sort(key=lambda x: (x["cost"], x["champion"]))

    traits = []
    for t in me.get("traits", []):
        style = int(t.get("style", 0))
        if style <= 0 or int(t.get("tier_current", 0)) <= 0:
            continue
        meta = _TRAIT_BY_NORM.get(_norm(re.sub(r"^TFT\d*_", "", t.get("name", ""))))
        traits.append({
            "name": meta["name"] if meta else re.sub(r"^TFT\d*_", "", t.get("name", "")),
            "count": int(t.get("num_units", 0)), "tier": int(t.get("tier_current", 0)),
            "icon": (meta or {}).get("icon", ""), "style": _TRAIT_STYLES.get(style, "bronze"),
        })
    traits.sort(key=lambda t: (-t["tier"], -t["count"]))

    dt = info.get("game_datetime", time.time() * 1000) / 1000.0
    return {
        "match_id": raw.get("metadata", {}).get("match_id", ""),
        "date": datetime.date.fromtimestamp(dt).isoformat(),
        "timestamp": int(info.get("game_datetime", 0)),
        "queue": _QUEUES.get(info.get("queue_id"), "TFT"),
        "placement": int(me.get("placement", 8)),
        "level": int(me.get("level", 0)),
        "round": _stage_round(int(me.get("last_round", 0))),
        "gold_left": int(me.get("gold_left", 0)),
        "damage": int(me.get("total_damage_to_players", 0)),
        "eliminations": int(me.get("players_eliminated", 0)),
        "traits": traits,
        "units": units,
    }


def build_player_profile(api_key: str, game_name: str, tag: str) -> dict:
    """Fetch and assemble a player's profile entirely from official Riot data."""
    client = RiotTFT(api_key)
    platform, _acct_cluster, cluster = client.route(tag)
    display_id = f"{game_name}#{tag}" if tag else game_name

    acct = client.account(game_name, tag)
    if not acct or "puuid" not in acct:
        return {"status": "not_found", "summoner_name": display_id}
    puuid = acct["puuid"]
    game_name = acct.get("gameName", game_name)
    tag = acct.get("tagLine", tag)
    region = re.sub(r"\d+$", "", tag).upper() or "NA"
    register(f"{game_name}#{tag}")  # real, resolved id → feeds autocomplete

    ranked = next((e for e in client.league(puuid, platform) if e.get("queueType") == "RANKED_TFT"), None)
    current_rank = _rank_from_league(ranked)
    rank_history = record_rank(puuid, current_rank)  # real, grows over time
    peak = max(rank_history, key=lambda h: h["rating"]) if rank_history else None
    peak_rank = {"tier": peak["tier"], "label": peak["label"]} if peak else current_rank

    ids = client.match_ids(puuid, cluster, count=20)
    matches = []
    for mid in ids:
        pm = _parse_match(client.match(mid, cluster) or {}, puuid)
        if pm:
            matches.append(pm)

    if not matches:
        return {
            "status": "ok", "data_source": "riot", "summoner_name": display_id,
            "game_name": game_name, "tag_line": tag, "region": region,
            "current_rank": current_rank, "rank_history": rank_history, "peak_rank": peak_rank,
            "recent_matches": [], "no_matches": True,
        }

    matches.sort(key=lambda m: m["timestamp"], reverse=True)  # most recent first
    places = [m["placement"] for m in matches]
    n = len(matches)
    all_units = [u for m in matches for u in m["units"]]
    star_gold = {1: 1, 2: 3, 3: 9}

    dist = [0] * 8
    for p in places:
        dist[min(8, max(1, p)) - 1] += 1
    top4 = sum(1 for p in places if p <= 4)
    firsts = sum(1 for p in places if p == 1)
    streak = 0
    for p in places:
        if p <= 4:
            streak += 1
        else:
            break

    games_season = (current_rank["wins"] + current_rank["losses"]) if ranked else n

    # Per-champion usage from the sampled matches.
    cg, cp = {}, {}
    for m in matches:
        seen = set()
        for u in m["units"]:
            cid = u["champion"]
            if cid in seen:
                continue
            seen.add(cid)
            cg[cid] = cg.get(cid, 0) + 1
            cp[cid] = cp.get(cid, 0.0) + m["placement"]
    most_played = sorted(
        ({"champion": c, "games": g, "your_avg_placement": round(cp[c] / g, 2)} for c, g in cg.items()),
        key=lambda r: -r["games"])[:6]

    carry_count = {}
    for m in matches:
        for u in m["units"]:
            if u.get("carry") and u["cost"] >= 4:
                carry_count[u["champion"]] = carry_count.get(u["champion"], 0) + 1
    top_carry = None
    if carry_count:
        cid = max(carry_count, key=carry_count.get)
        top_carry = {"champion": cid, "icon": td.CHAMPION_ICONS.get(cid, ""), "name": re.sub(r"^TFT\d*_", "", cid)}

    return {
        "status": "ok",
        "data_source": "riot",
        "summoner_name": display_id,
        "game_name": game_name,
        "tag_line": tag,
        "region": region,
        "current_rank": current_rank,
        "rank_history": rank_history,
        "peak_rank": peak_rank,
        "stats": {
            "games": games_season,
            "sample": n,
            "avg_placement": round(sum(places) / n, 2),
            "win_rate": round(firsts / n, 4),
            "top4_rate": round(top4 / n, 4),
            "firsts": firsts,
            "top4": top4,
            "top4_pct": round(top4 / n * 100, 1),
            "won_pct": round(firsts / n * 100, 1),
            "avg_level": round(sum(m["level"] for m in matches) / n, 2),
            "avg_team_cost": round(sum(u["cost"] * star_gold.get(u["star"], 1) for u in all_units) / n, 1),
            "avg_star_level": round(sum(u["star"] for u in all_units) / max(1, len(all_units)), 2),
            "wins": current_rank["wins"], "losses": current_rank["losses"],
        },
        "placement_distribution": [{"place": k + 1, "count": dist[k]} for k in range(8)],
        "recent_summary": {"avg": round(sum(places) / n, 2), "top4": top4, "wins": firsts, "streak": streak},
        "recent_matches": matches,
        "most_played": most_played,
        "top_carry": top_carry,
    }
