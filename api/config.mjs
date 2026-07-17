const DEFAULT_OAUTH_CLIENT_ID = "91581ad0-d16c-4f49-9746-cff21b50ac9e"

function env(name, fallback) {
	const value = process.env[name]?.trim()
	return value || fallback
}

function envFloat(name, fallback) {
	const value = Number(env(name, String(fallback)))
	return Number.isFinite(value) ? value : fallback
}

function envInt(name, fallback, min, max) {
	const value = Number(env(name, String(fallback)))
	if (!Number.isInteger(value)) return fallback
	return Math.min(max, Math.max(min, value))
}

export function runtimeConfig() {
	return {
		scene: {
			yOffset: envFloat("WS_SCENE_Y_OFFSET", 0),
			opacityFloor: envFloat("WS_SCENE_OPACITY_FLOOR", 0.03),
			yaw: envFloat("WS_SCENE_YAW", 0),
			fitBboxPercentile: envFloat("WS_SCENE_FIT_BBOX_PERCENTILE", 0),
		},
		generation: {
			provider: "huggingface",
			oauthClientId: env("WS_HF_OAUTH_CLIENT_ID", DEFAULT_OAUTH_CLIENT_ID),
			redirectUrl: env("WS_HF_REDIRECT_URL", ""),
			imageSpace: env("WS_HF_IMAGE_SPACE", "black-forest-labs/FLUX.1-Kontext-Dev"),
			tripoSpace: env("WS_HF_TRIPO_SPACE", "VAST-AI/TripoSplat"),
			// fal-ai runs the real pipelines with our steps/guidance; wavespeed's
			// endpoints are fixed presets that ignore both. FLUX.2-dev (32B)
			// replaced Qwen-Edit (20B) as the default: Qwen only shaded the
			// block-out instead of interpreting its geometry into real structures.
			inferenceProvider: env("WS_HF_INFERENCE_PROVIDER", "fal-ai"),
			inferenceModel: env("WS_HF_INFERENCE_MODEL", "black-forest-labs/FLUX.2-dev"),
			// Image detail ALWAYS runs on inference credits by default — ZeroGPU
			// queues kept starving the image step while credits deliver reliably.
			// Set WS_HF_IMAGE_CREDITS=0 to fall back to the imageSpace route.
			imageCredits: env("WS_HF_IMAGE_CREDITS", "1") !== "0",
			image: {
				steps: envInt("WS_HF_IMAGE_STEPS", 28, 1, 100), // FLUX.2-dev's comfortable range (Qwen ran 20)
				guidance: envFloat("WS_HF_IMAGE_GUIDANCE", 4),
				width: envInt("WS_HF_IMAGE_WIDTH", 1024, 256, 2048),
				height: envInt("WS_HF_IMAGE_HEIGHT", 1024, 256, 2048),
			},
			tripo: {
				steps: envInt("WS_HF_TRIPO_STEPS", 30, 1, 64),
				guidance: envFloat("WS_HF_TRIPO_GUIDANCE", 3),
				// 262144 is TripoSplat's hard maximum — its pipeline asserts
				// num_gaussians ∈ [32768, 262144] (triposplat.py _validate_num_gaussians).
				gaussians: envInt("WS_HF_TRIPO_GAUSSIANS", 131072, 32768, 262144),
				format: "splat",
				// BiRefNet background cutout before reconstruction. Set to 0 to
				// suppress it via the transparent-border trick (the old behavior,
				// for when the cutout starts carving away real terrain again).
				preprocess: env("WS_HF_TRIPO_PREPROCESS", "1") !== "0",
			},
		},
	}
}

export default {
	fetch(request) {
		if (request.method !== "GET") {
			return new Response("method not allowed\n", {
				status: 405,
				headers: { Allow: "GET" },
			})
		}
		return Response.json(runtimeConfig(), {
			headers: { "Cache-Control": "no-cache" },
		})
	},
}
