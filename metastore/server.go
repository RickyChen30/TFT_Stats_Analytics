package main

import (
	"context"
	"log"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tft-analytics/gossip"
	"github.com/tft-analytics/hasher"
	pb "github.com/tft-analytics/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"
)

// Quorum parameters: N=3 replicas, W=2, R=2.
const (
	replicaFactor = 3
	writeQuorum   = 2
	readQuorum    = 2
)

// minSampleSize is the floor below which a stat is considered insufficient. The
// API enforces this, but the store annotates nothing extra — it just stores.
const promoteThreshold = 500 // samples that promote a patch to primary

// Server implements the MetaStore gRPC service over a sharded, replicated LSM.
type Server struct {
	pb.UnimplementedMetaStoreServer

	nodeID string
	self   string
	lsm    *LSMTree
	ring   *hasher.HashRing
	gossip *gossip.GossipNode

	clientMu sync.Mutex
	clients  map[string]pb.MetaStoreClient

	patchMu          sync.RWMutex
	currentPatch     string
	currentPatchSince time.Time
	seenPatches      map[string]time.Time
}

// NewServer constructs a metastore server. peers is the full set of metastore
// gRPC addresses including self.
func NewServer(nodeID, self string, lsm *LSMTree, peers []string, g *gossip.GossipNode) *Server {
	ring := hasher.New(hasher.DefaultVirtualNodes)
	for _, p := range peers {
		ring.AddNode(p)
	}
	return &Server{
		nodeID:           nodeID,
		self:             self,
		lsm:              lsm,
		ring:             ring,
		gossip:           g,
		clients:          make(map[string]pb.MetaStoreClient),
		seenPatches:      make(map[string]time.Time),
		currentPatchSince: time.Now(),
	}
}

// ---- Write path ----

func (s *Server) Write(ctx context.Context, req *pb.WriteRequest) (*pb.WriteResponse, error) {
	if req.Entry == nil {
		return &pb.WriteResponse{Success: false}, nil
	}
	s.trackPatch(req.Entry)

	if isReplica(ctx) {
		// Forwarded replica write: apply locally only.
		if err := s.lsm.Write(req.Entry); err != nil {
			return &pb.WriteResponse{Success: false}, err
		}
		return &pb.WriteResponse{Success: true}, nil
	}

	owners := s.ring.GetNodes(req.Entry.EntityId, replicaFactor)
	if len(owners) == 0 {
		// No ring membership (single-node bootstrap): write locally.
		if err := s.lsm.Write(req.Entry); err != nil {
			return &pb.WriteResponse{Success: false}, err
		}
		return &pb.WriteResponse{Success: true}, nil
	}

	need := writeQuorum
	if len(owners) < need {
		need = len(owners)
	}

	// Local write first (the coordinator is usually an owner).
	acks := 0
	remotes := make([]string, 0, len(owners))
	for _, owner := range owners {
		if owner == s.self {
			if err := s.lsm.Write(req.Entry); err == nil {
				acks++
			}
			continue
		}
		if s.gossip != nil && !s.gossip.IsAlive(owner) {
			continue
		}
		remotes = append(remotes, owner)
	}

	// Fan out replica writes concurrently and wait until quorum is satisfied;
	// stragglers keep replicating in the background for full durability.
	results := make(chan bool, len(remotes))
	for _, owner := range remotes {
		owner := owner
		go func() { results <- s.replicaWrite(owner, req.Entry) }()
	}
	for i := 0; i < len(remotes) && acks < need; i++ {
		if <-results {
			acks++
		}
	}
	return &pb.WriteResponse{Success: acks >= need}, nil
}

func (s *Server) replicaWrite(owner string, entry *pb.StatEntry) bool {
	client, err := s.peerClient(owner)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "x-replica", "1")
	resp, err := client.Write(ctx, &pb.WriteRequest{Entry: entry})
	if err != nil {
		log.Printf("[metastore] replicaWrite to %s failed: %v", owner, err)
		return false
	}
	return resp.Success
}

