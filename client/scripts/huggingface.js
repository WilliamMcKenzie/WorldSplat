import { Client, handle_file } from "@gradio/client"
import { InferenceClient } from "@huggingface/inference"
import {
	configureHuggingFaceAuth,
	getHuggingFaceAccessToken,
	getHuggingFaceAuth,
	signOutHuggingFaceAuth,
} from "/scripts/huggingface-auth.js"
import { sceneGenerationPrompt } from "/scripts/generation-prompt.js?v=no-floor-1"
import { friendlyHuggingFaceError } from "/scripts/huggingface-errors.js?v=hf-credits-1"
import { imageEditRequest, spaceSupportsGeometry } from "/scripts/huggingface-image.js?v=style-ref-1"
import { falQueueImageEdit, inferenceCreditImageRequest } from "/scripts/huggingface-provider.js?v=flux2-credits-1"
import { resolveAuthenticatedSpaceFileURL } from "/scripts/huggingface-url.js?v=space-only-1"

const DEFAULT_CONFIG = {
	oauthClientId: "91581ad0-d16c-4f49-9746-cff21b50ac9e",
	redirectUrl: "",
	imageSpace: "black-forest-labs/FLUX.1-Kontext-Dev",
	tripoSpace: "VAST-AI/TripoSplat",
	inferenceProvider: "fal-ai",
	inferenceModel: "black-forest-labs/FLUX.2-dev", // 32B: interprets block geometry where Qwen-Edit only shaded it
	imageCredits: true, // image detail always runs on inference credits (WS_HF_IMAGE_CREDITS=0 reverts)
	image: { steps: 28, guidance: 4, width: 1024, height: 1024 },
	tripo: { steps: 30, guidance: 3, gaussians: 131072, format: "splat", preprocess: true },
}

let config = structuredClone(DEFAULT_CONFIG)
let activeJob = null

function mergeConfig(next = {}) {
	return {
		...DEFAULT_CONFIG,
		...next,
		image: { ...DEFAULT_CONFIG.image, ...(next.image ?? {}) },
		tripo: { ...DEFAULT_CONFIG.tripo, ...(next.tripo ?? {}) },
	}
}

export function configureHuggingFace(next) {
	config = mergeConfig(next)
	configureHuggingFaceAuth(config)
}

export function signOutHuggingFace() {
	activeJob?.cancel?.()
	activeJob = null
	signOutHuggingFaceAuth()
}

export { getHuggingFaceAuth }

export function cancelHuggingFaceGeneration() {
	activeJob?.cancel?.()
}

// Whether the image-detail step runs on inference credits. True by default —
// the ZeroGPU image routes kept dying in the GPU queue while credits deliver
// reliably (~1-2¢/image); WS_HF_IMAGE_CREDITS=0 reverts to the image Space.
// The splat step is unaffected: TripoSplat stays on ZeroGPU.
export function imageStepUsesCredits() {
	return config.imageCredits !== false && String(config.imageCredits) !== "0"
}

function fileReference(value) {
	if (!value) return null
	if (typeof value === "string" && (value.startsWith("http://") || value.startsWith("https://"))) return { url: value }
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = fileReference(item)
			if (found) return found
		}
		return null
	}
	if (typeof value === "object") {
		if (value.url || value.path) return value
		for (const child of Object.values(value)) {
			const found = fileReference(child)
			if (found) return found
		}
	}
	return null
}

