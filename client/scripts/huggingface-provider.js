// fal provider ids on the HF router (from each model's
// inferenceProviderMapping). The multi-image path below needs them because it
// bypasses @huggingface/inference entirely; both endpoints accept image_urls.
const FAL_EDIT_PROVIDER_IDS = {
	"Qwen/Qwen-Image-Edit-2509": "fal-ai/qwen-image-edit-2509",
	"black-forest-labs/FLUX.2-dev": "fal-ai/flux-2/edit",
}

// Multi-image edit on fal-ai through the Hugging Face router. The official
// @huggingface/inference client can never carry more than one image: its fal
// payload builder spreads our parameters FIRST and then overwrites image_urls
// with the single `inputs` blob. This speaks the same queue protocol directly
// (submit → poll status → fetch result), so a geometry map and/or a style
// reference can ride alongside the block-out. Billing is identical — the HF
// router meters it as inference credits either way.
export async function falQueueImageEdit({ images, prompt, seed, settings, model, accessToken, signal, onProgress }) {
	const providerId = FAL_EDIT_PROVIDER_IDS[model]
	if (!providerId) throw new Error(`No fal multi-image mapping for ${model} — add it to FAL_EDIT_PROVIDER_IDS`)
	const image_urls = await Promise.all(images.map(toDataUrl))
	const base = "https://router.huggingface.co/fal-ai"
	const auth = { Authorization: `Bearer ${accessToken}` }
	const submit = await fetch(`${base}/${providerId}?_subdomain=queue`, {
		method: "POST",
		headers: { ...auth, "Content-Type": "application/json" },
		body: JSON.stringify({
			prompt,
			image_urls,
			seed,
			num_inference_steps: Number(settings.steps),
			guidance_scale: Number(settings.guidance),
			image_size: { width: Number(settings.width), height: Number(settings.height) },
			num_images: 1,
			output_format: "png",
			acceleration: "none", // match the plain pipeline, same as the single-image route
		}),
		signal,
	})
	if (!submit.ok) throw new Error(`fal queue submit failed (${submit.status}): ${(await submit.text()).slice(0, 300)}`)
	const ticket = await submit.json()
	if (!ticket?.request_id || !ticket?.response_url) throw new Error("fal queue submit returned no request ticket")
	const path = new URL(ticket.response_url).pathname

	const deadline = Date.now() + 180_000 // a queued edit takes seconds; minutes = dead job
	for (;;) {
		await sleep(1200, signal)
		if (Date.now() > deadline) throw new Error("fal queue job timed out after 3 minutes")
		const status = await (await fetch(`${base}${path}/status?_subdomain=queue`, { headers: auth, signal })).json()
		if (status?.status === "COMPLETED") break
		if (status?.status === "FAILED" || status?.error) throw new Error(`fal queue job failed: ${JSON.stringify(status?.error ?? status).slice(0, 300)}`)
		onProgress?.(status?.status === "IN_PROGRESS" ? "generating" : "queued")
	}
	const result = await (await fetch(`${base}${path}?_subdomain=queue`, { headers: auth, signal })).json()
	const url = result?.images?.[0]?.url
	if (!url) throw new Error("fal returned no image")
	return (await fetch(url, { signal })).blob()
}

function toDataUrl(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(reader.result)
		reader.onerror = () => reject(reader.error ?? new Error("could not read image"))
		reader.readAsDataURL(blob)
	})
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new DOMException("Generation cancelled", "AbortError"))
		const timer = setTimeout(() => resolve(), ms)
		signal?.addEventListener("abort", () => {
			clearTimeout(timer)
			reject(new DOMException("Generation cancelled", "AbortError"))
		}, { once: true })
	})
}

export function inferenceCreditImageRequest({ image, prompt, seed, settings, provider, model }) {
	return {
		provider,
		model,
		inputs: image,
		parameters: {
			prompt,
			seed,
			num_inference_steps: Number(settings.steps),
			// True-CFG for Qwen-Image-Edit — the same knob the ZeroGPU Space's
			// true_guidance_scale sets, so both routes edit with equal strength.
			guidance_scale: Number(settings.guidance),
			image_size: {
				width: Number(settings.width),
				height: Number(settings.height),
			},
			num_images: 1,
			output_format: "png",
			// fal-only (other providers ignore unknown fields): disable fal's inference
			// speedups so the paid route matches the Space's plain pipeline as closely
			// as possible — its output should predict ZeroGPU output.
			...(provider === "fal-ai" ? { acceleration: "none" } : {}),
		},
	}
}
