package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStaticHeaders(t *testing.T) {
	handler := StaticHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	for _, test := range []struct {
		path, cache string
	}{
		{path: "/", cache: "no-cache"},
		{path: "/app/", cache: "no-cache"},
		{path: "/api/config", cache: "no-cache"},
		{path: "/scripts/renderer.js", cache: "public, max-age=3600, must-revalidate"},
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, test.path, nil))
		if got := recorder.Header().Get("Cache-Control"); got != test.cache {
			t.Errorf("%s cache = %q, want %q", test.path, got, test.cache)
		}
		if recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s missing security headers", test.path)
		}
	}
}
