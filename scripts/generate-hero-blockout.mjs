// Bake the landing hero's block-out from the hero mech splat:
//   node scripts/generate-hero-blockout.mjs client/assets/hero-splat.ply client/assets/hero-blockout.json
// The landing page constructs these blocks one by one (the editor's Apply-JSON
// reveal), then flashes them white and dissolves into the real splat — so the
// boxes must sit in the SAME seat the splat lands in. hero-splat.js seats the
// splat from percentile bounds in the file's raw frame; this script replicates
// that math and bakes the final display-frame coordinates into the JSON, so a
// fresh hero-splat.ply only needs this script re-run, never a client edit.
//
// SEMANTIC blocks, not voxels: like a hand-built editor block-out, every box
// is a named part (foot, shin, thigh, pelvis, torso, shoulder pod, arm,
// cannon, fist, head, visor…). Each part is a region query over the culled
// point cloud (y-bands as fractions of the mech's height, lateral bounds from
// the detected leg/torso structure) fitted with per-axis percentile bounds.
// Colors are a curated hull-grey/navy/visor-blue palette — the splat's own
// colors carry baked-in yellow lighting, so they are only used to separate
// panel from hull, never sampled directly. Tune with ?hero=overlay (blocks
// ghosted over the splat) and ?hero=hold (blocks only).
import { readFileSync, writeFileSync } from "node:fs"

const [src = "client/assets/hero-splat.ply", dst = "client/assets/hero-blockout.json"] = process.argv.slice(2)
const SH_C0 = 0.28209479177387814
const sig = v => 1 / (1 + Math.exp(-v))

// The mech's paint job (matte editor blocks): warm metal hull, blue-grey
// armor accents, glowing visor blue, gunmetal joints.
const HULL = "#ddc8ad"
const HULL_DIM = "#c9b49a" // hull shade for feet/forearms
const NAVY = "#697177" // panel accents (chest plate, cannon)
const VISOR = "#6fa8e8"
const DARK = "#565d63" // pelvis/fist, a step darker than the accents

// ---- decode + cull, mirroring hero-splat.js exactly --------------------------
const buf = readFileSync(src)
const headerEnd = buf.indexOf("end_header\n") + "end_header\n".length
const header = buf.toString("ascii", 0, headerEnd)
const total = Number(header.match(/element vertex (\d+)/)[1])
const props = [...header.matchAll(/property float (\w+)/g)].map(m => m[1])
const stride = props.length * 4
const at = Object.fromEntries(props.map((p, i) => [p, i * 4]))

const raw = []
for (let i = 0; i < total; i++) {
	const o = headerEnd + i * stride
	const f = n => buf.readFloatLE(o + at[n])
	const p = [f("x"), f("y"), f("z")]
	if (!p.every(Number.isFinite)) continue
	raw.push({
		p,
		o: sig(f("opacity")),
		s: Math.max(Math.exp(f("scale_0")), Math.exp(f("scale_1")), Math.exp(f("scale_2"))),
	})
}
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
const axisSorted = [0, 1, 2].map(a => raw.map(r => r.p[a]).sort((x, y) => x - y))
const lo = axisSorted.map(v => pct(v, 0.005))
const hi = axisSorted.map(v => pct(v, 0.995))
const size = [0, 1, 2].map(a => hi[a] - lo[a])
const scaleCull = 0.05 * Math.max(...size)
const ctr = [0, 1, 2].map(a => (lo[a] + hi[a]) / 2)
const s = 0.8 * 2 / Math.max(...size, 0.001)

// Display frame (the pivot's space): rotX(PI) maps raw (x,y,z) → (x,−y,−z),
// then the seat centres the percentile box and scales it to the 2-unit stage.
// Only confident surface splats vote on part shapes — no haze.
const pts = []
for (const r of raw) {
	if ([0, 1, 2].some(a => r.p[a] < lo[a] - size[a] * 0.2 || r.p[a] > hi[a] + size[a] * 0.2)) continue
	if (r.s > scaleCull || r.o < 0.25) continue
	pts.push([s * (r.p[0] - ctr[0]), s * (ctr[1] - r.p[1]), s * (ctr[2] - r.p[2])])
}

