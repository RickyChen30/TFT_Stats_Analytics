// Package hasher implements a consistent hashing ring with virtual nodes.
//
// It is used by both the broker (to place partitions on broker nodes) and the
// meta store (to place shards on metastore nodes). Lookups are O(log n) via
// binary search over a sorted slice of virtual-node hashes.
package hasher

import (
	"hash/crc32"
	"sort"
	"strconv"
	"sync"
)

// DefaultVirtualNodes is the number of virtual nodes created per physical node.
// More virtual nodes => smoother key distribution at the cost of memory.
const DefaultVirtualNodes = 150

// HashRing is a thread-safe consistent hash ring.
type HashRing struct {
	mu           sync.RWMutex
	virtualNodes int
	ring         []uint32          // sorted hash values
	nodeMap      map[uint32]string // hash -> physical node address
	nodes        map[string]bool   // set of physical nodes currently in the ring
}

// New creates a ring with the given number of virtual nodes per physical node.
// A value <= 0 falls back to DefaultVirtualNodes.
func New(virtualNodes int) *HashRing {
	if virtualNodes <= 0 {
		virtualNodes = DefaultVirtualNodes
	}
	return &HashRing{
		virtualNodes: virtualNodes,
		ring:         make([]uint32, 0),
		nodeMap:      make(map[uint32]string),
		nodes:        make(map[string]bool),
	}
}

func (r *HashRing) hashKey(key string) uint32 {
	return crc32.ChecksumIEEE([]byte(key))
}

// AddNode inserts a physical node and its virtual replicas into the ring.
func (r *HashRing) AddNode(addr string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.nodes[addr] {
		return
	}
	r.nodes[addr] = true
	for i := 0; i < r.virtualNodes; i++ {
		h := r.hashKey(addr + "#" + strconv.Itoa(i))
		// Skip the rare collision rather than clobber another node's slot.
		if _, exists := r.nodeMap[h]; exists {
			continue
		}
		r.nodeMap[h] = addr
		r.ring = append(r.ring, h)
	}
	sort.Slice(r.ring, func(a, b int) bool { return r.ring[a] < r.ring[b] })
}

// RemoveNode deletes a physical node and all of its virtual replicas.
func (r *HashRing) RemoveNode(addr string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.nodes[addr] {
		return
	}
	delete(r.nodes, addr)
	filtered := r.ring[:0]
	for _, h := range r.ring {
		if r.nodeMap[h] == addr {
			delete(r.nodeMap, h)
			continue
		}
		filtered = append(filtered, h)
	}
	r.ring = filtered
}

// search returns the index of the first ring hash >= h, wrapping to 0.
// Caller must hold at least the read lock and ensure the ring is non-empty.
func (r *HashRing) search(h uint32) int {
	idx := sort.Search(len(r.ring), func(i int) bool { return r.ring[i] >= h })
	if idx == len(r.ring) {
		idx = 0 // wrap around the ring
	}
	return idx
}

// GetNode returns the physical node responsible for key, or "" if the ring is empty.
func (r *HashRing) GetNode(key string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.ring) == 0 {
		return ""
	}
	return r.nodeMap[r.ring[r.search(r.hashKey(key))]]
}

// GetNodes returns up to n distinct physical nodes responsible for key, walking
// clockwise from the primary. Used to select replication targets.
func (r *HashRing) GetNodes(key string, n int) []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.ring) == 0 || n <= 0 {
		return nil
	}
	if n > len(r.nodes) {
		n = len(r.nodes)
	}

	seen := make(map[string]bool, n)
	result := make([]string, 0, n)
	start := r.search(r.hashKey(key))
	for i := 0; i < len(r.ring) && len(result) < n; i++ {
		idx := (start + i) % len(r.ring)
		node := r.nodeMap[r.ring[idx]]
		if !seen[node] {
			seen[node] = true
			result = append(result, node)
		}
	}
	return result
}

// Nodes returns the current set of physical node addresses.
func (r *HashRing) Nodes() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.nodes))
	for n := range r.nodes {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}
