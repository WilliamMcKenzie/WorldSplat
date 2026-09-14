CREATE TABLE IF NOT EXISTS public.users (
 id uuid PRIMARY KEY,
 google_subject text NOT NULL UNIQUE,
 email text NOT NULL UNIQUE,
 name text NOT NULL,
 generations integer NOT NULL DEFAULT 0 CHECK (generations >= 0),
 tabs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tabs) = 'array'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.jobs (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 prompt text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','rendering','splatting','completed','failed')),
 error text NOT NULL DEFAULT '',
 snapshot_uri text NOT NULL,
 depth_uri text NOT NULL,
 wireframe_uri text NOT NULL,
 render_uri text NOT NULL DEFAULT '',
 splat_uri text NOT NULL DEFAULT '',
 fal_request jsonb,
 tripo_request jsonb,
 idempotency_key text NOT NULL,
 request_hash text NOT NULL,
 dispatched boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_user_created ON public.jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_dispatch ON public.jobs(created_at) WHERE dispatched = false AND status = 'queued';
