"""Causal reorder buffer for MatchEvents.

Events carry a vector clock ``{node_id: seq}``. An event is causally ready once
every node component is no greater than that node's delivered watermark + 1
(i.e. no prior event from the same node is still missing). Out-of-order events
are held in a min-heap keyed by total clock value and force-released after a
timeout so a permanently missing predecessor cannot stall the stream forever.
"""
from __future__ import annotations

import heapq
import time
from collections import defaultdict


def _vc_sum(event) -> int:
    return sum(event.clock.clocks.values())


class ReorderBuffer:
    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout
        self._heap: list[tuple] = []  # (vc_sum, counter, arrival_ts, event)
        self._counter = 0
        self.delivered: dict[str, int] = defaultdict(int)  # node -> last contiguous seq
        self.forced = 0

    def push(self, event):
        heapq.heappush(self._heap, (_vc_sum(event), self._counter, time.time(), event))
        self._counter += 1

    def _is_ready(self, event) -> bool:
        for node, seq in event.clock.clocks.items():
            if seq > self.delivered[node] + 1:
                return False
        return True

    def _deliver(self, event):
        for node, seq in event.clock.clocks.items():
            if seq > self.delivered[node]:
                self.delivered[node] = seq

    def pop_ready(self) -> list:
        """Return all events now deliverable, in causal (clock) order.

        Delivering one event can unblock others (watermark advances), so we scan
        repeatedly until the set stabilizes.
        """
        out = []
        now = time.time()
        progressed = True
        while progressed and self._heap:
            progressed = False
            keep: list[tuple] = []
            for item in self._heap:
                _, _, arrival, event = item
                if self._is_ready(event):
                    self._deliver(event)
                    out.append(event)
                    progressed = True
                elif now - arrival >= self.timeout:
                    self._deliver(event)
                    out.append(event)
                    self.forced += 1
                    progressed = True
                else:
                    keep.append(item)
            self._heap = keep
        heapq.heapify(self._heap)
        out.sort(key=_vc_sum)
        return out

    def __len__(self):
        return len(self._heap)
