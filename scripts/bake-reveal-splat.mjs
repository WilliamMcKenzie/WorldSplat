// Bake the landing page's reveal splat — the real gaussian render the ASCII
// cloud resolves into:
//   node scripts/bake-reveal-splat.mjs "<splat>.ply" client/assets/reveal-splat.ply [count]
// Keeps the top `count` (default 100k) gaussians by opacity×area so the page
// fetches ~5.6MB instead of a 17.8MB PLY with no visible quality loss, culls
// floaters and giant fog blobs (same rules as hero-splat.js), and rewrites
// positions/scales pre-normalized into a unit frame, so the block-out baked
// from this output (generate-reveal-blockout.mjs) and the splat share one
// frame with zero runtime measuring. Output stays in the stored (raw) frame
// — the page applies the usual rotation.x = π — and drops the unused normals
// (56 bytes/gaussian instead of 68).
import { readFileSync, writeFileSync } from "node:fs"

const [src, dst, countArg] = process.argv.slice(2)
const KEEP = Number(countArg) || 100000
const sig = v => 1 / (1 + Math.exp(-v))

const buf = readFileSync(src)
const headerEnd = buf.indexOf("end_header\n") + "end_header\n".length
const header = buf.toString("ascii", 0, headerEnd)
const total = Number(header.match(/element vertex (\d+)/)[1])
const props = [...header.matchAll(/property float (\w+)/g)].map(m => m[1])
const stride = props.length * 4
const at = Object.fromEntries(props.map((p, i) => [p, i * 4]))

// Trim pass: finite + opacity ≥ 0.05 → 0.5/99.5 percentile bounds → centre
// and unit radius over the in-bounds set. Raw frame throughout — the y/z flip
// is a sign change, so symmetric percentiles land on the same gaussians.
const idx = [], pos = [], w = [], maxS = []
for (let i = 0; i < total; i++) {
	const o = headerEnd + i * stride
	const f = n => buf.readFloatLE(o + at[n])
	const x = f("x"), y = f("y"), z = f("z")
	if (![x, y, z].every(Number.isFinite)) continue
	const op = sig(f("opacity"))
	if (op < 0.05) continue
	const s = [Math.exp(f("scale_0")), Math.exp(f("scale_1")), Math.exp(f("scale_2"))]
	idx.push(i)
	pos.push([x, y, z])
	w.push(op * (s[0] * s[1] + s[1] * s[2] + s[2] * s[0]))
	maxS.push(Math.max(...s))
}
const bnd = a => {
	const v = pos.map(p => p[a]).sort((x, y) => x - y)
	return [v[Math.floor(0.005 * v.length)], v[Math.min(v.length - 1, Math.floor(0.995 * v.length))]]
}
const bb = [bnd(0), bnd(1), bnd(2)]
const ctr = bb.map(([lo, hi]) => (lo + hi) / 2)
const size = Math.max(...bb.map(([lo, hi]) => hi - lo))
const inBounds = j => [0, 1, 2].every(a => pos[j][a] >= bb[a][0] && pos[j][a] <= bb[a][1])
let maxR = 1e-6
for (let j = 0; j < pos.length; j++) {
	if (!inBounds(j)) continue
	maxR = Math.max(maxR, Math.hypot(pos[j][0] - ctr[0], pos[j][1] - ctr[1], pos[j][2] - ctr[2]))
}

// display set: in bounds, no fog blobs (> 5% of the subject — hero-splat.js's
// veil rule), then the most visible KEEP gaussians
const picked = []
for (let j = 0; j < pos.length; j++) if (inBounds(j) && maxS[j] <= 0.05 * size) picked.push(j)
picked.sort((a, b) => w[b] - w[a])
const kept = picked.slice(0, KEEP)

const OUT = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
const outHeader = Buffer.from(
	`ply\nformat binary_little_endian 1.0\nelement vertex ${kept.length}\n` +
	OUT.map(p => `property float ${p}\n`).join("") + "end_header\n",
)
const out = Buffer.alloc(outHeader.length + kept.length * OUT.length * 4)
outHeader.copy(out, 0)
const logMaxR = Math.log(maxR)
let off = outHeader.length
for (const j of kept) {
	const o = headerEnd + idx[j] * stride
	const f = n => buf.readFloatLE(o + at[n])
	for (let a = 0; a < 3; a++) { out.writeFloatLE((pos[j][a] - ctr[a]) / maxR, off); off += 4 }
	for (const p of ["f_dc_0", "f_dc_1", "f_dc_2", "opacity"]) { out.writeFloatLE(f(p), off); off += 4 }
	for (const p of ["scale_0", "scale_1", "scale_2"]) { out.writeFloatLE(f(p) - logMaxR, off); off += 4 }
	for (const p of ["rot_0", "rot_1", "rot_2", "rot_3"]) { out.writeFloatLE(f(p), off); off += 4 }
}
writeFileSync(dst, out)
console.log(`baked ${kept.length} of ${total} gaussians (${picked.length} after trim), ${(out.length / 1048576).toFixed(1)}MB -> ${dst}`)
