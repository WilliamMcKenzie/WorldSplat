import assert from "node:assert/strict"
import test from "node:test"

import configHandler, { runtimeConfig } from "../../api/config.mjs"
import healthHandler from "../../api/healthz.mjs"

test("Vercel config function matches the server defaults", async () => {
	const config = runtimeConfig()
	assert.equal(config.generation.provider, "backend")
	assert.match(config.backend.googleClientId, /\.apps\.googleusercontent\.com$/)
	assert.equal(config.backend.apiBaseURL, "https://worldsplat-api.lagso.com")

	const response = await configHandler.fetch(new Request("https://example.com/api/config"))
	assert.equal(response.status, 200)
	assert.equal(response.headers.get("cache-control"), "no-cache")
	assert.deepEqual(await response.json(), config)
})

test("Vercel config function clamps integer environment values", () => {
	const previous = process.env.WS_SCENE_OPACITY_FLOOR
	process.env.WS_SCENE_OPACITY_FLOOR = "9000"
	try {
		assert.equal(runtimeConfig().scene.opacityFloor, 1)
	} finally {
		if (previous === undefined) delete process.env.WS_SCENE_OPACITY_FLOOR
		else process.env.WS_SCENE_OPACITY_FLOOR = previous
	}
})

test("Vercel health function supports GET and HEAD", async () => {
	const getResponse = await healthHandler.fetch(new Request("https://example.com/healthz"))
	assert.equal(getResponse.status, 200)
	assert.equal(await getResponse.text(), "ok\n")

	const headResponse = await healthHandler.fetch(new Request("https://example.com/healthz", { method: "HEAD" }))
	assert.equal(headResponse.status, 200)
	assert.equal(await headResponse.text(), "")
})
