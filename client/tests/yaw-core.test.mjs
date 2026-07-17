import assert from "node:assert/strict"
import test from "node:test"

import { estimateYawFromData, unitChroma } from "../scripts/yaw-core.js"

// Synthetic object-only scene: two coloured pillars in an L (asymmetric under yaw).
// The estimator must recover the quarter-turn that was baked into the splat cloud.

const YAW_GRID = 32
// The real capture camera basis (ISO_PROJ_RIGHT/UP in renderer.js). A plain front view
// is degenerate here: it drops depth entirely, and after per-candidate re-normalization
// a two-pillar L reads identically at two different quarter-turns.
const PROJ_RIGHT = [1 / Math.sqrt(2), 0, -1 / Math.sqrt(2)]
const PROJ_UP = [-1 / Math.sqrt(6), 2 / Math.sqrt(6), -1 / Math.sqrt(6)]

const BLOCKS = [
	{ pos: [8, 1, 0], scale: [2, 2, 2], hex: "c82828" }, // red pillar on +X
	{ pos: [0, 1, 8], scale: [2, 2, 2], hex: "2828c8" }, // blue pillar on +Z
]

// Mirror of the renderer's block prep: 27 samples per block, projected bounds, occupancy
// cells, and per-colour anchors (see estimateSceneYaw in renderer.js).
function blockInputs() {
	const blockUV = []
	const blockRects = []
	for (const { pos, scale, hex } of BLOCKS) {
		const vol = scale[0] * scale[1] * scale[2]
		const rect = [Infinity, -Infinity, Infinity, -Infinity]
		for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) {
			const p = [
				pos[0] + (a / 2 - 0.5) * scale[0],
				pos[1] + (b / 2 - 0.5) * scale[1],
				pos[2] + (c / 2 - 0.5) * scale[2],
			]
			const pu = p[0] * PROJ_RIGHT[0] + p[1] * PROJ_RIGHT[1] + p[2] * PROJ_RIGHT[2]
			const pv = p[0] * PROJ_UP[0] + p[1] * PROJ_UP[1] + p[2] * PROJ_UP[2]
			blockUV.push([pu, pv, hex, vol / 27])
			rect[0] = Math.min(rect[0], pu); rect[1] = Math.max(rect[1], pu)
			rect[2] = Math.min(rect[2], pv); rect[3] = Math.max(rect[3], pv)
		}
		blockRects.push(rect)
	}
	let bu0 = Infinity, bu1 = -Infinity, bv0 = Infinity, bv1 = -Infinity
	for (const [u, v] of blockUV) { bu0 = Math.min(bu0, u); bu1 = Math.max(bu1, u); bv0 = Math.min(bv0, v); bv1 = Math.max(bv1, v) }
	const normRects = blockRects.map(([u0, u1, v0, v1]) => [
		(u0 - bu0) / (bu1 - bu0), (u1 - bu0) / (bu1 - bu0),
		(v0 - bv0) / (bv1 - bv0), (v1 - bv0) / (bv1 - bv0),
	])
	const blockOcc = new Set()
	const anchors = new Map()
	let blockMass = 0
	for (const [u, v, key, w] of blockUV) {
		const x = (u - bu0) / (bu1 - bu0)
		const y = (v - bv0) / (bv1 - bv0)
		blockOcc.add(Math.min(YAW_GRID - 1, x * YAW_GRID | 0) * YAW_GRID + Math.min(YAW_GRID - 1, y * YAW_GRID | 0))
		const a = anchors.get(key) ?? anchors.set(key, [0, 0, 0]).get(key)
		a[0] += x * w; a[1] += y * w; a[2] += w
		blockMass += w
	}
	const anchorChroma = [...anchors.keys()].map(key => [key, unitChroma(
		parseInt(key.slice(0, 2), 16), parseInt(key.slice(2, 4), 16), parseInt(key.slice(4, 6), 16),
	)])
	return { normRects, blockOcc: [...blockOcc], occupancyTarget: null, anchors: [...anchors], anchorChroma, blockMass }
}

function lcg(seed) {
	return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
}

// World-space cloud matching the two pillars.
function worldCloud() {
	const rand = lcg(7)
	const points = []
	for (const { pos, scale, hex } of BLOCKS) {
		const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16)
		for (let i = 0; i < 400; i++) {
			points.push([
				pos[0] + (rand() - 0.5) * scale[0] * 0.8,
				pos[1] + (rand() - 0.5) * scale[1] * 0.9,
				pos[2] + (rand() - 0.5) * scale[2] * 0.8,
				r, g, b,
			])
		}
	}
	return points
}

// Bake the INVERSE of the estimator's candidate transform into the cloud, so the
// estimator has to pick exactly `yawDeg` to undo it.
function bakeYaw(points, yawDeg) {
	const th = (yawDeg * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th)
	return points.map(([wx, y, wz, r, g, b]) => [wx * co - wz * si, y, wx * si + wz * co, r, g, b])
}

