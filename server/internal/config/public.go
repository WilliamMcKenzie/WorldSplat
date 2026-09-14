package config

import (
	"math"
	"os"
	"strconv"
)

func publicNumber(k string, d, lo, hi float64) float64 {
	raw := os.Getenv(k)
	if raw == "" {
		return d
	}
	n, e := strconv.ParseFloat(raw, 64)
	if e != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return d
	}
	return min(hi, max(lo, n))
}
func publicInt(k string, d, lo, hi float64) int { return int(publicNumber(k, d, lo, hi)) }

// Public contains only explicitly allowlisted browser configuration.
func (c Config) Public() map[string]any {
	return map[string]any{
		"backend":    map[string]any{"googleClientId": c.GoogleClientID, "apiBaseURL": env("WS_API_BASE_URL", ""), "loginEnabled": c.GoogleClientID != "", "renderEnabled": c.FALKey != "", "tabSchemaVersion": 1},
		"generation": map[string]any{"provider": "backend"},
		"scene":      map[string]any{"opacityFloor": publicNumber("WS_SCENE_OPACITY_FLOOR", .03, 0, 1), "yOffset": publicNumber("WS_SCENE_Y_OFFSET", 0, -100, 100), "yaw": publicNumber("WS_SCENE_YAW", 0, -360, 360), "fitBboxPercentile": publicNumber("WS_SCENE_FIT_BBOX_PERCENTILE", 0, 0, 49)},
	}
}
