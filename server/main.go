package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
	"google.golang.org/protobuf/types/known/durationpb"
	"worldsplat/internal/activities"
	"worldsplat/internal/api"
	"worldsplat/internal/assets"
	"worldsplat/internal/auth"
	"worldsplat/internal/config"
	"worldsplat/internal/pipeline"
	"worldsplat/internal/providers"
	"worldsplat/internal/store"
	"worldsplat/migrations"
)

func main() {
	if e := run(); e != nil {
		slog.Error("server stopped", "error", e)
		os.Exit(1)
	}
}
func run() error {
	mode := flag.String("mode", "all", "all, api, worker, migrate, or namespace")
	flag.Parse()
	c, e := config.Load()
	if e != nil {
		return e
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *mode == "namespace" {
		nc, e := client.NewNamespaceClient(client.Options{HostPort: c.TemporalAddress})
		if e != nil {
			return e
		}
		defer nc.Close()
		e = nc.Register(ctx, &workflowservice.RegisterNamespaceRequest{Namespace: c.TemporalNamespace, WorkflowExecutionRetentionPeriod: durationpb.New(30 * 24 * time.Hour)})
		var exists *serviceerror.NamespaceAlreadyExists
		if errors.As(e, &exists) {
			return nil
		}
		return e
	}
	if *mode != "all" && *mode != "api" && *mode != "worker" && *mode != "migrate" {
		return errors.New("invalid mode")
	}
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	db, e := pgxpool.New(startup, c.DatabaseURL)
	if e != nil {
		return e
	}
	defer db.Close()
	if e = migrations.Apply(startup, db); e != nil {
		return e
	}
	if *mode == "migrate" {
		return nil
	}
	opts, e := redis.ParseURL(c.RedisURL)
	if e != nil {
		return e
	}
	rc := redis.NewClient(opts)
	defer rc.Close()
	if e = rc.Ping(startup).Err(); e != nil {
		return e
	}
	tc, e := client.DialContext(startup, client.Options{HostPort: c.TemporalAddress, Namespace: c.TemporalNamespace})
	if e != nil {
		return e
	}
	defer tc.Close()
	if e = os.MkdirAll(c.DataDir, 0700); e != nil {
		return e
	}
	st := &store.Store{Pool: db}
	disk := assets.Store{Root: c.DataDir}
	httpClient := providers.HTTPClient()
	var wk worker.Worker
	if *mode == "all" || *mode == "worker" {
		wk = worker.New(tc, c.TaskQueue, worker.Options{MaxConcurrentActivityExecutionSize: 2, WorkerStopTimeout: 30 * time.Second})
		wk.RegisterWorkflowWithOptions(pipeline.Render, workflow.RegisterOptions{Name: pipeline.WorkflowName})
		wk.RegisterActivity(&activities.Activities{Store: st, Assets: disk, FAL: providers.FAL{Client: httpClient, BaseURL: c.FALURL, Model: c.FALModel, Key: c.FALKey}, Tripo: providers.Tripo{Client: httpClient, BaseURL: c.TripoURL, Steps: c.TripoSteps, Gaussians: c.TripoGaussians}})
		if e = wk.Start(); e != nil {
			return e
		}
		defer wk.Stop()
	}
	// The durable outbox is also polled in worker-only mode; duplicate starts are safe.
	dispatchDone := make(chan struct{})
	go func() { defer close(dispatchDone); pipeline.Dispatch(ctx, st, tc, c.TaskQueue) }()
	defer func() { stop(); <-dispatchDone }()
	if *mode == "worker" {
		<-ctx.Done()
		return nil
	}
	service := &api.Server{Config: c, Store: st, Auth: &auth.Service{Redis: rc, Users: st, Verifier: auth.Google{Audience: c.GoogleClientID}, TTL: c.SessionTTL}, Assets: disk, Temporal: tc}
	srv := &http.Server{Addr: c.Addr, Handler: service.Handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 2 * time.Minute, WriteTimeout: 3 * time.Minute, IdleTimeout: time.Minute, MaxHeaderBytes: 32 << 10}
	done := make(chan error, 1)
	go func() {
		slog.Info("WorldSplat listening", "address", c.Addr, "mode", *mode)
		done <- srv.ListenAndServe()
	}()
	select {
	case e = <-done:
		if errors.Is(e, http.ErrServerClosed) {
			return nil
		}
		return e
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return srv.Shutdown(shutdown)
	}
}