// Raw splat bytes: pos f32×3 at +0 (stored Y is world-inverted), rgba u8×4 at +24.
function splatBytes(points) {
	const bytes = new Uint8Array(points.length * 32)
	const view = new DataView(bytes.buffer)
	points.forEach(([x, y, z, r, g, b], i) => {
		const o = i * 32
		view.setFloat32(o, x, true)
		view.setFloat32(o + 4, -y, true)
		view.setFloat32(o + 8, z, true)
		view.setUint8(o + 24, r)
		view.setUint8(o + 25, g)
		view.setUint8(o + 26, b)
		view.setUint8(o + 27, 255)
	})
	return bytes
}

function estimate(points) {
	return estimateYawFromData({
		bytes: splatBytes(points),
		projRight: PROJ_RIGHT,
		projUp: PROJ_UP,
		yawOffsetDeg: 0,
		blocks: blockInputs(),
		ground: null,
	})
}

test("recovers an unrotated scene as yaw 0", () => {
	const result = estimate(worldCloud())
	assert.equal(result.yawDeg, 0)
	assert.equal(result.mirrorZ, false)
	assert.match(result.log, /scene yaw estimate → 0°/)
})

for (const yaw of [90, 180, 270]) {
	test(`recovers a scene baked at ${yaw}°`, () => {
		const result = estimate(bakeYaw(worldCloud(), yaw))
		assert.equal(result.yawDeg, yaw)
		assert.equal(result.mirrorZ, false)
	})
}

test("returns null when the splat is too sparse to judge", () => {
	assert.equal(estimate(worldCloud().slice(0, 50)), null)
})

// ---- Painted-ground evidence path (water overlap + footprint + fine sweep) ----------
// A green sheet with a blue pond at (5, 7); the splat floor carries a blue cluster that
// only the true rotation lands back on the pond. Uses a single centred grey block, so
// the block terms carry no yaw signal — the water term must decide alone.

const SHEET = 40 // world units, sheet spans [-20, 20]²
const POND = [5, 7]

function groundInput() {
	const S = 256
	const grid = new Uint8ClampedArray(S * S * 4)
	let waterCells = 0, wx = 0, wz = 0
	for (let j = 0; j < S; j++) {
		for (let i = 0; i < S; i++) {
			const o = (j * S + i) * 4
			const worldX = (i + 0.5) / S * SHEET - SHEET / 2
			const worldZ = (j + 0.5) / S * SHEET - SHEET / 2
			const water = Math.hypot(worldX - POND[0], worldZ - POND[1]) < 3
			grid[o] = water ? 40 : 80
			grid[o + 1] = water ? 90 : 160
			grid[o + 2] = water ? 200 : 60
			grid[o + 3] = 255
			if (water) { waterCells++; wx += worldX; wz += worldZ }
		}
	}
	const target = { tcx: 0, tcz: 0, tSpanX: SHEET, tSpanZ: SHEET }
	target.fx0 = -SHEET / 2 - SHEET * 0.05
	target.fz0 = -SHEET / 2 - SHEET * 0.05
	target.fw = SHEET * 1.1
	target.fh = SHEET * 1.1
	const inkGrid = new Uint8Array(64 * 64).fill(1) // fully painted sheet
	return {
		grid, gridSize: S, sheetSize: SHEET,
		waterCells, waterCenter: [wx / waterCells, wz / waterCells],
		target, inkGrid, inkCells: 64 * 64, anchorClasses: [],
	}
}

function groundWorldCloud() {
	const points = []
	for (let gx = 0; gx <= 90; gx++) { // inclusive: keep the floor symmetric about the origin
		for (let gz = 0; gz <= 90; gz++) {
			const x = -18 + gx * 0.4, z = -18 + gz * 0.4
			const blue = Math.hypot(x - POND[0], z - POND[1]) < 3
			points.push([x, 0.05, z, blue ? 60 : 80, blue ? 80 : 160, blue ? 200 : 60])
		}
	}
	const rand = lcg(11)
	for (let i = 0; i < 400; i++) {
		points.push([(rand() - 0.5) * 2, 0.3 + rand() * 1.6, (rand() - 0.5) * 2, 144, 144, 144])
	}
	return points
}

// ---- Photo (render-and-compare) evidence path ---------------------------------------
// The generated image is the ground truth of what the splat depicts from the capture
// camera. A colour grid of it lets the estimator separate mirrored candidates even on
// object-only scenes, where mirror detection used to be gated off entirely.

