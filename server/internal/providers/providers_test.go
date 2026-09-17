package providers

import (
	"context"
	"encoding/json"
	"errors"
	"go.temporal.io/sdk/temporal"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFALQueue(t *testing.T) {
	calls := 0
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Key test-key" {
			t.Error("missing auth")
		}
		switch r.URL.Path {
		case "/openai/gpt-image-2.5/sunburst/edit":
			var in map[string]any
			json.NewDecoder(r.Body).Decode(&in)
			if in["num_images"] != float64(1) || in["output_format"] != "png" {
				t.Error("invalid input", in)
			}
			images, ok := in["image_urls"].([]any)
			if !ok || len(images) != 1 || images[0] != "data:image/png;base64,UE5H" || in["quality"] != "medium" || in["image_size"] != "square_hd" || in["prompt"] != "garden" {
				t.Error("invalid Sunburst input", in)
			}
			if len(in) != 6 {
				t.Error("unexpected fields sent to Sunburst", in)
			}
			json.NewEncoder(w).Encode(FALRequest{"req", srv.URL + "/status", srv.URL + "/result"})
		case "/status":
			calls++
			status := "IN_PROGRESS"
			if calls > 1 {
				status = "COMPLETED"
			}
			json.NewEncoder(w).Encode(map[string]string{"status": status})
		case "/result":
			w.Write([]byte(`{"images":[{"url":"https://v3.fal.media/result.png"}]}`))
		default:
			t.Error("unexpected path", r.URL.Path)
		}
	}))
	defer srv.Close()
	f := FAL{srv.Client(), srv.URL, "openai/gpt-image-2.5/sunburst/edit", "test-key"}
	req, e := f.Submit(context.Background(), "garden", []byte("PNG"))
	if e != nil {
		t.Fatal(e)
	}
	_, done, e := f.Poll(context.Background(), req)
	if e != nil || done {
		t.Fatal(done, e)
	}
	u, done, e := f.Poll(context.Background(), req)
	if e != nil || !done || u != "https://v3.fal.media/result.png" {
		t.Fatal(u, done, e)
	}
}
func TestProviderErrorsAndOrigins(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(402)
		w.Write([]byte("secret echoed input"))
	}))
	defer s.Close()
	f := FAL{s.Client(), s.URL, "model", "key"}
	_, e := f.Submit(context.Background(), "test", nil)
	var app *temporal.ApplicationError
	if !errors.As(e, &app) || !app.NonRetryable() || !strings.Contains(e.Error(), "credits") || strings.Contains(e.Error(), "secret") {
		t.Fatal(e)
	}
	for _, u := range []string{"http://169.254.169.254/latest", "https://queue.fal.run.evil.com/path", "https://user:pass@queue.fal.run/path"} {
		if _, e := SameOrigin("https://queue.fal.run", u); e == nil {
			t.Fatal("unsafe origin accepted", u)
		}
	}
	for _, u := range []string{"http://fal.media/a", "https://evil.com/a", "https://fal.media.evil.com/a", "https://fal.media:444/a"} {
		if _, e := FALAsset(u); e == nil {
			t.Fatal("unsafe asset", u)
		}
	}
}
func TestTripoStream(t *testing.T) {
	for _, tc := range []struct {
		name, input string
		ok          bool
	}{
		{"complete", "event: heartbeat\ndata: null\n\nevent: complete\ndata: [null,\"viewer\",{\"path\":\"/tmp/file.ply\"},\"done\"]\n\n", true},
		{"CRLF", "event: complete\r\ndata: [null,null,{\"path\":\"/tmp/file.ply\"}]\r\n\r\n", true},
		{"download update", "event: complete\ndata: [null,null,{\"__type__\":\"update\",\"value\":{\"path\":\"/tmp/file.ply\"}}]\n\n", true},
		{"path update", "event: complete\ndata: [null,null,{\"__type__\":\"update\",\"value\":\"/tmp/file.ply\"}]\n\n", true},
		{"error", "event: error\ndata: \"provider secret error\"\n\n", false},
		{"truncated", "event: heartbeat\ndata: null\n\n", false},
		{"bad URL", "event: complete\ndata: [null,null,{\"url\":\"http://evil.com/file.ply\"}]\n\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u, e := ParseTripoStream(strings.NewReader(tc.input), "http://127.0.0.1:7860")
			if (e == nil) != tc.ok {
				t.Fatal(u, e)
			}
			if e != nil && strings.Contains(e.Error(), "secret") {
				t.Fatal("provider error leaked")
			}
		})
	}
}
