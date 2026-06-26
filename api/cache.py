"""A tiny thread-safe TTL cache for hot meta-store reads (60s default)."""
from __future__ import annotations

import threading
import time
from typing import Any, Callable


class TTLCache:
    def __init__(self, ttl: float = 60.0):
        self.ttl = ttl
        self._lock = threading.Lock()
        self._store: dict[Any, tuple[float, Any]] = {}

    def get_or_compute(self, key: Any, compute: Callable[[], Any]) -> Any:
        now = time.time()
        with self._lock:
            hit = self._store.get(key)
            if hit and now - hit[0] < self.ttl:
                return hit[1]
        # Compute outside the lock so a slow gRPC scan doesn't block other keys.
        value = compute()
        with self._lock:
            self._store[key] = (now, value)
        return value

    def invalidate(self):
        with self._lock:
            self._store.clear()
