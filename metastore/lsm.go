package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/tft-analytics/proto"
	"google.golang.org/protobuf/proto"
)

const (
	defaultMemTableMaxBytes = 64 * 1024 * 1024 // 64MB flush threshold
	level0CompactThreshold  = 4                // compact L0 when it exceeds this
	blockCacheEntries       = 4096
)

// LSMTree is a log-structured merge tree: writes hit the WAL then a memtable,
// which is flushed to immutable on-disk SSTables and periodically compacted.
type LSMTree struct {
	mu          sync.RWMutex
	memtable    *MemTable
	immutable   *MemTable // currently being flushed (nil otherwise)
	levels      [][]*SSTable
	wal         *WAL
	blockCache  *LRUCache
	dir         string
	maxMemBytes int64
	fileSeq     uint64
}

// NewLSMTree opens (or creates) an LSM tree rooted at dir.
func NewLSMTree(dir string, maxMemBytes int64) (*LSMTree, error) {
	if maxMemBytes <= 0 {
		maxMemBytes = defaultMemTableMaxBytes
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	wal, err := openWAL(dir)
	if err != nil {
		return nil, err
	}
	l := &LSMTree{
		memtable:    NewMemTable(),
		levels:      make([][]*SSTable, 1),
		wal:         wal,
		blockCache:  NewLRUCache(blockCacheEntries),
		dir:         dir,
		maxMemBytes: maxMemBytes,
	}
	if err := l.loadLevels(); err != nil {
		return nil, err
	}
	if err := l.replayWAL(); err != nil {
		return nil, err
	}
	return l, nil
}

// loadLevels reopens any SSTables left on disk, grouped by level from filename.
func (l *LSMTree) loadLevels() error {
	entries, err := filepath.Glob(filepath.Join(l.dir, "L*.sst"))
	if err != nil {
		return err
	}
	for _, path := range entries {
		base := filepath.Base(path)
		level := 0
		if strings.HasPrefix(base, "L") {
			if i := strings.IndexByte(base, '-'); i > 1 {
				level, _ = strconv.Atoi(base[1:i])
			}
		}
		sst, err := openSSTable(path)
		if err != nil {
			log.Printf("[lsm] skip bad sstable %s: %v", path, err)
			continue
		}
		for len(l.levels) <= level {
			l.levels = append(l.levels, nil)
		}
		l.levels[level] = append(l.levels[level], sst)
	}
	return nil
}

// replayWAL rebuilds the memtable from the write-ahead log after a restart.
func (l *LSMTree) replayWAL() error {
	records, err := l.wal.Replay()
	if err != nil {
		return err
	}
	for _, r := range records {
		e := &pb.StatEntry{}
		if err := proto.Unmarshal(r.Value, e); err != nil {
			continue
		}
		l.memtable.Put(r.Key, e)
	}
	if len(records) > 0 {
		log.Printf("[lsm] replayed %d WAL records into memtable", len(records))
	}
	return nil
}

// Write durably records an entry: WAL first (invariant), then memtable.
func (l *LSMTree) Write(entry *pb.StatEntry) error {
	key := entryKey(entry)
	val, err := proto.Marshal(entry)
	if err != nil {
		return err
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	seq, err := l.wal.Append(key, val) // WAL before memtable — never the reverse
	if err != nil {
		return err
	}
	l.memtable.Put(key, entry)
	_ = l.wal.Commit(seq)
	l.blockCache.Remove(key)

	if l.memtable.Size() > l.maxMemBytes {
		if err := l.flushLocked(); err != nil {
			return err
		}
	}
	return nil
}

// flushLocked writes the current memtable to a new L0 SSTable. Caller holds mu,
// which serializes flushes with writes so the WAL can be safely rotated.
func (l *LSMTree) flushLocked() error {
	if l.memtable.Len() == 0 {
		return nil
	}
	l.immutable = l.memtable
	l.memtable = NewMemTable()

	path := l.nextSSTablePath(0)
	sst, err := writeSSTable(path, l.immutable.SortedEntries())
	if err != nil {
		// Roll back the swap so data isn't lost.
		l.memtable = l.immutable
		l.immutable = nil
		return err
	}
	l.levels[0] = append(l.levels[0], sst)
	l.immutable = nil

	// Flushed data is now durable in the SSTable; the WAL can be truncated.
	if err := l.wal.Rotate(); err != nil {
		return err
	}
	log.Printf("[lsm] flushed memtable -> %s", filepath.Base(path))

	if len(l.levels[0]) > level0CompactThreshold {
		return l.compactLocked(0)
	}
	return nil
}

// compactLocked merges all SSTables at `level` (and the next level) into a
// single SSTable at level+1, deduplicating by vector clock.
func (l *LSMTree) compactLocked(level int) error {
	for len(l.levels) <= level+1 {
		l.levels = append(l.levels, nil)
	}
	sources := append([]*SSTable{}, l.levels[level]...)
	sources = append(sources, l.levels[level+1]...)
	if len(sources) == 0 {
		return nil
	}

	merged := make(map[string]*pb.StatEntry)
	for _, sst := range sources {
		all, err := sst.Scan(func(*pb.StatEntry) bool { return true })
		if err != nil {
			return err
		}
		for _, e := range all {
			k := entryKey(e)
			merged[k] = pickNewer(merged[k], e)
		}
	}
	entries := make([]*pb.StatEntry, 0, len(merged))
	for _, e := range merged {
		entries = append(entries, e)
	}

	path := l.nextSSTablePath(level + 1)
	newSST, err := writeSSTable(path, entries)
	if err != nil {
		return err
	}

	// Swap in the new SSTable and delete the old source files.
	for _, sst := range sources {
		old := sst.path
		_ = sst.Close()
		_ = os.Remove(old)
	}
	l.levels[level] = nil
	l.levels[level+1] = []*SSTable{newSST}
	log.Printf("[lsm] compacted L%d (%d tables) -> L%d (%d entries)", level, len(sources), level+1, len(entries))

	if len(l.levels[level+1]) > level0CompactThreshold {
		return l.compactLocked(level + 1)
	}
	return nil
}

func (l *LSMTree) nextSSTablePath(level int) string {
	seq := atomic.AddUint64(&l.fileSeq, 1)
	name := fmt.Sprintf("L%d-%d-%d.sst", level, time.Now().UnixNano(), seq)
	return filepath.Join(l.dir, name)
}

// Read returns the entry for key, searching memtable -> immutable -> SSTables
// (newest first) and resolving conflicts by vector clock.
func (l *LSMTree) Read(key string) (*pb.StatEntry, bool) {
	if cached, ok := l.blockCache.Get(key); ok {
		e := &pb.StatEntry{}
		if proto.Unmarshal(cached, e) == nil {
			return e, true
		}
	}

	l.mu.RLock()
	defer l.mu.RUnlock()

	var best *pb.StatEntry
	if e, ok := l.memtable.Get(key); ok {
		best = pickNewer(best, e)
	}
	if l.immutable != nil {
		if e, ok := l.immutable.Get(key); ok {
			best = pickNewer(best, e)
		}
	}
	for lvl := 0; lvl < len(l.levels); lvl++ {
		tables := l.levels[lvl]
		for i := len(tables) - 1; i >= 0; i-- { // newest first within a level
			e, ok, err := tables[i].Get(key)
			if err == nil && ok {
				best = pickNewer(best, e)
				if lvl > 0 {
					break // levels 1+ are non-overlapping; first hit suffices
				}
			}
		}
	}

	if best != nil {
		if val, err := proto.Marshal(best); err == nil {
			l.blockCache.Put(key, val)
		}
		return best, true
	}
	return nil, false
}

// Scan returns all entries matching the predicate across memtable and SSTables,
// keeping the newest version of each key.
func (l *LSMTree) Scan(match func(*pb.StatEntry) bool) []*pb.StatEntry {
	l.mu.RLock()
	defer l.mu.RUnlock()

	merged := make(map[string]*pb.StatEntry)
	collect := func(e *pb.StatEntry) {
		k := entryKey(e)
		merged[k] = pickNewer(merged[k], e)
	}
	for _, e := range l.memtable.Scan(match) {
		collect(e)
	}
	if l.immutable != nil {
		for _, e := range l.immutable.Scan(match) {
			collect(e)
		}
	}
	for _, tables := range l.levels {
		for _, sst := range tables {
			hits, err := sst.Scan(match)
			if err != nil {
				continue
			}
			for _, e := range hits {
				collect(e)
			}
		}
	}
	out := make([]*pb.StatEntry, 0, len(merged))
	for _, e := range merged {
		out = append(out, e)
	}
	return out
}

// Flush forces the current memtable to disk (used for clean shutdown / tests).
func (l *LSMTree) Flush() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.flushLocked()
}

// Close flushes and releases file handles.
func (l *LSMTree) Close() error {
	_ = l.Flush()
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, tables := range l.levels {
		for _, sst := range tables {
			_ = sst.Close()
		}
	}
	return l.wal.Close()
}

// Stats reports counts for metrics.
func (l *LSMTree) Stats() (memEntries, sstables int, levels int) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	memEntries = l.memtable.Len()
	for _, t := range l.levels {
		sstables += len(t)
	}
	return memEntries, sstables, len(l.levels)
}
