// Per-Space image-edit request builders. Spaces expose different /infer
// parameters, so the payload is chosen by Space name.

// FLUX.2 Spaces. The klein Space adds a mode_choice picker (distilled vs base)
// that the full FLUX.2-dev Space does not have.
export function fluxEditPayload({ file, geometryFile = null, styleFile = null, prompt, seed, settings, space = "" }) {
	const inputImages = [{ image: file, caption: null }]
	if (geometryFile) inputImages.push({ image: geometryFile, caption: null })
	if (styleFile) inputImages.push({ image: styleFile, caption: null })
	const payload = {
		prompt,
		input_images: inputImages,
		seed,
		randomize_seed: false,
		width: Number(settings.width),
		height: Number(settings.height),
		num_inference_steps: Number(settings.steps),
		guidance_scale: Number(settings.guidance),
		prompt_upsampling: false,
	}
	if (/klein/i.test(space)) payload.mode_choice = "Distilled (4 steps)"
	return payload
}

// Qwen-Image-Edit-2509 Space. rewrite_prompt stays off so the exact WorldSketch
// prompt reaches the model instead of a machine-expanded paraphrase.
export function qwenEditPayload({ file, geometryFile = null, styleFile = null, prompt, seed, settings }) {
	const images = [{ image: file, caption: null }]
	if (geometryFile) images.push({ image: geometryFile, caption: null })
	if (styleFile) images.push({ image: styleFile, caption: null })
	return {
		prompt,
		images,
		seed,
		randomize_seed: false,
		width: Number(settings.width),
		height: Number(settings.height),
		num_inference_steps: Number(settings.steps),
		true_guidance_scale: Number(settings.guidance),
		rewrite_prompt: false,
	}
}

// akhaliq/Qwen-Image-Edit-2509: two-image Qwen-Edit-Plus with the 8-step
// Lightning LoRA fused and a 60s ZeroGPU reservation — chosen after the
// official Space raised its reservation to 600s, which is above every normal
// account's per-run ceiling. Its /edit_images endpoint REQUIRES both image
// slots, so without a geometry map the block-out render fills slot 2 as well.
// Lightning has its own tuned sampler numbers (8 steps, cfg 1) — the
// WS_HF_IMAGE_STEPS / WS_HF_IMAGE_GUIDANCE knobs do not apply on this Space.
export function akhaliqEditPayload({ file, geometryFile = null, styleFile = null, prompt, seed }) {
	return {
		image1: file,
		// exactly two slots: geometry map wins slot 2, else the style reference,
		// else the block-out doubles up (the Space requires both slots filled)
		image2: geometryFile ?? styleFile ?? file,
		prompt,
		seed,
		true_cfg_scale: 1,
		negative_prompt: " ",
		num_steps: 8,
		guidance_scale: 1,
	}
}

// black-forest-labs/FLUX.1-Kontext-Dev: 12B editing model on the most popular
// ZeroGPU Space on HF (warm workers ≈ no cold-load window to blow) — chosen
// after every 20B Qwen route kept dying in the GPU queue. Single input image
// only, so the geometry map is dropped on this Space (spaceSupportsGeometry
// below keeps the prompt from referencing it). The Space's own tuned sampler
// (28 steps, guidance 2.5) — WS_HF_IMAGE_STEPS/GUIDANCE do not apply.
export function kontextEditPayload({ file, prompt, seed }) {
	return {
		input_image: file,
		prompt,
		seed,
		randomize_seed: false,
		guidance_scale: 2.5,
		steps: 28,
	}
}

// Single-image Spaces can't take the aligned geometry map; the scene prompt
// must not mention a reference image that never arrives.
export function spaceSupportsGeometry(space) {
	return !/kontext/i.test(space || "")
}

// Space name → { endpoint, payload }: Spaces differ in both the endpoint name
// and the /infer parameters, so both are chosen together. Kontext is matched
// before the generic /flux/ fallback (its Space name contains "FLUX" too).
export function imageEditRequest(request) {
	const space = request.space || ""
	if (/kontext/i.test(space)) return { endpoint: "/infer", payload: kontextEditPayload(request) }
	if (/akhaliq\/qwen-image-edit-2509/i.test(space)) return { endpoint: "/edit_images", payload: akhaliqEditPayload(request) }
	if (/qwen/i.test(space)) return { endpoint: "/infer", payload: qwenEditPayload(request) }
	return { endpoint: "/infer", payload: fluxEditPayload(request) }
}
