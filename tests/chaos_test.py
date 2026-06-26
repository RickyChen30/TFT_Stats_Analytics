"""Chaos test: kill the coordinator meta-store node and prove that quorum
replication preserved every write (no data loss) and the cluster keeps serving.

Run:  .venv/bin/python -m tests.chaos_test
"""
from __future__ import annotations

import sys
import time

from common.clients import MetaStoreClient
from common.proto import pb
from tests.cluster import Cluster

N_KEYS = 200
GOSSIP_DEAD_WAIT = 25  # seconds for gossip to declare the killed node dead


def make_entry(i: int) -> pb.StatEntry:
    return pb.StatEntry(
        entity_id=f"champ-{i}", entity_type="champion", patch="14.3",
        region="NA", tier="CHALLENGER", win_rate=0.5 + (i % 10) / 100.0,
        avg_placement=4.0, play_rate=0.2, sample_size=300 + i,
        clock=pb.VectorClock(clocks={"writer": i + 1}),
    )


def read_all(client: MetaStoreClient) -> tuple[int, int]:
    found = missing = 0
    for i in range(N_KEYS):
        e = client.read(f"champ-{i}", patch="14.3", tier="CHALLENGER", region="NA")
        if e and e.sample_size == 300 + i:
            found += 1
        else:
            missing += 1
    return found, missing


def main() -> int:
    cluster = Cluster(n_brokers=1, n_metastores=3)
    print(f"[chaos] starting cluster in {cluster.base_dir}")
    cluster.start()
    ok = True
    try:
        coord = MetaStoreClient(cluster.metastore(0).addr)   # metastore-1 (coordinator)
        survivor = MetaStoreClient(cluster.metastore(2).addr)  # metastore-3

        print(f"[chaos] writing {N_KEYS} entries via {cluster.metastore(0).name} (W=2, N=3)…")
        acked = sum(1 for i in range(N_KEYS) if coord.write(make_entry(i)))
        print(f"[chaos]   {acked}/{N_KEYS} writes acknowledged quorum")
        assert acked == N_KEYS, "some writes failed to reach quorum"

        found, missing = read_all(coord)
        print(f"[chaos] pre-kill read via coordinator: found={found} missing={missing}")
        assert missing == 0, "data missing before any failure"

        # --- inject failure: kill the coordinator that received every write ---
        print(f"[chaos] *** killing {cluster.metastore(0).name} (the coordinator) ***")
        cluster.metastore(0).kill()
        print(f"[chaos] waiting {GOSSIP_DEAD_WAIT}s for gossip to detect the death…")
        time.sleep(GOSSIP_DEAD_WAIT)

        # Reads now go through a *different* node; data is only present if it was
        # actually replicated by the quorum write.
        t0 = time.time()
        found, missing = read_all(survivor)
        dt = time.time() - t0
        print(f"[chaos] post-kill read via {cluster.metastore(2).name}: "
              f"found={found} missing={missing} ({dt:.1f}s)")
        if missing != 0:
            print(f"[chaos] FAIL: {missing} entries lost after node death")
            ok = False
        else:
            print("[chaos] PASS: zero data loss — quorum replication held")

        # Cluster still accepts new writes with one node down (2 of 3 alive).
        print("[chaos] verifying writes still succeed with one node down…")
        new_ok = sum(1 for i in range(N_KEYS, N_KEYS + 50) if survivor.write(make_entry(i)))
        readback = sum(
            1 for i in range(N_KEYS, N_KEYS + 50)
            if (e := survivor.read(f"champ-{i}", patch="14.3", tier="CHALLENGER", region="NA"))
            and e.sample_size == 300 + i
        )
        print(f"[chaos]   new writes acked={new_ok}/50, read back={readback}/50")
        if new_ok != 50 or readback != 50:
            ok = False
            print("[chaos] FAIL: degraded cluster could not serve writes")
        else:
            print("[chaos] PASS: degraded cluster still serves reads and writes")
    finally:
        cluster.stop()

    print("[chaos] RESULT:", "ALL CHECKS PASSED" if ok else "FAILURES DETECTED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
