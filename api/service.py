"""Data-access layer for the REST API.

Wraps the meta-store gRPC client with a 60s TTL cache, aggregates per-entity
stats across tiers/regions, enforces the minimum-sample-size invariant, and
maintains a rolling in-memory feed of anomaly alerts subscribed from the broker.
"""
from __future__ import annotations

import json
import os
import threading
import time
from collections import defaultdict, deque

from common import tft_data as td
from common.clients import BrokerClient, MetaStoreClient
from common.proto import TOPIC_ANOMALY_ALERTS
from .cache import TTLCache

MIN_SAMPLE_SIZE = 200          # invariant: never serve a stat below this
HIGH_TIERS = {"MASTER", "GRANDMASTER", "CHALLENGER", "DIAMOND"}
LOW_TIERS = {"IRON", "BRONZE", "SILVER", "GOLD"}


def getenv(key, default=None):
    v = os.environ.get(key)
    return v if v not in (None, "") else default


def _entry_dict(eid, etype, win_rate, avg_placement, play_rate, sample_size, patch, tiers, regions):
    return {
        "entity_id": eid,
        "entity_type": etype,
        "win_rate": round(win_rate, 4),
        "avg_placement": round(avg_placement, 4),
        "play_rate": round(play_rate, 4),
        "sample_size": int(sample_size),
        "patch": patch,
        "tiers": sorted(tiers),
        "regions": sorted(regions),
    }


def _empty_reference_entry(eid: str, etype: str, patch: str):
    return _entry_dict(
        eid,
        etype,
        win_rate=0.0,
        avg_placement=8.0,
        play_rate=0.0,
        sample_size=0,
        patch=patch or td.DEFAULT_PATCH,
        tiers=set(),
        regions=set(),
    )


def _augment_category(eid: str) -> str:
    return td.AUGMENT_CATEGORIES.get(eid, "god" if "GodAugment" in eid else "standard")


def _decorate_entity(row: dict) -> dict:
    if row["entity_type"] != "augment":
        return row
    row["augment_tier"] = td.AUGMENT_TIERS.get(row["entity_id"], "unknown")
    row["augment_category"] = _augment_category(row["entity_id"])
    return row


def aggregate_by_entity(entries) -> list[dict]:
    """Collapse per-(tier,region) entries into one sample-weighted row per entity."""
    groups: dict[str, list] = defaultdict(list)
    for e in entries:
        groups[e.entity_id].append(e)
    out = []
    for eid, es in groups.items():
        total = sum(e.sample_size for e in es)
        if total == 0:
            continue
        wr = sum(e.win_rate * e.sample_size for e in es) / total
        ap = sum(e.avg_placement * e.sample_size for e in es) / total
        pr = sum(e.play_rate * e.sample_size for e in es) / total
        out.append(_decorate_entity(_entry_dict(
            eid, es[0].entity_type, wr, ap, pr, total, es[0].patch,
            {e.tier for e in es}, {e.region for e in es},
        )))
    return out


def complete_reference_entities(entity_type: str, rows: list[dict], patch: str = "") -> list[dict]:
    """Append missing static reference entities for dashboards that need full coverage."""
    if entity_type != "augment":
        return rows
    seen = {r["entity_id"] for r in rows}
    out = list(rows)
    for augment_id in td.AUGMENTS:
        if augment_id not in seen:
            out.append(_decorate_entity(_empty_reference_entry(augment_id, "augment", patch)))
    return out