// True soles and crown come from the vertical density profile, not percentile
// tails: the splat carries a baked ground-shadow disk under the feet (and thin
// haze above) — hundreds of real-opacity gaussians that would stretch the
// y-bands and sink every part below its anatomy.
const ysAll = pts.map(p => p[1]).sort((a, b) => a - b)
const yLo = pct(ysAll, 0.002)
const yHi = pct(ysAll, 0.998)
const BINS = 80
const profile = new Array(BINS).fill(0)
for (const y of ysAll) {
	const b = Math.floor(((y - yLo) / (yHi - yLo)) * BINS)
	if (b >= 0 && b < BINS) profile[b]++
}
const ref = pct([...profile].sort((a, b) => a - b), 0.85)
const onset = c => profile[c] >= 0.15 * ref && profile[c + 1] >= 0.15 * ref
let b0 = 0
while (b0 < BINS - 2 && !onset(b0)) b0++
let b1 = BINS - 1
while (b1 > 1 && !onset(b1 - 1)) b1--
const yBase = yLo + (b0 / BINS) * (yHi - yLo)
const yTop = yLo + ((b1 + 1) / BINS) * (yHi - yLo)
const H = yTop - yBase
const yf = f => yBase + f * H // y-band fractions: 0 = soles, 1 = crown
// The shadow points below the soles would still pollute the foot boxes'
// footprint percentiles — drop everything under the detected ground.
const body = pts.filter(p => p[1] > yBase - 0.005)

// ---- structural landmarks ----------------------------------------------------
// Legs split along z: the density valley in the shin band's z histogram.
const shinBand = body.filter(p => p[1] > yf(0.10) && p[1] < yf(0.32))
const zSplit = valley(shinBand.map(p => p[2]))
const legL = extent(shinBand.filter(p => p[2] < zSplit), 2, 0.02, 0.98) // cannon-arm side
const legR = extent(shinBand.filter(p => p[2] > zSplit), 2, 0.02, 0.98)
// Torso occupies the middle; arms hang beyond it on both sides.
const chestBand = body.filter(p => p[1] > yf(0.55) && p[1] < yf(0.78) && p[2] > zSplit - 0.33 && p[2] < zSplit + 0.33)
const torsoZ = extent(chestBand, 2, 0.03, 0.97)

// ---- parts -------------------------------------------------------------------
// Each part: a region filter → percentile box. L = z < zSplit (fist arm,
// screen-right after the pivot yaw), R = z > zSplit (cannon arm). Sizes of
// L/R leg pairs are averaged afterwards — a mech's legs match even when its
// stance doesn't.
const inZ = (a, b) => p => p[2] > a && p[2] < b
const band = (f0, f1) => p => p[1] > yf(f0) && p[1] < yf(f1)
const all = (...fs) => p => fs.every(f => f(p))
const armLz = inZ(-Infinity, torsoZ[0] - 0.01)
const armRz = inZ(torsoZ[1] + 0.01, Infinity)

const parts = []
const add = (name, color, filter, opts = {}) => {
	const box = fit(body.filter(filter), opts)
	if (box) parts.push({ name, color, box })
	else console.warn(`part ${name}: too few points, skipped`)
	return box
}

add("foot-L", HULL_DIM, all(band(0.00, 0.13), inZ(legL[0] - 0.06, zSplit)))
add("foot-R", HULL_DIM, all(band(0.00, 0.13), inZ(zSplit, legR[1] + 0.06)))
add("shin-L", HULL, all(band(0.13, 0.335), inZ(legL[0] - 0.03, zSplit)))
add("shin-R", HULL, all(band(0.13, 0.335), inZ(zSplit, legR[1] + 0.03)))
add("thigh-L", HULL, all(band(0.335, 0.50), inZ(legL[0], legL[1] + 0.04)))
add("thigh-R", HULL, all(band(0.335, 0.50), inZ(legR[0] - 0.04, legR[1])))
add("pelvis", DARK, all(band(0.44, 0.56), inZ(legL[1] - 0.03, legR[0] + 0.03)))
const torso = add("torso", HULL, all(band(0.56, 0.80), inZ(torsoZ[0], torsoZ[1])))
add("shoulder-L", HULL, all(band(0.62, 0.88), armLz))
add("shoulder-R", HULL, all(band(0.62, 0.88), armRz))
add("arm-L", HULL_DIM, all(band(0.44, 0.62), armLz))
add("fist-L", DARK, all(band(0.30, 0.44), armLz))
add("arm-R", HULL_DIM, all(band(0.44, 0.62), armRz))
add("cannon-R", NAVY, all(band(0.28, 0.44), armRz))
const head = add("head", HULL, all(band(0.82, 1.0), inZ(zSplit - 0.28, zSplit + 0.28)), { pLo: 0.06, pHi: 0.94 })

// Legs match: average L/R sizes for each pair, keep the stance (positions).
for (const base of ["foot", "shin", "thigh"]) {
	const pair = parts.filter(p => p.name === `${base}-L` || p.name === `${base}-R`)
	if (pair.length !== 2) continue
	const ext = [0, 1, 2].map(a => (pair[0].box.ext[a] + pair[1].box.ext[a]) / 2)
	for (const part of pair) part.box.ext = ext
}

