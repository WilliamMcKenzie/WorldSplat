import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const source = await readFile(new URL("../scripts/generation-debug-images.js", import.meta.url), "utf8")
const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
const { createGenerationImageDebugger } = await import(moduleURL)

function harness() {
	const revoked = []
	const logged = []
	const opened = []
	let nextURL = 1
	const document = {
		title: "",
		documentElement: { style: {} },
		body: {
			style: {},
			children: [],
			replaceChildren(...children) { this.children = children },
		},
		createElement: tagName => ({ tagName, style: {} }),
	}
	const windowObject = {
		open: () => {
			const tab = { document }
			opened.push(tab)
			return tab
		},
	}
	const urlObject = {
		createObjectURL: () => `blob:https://worldsketch.vercel.app/image-${nextURL++}`,
		revokeObjectURL: url => revoked.push(url),
	}
	const consoleObject = { info: message => logged.push(message) }
	return { windowObject, urlObject, consoleObject, document, opened, revoked, logged }
}

test("publishes a reliable DevTools preview command without a copyable relative URL", () => {
	const env = harness()
	const debuggerImages = createGenerationImageDebugger(env)
	debuggerImages.log("output", "Final FLUX image sent to TripoSplat", new Blob(["png"], { type: "image/png" }))

	assert.deepEqual(env.windowObject.__wsGenerationImages.output, {
		label: "Final FLUX image sent to TripoSplat",
		type: "image/png",
		size: 3,
		preview: '__wsOpenGenerationImage("output")',
	})
	assert.match(env.logged[0], /__wsOpenGenerationImage\("output"\)/)
	assert.doesNotMatch(env.logged[0], /https:\/\/worldsketch/)

	env.windowObject.__wsOpenGenerationImage("output")
	assert.equal(env.opened.length, 1)
	assert.equal(env.document.body.children[0].src, "blob:https://worldsketch.vercel.app/image-1")
	assert.equal(env.document.body.children[0].alt, "Final FLUX image sent to TripoSplat")
})

test("replaces and revokes old previews", () => {
	const env = harness()
	const debuggerImages = createGenerationImageDebugger(env)
	debuggerImages.log("output", "First", new Blob(["one"]))
	debuggerImages.log("output", "Second", new Blob(["two"]))
	debuggerImages.clear()

	assert.deepEqual(env.revoked, [
		"blob:https://worldsketch.vercel.app/image-1",
		"blob:https://worldsketch.vercel.app/image-2",
	])
	assert.deepEqual(env.windowObject.__wsGenerationImages, {})
	assert.throws(() => env.windowObject.__wsOpenGenerationImage("output"), /No WorldSketch generation image/)
})
