package main

import (
	"sync"
	"time"
)

// TokenBucket is a simple per-consumer rate limiter used for backpressure.
// It refills `rate` tokens per second up to a burst capacity of `rate`.
type TokenBucket struct {
	mu       sync.Mutex
	tokens   float64
	rate     float64
	capacity float64
	last     time.Time
}

// NewTokenBucket creates a bucket allowing up to ratePerSec events per second.
func NewTokenBucket(ratePerSec float64) *TokenBucket {
	return &TokenBucket{
		tokens:   ratePerSec,
		rate:     ratePerSec,
		capacity: ratePerSec,
		last:     time.Now(),
	}
}

// Take blocks until a token is available, then consumes it. This is how the
// broker caps delivery at 1000 msgs/sec per consumer.
func (b *TokenBucket) Take() {
	for {
		b.mu.Lock()
		b.refill()
		if b.tokens >= 1 {
			b.tokens--
			b.mu.Unlock()
			return
		}
		// Time until the next token becomes available.
		deficit := 1 - b.tokens
		wait := time.Duration(deficit / b.rate * float64(time.Second))
		b.mu.Unlock()
		if wait < time.Millisecond {
			wait = time.Millisecond
		}
		time.Sleep(wait)
	}
}

func (b *TokenBucket) refill() {
	now := time.Now()
	elapsed := now.Sub(b.last).Seconds()
	b.last = now
	b.tokens += elapsed * b.rate
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}
}
