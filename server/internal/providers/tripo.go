package providers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"worldsplat/internal/assets"
)

type Tripo struct {
	Client           *http.Client
	BaseURL          string
	Steps, Gaussians int
}
type TripoRequest struct {
	EventID   string `json:"event_id"`
	ResultURL string `json:"result_url,omitempty"`
}

func (t Tripo) Submit(ctx context.Context, png []byte) (TripoRequest, error) {
	var out TripoRequest
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, e := w.CreateFormFile("files", "render.png")
	if e != nil {
		return out, e
	}
	if _, e = part.Write(png); e != nil {
		return out, e
	}
	if e = w.Close(); e != nil {
		return out, e
	}
	req, e := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(t.BaseURL, "/")+"/gradio_api/upload", &body)
	if e != nil {
		return out, e
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	res, e := t.Client.Do(req)
	if e != nil {
		return out, fmt.Errorf("TripoSplat upload failed")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return out, providerError(res)
	}
	b, e := assets.ReadLimited(res.Body, 1<<20)
	if e != nil {
		return out, e
	}
	var paths []string
	if e = json.Unmarshal(b, &paths); e != nil || len(paths) != 1 {
		return out, Permanent("TripoSplat upload returned no file")
	}
	input := map[string]any{"data": []any{map[string]any{"path": paths[0], "meta": map[string]string{"_type": "gradio.FileData"}}, 42, t.Steps, 3.0, strconv.Itoa(t.Gaussians), "ply"}}
	e = requestJSON(ctx, t.Client, "POST", strings.TrimRight(t.BaseURL, "/")+"/gradio_api/call/generate", "", input, &out)
	if e == nil && out.EventID == "" {
		e = Permanent("TripoSplat returned no event ID")
	}
	return out, e
}
func (t Tripo) Result(ctx context.Context, r TripoRequest) (string, error) {
	uri := strings.TrimRight(t.BaseURL, "/") + "/gradio_api/call/generate/" + url.PathEscape(r.EventID)
	req, e := http.NewRequestWithContext(ctx, "GET", uri, nil)
	if e != nil {
		return "", e
	}
	req.Header.Set("Accept", "text/event-stream")
	// An inference stream may last longer than the normal request timeout. Context and activity heartbeat bound it.
	c := *t.Client
	c.Timeout = 0
	res, e := c.Do(req)
	if e != nil {
		return "", fmt.Errorf("TripoSplat result stream failed")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", providerError(res)
	}
	return ParseTripoStream(res.Body, t.BaseURL)
}
func ParseTripoStream(r io.Reader, base string) (string, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	event := ""
	var data []string
	process := func() (string, error) {
		payload := strings.Join(data, "\n")
		if event == "error" {
			return "", Permanent("TripoSplat generation failed; inspect the TripoSplat server logs")
		}
		if event != "complete" {
			return "", nil
		}
		var values []json.RawMessage
		if e := json.Unmarshal([]byte(payload), &values); e != nil || len(values) < 3 {
			return "", Permanent("invalid TripoSplat completion")
		}
		var file struct {
			Path  string          `json:"path"`
			URL   string          `json:"url"`
			Value json.RawMessage `json:"value"`
		}
		if e := json.Unmarshal(values[2], &file); e != nil {
			return "", Permanent("TripoSplat returned no download")
		}
		// DownloadButton returns gr.update(value=FileData), while other apps return FileData directly.
		if len(file.Value) > 0 {
			value := file.Value
			if e := json.Unmarshal(value, &file); e != nil {
				if e = json.Unmarshal(value, &file.Path); e != nil {
					return "", Permanent("invalid TripoSplat download update")
				}
			}
		}
		// Rebuild the URL from its server path; Gradio may advertise localhost even behind a proxy.
		if file.Path != "" {
			return strings.TrimRight(base, "/") + "/gradio_api/file=" + url.PathEscape(file.Path), nil
		}
		if file.URL != "" {
			return SameOrigin(base, file.URL)
		}
		return "", Permanent("TripoSplat returned an empty download")
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			u, e := process()
			if e != nil || u != "" {
				return u, e
			}
			event = ""
			data = nil
			continue
		}
		if strings.HasPrefix(line, "event:") {
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if scanner.Err() != nil {
		return "", fmt.Errorf("TripoSplat stream interrupted")
	}
	if u, e := process(); u != "" || e != nil {
		return u, e
	}
	return "", fmt.Errorf("TripoSplat stream ended before completion")
}
