import assert from "node:assert/strict"
import test from "node:test"

import { inferenceCreditImageRequest } from "../scripts/huggingface-provider.js"

test("builds the paid inference-provider image edit request", () => {
	const image = { blob: "guide" }
	assert.deepEqual(inferenceCreditImageRequest({
		image,
		prompt: "Preserve the block-out",
		seed: 42,
		settings: { width: "512", height: "512", steps: "4", guidance: "1" },
		provider: "fal-ai",
		model: "Qwen/Qwen-Image-Edit-2509",
	}), {
		provider: "fal-ai",
		model: "Qwen/Qwen-Image-Edit-2509",
		inputs: image,
		parameters: {
			prompt: "Preserve the block-out",
			seed: 42,
			num_inference_steps: 4,
			guidance_scale: 1,
			image_size: { width: 512, height: 512 },
			num_images: 1,
			output_format: "png",
			acceleration: "none",
		},
	})
})

test("skips the fal-only acceleration flag for other providers", () => {
	const request = inferenceCreditImageRequest({
		image: {},
		prompt: "p",
		seed: 1,
		settings: { width: "1024", height: "1024", steps: "20", guidance: "4" },
		provider: "wavespeed",
		model: "Qwen/Qwen-Image-Edit-2509",
	})
	assert.equal(request.parameters.acceleration, undefined)
	assert.equal(request.parameters.guidance_scale, 4)
})
