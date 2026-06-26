"""Riot Games TFT API client (async).

Used when ``RIOT_API_KEY`` is set. Walks league -> puuids -> match ids ->
match detail and normalizes each match into a ``MatchEvent`` proto. All requests
pass through the shared :class:`RateLimiter`.
"""
from __future__ import annotations

import asyncio
import time

import aiohttp

from common import tft_data as td
from common.proto import pb
from .rate_limiter import RateLimiter

TIER_ENDPOINTS = {
    "CHALLENGER": "/tft/league/v1/challenger",
    "GRANDMASTER": "/tft/league/v1/grandmaster",
    "MASTER": "/tft/league/v1/master",
    "DIAMOND": "/tft/league/v1/entries/DIAMOND/I",
    "PLATINUM": "/tft/league/v1/entries/PLATINUM/I",
    "GOLD": "/tft/league/v1/entries/GOLD/I",
    "SILVER": "/tft/league/v1/entries/SILVER/I",
    "BRONZE": "/tft/league/v1/entries/BRONZE/I",
    "IRON": "/tft/league/v1/entries/IRON/I",
}


class RiotClient:
    def __init__(self, api_key: str, limiter: RateLimiter):
        self.api_key = api_key
        self.limiter = limiter
        self.session: aiohttp.ClientSession | None = None

    async def __aenter__(self):
        self.session = aiohttp.ClientSession(headers={"X-Riot-Token": self.api_key})
        return self

    async def __aexit__(self, *exc):
        if self.session:
            await self.session.close()

    async def _get(self, url: str):
        await self.limiter.acquire()
        async with self.session.get(url) as resp:
            if resp.status == 429:
                retry = int(resp.headers.get("Retry-After", "1"))
                await asyncio.sleep(retry)
                return await self._get(url)
            if resp.status != 200:
                return None
            return await resp.json()

    async def puuids_for_tier(self, region: str, tier: str, limit: int = 50) -> list[str]:
        platform = td.REGION_PLATFORM[region]
        path = TIER_ENDPOINTS[tier]
        data = await self._get(f"https://{platform}.api.riotgames.com{path}")
        if not data:
            return []
        entries = data["entries"] if isinstance(data, dict) and "entries" in data else data
        puuids = []
        for e in entries[:limit]:
            puuid = e.get("puuid")
            if puuid:
                puuids.append(puuid)
        return puuids

    async def match_ids(self, region: str, puuid: str, count: int = 20) -> list[str]:
        cluster = td.REGION_CLUSTER[region]
        url = (f"https://{cluster}.api.riotgames.com"
               f"/tft/match/v1/matches/by-puuid/{puuid}/ids?count={count}")
        return await self._get(url) or []

    async def match(self, region: str, match_id: str):
        cluster = td.REGION_CLUSTER[region]
        url = f"https://{cluster}.api.riotgames.com/tft/match/v1/matches/{match_id}"
        return await self._get(url)

    @staticmethod
    def normalize(raw: dict, region: str, tier: str, node_id: str, seq: int) -> pb.MatchEvent | None:
        """Convert a raw Riot match payload into a MatchEvent proto."""
        info = raw.get("info") if raw else None
        if not info:
            return None
        # game_version looks like "Version 14.3.555.1234 ..." -> "14.3".
        patch = td.DEFAULT_PATCH
        gv = info.get("game_version", "")
        for tok in gv.replace("Version", "").split():
            parts = tok.split(".")
            if len(parts) >= 2 and parts[0].isdigit():
                patch = f"{parts[0]}.{parts[1]}"
                break

        players = []
        for p in info.get("participants", []):
            units = [
                pb.Unit(
                    character_id=u.get("character_id", ""),
                    tier=int(u.get("tier", 1)),
                    items=u.get("itemNames", u.get("items", [])) or [],
                )
                for u in p.get("units", [])
            ]
            players.append(
                pb.PlayerResult(
                    puuid=p.get("puuid", ""),
                    placement=int(p.get("placement", 8)),
                    units=units,
                    augments=p.get("augments", []) or [],
                    rounds_played=int(p.get("last_round", 0)),
                )
            )
        if not players:
            return None
        return pb.MatchEvent(
            match_id=raw.get("metadata", {}).get("match_id", ""),
            region=region,
            patch=patch,
            tier=tier,
            players=players,
            clock=pb.VectorClock(clocks={node_id: seq}),
            timestamp=int(info.get("game_datetime", time.time() * 1000)),
        )
