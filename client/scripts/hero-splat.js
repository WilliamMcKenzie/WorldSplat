// Hero cursor-follower: the mech splat in the hero's right column floats on
// the page — transparent canvas, no box — and turns to face wherever the
// cursor is, like a robot tracking your gaze. On load it acts out the product
// promise: its block-out (baked by scripts/generate-hero-blockout.mjs into the
// same seat the splat lands in) constructs block by block — the editor's
// Apply-JSON reveal — then flashes white and dissolves into the real splat.
// Own WebGL context + SparkRenderer + scene — Spark accumulators are
// scene-scoped, so this can't ghost into the showcase splat below (and vice
// versa). Standalone on purpose, same as landing.js: the marketing page
// shares only primitives.js with the editor.

import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "spark"
import { createPrimitive, disposeObject } from "/scripts/primitives.js"

const ASSET = "/assets/hero-splat.ply"
const BLOCKOUT = "/assets/hero-blockout.json"
const BASE_YAW = Math.PI * 1.5 // raw front points along -X; a 90° left turn faces the camera
const MAX_YAW = 0.85 // rad each way toward the cursor
const MAX_PITCH = 0.32
const FOLLOW = 5.5 // 1/s — exponential chase toward the cursor
const BUILD_SECONDS = 0.4 // block-by-block construction, snappier than the editor reveal
const FLASH_MS = 200 // blocks ramp to white-hot…
const FADE_MS = 160 // …vanish completely…
const MATERIALIZE_MS = 280 // …and only then does the splat fade up
const WHITE = new THREE.Color(0xffffff)
const SPLAT_YAW = 15 * Math.PI / 180 // splat-only trim so it faces the same way as the block-out (tuned by eye on ?hero=overlay)

const host = document.getElementById("hero-stage")
if (host) main().catch(error => {
	console.error(error)
	host.remove() // hero degrades to text-only; the grid collapses the empty cell
})

