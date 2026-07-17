// Animated pixel-pattern background for the "cloud of splats" band — WebGL port
// of the canvas-2D sketch this file started as. Same pattern family as bg.js
// (directions of cos(dir·p + offset) summed past a threshold), but keeping the
// sketch's own voice: chunkier-grained 5px cells, tighter zoom, seven evenly
// spread directions, and a slower drift. The 2D sketch walked every cell on the
// CPU each frame; here one fragment shader evaluates all cells on the GPU, and
// the loop only runs while the band is actually on screen.

const PIXEL = 5 // CSS px per pattern cell (the sketch's finer grain — do not DPR-scale)
const ZOOM = 8
const SPEED = 2 // offset units per frame, /128 — the sketch's slower tempo
// The wave-direction count breathes between SEED_MIN and SEED_MAX (a slow sine
// over the drift clock) — the pattern morphs from sparse stripes to dense
// rosettes and back. Fractional counts blend the newest direction in smoothly.
const SEED_MIN = 3
const SEED_MAX = 8
const SEED_RATE = 0.0875 // sine frequency vs the drift offset (~75s per cycle)
const COLOR = "#f0f0f0" // same ink as bg.js so both bands read as one system

const band = document.getElementById("reveal")
const canvas = document.createElement("canvas")
canvas.setAttribute("aria-hidden", "true")
// Back of the band, under the ASCII/splat canvases (z1) and the copy (z2). The
// centre-clear radial mask is inherited from the drifting-code layer this
// replaces — it keeps the middle of the band clean for the splat. A second,
// vertical mask fades the pattern out over the band's top and bottom edges so
// the section needs no dividing rule — the background just breathes away.
const MASKS = "radial-gradient(closest-side at 50% 50%, transparent 26%, #000 76%), linear-gradient(to bottom, transparent, #000 12%, #000 88%, transparent)"
canvas.style.cssText = [
	"position: absolute",
	"inset: 0",
	"width: 100%",
	"height: 100%",
	"z-index: 0",
	"pointer-events: none",
	`-webkit-mask-image: ${MASKS}`,
	"-webkit-mask-composite: source-in",
	`mask-image: ${MASKS}`,
	"mask-composite: intersect",
].join("; ")
const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, stencil: false })

if (band && gl) {
	band.prepend(canvas)

	const FRAG = `
		precision mediump float;
		uniform vec2 uRes;
		uniform float uOffset;
		uniform float uSeed; // live direction count, ${SEED_MIN}..${SEED_MAX} (fractional)
		const float TAU = 6.28318530718;

		void main() {
			// Canvas-2D orientation (y down) and the sketch's centered coordinates.
			vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
			vec2 cell = floor((frag - uRes * 0.5) / ${PIXEL.toFixed(1)}) * ${PIXEL.toFixed(1)};
			vec2 p = cell / ${ZOOM.toFixed(1)};

			float sum = 0.0;
			float angle = TAU;
			for (int i = 0; i < ${SEED_MAX}; i++) {
				// Directions past uSeed weigh 0; the frontier direction fades in
				// with its fraction, so the count morphs instead of popping.
				float w = clamp(uSeed - float(i), 0.0, 1.0);
				sum += w * cos(cos(angle) * p.x + sin(angle) * p.y + uOffset) * 100.0;
				angle -= TAU / uSeed;
			}
			float on = step(0.5, sum / uSeed);
			// Clear the top-left and bottom-right corners with the same curved
			// falloff idea as bg.js's hero fade — the band's two headlines sit in
			// those corners and must read on clean paper, not on the pattern.
			vec2 uv = frag / uRes;
			float corner = smoothstep(0.42, 0.8, length(uv))
				* smoothstep(0.42, 0.8, length(vec2(1.0) - uv));
			gl_FragColor = vec4(${hexToGlsl(COLOR)}, 1.0) * (on * corner); // premultiplied
		}`

	const VERT = "attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }"

	const program = gl.createProgram()
	for (const [type, source] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
		const shader = gl.createShader(type)
		gl.shaderSource(shader, source)
		gl.compileShader(shader)
		gl.attachShader(program, shader)
	}
	gl.linkProgram(program)
	gl.useProgram(program)

	gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
	const aPos = gl.getAttribLocation(program, "aPos")
	gl.enableVertexAttribArray(aPos)
	gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

	const uRes = gl.getUniformLocation(program, "uRes")
	const uOffset = gl.getUniformLocation(program, "uOffset")
	const uSeed = gl.getUniformLocation(program, "uSeed")

	let offset = 0
	let raf = 0
	let onScreen = false
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

	function resize() {
		const w = band.clientWidth
		const h = band.clientHeight
		if (!w || !h) return
		canvas.width = w
		canvas.height = h
		gl.viewport(0, 0, w, h)
		gl.uniform2f(uRes, w, h)
		draw()
	}

	function draw() {
		const mid = (SEED_MIN + SEED_MAX) / 2
		const amp = (SEED_MAX - SEED_MIN) / 2
		gl.uniform1f(uOffset, offset)
		gl.uniform1f(uSeed, mid + amp * Math.sin(offset * SEED_RATE))
		gl.drawArrays(gl.TRIANGLES, 0, 3)
	}

	function tick() {
		raf = 0
		offset += SPEED / 128
		draw()
		if (onScreen && !reducedMotion.matches) raf = requestAnimationFrame(tick)
	}

	// Only animate while the band is in the viewport; reduced motion keeps the
	// static first frame that resize() already painted.
	function applyRunState() {
		if (onScreen && !raf && !reducedMotion.matches) raf = requestAnimationFrame(tick)
		if ((!onScreen || reducedMotion.matches) && raf) { cancelAnimationFrame(raf); raf = 0 }
	}

	new ResizeObserver(resize).observe(band)
	new IntersectionObserver(([entry]) => {
		onScreen = entry.isIntersecting
		applyRunState()
	}, { threshold: 0 }).observe(band)
	reducedMotion.addEventListener?.("change", applyRunState)

	resize()
}

function hexToGlsl(hex) {
	const n = parseInt(hex.slice(1), 16)
	return [16, 8, 0].map(shift => (((n >> shift) & 255) / 255).toFixed(4)).join(", ")
}
