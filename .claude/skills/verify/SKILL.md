---
name: verify
description: Drive the WorldSketch client in a headless browser to verify renderer/pipeline changes at the real surface.
---

# Verifying WorldSketch client changes

The app is a static client served by the Go server; the browser is the surface.

## Launch

- The dev server is often already running: `lsof -i :8067 -sTCP:LISTEN`. It serves
  `client/` straight from disk, so file edits are live on reload — no build step.
- Otherwise: `cd server && go run .` (port from `PORT`, default 8067; env from `.env`).
- The editor lives at `/app/` (`client/app/index.html`); `/` is the marketing landing
  page and `/login` the Hugging Face sign-in. Drive `http://localhost:8067/app/`.
  Static files are always live, but compiled Go routes are not — if server code
  changed, start a fresh instance on another PORT rather than trusting the old binary.

## Drive (Playwright)

- No repo Playwright dep. Install into the session scratchpad (`npm init -y && npm
  install playwright`) and launch with the system Chrome: `chromium.launch({ channel:
  "chrome", headless: true })` — avoids the browser download.
- Load a real generated scene WITHOUT HuggingFace auth by uploading a bundled session
  ZIP into the hidden input: `page.locator("#upload_zip_input").setInputFiles("fixtures/
  test-scene.zip")` (also `test-campsite.zip`, `test-4obj.zip`; the fixtures live in
  `fixtures/`, outside the deployed `client/`). This re-runs the full
  fit + segmentation pipeline (`segmentSceneSplat`).
- Evidence channels: console lines prefixed `[fit]` / `[segment]` (capture via
  `page.on("console", ...)`), `window.__wsSegLast` / `window.__wsSegClaims` globals,
  and screenshots. Segmentation of test-scene.zip takes ~10-30s; wait for the
  `[segment] content →` summary (or a `collapse guard` warn).
- Dev controls: `page.keyboard.press("Backquote")` shows the settings gear + tuning
  panel. Tuning sliders are `[data-tune-id="..."]` range inputs — set `.value` then
  dispatch an `input` event; uncheck `[data-tune-live]` first, then click
  `[data-tune-retune]` ("Apply to current scene") for one batched retune.
- Tabs: `[data-view-tab="view"|"play"|"build"]` buttons (View/Play enable only after a
  scene exists).

## Gotchas

- Extreme tuning-panel culling on a well-fit scene still keeps ~97% of gaussians — you
  cannot reproduce a segmentation collapse via knobs alone; collapse requires a bad
  seating. To exercise collapse-only paths, fault-inject (e.g. temporarily raise the
  guard threshold) and revert.
- The user's own browser may be attached to the same server; don't mutate server state
  (the server is a static file host, so driving your own page is safe).
