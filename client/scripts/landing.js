// Landing-page showcase stage: the japanese-courtyard block-out sketch and its
// generated splat share one orbit on two stacked canvases. The card sits sticky
// inside the tall #showcase-scroll band and scroll progress scrubs the sketch
// layer's opacity — the further you scroll, the more the block-out dissolves
// into the real splat. Standalone on purpose — shares only primitives.js with
// the editor so the marketing page can't drift the app.

import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"
import { createPrimitive } from "/scripts/primitives.js"
// reveal.js is versioned too — the server caches .js for 1h and a stale reveal.js
// (old feed-me API) paired with a fresh landing.js leaves the band stuck empty.
import { initReveal } from "/scripts/reveal.js?v=worldsplat-30"

const ASSET = "/assets/japanese-courtyard"
const PANEL = 0xfbfbfa // paper colour; layers clear it at alpha 0 (kept for premultiplied edge blending)

const stage = document.getElementById("stage")
const hint = document.getElementById("stage-hint")

// TEMP calibration harness — ?calib=1&yaw=0&k=1&dx=0&dz=0&theta=0.785&phi=1.12
// freezes the orbit and overlays the sketch at half opacity over the splat.
const Q = new URLSearchParams(location.search)
const calib = Q.has("calib")
const qn = (name, dflt) => (Q.has(name) ? Number(Q.get(name)) : dflt)

const booted = main()
booted.catch(error => {
	console.error(error)
	hint.textContent = "The world couldn't load. Check client/assets/japanese-courtyard.*"
})
// Calib screenshots wait on the window load event, so hold module evaluation
// (and with it the load event) until the splat is seated and drawn.
if (calib) await booted

