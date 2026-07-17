// Bake the reveal band's block-out from the arena splat:
//   node scripts/generate-reveal-blockout.mjs client/assets/reveal-splat.ply client/assets/reveal-blockout.json
// The band constructs these blocks one by one (the hero mech's build-up), then
// flashes them white and dissolves into the real splat.
//
// PURPOSEFUL blocks, not voxels: like a hand-built editor block-out, every box
// stands for something you can point at in the render — the stone base, the
// plaza deck, a run of perimeter wall, a blue dome, a fountain, a hedge. The
// scene is read in three passes:
//   1. classify every confident gaussian by palette role (stone / blue / green),
//   2. find the plaza deck level from the stone points' vertical density mode,
//   3. emit: one base slab + one deck slab, coarse-grid wall segments from the
//      above-deck stone mass (each with its own local height), and clustered
//      boxes for the blue (domes, fountains) and green (foliage) accents.
// Colors are a curated palette — white stone, gold trim, dome blue, foliage
// green — never muddy per-gaussian means; the splat's own colors carry baked
// lighting and read as brown sludge on matte boxes.
//
// reveal-splat.ply is pre-normalized (bake-reveal-splat.mjs). The page shows
// the splat through rotation.x = π (raw (x,y,z) → display (x,−y,−z)), so boxes
// are baked directly in that display frame.
import { readFileSync, writeFileSync } from "node:fs"

const [src = "client/assets/reveal-splat.ply", dst = "client/assets/reveal-blockout.json"] = process.argv.slice(2)
const SH_C0 = 0.28209479177387814
const sig = v => 1 / (1 + Math.exp(-v))

// The arena's paint job, matched to the render: warm white stone, its shaded
// base, gold trim, the domes' steel blue, water blue, hedge green.
const STONE = "#e3d9c6"
const STONE_DIM = "#a89f8d"
const GOLD = "#c9a25e"
const BLUE = "#7da4bd"
const GREEN = "#5c7350"

// ---- decode into the display frame --------------------------------------------
const buf = readFileSync(src)
const headerEnd = buf.indexOf("end_header\n") + "end_header\n".length
const header = buf.toString("ascii", 0, headerEnd)
const total = Number(header.match(/element vertex (\d+)/)[1])
const props = [...header.matchAll(/property float (\w+)/g)].map(m => m[1])
const stride = props.length * 4
const at = Object.fromEntries(props.map((p, i) => [p, i * 4]))

const pts = []
for (let i = 0; i < total; i++) {
	const o = headerEnd + i * stride
	const f = n => buf.readFloatLE(o + at[n])
	const x = f("x"), y = -f("y"), z = -f("z") // raw → display
	if (![x, y, z].every(Number.isFinite)) continue
	if (sig(f("opacity")) < 0.3) continue
	const c = ["f_dc_0", "f_dc_1", "f_dc_2"].map(p => Math.max(0, Math.min(255, (0.5 + SH_C0 * f(p)) * 255)))
	pts.push({ x, y, z, r: c[0], g: c[1], b: c[2] })
}

// palette role per point: blue accents (domes, water, doorways), foliage green,
// everything else is stone
for (const p of pts) {
	if (p.b > p.r + 14 && p.b > p.g + 6) p.role = "blue"
	else if (p.g > p.r + 4 && p.g > p.b + 8) p.role = "green"
	else p.role = "stone"
}
const stone = pts.filter(p => p.role === "stone")

// ---- levels --------------------------------------------------------------------
const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
const axis = (arr, get) => arr.map(get).sort((a, b) => a - b)
const ys = axis(stone, p => p.y)
const yMin = pct(ys, 0.004), yMax = pct(ys, 0.996)
// The plaza deck is the arena's biggest horizontal surface: the strongest bin
// of the stone points' vertical histogram.
const BINS = 60
const hist = new Array(BINS).fill(0)
for (const y of ys) {
	const b = Math.floor(((y - yMin) / (yMax - yMin)) * BINS)
	if (b >= 0 && b < BINS) hist[b]++
}
const deckBin = hist.indexOf(Math.max(...hist))
const yDeck = yMin + ((deckBin + 0.5) / BINS) * (yMax - yMin)

const xs = axis(stone, p => p.x), zs = axis(stone, p => p.z)
const x0 = pct(xs, 0.01), x1 = pct(xs, 0.99)
const z0 = pct(zs, 0.01), z1 = pct(zs, 0.99)

const primitives = []
const round = v => Math.round(v * 1e4) / 1e4
const box = (name, color, lo, hi) => primitives.push({
	name,
	type: "box",
	position: [round((lo[0] + hi[0]) / 2), round((lo[1] + hi[1]) / 2), round((lo[2] + hi[2]) / 2)],
	rotation: [0, 0, 0],
	scale: [round(Math.max(0.03, hi[0] - lo[0])), round(Math.max(0.03, hi[1] - lo[1])), round(Math.max(0.03, hi[2] - lo[2]))],
	color,
})

// ---- the two big reads: base + deck --------------------------------------------
box("base", STONE_DIM, [x0, yMin, z0], [x1, yDeck - 0.01, z1])
box("plaza", STONE, [x0 + 0.02, yDeck - 0.01, z0 + 0.02], [x1 - 0.02, yDeck + 0.03, z1 - 0.02])

