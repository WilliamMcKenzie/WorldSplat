import assert from "node:assert/strict"
import test from "node:test"

import { DEFAULT_SEED_COUNT, loadDefaultBuildSeeds } from "../scripts/default-builds.js"

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

test("seeds two distinct random maps named Example 1 and Example 2", async () => {
	const requested = []
	const seeds = await loadDefaultBuildSeeds(fetcherFor(fixturesWithAllMaps(), requested))
	assert.equal(seeds.length, DEFAULT_SEED_COUNT)
	assert.deepEqual(seeds.map(seed => seed.name), ["Example 1", "Example 2"])
	const mapFiles = requested.filter(url => !url.endsWith("manifest.json"))
	assert.equal(new Set(mapFiles).size, DEFAULT_SEED_COUNT)
})

test("shuffle is driven by the injected random source", async () => {
	// random() = 0 swaps every element to the front in turn: pool ends
	// [frostwatch, drowned, skyforge, desert] → fetches the first two.
	const requested = []
	await loadDefaultBuildSeeds(fetcherFor(fixturesWithAllMaps(), requested), { random: () => 0 })
	assert.deepEqual(requested.filter(url => !url.endsWith("manifest.json")), [
		"/assets/default_maps/frostwatch_observatory.json",
		"/assets/default_maps/drowned_temple_ruins.json",
	])
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
