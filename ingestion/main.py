"""Ingestion service entry point.

Fetches (or synthesizes) TFT matches across tiers/regions, normalizes each into
a ``MatchEvent`` with a vector clock, and publishes to the broker's
``raw_matches`` topic partitioned by region_tier. Challenger/GM are processed
before lower tiers via an asyncio priority queue keyed on tier rank.
"""
from __future__ import annotations

import asyncio
import os
import random
import threading

from common import tft_data as td
from common.clients import BrokerClient
from common.metrics import Metrics, serve_metrics
from common.proto import TOPIC_PATCH_EVENTS, TOPIC_RAW_MATCHES
from .rate_limiter import RateLimiter
from .riot_client import RiotClient
from .synthetic import generate_match


def getenv(key, default=None):
    v = os.environ.get(key)
    return v if v not in (None, "") else default


class SeqCounter:
    """Thread-safe monotonically increasing vector-clock sequence."""

    def __init__(self):
        self._n = 0
        self._lock = threading.Lock()

    def next(self) -> int:
        with self._lock:
            self._n += 1
            return self._n


class Ingestor:
    def __init__(self):
        self.node_id = getenv("NODE_ID", "ingest-1")
        self.broker_addr = getenv("BROKER_ADDR", "127.0.0.1:50051")
        self.api_key = getenv("RIOT_API_KEY")
        self.regions = (getenv("REGIONS", "NA,EUW") or "").split(",")
        self.tiers = (getenv("TIERS", ",".join(td.TIERS)) or "").split(",")
        # Spread synthetic matches across recent patches (oldest -> newest).
        self.patches = [p.strip() for p in
                        (getenv("PATCHES", ",".join(td.PATCHES)) or "").split(",") if p.strip()]
        # Weight toward the latest patch so it crosses the 500-sample promotion
        # threshold while older patches still clear the 200-sample serve floor.
        self.patch_weights = [2 ** i for i in range(len(self.patches))]
        self.matches_per_task = int(getenv("MATCHES_PER_TASK", "40"))
        self.round_interval = float(getenv("ROUND_INTERVAL_SECS", "2.0"))
        self.workers = int(getenv("WORKERS", "8"))
        self.rate = int(getenv("RIOT_RATE", "20"))

        self.synthetic = not self.api_key or self.api_key.lower() in ("", "synthetic", "none")
        self.broker = BrokerClient(self.broker_addr)
        self.limiter = RateLimiter(self.rate)
        self.seq = SeqCounter()
        self.metrics = Metrics("ingestion")
        self.rng = random.Random()

    def publish_match(self, event):
        payload = event.SerializeToString()
        self.broker.publish(TOPIC_RAW_MATCHES, payload, region=event.region, tier=event.tier)
        self.metrics.inc("matches_published_total")
        self.metrics.inc(f"matches_published_{event.tier}")

    def _pick_patch(self) -> str:
        return self.rng.choices(self.patches, weights=self.patch_weights, k=1)[0]

    # ---- synthetic mode ----
    async def process_synthetic(self, region: str, tier: str):
        loop = asyncio.get_event_loop()
        for _ in range(self.matches_per_task):
            seq = self.seq.next()
            patch = self._pick_patch()
            event = generate_match(region, tier, patch, self.node_id, seq, self.rng)
            await loop.run_in_executor(None, self.publish_match, event)

    # ---- real mode ----
    async def process_real(self, client: RiotClient, region: str, tier: str):
        loop = asyncio.get_event_loop()
        puuids = await client.puuids_for_tier(region, tier, limit=10)
        for puuid in puuids:
            match_ids = await client.match_ids(region, puuid, count=20)
            for mid in match_ids[:5]:
                raw = await client.match(region, mid)
                if not raw:
                    continue
                event = RiotClient.normalize(raw, region, tier, self.node_id, self.seq.next())
                if event:
                    await loop.run_in_executor(None, self.publish_match, event)

    async def worker(self, queue: asyncio.PriorityQueue, client: RiotClient | None):
        while True:
            _, region, tier = await queue.get()
            try:
                if self.synthetic:
                    await self.process_synthetic(region, tier)
                else:
                    await self.process_real(client, region, tier)
            except Exception as exc:  # keep the worker alive on transient errors
                self.metrics.inc("errors_total")
                print(f"[ingestion] {region}/{tier} error: {exc}", flush=True)
            finally:
                queue.task_done()

    async def run(self):
        serve_metrics(self.metrics, int(getenv("METRICS_PORT", "9103")))
        self.limiter.start()
        mode = "SYNTHETIC" if self.synthetic else "RIOT-API"
        print(f"[ingestion] {self.node_id} mode={mode} set={td.SET} broker={self.broker_addr} "
              f"regions={self.regions} tiers={self.tiers} patches={self.patches}", flush=True)

        # Announce each patch (oldest -> newest) on the patch_events topic.
        for patch in self.patches:
            self.broker.publish(TOPIC_PATCH_EVENTS, patch.encode())

        queue: asyncio.PriorityQueue = asyncio.PriorityQueue()
        client_cm = None
        client = None
        if not self.synthetic:
            client_cm = RiotClient(self.api_key, self.limiter)
            client = await client_cm.__aenter__()

        workers = [asyncio.create_task(self.worker(queue, client)) for _ in range(self.workers)]
        try:
            while True:
                # Enqueue one task per (region, tier); priority = tier rank so
                # Challenger (rank 0) is served before Iron.
                for region in self.regions:
                    for tier in self.tiers:
                        priority = td.TIER_RANK.get(tier, 99)
                        queue.put_nowait((priority, region, tier))
                await queue.join()
                await asyncio.sleep(self.round_interval)
        finally:
            for w in workers:
                w.cancel()
            if client_cm:
                await client_cm.__aexit__(None, None, None)


def main():
    asyncio.run(Ingestor().run())


if __name__ == "__main__":
    main()
