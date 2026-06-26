// Command metastore runs a single node of the sharded, replicated LSM-tree
// meta store. Shards are placed by consistent hashing on entity_id and
// replicated 3x with quorum reads/writes (W=2, R=2). Patch data is never
// hard-deleted — superseded patches are exponentially decayed on read.
package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/tft-analytics/gossip"
	pb "github.com/tft-analytics/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	nodeID := getenv("NODE_ID", "metastore-1")
	grpcPort := getenv("GRPC_PORT", "50052")
	dataDir := getenv("DATA_DIR", "./data/"+nodeID)
	self := getenv("SELF", "metastore-1:50052")
	peersEnv := getenv("PEERS", "")

	var maxMem int64 = defaultMemTableMaxBytes
	if v := os.Getenv("MEMTABLE_MAX_BYTES"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			maxMem = n
		}
	}

	peers := []string{self}
	for _, p := range strings.Split(peersEnv, ",") {
		if p = strings.TrimSpace(p); p != "" {
			peers = append(peers, p)
		}
	}

	lsm, err := NewLSMTree(dataDir, maxMem)
	if err != nil {
		log.Fatalf("lsm open: %v", err)
	}
	defer lsm.Close()

	g, err := gossip.New(self, peers, gossip.DefaultGossipPortOffset)
	if err != nil {
		log.Fatalf("gossip init: %v", err)
	}

	srv := NewServer(nodeID, self, lsm, peers, g)
	// Gossip reports dead members by their gRPC identity — the same identity the
	// ring uses — so re-replication can act on it directly.
	g.OnDead(func(deadAddr string) { srv.onPeerDead(deadAddr) })
	g.Start()

	// Best-effort: learn about new patches from the broker's patch_events topic.
	if brokerAddr := os.Getenv("BROKER_ADDR"); brokerAddr != "" {
		go subscribePatchEvents(brokerAddr, srv)
	}

	go serveMetrics(getenv("METRICS_PORT", "9102"), srv)

	lis, err := net.Listen("tcp", ":"+grpcPort)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	gsrv := grpc.NewServer(grpc.MaxRecvMsgSize(32 * 1024 * 1024))
	pb.RegisterMetaStoreServer(gsrv, srv)
	log.Printf("[metastore] %s gRPC :%s data=%s peers=%v", nodeID, grpcPort, dataDir, peers)
	if err := gsrv.Serve(lis); err != nil {
		log.Fatalf("serve: %v", err)
	}
}


// subscribePatchEvents tails the patch_events topic and notifies the server of
// newly announced patch versions. Payloads are plain patch strings.
func subscribePatchEvents(brokerAddr string, srv *Server) {
	for {
		conn, err := grpc.NewClient(brokerAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			time.Sleep(5 * time.Second)
			continue
		}
		client := pb.NewBrokerClient(conn)
		stream, err := client.Subscribe(context.Background(), &pb.SubscribeRequest{
			Topic: "patch_events", ConsumerGroup: "metastore", Offset: 0,
		})
		if err != nil {
			conn.Close()
			time.Sleep(5 * time.Second)
			continue
		}
		for {
			msg, err := stream.Recv()
			if err != nil {
				break
			}
			patch := string(msg.Payload)
			log.Printf("[metastore] patch_events: %s", patch)
			srv.NotifyPatch(patch)
		}
		conn.Close()
		time.Sleep(5 * time.Second)
	}
}

func serveMetrics(port string, srv *Server) {
	http.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		mem, ssts, levels := srv.lsm.Stats()
		srv.patchMu.RLock()
		cur := srv.currentPatch
		srv.patchMu.RUnlock()
		fmt.Fprintf(w, "# HELP metastore_memtable_entries Entries in the active memtable\n")
		fmt.Fprintf(w, "# TYPE metastore_memtable_entries gauge\n")
		fmt.Fprintf(w, "metastore_memtable_entries{node=%q} %d\n", srv.nodeID, mem)
		fmt.Fprintf(w, "metastore_sstables{node=%q} %d\n", srv.nodeID, ssts)
		fmt.Fprintf(w, "metastore_levels{node=%q} %d\n", srv.nodeID, levels)
		fmt.Fprintf(w, "metastore_current_patch{node=%q,patch=%q} 1\n", srv.nodeID, cur)
	})
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	})
	_ = http.ListenAndServe(":"+port, nil)
}
