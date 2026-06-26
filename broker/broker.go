package main

import (
	"context"
	"io"
	"log"
	"sync"
	"time"

	"github.com/tft-analytics/gossip"
	"github.com/tft-analytics/hasher"
	pb "github.com/tft-analytics/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

// replicationFactor is the total number of broker nodes holding each partition.
const replicationFactor = 2

// consumerRateLimit caps delivery at 1000 msgs/sec per consumer (backpressure).
const consumerRateLimit = 1000

// Broker is an append-only-log message broker node.
type Broker struct {
	pb.UnimplementedBrokerServer

	nodeID     string
	addr       string
	dataDir    string
	maxRecords int // per-partition log retention cap (0 = unbounded)

	mu         sync.RWMutex
	partitions map[string]*Partition // key: "topic_region_tier"

	ring   *hasher.HashRing
	gossip *gossip.GossipNode
	self   string

	// lazily created gRPC clients to peer brokers, for replication.
	clientMu sync.Mutex
	clients  map[string]pb.BrokerClient
}

// NewBroker constructs a broker. self is this node's gRPC address; peers is the
// full set of broker gRPC addresses (including self).
func NewBroker(nodeID, addr, dataDir, self string, peers []string, g *gossip.GossipNode, maxRecords int) *Broker {
	ring := hasher.New(hasher.DefaultVirtualNodes)
	for _, p := range peers {
		ring.AddNode(p)
	}
	return &Broker{
		nodeID:     nodeID,
		addr:       addr,
		dataDir:    dataDir,
		maxRecords: maxRecords,
		partitions: make(map[string]*Partition),
		ring:       ring,
		gossip:     g,
		self:       self,
		clients:    make(map[string]pb.BrokerClient),
	}
}

// getPartition returns (creating if needed) the partition for key.
func (b *Broker) getPartition(key string) (*Partition, error) {
	b.mu.RLock()
	p, ok := b.partitions[key]
	b.mu.RUnlock()
	if ok {
		return p, nil
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	if p, ok := b.partitions[key]; ok { // double-check under write lock
		return p, nil
	}
	p, err := openPartition(b.dataDir, key, b.maxRecords)
	if err != nil {
		return nil, err
	}
	p.replicas = b.replicaTargets(key)
	b.partitions[key] = p
	return p, nil
}

// replicaTargets returns up to replicationFactor-1 peer addresses (excluding
// self) that should hold a replica of this partition, chosen by the hash ring.
func (b *Broker) replicaTargets(key string) []string {
	owners := b.ring.GetNodes(key, replicationFactor+1)
	targets := make([]string, 0, replicationFactor-1)
	for _, o := range owners {
		if o == b.self {
			continue
		}
		targets = append(targets, o)
		if len(targets) >= replicationFactor-1 {
			break
		}
	}
	return targets
}

// Publish appends a message locally and asynchronously replicates it.
func (b *Broker) Publish(ctx context.Context, req *pb.PublishRequest) (*pb.PublishResponse, error) {
	key := partitionKey(req.Topic, req.Region, req.Tier)
	p, err := b.getPartition(key)
	if err != nil {
		return nil, err
	}

	offset, err := p.Append(req.Payload)
	if err != nil {
		return nil, err
	}

	// If this write was forwarded from another broker, do not re-replicate.
	if isReplicaWrite(ctx) {
		return &pb.PublishResponse{Success: true, Offset: offset}, nil
	}

	// Async replication: ack the client after the local write (spec requirement).
	for _, target := range p.replicas {
		target := target
		go b.replicate(target, req)
	}
	return &pb.PublishResponse{Success: true, Offset: offset}, nil
}

func (b *Broker) replicate(target string, req *pb.PublishRequest) {
	if b.gossip != nil && !b.gossip.IsAlive(target) {
		return // skip known-dead replicas; re-replication handles them later
	}
	client, err := b.peerClient(target)
	if err != nil {
		log.Printf("[broker] replicate dial %s: %v", target, err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "x-replica", "1")
	if _, err := client.Publish(ctx, req); err != nil {
		log.Printf("[broker] replicate to %s failed: %v", target, err)
	}
}

// Subscribe streams records from the requested offset, then tails the partition
// for new messages. Delivery is throttled per consumer via a token bucket.
func (b *Broker) Subscribe(req *pb.SubscribeRequest, stream pb.Broker_SubscribeServer) error {
	key := partitionKey(req.Topic, req.Region, req.Tier)
	p, err := b.getPartition(key)
	if err != nil {
		return err
	}

	bucket := NewTokenBucket(consumerRateLimit)
	offset := req.Offset
	if offset < 0 {
		offset = 0
	}
	ctx := stream.Context()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// If the consumer is behind the retained window (old data was trimmed),
		// fast-forward to the oldest record still available.
		if base := p.BaseOffset(); offset < base {
			offset = base
		}

		if offset >= p.NextOffset() {
			// Caught up: wait for a new append or a periodic wakeup.
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-p.notify:
			case <-time.After(500 * time.Millisecond):
			}
			continue
		}

		payload, err := p.ReadAt(offset)
		if err == io.EOF {
			continue
		}
		if err != nil {
			return err
		}

		bucket.Take() // backpressure: <= 1000 msgs/sec
		if err := stream.Send(&pb.SubscribeResponse{Payload: payload, Offset: offset}); err != nil {
			return err
		}
		offset++
	}
}

func isReplicaWrite(ctx context.Context) bool {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return false
	}
	vals := md.Get("x-replica")
	return len(vals) > 0 && vals[0] == "1"
}

func (b *Broker) peerClient(addr string) (pb.BrokerClient, error) {
	b.clientMu.Lock()
	defer b.clientMu.Unlock()
	if c, ok := b.clients[addr]; ok {
		return c, nil
	}
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	c := pb.NewBrokerClient(conn)
	b.clients[addr] = c
	return c, nil
}

// onPeerDead re-replicates partitions whose replica set included the dead node.
// New replica targets are recomputed from the (now smaller) ring and back-filled.
func (b *Broker) onPeerDead(addr string) {
	log.Printf("[broker] peer %s dead; recomputing replicas", addr)
	b.ring.RemoveNode(addr)
	b.mu.RLock()
	parts := make([]*Partition, 0, len(b.partitions))
	keys := make([]string, 0, len(b.partitions))
	for k, p := range b.partitions {
		parts = append(parts, p)
		keys = append(keys, k)
	}
	b.mu.RUnlock()

	for i, p := range parts {
		newTargets := b.replicaTargets(keys[i])
		p.mu.Lock()
		old := p.replicas
		p.replicas = newTargets
		p.mu.Unlock()
		// Back-fill any newly-added replica that wasn't holding this partition.
		for _, t := range newTargets {
			if !contains(old, t) {
				go b.backfill(t, p)
			}
		}
	}
}

// backfill streams every record of a partition to a freshly-assigned replica.
func (b *Broker) backfill(target string, p *Partition) {
	client, err := b.peerClient(target)
	if err != nil {
		return
	}
	next := p.NextOffset()
	for off := int64(0); off < next; off++ {
		payload, err := p.ReadAt(off)
		if err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		ctx = metadata.AppendToOutgoingContext(ctx, "x-replica", "1")
		topic, region, tier := splitKey(p.key)
		_, _ = client.Publish(ctx, &pb.PublishRequest{
			Topic: topic, Region: region, Tier: tier, Payload: payload,
		})
		cancel()
	}
	log.Printf("[broker] backfilled %s -> %s (%d records)", p.key, target, next)
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