// ---- weld --------------------------------------------------------------------
// A block-out is a stack, not a constellation: close every joint gap along its
// axis by stretching both boxes toward each other, so faces actually touch
// (percentile fitting always leaves slivers between bands).
const byName = Object.fromEntries(parts.map(p => [p.name, p.box]))
const weld = (na, nb, axis) => {
	const a = byName[na], b = byName[nb]
	if (!a || !b) return
	const [first, second] = a.mid[axis] <= b.mid[axis] ? [a, b] : [b, a]
	const gap = (second.mid[axis] - second.ext[axis] / 2) - (first.mid[axis] + first.ext[axis] / 2)
	if (gap <= 0) return
	first.ext[axis] += gap / 2; first.mid[axis] += gap / 4
	second.ext[axis] += gap / 2; second.mid[axis] -= gap / 4
}
for (const side of ["L", "R"]) {
	weld(`foot-${side}`, `shin-${side}`, 1)
	weld(`shin-${side}`, `thigh-${side}`, 1)
	weld(`thigh-${side}`, "pelvis", 1)
	weld(`shoulder-${side}`, "torso", 2)
	weld(`arm-${side}`, `shoulder-${side}`, 1)
	weld(`arm-${side}`, "torso", 2)
}
weld("pelvis", "torso", 1)
weld("torso", "head", 1)
weld("fist-L", "arm-L", 1)
weld("cannon-R", "arm-R", 1)

// ---- detail slabs ------------------------------------------------------------
// Painted-on panels, derived from their (welded) parent box so they always sit
// flush: the glowing visor and the chest plate live on the front face
// (front = +x — after the pivot yaw, +x is what the camera sees).
if (head) {
	const [hx, hy, hz] = head.mid, [sx, sy, sz] = head.ext
	parts.push({ name: "visor", color: VISOR, box: { mid: [hx + sx / 2, hy + sy * 0.08, hz], ext: [0.035, sy * 0.42, sz * 0.72] } })
}
if (torso) {
	const [tx, ty, tz] = torso.mid, [sx, sy, sz] = torso.ext
	parts.push({ name: "chest-plate", color: NAVY, box: { mid: [tx + sx / 2, ty + sy * 0.16, tz], ext: [0.035, sy * 0.5, sz * 0.55] } })
}

// ---- emit --------------------------------------------------------------------
const round = v => Math.round(v * 1e4) / 1e4
const primitives = parts.map(part => ({
	name: part.name,
	type: "box",
	position: part.box.mid.map(round),
	rotation: [0, 0, 0],
	scale: part.box.ext.map(round),
	color: part.color,
}))
writeFileSync(dst, JSON.stringify({ version: 1, source: "hero-splat.ply", primitives }, null, "\t") + "\n")
console.log(`${primitives.length} parts (zSplit ${zSplit.toFixed(2)}, torso z ${torsoZ.map(v => v.toFixed(2)).join("..")}) -> ${dst}`)
console.log(primitives.map(p => `  ${p.name.padEnd(12)} pos ${p.position.map(v => v.toFixed(2)).join(",").padEnd(18)} size ${p.scale.map(v => v.toFixed(2)).join(",")}`).join("\n"))

// Percentile box over a region's points: robust to stray gaussians without
// starving chunky silhouettes.
function fit(sel, { pLo = 0.04, pHi = 0.96, minPts = 150 } = {}) {
	if (sel.length < minPts) return null
	const mid = [], ext = []
	for (let a = 0; a < 3; a++) {
		const [a0, a1] = extent(sel, a, pLo, pHi)
		mid.push((a0 + a1) / 2)
		ext.push(Math.max(0.05, a1 - a0))
	}
	return { mid, ext }
}

function extent(sel, axis, pLo, pHi) {
	const v = sel.map(p => p[axis]).sort((a, b) => a - b)
	return [pct(v, pLo), pct(v, pHi)]
}

// Lowest-density z in the middle half of the range — the gap between the legs.
function valley(values) {
	const v = [...values].sort((a, b) => a - b)
	const v0 = pct(v, 0.02), v1 = pct(v, 0.98)
	const bins = 40
	const hist = new Array(bins).fill(0)
	for (const x of v) {
		const b = Math.floor(((x - v0) / (v1 - v0)) * bins)
		if (b >= 0 && b < bins) hist[b]++
	}
	let best = bins / 2
	for (let b = bins / 4; b < (3 * bins) / 4; b++) if (hist[b] < hist[best]) best = b
	return v0 + ((best + 0.5) / bins) * (v1 - v0)
}
