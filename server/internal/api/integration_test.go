package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"worldsplat/internal/assets"
	"worldsplat/internal/auth"
	"worldsplat/internal/config"
	"worldsplat/internal/model"
	"worldsplat/internal/store"
	"worldsplat/migrations"
)

type fakeGoogle struct {
	Subject string
	Calls   int
}

func (f *fakeGoogle) Verify(_ context.Context, token string) (auth.Identity, error) {
	f.Calls++
	if !strings.HasPrefix(token, "test-valid-") {
		return auth.Identity{}, auth.ErrUnauthorized
	}
	return auth.Identity{Subject: f.Subject, Email: f.Subject + "@example.invalid", Name: "Integration Test"}, nil
}
func TestAPIIntegration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL and TEST_REDIS_URL to run integration tests")
	}
	ctx := context.Background()
	db, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	if e = migrations.Apply(ctx, db); e != nil {
		t.Fatal(e)
	}
	ro, e := redis.ParseURL(os.Getenv("TEST_REDIS_URL"))
	if e != nil {
		t.Fatal(e)
	}
	rc := redis.NewClient(ro)
	defer rc.Close()
	subject := "test-" + uuid.NewString()
	verifier := &fakeGoogle{Subject: subject}
	st := &store.Store{Pool: db}
	sessions := &auth.Service{Redis: rc, Users: st, Verifier: verifier, TTL: time.Hour}
	disk := assets.Store{Root: t.TempDir()}
	srv := httptest.NewServer((&Server{Config: config.Config{FALKey: "test", MaxActiveJobs: 2, DailyLimit: 10, Origins: []string{"https://allowed.example"}}, Store: st, Auth: sessions, Assets: disk}).Handler())
	defer srv.Close()
	access := "test-valid-" + uuid.NewString()
	otherToken := "test-other-" + uuid.NewString()
	defer rc.Del(ctx, auth.Key(access), auth.Key(otherToken))
	do := func(method, path, token, body string) *http.Response {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		res, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		return res
	}
	expect := func(res *http.Response, status int) {
		t.Helper()
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		if res.StatusCode != status {
			t.Fatalf("status=%d want=%d body=%s", res.StatusCode, status, b)
		}
	}
	expect(do("GET", "/me", "", ""), 401)
	expect(do("POST", "/login", "", `{"token":"invalid-token-value"}`), 401)
	res := do("POST", "/login", "", fmt.Sprintf(`{"token":%q}`, access))
	if res.StatusCode != 200 {
		t.Fatal("login failed", res.StatusCode)
	}
	var login struct {
		Token string     `json:"token"`
		User  model.User `json:"user"`
	}
	json.NewDecoder(res.Body).Decode(&login)
	res.Body.Close()
	user := login.User.ID
	defer db.Exec(ctx, "DELETE FROM public.users WHERE id=$1", user)
	if login.Token != access || string(login.User.Tabs) != "[]" {
		t.Fatal("login response mismatch")
	}
	calls := verifier.Calls
	expect(do("POST", "/login", "", fmt.Sprintf(`{"token":%q}`, access)), 200)
	if verifier.Calls != calls {
		t.Fatal("existing session was reverified")
	}
	expect(do("POST", "/save_tabs", access, `{"tabs":[]}`), 200)
	expect(do("POST", "/save_tabs", access, `{"tabs":null}`), 400)
	expect(do("POST", "/save_tabs", access, `{"tabs":[{"id":"s","name":"View","type":"splat","job_id":"11111111-1111-4111-8111-111111111111"}]}`), 400)
	var img bytes.Buffer
	png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 8, 8)))
	upload := func(key, prompt string, valid bool) *http.Response {
		var b bytes.Buffer
		w := multipart.NewWriter(&b)
		w.WriteField("prompt", prompt)
		for _, kind := range []string{"render", "depth", "wireframe"} {
			p, _ := w.CreateFormFile(kind, kind+".png")
			if valid {
				p.Write(img.Bytes())
			} else {
				p.Write([]byte("invalid png"))
			}
		}
		w.Close()
		req, _ := http.NewRequest("POST", srv.URL+"/render", &b)
		req.Header.Set("Content-Type", w.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+access)
		req.Header.Set("Idempotency-Key", key)
		r, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Error(e)
			return nil
		}
		return r
	}
	expect(upload("bad", "garden", false), 400)
	res = upload("same", "garden", true)
	if res.StatusCode != 202 {
		b, _ := io.ReadAll(res.Body)
		t.Fatal(res.StatusCode, string(b))
	}
	var job model.Job
	json.NewDecoder(res.Body).Decode(&job)
	res.Body.Close()
	res = upload("same", "garden", true)
	var duplicate model.Job
	json.NewDecoder(res.Body).Decode(&duplicate)
	res.Body.Close()
	if job.ID != duplicate.ID {
		t.Fatal("duplicate render created another job")
	}
	expect(upload("same", "different", true), 409)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := upload("same", "garden", true)
			if r != nil {
				defer r.Body.Close()
				if r.StatusCode != 202 {
					t.Error("concurrent replay status", r.StatusCode)
				}
			}
		}()
	}
	wg.Wait()
	var n int
	db.QueryRow(ctx, "SELECT count(*) FROM public.jobs WHERE user_id=$1", user).Scan(&n)
	if n != 1 {
		t.Fatal("duplicate job rows", n)
	}
	other, e := st.UpsertUser(ctx, "test-"+uuid.NewString(), uuid.NewString()+"@example.invalid", "Other")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Exec(ctx, "DELETE FROM public.users WHERE id=$1", other.ID)
	rc.Set(ctx, auth.Key(otherToken), other.ID, time.Hour)
	expect(do("GET", "/jobs/"+job.ID, otherToken, ""), 404)
	expect(do("GET", job.SnapshotURI, otherToken, ""), 404)
	expect(do("GET", job.SnapshotURI, access, ""), 200)
	expect(do("GET", "/jobs/"+job.ID+"/assets/splat", access, ""), 404)
	// Pending splat tabs must survive reload while the workflow is running.
	expect(do("POST", "/save_tabs", access, fmt.Sprintf(`{"tabs":[{"id":"pending","name":"Pending","type":"splat","job_id":%q}]}`, job.ID)), 200)
	expect(do("POST", "/save_tabs", otherToken, fmt.Sprintf(`{"tabs":[{"id":"pending","name":"Pending","type":"splat","job_id":%q}]}`, job.ID)), 400)
	expect(upload("second", "garden", true), 202)
	expect(upload("third", "garden", true), 429)
	if e = st.Complete(ctx, job.ID, assets.URI(job.ID, "splat")); e != nil {
		t.Fatal(e)
	}
	if e = st.Complete(ctx, job.ID, assets.URI(job.ID, "splat")); e != nil {
		t.Fatal(e)
	}
	u, _ := st.User(ctx, user)
	if u.Generations != 1 {
		t.Fatal("completion counted twice")
	}
	expect(do("POST", "/save_tabs", access, fmt.Sprintf(`{"tabs":[{"id":"s","name":"View","type":"splat","job_id":%q}]}`, job.ID)), 200)
	expect(do("POST", "/save_tabs", otherToken, fmt.Sprintf(`{"tabs":[{"id":"s","name":"View","type":"splat","job_id":%q}]}`, job.ID)), 400)
	expect(do("POST", "/logout", access, ""), 204)
	expect(do("GET", "/me", access, ""), 401)
	req, _ := http.NewRequest("OPTIONS", srv.URL+"/render", nil)
	req.Header.Set("Origin", "https://allowed.example")
	res, e = http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "https://allowed.example" {
		t.Fatal("CORS missing")
	}
	expect(res, 204)
	req.Header.Set("Origin", "https://evil.example")
	res, e = http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	expect(res, 403)
}
