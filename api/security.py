"""Security hardening for the public REST API.

This module centralises every defensive control the API applies to untrusted
input:

* **Rate limiting** — a per-IP sliding-window limiter with a tighter bucket for
  the expensive, Riot-backed player endpoints, plus a global daily cap that
  protects the shared Riot API-key budget from being exhausted (accidentally or
  maliciously).
* **Input validation** — length caps, control-character / NUL rejection, and
  path-traversal / URL-scheme guards on every query and path parameter, with a
  stricter validator for Riot ids. This is what stops hostile payloads (e.g.
  attempts to smuggle a URL, traversal sequence, or huge blob through a
  parameter) from ever reaching the data or networking layers.
* **Numeric clamping** — `limit`/`count`/`window` are forced into sane ranges so
  a caller can't ask for an unbounded amount of work.
* **Security headers** — added to every response.

Everything is dependency-free (stdlib + FastAPI) and configurable via env vars.
"""
from __future__ import annotations

import os
import re
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


# ---- tunables (env-overridable) ----
MAX_PARAM_LEN = _int_env("MAX_PARAM_LEN", 120)          # any single query/path param
RATE_PER_MIN = _int_env("RATE_LIMIT_PER_MIN", 120)       # all endpoints, per IP / 60s
PLAYER_RATE_PER_MIN = _int_env("PLAYER_RATE_PER_MIN", 12)  # Riot-backed lookups, per IP / 60s
RIOT_DAILY_CAP = _int_env("RIOT_DAILY_CAP", 20000)       # global guard on the Riot key budget
MAX_LIMIT = _int_env("MAX_LIMIT", 500)                   # cap on list `limit`
MAX_MATCH_COUNT = _int_env("MAX_MATCH_COUNT", 20)        # cap on match `count`

# Riot-backed paths get the stricter per-IP bucket + the daily cap.
_RIOT_PATHS = ("/player/", "/players/suggest")

_CTRL = re.compile(r"[\x00-\x1f\x7f]")
# A Riot id is "GameName#TAG"; name 1-30 (letters/digits/space/._-), tag 1-10 alnum.
_RIOT_ID = re.compile(r"^[\w .\-]{1,30}(?:#[A-Za-z0-9]{1,10})?$", re.UNICODE)


# --------------------------------------------------------------------------- #
# Rate limiting
# --------------------------------------------------------------------------- #
class _SlidingWindow:
    """In-memory per-key sliding-window counter. Thread-safe, self-pruning."""

    def __init__(self):
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window: float = 60.0) -> tuple[bool, int]:
        now = time.monotonic()
        cutoff = now - window
        with self._lock:
            dq = self._hits[key]
            while dq and dq[0] < cutoff:
                dq.popleft()
            if len(dq) >= limit:
                retry = int(window - (now - dq[0])) + 1
                return False, max(1, retry)
            dq.append(now)
            # Opportunistic prune so idle IPs don't accumulate forever.
            if len(self._hits) > 4096:
                for k in [k for k, v in self._hits.items() if not v]:
                    del self._hits[k]
            return True, 0


class _DailyCap:
    """Global counter that resets at UTC midnight — protects the Riot key budget."""

    def __init__(self, cap: int):
        self.cap = cap
        self._day = -1
        self._count = 0
        self._lock = threading.Lock()

    def allow(self) -> bool:
        day = time.gmtime().tm_yday
        with self._lock:
            if day != self._day:
                self._day, self._count = day, 0
            if self._count >= self.cap:
                return False
            self._count += 1
            return True


_global_rl = _SlidingWindow()
_player_rl = _SlidingWindow()
_riot_daily = _DailyCap(RIOT_DAILY_CAP)


def _client_ip(request: Request) -> str:
    # Trust the first hop of X-Forwarded-For only if present (set by a proxy),
    # else the socket peer. Truncated so a spoofed header can't blow up memory.
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "unknown")[:64]


async def rate_limit_middleware(request: Request, call_next):
    """Per-IP rate limiting + global Riot-budget cap, applied before routing.

    Each limit is independently disabled by setting it to 0 (or below): the global
    per-IP limit via RATE_LIMIT_PER_MIN, the player-endpoint limit via
    PLAYER_RATE_PER_MIN, and the daily Riot-budget cap via RIOT_DAILY_CAP. Input
    validation and the security headers below always apply.
    """
    path = request.url.path
    ip = _client_ip(request)
    is_riot = any(path.startswith(p) for p in _RIOT_PATHS)

    ok, retry = True, 0
    if RATE_PER_MIN > 0:
        ok, retry = _global_rl.allow(f"g:{ip}", RATE_PER_MIN)
    if ok and is_riot and PLAYER_RATE_PER_MIN > 0:
        ok, retry = _player_rl.allow(f"p:{ip}", PLAYER_RATE_PER_MIN)
    if not ok:
        return JSONResponse(
            {"status": "rate_limited",
             "message": "Too many requests. Slow down and retry shortly."},
            status_code=429, headers={"Retry-After": str(retry)},
        )

    # The player lookup actually spends Riot quota; guard the shared budget.
    if path.startswith("/player/") and RIOT_DAILY_CAP > 0 and not _riot_daily.allow():
        return JSONResponse(
            {"status": "unavailable",
             "message": "Daily player-lookup capacity reached. Try again tomorrow."},
            status_code=503,
        )

    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Cache-Control", "no-store")
    return response


# --------------------------------------------------------------------------- #
# Input validation
# --------------------------------------------------------------------------- #
def clean_param(value: str | None, *, field: str = "parameter") -> str:
    """Reject obviously hostile input: over-long, control chars/NUL, traversal
    or embedded URL scheme. Returns the stripped value (may be empty)."""
    if value is None:
        return ""
    if len(value) > MAX_PARAM_LEN:
        raise HTTPException(422, f"{field} too long")
    if _CTRL.search(value):
        raise HTTPException(422, f"{field} contains invalid characters")
    low = value.lower()
    if ".." in value or "://" in low:
        raise HTTPException(422, f"{field} is malformed")
    return value.strip()


def validate_riot_id(raw: str | None) -> str:
    """Validate a 'GameName#TAG' Riot id (tag optional — surfaced downstream)."""
    val = clean_param(raw, field="riot id")
    if not val:
        raise HTTPException(422, "riot id is required")
    if not _RIOT_ID.match(val):
        raise HTTPException(422, "invalid Riot id format")
    return val


def clamp(value: int, lo: int, hi: int) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError):
        return lo
    return max(lo, min(hi, v))
