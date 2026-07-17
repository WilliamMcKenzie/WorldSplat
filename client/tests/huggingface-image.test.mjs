import assert from "node:assert/strict"
import test from "node:test"

import { fluxEditPayload, imageEditRequest, qwenEditPayload, spaceSupportsGeometry } from "../scripts/huggingface-image.js"

test("builds the live FLUX.2-dev image-edit request (no mode_choice)", () => {
	const file = { blob: "guide" }
	assert.deepEqual(fluxEditPayload({
		file,
		prompt: "Preserve the block-out",
		seed: 42,
		settings: { width: "512", height: "512", steps: "30", guidance: "4" },
		space: "black-forest-labs/FLUX.2-dev",
	}), {
		prompt: "Preserve the block-out",
		input_images: [{ image: file, caption: null }],
		seed: 42,
		randomize_seed: false,
		width: 512,
		height: 512,
		num_inference_steps: 30,
		guidance_scale: 4,
		prompt_upsampling: false,
	})
})

test("adds mode_choice only for the klein Space", () => {
	const file = { blob: "guide" }
	const payload = fluxEditPayload({
		file,
		prompt: "Preserve the block-out",
		seed: 42,
		settings: { width: 1024, height: 1024, steps: 4, guidance: 1 },
		space: "black-forest-labs/FLUX.2-klein-4B",
	})
	assert.equal(payload.mode_choice, "Distilled (4 steps)")
})

test("builds the live Qwen-Image-Edit-2509 request with prompt rewriting off", () => {
	const file = { blob: "guide" }
	const geometryFile = { blob: "geometry" }
	assert.deepEqual(qwenEditPayload({
		file,
		geometryFile,
		prompt: "Preserve the block-out",
		seed: 42,
		settings: { width: "1024", height: "1024", steps: "40", guidance: "4" },
	}), {
		prompt: "Preserve the block-out",
		images: [
			{ image: file, caption: null },
			{ image: geometryFile, caption: null },
		],
		seed: 42,
		randomize_seed: false,
		width: 1024,
		height: 1024,
		num_inference_steps: 40,
		true_guidance_scale: 4,
		rewrite_prompt: false,
	})
})

test("dispatches endpoint and payload builder by Space name", () => {
	const file = { blob: "guide" }
	const base = { file, prompt: "p", seed: 1, settings: { width: 512, height: 512, steps: 8, guidance: 2 } }
	const qwen = imageEditRequest({ ...base, space: "Qwen/Qwen-Image-Edit-2509" })
	assert.equal(qwen.endpoint, "/infer")
	assert.ok("true_guidance_scale" in qwen.payload)
	const flux = imageEditRequest({ ...base, space: "black-forest-labs/FLUX.2-dev" })
	assert.equal(flux.endpoint, "/infer")
	assert.ok("guidance_scale" in flux.payload)
	// akhaliq's Qwen duplicate must win over the generic /qwen/ match: it uses a
	// different endpoint and a two-image payload (the block-out doubles as slot 2).
	const akhaliq = imageEditRequest({ ...base, space: "akhaliq/Qwen-Image-Edit-2509" })
	assert.equal(akhaliq.endpoint, "/edit_images")
	assert.equal(akhaliq.payload.image2, file)
	// Kontext must win over the generic /flux/ fallback (its name contains FLUX):
	// single input image, the Space's own tuned sampler, no width/height knobs.
	const kontext = imageEditRequest({ ...base, space: "black-forest-labs/FLUX.1-Kontext-Dev" })
	assert.equal(kontext.endpoint, "/infer")
	assert.deepEqual(kontext.payload, {
		input_image: file,
		prompt: "p",
		seed: 1,
		randomize_seed: false,
		guidance_scale: 2.5,
		steps: 28,
	})
})

test("only multi-image Spaces advertise geometry-map support", () => {
	assert.equal(spaceSupportsGeometry("black-forest-labs/FLUX.1-Kontext-Dev"), false)
	assert.equal(spaceSupportsGeometry("akhaliq/Qwen-Image-Edit-2509"), true)
	assert.equal(spaceSupportsGeometry("Qwen/Qwen-Image-Edit-2509"), true)
	assert.equal(spaceSupportsGeometry("black-forest-labs/FLUX.2-dev"), true)
})

test("appends the style reference after the geometry map on multi-image Spaces", () => {
	const file = { blob: "guide" }
	const geometryFile = { blob: "geometry" }
	const styleFile = { blob: "style" }
	const payload = qwenEditPayload({
		file,
		geometryFile,
		styleFile,
		prompt: "Match the art style of the last input image",
		seed: 7,
		settings: { width: 1024, height: 1024, steps: 8, guidance: 1 },
	})
	assert.deepEqual(payload.images.map(entry => entry.image), [file, geometryFile, styleFile])
	// akhaliq has exactly two slots: geometry wins, style takes slot 2 only when
	// there is no geometry, and the block-out doubles up when neither exists.
	const base = { file, prompt: "p", seed: 1, settings: { width: 512, height: 512, steps: 8, guidance: 1 }, space: "akhaliq/Qwen-Image-Edit-2509" }
	assert.equal(imageEditRequest({ ...base, geometryFile, styleFile }).payload.image2, geometryFile)
	assert.equal(imageEditRequest({ ...base, styleFile }).payload.image2, styleFile)
	assert.equal(imageEditRequest({ ...base }).payload.image2, file)
})

test("adds the aligned geometry map as a second Flux edit image", () => {
	const file = { blob: "guide" }
	const geometryFile = { blob: "geometry" }
	const payload = fluxEditPayload({
		file,
		geometryFile,
		prompt: "Preserve every mask",
		seed: 42,
		settings: { width: 1024, height: 1024, steps: 30, guidance: 4 },
	})
	assert.deepEqual(payload.input_images, [
		{ image: file, caption: null },
		{ image: geometryFile, caption: null },
	])
})