// ---- Read path ----

func (s *Server) Read(ctx context.Context, req *pb.ReadRequest) (*pb.ReadResponse, error) {
	key := readKey(req)

	if isReplica(ctx) {
		e, ok := s.lsm.Read(key)
		return &pb.ReadResponse{Entry: e, Found: ok}, nil
	}

	owners := s.ring.GetNodes(req.EntityId, replicaFactor)
	var best *pb.StatEntry
	responses := 0

	if len(owners) == 0 {
		if e, ok := s.lsm.Read(key); ok {
			best = e
		}
		responses = 1
	} else {
		need := readQuorum
		if len(owners) < need {
			need = len(owners)
		}
		for _, owner := range s.orderSelfFirst(owners) {
			if owner == s.self {
				responses++
				if e, ok := s.lsm.Read(key); ok {
					best = pickNewer(best, e)
				}
				continue
			}
			if s.gossip != nil && !s.gossip.IsAlive(owner) {
				continue
			}
			if e, ok := s.replicaRead(owner, req); ok {
				responses++
				if e != nil {
					best = pickNewer(best, e)
				}
			}
			if responses >= need && best != nil {
				break // satisfied quorum with a value in hand
			}
		}
	}

	if best != nil {
		best = s.applyDecay(best)
	}
	return &pb.ReadResponse{Entry: best, Found: best != nil}, nil
}

func (s *Server) replicaRead(owner string, req *pb.ReadRequest) (*pb.StatEntry, bool) {
	client, err := s.peerClient(owner)
	if err != nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "x-replica", "1")
	resp, err := client.Read(ctx, req)
	if err != nil {
		return nil, false
	}
	return resp.Entry, true
}

// ---- Scan path (cross-shard fan-out) ----

func (s *Server) Scan(ctx context.Context, req *pb.ScanRequest) (*pb.ScanResponse, error) {
	match := scanPredicate(req)
	merged := make(map[string]*pb.StatEntry)
	for _, e := range s.lsm.Scan(match) {
		merged[entryKey(e)] = pickNewer(merged[entryKey(e)], e)
	}

	// Fan out to peers (unless this is itself a forwarded scan) to cover all shards.
	if !isReplica(ctx) {
		for _, peer := range s.ring.Nodes() {
			if peer == s.self {
				continue
			}
			if s.gossip != nil && !s.gossip.IsAlive(peer) {
				continue
			}
			for _, e := range s.remoteScan(peer, req) {
				merged[entryKey(e)] = pickNewer(merged[entryKey(e)], e)
			}
		}
	}

	out := make([]*pb.StatEntry, 0, len(merged))
	for _, e := range merged {
		out = append(out, s.applyDecay(e))
	}
	if req.Limit > 0 && int64(len(out)) > req.Limit {
		out = out[:req.Limit]
	}
	return &pb.ScanResponse{Entries: out}, nil
}

func (s *Server) remoteScan(peer string, req *pb.ScanRequest) []*pb.StatEntry {
	client, err := s.peerClient(peer)
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "x-replica", "1")
	resp, err := client.Scan(ctx, req)
	if err != nil {
		return nil
	}
	return resp.Entries
}

// ---- Patch invalidation / decay ----

func (s *Server) trackPatch(e *pb.StatEntry) {
	if e.Patch == "" {
		return
	}
	s.patchMu.Lock()
	defer s.patchMu.Unlock()
	if _, ok := s.seenPatches[e.Patch]; !ok {
		s.seenPatches[e.Patch] = time.Now()
	}
	if s.currentPatch == "" {
		s.currentPatch = e.Patch
		s.currentPatchSince = time.Now()
		return
	}
	// Promote a newer patch to primary once any entity crosses the sample threshold.
	if e.SampleSize >= promoteThreshold && patchNewer(e.Patch, s.currentPatch) {
		log.Printf("[metastore] promoting patch %s -> primary (was %s)", e.Patch, s.currentPatch)
		s.currentPatch = e.Patch
		s.currentPatchSince = time.Now()
	}
}

