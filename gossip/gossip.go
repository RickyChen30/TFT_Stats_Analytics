// Package gossip implements a SWIM-style gossip membership and failure detector
// over UDP. Each node periodically exchanges its full membership view with a few
// random peers. Members move alive -> suspected -> dead based on how long it has
// been since their heartbeat was last refreshed.
package gossip

import (
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net"
	"strconv"
	"sync"
	"time"
)

const (
	gossipInterval = 1 * time.Second
	suspectAfter   = 10 * time.Second
	deadAfter      = 20 * time.Second
	fanout         = 3 // peers contacted per gossip round
	maxPacket      = 65000
)

// Status values for a member.
const (
	StatusAlive     = "alive"
	StatusSuspected = "suspected"
	StatusDead      = "dead"
)

// MemberState tracks one peer's liveness.
type MemberState struct {
	Addr        string    `json:"addr"`
	HeartbeatAt time.Time `json:"heartbeat_at"`
	Incarnation uint64    `json:"incarnation"`
	Status      string    `json:"status"`
}

// GossipNode is the local view of cluster membership.
// DefaultGossipPortOffset is added to a node's gRPC port to derive its UDP
// gossip port. Offsetting (rather than using a fixed port) keeps gossip ports
// unique even when several nodes share a host but differ by gRPC port.
const DefaultGossipPortOffset = 10000

type GossipNode struct {
	self        string // logical node identity (its gRPC address)
	portOffset  int    // added to a node's gRPC port to get its gossip UDP port
	incarnation uint64
	members     map[string]*MemberState
	mu          sync.RWMutex
	conn        *net.UDPConn

	// onDead is invoked once each time a member transitions to dead. Components
	// (e.g. broker, metastore) use it to trigger re-replication.
	onDead func(addr string)

	stopCh chan struct{}
}

// New creates a gossip node. `self` and `peers` are the *logical* node
// identities (their gRPC addresses, host:grpcPort) — the same identities the
// hash ring and IsAlive() callers use. Gossip is transported over UDP on
// host(identity):(grpcPort+portOffset). Keying members by the gRPC identity
// lets IsAlive(grpcAddr) resolve directly.
func New(self string, peers []string, portOffset int) (*GossipNode, error) {
	if portOffset == 0 {
		portOffset = DefaultGossipPortOffset
	}
	g := &GossipNode{
		self:       self,
		portOffset: portOffset,
		members:    make(map[string]*MemberState),
		stopCh:     make(chan struct{}),
	}
	addr, err := net.ResolveUDPAddr("udp", g.gossipAddr(self))
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return nil, err
	}
	g.conn = conn

	now := time.Now()
	g.members[self] = &MemberState{Addr: self, HeartbeatAt: now, Status: StatusAlive}
	for _, p := range peers {
		if p == "" || p == self {
			continue
		}
		g.members[p] = &MemberState{Addr: p, HeartbeatAt: now, Status: StatusAlive}
	}
	return g, nil
}

// gossipAddr maps a node's logical identity (host:grpcPort) to its UDP gossip
// endpoint (host:grpcPort+offset).
func (g *GossipNode) gossipAddr(identity string) string {
	host, port := splitHostPort(identity)
	return fmt.Sprintf("%s:%d", host, port+g.portOffset)
}

func splitHostPort(addr string) (string, int) {
	i := -1
	for j := len(addr) - 1; j >= 0; j-- {
		if addr[j] == ':' {
			i = j
			break
		}
	}
	if i < 0 {
		return addr, 0
	}
	port, _ := strconv.Atoi(addr[i+1:])
	return addr[:i], port
}

// OnDead registers a callback fired when a member is declared dead.
func (g *GossipNode) OnDead(fn func(addr string)) { g.onDead = fn }

// Start launches the receive loop and the periodic gossip loop.
func (g *GossipNode) Start() {
	go g.recvLoop()
	go g.gossipLoop()
}

// Stop terminates the loops and closes the socket.
func (g *GossipNode) Stop() {
	close(g.stopCh)
	g.conn.Close()
}

func (g *GossipNode) gossipLoop() {
	ticker := time.NewTicker(gossipInterval)
	defer ticker.Stop()
	for {
		select {
		case <-g.stopCh:
			return
		case <-ticker.C:
			g.tick()
			g.disseminate()
		}
	}
}

