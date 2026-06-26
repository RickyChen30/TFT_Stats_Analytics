package main

import (
	"fmt"
	"testing"
)

func TestPartitionRetentionTrim(t *testing.T) {
	dir := t.TempDir()
	// Cap at 100 records; trimming kicks in once exceeded.
	p, err := openPartition(dir, "raw_matches_NA_GOLD", 100)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 500; i++ {
		if _, err := p.Append([]byte(fmt.Sprintf("m-%d", i))); err != nil {
			t.Fatal(err)
		}
	}
	// Offsets stay monotonic; next offset is 500 regardless of trims.
	if p.NextOffset() != 500 {
		t.Fatalf("next offset = %d, want 500", p.NextOffset())
	}
	base := p.BaseOffset()
	if base == 0 {
		t.Fatal("expected the head to have been trimmed (baseOffset > 0)")
	}
	// Retained record count stays bounded near the cap.
	if retained := p.NextOffset() - base; retained > 100 {
		t.Fatalf("retained %d records, want <= 100", retained)
	}
	// The newest record is still readable at its original offset.
	got, err := p.ReadAt(499)
	if err != nil || string(got) != "m-499" {
		t.Fatalf("ReadAt(499) = %q, %v", got, err)
	}
	// A trimmed offset returns EOF.
	if _, err := p.ReadAt(base - 1); err == nil {
		t.Fatal("expected EOF reading a trimmed offset")
	}

	// Survives a restart: recovery rebuilds base/next from the trimmed file.
	p.Close()
	p2, err := openPartition(dir, "raw_matches_NA_GOLD", 100)
	if err != nil {
		t.Fatal(err)
	}
	defer p2.Close()
	if p2.NextOffset() != 500 || p2.BaseOffset() != base {
		t.Fatalf("after restart next=%d base=%d, want next=500 base=%d", p2.NextOffset(), p2.BaseOffset(), base)
	}
	if got, err := p2.ReadAt(499); err != nil || string(got) != "m-499" {
		t.Fatalf("post-restart ReadAt(499) = %q, %v", got, err)
	}
}

func TestPartitionAppendReadRecover(t *testing.T) {
	dir := t.TempDir()
	p, err := openPartition(dir, "raw_matches_NA_GOLD", 0)
	if err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 50; i++ {
		off, err := p.Append([]byte(fmt.Sprintf("msg-%d", i)))
		if err != nil {
			t.Fatal(err)
		}
		if off != int64(i) {
			t.Fatalf("want offset %d, got %d", i, off)
		}
	}
	got, err := p.ReadAt(7)
	if err != nil || string(got) != "msg-7" {
		t.Fatalf("ReadAt(7) = %q, %v", got, err)
	}
	p.Close()

	// Reopen and verify recovery rebuilt the index and next offset.
	p2, err := openPartition(dir, "raw_matches_NA_GOLD", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer p2.Close()
	if p2.NextOffset() != 50 {
		t.Fatalf("recovered next offset = %d, want 50", p2.NextOffset())
	}
	got, err = p2.ReadAt(49)
	if err != nil || string(got) != "msg-49" {
		t.Fatalf("post-recover ReadAt(49) = %q, %v", got, err)
	}
	off, _ := p2.Append([]byte("after-recover"))
	if off != 50 {
		t.Fatalf("append after recover got offset %d, want 50", off)
	}
}

func TestSplitKeyRoundTrip(t *testing.T) {
	cases := []struct{ topic, region, tier string }{
		{"raw_matches", "NA", "GOLD"},
		{"processed_stats", "EUW", "MASTER"},
		{"anomaly_alerts", "KR", "CHALLENGER"},
	}
	for _, c := range cases {
		key := partitionKey(c.topic, c.region, c.tier)
		topic, region, tier := splitKey(key)
		if topic != c.topic || region != c.region || tier != c.tier {
			t.Fatalf("splitKey(%q) = (%q,%q,%q), want (%q,%q,%q)",
				key, topic, region, tier, c.topic, c.region, c.tier)
		}
	}
}
