package main

import (
	"sort"
	"sync"

	pb "github.com/tft-analytics/proto"
	"google.golang.org/protobuf/proto"
)

// MemTable is the in-memory write buffer at the top of the LSM tree. Writes land
// here (after the WAL) and are flushed to an SSTable once size exceeds a bound.
type MemTable struct {
	mu   sync.RWMutex
	data map[string]*pb.StatEntry // key: "entity_id:patch:tier:region"
	size int64                    // approximate bytes held
}

// NewMemTable creates an empty memtable.
func NewMemTable() *MemTable {
	return &MemTable{data: make(map[string]*pb.StatEntry)}
}

// Put inserts/overwrites an entry, resolving conflicts by vector clock so a late
// out-of-order write never clobbers a causally-newer one.
func (m *MemTable) Put(key string, entry *pb.StatEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.data[key]; ok {
		winner := pickNewer(existing, entry)
		m.size += int64(proto.Size(winner) - proto.Size(existing))
		m.data[key] = winner
		return
	}
	m.data[key] = entry
	m.size += int64(len(key) + proto.Size(entry))
}

// Get returns the entry for key if present.
func (m *MemTable) Get(key string) (*pb.StatEntry, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.data[key]
	return e, ok
}

// Size returns the approximate in-memory byte size.
func (m *MemTable) Size() int64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.size
}

// Len returns the number of entries.
func (m *MemTable) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.data)
}

// SortedEntries returns all entries ordered by key, for flushing to an SSTable.
func (m *MemTable) SortedEntries() []*pb.StatEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	keys := make([]string, 0, len(m.data))
	for k := range m.data {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]*pb.StatEntry, 0, len(keys))
	for _, k := range keys {
		out = append(out, m.data[k])
	}
	return out
}

// Scan returns entries matching the predicate.
func (m *MemTable) Scan(match func(*pb.StatEntry) bool) []*pb.StatEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []*pb.StatEntry
	for _, e := range m.data {
		if match(e) {
			out = append(out, e)
		}
	}
	return out
}
