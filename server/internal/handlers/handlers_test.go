package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestConfigExposesPublicHuggingFaceSettings(t *testing.T) {
	t.Setenv("WS_HF_IMAGE_STEPS", "33")
	recorder := httptest.NewRecorder()
	Config(recorder, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	var body struct {
		Generation struct {
			Provider          string `json:"provider"`
			OAuthClientID     string `json:"oauthClientId"`
			ImageSpace        string `json:"imageSpace"`
			InferenceProvider string `json:"inferenceProvider"`
			InferenceModel    string `json:"inferenceModel"`
			Image             struct {
				Steps int `json:"steps"`
			} `json:"image"`
		} `json:"generation"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Generation.Provider != "huggingface" || body.Generation.OAuthClientID == "" || body.Generation.Image.Steps != 33 {
		t.Fatalf("unexpected config: %+v", body.Generation)
	}
	if body.Generation.ImageSpace != "black-forest-labs/FLUX.1-Kontext-Dev" {
		t.Fatalf("image space = %q, want the FLUX.1-Kontext-Dev Space", body.Generation.ImageSpace)
	}
	if body.Generation.InferenceProvider != "fal-ai" || body.Generation.InferenceModel != "black-forest-labs/FLUX.2-dev" {
		t.Fatalf("unexpected inference provider config: %+v", body.Generation)
	}
}

func TestConfigRejectsWrites(t *testing.T) {
	recorder := httptest.NewRecorder()
	Config(recorder, httptest.NewRequest(http.MethodPost, "/api/config", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", recorder.Code)
	}
}

func TestHealth(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		recorder := httptest.NewRecorder()
		Health(recorder, httptest.NewRequest(method, "/healthz", nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", method, recorder.Code)
		}
	}
}
