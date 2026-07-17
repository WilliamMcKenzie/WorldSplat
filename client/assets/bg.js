// Animated pixel-wave background — WebGL port of the old canvas-2D version.
// Same pattern: the screen is quantized into cells and each cell switches on
// when a few directions of cos(dir·p + offset) sum past a threshold. Cell size,
// zoom, and tempo match bg_2.js so the hero and reveal bands read as one
// system. The 2D port walked every cell on the CPU each frame; here one
// fragment shader evaluates all cells on the GPU.
//
// The shader also bakes in the landing-page fade: fully transparent at the top,
// peaking at the hero section's bottom edge, then easing out over an OVERHANG
// below it — the canvas runs OVERHANG px past the hero so the pattern breathes
// away instead of ending on a hard cutoff line. Scrolling fades the whole layer
// out — gone entirely after about half a viewport — and pauses the render loop.

const PIXEL = 5 // CSS px per pattern cell — same grain as bg_2.js so both bands read as one system
const ZOOM = 8 // matches bg_2.js
const SPEED = 2 // offset units per frame, /128 — bg_2.js's slower tempo
const SEED = 3 // wave directions spread evenly over 2π
const COLOR = "#f0f0f0"
const OVERHANG = 180 // px past the hero bottom over which the pattern fades to nothing
const SCROLL_FADE_PX = () => window.innerHeight * 0.5 // fully gone after this much scroll

const canvas = document.createElement("canvas")
canvas.setAttribute("aria-hidden", "true")
// Absolute, not fixed: it scrolls with the page and resize() pins its bottom
// edge to the hero section's bottom (bottom: 0 of the top section, effectively).
canvas.style.cssText = "position: absolute; top: 0; left: 0; width: 100%; z-index: -1; pointer-events: none;"
const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, stencil: false })

if (gl) {
	document.body.prepend(canvas)

	const FRAG = `
		precision mediump float;
		uniform vec2 uRes;
		uniform float uOffset;
		uniform float uTail; // overhang below the hero, as a fraction of canvas height
		const float TAU = 6.28318530718;

		void main() {
			// Canvas-2D orientation (y down) and the old loop's centered coordinates.
			vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
			vec2 cell = floor((frag - uRes * 0.5) / ${PIXEL.toFixed(1)}) * ${PIXEL.toFixed(1)};
			vec2 p = cell / ${ZOOM.toFixed(1)};

			float sum = 0.0;
			float angle = TAU;
			for (int i = 0; i < ${Math.ceil(SEED)}; i++) {
				sum += cos(cos(angle) * p.x + sin(angle) * p.y + uOffset) * 100.0;
				angle -= TAU / ${SEED.toFixed(4)};
			}
			float on = step(0.5, sum / ${SEED.toFixed(4)});

			// Peaks at the hero's bottom edge (1 - uTail of the canvas), 0% above a
			// cutoff line that stays LOW on the left (clear of the hero copy and
			// CTA), runs flat to mid-screen, then curves up to the right edge's
			// full height — and eases back to 0 over the overhang below the hero,
			// so the pattern has no hard bottom cutoff.
			float x = gl_FragCoord.x / uRes.x;
			float cut = 0.8 * (1.0 - smoothstep(0.45, 0.85, x));
			float t = frag.y / uRes.y;
			float peak = 1.0 - uTail;
			float rise = clamp((t - cut) / max(0.0001, peak - cut), 0.0, 1.0);
			float tail = 1.0 - smoothstep(peak, 1.0, t);
			float fade = min(rise, tail);
			gl_FragColor = vec4(${hexToGlsl(COLOR)}, 1.0) * (on * fade); // premultiplied
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
	const uTail = gl.getUniformLocation(program, "uTail")

	let offset = 0
	let raf = 0
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

	function resize() {
		// Cover from the document top to OVERHANG px past the hero section's
		// bottom edge: the pattern peaks exactly on the section bottom and fades
		// to nothing across the overhang (buffer stays in CSS px — cells keep
		// their chunk size).
		const hero = document.querySelector(".hero")
		const heroBottom = hero
			? Math.ceil(hero.getBoundingClientRect().bottom + window.scrollY)
			: window.innerHeight
		const bottom = heroBottom + OVERHANG
		const width = document.documentElement.clientWidth
		if (!width || !bottom) return
		canvas.width = width
		canvas.height = bottom
		canvas.style.height = `${bottom}px`
		gl.viewport(0, 0, canvas.width, canvas.height)
		gl.uniform2f(uRes, canvas.width, canvas.height)
		gl.uniform1f(uTail, OVERHANG / bottom)
		draw()
	}

	function draw() {
		gl.uniform1f(uOffset, offset)
		gl.drawArrays(gl.TRIANGLES, 0, 3)
	}

	function tick() {
		raf = 0
		offset += SPEED / 128
		draw()
		if (!reducedMotion.matches) raf = requestAnimationFrame(tick)
	}

	// Scroll a bit and the layer leaves entirely; the loop pauses while it is gone.
	function applyScroll() {
		const opacity = Math.max(0, 1 - window.scrollY / SCROLL_FADE_PX())
		canvas.style.opacity = String(opacity)
		canvas.style.visibility = opacity ? "visible" : "hidden"
		if (opacity && !raf && !reducedMotion.matches) raf = requestAnimationFrame(tick)
		if (!opacity && raf) { cancelAnimationFrame(raf); raf = 0 }
	}

	window.addEventListener("resize", () => { resize(); applyScroll() })
	window.addEventListener("scroll", applyScroll, { passive: true })
	reducedMotion.addEventListener?.("change", applyScroll)
	// The hero grows after load (web fonts, the splat stage) — track its box so
	// the canvas bottom stays pinned to the section bottom.
	const hero = document.querySelector(".hero")
	if (hero) new ResizeObserver(() => { resize(); applyScroll() }).observe(hero)

	resize()
	applyScroll()
}

function hexToGlsl(hex) {
	const n = parseInt(hex.slice(1), 16)
	return [16, 8, 0].map(shift => (((n >> shift) & 255) / 255).toFixed(4)).join(", ")
}
