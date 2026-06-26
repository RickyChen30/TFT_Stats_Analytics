"""Stream processor entry point.

Subscribes to every ``raw_matches`` region_tier partition, reorders events into
causal order, aggregates per-entity statistics with NumPy, and flushes StatEntry
protos to the meta store every 60 seconds or every 10K matches — whichever comes
first. Consumer offsets are persisted to a local file per partition.
"""
from __future__ import annotations

import os
import queue
import threading
import time

from common import tft_data as td
from common.clients import BrokerClient, MetaStoreClient
from common.metrics import Metrics, serve_metrics
from common.proto import TOPIC_RAW_MATCHES, pb
from .aggregator import StatAggregator
from .reorder import ReorderBuffer

def getenv(key, default=None):
    v = os.environ.get(key)
    return v if v not in (None, "") else default


FLUSH_INTERVAL_SECS = float(getenv("FLUSH_INTERVAL_SECS", "60"))
FLUSH_MATCH_THRESHOLD = int(getenv("FLUSH_MATCH_THRESHOLD", "10000"))


class OffsetStore:
    """Persists per-partition consumer offsets to a local directory."""

    def __init__(self, directory: str):
        self.dir = directory
        os.makedirs(self.dir, exist_ok=True)

    def _path(self, partition: str) -> str:
        safe = partition.replace("/", "_")
        return os.path.join(self.dir, f"{safe}.offset")

    def load(self, partition: str) -> int:
        try:
            with open(self._path(partition)) as f:
                return int(f.read().strip())
        except (FileNotFoundError, ValueError):
            return 0

    def save(self, partition: str, offset: int):
        tmp = self._path(partition) + ".tmp"
        with open(tmp, "w") as f:
            f.write(str(offset))
        os.replace(tmp, self._path(partition))


class Processor:
    def __init__(self):
        self.node_id = getenv("NODE_ID", "processor-1")
        self.broker_addr = getenv("BROKER_ADDR", "127.0.0.1:50051")
        self.metastore_addr = getenv("METASTORE_ADDR", "127.0.0.1:50052")
        self.regions = (getenv("REGIONS", "NA,EUW") or "").split(",")
        self.tiers = (getenv("TIERS", ",".join(td.TIERS)) or "").split(",")
        self.data_dir = getenv("DATA_DIR", f"./data/{self.node_id}")

        self.broker = BrokerClient(self.broker_addr)
        self.metastore = MetaStoreClient(self.metastore_addr)
        self.offsets = OffsetStore(os.path.join(self.data_dir, "offsets"))

        self.incoming: queue.Queue = queue.Queue(maxsize=50_000)
        self.reorder = ReorderBuffer(timeout=30.0)
        self.aggregator = StatAggregator()
        self.metrics = Metrics("processor")

        self.merged_clock: dict[str, int] = {}
        self.flush_seq = 0
        self._stop = threading.Event()

    # ---- subscriber threads ----
    def _subscribe_partition(self, region: str, tier: str):
        partition = f"{TOPIC_RAW_MATCHES}/{region}/{tier}"
        broker = BrokerClient(self.broker_addr)  # own channel per thread
        while not self._stop.is_set():
            start = self.offsets.load(partition)
            try:
                last_saved = start
                for offset, payload in broker.subscribe(
                    TOPIC_RAW_MATCHES, self.node_id, offset=start, region=region, tier=tier
                ):
                    event = pb.MatchEvent()
                    event.ParseFromString(payload)
                    self.incoming.put((partition, offset, event))
                    # Persist the offset periodically (every 50 messages).
                    if offset - last_saved >= 50:
                        self.offsets.save(partition, offset + 1)
                        last_saved = offset
                    if self._stop.is_set():
                        break
            except Exception as exc:
                self.metrics.inc("subscribe_errors_total")
                print(f"[processor] subscribe {partition} error: {exc}", flush=True)
                time.sleep(2)

    # ---- aggregation / flush ----
    def _merge_clock(self, event):
        for node, seq in event.clock.clocks.items():
            if seq > self.merged_clock.get(node, 0):
                self.merged_clock[node] = seq

    def _maybe_flush(self, last_flush: float) -> float:
        due = (time.time() - last_flush) >= FLUSH_INTERVAL_SECS
        big = len(self.aggregator) >= FLUSH_MATCH_THRESHOLD
        if not (due or big):
            return last_flush
        return self._flush()

    def _flush(self) -> float:
        if len(self.aggregator) == 0:
            return time.time()
        self.flush_seq += 1
        clock = pb.VectorClock(clocks={**self.merged_clock, self.node_id: self.flush_seq})
        entries = self.aggregator.flush(clock)
        written = 0
        for entry in entries:
            try:
                if self.metastore.write(entry):
                    written += 1
            except Exception as exc:
                self.metrics.inc("write_errors_total")
                print(f"[processor] write error: {exc}", flush=True)
        self.metrics.inc("flushes_total")
        self.metrics.inc("entries_written_total", written)
        self.metrics.set("last_flush_entries", written)
        print(f"[processor] flushed {written} stat entries (clock seq={self.flush_seq})", flush=True)
        return time.time()

    def run(self):
        serve_metrics(self.metrics, int(getenv("METRICS_PORT", "9104")))
        print(f"[processor] {self.node_id} broker={self.broker_addr} "
              f"metastore={self.metastore_addr} partitions={len(self.regions)*len(self.tiers)}",
              flush=True)

        for region in self.regions:
            for tier in self.tiers:
                t = threading.Thread(target=self._subscribe_partition, args=(region, tier), daemon=True)
                t.start()

        last_flush = time.time()
        while not self._stop.is_set():
            drained = 0
            try:
                while drained < 5000:
                    partition, offset, event = self.incoming.get(timeout=0.5)
                    self._merge_clock(event)
                    self.reorder.push(event)
                    drained += 1
            except queue.Empty:
                pass

            ready = self.reorder.pop_ready()
            if ready:
                self.aggregator.process_batch(ready)
                self.metrics.inc("matches_processed_total", len(ready))
            self.metrics.set("reorder_buffer_size", len(self.reorder))
            last_flush = self._maybe_flush(last_flush)


def main():
    Processor().run()


if __name__ == "__main__":
    main()
