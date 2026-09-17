export const DEFAULT_MAPS_DIR = "/assets/default_maps"
// New workspaces start with every bundled scene, in manifest order.
export async function loadDefaultBuildSeeds(fetcher = fetch) {
	const manifestResponse = await fetcher(`${DEFAULT_MAPS_DIR}/manifest.json`)
	if (!manifestResponse.ok) throw new Error(`Could not load the default maps manifest (${manifestResponse.status})`)
	const manifest = await manifestResponse.json()
	const maps = Array.isArray(manifest?.maps) ? manifest.maps.filter(map => typeof map?.file === "string") : []
	if (!maps.length) throw new Error("The default maps manifest lists no maps")
	return Promise.all(maps.map(async (map, index) => {
		const response = await fetcher(`${DEFAULT_MAPS_DIR}/${map.file}`)
		if (!response.ok) throw new Error(`Could not load default map ${map.file} (${response.status})`)
		const prims = await response.json()
		if (!Array.isArray(prims?.primitives)) throw new Error(`Default map ${map.file} has no primitives`)
		const prompt = map.file.replace(/\.json$/, '').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())
		return { name: `Example ${index + 1}`, prompt, prims }
	}))
}