// NotifyPatch records a patch announced via the patch_events topic. It bootstraps
// the primary patch but does not force promotion (that waits for sample volume).
func (s *Server) NotifyPatch(patch string) {
	if patch == "" {
		return
	}
	s.patchMu.Lock()
	defer s.patchMu.Unlock()
	if _, ok := s.seenPatches[patch]; !ok {
		s.seenPatches[patch] = time.Now()
	}
	if s.currentPatch == "" {
		s.currentPatch = patch
		s.currentPatchSince = time.Now()
	}
}

// applyDecay scales sample_size down for entries on a superseded patch, using
// exponential decay keyed on how long the current patch has been primary.
func (s *Server) applyDecay(e *pb.StatEntry) *pb.StatEntry {
	s.patchMu.RLock()
	cur, since := s.currentPatch, s.currentPatchSince
	s.patchMu.RUnlock()
	if cur == "" || e.Patch == "" || e.Patch == cur || !patchNewer(cur, e.Patch) {
		return e
	}
	age := time.Since(since)
	cp := proto.Clone(e).(*pb.StatEntry)
	cp.SampleSize = decayedSampleSize(e.SampleSize, age)
	return cp
}

// decayedSampleSize applies 0.85^days exponential decay to an old-patch sample.
func decayedSampleSize(original int64, patchAge time.Duration) int64 {
	days := patchAge.Hours() / 24
	return int64(float64(original) * math.Pow(0.85, days))
}

// patchNewer reports whether patch a is newer than b. Patches look like
// "MAJOR.MINOR" (e.g. "14.3"); fall back to string comparison if unparseable.
func patchNewer(a, b string) bool {
	am, an, aok := parsePatch(a)
	bm, bn, bok := parsePatch(b)
	if aok && bok {
		if am != bm {
			return am > bm
		}
		return an > bn
	}
	return a > b
}

func parsePatch(p string) (major, minor int, ok bool) {
	parts := strings.SplitN(p, ".", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	m, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
	n, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return m, n, true
}

// ---- helpers ----

func (s *Server) peerClient(addr string) (pb.MetaStoreClient, error) {
	s.clientMu.Lock()
	defer s.clientMu.Unlock()
	if c, ok := s.clients[addr]; ok {
		return c, nil
	}
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	c := pb.NewMetaStoreClient(conn)
	s.clients[addr] = c
	return c, nil
}

func (s *Server) onPeerDead(addr string) {
	log.Printf("[metastore] peer %s dead; removing from ring", addr)
	s.ring.RemoveNode(addr)
}

func isReplica(ctx context.Context) bool {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return false
	}
	v := md.Get("x-replica")
	return len(v) > 0 && v[0] == "1"
}

func readKey(req *pb.ReadRequest) string {
	return req.EntityId + ":" + req.Patch + ":" + req.Tier + ":" + req.Region
}

// orderSelfFirst returns owners with this node moved to the front, so quorum
// ops read/write the local replica before paying any network round-trip.
func (s *Server) orderSelfFirst(owners []string) []string {
	out := make([]string, 0, len(owners))
	for _, o := range owners {
		if o == s.self {
			out = append(out, o)
		}
	}
	for _, o := range owners {
		if o != s.self {
			out = append(out, o)
		}
	}
	return out
}

func scanPredicate(req *pb.ScanRequest) func(*pb.StatEntry) bool {
	return func(e *pb.StatEntry) bool {
		if req.EntityType != "" && e.EntityType != req.EntityType {
			return false
		}
		if req.Patch != "" && e.Patch != req.Patch {
			return false
		}
		if req.Tier != "" && e.Tier != req.Tier {
			return false
		}
		if req.Region != "" && e.Region != req.Region {
			return false
		}
		return true
	}
}
