package httpx

import (
	"net/http"
	"path/filepath"
	"strings"
)

// StaticHeaders adds conservative browser protections and allows short-lived caching of
// static assets. HTML and runtime JSON always revalidate so deploys/config changes appear
// promptly without forcing every JavaScript asset to be downloaded on every request.
func StaticHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		ext := strings.ToLower(filepath.Ext(r.URL.Path))
		if strings.HasSuffix(r.URL.Path, "/") || ext == ".html" || strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")
		}
		next.ServeHTTP(w, r)
	})
}
