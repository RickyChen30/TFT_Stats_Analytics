"""Synthetic TFT match generator.

When no Riot API key is configured the system runs in synthetic mode: this
module fabricates realistic ``MatchEvent`` protos so the whole pipeline
(processor -> metastore -> API -> dashboard) is exercisable end-to-end.

The generator bakes in deliberate signal so the analytics have something to
find: higher-cost champions place better, one augment is a "trap" (looks
played, places poorly), and a couple of units are stronger in high tiers than
low tiers (creating a rank gap).
"""
from __future__ import annotations

import hashlib
import random
import time
import uuid

from common import tft_data as td
from common.proto import pb

# Units that overperform specifically in high-elo lobbies (rank-gap signal),
# and one augment that looks played but underperforms (trap). Data-driven so it
# tracks whatever set common/tft_data.py is snapshotted to.
_HIGH_ELO_FAVORITES = set(td.HIGH_ELO_FAVORITES)
_HIGH_TIERS = {"DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"}
_TRAP_AUGMENT = td.TRAP_AUGMENT


def _comp_strength(comp_id: str) -> float:
    """Stable per-comp placement offset (lower => stronger) so the comp tier
    list has a real S→D spread instead of every comp performing the same."""
    h = int(hashlib.md5(comp_id.encode()).hexdigest()[:8], 16)
    return (h % 100) / 100.0 * 0.32 - 0.16  # deterministic in [-0.16, +0.16]


def _placement_bias(units: list[str], augments: list[str], tier: str,
                    comp_id: str = "") -> float:
    """Return a strength score; lower => better (1st place) placement."""
    score = _comp_strength(comp_id) if comp_id else 0.0
    for u in units:
        cost = td.CHAMPION_COST.get(u, 2)
        score -= cost * 0.04  # expensive boards trend stronger
        if u in _HIGH_ELO_FAVORITES and tier in _HIGH_TIERS:
            score -= 0.08
    if _TRAP_AUGMENT in augments:
        score += 0.10  # trap augment drags placement down
    return score


def _comp_board(rng: random.Random) -> tuple[list[str], list[pb.Unit], str]:
    """Build a coherent board from a named comp: the carry is itemized, the rest
    round out the combination. The comp id is returned so the board can be scored
    and labelled by its carry (TFT Academy style) rather than by trait pair."""
    comp = rng.choice(td.COMPS)
    carry = comp.get("carry")
    unit_ids = comp["units"]
    units = []
    for cid in unit_ids:
        if cid == carry:
            n_items = rng.choice([2, 3])                       # the carry holds items
        elif carry is None:
            n_items = rng.choices([0, 1], weights=[60, 40])[0]  # Fast 9: no single carry
        else:
            n_items = rng.choices([0, 1], weights=[75, 25])[0]
        items = rng.sample(td.ITEMS, n_items) if n_items else []
        units.append(pb.Unit(character_id=cid, tier=rng.randint(1, 3), items=items))
    return unit_ids, units, comp["id"]


def generate_match(region: str, tier: str, patch: str, node_id: str,
                   seq: int, rng: random.Random | None = None) -> pb.MatchEvent:
    rng = rng or random.Random()
    match_id = f"{region}_{uuid.uuid4().hex[:12]}"

    # Build 8 players, score them, then rank into placements 1..8.
    scored = []
    for _ in range(8):
        chosen, units, comp_id = _comp_board(rng)
        augments = rng.sample(td.AUGMENTS, rng.randint(2, 3))
        strength = _placement_bias(chosen, augments, tier, comp_id) + rng.gauss(0, 0.12)
        scored.append((strength, units, augments))

    scored.sort(key=lambda t: t[0])  # strongest (lowest score) first
    players = []
    for placement, (_, units, augments) in enumerate(scored, start=1):
        players.append(
            pb.PlayerResult(
                puuid=f"puuid_{uuid.uuid4().hex[:16]}",
                placement=placement,
                units=units,
                augments=augments,
                rounds_played=rng.randint(28, 42),
            )
        )

    return pb.MatchEvent(
        match_id=match_id,
        region=region,
        patch=patch,
        tier=tier,
        players=players,
        clock=pb.VectorClock(clocks={node_id: seq}),
        timestamp=int(time.time() * 1000),
    )
