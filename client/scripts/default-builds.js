export const DEFAULT_MAPS_DIR = "/assets/default_maps"
export const DEFAULT_SEED_COUNT = 2

// Fresh sessions seed from the checked-in default maps folder: read its manifest,
// pick `count` distinct maps at random, and load them with their ground data intact.
// Frames are named "Example 1", "Example 2", … regardless of which maps were drawn.
export async function loadDefaultBuildSeeds(fetcher = fetch, { count = DEFAULT_SEED_COUNT, random = Math.random } = {}) {
	const manifestResponse = await fetcher(`${DEFAULT_MAPS_DIR}/manifest.json`)
	if (!manifestResponse.ok) throw new Error(`Could not load the default maps manifest (${manifestResponse.status})`)
	const manifest = await manifestResponse.json()
	const maps = Array.isArray(manifest?.maps) ? manifest.maps.filter(map => typeof map?.file === "string") : []
	if (!maps.length) throw new Error("The default maps manifest lists no maps")
	const pool = [...maps]
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1))
		;[pool[i], pool[j]] = [pool[j], pool[i]]
	}
	const chosen = pool.slice(0, Math.max(1, Math.min(count, pool.length)))
	return Promise.all(chosen.map(async (map, index) => {
		const response = await fetcher(`${DEFAULT_MAPS_DIR}/${map.file}`)
		if (!response.ok) throw new Error(`Could not load default map ${map.file} (${response.status})`)
		const prims = await response.json()
		if (!Array.isArray(prims?.primitives)) throw new Error(`Default map ${map.file} has no primitives`)
		return { name: `Example ${index + 1}`, prims }
	}))
}
