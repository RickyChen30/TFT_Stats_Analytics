# Build context must be the repository root (the Go module lives there):
#   docker build -f broker/Dockerfile -t tft-broker .
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY proto ./proto
COPY hasher ./hasher
COPY gossip ./gossip
COPY broker ./broker
RUN CGO_ENABLED=0 go build -o /out/broker ./broker

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/broker /broker
ENTRYPOINT ["/broker"]
