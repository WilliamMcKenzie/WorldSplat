package handlers

import (
	"encoding/json"
	"net/http"

	"worldsketch/server/internal/config"
)

const defaultOAuthClientID = "91581ad0-d16c-4f49-9746-cff21b50ac9e"

func Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/config", Config)
	mux.HandleFunc("/healthz", Health)
}

func Config(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"scene": map[string]any{
			"yOffset":           config.EnvFloat("WS_SCENE_Y_OFFSET", 0),
			"opacityFloor":      config.EnvFloat("WS_SCENE_OPACITY_FLOOR", 0.03),
			"yaw":               config.EnvFloat("WS_SCENE_YAW", 0),
			"fitBboxPercentile": config.EnvFloat("WS_SCENE_FIT_BBOX_PERCENTILE", 0),
		},
		"generation": map[string]any{
			"provider":          "huggingface",
			"oauthClientId":     config.Env("WS_HF_OAUTH_CLIENT_ID", defaultOAuthClientID),
			"redirectUrl":       config.Env("WS_HF_REDIRECT_URL", ""),
			"imageSpace":        config.Env("WS_HF_IMAGE_SPACE", "black-forest-labs/FLUX.1-Kontext-Dev"),
			"tripoSpace":        config.Env("WS_HF_TRIPO_SPACE", "VAST-AI/TripoSplat"),
			"inferenceProvider": config.Env("WS_HF_INFERENCE_PROVIDER", "fal-ai"),
			"inferenceModel":    config.Env("WS_HF_INFERENCE_MODEL", "black-forest-labs/FLUX.2-dev"),
			"imageCredits":      config.Env("WS_HF_IMAGE_CREDITS", "1") != "0",
			"image": map[string]any{
				"steps":    config.EnvInt("WS_HF_IMAGE_STEPS", 28, 1, 100),
				"guidance": config.EnvFloat("WS_HF_IMAGE_GUIDANCE", 4),
				"width":    config.EnvInt("WS_HF_IMAGE_WIDTH", 1024, 256, 2048),
				"height":   config.EnvInt("WS_HF_IMAGE_HEIGHT", 1024, 256, 2048),
			},
			"tripo": map[string]any{
				"steps":      config.EnvInt("WS_HF_TRIPO_STEPS", 30, 1, 64),
				"guidance":   config.EnvFloat("WS_HF_TRIPO_GUIDANCE", 3),
				"gaussians":  config.EnvInt("WS_HF_TRIPO_GAUSSIANS", 131072, 32768, 262144),
				"preprocess": config.Env("WS_HF_TRIPO_PREPROCESS", "1") != "0",
				"format":     "splat",
			},
		},
	})
}

func Health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte("ok\n"))
	}
}