async function main() {
	// Kick the heavy splat download off first so it streams while the sketch builds.
	const splatFetch = fetch(`${ASSET}.ply`)
	const splatLayer = makeLayer()
	// Spark draws every SplatMesh through ANY SparkRenderer sharing its globals, so
	// only the splat layer gets one — a second would ghost the splat into the sketch.
	splatLayer.scene.add(new SparkRenderer({ renderer: splatLayer.renderer }))
	const sketchLayer = makeLayer() // later sibling paints on top
	sketchLayer.canvas.classList.add("fade")
	sketchLayer.scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5d42, 2.25)) // editor lighting,
	const sun = new THREE.DirectionalLight(0xffffff, 1.8) // so the block-out reads identically
	sun.position.set(5, 8, 3)
	sketchLayer.scene.add(sun)

	// The sketch is a 35KB JSON — build and show it immediately while the splat streams.
	const blockoutJson = await (await fetch(`${ASSET}-blockout.json`)).json()
	const { group: blockout, box: blockoutBox } = normalize(buildBlockout(blockoutJson))
	// Seat wrapper: rotates/scales the normalized sketch about the world origin so it
	// can be registered onto the splat's frame (content is already centered on origin).
	const seat = new THREE.Group()
	seat.add(blockout)
	seat.rotation.y = qn("yaw", Math.PI / 2) // +90° turns the sketch to the left, onto the splat's heading
	seat.scale.setScalar(qn("k", 1.04)) // 1.3 (matches the splat) × 0.8 world shrink
	seat.position.set(qn("dx", 0), qn("dy", 0.12), qn("dz", 0)) // lift, also × 0.8 to stay registered
	sketchLayer.scene.add(seat)

	const view = frameFor(blockoutBox)
	view.radius *= 1.1 // pull the camera back ~10% so the world sits a bit smaller in frame
	if (calib) {
		view.theta = qn("theta", view.theta)
		view.phi = qn("phi", view.phi)
		view.radius *= qn("r", 1)
	}
	hint.remove()
	sketchLayer.canvas.style.opacity = "1" // visible immediately; the scroll morph takes over below

	// Drag to orbit; auto-rotate resumes after a beat of stillness.
	const reduceMotion = calib || window.matchMedia("(prefers-reduced-motion: reduce)").matches
	let lastPointer = null
	let lastInteraction = -Infinity
	stage.addEventListener("pointerdown", event => {
		stage.setPointerCapture(event.pointerId)
		lastPointer = { x: event.clientX, y: event.clientY }
		lastInteraction = performance.now()
	})
	stage.addEventListener("pointermove", event => {
		if (!lastPointer) return
		view.theta -= (event.clientX - lastPointer.x) * 0.005
		view.phi = Math.min(1.5, Math.max(0.45, view.phi - (event.clientY - lastPointer.y) * 0.005))
		lastPointer = { x: event.clientX, y: event.clientY }
		lastInteraction = performance.now()
	})
	const release = () => { lastPointer = null }
	stage.addEventListener("pointerup", release)
	stage.addEventListener("pointercancel", release)

	// Scroll drives the morph: progress through the sticky band fades the sketch
	// layer out over the splat. Until the splat is seated the sketch holds at
	// full opacity so a fast scroller never stares at an empty panel.
	const scroller = document.getElementById("showcase-scroll")
	let splatReady = false
	const morphProgress = () => {
		const r = scroller.getBoundingClientRect()
		const span = Math.max(1, r.height - (window.innerHeight || 1))
		const raw = clamp(-r.top / span, 0, 1)
		const t = clamp((raw - 0.12) / 0.76, 0, 1) // hold pure sketch / pure splat at the ends
		return t * t * (3 - 2 * t)
	}
	const applyMorph = () => {
		const p = morphProgress()
		// True crossfade — both canvases are transparent (the bg3.js pattern sits
		// behind the stage), so the splat can't hide under an opaque panel: it
		// fades in exactly as the sketch fades out.
		sketchLayer.canvas.style.opacity = String(splatReady ? 1 - p : 1)
		splatLayer.canvas.style.opacity = String(splatReady ? p : 0)
	}
	if (!calib) {
		applyMorph()
		window.addEventListener("scroll", applyMorph, { passive: true })
		window.addEventListener("resize", applyMorph)
	}

	// Mount the scroll-reveal band now — it fetches its own pre-sampled points
	// (assets/reveal-points.json), so it resolves without waiting on any splat.
	if (!calib) initReveal()

	const drawFrame = () => {
		for (const layer of [splatLayer, sketchLayer]) {
			layer.camera.position.set(
				view.target.x + view.radius * Math.sin(view.phi) * Math.sin(view.theta),
				view.target.y + view.radius * Math.cos(view.phi),
				view.target.z + view.radius * Math.sin(view.phi) * Math.cos(view.theta),
			)
			layer.camera.lookAt(view.target)
			layer.renderer.render(layer.scene, layer.camera)
		}
	}
	let lastTime = performance.now()
	const tick = () => {
		const now = performance.now()
		const dt = Math.min(0.05, (now - lastTime) / 1000)
		lastTime = now
		if (!reduceMotion && !lastPointer && now - lastInteraction > 2500) view.theta += dt * 0.12
		drawFrame()
	}
	splatLayer.renderer.setAnimationLoop(tick)
	// The hero and the scroll-reveal cloud are never on screen together — pause the
	// hero's GL loop once it scrolls away so only one heavy render runs at a time.
	if (!calib) new IntersectionObserver(([e]) => {
		splatLayer.renderer.setAnimationLoop(e.isIntersecting ? tick : null)
		if (e.isIntersecting) lastTime = performance.now()
	}, { threshold: 0 }).observe(stage)

	// The splat has been streaming since the top of main(); seat it in the same
	// normalized frame, then start the loop.
	const response = await splatFetch
	if (!response.ok) throw new Error(`splat fetch failed (${response.status})`)
	const bytes = new Uint8Array(await response.arrayBuffer())
	const mesh = new SplatMesh({ fileBytes: bytes, fileName: "japanese-courtyard.ply" })
	await mesh.initialized
	mesh.rotation.x = Math.PI // stored splat files are Y-inverted vs the world
	mesh.updateMatrixWorld(true)

	const rawBox = new THREE.Box3()
	const point = new THREE.Vector3()
	mesh.packedSplats?.forEachSplat((_i, center) => {
		if (![center.x, center.y, center.z].every(Number.isFinite)) return
		rawBox.expandByPoint(point.copy(center).applyMatrix4(mesh.matrixWorld))
	})
	const { group: splat } = normalize({ group: new THREE.Group().add(mesh), box: rawBox })
	// Seat calibrated against the sketch with the slider tuner (2026-07-16):
	// slightly larger than the sketch's 0.8 baseline shrink, nudged and lifted
	// so the courtyard registers on the block-out plate.
	const splatSeat = new THREE.Group()
	splatSeat.add(splat)
	splatSeat.scale.setScalar(0.9)
	splatSeat.position.set(-0.07, 0.05, 0.035)
	splatLayer.scene.add(splatSeat)
	splatLayer.canvas.classList.add("base")

	if (calib) {
		// Overlay mode: both layers visible at once, camera frozen, no scroll morph.
		sketchLayer.canvas.style.opacity = String(qn("op", 0.55))
		stage.scrollIntoView({ block: "center" })
		await new Promise(resolve => setTimeout(resolve, 800)) // let the sort worker settle
		drawFrame()
		document.title = "calib-ready"
		return
	}

	// The splat is seated — hand the sketch layer's opacity over to the scroll
	// position, wherever the user has already scrolled to.
	splatReady = true
	applyMorph()

	function makeLayer() {
		// alpha canvas cleared fully transparent: the stage floats on the page, so
		// the bg3.js pattern behind it stays visible around the world.
		const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" })
		renderer.setClearColor(PANEL, 0)
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
		const scene = new THREE.Scene()
		const camera = new THREE.PerspectiveCamera(46, 1, 0.05, 2000)
		const layer = { renderer, scene, camera, canvas: renderer.domElement }
		stage.insertBefore(layer.canvas, hint)
		const resize = () => {
			const w = stage.clientWidth
			const h = stage.clientHeight
			if (!w || !h) return
			renderer.setSize(w, h, false)
			camera.aspect = w / h
			// Full-bleed canvas: seat the world around the left third — the copy owns
			// the right. Proportional to the extra width, so squarish viewports (and
			// the mobile layout) keep the world centered.
			camera.setViewOffset(w, h, Math.round(Math.max(0, w - h) * 0.35), 0, w, h)
			camera.updateProjectionMatrix()
		}
		new ResizeObserver(resize).observe(stage)
		resize()
		return layer
	}
}

