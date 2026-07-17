import { getConfig } from "/scripts/api.js"
import { configureHuggingFaceAuth, getHuggingFaceAuth } from "/scripts/huggingface-auth.js"

try {
	const runtimeConfig = await getConfig()
	configureHuggingFaceAuth(runtimeConfig?.generation)
	if (!getHuggingFaceAuth().signedIn) location.replace("/")
	else await import("/scripts/renderer.js?v=dev-chrome-1")
} catch (error) {
	console.error("Editor startup failed:", error)
	location.replace("/")
}
