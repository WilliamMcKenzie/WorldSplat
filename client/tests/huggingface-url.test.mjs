import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

// Load the browser ESM source without changing the project's package type.
const source = await readFile(new URL("../scripts/huggingface-url.js", import.meta.url), "utf8")
const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
const { huggingFaceSpaceOrigin, resolveAuthenticatedSpaceFileURL } = await import(moduleURL)

test("maps a Space ID to its exact hf.space origin", () => {
	assert.equal(huggingFaceSpaceOrigin("Qwen/Qwen-Image_Edit"), "https://qwen-qwen-image-edit.hf.space")
	assert.equal(
		huggingFaceSpaceOrigin("black-forest-labs/FLUX.2-klein-4B"),
		"https://black-forest-labs-flux-2-klein-4b.hf.space",
	)
})

test("accepts a file from the configured Space only", () => {
	const url = "https://qwen-qwen-image-edit-2511.hf.space/gradio_api/file=/tmp/output.png"
	assert.equal(resolveAuthenticatedSpaceFileURL({ url }, "Qwen/Qwen-Image-Edit-2511"), url)
})

test("constructs a safe Space URL from a Gradio file path", () => {
	assert.equal(
		resolveAuthenticatedSpaceFileURL({ path: "/tmp/output image.png" }, "Qwen/Qwen-Image-Edit-2511"),
		"https://qwen-qwen-image-edit-2511.hf.space/gradio_api/file=%2Ftmp%2Foutput%20image.png",
	)
})

for (const unsafe of [
	"https://attacker.example/collect",
	"//attacker.example/collect",
	"https://qwen-qwen-image-edit-2511.hf.space.attacker.example/collect",
	"https://attacker.example@qwen-qwen-image-edit-2511.hf.space/collect",
	"http://qwen-qwen-image-edit-2511.hf.space/collect",
]) {
	test(`rejects an unsafe token destination: ${unsafe}`, () => {
		assert.throws(
			() => resolveAuthenticatedSpaceFileURL({ url: unsafe }, "Qwen/Qwen-Image-Edit-2511"),
			/unsafe download URL/,
		)
	})
}
