package main

import (
	"encoding/binary"
	"hash/fnv"
	"math"
)

// BloomFilter is a classic bit-array Bloom filter used to skip SSTables that
// cannot contain a key, avoiding wasted disk reads on the LSM read path.
type BloomFilter struct {
	bits  []uint64
	m     uint64 // number of bits
	k     uint32 // number of hash functions
	count uint64 // number of inserted elements (for stats)
}

// NewBloomFilter sizes a filter for n expected elements at false-positive rate p.
func NewBloomFilter(n int, p float64) *BloomFilter {
	if n < 1 {
		n = 1
	}
	if p <= 0 || p >= 1 {
		p = 0.01
	}
	// Optimal m and k for n elements at false-positive rate p.
	m := optimalM(n, p)
	k := optimalK(m, n)
	return &BloomFilter{
		bits: make([]uint64, (m+63)/64),
		m:    m,
		k:    k,
	}
}

func optimalM(n int, p float64) uint64 {
	// m = -(n * ln p) / (ln 2)^2
	ln2sq := math.Ln2 * math.Ln2
	m := uint64(-(float64(n) * math.Log(p)) / ln2sq)
	if m < 64 {
		m = 64
	}
	return m
}

func optimalK(m uint64, n int) uint32 {
	// k = (m/n) * ln 2
	k := uint32(float64(m) / float64(n) * math.Ln2)
	if k < 1 {
		k = 1
	}
	if k > 12 {
		k = 12
	}
	return k
}

// indices derives k bit positions from two base hashes (Kirsch-Mitzenmacher).
func (b *BloomFilter) indices(key string) []uint64 {
	h1 := fnv1a(key)
	h2 := fnv1a("salt:" + key)
	out := make([]uint64, b.k)
	for i := uint32(0); i < b.k; i++ {
		out[i] = (h1 + uint64(i)*h2) % b.m
	}
	return out
}

// Add inserts a key.
func (b *BloomFilter) Add(key string) {
	for _, idx := range b.indices(key) {
		b.bits[idx/64] |= 1 << (idx % 64)
	}
	b.count++
}

// MayContain reports whether key might be present (false => definitely absent).
func (b *BloomFilter) MayContain(key string) bool {
	for _, idx := range b.indices(key) {
		if b.bits[idx/64]&(1<<(idx%64)) == 0 {
			return false
		}
	}
	return true
}

func fnv1a(s string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(s))
	return h.Sum64()
}

// Marshal serializes the filter: [m u64][k u32][len u32][bits...].
func (b *BloomFilter) Marshal() []byte {
	buf := make([]byte, 8+4+4+len(b.bits)*8)
	binary.BigEndian.PutUint64(buf[0:8], b.m)
	binary.BigEndian.PutUint32(buf[8:12], b.k)
	binary.BigEndian.PutUint32(buf[12:16], uint32(len(b.bits)))
	for i, v := range b.bits {
		binary.BigEndian.PutUint64(buf[16+i*8:], v)
	}
	return buf
}

// UnmarshalBloom reconstructs a filter from Marshal output.
func UnmarshalBloom(buf []byte) *BloomFilter {
	if len(buf) < 16 {
		return NewBloomFilter(1, 0.01)
	}
	m := binary.BigEndian.Uint64(buf[0:8])
	k := binary.BigEndian.Uint32(buf[8:12])
	n := binary.BigEndian.Uint32(buf[12:16])
	bits := make([]uint64, n)
	for i := uint32(0); i < n; i++ {
		bits[i] = binary.BigEndian.Uint64(buf[16+int(i)*8:])
	}
	return &BloomFilter{bits: bits, m: m, k: k}
}
