// Command broker runs a single append-only-log message broker node.
//
// Topics (raw_matches, processed_stats, patch_events, anomaly_alerts) are
// partitioned by region_tier and replicated across broker nodes via a consistent
// hash ring. Gossip detects node death and triggers re-replication.
package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/tft-analytics/gossip"
	pb "github.com/tft-analytics/proto"
	"google.golang.org/grpc"
)

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	nodeID := getenv("NODE_ID", "broker-1")
	grpcPort := getenv("GRPC_PORT", "50051")
	dataDir := getenv("DATA_DIR", "./data/"+nodeID)
	// SELF is this broker's externally reachable gRPC address (host:port). It is
	// the node's identity for the hash ring and gossip; gossip transports over
	// UDP on grpcPort+offset.
	self := getenv("SELF", "broker-1:50051")
	// PEERS is a comma-separated list of peer gRPC addresses (excluding self).
	peersEnv := getenv("PEERS", "")

	peers := []string{self}
	for _, p := range strings.Split(peersEnv, ",") {
		if p = strings.TrimSpace(p); p != "" {
			peers = append(peers, p)
		}
	}

	g, err := gossip.New(self, peers, gossip.DefaultGossipPortOffset)
	if err != nil {
		log.Fatalf("gossip init: %v", err)
	}

	// Per-partition log retention cap (records). Keeps the append-only logs
	// bounded so continuous ingestion does not fill the disk. 0 = unbounded.
	maxRecords := 100000
	if v := os.Getenv("MAX_RECORDS_PER_PARTITION"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			maxRecords = n
		}
	}

	b := NewBroker(nodeID, self, dataDir, self, peers, g, maxRecords)

	// Gossip reports dead members by their gRPC identity, exactly what the
	// broker needs to recompute replica placement.
	g.OnDead(func(deadAddr string) { b.onPeerDead(deadAddr) })
	g.Start()

	go serveMetrics(getenv("METRICS_PORT", "9101"), b)

	lis, err := net.Listen("tcp", ":"+grpcPort)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	srv := grpc.NewServer(grpc.MaxRecvMsgSize(16 * 1024 * 1024))
	pb.RegisterBrokerServer(srv, b)
	log.Printf("[broker] %s gRPC :%s data=%s peers=%v", nodeID, grpcPort, dataDir, peers)
	if err := srv.Serve(lis); err != nil {
		log.Fatalf("serve: %v", err)
	}
}

// serveMetrics exposes a minimal Prometheus-style metrics endpoint.
func serveMetrics(port string, b *Broker) {
	http.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		b.mu.RLock()
		defer b.mu.RUnlock()
		fmt.Fprintf(w, "# HELP broker_partitions Number of partitions hosted\n")
		fmt.Fprintf(w, "# TYPE broker_partitions gauge\n")
		fmt.Fprintf(w, "broker_partitions{node=%q} %d\n", b.nodeID, len(b.partitions))
		var total int64
		for key, p := range b.partitions {
			n := p.NextOffset()
			total += n
			fmt.Fprintf(w, "broker_partition_offset{node=%q,partition=%q} %d\n", b.nodeID, key, n)
		}
		fmt.Fprintf(w, "broker_messages_total{node=%q} %d\n", b.nodeID, total)
	})
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	})
	log.Printf("[broker] metrics on :%s/metrics", port)
	_ = http.ListenAndServe(":"+port, nil)
}
