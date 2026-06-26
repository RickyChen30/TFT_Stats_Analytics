package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"sort"

	pb "github.com/tft-analytics/proto"
	"google.golang.org/protobuf/proto"
)

const ssTableMagic uint64 = 0x7466745353544142 // "tftSSTAB"

// SSTable is an immutable on-disk sorted string table.
//
// File layout:
//
//	[data:  repeated [keyLen u32][key][valLen u32][value(proto StatEntry)]]
//	[index: [count u32] repeated [keyLen u32][key][dataOffset u64]]
//	[bloom: marshalled BloomFilter]
//	[footer (40 bytes): indexOff u64 | indexLen u64 | bloomOff u64 | bloomLen u64 | magic u64]
type SSTable struct {
	path        string
	bloomFilter *BloomFilter
	index       map[string]int64 // key -> byte offset of the record in the data section
	sortedKeys  []string         // for ordered range scans
	f           *os.File
}

// entryKey is the canonical primary key for a StatEntry.
func entryKey(e *pb.StatEntry) string {
	return fmt.Sprintf("%s:%s:%s:%s", e.EntityId, e.Patch, e.Tier, e.Region)
}

// writeSSTable flushes sorted entries to a new SSTable file at path.
func writeSSTable(path string, entries []*pb.StatEntry) (*SSTable, error) {
	sort.Slice(entries, func(i, j int) bool { return entryKey(entries[i]) < entryKey(entries[j]) })

	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	bloom := NewBloomFilter(len(entries), 0.01)
	index := make(map[string]int64, len(entries))
	sortedKeys := make([]string, 0, len(entries))

	var pos int64
	for _, e := range entries {
		key := entryKey(e)
		val, err := proto.Marshal(e)
		if err != nil {
			return nil, err
		}
		rec := make([]byte, 4+len(key)+4+len(val))
		binary.BigEndian.PutUint32(rec[0:4], uint32(len(key)))
		copy(rec[4:], key)
		off := 4 + len(key)
		binary.BigEndian.PutUint32(rec[off:off+4], uint32(len(val)))
		copy(rec[off+4:], val)
		if _, err := f.Write(rec); err != nil {
			return nil, err
		}
		index[key] = pos
		sortedKeys = append(sortedKeys, key)
		bloom.Add(key)
		pos += int64(len(rec))
	}

	// Index section.
	indexOff := pos
	idxBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(idxBuf, uint32(len(sortedKeys)))
	for _, key := range sortedKeys {
		entry := make([]byte, 4+len(key)+8)
		binary.BigEndian.PutUint32(entry[0:4], uint32(len(key)))
		copy(entry[4:], key)
		binary.BigEndian.PutUint64(entry[4+len(key):], uint64(index[key]))
		idxBuf = append(idxBuf, entry...)
	}
	if _, err := f.Write(idxBuf); err != nil {
		return nil, err
	}

	// Bloom section.
	bloomOff := indexOff + int64(len(idxBuf))
	bloomBuf := bloom.Marshal()
	if _, err := f.Write(bloomBuf); err != nil {
		return nil, err
	}

	// Footer.
	footer := make([]byte, 40)
	binary.BigEndian.PutUint64(footer[0:8], uint64(indexOff))
	binary.BigEndian.PutUint64(footer[8:16], uint64(len(idxBuf)))
	binary.BigEndian.PutUint64(footer[16:24], uint64(bloomOff))
	binary.BigEndian.PutUint64(footer[24:32], uint64(len(bloomBuf)))
	binary.BigEndian.PutUint64(footer[32:40], ssTableMagic)
	if _, err := f.Write(footer); err != nil {
		return nil, err
	}
	if err := f.Sync(); err != nil {
		return nil, err
	}

	return openSSTable(path)
}

// openSSTable loads an SSTable's index and bloom filter into memory.
func openSSTable(path string) (*SSTable, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if fi.Size() < 40 {
		f.Close()
		return nil, fmt.Errorf("sstable %s too small", path)
	}

	footer := make([]byte, 40)
	if _, err := f.ReadAt(footer, fi.Size()-40); err != nil {
		f.Close()
		return nil, err
	}
	if binary.BigEndian.Uint64(footer[32:40]) != ssTableMagic {
		f.Close()
		return nil, fmt.Errorf("sstable %s bad magic", path)
	}
	indexOff := int64(binary.BigEndian.Uint64(footer[0:8]))
	indexLen := int64(binary.BigEndian.Uint64(footer[8:16]))
	bloomOff := int64(binary.BigEndian.Uint64(footer[16:24]))
	bloomLen := int64(binary.BigEndian.Uint64(footer[24:32]))

	idxBuf := make([]byte, indexLen)
	if _, err := f.ReadAt(idxBuf, indexOff); err != nil {
		f.Close()
		return nil, err
	}
	bloomBuf := make([]byte, bloomLen)
	if _, err := f.ReadAt(bloomBuf, bloomOff); err != nil {
		f.Close()
		return nil, err
	}

	count := binary.BigEndian.Uint32(idxBuf[0:4])
	index := make(map[string]int64, count)
	sortedKeys := make([]string, 0, count)
	p := 4
	for i := uint32(0); i < count; i++ {
		keyLen := int(binary.BigEndian.Uint32(idxBuf[p : p+4]))
		p += 4
		key := string(idxBuf[p : p+keyLen])
		p += keyLen
		off := int64(binary.BigEndian.Uint64(idxBuf[p : p+8]))
		p += 8
		index[key] = off
		sortedKeys = append(sortedKeys, key)
	}

	return &SSTable{
		path:        path,
		bloomFilter: UnmarshalBloom(bloomBuf),
		index:       index,
		sortedKeys:  sortedKeys,
		f:           f,
	}, nil
}

// Get returns the entry for key, using the bloom filter to skip absent keys.
func (s *SSTable) Get(key string) (*pb.StatEntry, bool, error) {
	if !s.bloomFilter.MayContain(key) {
		return nil, false, nil
	}
	off, ok := s.index[key]
	if !ok {
		return nil, false, nil
	}
	return s.readAt(off)
}

func (s *SSTable) readAt(off int64) (*pb.StatEntry, bool, error) {
	lenBuf := make([]byte, 4)
	if _, err := s.f.ReadAt(lenBuf, off); err != nil {
		return nil, false, err
	}
	keyLen := int64(binary.BigEndian.Uint32(lenBuf))
	valLenBuf := make([]byte, 4)
	if _, err := s.f.ReadAt(valLenBuf, off+4+keyLen); err != nil {
		return nil, false, err
	}
	valLen := int64(binary.BigEndian.Uint32(valLenBuf))
	val := make([]byte, valLen)
	if _, err := s.f.ReadAt(val, off+4+keyLen+4); err != nil {
		return nil, false, err
	}
	e := &pb.StatEntry{}
	if err := proto.Unmarshal(val, e); err != nil {
		return nil, false, err
	}
	return e, true, nil
}

// Scan returns all entries matching the predicate.
func (s *SSTable) Scan(match func(*pb.StatEntry) bool) ([]*pb.StatEntry, error) {
	var out []*pb.StatEntry
	for _, key := range s.sortedKeys {
		e, ok, err := s.readAt(s.index[key])
		if err != nil {
			return nil, err
		}
		if ok && match(e) {
			out = append(out, e)
		}
	}
	return out, nil
}

func (s *SSTable) Close() error { return s.f.Close() }
