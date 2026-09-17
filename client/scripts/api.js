// Fetch runtime/debug flags from the server (env-driven). Returns {} on failure so
// generation still proceeds with defaults.
export async function getConfig() {
	try {
		const apiBaseURL = ["localhost", "127.0.0.1"].includes(location.hostname) && location.port === "8080" ? "https://worldsplat.app" : ""
		const response = await fetch(`${apiBaseURL}/api/config`)
		if (!response.ok) return {}
		const config = await response.json()
		if (apiBaseURL && config.backend) config.backend.apiBaseURL = apiBaseURL
		return config
	} catch {
		return {}
	}
}
