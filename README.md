# WorldSplat

Build a block-out world in the browser and WorldSplat turns it into a 3D Gaussian splat: the block-out render is detailed into an image with FLUX, then reconstructed into a splat with TripoSplat. Sign in with Google, edit independent build tabs, and generate view-only splat tabs. Tabs and render history are saved to your account in PostgreSQL. The Go backend runs fal → TripoSplat through Temporal; provider credentials stay on the server.

- `client/` — the whole app as a static site, no build step.
- `api/` — two serverless functions: `/api/config` (public runtime config) and `/healthz`.
- `server/` — Go API and Temporal worker, with PostgreSQL/Redis persistence and private asset storage. See [server setup and API contract](server/README.md).
- `fixtures/` — dev-only session ZIPs for testing splat flows without spending GPU quota. Not deployed.

## Run locally

For UI work, serve the static client and open http://localhost:8080/app/:

```sh
python3 -m http.server 8080 --directory client
```

The editor opens without sign-in or backend services. Signed-out edits last until reload; generating requires an authenticated backend and displays errors in the editor.

On localhost port 8080, the client connects to the live backend at `https://worldsplat.app`. Open `http://localhost:8080/` to sign in; saves and generation use your live account. Add `http://localhost` and `http://localhost:8080` to Google's Authorized JavaScript origins, and append `http://localhost:8080` to Avalon's `WS_ALLOWED_ORIGINS` before restarting the service.

For the Go backend, configure PostgreSQL, Redis, Temporal and `server/.env` following [server/README.md](server/README.md), then run `cd server && go run .` → http://localhost:8067.

## Tests

```sh
(cd server && go test -race ./...)
npm ci
npm test
npx playwright install --with-deps chromium
npm run test:browser
```

## Deploy

The app and API are deployed together at https://worldsplat.avalon.lagso.com. For a separate Vercel frontend, deploy with `npx vercel deploy --prod` and set `.env.example` variables; add that frontend origin to the backend's `WS_ALLOWED_ORIGINS`.

In Google Cloud, configure a Web application client with Authorized JavaScript origins for each frontend you use, such as `https://worldsplat.avalon.lagso.com`, `https://worldsplat.vercel.app`, and `http://localhost:8080`. Leave Authorized redirect URIs empty: the native Google Identity Services button uses a popup and JavaScript callback. No Google client secret is needed.

The top bar contains only native daisyUI `tabs tabs-lift` tabs. New accounts start with a blank Canvas tab followed by Example 1 through Example 4, seeded from every bundled default scene and saved once; existing account tabs are restored. Arrow keys, Home and End navigate tabs. Render creates a disabled splat tab immediately, showing a red spinner and a stage-based ETA until the splat is ready. Double-click a ready tab name to rename it inline. Ctrl+S or Cmd+S saves only the current tab; edits do not autosave. The selected tab shows an unsaved dot, replaced by a close button once saved when more than one tab is open. Save failures keep the dot visible until an explicit retry succeeds. Concurrent browser windows use last-write-wins saves. Google sign-in uses a black daisyUI button container matching the earlier landing-page button dimensions.

Self-hosted container:

```sh
docker build -t worldsplat .
docker run --rm -p 8067:8067 --env-file server/.env -v worldsplat-data:/app/output worldsplat
```

Container dependency addresses must be reachable from the container; `127.0.0.1` refers to the container itself. Set `WS_ADDR=:8067` for published Docker ports.
