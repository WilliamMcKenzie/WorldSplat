export function createGenerationImageDebugger({
	windowObject = window,
	urlObject = URL,
	consoleObject = console,
} = {}) {
	const images = new Map()

	function publish() {
		windowObject.__wsGenerationImages = Object.fromEntries(
			[...images].map(([key, image]) => [key, {
				label: image.label,
				type: image.blob.type,
				size: image.blob.size,
				preview: `__wsOpenGenerationImage(${JSON.stringify(key)})`,
			}]),
		)
	}

	function open(key) {
		const image = images.get(key)
		if (!image) throw new Error(`No WorldSketch generation image named ${JSON.stringify(key)} is available`)

		const preview = windowObject.open("about:blank", "_blank")
		if (!preview) throw new Error("The browser blocked the image preview tab")

		const document = preview.document
		document.title = image.label
		document.documentElement.style.background = "#111318"
		document.body.style.cssText = "margin:0;min-height:100vh;display:grid;place-items:center;background:#111318;color:#fff;font:14px system-ui,sans-serif"
		const element = document.createElement("img")
		element.alt = image.label
		element.src = image.url
		element.style.cssText = "display:block;max-width:100vw;max-height:100vh;object-fit:contain"
		document.body.replaceChildren(element)
		return preview
	}

	function clear() {
		for (const image of images.values()) urlObject.revokeObjectURL(image.url)
		images.clear()
		publish()
	}

	function log(key, label, blob) {
		if (!(blob instanceof Blob)) return
		const previous = images.get(key)
		if (previous) urlObject.revokeObjectURL(previous.url)
		images.set(key, { blob, label, url: urlObject.createObjectURL(blob) })
		publish()
		consoleObject.info(`[WorldSketch image] ${label}. Preview with: __wsOpenGenerationImage(${JSON.stringify(key)})`)
	}

	windowObject.__wsOpenGenerationImage = open
	publish()
	return { clear, log, open }
}
