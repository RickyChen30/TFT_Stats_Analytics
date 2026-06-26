package gossip

import (
	"testing"
	"time"
)

func TestTwoNodesDiscover(t *testing.T) {
	a, err := New("127.0.0.1:17946", []string{"127.0.0.1:17947"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	b, err := New("127.0.0.1:17947", []string{"127.0.0.1:17946"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	a.Start()
	b.Start()
	defer a.Stop()
	defer b.Stop()

	// After a couple of gossip rounds, each should consider the other alive.
	time.Sleep(3 * time.Second)
	if !a.IsAlive("127.0.0.1:17947") {
		t.Fatal("a should see b as alive")
	}
	if !b.IsAlive("127.0.0.1:17946") {
		t.Fatal("b should see a as alive")
	}
}

func TestMergeRefutesFalseSuspicion(t *testing.T) {
	g, err := New("127.0.0.1:17950", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Stop()
	// A peer claims we are dead at incarnation 0; we must bump past it.
	g.merge([]*MemberState{{Addr: "127.0.0.1:17950", Status: StatusDead, Incarnation: 0}})
	if g.incarnation == 0 {
		t.Fatal("expected incarnation to advance to refute false death")
	}
}
