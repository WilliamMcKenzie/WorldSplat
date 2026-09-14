package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	enumspb "go.temporal.io/api/enums/v1"
	taskqueuepb "go.temporal.io/api/taskqueue/v1"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	"worldsplat/internal/assets"
	"worldsplat/internal/auth"
	"worldsplat/internal/config"
	"worldsplat/internal/model"
	"worldsplat/internal/store"
)

type Server struct {
	Config       config.Config
	Store        *store.Store
	Auth         *auth.Service
	Assets       assets.Store
	Temporal     client.Client
	loginLimiter limiter
}

func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func failure(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]string{"error": message})
}
func internal(w http.ResponseWriter, e error) {
	slog.Error("API operation failed", "error", e)
	failure(w, 503, "service temporarily unavailable")
}
func token(r *http.Request, body string) string {
	h := r.Header.Get("Authorization")
	if h != "" {
		if !strings.HasPrefix(h, "Bearer ") {
			return ""
		}
		return strings.TrimPrefix(h, "Bearer ")
	}
	return body
}
func (s *Server) session(w http.ResponseWriter, r *http.Request, body string) (string, bool) {
	id, e := s.Auth.Session(r.Context(), token(r, body))
	if e != nil {
		if errors.Is(e, auth.ErrUnauthorized) {
			failure(w, 401, e.Error())
		} else {
			internal(w, e)
		}
		return "", false
	}
	return id, true
}
func decode(w http.ResponseWriter, r *http.Request, max int64, v any) bool {
	mt, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if e != nil || mt != "application/json" {
		failure(w, 415, "Content-Type must be application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, max)
	if e = model.StrictJSON(r.Body, v); e != nil {
		var limit *http.MaxBytesError
		if errors.As(e, &limit) {
			failure(w, 413, "request body too large")
		} else {
			failure(w, 400, "invalid JSON: "+e.Error())
		}
		return false
	}
	return true
}
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("GET /status", s.status)
	mux.HandleFunc("POST /login", s.login)
	mux.HandleFunc("POST /logout", s.logout)
	mux.HandleFunc("GET /me", s.me)
	mux.HandleFunc("GET /tabs", s.me)
	mux.HandleFunc("POST /save_tabs", s.saveTabs)
	uploadSlots := make(chan struct{}, 4)
	mux.HandleFunc("POST /render", func(w http.ResponseWriter, r *http.Request) {
		select {
		case uploadSlots <- struct{}{}:
			defer func() { <-uploadSlots }()
			s.render(w, r)
		default:
			w.Header().Set("Retry-After", "5")
			failure(w, 429, "upload capacity reached; retry shortly")
		}
	})
	mux.HandleFunc("GET /jobs", s.jobs)
	mux.HandleFunc("GET /jobs/{id}", s.job)
	mux.HandleFunc("GET /jobs/{id}/assets/{kind}", s.asset)
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, s.Config.Public())
	})
	if s.Config.ClientDir != "" {
		mux.Handle("GET /", http.FileServer(http.Dir(s.Config.ClientDir)))
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		origin := r.Header.Get("Origin")
		if origin != "" {
			allowed := false
			for _, v := range s.Config.Origins {
				if origin == v {
					allowed = true
					break
				}
			}
			w.Header().Add("Vary", "Origin")
			if allowed {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Expose-Headers", "Location, Retry-After")
			} else if r.Method == "OPTIONS" {
				failure(w, 403, "origin is not allowed")
				return
			}
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		defer func() {
			if p := recover(); p != nil {
				slog.Error("request panic", "path", r.URL.Path)
				failure(w, 500, "internal server error")
			}
		}()
		mux.ServeHTTP(w, r)
	})
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if !s.loginLimiter.Allow(host) {
		failure(w, 429, "too many login attempts")
		return
	}
	var b struct {
		Token string `json:"token"`
	}
	if !decode(w, r, 20<<10, &b) {
		return
	}
	u, e := s.Auth.Login(r.Context(), token(r, b.Token))
	if e != nil {
		if errors.Is(e, auth.ErrUnauthorized) {
			failure(w, 401, e.Error())
		} else if errors.Is(e, auth.ErrDisabled) {
			failure(w, 503, e.Error())
		} else {
			internal(w, e)
		}
		return
	}
	respond(w, 200, map[string]any{"token": token(r, b.Token), "user": u})
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Token string `json:"token"`
	}
	if r.ContentLength != 0 && !decode(w, r, 20<<10, &b) {
		return
	}
	if _, ok := s.session(w, r, b.Token); !ok {
		return
	}
	if e := s.Auth.Logout(r.Context(), token(r, b.Token)); e != nil {
		internal(w, e)
		return
	}
	w.WriteHeader(204)
}
func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	id, ok := s.session(w, r, "")
	if !ok {
		return
	}
	u, e := s.Store.User(r.Context(), id)
	if e != nil {
		internal(w, e)
		return
	}
	respond(w, 200, u)
}
func (s *Server) saveTabs(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Token string          `json:"token"`
		Tabs  json.RawMessage `json:"tabs"`
	}
	if !decode(w, r, 32<<20, &b) {
		return
	}
	id, ok := s.session(w, r, b.Token)
	if !ok {
		return
	}
	tabs, e := model.ParseTabs(b.Tabs)
	if e != nil {
		failure(w, 400, e.Error())
		return
	}
	if e = s.Store.SaveTabs(r.Context(), id, tabs, b.Tabs); e != nil {
		if strings.HasPrefix(e.Error(), "splat job") {
			failure(w, 400, e.Error())
		} else {
			internal(w, e)
		}
		return
	}
	respond(w, 200, map[string]any{"tabs": json.RawMessage(b.Tabs)})
}
func (s *Server) render(w http.ResponseWriter, r *http.Request) {
	// Bearer authentication is checked before accepting large uploads. Body token remains supported for the planned client.
	user := ""
	if r.Header.Get("Authorization") != "" {
		var ok bool
		user, ok = s.session(w, r, "")
		if !ok {
			return
		}
	}
	mt, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if e != nil || mt != "multipart/form-data" {
		failure(w, 415, "render requires multipart/form-data")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 50<<20)
	if e = r.ParseMultipartForm(1 << 20); e != nil {
		if r.MultipartForm != nil {
			r.MultipartForm.RemoveAll()
		}
		var tooLarge *http.MaxBytesError
		if errors.As(e, &tooLarge) {
			failure(w, 413, "render upload exceeds 50 MiB")
		} else {
			failure(w, 400, "invalid multipart upload")
		}
		return
	}
	defer r.MultipartForm.RemoveAll()
	if user == "" {
		var ok bool
		user, ok = s.session(w, r, r.FormValue("token"))
		if !ok {
			return
		}
	}
	if s.Config.FALKey == "" {
		failure(w, 503, "render provider is not configured")
		return
	}
	prompt := strings.TrimSpace(r.FormValue("prompt"))
	if prompt == "" || len(prompt) > 8000 {
		failure(w, 400, "prompt must be 1–8000 bytes")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		key = uuid.NewString()
	}
	if len(key) > 200 {
		failure(w, 400, "Idempotency-Key is too long")
		return
	}
	for k, v := range r.MultipartForm.Value {
		if (k != "token" && k != "prompt") || len(v) != 1 {
			failure(w, 400, "unknown or repeated form field")
			return
		}
	}
	for k, v := range r.MultipartForm.File {
		if (k != "render" && k != "snapshot" && k != "depth" && k != "wireframe") || len(v) != 1 {
			failure(w, 400, "unknown or repeated image field")
			return
		}
	}
	input := map[string][]byte{}
	hash := sha256.New()
	hash.Write([]byte(prompt))
	for _, kind := range []string{"snapshot", "depth", "wireframe"} {
		field := kind
		if kind == "snapshot" && len(r.MultipartForm.File["render"]) > 0 {
			if len(r.MultipartForm.File["snapshot"]) > 0 {
				failure(w, 400, "send either render or snapshot, not both")
				return
			}
			field = "render"
		}
		f, _, e := r.FormFile(field)
		if e != nil {
			failure(w, 400, "missing "+kind+" PNG")
			return
		}
		b, e := assets.ReadLimited(f, assets.MaxPNG)
		f.Close()
		if e != nil {
			failure(w, 413, kind+" image exceeds 16 MiB")
			return
		}
		if e = assets.ValidatePNG(b); e != nil {
			failure(w, 400, kind+": "+e.Error())
			return
		}
		input[kind] = b
		sum := sha256.Sum256(b)
		hash.Write(sum[:])
	}
	j := model.Job{ID: uuid.NewString(), UserID: user, Prompt: prompt, RequestHash: hex.EncodeToString(hash.Sum(nil))}
	id := j.ID
	for _, kind := range []string{"snapshot", "depth", "wireframe"} {
		if e = s.Assets.Put(id, kind, input[kind]); e != nil {
			s.Assets.Remove(id)
			internal(w, e)
			return
		}
	}
	j.SnapshotURI = assets.URI(id, "snapshot")
	j.DepthURI = assets.URI(id, "depth")
	j.WireframeURI = assets.URI(id, "wireframe")
	saved, created, e := s.Store.CreateJob(r.Context(), j, key, s.Config.MaxActiveJobs, s.Config.DailyLimit)
	// A commit error can be ambiguous. Keep files if database success is unknown, so a committed job remains runnable.
	if !created && e == nil {
		s.Assets.Remove(id)
	}
	if e != nil {
		if errors.Is(e, store.ErrLimit) || errors.Is(e, store.ErrConflict) {
			s.Assets.Remove(id)
		}
		switch {
		case errors.Is(e, store.ErrLimit):
			failure(w, 429, e.Error())
		case errors.Is(e, store.ErrConflict):
			failure(w, 409, e.Error())
		default:
			internal(w, e)
		}
		return
	}
	w.Header().Set("Location", "/jobs/"+saved.ID)
	respond(w, 202, saved)
}
func (s *Server) jobs(w http.ResponseWriter, r *http.Request) {
	id, ok := s.session(w, r, "")
	if !ok {
		return
	}
	limit, offset := 50, 0
	var e error
	if v := r.URL.Query().Get("limit"); v != "" {
		limit, e = strconv.Atoi(v)
		if e != nil || limit < 1 || limit > 100 {
			failure(w, 400, "limit must be 1–100")
			return
		}
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		offset, e = strconv.Atoi(v)
		if e != nil || offset < 0 || offset > 100000 {
			failure(w, 400, "invalid offset")
			return
		}
	}
	jobs, e := s.Store.Jobs(r.Context(), id, limit, offset)
	if e != nil {
		internal(w, e)
		return
	}
	respond(w, 200, map[string]any{"jobs": jobs})
}
func (s *Server) ownedJob(w http.ResponseWriter, r *http.Request) (model.Job, bool) {
	user, ok := s.session(w, r, "")
	if !ok {
		return model.Job{}, false
	}
	id := r.PathValue("id")
	if _, e := uuid.Parse(id); e != nil {
		failure(w, 404, "job not found")
		return model.Job{}, false
	}
	j, e := s.Store.UserJob(r.Context(), id, user)
	if e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			failure(w, 404, "job not found")
		} else {
			internal(w, e)
		}
		return j, false
	}
	return j, true
}
func (s *Server) job(w http.ResponseWriter, r *http.Request) {
	j, ok := s.ownedJob(w, r)
	if ok {
		respond(w, 200, j)
	}
}
func (s *Server) asset(w http.ResponseWriter, r *http.Request) {
	j, ok := s.ownedJob(w, r)
	if !ok {
		return
	}
	kind := r.PathValue("kind")
	p, e := s.Assets.Path(j.ID, kind)
	if e != nil || (kind == "render" && j.RenderURI == "") || (kind == "splat" && j.SplatURI == "") {
		failure(w, 404, "asset not found")
		return
	}
	f, e := os.Open(p)
	if e != nil {
		failure(w, 404, "asset not found")
		return
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		internal(w, e)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "image/png")
	if kind == "splat" {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", `attachment; filename="splat.ply"`)
	}
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}
func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	checks := map[string]bool{}
	checks["postgres"] = s.Store.Pool.Ping(ctx) == nil
	checks["redis"] = s.Auth.Redis.Ping(ctx).Err() == nil
	_, e := s.Temporal.CheckHealth(ctx, &client.CheckHealthRequest{})
	checks["temporal"] = e == nil
	pollers := 0
	queue, queueErr := s.Temporal.WorkflowService().DescribeTaskQueue(ctx, &workflowservice.DescribeTaskQueueRequest{
		Namespace:     s.Config.TemporalNamespace,
		TaskQueue:     &taskqueuepb.TaskQueue{Name: s.Config.TaskQueue},
		TaskQueueType: enumspb.TASK_QUEUE_TYPE_ACTIVITY,
	})
	if queueErr == nil {
		for _, p := range queue.Pollers {
			if p.LastAccessTime != nil && time.Since(p.LastAccessTime.AsTime()) < 2*time.Minute {
				pollers++
			}
		}
	}
	checks["worker"] = queueErr == nil && pollers > 0
	good := true
	for _, v := range checks {
		good = good && v
	}
	status := 200
	if !good {
		status = 503
	}
	respond(w, status, map[string]any{"ok": good, "services": checks, "login_configured": s.Config.GoogleClientID != "", "render_configured": s.Config.FALKey != "", "namespace": s.Config.TemporalNamespace, "worker_pollers": pollers})
}

type limiter struct {
	mu      sync.Mutex
	entries map[string]bucket
}
type bucket struct {
	n     int
	until time.Time
}

func (l *limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.entries == nil {
		l.entries = map[string]bucket{}
	}
	now := time.Now()
	if len(l.entries) > 10000 {
		for k, b := range l.entries {
			if now.After(b.until) {
				delete(l.entries, k)
			}
		}
		if len(l.entries) > 10000 {
			return false
		}
	}
	b := l.entries[key]
	if now.After(b.until) {
		b = bucket{until: now.Add(time.Minute)}
	}
	b.n++
	l.entries[key] = b
	return b.n <= 30
}
