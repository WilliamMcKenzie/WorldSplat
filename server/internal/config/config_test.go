package config

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestConfigValidation(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/worldsplat")
	for _, tc := range []struct{ k, v string }{{"WS_SESSION_TTL", "0s"}, {"WS_MAX_ACTIVE_JOBS", "0"}, {"WS_DAILY_GENERATION_LIMIT", "-1"}, {"WS_TRIPO_GAUSSIANS", "99999"}, {"WS_ALLOWED_ORIGINS", "*"}, {"WS_ALLOWED_ORIGINS", "https://example.com/"}, {"WS_FAL_URL", "file:///tmp/file"}} {
		t.Run(tc.k+tc.v, func(t *testing.T) {
			t.Setenv(tc.k, tc.v)
			if _, e := Load(); e == nil {
				t.Fatal("invalid setting accepted")
			}
		})
	}
}
func TestPublicConfig(t *testing.T) {
	t.Setenv("WS_SCENE_OPACITY_FLOOR", "9000")
	t.Setenv("WS_SCENE_YAW", "NaN")
	c := Config{FALKey: "secret-fal-key", DatabaseURL: "secret-db-url", RedisURL: "secret-redis-url"}
	out := c.Public()
	b, _ := json.Marshal(out)
	if strings.Contains(string(b), "secret-") {
		t.Fatal("secret leaked")
	}
	img := out["scene"].(map[string]any)
	if img["opacityFloor"] != float64(1) || img["yaw"] != float64(0) {
		t.Fatal(img)
	}
}