// Rebuild the block-out exactly as the editor draws it: painted-stroke ground
// sheet + createPrimitive boxes (same materials and edge outlines).
function buildBlockout(data) {
	const group = new THREE.Group()

	const strokes = (data.ground?.strokes ?? []).filter(s => s.points?.length)
	if (strokes.length) {
		const pad = Math.max(...strokes.map(s => s.radius)) * 1.5
		const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
		for (const stroke of strokes) {
			for (const [x, z] of stroke.points) {
				bounds.minX = Math.min(bounds.minX, x - pad); bounds.maxX = Math.max(bounds.maxX, x + pad)
				bounds.minZ = Math.min(bounds.minZ, z - pad); bounds.maxZ = Math.max(bounds.maxZ, z + pad)
			}
		}
		const w = bounds.maxX - bounds.minX
		const h = bounds.maxZ - bounds.minZ
		const W = 1024
		const H = Math.round(W * (h / w))
		const canvas = document.createElement("canvas")
		canvas.width = W
		canvas.height = H
		const ctx = canvas.getContext("2d")
		const px = x => ((x - bounds.minX) / w) * W
		const py = z => ((z - bounds.minZ) / h) * H // flipY texture: +z runs down the canvas
		for (const stroke of strokes) {
			ctx.strokeStyle = ctx.fillStyle = stroke.color
			ctx.lineWidth = stroke.radius * 2 * (W / w)
			ctx.lineCap = ctx.lineJoin = "round"
			if (stroke.points.length === 1) {
				const [x, z] = stroke.points[0]
				ctx.beginPath()
				ctx.arc(px(x), py(z), stroke.radius * (W / w), 0, Math.PI * 2)
				ctx.fill()
			} else {
				ctx.beginPath()
				stroke.points.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), py(z)) : ctx.moveTo(px(x), py(z))))
				ctx.stroke()
			}
		}
		const texture = new THREE.CanvasTexture(canvas)
		texture.colorSpace = THREE.SRGBColorSpace
		const sheet = new THREE.Mesh(
			new THREE.PlaneGeometry(w, h),
			new THREE.MeshStandardMaterial({
				map: texture,
				transparent: true, // unpainted ground is void, like the editor
				roughness: 1,
				polygonOffset: true,
				polygonOffsetFactor: 1,
				polygonOffsetUnits: 1,
			}),
		)
		sheet.rotation.x = -Math.PI / 2
		sheet.position.set((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2)
		group.add(sheet)
	}

	;(data.primitives ?? []).forEach((prim, i) => group.add(createPrimitive(prim.type, i, prim)))

	group.updateMatrixWorld(true)
	const box = new THREE.Box3().setFromObject(group)
	return { group, box }
}

// Seat a world into a shared canonical frame — footprint spanning 2 units,
// centered at the origin, resting on y=0 — so sketch and splat overlay during
// the crossfade no matter what units they were authored in.
function normalize({ group, box }) {
	const size = box.getSize(new THREE.Vector3())
	const center = box.getCenter(new THREE.Vector3())
	const s = 2 / Math.max(size.x, size.z, 0.001)
	const wrapper = new THREE.Group()
	wrapper.add(group)
	wrapper.scale.setScalar(s)
	wrapper.position.set(-center.x * s, -box.min.y * s, -center.z * s)
	wrapper.updateMatrixWorld(true)
	const normBox = new THREE.Box3(
		new THREE.Vector3(-size.x * s / 2, 0, -size.z * s / 2),
		new THREE.Vector3(size.x * s / 2, size.y * s, size.z * s / 2),
	)
	return { group: wrapper, box: normBox }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

function frameFor(box) {
	const sphere = box.getBoundingSphere(new THREE.Sphere())
	const target = sphere.center.clone()
	// Aim below the sphere center: tall thin props (poles) inflate the box, and
	// targeting half-height leaves a big sky gap while the plate clips below.
	target.y = box.min.y + (box.max.y - box.min.y) * 0.33
	return {
		target,
		radius: Math.max(0.5, sphere.radius * 1.58), // 1.9 / 1.2 — the world reads ~20% bigger
		theta: 1.296, // calibrated with the slider tuner (2026-07-16)
		phi: 1.12, // polar angle from +Y — a gentle look down onto the plot
	}
}
