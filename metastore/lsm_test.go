package main

import (
	"fmt"
	"testing"
	"time"

	pb "github.com/tft-analytics/proto"
)

func mkEntry(id, patch, tier string, sample int64, clock map[string]int64) *pb.StatEntry {
	return &pb.StatEntry{
		EntityId:   id,
		EntityType: "champion",
		Patch:      patch,
		Region:     "NA",
		Tier:       tier,
		WinRate:    0.55,
		AvgPlacement: 4.2,
		SampleSize: sample,
		Clock:      &pb.VectorClock{Clocks: clock},
	}
}

func TestLSMWriteReadFlushCompact(t *testing.T) {
	dir := t.TempDir()
	// Tiny memtable so we exercise flush + compaction quickly.
	l, err := NewLSMTree(dir, 2048)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2000; i++ {
		e := mkEntry(fmt.Sprintf("champ-%d", i), "14.1", "GOLD", int64(200+i), map[string]int64{"n1": int64(i)})
		if err := l.Write(e); err != nil {
			t.Fatal(err)
		}
	}
	// Spot-check reads across what should now be several SSTables.
	for _, i := range []int{0, 7, 999, 1999} {
		key := fmt.Sprintf("champ-%d:14.1:GOLD:NA", i)
		got, ok := l.Read(key)
		if !ok {
			t.Fatalf("missing key %s", key)
		}
		if got.SampleSize != int64(200+i) {
			t.Fatalf("key %s sample = %d, want %d", key, got.SampleSize, 200+i)
		}
	}
	_, ssts, _ := l.Stats()
	if ssts == 0 {
		t.Fatal("expected at least one SSTable after flushes")
	}
}

func TestLSMVectorClockConflict(t *testing.T) {
	dir := t.TempDir()
	l, _ := NewLSMTree(dir, 1<<20)
	key := "champ-x:14.1:GOLD:NA"
	l.Write(mkEntry("champ-x", "14.1", "GOLD", 300, map[string]int64{"n1": 5}))
	// Older clock should NOT overwrite the newer one.
	l.Write(mkEntry("champ-x", "14.1", "GOLD", 999, map[string]int64{"n1": 2}))
	got, _ := l.Read(key)
	if got.SampleSize != 300 {
		t.Fatalf("stale write won conflict: sample=%d", got.SampleSize)
	}
	// A strictly-newer clock should win.
	l.Write(mkEntry("champ-x", "14.1", "GOLD", 777, map[string]int64{"n1": 9}))
	got, _ = l.Read(key)
	if got.SampleSize != 777 {
		t.Fatalf("newer write lost conflict: sample=%d", got.SampleSize)
	}
}

func TestWALRecovery(t *testing.T) {
	dir := t.TempDir()
	l, _ := NewLSMTree(dir, 1<<30) // never flush, so data only lives in WAL+memtable
	for i := 0; i < 100; i++ {
		l.Write(mkEntry(fmt.Sprintf("c-%d", i), "14.1", "GOLD", int64(250+i), map[string]int64{"n1": int64(i)}))
	}
	// Simulate crash: drop the in-memory tree WITHOUT flushing, reopen from disk.
	l.wal.Close()

	l2, err := NewLSMTree(dir, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	defer l2.Close()
	got, ok := l2.Read("c-42:14.1:GOLD:NA")
	if !ok || got.SampleSize != 292 {
		t.Fatalf("WAL recovery failed: ok=%v entry=%v", ok, got)
	}
}

func TestScanFilter(t *testing.T) {
	dir := t.TempDir()
	l, _ := NewLSMTree(dir, 1<<20)
	l.Write(mkEntry("champ-a", "14.1", "GOLD", 300, map[string]int64{"n": 1}))
	l.Write(mkEntry("champ-b", "14.1", "MASTER", 300, map[string]int64{"n": 1}))
	gold := l.Scan(func(e *pb.StatEntry) bool { return e.Tier == "GOLD" })
	if len(gold) != 1 || gold[0].EntityId != "champ-a" {
		t.Fatalf("scan tier filter failed: %v", gold)
	}
}

func TestDecaySampleSize(t *testing.T) {
	// 0.85^2 ≈ 0.7225, so 1000 -> ~722 after 2 days.
	got := decayedSampleSize(1000, 48*time.Hour)
	if got < 700 || got > 740 {
		t.Fatalf("decay over 2 days = %d, want ~722", got)
	}
	if decayedSampleSize(1000, 0) != 1000 {
		t.Fatal("no decay expected at age 0")
	}
}

func TestBloomFilterNoFalseNegatives(t *testing.T) {
	bf := NewBloomFilter(1000, 0.01)
	for i := 0; i < 1000; i++ {
		bf.Add(fmt.Sprintf("k-%d", i))
	}
	for i := 0; i < 1000; i++ {
		if !bf.MayContain(fmt.Sprintf("k-%d", i)) {
			t.Fatalf("false negative for k-%d", i)
		}
	}
}