class Service:
    def __init__(self):
        self.metastore_addr = getenv("METASTORE_ADDR", "127.0.0.1:50052")
        self.broker_addr = getenv("BROKER_ADDR", "127.0.0.1:50051")
        self.api_key = getenv("RIOT_API_KEY")
        self.metastore = MetaStoreClient(self.metastore_addr)
        self.cache = TTLCache(ttl=float(getenv("CACHE_TTL_SECS", "60")))
        self.anomalies: deque = deque(maxlen=500)
        self._anom_lock = threading.Lock()
        self._start_anomaly_feed()

    # ---- raw scans (cached) ----
    def _scan(self, entity_type: str, patch: str = "", region: str = "") -> list:
        key = ("scan", entity_type, patch, region)
        return self.cache.get_or_compute(
            key, lambda: self.metastore.scan(entity_type=entity_type, patch=patch, region=region)
        )

    def _select_tiers(self, tier: str | None, tier_range: str | None) -> set | None:
        if tier:
            return {tier}
        if tier_range:
            return {t.strip() for t in tier_range.split(",") if t.strip()}
        return None  # all tiers

    # ---- list endpoint ----
    def list_entities(self, entity_type: str, patch: str = "", region: str = "",
                      tier: str | None = None, tier_range: str | None = None,
                      limit: int = 20, sort: str = "win_rate",
                      augment_category: str | None = None) -> list[dict]:
        entries = self._scan(entity_type, patch or "", region or "")
        tiers = self._select_tiers(tier, tier_range)
        if tiers is not None:
            entries = [e for e in entries if e.tier in tiers]
        rows = aggregate_by_entity(entries)
        if entity_type == "augment":
            rows = complete_reference_entities(entity_type, rows, patch or "")
            if augment_category:
                rows = [r for r in rows if r.get("augment_category") == augment_category]
        else:
            rows = [r for r in rows if r["sample_size"] >= MIN_SAMPLE_SIZE]
        reverse = sort != "avg_placement"  # avg_placement: lower is better
        if reverse:
            rows.sort(key=lambda r: (r["sample_size"] == 0, -r.get(sort, r["win_rate"])))
        else:
            rows.sort(key=lambda r: (r["sample_size"] == 0, r.get(sort, r["win_rate"])))
        return rows[:limit]

    # ---- single entity ----
    def get_entity(self, entity_type: str, entity_id: str, patch: str = "",
                   tier: str | None = None, region: str = "") -> dict:
        entries = self._scan(entity_type, patch or "", region or "")
        entries = [e for e in entries if e.entity_id == entity_id]
        if tier:
            entries = [e for e in entries if e.tier == tier]
        rows = aggregate_by_entity(entries)
        if entity_type != "augment":
            rows = [r for r in rows if r["sample_size"] >= MIN_SAMPLE_SIZE]
        if not rows:
            if entity_type == "augment" and entity_id in td.AUGMENTS:
                return _decorate_entity(_empty_reference_entry(entity_id, "augment", patch or ""))
            return {"status": "insufficient_data", "entity_id": entity_id}
        return _decorate_entity(rows[0])

    # ---- tier comparison ----
    def tier_comparison(self, entity_id: str, patch: str = "") -> dict:
        all_entries = []
        etype = None
        for t in ["champion", "item", "augment", "composition"]:
            es = [e for e in self._scan(t, patch or "") if e.entity_id == entity_id]
            if es:
                etype = t
                all_entries.extend(es)
        if not all_entries:
            return {"status": "insufficient_data", "entity_id": entity_id}
        per_tier = defaultdict(list)
        for e in all_entries:
            per_tier[e.tier].append(e)
        series = []
        for tier, es in per_tier.items():
            total = sum(e.sample_size for e in es)
            if total < MIN_SAMPLE_SIZE:
                continue
            wr = sum(e.win_rate * e.sample_size for e in es) / total
            ap = sum(e.avg_placement * e.sample_size for e in es) / total
            series.append({"tier": tier, "rank": td.TIER_RANK.get(tier, 99),
                           "win_rate": round(wr, 4), "avg_placement": round(ap, 4),
                           "sample_size": total})
        series.sort(key=lambda s: s["rank"])
        return {"entity_id": entity_id, "entity_type": etype, "series": series}

    # ---- rank gap ----
    def rank_gap(self, entity_type: str = "champion", patch: str = "", limit: int = 20) -> list[dict]:
        entries = self._scan(entity_type, patch or "")
        high = defaultdict(list)
        low = defaultdict(list)
        for e in entries:
            if e.sample_size < MIN_SAMPLE_SIZE:
                continue
            if e.tier in HIGH_TIERS:
                high[e.entity_id].append(e)
            elif e.tier in LOW_TIERS:
                low[e.entity_id].append(e)

        def wavg(es):
            tot = sum(x.sample_size for x in es)
            return sum(x.win_rate * x.sample_size for x in es) / tot if tot else None

        out = []
        for eid in set(high) & set(low):
            hw, lw = wavg(high[eid]), wavg(low[eid])
            if hw is None or lw is None:
                continue
            out.append({
                "entity_id": eid,
                "high_tier_win_rate": round(hw, 4),
                "low_tier_win_rate": round(lw, 4),
                "gap": round(hw - lw, 4),
            })
        out.sort(key=lambda r: abs(r["gap"]), reverse=True)
        return out[:limit]

    # ---- patch history ----
    def patch_history(self, entity_id: str | None = None) -> dict:
        per_patch = defaultdict(list)
        patches = set()
        for t in ["champion", "item", "augment", "composition"]:
            for e in self._scan(t, ""):
                patches.add(e.patch)
                if entity_id and e.entity_id == entity_id:
                    per_patch[e.patch].append(e)
        if not entity_id:
            return {"patches": sorted(patches)}
        series = []
        for patch, es in per_patch.items():
            total = sum(e.sample_size for e in es)
            if total < MIN_SAMPLE_SIZE:
                continue
            wr = sum(e.win_rate * e.sample_size for e in es) / total
            series.append({"patch": patch, "win_rate": round(wr, 4), "sample_size": total})
        series.sort(key=lambda s: s["patch"])
        return {"entity_id": entity_id, "series": series}

    # ---- champion x item heatmap support ----
    def champion_item_pairs(self, tier: str | None = None, patch: str = "",
                            top_champions: int = 14, top_items: int = 12):
        """Pivot champion_item pair stats into a champion (row) x item (col) grid."""
        entries = self._scan("champion_item", patch or "")
        if tier:
            entries = [e for e in entries if e.tier == tier]
        rows = aggregate_by_entity(entries)  # entity_id = "champion|item"

        # Rank champions and items by total samples to keep the grid readable.
        champ_samples: dict[str, int] = defaultdict(int)
        item_samples: dict[str, int] = defaultdict(int)
        cell: dict[tuple, dict] = {}
        for r in rows:
            if "|" not in r["entity_id"]:
                continue
            champ, item = r["entity_id"].split("|", 1)
            champ_samples[champ] += r["sample_size"]
            item_samples[item] += r["sample_size"]
            cell[(champ, item)] = r

        champions = [c for c, _ in sorted(champ_samples.items(), key=lambda kv: -kv[1])][:top_champions]
        items = [i for i, _ in sorted(item_samples.items(), key=lambda kv: -kv[1])][:top_items]

        matrix = []
        for champ in champions:
            for item in items:
                r = cell.get((champ, item))
                if r and r["sample_size"] >= MIN_SAMPLE_SIZE:
                    matrix.append({
                        "champion": champ, "item": item,
                        "win_rate": r["win_rate"], "avg_placement": r["avg_placement"],
                        "sample_size": r["sample_size"],
                    })
        return {"champions": champions, "items": items, "cells": matrix}

    # ---- player personalization ----
    def player_suggest(self, q: str = "", limit: int = 8) -> dict:
        """Riot id autocomplete (seed + previously-resolved ids)."""
        from .riot import suggest
        return {"suggestions": suggest(q, limit)}

    def player_analysis(self, summoner_name: str, region: str = "NA", api_key: str | None = None) -> dict:
        """Real player profile from the official Riot API. Uses a per-request key
        if supplied, else the configured RIOT_API_KEY. Never synthesizes stats."""
        from .riot import build_player_profile, RiotError

        key = api_key or self.api_key
        raw = (summoner_name or "").strip()
        game_name, _, tag = raw.partition("#")
        game_name, tag = game_name.strip(), tag.strip()

        if not (key and key.lower() not in ("", "synthetic", "none")):
            return {
                "status": "needs_api_key",
                "summoner_name": summoner_name,
                "message": "Player search uses live Riot data. Set a real RIOT_API_KEY "
                           "in your .env and restart the api service to look up players.",
            }
        if not tag:
            return {
                "status": "needs_tag",
                "summoner_name": summoner_name,
                "message": "Enter a full Riot id including the tag, e.g. hyperick#NA1.",
            }
        try:
            return build_player_profile(key, game_name, tag)
        except RiotError as e:
            return {"status": "error", "summoner_name": summoner_name, "message": f"Riot API error: {e}"}

    # ---- anomaly feed ----
    def _start_anomaly_feed(self):
        def loop():
            broker = BrokerClient(self.broker_addr)
            while True:
                try:
                    for _, payload in broker.subscribe(TOPIC_ANOMALY_ALERTS, "api", offset=0):
                        try:
                            self.anomalies.appendleft(json.loads(payload.decode()))
                        except json.JSONDecodeError:
                            continue
                except Exception:
                    time.sleep(3)
        threading.Thread(target=loop, daemon=True).start()

    def get_anomalies(self, window_hours: int = 24) -> list[dict]:
        cutoff = int(time.time() * 1000) - window_hours * 3600 * 1000
        with self._anom_lock:
            return [a for a in self.anomalies if a.get("timestamp", 0) >= cutoff]
