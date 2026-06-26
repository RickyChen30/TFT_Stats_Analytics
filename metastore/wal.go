package main

import (
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// WAL status values.
const (
	walPending   uint8 = 0
	walCommitted uint8 = 1
)

// WALEntry mirrors the on-disk write-ahead-log record.
type WALEntry struct {
	SequenceNum uint64
	Key         string
	Value       []byte
	Status      uint8
}

// WAL is an append-only write-ahead log guaranteeing that every memtable write
// is durably recorded first. After an SSTable flush the WAL is rotated (the
// flushed data is now durable on disk), keeping replay bounded.
//
// Record format (big-endian):
//
//	[seq u64][status u8][keyLen u32][key][valLen u32][value]
//
// A commit marker is the same record with status=COMMITTED and empty key/value.
type WAL struct {
	mu   sync.Mutex
	f    *os.File
	path string
	seq  uint64
}

func openWAL(dir string) (*WAL, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "wal.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &WAL{f: f, path: path}, nil
}

// Append writes a PENDING record for (key, value) and fsyncs before returning,
// so the WAL is guaranteed durable before the caller touches the memtable.
func (w *WAL) Append(key string, value []byte) (uint64, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.seq++
	seq := w.seq
	if err := w.writeRecord(seq, walPending, key, value); err != nil {
		return 0, err
	}
	if err := w.f.Sync(); err != nil {
		return 0, err
	}
	return seq, nil
}

// Commit appends a COMMITTED marker for seq (best-effort; not fsynced).
func (w *WAL) Commit(seq uint64) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.writeRecord(seq, walCommitted, "", nil)
}

func (w *WAL) writeRecord(seq uint64, status uint8, key string, value []byte) error {
	buf := make([]byte, 8+1+4+len(key)+4+len(value))
	binary.BigEndian.PutUint64(buf[0:8], seq)
	buf[8] = status
	binary.BigEndian.PutUint32(buf[9:13], uint32(len(key)))
	copy(buf[13:], key)
	off := 13 + len(key)
	binary.BigEndian.PutUint32(buf[off:off+4], uint32(len(value)))
	copy(buf[off+4:], value)
	_, err := w.f.Write(buf)
	return err
}

// Replay reads the WAL and returns the data records to re-apply. Records whose
// sequence was later committed are returned with Status=COMMITTED; the rest are
// PENDING. All un-flushed records are returned because the memtable is empty
// after a restart and must be fully reconstructed.
func (w *WAL) Replay() ([]WALEntry, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, err := w.f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}

	committed := map[uint64]bool{}
	var records []WALEntry
	header := make([]byte, 13)
	var maxSeq uint64
	for {
		if _, err := io.ReadFull(w.f, header); err != nil {
			break // EOF or torn tail
		}
		seq := binary.BigEndian.Uint64(header[0:8])
		status := header[8]
		keyLen := binary.BigEndian.Uint32(header[9:13])
		key := make([]byte, keyLen)
		if _, err := io.ReadFull(w.f, key); err != nil {
			break
		}
		lenBuf := make([]byte, 4)
		if _, err := io.ReadFull(w.f, lenBuf); err != nil {
			break
		}
		valLen := binary.BigEndian.Uint32(lenBuf)
		val := make([]byte, valLen)
		if _, err := io.ReadFull(w.f, val); err != nil {
			break
		}
		if seq > maxSeq {
			maxSeq = seq
		}
		if status == walCommitted {
			committed[seq] = true
			continue
		}
		records = append(records, WALEntry{SequenceNum: seq, Key: string(key), Value: val, Status: walPending})
	}

	for i := range records {
		if committed[records[i].SequenceNum] {
			records[i].Status = walCommitted
		}
	}
	w.seq = maxSeq
	_, _ = w.f.Seek(0, io.SeekEnd)
	return records, nil
}

// Rotate truncates the WAL after a successful SSTable flush.
func (w *WAL) Rotate() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.f.Truncate(0); err != nil {
		return err
	}
	if _, err := w.f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	w.seq = 0
	return w.f.Sync()
}

func (w *WAL) Close() error { return w.f.Close() }
