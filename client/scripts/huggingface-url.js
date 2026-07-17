const SPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

// Convert an owner/space ID into the one exact origin allowed to receive that
// Space's bearer token. Full hf.space URLs are supported for configuration, but
// arbitrary hosts, insecure HTTP, ports, and embedded credentials are rejected.
export function huggingFaceSpaceOrigin(space) {
	const value = String(space ?? "").trim()
	if (SPACE_ID.test(value)) {
		const subdomain = value.toLowerCase().replaceAll("/", "-").replaceAll(/[^a-z0-9-]/g, "-")
		return `https://${subdomain}.hf.space`
	}
	try {
		const url = new URL(value)
		if (url.protocol !== "https:" || url.port || url.username || url.password || !url.hostname.endsWith(".hf.space")) throw new Error()
		return url.origin
	} catch {
		throw new Error("The configured Hugging Face Space address is not allowed")
	}
}

// A Gradio Space controls the FileData it returns. Resolve that file only after
// proving its URL has the exact expected Space origin; otherwise the caller must
// not attach the user's bearer token.
export function resolveAuthenticatedSpaceFileURL(file, space) {
	const expectedOrigin = huggingFaceSpaceOrigin(space)
	let value = file?.url
	if (!value && file?.path) value = `${expectedOrigin}/gradio_api/file=${encodeURIComponent(String(file.path))}`
	if (!value) throw new Error("The Hugging Face Space returned no downloadable file")

	let url
	try {
		url = new URL(String(value), `${expectedOrigin}/`)
	} catch {
		throw new Error("The Hugging Face Space returned an invalid download URL")
	}
	if (url.origin !== expectedOrigin || url.username || url.password) {
		throw new Error("Blocked an unsafe download URL returned by the Hugging Face Space")
	}
	return url.href
}