async function main() {
	// Tuning aids for generate-hero-blockout.mjs: ?hero=hold freezes the show at
	// the fully-built block-out (no splat fetch, no flash); ?hero=overlay ghosts
	// the blocks over the seated splat to check part registration.
	const mode = new URLSearchParams(location.search).get("hero")
	const hold = mode === "hold"
	const overlay = mode === "overlay"

	// alpha canvas: only the splat's own gaussians paint, so it floats on the
	// page with no visible rectangle no matter what the page background is.
	const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" })
	renderer.setClearColor(0x000000, 0)
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
	host.appendChild(renderer.domElement)
	const scene = new THREE.Scene()
	scene.add(new SparkRenderer({ renderer }))
	// Splats are unlit; these exist for the block-out so it reads exactly like
	// the Build tab (same rig as landing.js's sketch layer).
	scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5d42, 2.25))
	const sun = new THREE.DirectionalLight(0xffffff, 1.8)
	sun.position.set(5, 8, 3)
	scene.add(sun)
	const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100)

	const resize = () => {
		const w = host.clientWidth
		const h = host.clientHeight
		if (!w || !h) return
		renderer.setSize(w, h, false)
		camera.aspect = w / h
		camera.updateProjectionMatrix()
	}
	new ResizeObserver(resize).observe(host)
	resize()

	// Gaze pivot goes up before any content exists — the block-out builds
	// inside it, so the half-made robot already tracks the cursor.
	const pivot = new THREE.Group()
	pivot.rotation.y = BASE_YAW
	scene.add(pivot)
	camera.position.set(0, 0.1, 3.3) // fov 38° at 3.3 fits the 2-unit seat + bob headroom
	camera.lookAt(0, 0, 0)

	// Track the cursor anywhere on the page: the offset from the splat's own
	// screen position sets a target yaw/pitch, chased with critically-damped ease.
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
	let targetYaw = 0
	let targetPitch = 0
	let sawPointer = false
	window.addEventListener("pointermove", event => {
		sawPointer = true
		const r = host.getBoundingClientRect()
		const dx = event.clientX - (r.left + r.width / 2)
		const dy = event.clientY - (r.top + r.height / 2)
		targetYaw = clamp(dx / (window.innerWidth * 0.5), -1, 1) * MAX_YAW
		targetPitch = clamp(dy / (window.innerHeight * 0.5), -1, 1) * MAX_PITCH
	}, { passive: true })

	let yaw = 0
	let pitch = 0
	let lastTime = performance.now()
	const tick = () => {
		const now = performance.now()
		const dt = Math.min(0.05, (now - lastTime) / 1000)
		lastTime = now
		if (!reduceMotion && !hold && !overlay) {
			// No pointer yet (touch devices): a slow ambient sway so it isn't frozen.
			const wantYaw = sawPointer ? targetYaw : Math.sin(now / 2400) * 0.22
			const wantPitch = sawPointer ? targetPitch : Math.sin(now / 3100) * 0.06
			const k = 1 - Math.exp(-FOLLOW * dt)
			yaw += (wantYaw - yaw) * k
			pitch += (wantPitch - pitch) * k
			pivot.rotation.y = BASE_YAW + yaw
			pivot.rotation.x = pitch
			pivot.position.y = Math.sin(now / 600) * 0.06 // hover: a visible ~3.8s bob
		}
		renderer.render(scene, camera)
	}
	renderer.setAnimationLoop(tick)
	// Only burn GL frames while the hero is actually on screen.
	new IntersectionObserver(([e]) => {
		renderer.setAnimationLoop(e.isIntersecting ? tick : null)
		if (e.isIntersecting) lastTime = performance.now()
	}, { threshold: 0 }).observe(host)

	// Splat streams while the block-out constructs; the .catch marks the
	// rejection handled until the real await below.
	const seating = hold ? null : loadSplat()
	seating?.catch(() => {})

	let blocks = null
	try {
		blocks = await buildBlocks()
		pivot.add(blocks)
	} catch (error) {
		console.warn("hero block-out unavailable, going straight to the splat", error)
	}

	// Don't start the show into a hidden tab (background-tab open): the reveal
	// would play unseen and the rAF tweens would freeze mid-flash anyway.
	if (document.hidden && !hold && !overlay) {
		await new Promise(resolve => {
			const onVisible = () => {
				if (document.hidden) return
				document.removeEventListener("visibilitychange", onVisible)
				resolve()
			}
			document.addEventListener("visibilitychange", onVisible)
		})
	}

	// Bottom-up staggered reveal, verbatim pacing from the editor's Apply-JSON
	// path: time-based so timer throttling can't stretch the build.
	if (blocks && !reduceMotion && !overlay) {
		const meshes = [...blocks.children].sort(
			(a, b) => (a.position.y - a.scale.y / 2) - (b.position.y - b.scale.y / 2),
		)
		const delay = Math.max(16, (BUILD_SECONDS * 1000) / meshes.length)
		const start = performance.now()
		let shown = 0
		while (shown < meshes.length) {
			const due = Math.min(meshes.length, Math.max(shown + 1, Math.ceil((performance.now() - start) / delay)))
			while (shown < due) meshes[shown++].visible = true
			await new Promise(resolve => window.setTimeout(resolve, delay))
		}
	} else if (blocks) {
		for (const mesh of blocks.children) mesh.visible = true
	}
	if (hold) return

	let seat = null
	try {
		seat = await seating
	} catch (error) {
		if (!blocks) throw error // nothing on screen — let the outer catch drop the stage
		console.error("hero splat unavailable; the block-out stays up", error)
		return
	}

	// Paths below skip the probe, so drop its twin right away.
	const dropProbe = () => {
		seat.probeMesh?.dispose?.()
		seat.probe = null
		seat.probeMesh = null
	}
	if (overlay) {
		dropProbe()
		pivot.add(seat.inner)
		for (const mesh of blocks?.children ?? []) {
			mesh.material.transparent = true
			mesh.material.opacity = 0.5
			mesh.material.depthWrite = false
		}
		window.__hero = { blocks, seat } // registration probing from the console
		return
	}
	if (!blocks) { dropProbe(); pivot.add(seat.inner); return }
	if (reduceMotion) {
		dropProbe()
		pivot.add(seat.inner)
		disposeObject(blocks)
		return
	}

	// Seat the splat invisibly and warm it behind the opaque blocks. A fixed
	// 450ms here wasn't enough: on a cold first open Spark still has WASM,
	// worker, and shader warm-up ahead, so the dissolve revealed an empty
	// stage for seconds ("robot doesn't load"). Hold the blocks until the
	// splat has actually painted pixels (probed offscreen), not a wall-clock
	// guess — capped so a probe failure can't pin the blocks.
	seat.mesh.opacity = 0
	pivot.add(seat.inner)
	await splatPainted()

	// The payoff: every block ramps to white-hot, the splat fades up through
	// the glow, and the blocks dissolve away — primitives became a world.
	const mats = []
	const lines = []
	for (const mesh of blocks.children) {
		mesh.material.emissive = WHITE.clone()
		mesh.material.emissiveIntensity = 0
		mats.push(mesh.material)
		const edge = mesh.children.find(child => child.userData.isEdgeOutline)
		if (edge) lines.push({ material: edge.material, base: edge.material.color.clone() })
	}
	await animate(FLASH_MS, t => {
		for (const mat of mats) mat.emissiveIntensity = t
		for (const { material, base } of lines) material.color.copy(base).lerp(WHITE, t)
	})
	// The white blocks vanish completely before the splat shows a single
	// gaussian — the blink of empty stage is what sells the swap.
	for (const mat of [...mats, ...lines.map(l => l.material)]) {
		mat.transparent = true
		mat.depthWrite = false
	}
	await animate(FADE_MS, t => {
		for (const mat of mats) mat.opacity = 1 - t
		for (const { material } of lines) material.opacity = 1 - t
	})
	disposeObject(blocks)
	await animate(MATERIALIZE_MS, t => { seat.mesh.opacity = t })
	seat.mesh.opacity = 1

	// The block-out is baked in display coordinates (see the generator), so the
	// primitives drop straight into the pivot with the editor's exact look.
	async function buildBlocks() {
		const response = await fetch(BLOCKOUT)
		if (!response.ok) throw new Error(`hero blockout fetch failed (${response.status})`)
		const data = await response.json()
		const group = new THREE.Group()
		;(data.primitives ?? []).forEach((prim, i) => {
			const mesh = createPrimitive(prim.type, i, prim)
			mesh.visible = false
			group.add(mesh)
		})
		if (!group.children.length) throw new Error("hero blockout is empty")
		return group
	}

	// Offscreen readiness probe. The hero mesh itself can't be probed: Spark
	// bakes mesh opacity into a scene-wide accumulation that regenerates
	// asynchronously on every opacity change, so toggling it per probe both
	// leaked visible flicker AND thrashed the pipeline with rebuilds. Instead
	// the probe renders the seat's down-sampled twin — its own scene, its own
	// SparkRenderer, same WebGL context — into a tiny target and reads the
	// pixels back. When the twin paints, the shared cold-start work (WASM,
	// sort worker, shader programs) is done, so the real mesh is ready too,
	// and the visible scene was never touched. Keeps the original 450ms beat
	// as a minimum; gives up after 5s so a probe failure degrades to the old
	// timer behavior instead of pinning the blocks.
	async function splatPainted() {
		if (!seat.probe) return
		const size = 64
		const target = new THREE.WebGLRenderTarget(size, size)
		const pixels = new Uint8Array(size * size * 4)
		const probeScene = new THREE.Scene()
		const probeSpark = new SparkRenderer({ renderer })
		probeScene.add(probeSpark)
		probeScene.add(seat.probe)
		const started = performance.now()
		try {
			for (;;) {
				renderer.setRenderTarget(target)
				renderer.render(probeScene, camera)
				renderer.setRenderTarget(null)
				renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels)
				let painted = false
				for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 1) { painted = true; break }
				const elapsed = performance.now() - started
				if ((painted && elapsed >= 450) || elapsed > 5000) return
				await new Promise(resolve => window.setTimeout(resolve, 150))
			}
		} finally {
			target.dispose()
			probeScene.remove(seat.probe)
			seat.probeMesh?.dispose?.()
			probeSpark.dispose?.()
			seat.probe = null
			seat.probeMesh = null
		}
	}

	async function loadSplat() {
		const response = await fetch(ASSET)
		if (!response.ok) throw new Error(`hero splat fetch failed (${response.status})`)
		const bytes = new Uint8Array(await response.arrayBuffer())
		// Data-only load; never added to the scene. Everything below works in the
		// file's RAW frame — the display mesh gets the Y-flip at the end.
		const source = new SplatMesh({ fileBytes: bytes, fileName: "hero-splat.ply" })
		await source.initialized

		// Percentile bounds, not min/max: generated splats carry floater gaussians
		// and a baked background haze; a raw bounding box zooms the subject into a
		// speck, and the haze is what painted the canvas as a visible rectangle.
		const count = source.packedSplats?.numSplats ?? 0
		const xs = new Float32Array(count)
		const ys = new Float32Array(count)
		const zs = new Float32Array(count)
		let n = 0
		source.packedSplats?.forEachSplat((_i, center) => {
			if (![center.x, center.y, center.z].every(Number.isFinite)) return
			xs[n] = center.x; ys[n] = center.y; zs[n] = center.z
			n++
		})
		if (!n) throw new Error("hero splat has no finite points")
		const pct = (sorted, p) => sorted[Math.min(n - 1, Math.floor(p * n))]
		for (const axis of [xs, ys, zs]) axis.subarray(0, n).sort()
		const lo = new THREE.Vector3(pct(xs, 0.005), pct(ys, 0.005), pct(zs, 0.005))
		const hi = new THREE.Vector3(pct(xs, 0.995), pct(ys, 0.995), pct(zs, 0.995))
		const size = hi.clone().sub(lo)

		// Rebuild with only the subject's gaussians: keep a 20%-margin box around
		// the percentile bounds, drop the far haze/floaters entirely. Also drop
		// giant fog blobs: this file carries ~10 gaussians up to 5 units across at
		// ~1% opacity — a soft gray veil over the whole canvas (the "top shadow").
		// Real surface splats top out near 2% of the subject size, so 5% is safe.
		const margin = size.clone().multiplyScalar(0.2)
		const keepLo = lo.clone().sub(margin)
		const keepHi = hi.clone().add(margin)
		const scaleCull = 0.05 * Math.max(size.x, size.y, size.z)
		const mesh = new SplatMesh({
			constructSplats: splats => {
				source.packedSplats.forEachSplat((_i, center, scales, quaternion, opacity, color) => {
					if (![center.x, center.y, center.z].every(Number.isFinite)) return
					if (center.x < keepLo.x || center.x > keepHi.x) return
					if (center.y < keepLo.y || center.y > keepHi.y) return
					if (center.z < keepLo.z || center.z > keepHi.z) return
					if (Math.max(scales.x, scales.y, scales.z) > scaleCull) return
					splats.pushSplat(center, scales, quaternion, opacity, color)
				})
			},
		})
		await mesh.initialized
		source.dispose?.()
		mesh.rotation.x = Math.PI // stored splat files are Y-inverted vs the world

		// Seat the splat centred on the origin at unit-ish size — the same frame
		// the block-out was baked into. The X-flip maps raw (x, y, z) →
		// (x, -y, -z), so flip the centre with it.
		const center = lo.clone().add(hi).multiplyScalar(0.5)
		const s = 0.8 * 2 / Math.max(size.x, size.y, size.z, 0.001) // 80% of the full seat height
		const inner = new THREE.Group()
		inner.add(mesh)
		inner.scale.setScalar(s)
		inner.position.set(-center.x * s, center.y * s, center.z * s)
		// Splat-only yaw trim: the generated splat's facing doesn't quite match
		// the block-out's, so the splat gets its own correction about its centre
		// (the rig origin = the seat origin) without touching the blocks.
		const rig = new THREE.Group()
		rig.rotation.y = SPLAT_YAW
		rig.add(inner)

		// Down-sampled twin for the readiness probe (see splatPainted): every
		// 16th gaussian in the same seat transform. It lives in its own probe
		// scene, never the visible one, and is disposed once the probe passes.
		const probeMesh = new SplatMesh({
			constructSplats: splats => {
				let i = 0
				mesh.packedSplats.forEachSplat((_i, center, scales, quaternion, opacity, color) => {
					if (i++ % 16 === 0) splats.pushSplat(center, scales, quaternion, opacity, color)
				})
			},
		})
		probeMesh.initialized.catch(() => {})
		probeMesh.rotation.x = Math.PI
		const probeInner = new THREE.Group()
		probeInner.add(probeMesh)
		probeInner.scale.setScalar(s)
		probeInner.position.set(-center.x * s, center.y * s, center.z * s)
		return { inner: rig, mesh, probe: probeInner, probeMesh }
	}
}

// rAF-driven tween, independent of the GL loop so an off-screen hero still
// finishes its sequence (invisibly) instead of stalling mid-swap.
function animate(ms, step) {
	return new Promise(resolve => {
		const start = performance.now()
		const frame = () => {
			const t = Math.min(1, (performance.now() - start) / ms)
			step(t)
			if (t < 1) requestAnimationFrame(frame)
			else resolve()
		}
		requestAnimationFrame(frame)
	})
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
