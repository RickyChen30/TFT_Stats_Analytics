"""Fast, dependency-light unit checks for the Python pipeline logic (no servers).

Run:  .venv/bin/python tests/unit_checks.py
"""
from __future__ import annotations

import os
import sys
import time

# Allow running both as `python -m tests.unit_checks` and `python tests/unit_checks.py`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from anomaly.detector import AnomalyDetector
from common.proto import pb
from ingestion.synthetic import generate_match
from processor.aggregator import StatAggregator, composition_label
from processor.reorder import ReorderBuffer


def _ev(node, seq):
    e = pb.MatchEvent(match_id=f"{node}-{seq}", region="NA", tier="GOLD", patch="14.3")
    e.clock.clocks[node] = seq
    return e


def check_reorder():
    rb = ReorderBuffer(timeout=30)
    for seq in [3, 1, 2, 5, 4]:
        rb.push(_ev("n1", seq))
    order = [int(e.match_id.split("-")[1]) for e in rb.pop_ready()]
    assert order == [1, 2, 3, 4, 5], order

    gap = ReorderBuffer(timeout=30)
    for seq in [1, 2, 4]:
        gap.push(_ev("n1", seq))
    assert [int(e.match_id.split("-")[1]) for e in gap.pop_ready()] == [1, 2]
    gap.push(_ev("n1", 3))
    assert [int(e.match_id.split("-")[1]) for e in gap.pop_ready()] == [3, 4]

    forced = ReorderBuffer(timeout=0.01)
    forced.push(_ev("n1", 5))
    time.sleep(0.05)
    assert [int(e.match_id.split("-")[1]) for e in forced.pop_ready()] == [5]
    assert forced.forced == 1
    print("OK  reorder buffer: in-order, gap-hold, gap-fill, force-release")


def check_aggregator():
    agg = StatAggregator()
    m = pb.MatchEvent(match_id="m1", region="NA", tier="GOLD", patch="14.3")
    for placement in range(1, 9):
        pr = m.players.add()
        pr.placement = placement
        u = pr.units.add()
        u.character_id = "TFT_Ahri"
        u.items.append("TFT_Item_BlueBuff")
        pr.augments.append("TFT_Augment_TrueTwos")
    agg.process_match(m)
    entries = agg.flush(pb.VectorClock(clocks={"proc": 1}))
    champ = next(e for e in entries if e.entity_type == "champion" and e.entity_id == "TFT_Ahri")
    assert abs(champ.win_rate - 0.5) < 1e-9, champ.win_rate
    assert abs(champ.avg_placement - 4.5) < 1e-9, champ.avg_placement
    assert champ.sample_size == 8
    assert any(e.entity_type == "champion_item" for e in entries)
    print("OK  aggregator: win_rate, avg_placement, champion_item pairs")


def check_detector():
    d = AnomalyDetector(window=48)
    assert d.check("TFT_Ahri", "GOLD", 0.9, 100) == (False, 0.0)  # below sample floor
    for _ in range(8):
        d.check("TFT_Ahri", "GOLD", 0.50 + (_ % 2) * 0.01, 300)
    anom, z = d.check("TFT_Ahri", "GOLD", 0.70, 300)
    assert anom and z > 2.0, (anom, z)
    print("OK  anomaly detector: z-score spike detection")


def check_synthetic():
    ev = generate_match("NA", "CHALLENGER", "14.3", "ingest-1", 1)
    assert len(ev.players) == 8
    assert {p.placement for p in ev.players} == set(range(1, 9))
    assert ev.clock.clocks["ingest-1"] == 1
    assert composition_label(ev.players[0].units)  # non-empty label
    print("OK  synthetic generator: 8 ranked players, vector clock, comp label")


def main():
    check_reorder()
    check_aggregator()
    check_detector()
    check_synthetic()
    print("\nALL PYTHON UNIT CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
