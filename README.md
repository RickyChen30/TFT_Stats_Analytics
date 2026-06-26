# TFT Distributed Meta Analytics Engine

A distributed, real-time analytics system for **Teamfight Tactics**. It ingests
match data across every rank tier, processes it through a custom distributed
cluster, and serves per-tier statistics on champions, items, augments, and
compositions — plus personalized play recommendations.

Every distributed primitive (message broker, consistent-hashing ring, gossip
failure detector, LSM-tree key/value store with quorum replication) is built
from scratch in Go. No Kafka, no embedded DB, no off-the-shelf clustering.

> **Runs with zero credentials.** With no `RIOT_API_KEY`, the ingestion layer
> generates realistic synthetic matches (real **Set 17** champions, traits,
> items and augments) across several patches so the whole pipeline — including
> patch navigation — is exercisable end-to-end. Set a real key to ingest live
> data.

The Set 17 reference data is a static snapshot in `common/tft_data.py`. Refresh
it (or move to a future set) from Community Dragon + Data Dragon with:

```bash
.venv/bin/python scripts/fetch_set_data.py
```

---

## Architecture

```
                ┌────────────┐   gRPC    ┌──────────────────────┐
   Riot API ───▶│ ingestion  │──────────▶│  broker cluster (x3)  │  append-only log
  (or synth)    │  (Python)  │  publish  │  partition=region_tier│  replicated x2
                └────────────┘           └───────────┬──────────┘
                                                      │ subscribe
                                         ┌────────────▼──────────┐
                                         │   processor (Python)  │ causal reorder +
                                         │  NumPy aggregation    │ 60s/10k flush
                                         └────────────┬──────────┘
                                                      │ gRPC Write (quorum W=2)
                                         ┌────────────▼──────────┐
   anomaly  ◀── scan ──────────────────▶│ metastore cluster(x3) │ LSM-tree, WAL,
   detector ──▶ anomaly_alerts topic    │ sharded + replicated  │ bloom, quorum R/W
                                         └────────────┬──────────┘
                                                      │ gRPC Read/Scan (quorum R=2)
   dashboard ◀── REST ── FastAPI api ◀────────────────┘
   (React+D3)            (60s TTL cache)
```

| Layer | Language / Tooling |
|---|---|
| Broker, metastore, gossip, hashing | **Go** (from scratch) |
| Ingestion, aggregation, anomaly detection | **Python** |
| REST API | **Python / FastAPI** |
| Go ↔ Python transport | **gRPC + protobuf** |
| Dashboard | **React + D3.js** |
| Hot storage | **Custom LSM-tree** (Go) |
| Infra | **Docker Compose** |
| Metrics | **Prometheus + Grafana** |

### Repository layout

```
proto/        tft.proto + generated Go bindings
gen/python/   generated Python bindings
hasher/       Go: consistent-hash ring (crc32, virtual nodes, binary search)
gossip/       Go: SWIM-style UDP failure detector
broker/       Go: append-only-log message broker, partitioned + replicated
metastore/    Go: LSM-tree KV store — memtable, SSTable, WAL, bloom, LRU, quorum
common/       Python: shared proto access, gRPC clients, TFT data, metrics
ingestion/    Python: Riot API + synthetic match generators
processor/    Python: causal reorder buffer + NumPy stat aggregation
anomaly/      Python: z-score anomaly detector
api/          Python: FastAPI REST server
dashboard/    React + D3 single-page app (7 pages)
monitoring/   Prometheus config + Grafana provisioning
tests/        chaos test, benchmark, unit checks
scripts/      proto generation
```

---

## Quick start

### Docker (full stack)

```bash
cp .env.example .env          # optional; defaults to synthetic mode
make proto                    # generate gRPC bindings (required after a fresh clone)
docker compose up --build
```

> The protobuf bindings (`gen/`, `proto/*.pb.go`) are generated, not checked in,
> so run `make proto` once after cloning. It needs `protoc`, Go, and the Python
> venv (`make setup`); the Go plugins are installed automatically.

Then open:

- **Dashboard** — http://localhost:3000
- **API docs** — http://localhost:8000/docs
- **Prometheus** — http://localhost:9090
- **Grafana** — http://localhost:3002 (anonymous admin)

### Local (without Docker)

```bash
make setup          # python venv + deps
make proto          # generate Go + Python bindings
make build          # broker + metastore binaries
make test           # Go + Python unit tests
make chaos          # fault-injection test (zero data loss)
make bench          # throughput + latency benchmark
```

To run the live pipeline locally, start a broker and metastore, then the Python
services (see env vars below). The dashboard dev server: `make dashboard-dev`.

---

## How the distributed pieces work

**Consistent hashing** (`hasher/`) — 150 virtual nodes per physical node, keyed
by `crc32`, `O(log n)` lookup via binary search. `GetNodes(key, n)` walks the
ring clockwise to pick replica sets.

