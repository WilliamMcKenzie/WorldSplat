package providers

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
)

type FAL struct {
	Client              *http.Client
	BaseURL, Model, Key string
}
type FALRequest struct {
	RequestID   string `json:"request_id"`
	StatusURL   string `json:"status_url"`
	ResponseURL string `json:"response_url"`
}

func (f FAL) Submit(ctx context.Context, prompt string, png, depth []byte) (FALRequest, error) {
	var out FALRequest
	if f.Key == "" {
		return out, Permanent("FAL_KEY is not configured")
	}
	input := map[string]any{
		"prompt":                 prompt,
		"image_url":              "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
		"control_lora_image_url": "data:image/png;base64," + base64.StdEncoding.EncodeToString(depth),
		"preprocess_depth":       false,
		"control_lora_strength":  1,
		"image_size":             "square_hd",
		"num_images":             1, "output_format": "png", "enable_safety_checker": true,
	}
	e := requestJSON(ctx, f.Client, "POST", strings.TrimRight(f.BaseURL, "/")+"/"+f.Model, f.Key, input, &out)
	if e != nil {
		return out, e
	}
	if out.RequestID == "" || out.StatusURL == "" || out.ResponseURL == "" {
		return out, Permanent("FAL submission returned no request ID or tracking URLs")
	}
	return out, nil
}
func (f FAL) Poll(ctx context.Context, r FALRequest) (string, bool, error) {
	statusURL, e := SameOrigin(f.BaseURL, r.StatusURL)
	if e != nil {
		return "", false, e
	}
	resultURL, e := SameOrigin(f.BaseURL, r.ResponseURL)
	if e != nil {
		return "", false, e
	}
	var status struct {
		Status    string `json:"status"`
		Error     string `json:"error"`
		ErrorType string `json:"error_type"`
	}
	if e = requestJSON(ctx, f.Client, "GET", statusURL, f.Key, nil, &status); e != nil {
		return "", false, e
	}
	switch status.Status {
	case "IN_QUEUE", "IN_PROGRESS":
		return "", false, nil
	case "COMPLETED":
		if status.Error != "" {
			return "", false, Permanent("FAL generation failed; inspect the provider request in the FAL dashboard")
		}
	default:
		return "", false, Permanent("FAL returned an unknown queue status")
	}
	var result struct {
		Images []struct {
			URL string `json:"url"`
		} `json:"images"`
		NSFW []bool `json:"has_nsfw_concepts"`
	}
	if e = requestJSON(ctx, f.Client, "GET", resultURL, f.Key, nil, &result); e != nil {
		return "", false, e
	}
	for _, v := range result.NSFW {
		if v {
			return "", false, Permanent("FAL safety checker rejected the generated image")
		}
	}
	if len(result.Images) == 0 {
		return "", false, fmt.Errorf("FAL result contains no image")
	}
	return result.Images[0].URL, true, nil
}
