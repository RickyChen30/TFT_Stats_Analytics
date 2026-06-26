"""Z-score anomaly detection over a rolling window of win-rate observations."""
from __future__ import annotations

from collections import defaultdict, deque

import numpy as np

MIN_SAMPLE_SIZE = 200   # ignore entities without enough matches
MIN_HISTORY = 6         # need this many observations before scoring
Z_THRESHOLD = 2.0


class AnomalyDetector:
    def __init__(self, window: int = 48):
        # (entity_id, tier) -> deque of recent win_rate observations
        self.history: dict[tuple, deque] = defaultdict(lambda: deque(maxlen=window))

    def check(self, entity_id: str, tier: str, current_win_rate: float, sample_size: int):
        """Return (is_anomaly, z_score). Records the observation either way."""
        if sample_size < MIN_SAMPLE_SIZE:
            return False, 0.0
        key = (entity_id, tier)
        hist = list(self.history[key])
        if len(hist) < MIN_HISTORY:
            self.history[key].append(current_win_rate)
            return False, 0.0
        mean = float(np.mean(hist))
        std = float(np.std(hist))
        self.history[key].append(current_win_rate)
        if std == 0:
            return False, 0.0
        z = (current_win_rate - mean) / std
        return z > Z_THRESHOLD, z
