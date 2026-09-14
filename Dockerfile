FROM golang:1.26-alpine AS build
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /worldsplat .

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && addgroup -S worldsplat && adduser -S -G worldsplat worldsplat
WORKDIR /app
COPY --from=build /worldsplat /app/worldsplat
COPY client/ /app/client/
RUN mkdir /app/output && chown worldsplat:worldsplat /app/output
USER worldsplat
ENV WS_ADDR=:8067 WS_CLIENT_DIR=/app/client WS_DATA_DIR=/app/output
EXPOSE 8067
VOLUME ["/app/output"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD wget -q -O - http://127.0.0.1:8067/status || exit 1
CMD ["/app/worldsplat"]
