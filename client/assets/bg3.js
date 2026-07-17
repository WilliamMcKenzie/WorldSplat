// Animated pixel-wave background for the middle (showcase) band — the japanese
// courtyard. Same family and specs as bg.js (5px cells, zoom 8, tempo 2) with
// its own seed. It sits BEHIND the stage inside the sticky row (the stage's
// layers render transparent — see landing.js makeLayer), pointer-events off so
// world-dragging still works. The shader fades the pattern to nothing across
// the middle of the viewport — clean paper for the splat — leaving it solid
// along the top and bottom edges.
//
// Scroll choreography over the 300vh #showcase-scroll band: fade in over the
// first stretch of the sticky phase, hold fully on while the visitor is locked
// on the world, fade out over the last stretch, gone (and render loop paused)
// outside the band.

const PIXEL = 5 // CSS px per pattern cell — same grain as bg.js
const ZOOM = 8
const SPEED = 2 // offset units per frame, /128
// The wave-direction count is SCRUBBED BY SCROLL: this layer is the only one
// that stays stationary through the sticky band, so progress through the
// 300vh scroll sweeps the seed — the pattern morphs from sparse stripes to
// dense rosettes as the block-out dissolves into the splat. Fractional counts
// blend the frontier direction in smoothly (bg_2.js's uniform method).
const SEED_MIN = 3
const SEED_MAX = 14
const COLOR = "#f0f0f0"
const FADE_FRACTION = 0.18 // entry/exit ramp, as a fraction of the sticky scroll distance

const band = document.getElementById("showcase-scroll")
const row = band?.querySelector(".showcase")
const canvas = document.createElement("canvas")
canvas.setAttribute("aria-hidden", "true")
// Full-bleed like .stage: the sticky row lives inside main's max-width column,
// so a plain inset:0 canvas gets cut off at the viewport edges on wide screens.
canvas.style.cssText = "position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 100vw; height: 100%; z-index: 0; pointer-events: none;"
const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, stencil: false })

if (band && row && gl) {
	row.prepend(canvas) // before .stage in DOM → paints behind the world and the copy

	const VERT = "attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }"
	gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)

	// One static program; the live direction count arrives as a uniform so
	// scroll can scrub it every frame without recompiling shaders.
	const FRAG = `
		precision mediump float;
		uniform vec2 uRes;
		uniform float uOffset;
		uniform float uSeed; // live direction count, ${SEED_MIN}..${SEED_MAX} (fractional)
		const float TAU = 6.28318530718;
		const float PI = 3.14159265359;

		void main() {
			// Canvas-2D orientation (y down) and centered coordinates, as bg.js.
			vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
			vec2 cell = floor((frag - uRes * 0.5) / ${PIXEL.toFixed(1)}) * ${PIXEL.toFixed(1)};
			vec2 p = cell / ${ZOOM.toFixed(1)};

			float sum = 0.0;
			float angle = TAU;
			for (int i = 0; i < ${SEED_MAX}; i++) {
				// Directions past uSeed weigh 0; the frontier direction fades in
				// with its fraction, so scrubbing morphs instead of popping. Each
				// direction keeps quasicrystals.js's per-direction phase offset
				// ((PI/seed)*i*100) so the waves decorrelate.
				float w = clamp(uSeed - float(i), 0.0, 1.0);
				sum += w * cos(cos(angle) * p.x + sin(angle) * p.y + uOffset + (100.0 * PI / uSeed) * float(i)) * 100.0;
				angle -= TAU / uSeed;
			}
			float on = step(0.5, sum / uSeed);

			// Solid along the top and bottom edges, fading to nothing across the
			// middle where the courtyard and the copy live. Fade starts closer to
			// the edges (0.55, was 0.35) so the bands stay out of the middle.
			float d = abs(frag.y / uRes.y - 0.5) * 2.0; // 0 mid → 1 at edges
			float fade = smoothstep(0.55, 0.95, d);
			gl_FragColor = vec4(${hexToGlsl(COLOR)}, 1.0) * (on * fade); // premultiplied
		}`
	const program = gl.createProgram()
	for (const [type, source] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
		const shader = gl.createShader(type)
		gl.shaderSource(shader, source)
		gl.compileShader(shader)
		gl.attachShader(program, shader)
	}
	gl.linkProgram(program)
	gl.useProgram(program)
	const aPos = gl.getAttribLocation(program, "aPos")
	gl.enableVertexAttribArray(aPos)
	gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
	const uRes = gl.getUniformLocation(program, "uRes")
	const uOffset = gl.getUniformLocation(program, "uOffset")
	const uSeed = gl.getUniformLocation(program, "uSeed")

	let offset = 0
	let seed = SEED_MIN
	let raf = 0
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

	function resize() {
		const w = document.documentElement.clientWidth // full-bleed width, not the column's
		const h = row.clientHeight
		if (!w || !h) return
		canvas.width = w
		canvas.height = h
		gl.viewport(0, 0, w, h)
		gl.uniform2f(uRes, w, h)
		draw()
	}

	function draw() {
		gl.uniform1f(uOffset, offset)
		gl.uniform1f(uSeed, seed)
		gl.drawArrays(gl.TRIANGLES, 0, 3)
	}

	function tick() {
		raf = 0
		offset += SPEED / 128
		draw()
		if (!reducedMotion.matches) raf = requestAnimationFrame(tick)
	}

	// Progress through the sticky phase drives the layer's opacity: ramp in over
	// the first FADE_FRACTION, hold at 1 while scrolling on the world, ramp out
	// over the last FADE_FRACTION. Outside the band it is hidden and the render
	// loop stays paused.
	function applyScroll() {
		const rect = band.getBoundingClientRect()
		const travel = Math.max(1, rect.height - window.innerHeight) // sticky scroll distance
		const p = -rect.top / travel // <0 before the band, 0..1 through it, >1 past it
		const opacity = Math.max(0, Math.min(1, p / FADE_FRACTION, (1 - p) / FADE_FRACTION))
		// Scroll scrubs the direction count across the whole sticky phase.
		seed = SEED_MIN + (SEED_MAX - SEED_MIN) * Math.max(0, Math.min(1, p))
		canvas.style.opacity = String(opacity)
		canvas.style.visibility = opacity ? "visible" : "hidden"
		if (opacity && !raf && !reducedMotion.matches) raf = requestAnimationFrame(tick)
		if (!opacity && raf) { cancelAnimationFrame(raf); raf = 0 }
		if (opacity && (raf === 0 || reducedMotion.matches)) draw() // reduced motion still sees the scrub
	}

	window.addEventListener("resize", () => { resize(); applyScroll() })
	window.addEventListener("scroll", applyScroll, { passive: true })
	reducedMotion.addEventListener?.("change", applyScroll)
	new ResizeObserver(() => { resize(); applyScroll() }).observe(row)

	resize()
	applyScroll()
}

function hexToGlsl(hex) {
	const n = parseInt(hex.slice(1), 16)
	return [16, 8, 0].map(shift => (((n >> shift) & 255) / 255).toFixed(4)).join(", ")
}
