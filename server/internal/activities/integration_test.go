package activities

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.temporal.io/sdk/testsuite"
	"worldsplat/internal/assets"
	"worldsplat/internal/model"
	"worldsplat/internal/providers"
	"worldsplat/internal/store"
	"worldsplat/migrations"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestResumeProviderActivities(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL for activity recovery integration tests")
	}
	ctx := context.Background()
	pool, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	if e = migrations.Apply(ctx, pool); e != nil {
		t.Fatal(e)
	}
	st := &store.Store{Pool: pool}
	sub := uuid.NewString()
	u, e := st.UpsertUser(ctx, sub, sub+"@example.invalid", "Recovery test")
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Exec(ctx, "DELETE FROM public.users WHERE id=$1", u.ID)
	id := uuid.NewString()
	_, _, e = st.CreateJob(ctx, model.Job{ID: id, UserID: u.ID, Prompt: "test", SnapshotURI: assets.URI(id, "snapshot"), DepthURI: assets.URI(id, "depth"), WireframeURI: assets.URI(id, "wireframe"), RequestHash: "test"}, "recovery", 2, 10)
	if e != nil {
		t.Fatal(e)
	}
	falReq := providers.FALRequest{RequestID: "existing-paid-request", StatusURL: "https://queue.example.test/status", ResponseURL: "https://queue.example.test/result"}
	if e = st.SaveRequest(ctx, id, "fal", falReq); e != nil {
		t.Fatal(e)
	}
	if e = st.SaveRequest(ctx, id, "tripo", providers.TripoRequest{EventID: "existing-gpu-request"}); e != nil {
		t.Fatal(e)
	}
	var img bytes.Buffer
	png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 4, 4)))
	ply := "ply\nformat binary_little_endian 1.0\nelement vertex 1\n"
	for _, p := range []string{"x", "y", "z", "opacity", "f_dc_0", "f_dc_1", "f_dc_2", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"} {
		ply += "property float " + p + "\n"
	}
	ply += "end_header\n" + strings.Repeat("\x00", 56)
	var mu sync.Mutex
	requests := map[string]int{}
	c := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		requests[r.URL.Path]++
		if r.Method != "GET" {
			return nil, fmt.Errorf("provider was resubmitted")
		}
		var body []byte
		status := 200
		switch r.URL.Path {
		case "/status":
			body = []byte(`{"status":"COMPLETED"}`)
		case "/result":
			body = []byte(`{"images":[{"url":"https://v3.fal.media/render.png"}]}`)
		case "/render.png":
			body = img.Bytes()
		case "/gradio_api/call/generate/existing-gpu-request":
			body = []byte("event: complete\ndata: [null,null,{\"__type__\":\"update\",\"value\":{\"path\":\"/tmp/splat.ply\"}}]\n\n")
		case "/gradio_api/file=/tmp/splat.ply":
			if requests[r.URL.Path] == 1 {
				status = 503
			} else {
				body = []byte(ply)
			}
		default:
			return nil, fmt.Errorf("unexpected provider path %s", r.URL.Path)
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header), Request: r}, nil
	})}
	a := &Activities{Store: st, Assets: assets.Store{Root: t.TempDir()}, FAL: providers.FAL{Client: c, BaseURL: "https://queue.example.test", Key: "test"}, Tripo: providers.Tripo{Client: c, BaseURL: "http://tripo.example.test"}}
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(a)
	if _, e = env.ExecuteActivity(a.RenderVisual, id); e != nil {
		t.Fatal(e)
	}
	if _, e = env.ExecuteActivity(a.RenderVisual, id); e != nil {
		t.Fatal(e)
	}
	if requests["/status"] != 1 {
		t.Fatal("completed render stage was repeated")
	}
	if _, e = env.ExecuteActivity(a.RenderSplat, id); e == nil {
		t.Fatal("download failure was ignored")
	}
	if _, e = env.ExecuteActivity(a.RenderSplat, id); e != nil {
		t.Fatal(e)
	}
	if _, e = env.ExecuteActivity(a.RenderSplat, id); e != nil {
		t.Fatal(e)
	}
	if requests["/gradio_api/call/generate/existing-gpu-request"] != 1 {
		t.Fatal("consumed Gradio stream was read twice")
	}
	j, e := st.Job(ctx, id)
	if e != nil || j.Status != "completed" {
		t.Fatal(j.Status, e)
	}
	u, e = st.User(ctx, u.ID)
	if e != nil || u.Generations != 1 {
		t.Fatal(u.Generations, e)
	}
}
