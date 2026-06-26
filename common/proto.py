"""Shared access to the generated protobuf / gRPC bindings.

The grpc_tools generator emits ``import tft_pb2`` (a flat import), which only
resolves when the directory holding the generated files is on ``sys.path``. This
module locates ``gen/python`` (overridable via ``PROTO_DIR``) and re-exports the
bindings so every service can simply ``from common.proto import pb, rpc``.
"""
import os
import sys

_DEFAULT = os.path.join(os.path.dirname(__file__), "..", "gen", "python")
_PROTO_DIR = os.environ.get("PROTO_DIR", _DEFAULT)
_PROTO_DIR = os.path.abspath(_PROTO_DIR)

if _PROTO_DIR not in sys.path:
    sys.path.insert(0, _PROTO_DIR)

import tft_pb2 as pb  # noqa: E402
import tft_pb2_grpc as rpc  # noqa: E402

# Canonical topic names shared across producers/consumers.
TOPIC_RAW_MATCHES = "raw_matches"
TOPIC_PROCESSED_STATS = "processed_stats"
TOPIC_PATCH_EVENTS = "patch_events"
TOPIC_ANOMALY_ALERTS = "anomaly_alerts"

__all__ = [
    "pb",
    "rpc",
    "TOPIC_RAW_MATCHES",
    "TOPIC_PROCESSED_STATS",
    "TOPIC_PATCH_EVENTS",
    "TOPIC_ANOMALY_ALERTS",
]
