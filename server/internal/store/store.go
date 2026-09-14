package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"worldsplat/internal/model"
)

var ErrLimit = errors.New("generation limit reached")
var ErrConflict = errors.New("idempotency key already used for different input")

type Store struct{ Pool *pgxpool.Pool }

const userCols = "id::text,email,name,generations,tabs"

func scanUser(row pgx.Row) (u model.User, err error) {
	err = row.Scan(&u.ID, &u.Email, &u.Name, &u.Generations, &u.Tabs)
	return
}
func (s *Store) UpsertUser(ctx context.Context, sub, email, name string) (model.User, error) {
	return scanUser(s.Pool.QueryRow(ctx, `INSERT INTO public.users(id,google_subject,email,name) VALUES($1,$2,$3,$4) ON CONFLICT(google_subject) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,updated_at=now() RETURNING `+userCols, uuid.NewString(), sub, email, name))
}
func (s *Store) User(ctx context.Context, id string) (model.User, error) {
	return scanUser(s.Pool.QueryRow(ctx, "SELECT "+userCols+" FROM public.users WHERE id=$1", id))
}
func (s *Store) SaveTabs(ctx context.Context, id string, tabs []model.Tab, raw json.RawMessage) error {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	for _, t := range tabs {
		if t.Type == "splat" {
			var ok bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM public.jobs WHERE id=$1 AND user_id=$2 )", t.JobID, id).Scan(&ok); e != nil {
				return e
			}
			if !ok {
				return fmt.Errorf("splat job does not exist or belongs to another user")
			}
		}
	}
	tag, e := tx.Exec(ctx, "UPDATE public.users SET tabs=$2,updated_at=now() WHERE id=$1", id, raw)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return pgx.ErrNoRows
	}
	return tx.Commit(ctx)
}

const jobCols = "id::text,user_id::text,prompt,status,error,snapshot_uri,depth_uri,wireframe_uri,render_uri,splat_uri,created_at,updated_at,fal_request,tripo_request,request_hash"