**Gossip / failure detection** (`gossip/`) — each node exchanges its full
membership view with 3 random peers per second over UDP. Members move
`alive → suspected (10s) → dead (20s)`. A node refutes false suspicion by
bumping its incarnation number. Death triggers re-replication. Members are keyed
by their **gRPC identity** while transported on `grpcPort + 10000`, so
`IsAlive(grpcAddr)` resolves directly.

**Broker** (`broker/`) — append-only log per `topic_region_tier` partition
(`[8B offset][4B len][payload]`), an in-memory offset→byte index for O(1) seeks,
async replication to ring-chosen replicas, and a per-consumer token bucket
capping delivery at 1000 msg/s.

**LSM-tree metastore** (`metastore/`) — write path: WAL (fsync) → memtable →
flush to L0 SSTable at 64MB → compact when L0 > 4 tables. Read path: memtable →
immutable → L0 (newest first, bloom-filtered) → L1+. Sharded by
`crc32(entity_id)`, replicated 3× with **quorum W=2 / R=2**; read conflicts
resolve by vector clock. WAL replays on restart. Superseded patches are never
deleted — they decay as `0.85^days` on read.

---

## Key invariants

- Every match event carries a **vector clock**; the processor enforces causal
  order via a reorder buffer (force-released after 30s).
- Stats with `sample_size < 200` are never served — the API returns
  `{"status": "insufficient_data"}`.
- All stats are stored and queryable independently per
  `(entity_id, patch, tier, region)`.
- Quorum is always **W=2, R=2 with N=3** replicas.
- Patch data is never hard-deleted — only decayed.
- The WAL record is written (and fsynced) **before** the memtable write.

---

## Verification

`make test` runs the Go unit tests (hash ring distribution, gossip
discovery/refutation, broker log append+recover, LSM write/read/flush/compact,
WAL crash recovery, vector-clock conflict resolution, bloom filter, patch decay)
and the Python logic checks (causal reorder, aggregation, anomaly z-score,
synthetic generation).

**Chaos test** (`make chaos`) writes 200 entries via the coordinator, kills that
coordinator, waits for gossip to declare it dead, then reads every entry back
**through a different node** — proving quorum replication preserved all data,
and that the degraded 2-of-3 cluster still serves reads and writes.

```
[chaos] 200/200 writes acknowledged quorum
[chaos] *** killing metastore-1 (the coordinator) ***
[chaos] post-kill read via metastore-3: found=200 missing=0
[chaos] PASS: zero data loss — quorum replication held
[chaos] PASS: degraded cluster still serves reads and writes
```

**Benchmark** (`make bench`) — representative single-client numbers on a laptop:

| Metric | Result |
|---|---|
| Read latency p99 | **~0.5 ms** (target < 100 ms) |
| Reads/s (quorum R=2) | ~5,000 |
| Writes/s (quorum W=2, WAL fsync) | ~90 (durability-bound) |
| Broker publish | ~10,000 msg/s |

Write throughput is intentionally fsync-bound: every write is durably logged and
quorum-replicated before acknowledgement. Concurrent clients scale it well past
the single-client figure.

---

## REST API

All endpoints accept optional `?patch=&region=&tier=&tier_range=`.

| Endpoint | Description |
|---|---|
| `GET /meta/compositions` `…/{id}` | Composition tier list / detail |
| `GET /meta/champions` `…/{id}` | Champion stats |
| `GET /meta/items` `…/{id}` | Item stats |
| `GET /meta/augments` `…/{id}` | Augment stats |
| `GET /meta/anomalies?window_hours=` | Recent win-rate spikes |
| `GET /meta/tier-comparison/{id}` | One entity's win rate across tiers |
| `GET /meta/rank-gap` | Entities that over/under-perform in high elo |
| `GET /meta/heatmap?tier=` | Champion × item win-rate matrix |
| `GET /meta/patch-history?entity_id=` | Win rate over patches |
| `GET /player/{summoner_name}?tier=` | Personalized stats vs tier average |

## Dashboard pages

Meta Tier List · Win Rate vs Play Rate (bubble) · Augment Analysis (trap
detection) · Champion × Item Heatmap · Patch Timeline · Anomaly Feed · Player
Profile.

---

## Environment variables

| Var | Used by | Meaning |
|---|---|---|
| `RIOT_API_KEY` | ingestion, api | Riot key; `synthetic` (or empty) ⇒ synthetic mode |
| `BROKER_ADDR` | ingestion, processor, anomaly | broker `host:port` |
| `METASTORE_ADDR` | processor, anomaly, api | metastore `host:port` |
| `SELF` / `PEERS` | broker, metastore | this node's gRPC addr / peer gRPC addrs |
| `NODE_ID` | all | unique node id |
| `DATA_DIR` | broker, metastore, processor | WAL / SSTable / offset directory |
| `REGIONS` / `TIERS` | ingestion, processor | partitions to cover |
| `PATCHES` | ingestion | Set patches to spread synthetic data across (navigable in the dashboard) |
| `MEMTABLE_MAX_BYTES` | metastore | flush threshold (default 64MB) |
| `FLUSH_INTERVAL_SECS` | processor | aggregate flush cadence (default 60) |
| `CHECK_INTERVAL_SECS` | anomaly | detection cadence (default 600) |