async function downloadFile(file, space, signal, { onProgress, stallMs = 45_000 } = {}) {
	const url = resolveAuthenticatedSpaceFileURL(file, space)
	const controller = new AbortController()
	let stalled = false
	let stallTimer = 0
	const abort = () => controller.abort(signal?.reason)
	const armStallTimer = () => {
		window.clearTimeout(stallTimer)
		stallTimer = window.setTimeout(() => {
			stalled = true
			controller.abort()
		}, stallMs)
	}
	signal?.addEventListener("abort", abort, { once: true })
	try {
		armStallTimer()
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${getHuggingFaceAccessToken()}` },
			signal: controller.signal,
		})
		if (!response.ok) throw new Error(`Could not download the generated file (${response.status})`)
		const reader = response.body?.getReader?.()
		if (!reader) return response.blob()
		const total = Math.max(0, Number(response.headers.get("content-length")) || 0)
		const chunks = []
		let loaded = 0
		while (true) {
			armStallTimer()
			const { done, value } = await reader.read()
			if (done) break
			if (!value?.byteLength) continue
			chunks.push(value)
			loaded += value.byteLength
			onProgress?.({ loaded, total })
		}
		return new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" })
	} catch (error) {
		if (stalled) throw new Error(`The generated file download stalled for ${Math.round(stallMs / 1000)} seconds. Please try again.`)
		throw error
	} finally {
		window.clearTimeout(stallTimer)
		signal?.removeEventListener("abort", abort)
	}
}

function downloadLabel(loaded, total) {
	const mb = bytes => `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	return total > 0
		? `Downloading the 3D scene — ${mb(loaded)} of ${mb(total)}`
		: `Downloading the 3D scene — ${mb(loaded)}`
}

function statusLabel(stage, message) {
	const status = message?.status ?? message
	const position = status?.position
	if (status?.stage === "pending" || status?.stage === "queued") {
		return Number.isFinite(position) ? `${stage} — ${position + 1} job${position ? "s" : ""} ahead` : `${stage} — waiting for a GPU`
	}
	if (status?.stage === "generating" || status?.stage === "running") return `${stage} — running`
	return stage
}

async function runSpace(space, endpoint, payload, stage, progress, signal) {
	if (signal?.aborted) throw new DOMException("Generation cancelled", "AbortError")
	const app = await Client.connect(space, { token: getHuggingFaceAccessToken(), events: ["data", "status"] })
	const job = await app.submit(endpoint, payload)
	activeJob = job
	const abort = () => job.cancel?.()
	signal?.addEventListener("abort", abort, { once: true })
	let data = null
	try {
		// The Space's event stream can die silently (ZeroGPU proxy drops the
		// connection while the job queues); without a watchdog the iterator
		// waits forever — the "waiting for a GPU" permastuck. Gradio sends
		// queue/progress updates far more often than this, so a long silence
		// means the stream is dead, not that the queue is slow.
		const stallMs = 180_000
		const iterator = job[Symbol.asyncIterator]()
		for (;;) {
			let stallTimer = 0
			let next
			try {
				next = await Promise.race([
					iterator.next(),
					new Promise((_, reject) => {
						stallTimer = window.setTimeout(() => reject(new Error(
							`${stage} stopped responding — no update from Hugging Face for ${Math.round(stallMs / 60_000)} minutes. Cancel and try again.`,
						)), stallMs)
					}),
				])
			} finally {
				window.clearTimeout(stallTimer)
			}
			if (next.done) break
			const message = next.value
			if (message?.type === "status") {
				if (message.stage === "error") {
					const detail = typeof message.message === "string" ? message.message : JSON.stringify(message.message || message.code || "Space job failed")
					throw new Error(detail)
				}
				progress?.(statusLabel(stage, message))
			}
			if (message?.type === "data") data = message.data
		}
	} catch (error) {
		job.cancel?.() // free the queue slot on stall/error; harmless if already done
		throw error
	} finally {
		signal?.removeEventListener("abort", abort)
		if (activeJob === job) activeJob = null
	}
	if (signal?.aborted) throw new DOMException("Generation cancelled", "AbortError")
	if (!data) throw new Error(`${stage} finished without returning a result`)
	return data
}

// TripoSplat's Space runs its own background-removal model (BiRefNet) on any
// upload without transparency, and that pass can carve away real terrain. It
// skips removal entirely when the image already carries a real alpha channel
// (any pixel below 255), so a transparent 1px border keeps the full frame
// intact and leaves the black background to the image model.
async function withTransparentBorder(blob) {
	const bitmap = await createImageBitmap(blob)
	const canvas = document.createElement("canvas")
	canvas.width = bitmap.width
	canvas.height = bitmap.height
	const context = canvas.getContext("2d")
	context.drawImage(bitmap, 0, 0)
	bitmap.close()
	context.clearRect(0, 0, canvas.width, 1)
	context.clearRect(0, canvas.height - 1, canvas.width, 1)
	context.clearRect(0, 0, 1, canvas.height)
	context.clearRect(canvas.width - 1, 0, 1, canvas.height)
	const png = await new Promise((resolve, reject) => {
		canvas.toBlob(result => result ? resolve(result) : reject(new Error("Could not encode the image for TripoSplat")), "image/png")
	})
	return new File([png], "scene.png", { type: "image/png" })
}

function randomSeed() {
	return crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff
}

// Image-detail stage only: block-out render (+ optional aligned geometry map,
// + optional style reference whose art style the output should copy) →
// detailed image blob. `prompt` is the FULL prompt text, not the scene
// description. A fixed `seed` makes runs reproducible for A/B comparisons.
export async function detailImageOnHuggingFace({ prompt, image, geometryImage = null, styleImage = null, seed = randomSeed(), signal, onProgress }) {
	if (!getHuggingFaceAuth().signedIn) throw new Error("Sign in with Hugging Face before generating")
	// Credits-by-default: every image caller (app generation AND the A/B lab)
	// rides the reliable paid route unless WS_HF_IMAGE_CREDITS=0 opts out.
	const useInferenceCredits = imageStepUsesCredits()
	try {
		if (useInferenceCredits) {
			onProgress?.(0, "Using inference credits for image detail")
			// Extra images (geometry map, style reference) can't ride through the
			// official client — it only carries one image — so multi-image edits
			// go straight to fal's queue on the HF router (fal-ai only).
			const extras = [geometryImage, styleImage].filter(Boolean)
			let editedImage
			try {
				if (extras.length && config.inferenceProvider === "fal-ai") {
					editedImage = await falQueueImageEdit({
						images: [image, ...extras],
						prompt,
						seed,
						settings: config.image,
						model: config.inferenceModel,
						accessToken: getHuggingFaceAccessToken(),
						signal,
						onProgress: stage => onProgress?.(0.5, stage === "generating"
							? "Image detail — generating (inference credits)"
							: "Image detail — queued (inference credits)"),
					})
				} else {
					const inference = new InferenceClient(getHuggingFaceAccessToken())
					editedImage = await inference.imageToImage(inferenceCreditImageRequest({
						image,
						prompt,
						seed,
						settings: config.image,
						provider: config.inferenceProvider,
						model: config.inferenceModel,
					}), { signal, retry_on_error: false })
				}
			} catch (error) {
				throw friendlyHuggingFaceError(error, { useInferenceCredits: true })
			}
			if (signal?.aborted) throw new DOMException("Generation cancelled", "AbortError")
			onProgress?.(1, "Image detail complete — inference credits used")
			return editedImage
		}
		onProgress?.(0, "Uploading the block-out")
		const { endpoint, payload } = imageEditRequest({
			file: handle_file(image),
			geometryFile: geometryImage ? handle_file(geometryImage) : null,
			styleFile: styleImage ? handle_file(styleImage) : null,
			prompt,
			seed,
			settings: config.image,
			space: config.imageSpace,
		})
		const imageData = await runSpace(config.imageSpace, endpoint, payload, "Adding detail to the block-out", label => onProgress?.(0.5, label), signal)
		const editedFile = fileReference(imageData?.[0] ?? imageData)
		if (!editedFile) throw new Error("The image editor returned no image")
		onProgress?.(0.9, "Downloading the detailed image")
		return await downloadFile(editedFile, config.imageSpace, signal)
	} catch (error) {
		throw friendlyHuggingFaceError(error)
	}
}

// 3D stage only: detailed image → splat bytes. A fixed `seed` makes runs
// reproducible for A/B comparisons. Splats always run on the public ZeroGPU
// Space through the signed-in user's allowance.
export async function buildSplatOnHuggingFace({ image, seed = randomSeed(), signal, onProgress }) {
	if (!getHuggingFaceAuth().signedIn) throw new Error("Sign in with Hugging Face before generating")
	try {
		onProgress?.(0, "Sending the image to TripoSplat")
		// Preprocess = TripoSplat's BiRefNet background cutout. Enabled (default):
		// the image goes in untouched so the cutout runs. Disabled
		// (WS_HF_TRIPO_PREPROCESS=0): the 1px transparent border suppresses the
		// ZeroGPU Space's cutout (it skips any upload that already has alpha) —
		// the old behavior, kept because the cutout can carve away real terrain.
		const preprocess = config.tripo.preprocess !== false && String(config.tripo.preprocess) !== "0"
		const payload = {
			image: handle_file(preprocess ? image : await withTransparentBorder(image)),
			seed,
			steps: Number(config.tripo.steps),
			guidance_scale: Number(config.tripo.guidance),
			num_gaussians: Number(config.tripo.gaussians),
			output_format: config.tripo.format || "splat",
		}
		const tripoData = await runSpace(config.tripoSpace, "/generate", payload, "TripoSplat is building the 3D scene", label => onProgress?.(0.43, label), signal)
		const splatFile = fileReference(tripoData?.[2]) ?? fileReference(tripoData)
		if (!splatFile) throw new Error("TripoSplat returned no 3D file")
		onProgress?.(0.92, "Downloading the 3D scene")
		const splat = await downloadFile(splatFile, config.tripoSpace, signal, {
			onProgress: ({ loaded, total }) => {
				const ratio = total > 0 ? loaded / total : Math.min(0.95, loaded / (8 * 1024 * 1024))
				onProgress?.(0.92 + Math.min(1, ratio) * 0.07, downloadLabel(loaded, total))
			},
		})
		onProgress?.(0.99, "Reading the downloaded 3D scene")
		return new Uint8Array(await splat.arrayBuffer())
	} catch (error) {
		throw friendlyHuggingFaceError(error)
	}
}

// Pinned generation seed for the app flow: 303 consistently gives the best
// results (user verdict, 2026-07-16 A/B rounds). The A/B lab still passes its
// own explicit seeds.
const SCENE_SEED = 303

// The bundled style guide rides along with every app generation as the
// art-style reference (the prompt points the model at it). Fetched once and
// cached; a missing or failed asset must never block generation.
const STYLE_GUIDE = "/assets/styleguide.png"
let styleGuidePromise = null
function loadStyleGuide() {
	styleGuidePromise ??= fetch(STYLE_GUIDE)
		.then(response => (response.ok ? response.blob() : null))
		.catch(() => null)
	return styleGuidePromise
}

export async function generateSceneOnHuggingFace({ prompt, image, geometryImage = null, hasGround = true, signal, onProgress, onImageReady }) {
	// Multi-image Spaces take the aligned geometry map alongside the block-out;
	// single-image routes (Kontext, the plain inference API) can't, so the
	// prompt only mentions the geometry map on paths that actually send it.
	const viaCredits = imageStepUsesCredits()
	const useGeometryReference = !viaCredits && Boolean(geometryImage) && spaceSupportsGeometry(config.imageSpace)
	// The style guide can ride any multi-image path: the fal queue on credits,
	// or an extra gallery image on multi-image Spaces. Same rule as geometry —
	// never mention a reference the route can't deliver.
	const styleImage = await loadStyleGuide()
	const useStyleReference = Boolean(styleImage)
		&& (viaCredits ? config.inferenceProvider === "fal-ai" : spaceSupportsGeometry(config.imageSpace))
	const editedImage = await detailImageOnHuggingFace({
		prompt: sceneGenerationPrompt(prompt, { hasGeometryReference: useGeometryReference, hasStyleReference: useStyleReference, hasGround }),
		image,
		geometryImage: useGeometryReference ? geometryImage : null,
		styleImage: useStyleReference ? styleImage : null,
		seed: SCENE_SEED,
		signal,
		onProgress: (fraction, label) => onProgress?.(0.12 + fraction * 0.43, label),
	})
	onImageReady?.(editedImage)
	const bytes = await buildSplatOnHuggingFace({
		image: editedImage,
		seed: SCENE_SEED,
		signal,
		onProgress: (fraction, label) => onProgress?.(0.6 + fraction * 0.37, label),
	})
	return { bytes, editedImage }
}
