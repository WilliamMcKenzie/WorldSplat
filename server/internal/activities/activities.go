package activities

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
	"worldsplat/internal/assets"
	"worldsplat/internal/providers"
	"worldsplat/internal/store"
)

type Activities struct {
	Store  *store.Store
	Assets assets.Store
	FAL    providers.FAL
	Tripo  providers.Tripo
}

func heartbeat(ctx context.Context) func() {
	done := make(chan struct{})
	stopped := make(chan struct{})
	activity.RecordHeartbeat(ctx, "provider activity running")
	go func() {
		defer close(stopped)
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				activity.RecordHeartbeat(ctx, "provider activity running")
			}
		}
	}()
	return func() { close(done); <-stopped }
}
func (a *Activities) RenderVisual(ctx context.Context, id string) error {
	stop := heartbeat(ctx)
	defer stop()
	j, e := a.Store.Job(ctx, id)
	if e != nil {
		return e
	}
	if j.RenderURI != "" {
		return nil
	}
	if e = a.Store.Stage(ctx, id, "rendering"); e != nil {
		return e
	}
	var req providers.FALRequest
	if len(j.FALRequest) > 0 {
		if e = json.Unmarshal(j.FALRequest, &req); e != nil {
			return e
		}
		if req.RequestID == "" {
			return providers.Permanent("FAL submission outcome is unknown; check the FAL dashboard before submitting another job")
		}
	} else {
		png, e := a.Assets.Read(id, "snapshot")
		if e != nil {
			return e
		}
		depth, e := a.Assets.Read(id, "depth")
		if e != nil {
			return e
		}
		if a.FAL.Key == "" {
			return providers.Permanent("FAL_KEY is not configured")
		}
		claimed, e := a.Store.ClaimProvider(ctx, id, "fal")
		if e != nil {
			return e
		}
		if !claimed {
			return fmt.Errorf("FAL submission already claimed")
		}
		req, e = a.FAL.Submit(ctx, j.Prompt, png, depth)
		if e != nil {
			return e
		}
		// Persist before polling. Subsequent activity attempts reuse this exact paid request.
		if e = a.Store.SaveRequest(ctx, id, "fal", req); e != nil {
			return e
		}
	}
	for {
		uri, done, e := a.FAL.Poll(ctx, req)
		if e != nil {
			return e
		}
		if done {
			uri, e = providers.FALAsset(uri)
			if e != nil {
				return e
			}
			if e = a.Assets.Download(ctx, a.FAL.Client, id, "render", uri); e != nil {
				return e
			}
			return a.Store.SaveRender(ctx, id, assets.URI(id, "render"))
		}
		if e = providers.Pause(ctx, 3*time.Second); e != nil {
			return e
		}
	}
}
func (a *Activities) RenderSplat(ctx context.Context, id string) error {
	stop := heartbeat(ctx)
	defer stop()
	j, e := a.Store.Job(ctx, id)
	if e != nil {
		return e
	}
	if j.Status == "completed" {
		return nil
	}
	if e = a.Store.Stage(ctx, id, "splatting"); e != nil {
		return e
	}
	var req providers.TripoRequest
	if len(j.TripoRequest) > 0 {
		if e = json.Unmarshal(j.TripoRequest, &req); e != nil {
			return e
		}
		if req.EventID == "" {
			return providers.Permanent("TripoSplat submission outcome is unknown; inspect its queue before submitting another job")
		}
	} else {
		png, e := a.Assets.Read(id, "render")
		if e != nil {
			return e
		}
		claimed, e := a.Store.ClaimProvider(ctx, id, "tripo")
		if e != nil {
			return e
		}
		if !claimed {
			return fmt.Errorf("TripoSplat submission already claimed")
		}
		req, e = a.Tripo.Submit(ctx, png)
		if e != nil {
			return e
		}
		if e = a.Store.SaveRequest(ctx, id, "tripo", req); e != nil {
			return e
		}
	}
	uri := req.ResultURL
	if uri == "" {
		uri, e = a.Tripo.Result(ctx, req)
		if e != nil {
			return e
		}
		req.ResultURL = uri
		if e = a.Store.SaveRequest(ctx, id, "tripo", req); e != nil {
			return e
		}
	}
	uri, e = providers.SameOrigin(a.Tripo.BaseURL, uri)
	if e != nil {
		return e
	}
	if e = a.Assets.Download(ctx, a.Tripo.Client, id, "splat", uri); e != nil {
		return e
	}
	return a.Store.Complete(ctx, id, assets.URI(id, "splat"))
}
func (a *Activities) FailJob(ctx context.Context, id, message string) error {
	return a.Store.Fail(ctx, id, message)
}
