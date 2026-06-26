package hasher

import (
	"fmt"
	"testing"
)

func TestGetNodeStable(t *testing.T) {
	r := New(150)
	r.AddNode("a:1")
	r.AddNode("b:1")
	r.AddNode("c:1")

	key := "NA_GOLD"
	first := r.GetNode(key)
	if first == "" {
		t.Fatal("expected a node")
	}
	for i := 0; i < 100; i++ {
		if r.GetNode(key) != first {
			t.Fatal("GetNode should be deterministic")
		}
	}
}

func TestGetNodesDistinct(t *testing.T) {
	r := New(150)
	for _, n := range []string{"a", "b", "c", "d"} {
		r.AddNode(n)
	}
	nodes := r.GetNodes("EUW_MASTER", 3)
	if len(nodes) != 3 {
		t.Fatalf("want 3 replicas, got %d", len(nodes))
	}
	seen := map[string]bool{}
	for _, n := range nodes {
		if seen[n] {
			t.Fatalf("duplicate replica %s", n)
		}
		seen[n] = true
	}
}

func TestRemoveNodeMinimalDisruption(t *testing.T) {
	r := New(150)
	for _, n := range []string{"a", "b", "c", "d", "e"} {
		r.AddNode(n)
	}
	const total = 10000
	before := make([]string, total)
	for i := 0; i < total; i++ {
		before[i] = r.GetNode(fmt.Sprintf("key-%d", i))
	}
	r.RemoveNode("c")
	moved := 0
	for i := 0; i < total; i++ {
		now := r.GetNode(fmt.Sprintf("key-%d", i))
		if before[i] != now {
			moved++
		}
	}
	// Removing 1 of 5 nodes should remap roughly 1/5 of keys; allow generous slack.
	if moved > total/2 {
		t.Fatalf("too many keys moved: %d/%d", moved, total)
	}
}

func TestEmptyRing(t *testing.T) {
	r := New(0)
	if r.GetNode("x") != "" {
		t.Fatal("empty ring should return empty string")
	}
	if r.GetNodes("x", 3) != nil {
		t.Fatal("empty ring should return nil replicas")
	}
}
