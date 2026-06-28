"""FastAPI REST server for TFT meta analytics.

All reads go through the meta store via gRPC (behind a 60s TTL cache). Every
endpoint accepts optional ``patch``, ``region``, ``tier`` and ``tier_range``
filters. Stats below the minimum sample size are withheld as
``{"status": "insufficient_data"}``.
"""
from __future__ import annotations

import os

from fastapi import FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse

from common import tft_data as td
from . import security as sec
from .service import Service

app = FastAPI(title="TFT Distributed Meta Analytics", version="1.0.0")

# Middleware registration order matters: Starlette applies the LAST-added
# middleware as the OUTERMOST layer. We register the rate limiter first and CORS
# last so CORS wraps everything — otherwise a rate-limited (429) or capped (503)
# response returned early by the rate limiter would skip CORSMiddleware and reach
# the browser without an Access-Control-Allow-Origin header, which the browser
# rejects as an opaque "Failed to fetch" instead of a clean error the UI can show.

# Per-IP rate limiting, global Riot-budget cap, and security headers (inner).
app.middleware("http")(sec.rate_limit_middleware)

# CORS (outermost): read-only API, so only GET is ever needed. Origins are
# restricted to the dashboard (override via ALLOWED_ORIGINS="https://a.com,...").
_origins = [o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS",
    "http://localhost:8080,http://localhost:3000,http://localhost:5173",
).split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["GET"],
    allow_headers=["X-Riot-Key", "Content-Type"],
)

svc = Service()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/metrics", response_class=PlainTextResponse)
def metrics():
    n = len(svc.get_anomalies(window_hours=24))
    return f"# TYPE api_recent_anomalies gauge\napi_recent_anomalies {n}\n"


# ---- compositions ----
def _filters(patch: str, region: str, tier: str, tier_range: str):
    """Validate the shared filter params once."""
    return (
        sec.clean_param(patch, field="patch"),
        sec.clean_param(region, field="region"),
        sec.clean_param(tier, field="tier") or None,
        sec.clean_param(tier_range, field="tier_range") or None,
    )


@app.get("/meta/compositions")
def get_compositions(patch: str = "", region: str = "", tier: str = "",
                     tier_range: str = "", limit: int = 20):
    p, r, t, tr = _filters(patch, region, tier, tier_range)
    return svc.list_entities("composition", patch=p, region=r,
                             tier=t, tier_range=tr, limit=sec.clamp(limit, 1, sec.MAX_LIMIT))


@app.get("/meta/compositions/{entity_id}")
def get_composition(entity_id: str, patch: str = "", tier: str = "", region: str = ""):
    p, r, t, _ = _filters(patch, region, tier, "")
    return svc.get_entity("composition", sec.clean_param(entity_id, field="entity_id"),
                          patch=p, tier=t, region=r)


# ---- champions ----
@app.get("/meta/champions")
def get_champions(patch: str = "", region: str = "", tier: str = "",
                  tier_range: str = "", limit: int = 20):
    p, r, t, tr = _filters(patch, region, tier, tier_range)
    return svc.list_entities("champion", patch=p, region=r,
                             tier=t, tier_range=tr, limit=sec.clamp(limit, 1, sec.MAX_LIMIT))


@app.get("/meta/champions/{entity_id}")
def get_champion(entity_id: str, patch: str = "", tier: str = "", region: str = ""):
    p, r, t, _ = _filters(patch, region, tier, "")
    return svc.get_entity("champion", sec.clean_param(entity_id, field="entity_id"),
                          patch=p, tier=t, region=r)


# ---- items ----
@app.get("/meta/items")
def get_items(patch: str = "", region: str = "", tier: str = "",
              tier_range: str = "", limit: int = 20):
    p, r, t, tr = _filters(patch, region, tier, tier_range)
    return svc.list_entities("item", patch=p, region=r,
                             tier=t, tier_range=tr, limit=sec.clamp(limit, 1, sec.MAX_LIMIT))