func scanJob(row pgx.Row) (j model.Job, e error) {
	e = row.Scan(&j.ID, &j.UserID, &j.Prompt, &j.Status, &j.Error, &j.SnapshotURI, &j.DepthURI, &j.WireframeURI, &j.RenderURI, &j.SplatURI, &j.CreatedAt, &j.UpdatedAt, &j.FALRequest, &j.TripoRequest, &j.RequestHash)
	return
}
func (s *Store) Job(ctx context.Context, id string) (model.Job, error) {
	return scanJob(s.Pool.QueryRow(ctx, "SELECT "+jobCols+" FROM public.jobs WHERE id=$1", id))
}
func (s *Store) UserJob(ctx context.Context, id, user string) (model.Job, error) {
	return scanJob(s.Pool.QueryRow(ctx, "SELECT "+jobCols+" FROM public.jobs WHERE id=$1 AND user_id=$2", id, user))
}
func (s *Store) Jobs(ctx context.Context, user string, limit, offset int) ([]model.Job, error) {
	rows, e := s.Pool.Query(ctx, "SELECT "+jobCols+" FROM public.jobs WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3", user, limit, offset)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	jobs := []model.Job{}
	for rows.Next() {
		j, e := scanJob(rows)
		if e != nil {
			return nil, e
		}
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}
func (s *Store) CreateJob(ctx context.Context, j model.Job, key string, active, daily int) (model.Job, bool, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return j, false, e
	}
	defer tx.Rollback(ctx)
	// Serializes admission per user, including idempotent concurrent submissions.
	if _, e = tx.Exec(ctx, "SELECT id FROM public.users WHERE id=$1 FOR UPDATE", j.UserID); e != nil {
		return j, false, e
	}
	old, e := scanJob(tx.QueryRow(ctx, "SELECT "+jobCols+" FROM public.jobs WHERE user_id=$1 AND idempotency_key=$2", j.UserID, key))
	if e == nil {
		if old.RequestHash != j.RequestHash {
			return old, false, ErrConflict
		}
		return old, false, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return j, false, e
	}
	var n, d int
	if e = tx.QueryRow(ctx, `SELECT count(*) FILTER(WHERE status IN ('queued','rendering','splatting')), count(*) FILTER(WHERE created_at >= now()-interval '24 hours') FROM public.jobs WHERE user_id=$1`, j.UserID).Scan(&n, &d); e != nil {
		return j, false, e
	}
	if n >= active || d >= daily {
		return j, false, ErrLimit
	}
	j, e = scanJob(tx.QueryRow(ctx, `INSERT INTO public.jobs(id,user_id,prompt,snapshot_uri,depth_uri,wireframe_uri,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING `+jobCols, j.ID, j.UserID, j.Prompt, j.SnapshotURI, j.DepthURI, j.WireframeURI, key, j.RequestHash))
	if e != nil {
		return j, false, e
	}
	return j, true, tx.Commit(ctx)
}
func (s *Store) Pending(ctx context.Context) ([]string, error) {
	r, e := s.Pool.Query(ctx, "SELECT id::text FROM public.jobs WHERE dispatched=false AND status='queued' ORDER BY created_at LIMIT 100")
	if e != nil {
		return nil, e
	}
	defer r.Close()
	var ids []string
	for r.Next() {
		var id string
		if e = r.Scan(&id); e != nil {
			return nil, e
		}
		ids = append(ids, id)
	}
	return ids, r.Err()
}
func (s *Store) Dispatched(ctx context.Context, id string) error {
	_, e := s.Pool.Exec(ctx, "UPDATE public.jobs SET dispatched=true WHERE id=$1", id)
	return e
}
func (s *Store) Stage(ctx context.Context, id, status string) error {
	_, e := s.Pool.Exec(ctx, "UPDATE public.jobs SET status=$2,updated_at=now() WHERE id=$1 AND status NOT IN ('completed','failed')", id, status)
	return e
}
func (s *Store) ClaimProvider(ctx context.Context, id, provider string) (bool, error) {
	col, e := providerColumn(provider)
	if e != nil {
		return false, e
	}
	t, e := s.Pool.Exec(ctx, "UPDATE public.jobs SET "+col+"='{\"submitting\":true}',updated_at=now() WHERE id=$1 AND "+col+" IS NULL", id)
	return t.RowsAffected() == 1, e
}
func providerColumn(p string) (string, error) {
	switch p {
	case "fal":
		return "fal_request", nil
	case "tripo":
		return "tripo_request", nil
	}
	return "", fmt.Errorf("unknown provider")
}
func (s *Store) SaveRequest(ctx context.Context, id, p string, request any) error {
	col, e := providerColumn(p)
	if e != nil {
		return e
	}
	b, e := json.Marshal(request)
	if e != nil {
		return e
	}
	_, e = s.Pool.Exec(ctx, "UPDATE public.jobs SET "+col+"=$2,updated_at=now() WHERE id=$1", id, b)
	return e
}
func (s *Store) SaveRender(ctx context.Context, id, uri string) error {
	_, e := s.Pool.Exec(ctx, "UPDATE public.jobs SET render_uri=$2,updated_at=now() WHERE id=$1", id, uri)
	return e
}
func (s *Store) Complete(ctx context.Context, id, uri string) error {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var user string
	e = tx.QueryRow(ctx, "UPDATE public.jobs SET status='completed',splat_uri=$2,error='',updated_at=now() WHERE id=$1 AND status NOT IN ('completed','failed') RETURNING user_id::text", id, uri).Scan(&user)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "UPDATE public.users SET generations=generations+1,updated_at=now() WHERE id=$1", user); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (s *Store) Fail(ctx context.Context, id, message string) error {
	_, e := s.Pool.Exec(ctx, "UPDATE public.jobs SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status!='completed'", id, message)
	return e
}
