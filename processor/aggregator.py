"""Stat aggregation over a stream of MatchEvents.

Accumulates per-entity placement samples keyed by
``(entity_id, entity_type, patch, tier, region)`` and, on flush, computes
win_rate (top-4 finish), average placement and play_rate, emitting StatEntry
protos. Play rate is normalized against the total number of player-boards seen
for that (patch, tier, region).
"""
from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np

from common import tft_data as td
from common.proto import pb


def composition_label(units) -> str:
    """Derive a composition id from a board's two dominant traits."""
    trait_counts: Counter[str] = Counter()
    for u in units:
        for trait in td.CHAMPION_TRAITS.get(u.character_id, []):
            trait_counts[trait] += 1
    if not trait_counts:
        return "Unknown"
    top = [t for t, _ in trait_counts.most_common(2)]
    return "_".join(sorted(top))


class StatAggregator:
    def __init__(self):
        # key -> {"placements": [...], "count": n}
        self.buffers: dict[tuple, dict] = defaultdict(lambda: {"placements": []})
        # (patch, tier, region) -> total player-boards (denominator for play_rate)
        self.totals: dict[tuple, int] = defaultdict(int)
        self.matches_seen = 0

    def _add(self, entity_id, entity_type, patch, tier, region, placement):
        self.buffers[(entity_id, entity_type, patch, tier, region)]["placements"].append(placement)

    def process_match(self, match: "pb.MatchEvent"):
        patch, tier, region = match.patch, match.tier, match.region
        for player in match.players:
            placement = player.placement
            self.totals[(patch, tier, region)] += 1

            # Champions.
            seen_items = set()
            for unit in player.units:
                self._add(unit.character_id, "champion", patch, tier, region, placement)
                for item in unit.items:
                    # Champion x item pairing (per unit) powers the heatmap.
                    self._add(f"{unit.character_id}|{item}", "champion_item",
                              patch, tier, region, placement)
                    # Plain item stats: count an item once per board.
                    if item not in seen_items:
                        seen_items.add(item)
                        self._add(item, "item", patch, tier, region, placement)
            # Augments.
            for aug in player.augments:
                self._add(aug, "augment", patch, tier, region, placement)
            # Composition (dominant trait pair).
            self._add(composition_label(player.units), "composition", patch, tier, region, placement)
        self.matches_seen += 1

    def process_batch(self, matches: list["pb.MatchEvent"]):
        for m in matches:
            self.process_match(m)

    def __len__(self):
        return self.matches_seen

    def flush(self, clock: "pb.VectorClock") -> list["pb.StatEntry"]:
        """Emit StatEntry protos for every accumulated entity and reset."""
        results: list[pb.StatEntry] = []
        for (entity_id, entity_type, patch, tier, region), data in self.buffers.items():
            arr = np.array(data["placements"], dtype=np.float64)
            if arr.size == 0:
                continue
            total = self.totals.get((patch, tier, region), arr.size)
            play_rate = float(arr.size) / float(total) if total else 0.0
            results.append(
                pb.StatEntry(
                    entity_id=entity_id,
                    entity_type=entity_type,
                    patch=patch,
                    tier=tier,
                    region=region,
                    win_rate=float((arr <= 4).mean()),
                    avg_placement=float(arr.mean()),
                    play_rate=min(play_rate, 1.0),
                    sample_size=int(arr.size),
                    clock=clock,
                )
            )
        self.buffers.clear()
        self.totals.clear()
        self.matches_seen = 0
        return results