@app.get("/meta/items/{entity_id}")
def get_item(entity_id: str, patch: str = "", tier: str = "", region: str = ""):
    p, r, t, _ = _filters(patch, region, tier, "")
    return svc.get_entity("item", sec.clean_param(entity_id, field="entity_id"),
                          patch=p, tier=t, region=r)


# ---- augments ----
@app.get("/meta/augments")
def get_augments(patch: str = "", region: str = "", tier: str = "",
                 tier_range: str = "", category: str = "", limit: int = 500):
    p, r, t, tr = _filters(patch, region, tier, tier_range)
    return svc.list_entities("augment", patch=p, region=r,
                             tier=t, tier_range=tr,
                             augment_category=sec.clean_param(category, field="category") or None,
                             limit=sec.clamp(limit, 1, sec.MAX_LIMIT))


@app.get("/meta/augments/{entity_id}")
def get_augment(entity_id: str, patch: str = "", tier: str = "", region: str = ""):
    p, r, t, _ = _filters(patch, region, tier, "")
    return svc.get_entity("augment", sec.clean_param(entity_id, field="entity_id"),
                          patch=p, tier=t, region=r)


# ---- analytics ----
@app.get("/meta/anomalies")
def get_anomalies(window_hours: int = 24):
    return svc.get_anomalies(window_hours=sec.clamp(window_hours, 1, 720))


@app.get("/meta/tier-comparison/{entity_id}")
def tier_comparison(entity_id: str, patch: str = ""):
    return svc.tier_comparison(sec.clean_param(entity_id, field="entity_id"),
                               patch=sec.clean_param(patch, field="patch"))


@app.get("/meta/rank-gap")
def rank_gap(patch: str = "", entity_type: str = "champion", limit: int = 20):
    return svc.rank_gap(entity_type=sec.clean_param(entity_type, field="entity_type"),
                        patch=sec.clean_param(patch, field="patch"),
                        limit=sec.clamp(limit, 1, sec.MAX_LIMIT))


@app.get("/meta/heatmap")
def heatmap(tier: str = "", patch: str = ""):
    return svc.champion_item_pairs(tier=sec.clean_param(tier, field="tier") or None,
                                   patch=sec.clean_param(patch, field="patch"))


@app.get("/meta/patch-history")
def patch_history(entity_id: str = ""):
    return svc.patch_history(sec.clean_param(entity_id, field="entity_id") or None)


@app.get("/meta/roster")
def roster():
    """Full champion roster for the current set (for the team builder)."""
    icons = getattr(td, "CHAMPION_ICONS", {})
    champions = [
        {"id": cid, "cost": cost, "traits": list(traits), "icon": icons.get(cid, "")}
        for (cid, cost, traits) in td.CHAMPIONS
    ]
    champions.sort(key=lambda c: (c["cost"], c["id"]))
    return {
        "set": td.SET,
        "set_name": td.SET_NAME,
        "champions": champions,
        "items": getattr(td, "BUILDER_ITEMS", []),
        "traits": getattr(td, "TRAITS_DATA", [{"name": t, "breakpoints": [], "icon": ""} for t in td.TRAITS]),
        "augments": getattr(td, "BUILDER_AUGMENTS", []),
        "comps": getattr(td, "COMPS", []),
    }


@app.get("/players/suggest")
def players_suggest(q: str = "", limit: int = 8):
    return svc.player_suggest(sec.clean_param(q, field="q"), sec.clamp(limit, 1, 25))


@app.get("/player/{summoner_name}")
def player_analysis(summoner_name: str, region: str = "NA",
                    key: str = "", x_riot_key: str = Header(default="")):
    # The Riot key is read from the X-Riot-Key header so it never lands in
    # request logs / browser history (the legacy `?key=` is still accepted as a
    # fallback but should not be used).
    name = sec.validate_riot_id(summoner_name)
    region = sec.clean_param(region, field="region")[:8] or "NA"
    api_key = (x_riot_key or key).strip() or None
    return svc.player_analysis(name, region=region, api_key=api_key)


def main():
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("API_PORT", "8000")))


if __name__ == "__main__":
    main()
