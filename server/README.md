# WorldSplat backend

Go API + Temporal worker for Google sessions, PostgreSQL tabs/jobs, fal image editing, and the existing Avalon TripoSplat service. The browser uses Google Identity Services, account-backed build/splat tabs, and these generation endpoints.

## Run

Requires Go 1.26+, PostgreSQL, Redis, and Temporal. All API and worker processes must share the same `WS_DATA_DIR` filesystem.

```sh
cd server
cp .env.example .env
# Edit .env, including DATABASE_URL, FAL_KEY and WS_GOOGLE_CLIENT_ID.
set -a
. ./.env
set +a
go run . -mode namespace  # provision worldsplat once; safe to repeat
go run . -mode migrate
go run .                 # API + worker + durable job dispatcher
```

Modes: `all` (default), `api`, `worker`, `migrate`, `namespace`. Each serving mode applies the migration under a PostgreSQL advisory lock before startup. `api` and `worker` can run separately; both safely dispatch queued jobs. Namespace retention defaults to 30 days. `server/deploy/` contains an Avalon systemd unit and Caddy route. Run behind HTTPS in production; bind the Go listener to loopback when using Caddy.

The deployed API is available at `https://worldsplat.avalon.lagso.com` (alias `https://worldsplat-api.lagso.com`).

The deployment uses `/home/william/daemons/worldsplat/worldsplat.env`, `/home/william/storage/worldsplat/jobs` on the HDD, and the dedicated `worldsplat_app` PostgreSQL role. `worldsplat.service` starts automatically on boot. Provider secrets are read from the private env file. The credential-bearing local plan is excluded from Git and Docker build contexts.

Google login intentionally returns 503 until `WS_GOOGLE_CLIENT_ID` is set. Configure the Google Identity Services web client for the frontend's exact authorized JavaScript origins. Send its **ID token**, not an OAuth access token. No client secret is needed for ID-token verification. Restart the service after changing its environment.

## HTTP contract

JSON errors have the shape `{"error":"message"}`. Protected requests accept `Authorization: Bearer <token>`. Tokens are never accepted in URLs. The planned body `token` is also supported on login, logout, save_tabs and render.

| Method | Path | Input / result |
| --- | --- | --- |
| POST | `/login` | JSON `{token}` → `{token,user}`; existing session is reused before revalidating Google |
| POST | `/logout` | Bearer header or JSON `{token}` → 204; deletes this Redis session |
| GET | `/me`, `/tabs` | Current user, including saved tabs and generation count |
| POST | `/save_tabs` | JSON `{tabs:[...]}` → `{tabs:[...]}`; replaces all tabs atomically |
| POST | `/render` | Multipart `prompt`, `render` (or `snapshot`), `depth`, `wireframe`; three PNG files → 202 job + `Location` |
| GET | `/jobs?limit=50&offset=0` | `{jobs:[...]}` ordered newest first; max limit 100 |
| GET | `/jobs/{id}` | Owned job, status, error and asset URIs |
| GET | `/jobs/{id}/assets/{kind}` | Private file; kind is snapshot, depth, wireframe, render or splat |
| GET | `/status` | PostgreSQL, Redis, Temporal and recent worker poller health, plus login/render configuration flags; 503 on dependency failure |
| GET/HEAD | `/healthz` | Process liveness |
| GET | `/api/config` | Public browser settings, including Google client ID and backend capability flags |

Jobs move through `queued → rendering → splatting → completed`, or `failed`. The final splat is binary PLY. Asset URIs are relative API paths, not exposed HDD paths; fetch with the session bearer header. Another user's job or file always returns 404.

```js
const session = await fetch(`${api}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: googleCredential }),
}).then(r => r.json());

