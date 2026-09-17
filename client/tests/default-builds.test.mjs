import assert from "node:assert/strict"
import test from "node:test"

import { loadDefaultBuildSeeds } from "../scripts/default-builds.js"

const manifest = {
	maps: [
		{ file: "desert_sun_market.json" },
		{ file: "frostwatch_observatory.json" },
		{ file: "drowned_temple_ruins.json" },
		{ file: "skyforge_courtyard.json" },
	],
}

function fetcherFor(fixtures, requested = []) {
	return async url => {
		requested.push(url)
		return {
			ok: fixtures.has(url),
			status: fixtures.has(url) ? 200 : 404,
			json: async () => fixtures.get(url),
		}
	}
}

function fixturesWithAllMaps() {
	const fixtures = new Map([["/assets/default_maps/manifest.json", manifest]])
	for (const map of manifest.maps) {
		fixtures.set(`/assets/default_maps/${map.file}`, {
			version: 4,
			ground: { strokes: [] },
			primitives: [{ type: "box" }],
		})
	}
	return fixtures
}

test("seeds every bundled scene as a numbered example with its scene prompt", async () => {
	const requested = []
	const seeds = await loadDefaultBuildSeeds(fetcherFor(fixturesWithAllMaps(), requested))
	assert.equal(seeds.length, manifest.maps.length)
	assert.deepEqual(seeds.map(seed => seed.name), ["Example 1", "Example 2", "Example 3", "Example 4"])
	assert.deepEqual(seeds.map(seed => seed.prompt), ["Desert Sun Market", "Frostwatch Observatory", "Drowned Temple Ruins", "Skyforge Courtyard"])
	const mapFiles = requested.filter(url => !url.endsWith("manifest.json"))
	assert.deepEqual(mapFiles, manifest.maps.map(map => `/assets/default_maps/${map.file}`))
})

test("keeps ground data on every seed", async () => {
	const seeds = await loadDefaultBuildSeeds(fetcherFor(fixturesWithAllMaps()))
	for (const seed of seeds) {
		assert.equal(seed.prims.ground.strokes.length, 0)
	}
})

test("fails clearly when the manifest is missing", async () => {
	await assert.rejects(
		loadDefaultBuildSeeds(fetcherFor(new Map())),
		/default maps manifest/,
	)
})
