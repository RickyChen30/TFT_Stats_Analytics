#!/usr/bin/env bash
# Generate Go and Python gRPC bindings from proto/tft.proto.
set -euo pipefail
cd "$(dirname "$0")/.."

export PATH="/opt/homebrew/bin:$HOME/go/bin:$PATH"
PY=".venv/bin/python"

# Install the Go protoc plugins on demand so a fresh clone can regenerate the
# bindings with just Go + protoc + the Python venv present.
if ! command -v protoc-gen-go >/dev/null 2>&1; then
  echo "==> Installing protoc-gen-go"
  go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
fi
if ! command -v protoc-gen-go-grpc >/dev/null 2>&1; then
  echo "==> Installing protoc-gen-go-grpc"
  go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
fi

echo "==> Generating Go bindings"
protoc \
  --go_out=. --go_opt=module=github.com/tft-analytics \
  --go-grpc_out=. --go-grpc_opt=module=github.com/tft-analytics \
  proto/tft.proto

echo "==> Generating Python bindings"
mkdir -p gen/python
$PY -m grpc_tools.protoc \
  -Iproto \
  --python_out=gen/python \
  --grpc_python_out=gen/python \
  proto/tft.proto

# grpc_tools emits "import tft_pb2" which only resolves if gen/python is on
# sys.path. Each service inserts that dir; nothing further to rewrite.
touch gen/python/__init__.py
echo "==> Done"
