"""Launch a local multi-node broker + meta store cluster from the built Go
binaries, for chaos and benchmark testing without Docker.
"""
from __future__ import annotations

import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "bin")


def _wait_port(host: str, port: int, timeout: float = 15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    raise TimeoutError(f"{host}:{port} did not open in {timeout}s")


class Node:
    def __init__(self, name: str, proc: subprocess.Popen, grpc_port: int, data_dir: str):
        self.name = name
        self.proc = proc
        self.grpc_port = grpc_port
        self.data_dir = data_dir
        self.addr = f"127.0.0.1:{grpc_port}"

    def kill(self):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGKILL)
            self.proc.wait(timeout=5)

    def alive(self) -> bool:
        return self.proc.poll() is None


class Cluster:
    def __init__(self, n_brokers: int = 3, n_metastores: int = 3, base_dir: str | None = None):
        self.base_dir = base_dir or tempfile.mkdtemp(prefix="tft-cluster-")
        self.brokers: list[Node] = []
        self.metastores: list[Node] = []
        self.n_brokers = n_brokers
        self.n_metastores = n_metastores

    def _spawn(self, binary, env, log_path):
        full_env = {**os.environ, **env}
        log = open(log_path, "w")
        return subprocess.Popen([os.path.join(BIN, binary)], env=full_env, stdout=log, stderr=subprocess.STDOUT)

    def start(self):
        # Brokers: gRPC 51001.., gossip 51011..
        bgrpc = [51001 + i for i in range(self.n_brokers)]
        for i in range(self.n_brokers):
            self_addr = f"127.0.0.1:{bgrpc[i]}"
            peers = ",".join(f"127.0.0.1:{p}" for j, p in enumerate(bgrpc) if j != i)
            data = os.path.join(self.base_dir, f"broker-{i+1}")
            env = {
                "NODE_ID": f"broker-{i+1}", "SELF": self_addr, "PEERS": peers,
                "GRPC_PORT": str(bgrpc[i]), "GOSSIP_PORT": str(51011 + i),
                "METRICS_PORT": str(0), "DATA_DIR": data,
            }
            proc = self._spawn("broker", env, os.path.join(self.base_dir, f"broker-{i+1}.log"))
            self.brokers.append(Node(f"broker-{i+1}", proc, bgrpc[i], data))

        # Meta stores: gRPC 52001.., gossip 52011..
        mgrpc = [52001 + i for i in range(self.n_metastores)]
        for i in range(self.n_metastores):
            self_addr = f"127.0.0.1:{mgrpc[i]}"
            peers = ",".join(f"127.0.0.1:{p}" for j, p in enumerate(mgrpc) if j != i)
            data = os.path.join(self.base_dir, f"metastore-{i+1}")
            env = {
                "NODE_ID": f"metastore-{i+1}", "SELF": self_addr, "PEERS": peers,
                "GRPC_PORT": str(mgrpc[i]), "GOSSIP_PORT": str(52011 + i),
                "METRICS_PORT": str(0), "DATA_DIR": data,
            }
            proc = self._spawn("metastore", env, os.path.join(self.base_dir, f"metastore-{i+1}.log"))
            self.metastores.append(Node(f"metastore-{i+1}", proc, mgrpc[i], data))

        for n in self.brokers + self.metastores:
            _wait_port("127.0.0.1", n.grpc_port)
        # Give gossip a couple of rounds to form membership.
        time.sleep(2)

    def metastore(self, idx: int) -> Node:
        return self.metastores[idx]

    def broker(self, idx: int) -> Node:
        return self.brokers[idx]

    def stop(self, cleanup: bool = True):
        for n in self.brokers + self.metastores:
            try:
                n.kill()
            except Exception:
                pass
        if cleanup:
            shutil.rmtree(self.base_dir, ignore_errors=True)
