package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"worldsketch/server/internal/config"
	"worldsketch/server/internal/handlers"
	"worldsketch/server/internal/httpx"
)

func main() {
	config.LoadDotEnv()

	mux := http.NewServeMux()
	handlers.Register(mux)

	clientDir := filepath.Join(config.RootDir(), "client")
	mux.Handle("/", httpx.StaticHeaders(http.FileServer(http.Dir(clientDir))))
	// The Hugging Face sign-in page; mirrors the /login rewrite in vercel.json.
	mux.Handle("/login", httpx.StaticHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(clientDir, "login.html"))
	})))

	addr := config.Env("PORT", "8067")
	log.Printf("WorldSketch listening on http://localhost:%s", addr)
	server := &http.Server{
		Addr:              ":" + addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	stop, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-stop.Done()
		ctx, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
