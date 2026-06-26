"""Benchmark: meta-store write throughput, read latency (p50/p99/p999), and
broker publish throughput against a live 3-node cluster.

Target: query p99 < 100ms.

Run:  .venv/bin/python -m tests.benchmark
"""
from __future__ import annotations

import sys
import time

from common.clients import BrokerClient, MetaStoreClient
from common.proto import TOPIC_RAW_MATCHES, pb
from tests.cluster import Cluster

WRITES = 2000
READS = 2000
PUBLISHES = 2000
P99_TARGET_MS = 100.0


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = min(len(s) - 1, int(round((pct / 100.0) * (len(s) - 1))))
    return s[k]


def entry(i: int) -> pb.StatEntry:
    return pb.StatEntry(
        entity_id=f"bench-{i}", entity_type="champion", patch="14.3", region="NA",
        tier="GOLD", win_rate=0.5, avg_placement=4.3, play_rate=0.2,
        sample_size=300 + i, clock=pb.VectorClock(clocks={"bench": i + 1}),
    )


def main() -> int:
    cluster = Cluster(n_brokers=1, n_metastores=3)
    print(f"[bench] starting cluster in {cluster.base_dir}")
    cluster.start()
    passed = True
    try:
        ms = MetaStoreClient(cluster.metastore(0).addr)
        broker = BrokerClient(cluster.broker(0).addr)

        # --- write throughput (quorum W=2, N=3) ---
        t0 = time.time()
        for i in range(WRITES):
            ms.write(entry(i))
        wdt = time.time() - t0
        print(f"[bench] meta-store writes: {WRITES} in {wdt:.2f}s = {WRITES / wdt:,.0f} writes/s (quorum)")

        # --- read latency (quorum R=2) ---
        latencies = []
        for i in range(READS):
            k = i % WRITES
            t = time.perf_counter()
            ms.read(f"bench-{k}", patch="14.3", tier="GOLD", region="NA")
            latencies.append((time.perf_counter() - t) * 1000.0)
        p50 = percentile(latencies, 50)
        p99 = percentile(latencies, 99)
        p999 = percentile(latencies, 99.9)
        rps = READS / (sum(latencies) / 1000.0)
        print(f"[bench] meta-store reads: {READS} · {rps:,.0f} reads/s")
        print(f"[bench]   latency p50={p50:.2f}ms  p99={p99:.2f}ms  p99.9={p999:.2f}ms")
        if p99 < P99_TARGET_MS:
            print(f"[bench]   PASS: p99 {p99:.2f}ms < {P99_TARGET_MS:.0f}ms target")
        else:
            print(f"[bench]   WARN: p99 {p99:.2f}ms exceeds {P99_TARGET_MS:.0f}ms target")
            passed = False

        # --- broker publish throughput ---
        payload = entry(0).SerializeToString()
        t0 = time.time()
        for _ in range(PUBLISHES):
            broker.publish(TOPIC_RAW_MATCHES, payload, region="NA", tier="GOLD")
        pdt = time.time() - t0
        print(f"[bench] broker publishes: {PUBLISHES} in {pdt:.2f}s = {PUBLISHES / pdt:,.0f} msgs/s")
    finally:
        cluster.stop()

    print("[bench] RESULT:", "TARGETS MET" if passed else "SOME TARGETS MISSED")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