// ---- perimeter walls: coarse xz grid over the above-deck stone mass ------------
// Each occupied macro-cell becomes one wall piece with its own local height —
// low balustrades stay low, the rotunda and the arch colonnade rise tall.
const GRID = 9
const cw = (x1 - x0) / GRID, cd = (z1 - z0) / GRID
const wallCells = new Map()
for (const p of stone) {
	if (p.y < yDeck + 0.045) continue
	const ix = Math.min(GRID - 1, Math.max(0, Math.floor((p.x - x0) / cw)))
	const iz = Math.min(GRID - 1, Math.max(0, Math.floor((p.z - z0) / cd)))
	const k = ix * GRID + iz
	let c = wallCells.get(k)
	if (!c) wallCells.set(k, c = { ix, iz, pts: [] })
	c.pts.push(p)
}
const wallMin = pts.length * 0.0012 // low enough that the right rim's balustrade still reads
for (const c of [...wallCells.values()].filter(c => c.pts.length >= wallMin)) {
	const cx = axis(c.pts, p => p.x), cz = axis(c.pts, p => p.z), cy = axis(c.pts, p => p.y)
	const top = pct(cy, 0.93)
	const lum = c.pts.reduce((s, p) => s + 0.299 * p.r + 0.587 * p.g + 0.114 * p.b, 0) / c.pts.length
	box(`wall-${c.ix}-${c.iz}`, lum > 96 ? STONE : STONE_DIM,
		[pct(cx, 0.06), yDeck, pct(cz, 0.06)],
		[pct(cx, 0.94), Math.max(top, yDeck + 0.07), pct(cz, 0.94)])
}

// ---- accent clusters: blue (domes, fountains) and green (foliage) --------------
function clusters(sel, cell, minPts) {
	const grid = new Map()
	const key = (a, b, c) => `${a},${b},${c}`
	for (const p of sel) {
		const k = key(Math.floor(p.x / cell), Math.floor(p.y / cell), Math.floor(p.z / cell))
		;(grid.get(k) ?? grid.set(k, []).get(k)).push(p)
	}
	const seen = new Set()
	const out = []
	for (const start of grid.keys()) {
		if (seen.has(start)) continue
		const comp = []
		const queue = [start]
		seen.add(start)
		while (queue.length) {
			const k = queue.pop()
			comp.push(...grid.get(k))
			const [a, b, c] = k.split(",").map(Number)
			for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (let dc = -1; dc <= 1; dc++) {
				const nk = key(a + da, b + db, c + dc)
				if (!seen.has(nk) && grid.has(nk)) { seen.add(nk); queue.push(nk) }
			}
		}
		if (comp.length >= minPts) out.push(comp)
	}
	return out.sort((a, b) => b.length - a.length)
}

const blue = clusters(pts.filter(p => p.role === "blue" && p.y > yDeck - 0.05), 0.055, 60).slice(0, 7)
blue.forEach((comp, i) => {
	const cx = axis(comp, p => p.x), cy = axis(comp, p => p.y), cz = axis(comp, p => p.z)
	const lo = [pct(cx, 0.04), pct(cy, 0.04), pct(cz, 0.04)]
	const hi = [pct(cx, 0.96), pct(cy, 0.96), pct(cz, 0.96)]
	// Domes and pools are thin SHELLS of gaussians — a raw fit gives a wafer.
	// Give every blue read a chunky minimum so it lands like a placed block.
	for (const a of [0, 2]) {
		const pad = Math.max(0, 0.1 - (hi[a] - lo[a])) / 2
		lo[a] -= pad; hi[a] += pad
	}
	if (hi[1] - lo[1] < 0.07) lo[1] = hi[1] - 0.07
	box(`blue-${i}`, BLUE, lo, hi)
})
const green = clusters(pts.filter(p => p.role === "green" && p.y > yDeck), 0.05, 90).slice(0, 8)
green.forEach((comp, i) => {
	const cx = axis(comp, p => p.x), cy = axis(comp, p => p.y), cz = axis(comp, p => p.z)
	box(`green-${i}`, GREEN,
		[pct(cx, 0.05), pct(cy, 0.05), pct(cz, 0.05)],
		[pct(cx, 0.95), pct(cy, 0.95), pct(cz, 0.95)])
})

// ---- gold ring: the plaza's inlaid circle, a flat trim slab in the centre ------
box("plaza-ring", GOLD,
	[(x0 + x1) / 2 - 0.16, yDeck + 0.03, (z0 + z1) / 2 - 0.16],
	[(x0 + x1) / 2 + 0.16, yDeck + 0.042, (z0 + z1) / 2 + 0.16])

writeFileSync(dst, JSON.stringify({ version: 1, source: "reveal-splat.ply", primitives }, null, "\t") + "\n")
console.log(`${pts.length} pts (stone ${stone.length}) deck y=${yDeck.toFixed(3)} -> ${primitives.length} blocks -> ${dst}`)
console.log(primitives.map(p => `  ${p.name.padEnd(10)} ${p.color} pos ${p.position.map(v => v.toFixed(2)).join(",").padEnd(18)} size ${p.scale.map(v => v.toFixed(2)).join(",")}`).join("\n"))
