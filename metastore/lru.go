package main

import (
	"container/list"
	"sync"
)

// LRUCache is a fixed-capacity, thread-safe LRU cache used as the LSM block /
// hot-entry cache to absorb repeated reads of the same key.
type LRUCache struct {
	mu       sync.Mutex
	capacity int
	ll       *list.List
	items    map[string]*list.Element
}

type lruEntry struct {
	key   string
	value []byte
}

// NewLRUCache creates a cache holding up to capacity entries.
func NewLRUCache(capacity int) *LRUCache {
	if capacity < 1 {
		capacity = 1
	}
	return &LRUCache{
		capacity: capacity,
		ll:       list.New(),
		items:    make(map[string]*list.Element),
	}
}

// Get returns the cached value and whether it was present, refreshing recency.
func (c *LRUCache) Get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.ll.MoveToFront(el)
		return el.Value.(*lruEntry).value, true
	}
	return nil, false
}

// Put inserts or updates a value, evicting the least-recently-used entry if full.
func (c *LRUCache) Put(key string, value []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.ll.MoveToFront(el)
		el.Value.(*lruEntry).value = value
		return
	}
	el := c.ll.PushFront(&lruEntry{key: key, value: value})
	c.items[key] = el
	if c.ll.Len() > c.capacity {
		c.evict()
	}
}

// Remove drops a key (used to invalidate after a write).
func (c *LRUCache) Remove(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.ll.Remove(el)
		delete(c.items, key)
	}
}

func (c *LRUCache) evict() {
	el := c.ll.Back()
	if el == nil {
		return
	}
	c.ll.Remove(el)
	delete(c.items, el.Value.(*lruEntry).key)
}
