# Build context must be the repository root:
#   docker build -f metastore/Dockerfile -t tft-metastore .
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY proto ./proto
COPY hasher ./hasher
COPY gossip ./gossip
COPY metastore ./metastore
RUN CGO_ENABLED=0 go build -o /out/metastore ./metastore

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/metastore /metastore
ENTRYPOINT ["/metastore"]
