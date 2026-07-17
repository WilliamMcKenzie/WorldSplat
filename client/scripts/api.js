// Fetch runtime/debug flags from the server (env-driven). Returns {} on failure so
// generation still proceeds with defaults.
export async function getConfig() {
	try {
		const response = await fetch("/api/config")
		if (!response.ok) return {}
		return await response.json()
	} catch {
		return {}
	}
}
