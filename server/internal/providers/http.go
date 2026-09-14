package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.temporal.io/sdk/temporal"
	"worldsplat/internal/assets"
)

func Permanent(message string) error {
	return temporal.NewNonRetryableApplicationError(message, "ProviderError", nil)
}
func providerError(res *http.Response) error {
	// Provider bodies can echo prompts, credentials or signed URLs. Keep a useful status classification only.
	io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	message := fmt.Sprintf("provider returned HTTP %d", res.StatusCode)
	switch res.StatusCode {
	case 401, 403:
		message += " (provider authentication or permission denied)"
	case 402:
		message += " (insufficient provider credits)"
	case 422:
		message += " (provider rejected the input)"
	case 429:
		message += " (provider rate limit)"
	}
	if res.StatusCode >= 400 && res.StatusCode < 500 && res.StatusCode != 408 && res.StatusCode != 429 {
		return Permanent(message)
	}
	return fmt.Errorf("%s", message)
}
func requestJSON(ctx context.Context, c *http.Client, method, uri, key string, input, output any) error {
	var r io.Reader
	if input != nil {
		b, e := json.Marshal(input)
		if e != nil {
			return e
		}
		r = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, uri, r)
	if e != nil {
		return fmt.Errorf("invalid provider endpoint")
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Key "+key)
	}
	res, e := c.Do(req)
	if e != nil {
		return fmt.Errorf("provider request failed: network error")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return providerError(res)
	}
	b, e := assets.ReadLimited(res.Body, 2<<20)
	if e != nil {
		return e
	}
	if e = json.Unmarshal(b, output); e != nil {
		return fmt.Errorf("provider returned invalid JSON")
	}
	return nil
}
func SameOrigin(base, raw string) (string, error) {
	b, e := url.Parse(base)
	if e != nil {
		return "", Permanent("invalid provider base URL")
	}
	u, e := url.Parse(raw)
	if e != nil {
		return "", Permanent("invalid provider result URL")
	}
	u = b.ResolveReference(u)
	if u.Scheme != b.Scheme || !strings.EqualFold(u.Host, b.Host) || u.User != nil {
		return "", Permanent("provider result URL has an unexpected origin")
	}
	return u.String(), nil
}
func FALAsset(raw string) (string, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || !(u.Hostname() == "fal.media" || strings.HasSuffix(u.Hostname(), ".fal.media")) {
		return "", Permanent("FAL image URL has an unexpected origin")
	}
	return u.String(), nil
}
func HTTPClient() *http.Client {
	return &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return fmt.Errorf("provider redirects are disabled")
	}}
}
func Pause(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