// Content-normalized colour grid of the TRUE (identity) orientation — the estimator's
// splat-side cell convention: gx from the right axis, gy from the up axis, gx*G+gy.
function photoFromCloud(points) {
	const G = 20
	const uv = points.map(([x, y, z, r, g, b]) => [
		x * PROJ_RIGHT[0] + y * PROJ_RIGHT[1] + z * PROJ_RIGHT[2],
		x * PROJ_UP[0] + y * PROJ_UP[1] + z * PROJ_UP[2],
		r, g, b,
	])
	let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
	for (const [u, v] of uv) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v) }
	const sums = new Float32Array(G * G * 3)
	const counts = new Uint32Array(G * G)
	for (const [u, v, r, g, b] of uv) {
		const gx = Math.min(G - 1, ((u - u0) / (u1 - u0)) * G | 0)
		const gy = Math.min(G - 1, ((v - v0) / (v1 - v0)) * G | 0)
		const cell = gx * G + gy
		counts[cell]++
		sums[cell * 3] += r; sums[cell * 3 + 1] += g; sums[cell * 3 + 2] += b
	}
	const grid = new Float32Array(G * G * 3)
	const cover = new Uint8Array(G * G)
	for (let c = 0; c < G * G; c++) {
		if (!counts[c]) continue
		cover[c] = 1
		grid[c * 3] = sums[c * 3] / counts[c]
		grid[c * 3 + 1] = sums[c * 3 + 1] / counts[c]
		grid[c * 3 + 2] = sums[c * 3 + 2] / counts[c]
	}
	return { grid: [...grid], cover: [...cover], size: G }
}

// Mirror-symmetric geometry, asymmetric colours: a neutral slab (fills the photo grid
// like a real scene's ground does) with a red pillar at +Z and a blue one at −Z. Only
// colour evidence can tell the mirrored seating from the straight one.
const MIRROR_BLOCKS = [
	{ pos: [0, 0.25, 0], scale: [10, 0.5, 20], hex: "909090" },
	{ pos: [0, 1.5, 8], scale: [3, 3, 3], hex: "c82828" },
	{ pos: [0, 1.5, -8], scale: [3, 3, 3], hex: "2828c8" },
]
const bakeMirrorZ = points => points.map(([x, y, z, r, g, b]) => [x, y, -z, r, g, b])

test("photo evidence recovers a mirrored object-only scene", () => {
	const saved = BLOCKS.splice(0, BLOCKS.length, ...MIRROR_BLOCKS)
	try {
		const photo = photoFromCloud(worldCloud())
		const result = estimateYawFromData({
			bytes: splatBytes(bakeMirrorZ(worldCloud())),
			projRight: PROJ_RIGHT,
			projUp: PROJ_UP,
			yawOffsetDeg: 0,
			blocks: blockInputs(),
			ground: null,
			photo,
		})
		assert.equal(result.mirrorZ, true)
		assert.equal(result.yawDeg, 0)
		assert.doesNotMatch(result.top[0], /pho —/) // the photo term actually fired
	} finally {
		BLOCKS.splice(0, BLOCKS.length, ...saved)
	}
})

test("photo evidence does not invent a mirror on a straight scene", () => {
	const saved = BLOCKS.splice(0, BLOCKS.length, ...MIRROR_BLOCKS)
	try {
		const photo = photoFromCloud(worldCloud())
		const result = estimateYawFromData({
			bytes: splatBytes(worldCloud()),
			projRight: PROJ_RIGHT,
			projUp: PROJ_UP,
			yawOffsetDeg: 0,
			blocks: blockInputs(),
			ground: null,
			photo,
		})
		assert.equal(result.mirrorZ, false)
		assert.equal(result.yawDeg, 0)
	} finally {
		BLOCKS.splice(0, BLOCKS.length, ...saved)
	}
})

test("photo evidence agrees with the baked quarter-turn", () => {
	const photo = photoFromCloud(worldCloud())
	const result = estimateYawFromData({
		bytes: splatBytes(bakeYaw(worldCloud(), 180)),
		projRight: PROJ_RIGHT,
		projUp: PROJ_UP,
		yawOffsetDeg: 0,
		blocks: blockInputs(),
		ground: null,
		photo,
	})
	assert.equal(result.yawDeg, 180)
	assert.equal(result.mirrorZ, false)
	assert.doesNotMatch(result.top[0], /pho —/)
})

test("painted water pins the yaw when blocks carry no signal", () => {
	const centeredBlock = [{ pos: [0, 1, 0], scale: [2, 2, 2], hex: "909090" }]
	const saved = BLOCKS.splice(0, BLOCKS.length, ...centeredBlock)
	try {
		const result = estimateYawFromData({
			bytes: splatBytes(bakeYaw(groundWorldCloud(), 90)),
			projRight: PROJ_RIGHT,
			projUp: PROJ_UP,
			yawOffsetDeg: 0,
			blocks: blockInputs(),
			ground: groundInput(),
		})
		assert.equal(result.yawDeg, 90)
		assert.equal(result.mirrorZ, false)
		assert.doesNotMatch(result.top[0], /wat —/) // the water term actually fired
	} finally {
		BLOCKS.splice(0, BLOCKS.length, ...saved)
	}
})
