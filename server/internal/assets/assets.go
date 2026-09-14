package assets

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

const MaxPNG int64 = 16 << 20
const MaxSplat int64 = 128 << 20

type Store struct{ Root string }

func (s Store) Path(id, kind string) (string, error) {
	if _, e := uuid.Parse(id); e != nil {
		return "", fmt.Errorf("invalid job ID")
	}
	switch kind {
	case "snapshot", "depth", "wireframe", "render":
		return filepath.Join(s.Root, id, kind+".png"), nil
	case "splat":
		return filepath.Join(s.Root, id, "splat.ply"), nil
	}
	return "", fmt.Errorf("invalid asset")
}
func URI(id, kind string) string { return "/jobs/" + id + "/assets/" + kind }
func ValidatePNG(data []byte) error {
	if len(data) == 0 || int64(len(data)) > MaxPNG {
		return fmt.Errorf("PNG exceeds 16 MiB")
	}
	c, e := png.DecodeConfig(bytes.NewReader(data))
	if e != nil {
		return fmt.Errorf("invalid PNG")
	}
	if c.Width < 1 || c.Height < 1 || c.Width > 4096 || c.Height > 4096 || c.Width*c.Height > 16<<20 {
		return fmt.Errorf("PNG dimensions exceed 4096 × 4096")
	}
	if _, e = png.Decode(bytes.NewReader(data)); e != nil {
		return fmt.Errorf("corrupt PNG")
	}
	return nil
}
func (s Store) Put(id, kind string, data []byte) error {
	p, e := s.Path(id, kind)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(p), ".partial-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if _, e = f.Write(data); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(f.Name(), p)
}
func (s Store) Remove(id string) error {
	p, e := s.Path(id, "snapshot")
	if e != nil {
		return e
	}
	return os.RemoveAll(filepath.Dir(p))
}
func (s Store) Read(id, kind string) ([]byte, error) {
	p, e := s.Path(id, kind)
	if e != nil {
		return nil, e
	}
	return os.ReadFile(p)
}
func ReadLimited(r io.Reader, max int64) ([]byte, error) {
	b, e := io.ReadAll(io.LimitReader(r, max+1))
	if e != nil {
		return nil, e
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("file exceeds size limit")
	}
	return b, nil
}
func (s Store) Download(ctx context.Context, c *http.Client, id, kind, uri string) error {
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, uri, nil)
	if e != nil {
		return e
	}
	res, e := c.Do(req)
	if e != nil {
		return fmt.Errorf("asset download failed")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("asset download returned HTTP %d", res.StatusCode)
	}
	max := MaxPNG
	if kind == "splat" {
		max = MaxSplat
	}
	b, e := ReadLimited(res.Body, max)
	if e != nil {
		return e
	}
	if kind == "splat" {
		if e = ValidatePLY(b); e != nil {
			return e
		}
	} else if e = ValidatePNG(b); e != nil {
		return e
	}
	return s.Put(id, kind, b)
}
