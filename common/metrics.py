"""Minimal Prometheus-style metrics exporter (no external dependency).

Each service registers counters/gauges and starts a tiny HTTP server exposing
``/metrics`` in the Prometheus text format, plus ``/health``.
"""
from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


class Metrics:
    def __init__(self, namespace: str):
        self.namespace = namespace
        self._lock = threading.Lock()
        self._counters: dict[str, float] = {}
        self._gauges: dict[str, float] = {}

    def inc(self, name: str, amount: float = 1.0):
        with self._lock:
            self._counters[name] = self._counters.get(name, 0.0) + amount

    def set(self, name: str, value: float):
        with self._lock:
            self._gauges[name] = value

    def render(self) -> str:
        lines = []
        with self._lock:
            for name, val in sorted(self._counters.items()):
                metric = f"{self.namespace}_{name}"
                lines.append(f"# TYPE {metric} counter")
                lines.append(f"{metric} {val}")
            for name, val in sorted(self._gauges.items()):
                metric = f"{self.namespace}_{name}"
                lines.append(f"# TYPE {metric} gauge")
                lines.append(f"{metric} {val}")
        return "\n".join(lines) + "\n"


def serve_metrics(metrics: Metrics, port: int):
    """Start the metrics HTTP server in a daemon thread."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path == "/health":
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ok")
                return
            if self.path == "/metrics":
                body = metrics.render().encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; version=0.0.4")
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(404)
            self.end_headers()

        def log_message(self, *args):  # silence access logs
            pass

    server = HTTPServer(("0.0.0.0", port), Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server
