"""Anomaly detection service.

Every CHECK_INTERVAL seconds it scans current stats from the meta store, scores
each (entity, tier) win-rate against its recent history with a z-test, and
publishes spikes to the ``anomaly_alerts`` topic. An entity spiking across most
tiers is tagged ``cross_rank``; one spiking in a subset is ``tier_specific``.
"""
from __future__ import annotations

import json
import os
import time
from collections import defaultdict

from common import tft_data as td
from common.clients import BrokerClient, MetaStoreClient
from common.metrics import Metrics, serve_metrics
from common.proto import TOPIC_ANOMALY_ALERTS
from .detector import MIN_SAMPLE_SIZE, AnomalyDetector

CROSS_RANK_FRACTION = 0.6  # spiking in >=60% of its tiers => cross-rank


def getenv(key, default=None):
    v = os.environ.get(key)
    return v if v not in (None, "") else default


class AnomalyService:
    def __init__(self):
        self.node_id = getenv("NODE_ID", "anomaly-1")
        self.metastore_addr = getenv("METASTORE_ADDR", "127.0.0.1:50052")
        self.broker_addr = getenv("BROKER_ADDR", "127.0.0.1:50051")
        self.interval = float(getenv("CHECK_INTERVAL_SECS", "600"))  # 10 minutes
        self.entity_types = ["champion", "item", "augment", "composition"]

        self.metastore = MetaStoreClient(self.metastore_addr)
        self.broker = BrokerClient(self.broker_addr)
        self.detector = AnomalyDetector(window=int(getenv("WINDOW", "48")))
        self.metrics = Metrics("anomaly")

    def _scan_all(self):
        entries = []
        for etype in self.entity_types:
            entries.extend(self.metastore.scan(entity_type=etype))
        return entries

    def run_once(self):
        entries = self._scan_all()
        self.metrics.set("entities_scanned", len(entries))

        # First pass: score every entity/tier, collect raw spikes.
        spikes = []  # (entry, z)
        # Track, per entity, which tiers had data and which spiked (for tagging).
        tiers_with_data: dict[str, set] = defaultdict(set)
        tiers_spiking: dict[str, set] = defaultdict(set)

        for e in entries:
            if e.sample_size >= MIN_SAMPLE_SIZE:
                tiers_with_data[e.entity_id].add(e.tier)
            is_anom, z = self.detector.check(e.entity_id, e.tier, e.win_rate, e.sample_size)
            if is_anom:
                spikes.append((e, z))
                tiers_spiking[e.entity_id].add(e.tier)

        # Second pass: classify and publish.
        published = 0
        for e, z in spikes:
            n_data = len(tiers_with_data[e.entity_id]) or 1
            n_spike = len(tiers_spiking[e.entity_id])
            classification = "cross_rank" if (n_spike / n_data) >= CROSS_RANK_FRACTION else "tier_specific"
            alert = {
                "entity_id": e.entity_id,
                "entity_type": e.entity_type,
                "tier": e.tier,
                "region": e.region,
                "patch": e.patch,
                "win_rate": round(e.win_rate, 4),
                "avg_placement": round(e.avg_placement, 4),
                "z_score": round(z, 3),
                "sample_size": e.sample_size,
                "classification": classification,
                "direction": "rising" if z > 0 else "falling",
                "timestamp": int(time.time() * 1000),
            }
            self.broker.publish(TOPIC_ANOMALY_ALERTS, json.dumps(alert).encode())
            published += 1

        self.metrics.inc("checks_total")
        self.metrics.inc("anomalies_published_total", published)
        self.metrics.set("last_anomaly_count", published)
        print(f"[anomaly] scanned {len(entries)} entities, published {published} alerts", flush=True)

    def run(self):
        serve_metrics(self.metrics, int(getenv("METRICS_PORT", "9105")))
        print(f"[anomaly] {self.node_id} metastore={self.metastore_addr} "
              f"interval={self.interval}s", flush=True)
        while True:
            try:
                self.run_once()
            except Exception as exc:
                self.metrics.inc("errors_total")
                print(f"[anomaly] error: {exc}", flush=True)
            time.sleep(self.interval)


def main():
    AnomalyService().run()


if __name__ == "__main__":
    main()
