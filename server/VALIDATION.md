# WorldSplat validation — 2026-09-13

Deployed and running as `worldsplat.service` on Avalon. HTTPS health endpoint: https://worldsplat.avalon.lagso.com/status. PostgreSQL, Redis, Temporal and worker checks passed after restart. The service is enabled at boot.

- Go unit and integration tests passed with `-race`, using a separate `worldsplat_test` database and Redis DB 15. No production auth bypass was added.
- `go vet ./...` and Temporal `workflowcheck ./internal/pipeline/...` passed.
- All 62 client unit tests and eight Chromium browser tests passed. Coverage includes Google callback success/rejection, logout, independent build tabs, rename/close/reload, serialized save retries, pending jobs, visible splat pixels, PLY download, reopening render history, mobile keyboard navigation, and long names in an overflowing tablet tab bar. The Google callback is mocked only in browser tests.
- Docker image build and container binary startup passed.
- One paid fal image request completed. Its PNG was persisted and downloaded through the authenticated API: 1,692,422 bytes.
- The live TripoSplat test produced a binary Gaussian PLY with 131,072 vertices, 8,913,312 bytes. The first integration attempt exposed Gradio's DownloadButton update wrapper; the adapter was fixed and the splat stage rerun using the already saved fal image.
- A second diagnostic job reused the saved provider results. It was inserted while the service was stopped, then automatically dispatched and completed after restart. This required no additional fal or GPU generation. The two completed jobs incremented their diagnostic user's counter exactly twice.
- Cross-user job/file access, repeated and concurrent idempotency keys, malformed tabs, corrupt PNGs, provider credit failures, failed-download recovery, logout and CORS were covered by tests.

The diagnostic jobs and their HDD assets remain for operator inspection. All temporary test sessions were revoked after verification, and a follow-up `/me` returned 401. Ordinary users cannot access these jobs.

Google OAuth configuration update: the supplied public client ID is now set in `/home/william/daemons/worldsplat/worldsplat.env` and `server/.env.example`. The service was restarted; HTTPS `/status` reports `login_configured: true`, `/api/config` returns the matching client ID, and `/login` rejects an invalid credential with 401. The Google frontend migration is deployed. The live native Google button renders, but Google reports `The given origin is not allowed for the given client ID`. Add `https://worldsplat.avalon.lagso.com` under Authorized JavaScript origins in the Google Cloud web client. Add any separately used Vercel/local frontend origins too. Authorized redirect URIs remain empty because this integration uses the popup callback flow. Actual Google account sign-in cannot be completed until that console setting is updated and the user signs in interactively. The backend already allows the deployed Avalon and Vercel origins in CORS.

Redis already has RDB snapshots enabled; append-only persistence is disabled. Sessions therefore survive snapshots/restores, but the most recent unsnapshotted sessions can be lost on a Redis crash. No shared Redis configuration was changed.

## Client deployment and live browser checks

The Google client and native daisyUI tabs are deployed on Avalon alongside the updated API. Build tabs persist geometry, ground and prompts in PostgreSQL; pending/completed/failed splat tabs persist owned job IDs. Closing a splat tab retains its render in account history. Saves are serialized, display failure/retry state, and warn before leaving with unsaved edits. The legacy IndexedDB workspace/history and Hugging Face login are no longer used by the editor.

Live Chromium checks used a short-lived Redis session scoped to the existing diagnostic account; no server authentication bypass was added. Creating and renaming tabs, saving independent prompts, refreshing, reopening a completed job, displaying its actual splat pixels and downloading the 8,913,312-byte PLY all passed against the real HTTPS API. There were no page JavaScript exceptions. The self-hosted site has an existing optional Vercel analytics script 404; that does not affect the workspace.

A fresh render submitted through the live browser completed as job `a3965527-139c-4806-9041-10f1cb8782c0`. Its pending tab survived reload; the worker completed both provider stages and the browser displayed the finished splat. The snapshot, depth and wireframe uploads were distinct 1024×1024 PNGs (45,462 / 59,448 / 71,660 bytes), and the generated image was 1,825,007 bytes. The final PLY has 131,072 vertices. This added one paid fal request; the earlier checks used one paid fal request, for two in total. A software-rendered 1440×1000 browser stalled during the final pixel probe while the container was compiling; reopening the completed job at 960×720 passed the pixel check and screenshot capture. No repeat generation was needed. The final Docker build passed. After the last tab layout update, the live splat pixel check and screenshot capture passed again. The diagnostic account has three completed generations; its temporary session was revoked and local credential files removed.

## UI simplification — 2026-09-14

The landing sign-in uses the daisyUI button component with a black, 56px-high, 16px-radius treatment and Google's native filled-black button. The editor header now contains only `tabs tabs-lift`, without branding, add/close controls, badges, render history or account controls. A new workspace starts with one Build 1 tab; existing account data and background autosaving remain intact. Browser tests were updated for this simplified UI.

After the simplification, all 62 unit tests and nine Chromium browser tests passed. The black Google button and single-tab default workspace were visually inspected, and the updated static client was deployed on Avalon.
