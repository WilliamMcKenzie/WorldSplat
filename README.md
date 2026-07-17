# WorldSplat

Build a block-out world in the browser and WorldSplat turns it into a 3D Gaussian splat: the block-out render is detailed into an image with FLUX, then reconstructed into a splat with TripoSplat. Generation runs in the visitor's own browser through their Hugging Face sign-in — the server never receives or stores their token, images, or splats.

- `client/` — the whole app as a static site, no build step.
- `api/` — two serverless functions: `/api/config` (public runtime config) and `/healthz`.
- `server/` — optional Go server for self-hosting the same client (`Dockerfile` builds it).
- `fixtures/` — dev-only session ZIPs for testing splat flows without spending GPU quota. Not deployed.

## Run locally

```sh
cp .env.example .env
npx vercel dev        # client + /api/config on http://localhost:3000
```

or, with the Go server: `cd server && go run .` → http://localhost:8067

## Tests

```sh
cd server && go test ./...
node --test client/tests/*.test.mjs
```

## Deploy

Vercel is primary: push, or `npx vercel deploy --prod`. Configuration is environment variables only — see `.env.example`. Before using a production domain, register its exact HTTPS URL (trailing slash included) on the Hugging Face OAuth app and set `WS_HF_REDIRECT_URL` to the same value.

Self-hosted container:

```sh
docker build -t worldsplat .
docker run --rm -p 8067:8067 --env-file .env worldsplat
```
