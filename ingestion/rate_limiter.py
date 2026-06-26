"""Token-bucket rate limiter shared across ingestion workers."""
from __future__ import annotations

import asyncio


class RateLimiter:
    """Allows up to ``rate`` acquisitions per second, refilled once per second.

    A single instance is shared by all workers so the process as a whole stays
    within Riot's per-key request budget.
    """

    def __init__(self, rate: int = 20):
        self.tokens = rate
        self.rate = rate
        self.lock = asyncio.Lock()
        self._refill_task: asyncio.Task | None = None

    async def acquire(self):
        while True:
            async with self.lock:
                if self.tokens > 0:
                    self.tokens -= 1
                    return
            await asyncio.sleep(0.05)

    async def _refill_loop(self):
        while True:
            await asyncio.sleep(1)
            async with self.lock:
                self.tokens = self.rate

    def start(self):
        if self._refill_task is None:
            self._refill_task = asyncio.create_task(self._refill_loop())
