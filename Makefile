# TFT Distributed Meta Analytics — developer tasks.
SHELL := /bin/bash
PY := .venv/bin/python
PIP := .venv/bin/pip
export PATH := /opt/homebrew/bin:$(HOME)/go/bin:$(PATH)

.PHONY: help setup proto build test go-test py-test chaos bench up down clean dashboard-dev

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS=":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## Create the Python venv and install all service deps
	python3 -m venv .venv
	$(PIP) install --upgrade pip
	$(PIP) install grpcio grpcio-tools protobuf numpy scipy aiohttp fastapi "uvicorn[standard]"

proto: ## Regenerate Go and Python protobuf bindings
	./scripts/gen_proto.sh

build: ## Build the Go service binaries into bin/
	go build -o bin/broker ./broker
	go build -o bin/metastore ./metastore

go-test: ## Run the Go unit tests (hasher, gossip, broker, metastore)
	go test ./...

py-test: ## Run Python logic checks (reorder buffer, aggregator, detector)
	$(PY) tests/unit_checks.py

test: go-test py-test ## Run all unit tests (Go + Python)

chaos: build ## Chaos test: kill the coordinator, prove zero data loss
	$(PY) -m tests.chaos_test

bench: build ## Benchmark: write throughput + read p99 + publish throughput
	$(PY) -m tests.benchmark

up: ## Start the whole stack in Docker
	docker compose up --build

down: ## Stop the stack
	docker compose down

dashboard-dev: ## Run the dashboard dev server (needs the API on :8000)
	cd dashboard && npm install && npm run dev

clean: ## Remove build artifacts and local runtime data
	rm -rf bin data dashboard/dist
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