// tick refreshes our own heartbeat and ages other members.
func (g *GossipNode) tick() {
	g.mu.Lock()
	now := time.Now()
	g.members[g.self].HeartbeatAt = now
	g.members[g.self].Incarnation = g.incarnation
	var newlyDead []string
	for addr, m := range g.members {
		if addr == g.self {
			continue
		}
		age := now.Sub(m.HeartbeatAt)
		switch {
		case age >= deadAfter && m.Status != StatusDead:
			m.Status = StatusDead
			newlyDead = append(newlyDead, addr)
		case age >= suspectAfter && age < deadAfter && m.Status == StatusAlive:
			m.Status = StatusSuspected
		}
	}
	g.mu.Unlock()

	for _, addr := range newlyDead {
		log.Printf("[gossip] member %s declared DEAD", addr)
		if g.onDead != nil {
			g.onDead(addr)
		}
	}
}

// disseminate sends our membership view to a few random live peers.
func (g *GossipNode) disseminate() {
	g.mu.RLock()
	payload, err := json.Marshal(g.snapshotLocked())
	peers := make([]string, 0, len(g.members))
	for addr, m := range g.members {
		if addr != g.self && m.Status != StatusDead {
			peers = append(peers, addr)
		}
	}
	g.mu.RUnlock()
	if err != nil || len(peers) == 0 {
		return
	}

	rand.Shuffle(len(peers), func(i, j int) { peers[i], peers[j] = peers[j], peers[i] })
	n := fanout
	if n > len(peers) {
		n = len(peers)
	}
	for _, peer := range peers[:n] {
		g.sendTo(peer, payload)
	}
}

func (g *GossipNode) sendTo(peer string, payload []byte) {
	// Translate the peer's logical identity to its UDP gossip endpoint.
	addr, err := net.ResolveUDPAddr("udp", g.gossipAddr(peer))
	if err != nil {
		return
	}
	if len(payload) > maxPacket {
		return
	}
	_, _ = g.conn.WriteToUDP(payload, addr)
}

func (g *GossipNode) recvLoop() {
	buf := make([]byte, maxPacket)
	for {
		select {
		case <-g.stopCh:
			return
		default:
		}
		_ = g.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, _, err := g.conn.ReadFromUDP(buf)
		if err != nil {
			continue // timeout or closed socket
		}
		var incoming []*MemberState
		if err := json.Unmarshal(buf[:n], &incoming); err != nil {
			continue
		}
		g.merge(incoming)
	}
}

// merge folds a peer's view into ours, keeping the freshest heartbeat per member.
func (g *GossipNode) merge(incoming []*MemberState) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	for _, in := range incoming {
		if in.Addr == g.self {
			// A peer thinks we're suspected/dead: refute by bumping incarnation.
			if in.Status != StatusAlive && in.Incarnation >= g.incarnation {
				g.incarnation = in.Incarnation + 1
			}
			continue
		}
		cur, ok := g.members[in.Addr]
		if !ok {
			g.members[in.Addr] = &MemberState{
				Addr: in.Addr, HeartbeatAt: now, Incarnation: in.Incarnation, Status: StatusAlive,
			}
			continue
		}
		// Accept the update if it carries a newer incarnation, or an alive status
		// we don't yet have. Translate "fresh" gossip into a local heartbeat.
		if in.Incarnation > cur.Incarnation {
			cur.Incarnation = in.Incarnation
			cur.HeartbeatAt = now
			cur.Status = StatusAlive
		} else if in.Incarnation == cur.Incarnation && in.Status == StatusAlive && cur.Status != StatusAlive {
			cur.HeartbeatAt = now
			cur.Status = StatusAlive
		} else if in.Status == StatusAlive {
			cur.HeartbeatAt = now
			if cur.Status == StatusSuspected {
				cur.Status = StatusAlive
			}
		}
	}
}

func (g *GossipNode) snapshotLocked() []*MemberState {
	out := make([]*MemberState, 0, len(g.members))
	for _, m := range g.members {
		cp := *m
		out = append(out, &cp)
	}
	return out
}

// IsAlive reports whether addr is currently considered alive. Unknown members
// are treated as not alive.
func (g *GossipNode) IsAlive(addr string) bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if addr == g.self {
		return true
	}
	m, ok := g.members[addr]
	return ok && m.Status == StatusAlive
}

// AliveMembers returns the addresses of all members currently alive (incl. self).
func (g *GossipNode) AliveMembers() []string {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]string, 0, len(g.members))
	for addr, m := range g.members {
		if m.Status == StatusAlive {
			out = append(out, addr)
		}
	}
	return out
}

// Members returns a snapshot of all known member states.
func (g *GossipNode) Members() []MemberState {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]MemberState, 0, len(g.members))
	for _, m := range g.members {
		out = append(out, *m)
	}
	return out
}
