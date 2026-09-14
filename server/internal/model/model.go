package model

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"
	"strings"
	"time"
	"worldsplat/internal/assets"

	"github.com/google/uuid"
)

type User struct {
	ID          string          `json:"id"`
	Email       string          `json:"email"`
	Name        string          `json:"name"`
	Generations int             `json:"generations"`
	Tabs        json.RawMessage `json:"tabs"`
}
type Job struct {
	ID           string          `json:"id"`
	UserID       string          `json:"user_id"`
	Prompt       string          `json:"prompt"`
	Status       string          `json:"status"`
	Error        string          `json:"error,omitempty"`
	SnapshotURI  string          `json:"snapshot_uri"`
	DepthURI     string          `json:"depth_uri"`
	WireframeURI string          `json:"wireframe_uri"`
	RenderURI    string          `json:"render_uri,omitempty"`
	SplatURI     string          `json:"splat_uri,omitempty"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
	FALRequest   json.RawMessage `json:"-"`
	TripoRequest json.RawMessage `json:"-"`
	RequestHash  string          `json:"-"`
}
type Tab struct {
	ID       string    `json:"id"`
	Type     string    `json:"type"`
	Name     string    `json:"name"`
	Snapshot *Snapshot `json:"snapshot,omitempty"`
	JobID    string    `json:"job_id,omitempty"`
}
type Snapshot struct {
	Prims           Build  `json:"prims"`
	BaseGroundColor string `json:"baseGroundColor"`
	Prompt          string `json:"prompt"`
}
type Build struct {
	Version    int         `json:"version"`
	Source     string      `json:"source,omitempty"`
	Ground     *Ground     `json:"ground,omitempty"`
	Primitives []Primitive `json:"primitives"`
}
type Primitive struct {
	Name        string    `json:"name,omitempty"`
	Type        string    `json:"type"`
	Position    []float64 `json:"position"`
	Rotation    []float64 `json:"rotation"`
	Scale       []float64 `json:"scale"`
	Color       string    `json:"color"`
	Locked      bool      `json:"locked"`
	Support     *int      `json:"support"`
	SupportAxis *Axis     `json:"supportAxis,omitempty"`
}
type Axis struct {
	Name string `json:"name"`
	Sign int    `json:"sign"`
}
type Ground struct {
	Size     float64  `json:"size"`
	Complete bool     `json:"complete"`
	Strokes  []Stroke `json:"strokes"`
	Image    string   `json:"image,omitempty"`
}
type Stroke struct {
	Mode   string      `json:"mode"`
	Color  string      `json:"color"`
	Radius float64     `json:"radius"`
	Closed bool        `json:"closed"`
	Points [][]float64 `json:"points"`
}

var color = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func StrictJSON(r io.Reader, v any) error {
	d := json.NewDecoder(r)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("expected one JSON value")
	}
	return nil
}
func vector(v []float64, n int, positive bool) bool {
	if len(v) != n {
		return false
	}
	for _, x := range v {
		if math.IsNaN(x) || math.IsInf(x, 0) || math.Abs(x) > 100000 || (positive && x <= 0) {
			return false
		}
	}
	return true
}
func ParseTabs(raw json.RawMessage) ([]Tab, error) {
	var tabs []Tab
	if err := StrictJSON(bytes.NewReader(raw), &tabs); err != nil {
		return nil, fmt.Errorf("invalid tabs: %w", err)
	}
	if tabs == nil || len(tabs) > 100 {
		return nil, fmt.Errorf("tabs must be an array of at most 100 tabs")
	}
	seen := map[string]bool{}
	for _, t := range tabs {
		if t.ID == "" || len(t.ID) > 100 || seen[t.ID] || strings.TrimSpace(t.Name) == "" || len(t.Name) > 200 {
			return nil, fmt.Errorf("tabs need unique IDs and names of 1–200 bytes")
		}
		seen[t.ID] = true
		switch t.Type {
		case "build":
			if t.Snapshot == nil || t.JobID != "" {
				return nil, fmt.Errorf("build tab requires snapshot and forbids job_id")
			}
			if err := t.Snapshot.Validate(); err != nil {
				return nil, err
			}
		case "splat":
			if _, err := uuid.Parse(t.JobID); err != nil || t.Snapshot != nil {
				return nil, fmt.Errorf("splat tab requires a job UUID and forbids snapshot")
			}
		default:
			return nil, fmt.Errorf("tab type must be build or splat")
		}
	}
	return tabs, nil
}
func (s Snapshot) Validate() error {
	if len(s.Prompt) > 8000 || (s.BaseGroundColor != "" && !color.MatchString(s.BaseGroundColor)) {
		return fmt.Errorf("invalid snapshot prompt or ground color")
	}
	b := s.Prims
	if b.Version < 1 || b.Version > 4 || b.Primitives == nil || len(b.Primitives) > 10000 || len(b.Source) > 200 {
		return fmt.Errorf("invalid build version or primitives")
	}
	for i, p := range b.Primitives {
		if p.Type != "box" || !vector(p.Position, 3, false) || !vector(p.Rotation, 3, false) || !vector(p.Scale, 3, true) || !color.MatchString(p.Color) || len(p.Name) > 200 {
			return fmt.Errorf("invalid primitive %d", i)
		}
		if p.Support != nil && (*p.Support < 0 || *p.Support >= len(b.Primitives) || *p.Support == i) {
			return fmt.Errorf("invalid support index")
		}
		if p.SupportAxis != nil && ((p.SupportAxis.Name != "x" && p.SupportAxis.Name != "y" && p.SupportAxis.Name != "z") || (p.SupportAxis.Sign != 1 && p.SupportAxis.Sign != -1)) {
			return fmt.Errorf("invalid support axis")
		}
	}
	// Each support chain must terminate; cycles would break editor attachment traversal.
	state := make([]uint8, len(b.Primitives))
	var visit func(int) bool
	visit = func(i int) bool {
		if state[i] == 1 {
			return false
		}
		if state[i] == 2 {
			return true
		}
		state[i] = 1
		if p := b.Primitives[i].Support; p != nil && !visit(*p) {
			return false
		}
		state[i] = 2
		return true
	}
	for i := range b.Primitives {
		if !visit(i) {
			return fmt.Errorf("cyclic primitive support")
		}
	}
	if g := b.Ground; g != nil {
		if g.Size <= 0 || g.Size > 100000 || len(g.Strokes) > 20000 {
			return fmt.Errorf("invalid ground")
		}
		if g.Image != "" && (!strings.HasPrefix(g.Image, "data:image/png;base64,") || len(g.Image) > 12<<20) {
			return fmt.Errorf("ground image must be an embedded PNG")
		}
		if g.Image != "" {
			data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(g.Image, "data:image/png;base64,"))
			if err != nil {
				return fmt.Errorf("invalid ground PNG encoding")
			}
			if err = assets.ValidatePNG(data); err != nil {
				return fmt.Errorf("invalid ground PNG: %w", err)
			}
		}
		total := 0
		for _, p := range g.Strokes {
			total += len(p.Points)
			if (p.Mode != "paint" && p.Mode != "erase") || !color.MatchString(p.Color) || p.Radius <= 0 || p.Radius > 100000 || len(p.Points) == 0 || total > 200000 {
				return fmt.Errorf("invalid ground stroke")
			}
			for _, v := range p.Points {
				if !vector(v, 2, false) {
					return fmt.Errorf("invalid stroke point")
				}
			}
		}
	}
	return nil
}
