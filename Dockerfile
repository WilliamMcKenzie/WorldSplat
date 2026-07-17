FROM golang:1.23-alpine AS build
WORKDIR /src/server
COPY server/go.mod ./
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /worldsketch .

FROM alpine:3.21
RUN addgroup -S worldsketch && adduser -S -G worldsketch worldsketch
WORKDIR /app
COPY --from=build /worldsketch /app/worldsketch
COPY client/ /app/client/
USER worldsketch
ENV PORT=8067
EXPOSE 8067
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O - "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["/app/worldsketch"]