const body = new FormData();
body.set("prompt", prompt);
body.set("render", snapshotPNG, "snapshot.png");
body.set("depth", depthPNG, "depth.png");
body.set("wireframe", wireframePNG, "wireframe.png");
const response = await fetch(`${api}/render`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${session.token}`,
    "Idempotency-Key": requestID, // Keep this UUID when retrying the same upload.
  },
  body,
});
const job = await response.json();
// Poll GET /jobs/{job.id} until completed or failed.
```

Do not manually set multipart Content-Type; the browser includes the boundary. Supply the same `Idempotency-Key` and inputs after a request timeout. A duplicate returns the original job; using the key with different input returns 409. Without a key, each request is a new generation. Admission is serialized per user: defaults are two active jobs and ten accepted jobs per rolling 24 hours. Failed jobs count toward the daily limit because a provider may already have charged for them. Workers run at most two activities concurrently per process. For larger multi-tenant deployments, consider Temporal task queue fairness to distribute worker capacity between users.

Upload limits: 50 MiB total, 16 MiB per PNG, 4096×4096 dimensions; PNGs are decoded to reject corrupt content. Prompts allow 1–8000 bytes. Saved tabs allow 32 MiB total and 100 tabs. The default model consumes the snapshot; depth and wireframe are saved for future models. The prompt is passed through unchanged, so the client should include its scene-preservation instructions.

## Tabs, schema version 1

```json
[
  {
    "id": "build-1",
    "type": "build",
    "name": "Courtyard",
    "snapshot": {
      "prims": {
        "version": 4,
        "ground": {"size": 100, "complete": true, "strokes": []},
        "primitives": []
      },
      "baseGroundColor": "#779955",
      "prompt": "A stone courtyard"
    }
  },
  {
    "id": "splat-1",
    "type": "splat",
    "name": "Courtyard render",
    "job_id": "11111111-1111-4111-8111-111111111111"
  }
]
```

Tab IDs are unique strings of at most 100 bytes; convert the existing editor's numeric frame IDs to strings. Names allow 1–200 bytes. Build snapshots use the existing `snapshotBuildWorld()` format. Primitives support box type, position/rotation/scale vectors, hex color, locked state, optional name, support index and support axis. Ground includes editable paint/erase strokes and optional embedded PNG for legacy raster paint. Unknown JSON fields, malformed vectors, invalid support indices and support cycles are rejected. Splat tabs must reference a job belonging to the session user. Queued, running, failed and completed jobs are all accepted so tabs survive generation and reload. `[]` clears all tabs; `null` is rejected. Saves use last-write-wins semantics; multi-device merge/versioning is outside this phase.

## Sessions and durability

Google ID-token verification checks its signature, audience, expiry, issuer, subject, and verified email. Accounts are keyed by Google's stable subject; email is separately unique. As requested, the original ID token remains the client bearer credential after Google expiry while its Redis session exists. Redis stores `worldsplat:session:<SHA-256(token)> → user UUID`, keeping the raw bearer out of Redis keys. Sessions have a fixed 30-day TTL (`WS_SESSION_TTL`), do not slide on use, and are revoked by logout. Enable Redis persistence if sessions should survive Redis restarts. Google expiry prevents an old token from creating a new session after that session expires.

A PostgreSQL outbox (`jobs.dispatched`) bridges job creation and Temporal start. The dispatcher retries every five seconds using `worldsplat-<job UUID>` as a stable workflow ID and rejecting workflow ID reuse. A crashed API process cannot strand a committed queued job. FAL queue request IDs and TripoSplat event IDs are stored before polling; completed image stages are skipped on retry. Splat completion and the user's generation increment share one transaction and run only once. Files are private and replaced atomically.

Provider submissions do not offer a verified cross-provider exactly-once contract. The backend records a submission intent first. If a worker dies after submission but before saving the provider ID, it fails with an explicit "submission outcome is unknown" error instead of automatically spending again. An operator must inspect the provider before deciding to retry. A TripoSplat event stream is consumed once; its result URL is persisted before download so ordinary download retries do not consume it again. A crash between consuming that event and saving the result can still require operator recovery. Providers' auth/credit/input failures are not retried; transient polling/download errors have bounded Temporal retries.

Failure reporting is a separate cleanup activity with a disconnected context so workflow cancellation can still update the job. Public errors contain safe provider status classifications; raw provider responses, bearer tokens and credentials are not returned. Inspect `journalctl -u worldsplat` and Temporal history using the job ID for deeper diagnosis.

Files written before an ambiguous database commit are retained to avoid deleting inputs for a committed job. A crash before commit can leave an orphan directory. Back up PostgreSQL and the jobs directory together. Automated asset retention/deletion, billing, cancellation UI, and distributed disk storage are outside this implementation.

## Verify

```sh
cd server
go test -race ./...
go vet ./...
# Use an isolated disposable database, never the production worker's database:
TEST_DATABASE_URL='postgres://.../worldsplat_test' \
TEST_REDIS_URL='redis://127.0.0.1:6379/15' go test -race ./...
# Optional workflow determinism analysis; build the tool with the same Go version:
GOTOOLCHAIN=go1.26.8 go install go.temporal.io/sdk/contrib/tools/workflowcheck@v0.5.0
workflowcheck ./internal/pipeline/...
cd ..
npm ci
npm test
npx playwright install --with-deps chromium
npm run test:browser
```

Activity recovery tests also verify that saved provider requests are reused and a failed splat download retries from its persisted URL without consuming the Gradio stream twice. CI runs the database tests, client unit and Chromium browser tests, vet, and Docker build.

Integration tests create unique users and sessions, then remove only their own records. They verify login/session reuse, invalid tabs, cross-user access, idempotency under concurrent requests, upload validation, generation limits, exactly-once completion counting, logout, and CORS. The test verifier exists only in a `_test.go` file; the production server has no development-auth bypass.

Provider references: [fal queue API](https://fal.ai/docs/documentation/model-apis/inference/queue), [FLUX.2 Klein 4B edit schema](https://fal.ai/models/fal-ai/flux-2/klein/4b/edit/api), [Google backend ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token). TripoSplat compatibility was checked against Avalon's live `/gradio_api/info` and `run_gradio.py`.
