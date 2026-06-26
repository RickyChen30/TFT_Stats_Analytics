"""Thin gRPC client wrappers for the Go broker and meta store."""
from __future__ import annotations

import grpc

from .proto import pb, rpc

# 32MB to comfortably hold batched match payloads.
_CHANNEL_OPTS = [
    ("grpc.max_send_message_length", 32 * 1024 * 1024),
    ("grpc.max_receive_message_length", 32 * 1024 * 1024),
]


class BrokerClient:
    """Synchronous client for the broker's Publish/Subscribe RPCs."""

    def __init__(self, addr: str):
        self.addr = addr
        self.channel = grpc.insecure_channel(addr, options=_CHANNEL_OPTS)
        self.stub = rpc.BrokerStub(self.channel)

    def publish(self, topic: str, payload: bytes, region: str = "", tier: str = "") -> int:
        resp = self.stub.Publish(
            pb.PublishRequest(topic=topic, payload=payload, region=region, tier=tier)
        )
        return resp.offset

    def subscribe(self, topic: str, group: str, offset: int = 0, region: str = "", tier: str = ""):
        """Yield (offset, payload) tuples. Blocks, tailing the partition."""
        req = pb.SubscribeRequest(
            topic=topic, consumer_group=group, offset=offset, region=region, tier=tier
        )
        for msg in self.stub.Subscribe(req):
            yield msg.offset, msg.payload

    def close(self):
        self.channel.close()


class MetaStoreClient:
    """Synchronous client for the meta store's Read/Write/Scan RPCs."""

    def __init__(self, addr: str):
        self.addr = addr
        self.channel = grpc.insecure_channel(addr, options=_CHANNEL_OPTS)
        self.stub = rpc.MetaStoreStub(self.channel)

    def write(self, entry: "pb.StatEntry") -> bool:
        return self.stub.Write(pb.WriteRequest(entry=entry)).success

    def read(self, entity_id: str, patch: str = "", tier: str = "", region: str = ""):
        resp = self.stub.Read(
            pb.ReadRequest(entity_id=entity_id, patch=patch, tier=tier, region=region)
        )
        return resp.entry if resp.found else None

    def scan(self, entity_type: str = "", patch: str = "", tier: str = "",
             region: str = "", limit: int = 0):
        resp = self.stub.Scan(
            pb.ScanRequest(entity_type=entity_type, patch=patch, tier=tier,
                           region=region, limit=limit)
        )
        return list(resp.entries)

    def close(self):
        self.channel.close()
