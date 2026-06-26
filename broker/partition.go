package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Partition is a single append-only log segment for one (topic, region, tier).
//
// On-disk record format (binary, big-endian):
//
//	[8 bytes: offset][4 bytes: length N][N bytes: payload]
//
// Offsets are contiguous and 0-based per partition. An in-memory index maps each
// offset to its starting byte position so Subscribe can seek in O(1).
type Partition struct {
	mu         sync.RWMutex
	key        string
	path       string
	logFile    *os.File
	index      []int64  // index[offset-baseOffset] = byte position of that record
	replicas   []string // replica node addresses for this partition
	offset     int64    // next offset to assign
	baseOffset int64    // lowest offset still retained (head trimmed below this)
	maxRecords int      // retention cap; 0 = unbounded

	// notify wakes blocked subscribers when a new record is appended.
	notify chan struct{}
}

const (
	headerSize = 12 // 8-byte offset + 4-byte length
)

func openPartition(dir, key string, maxRecords int) (*Partition, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, sanitize(key)+".log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	p := &Partition{
		key:        key,
		path:       path,
		logFile:    f,
		index:      make([]int64, 0, 1024),
		maxRecords: maxRecords,
		notify:     make(chan struct{}, 1),
	}
	if err := p.recover(); err != nil {
		f.Close()
		return nil, err
	}
	return p, nil
}

// recover scans the existing log to rebuild the offset->byte index and the
// next/base offsets. Because the head may have been trimmed, the first record's
// stored offset (not 0) determines baseOffset.
func (p *Partition) recover() error {
	if _, err := p.logFile.Seek(0, io.SeekStart); err != nil {
		return err
	}
	var pos int64
	first := true
	header := make([]byte, headerSize)
	for {
		if _, err := io.ReadFull(p.logFile, header); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				break // reached end / torn trailing write
			}
			return err
		}
		recordOffset := int64(binary.BigEndian.Uint64(header[0:8]))
		length := binary.BigEndian.Uint32(header[8:12])
		if first {
			p.baseOffset = recordOffset
			p.offset = recordOffset
			first = false
		}
		// Skip the payload bytes.
		if _, err := p.logFile.Seek(int64(length), io.SeekCurrent); err != nil {
			return err
		}
		p.index = append(p.index, pos)
		pos += headerSize + int64(length)
		p.offset++
	}
	// Position at end for appends.
	_, err := p.logFile.Seek(0, io.SeekEnd)
	return err
}

// Append writes payload as a new record and returns its assigned offset.
func (p *Partition) Append(payload []byte) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	off := p.offset
	buf := make([]byte, headerSize+len(payload))
	binary.BigEndian.PutUint64(buf[0:8], uint64(off))
	binary.BigEndian.PutUint32(buf[8:12], uint32(len(payload)))
	copy(buf[headerSize:], payload)

	pos, err := p.logFile.Seek(0, io.SeekEnd)
	if err != nil {
		return 0, err
	}
	if _, err := p.logFile.Write(buf); err != nil {
		return 0, err
	}
	p.index = append(p.index, pos)
	p.offset++

	// Retention: once the partition exceeds its cap, drop the oldest records
	// (down to 90% of the cap) so trims are infrequent and the log stays bounded.
	if p.maxRecords > 0 && len(p.index) > p.maxRecords {
		target := p.maxRecords - p.maxRecords/10
		if drop := len(p.index) - target; drop > 0 {
			_ = p.trimLocked(drop)
		}
	}

	// Wake any waiting subscribers (non-blocking).
	select {
	case p.notify <- struct{}{}:
	default:
	}
	return off, nil
}

// ReadAt returns the payload stored at the given offset.
func (p *Partition) ReadAt(offset int64) ([]byte, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if offset < p.baseOffset || offset >= p.offset {
		return nil, io.EOF
	}
	pos := p.index[offset-p.baseOffset]
	header := make([]byte, headerSize)
	if _, err := p.logFile.ReadAt(header, pos); err != nil {
		return nil, err
	}
	length := binary.BigEndian.Uint32(header[8:12])
	payload := make([]byte, length)
	if _, err := p.logFile.ReadAt(payload, pos+headerSize); err != nil {
		return nil, err
	}
	return payload, nil
}

// NextOffset returns the offset that will be assigned to the next append.
func (p *Partition) NextOffset() int64 {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.offset
}

// BaseOffset returns the lowest offset still retained (older data was trimmed).
func (p *Partition) BaseOffset() int64 {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.baseOffset
}

// trimLocked drops the oldest `drop` records by rewriting the log file without
// them. Record offsets are preserved (so consumers stay consistent); baseOffset
// advances and the index is rebased. Caller must hold p.mu.
func (p *Partition) trimLocked(drop int) error {
	if drop <= 0 || drop >= len(p.index) {
		return nil
	}
	startPos := p.index[drop] // byte position of the first retained record
	endPos, err := p.logFile.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}

	// Stream the retained bytes into a temp file, then atomically replace.
	tmp := p.path + ".tmp"
	tf, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(tf, io.NewSectionReader(p.logFile, startPos, endPos-startPos)); err != nil {
		tf.Close()
		os.Remove(tmp)
		return err
	}
	if err := tf.Sync(); err != nil {
		tf.Close()
		os.Remove(tmp)
		return err
	}
	tf.Close()
	p.logFile.Close()
	if err := os.Rename(tmp, p.path); err != nil {
		return err
	}
	f, err := os.OpenFile(p.path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		f.Close()
		return err
	}
	p.logFile = f

	// Rebase the index: shift positions and drop the trimmed prefix.
	newIndex := make([]int64, len(p.index)-drop)
	for i := drop; i < len(p.index); i++ {
		newIndex[i-drop] = p.index[i] - startPos
	}
	p.index = newIndex
	p.baseOffset += int64(drop)
	return nil
}

func (p *Partition) Close() error { return p.logFile.Close() }

// sanitize makes a partition key safe for use as a filename.
func sanitize(key string) string {
	out := make([]byte, 0, len(key))
	for i := 0; i < len(key); i++ {
		c := key[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' {
			out = append(out, c)
		} else {
			out = append(out, '_')
		}
	}
	return string(out)
}

// partitionKey builds the canonical "topic_region_tier" key.
func partitionKey(topic, region, tier string) string {
	if region == "" {
		region = "ALL"
	}
	if tier == "" {
		tier = "ALL"
	}
	return fmt.Sprintf("%s_%s_%s", topic, region, tier)
}

// splitKey reverses partitionKey. Topic names may themselves contain
// underscores (e.g. "raw_matches"), so region and tier are taken as the last
// two underscore-separated tokens and everything before is the topic.
func splitKey(key string) (topic, region, tier string) {
	last := strings.LastIndex(key, "_")
	if last < 0 {
		return key, "ALL", "ALL"
	}
	tier = key[last+1:]
	rest := key[:last]
	prev := strings.LastIndex(rest, "_")
	if prev < 0 {
		return rest, "ALL", tier
	}
	region = rest[prev+1:]
	topic = rest[:prev]
	return topic, region, tier
}
