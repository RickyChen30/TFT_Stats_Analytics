package main

import pb "github.com/tft-analytics/proto"

// Vector-clock helpers for conflict resolution on quorum reads. When two
// replicas disagree on a key, the entry whose vector clock dominates wins; if
// the clocks are concurrent we fall back to the larger total event count and
// then to the larger sample size.

func clockMap(vc *pb.VectorClock) map[string]int64 {
	if vc == nil {
		return nil
	}
	return vc.Clocks
}

// vcSum totals all node counters in the clock — a coarse total-order key.
func vcSum(vc *pb.VectorClock) int64 {
	var s int64
	for _, v := range clockMap(vc) {
		s += v
	}
	return s
}

// vcDominates reports whether a >= b on every component (a is causally >= b).
func vcDominates(a, b *pb.VectorClock) bool {
	am, bm := clockMap(a), clockMap(b)
	for node, bv := range bm {
		if am[node] < bv {
			return false
		}
	}
	return true
}

// pickNewer returns whichever StatEntry should win a conflict. A nil entry loses.
func pickNewer(a, b *pb.StatEntry) *pb.StatEntry {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	aDom := vcDominates(a.Clock, b.Clock)
	bDom := vcDominates(b.Clock, a.Clock)
	switch {
	case aDom && !bDom:
		return a
	case bDom && !aDom:
		return b
	}
	// Concurrent (or equal) clocks: break ties deterministically.
	if sa, sb := vcSum(a.Clock), vcSum(b.Clock); sa != sb {
		if sa > sb {
			return a
		}
		return b
	}
	if a.SampleSize >= b.SampleSize {
		return a
	}
	return b
}

// mergeClocks returns the component-wise maximum of two clocks.
func mergeClocks(a, b *pb.VectorClock) *pb.VectorClock {
	out := map[string]int64{}
	for k, v := range clockMap(a) {
		out[k] = v
	}
	for k, v := range clockMap(b) {
		if v > out[k] {
			out[k] = v
		}
	}
	return &pb.VectorClock{Clocks: out}
}
