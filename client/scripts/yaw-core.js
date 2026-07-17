// Pure compute core of the scene yaw/mirror estimator. Runs inside yaw-worker.js so the
// candidate sweep never blocks the UI thread; renderer.js falls back to calling it
// directly if the worker cannot start. No DOM, THREE, or world access — every input is
// plain data prepared by estimateSceneYaw (see renderer.js for how each field is built,
// and for the reasoning comments behind each scoring term).

const YAW_GRID = 32
const FTP_G = 64 // footprint-registration grid resolution — must match renderer.js prep

export function unitChroma(r, g, b) {
	const m = (r + g + b) / 3
	const v = [r - m, g - m, b - m]
	const l = Math.hypot(v[0], v[1], v[2])
	return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l, l] : [0, 0, 0, 0]
}

// input = {
//   bytes: Uint8Array — raw splat file (32-byte stride; stored Y is world-inverted),
//   projRight, projUp: number[3] — capture projection basis,
//   yawOffsetDeg: number — capture yaw offset for the quarter candidates,
//   blocks: { normRects, blockOcc, occupancyTarget|null, anchors, anchorChroma, blockMass },
//   ground: null | {
//     grid: Uint8ClampedArray — 256×256 RGBA of the painted sheet, gridSize, sheetSize,
//     waterCells, waterCenter, target: {tcx,tcz,tSpanX,tSpanZ,fx0,fz0,fw,fh},
//     inkGrid: Uint8Array(FTP_G²), inkCells, anchorClasses: [{dir|null, targets:[[x,z]]}],
//   },
//   photo: null | { grid: number[size²×3], cover: number[size²], size } — the generated
//     image as a content-normalized colour grid (imageColorGrid in renderer.js). The
//     image IS what the splat depicts from the capture camera, so a candidate whose
//     visible-surface colours correlate with it is the true orientation — the one term
//     that separates mirrors on geometrically symmetric scenes.
// }
// Returns null (not enough signal) or { yawDeg, mirrorZ, top, log }.
export function estimateYawFromData(input) {
	const { bytes, projRight, projUp, yawOffsetDeg } = input
	const { normRects, blockMass } = input.blocks
	const anchors = new Map(input.blocks.anchors)
	const anchorChroma = new Map(input.blocks.anchorChroma)
	const occupancyTarget = new Set(input.blocks.occupancyTarget ?? input.blocks.blockOcc)

	// Sample the raw splat (pos f32×3 at +0, rgba u8×4 at +24, 32-byte stride).
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const count = bytes.length >> 5
	const stride = Math.max(1, Math.floor(count / 40000))
	const pts = []
	for (let i = 0; i < count; i += stride) {
		const o = i << 5
		if (view.getUint8(o + 27) < 40) continue // skip near-transparent reconstruction haze
		pts.push([view.getFloat32(o, true), -view.getFloat32(o + 4, true), view.getFloat32(o + 8, true),
			view.getUint8(o + 24), view.getUint8(o + 25), view.getUint8(o + 26)])
	}
	if (pts.length < 100) return null

	// Height gate: points above the low quartile band count as "object material".
	const heights = pts.map(p => p[1]).sort((a, b) => a - b)
	const hq = f => heights[Math.min(heights.length - 1, (f * (heights.length - 1)) | 0)]
	const floorY = hq(0.25)
	const aboveY = floorY + 0.08 * Math.max(1e-6, hq(0.99) - floorY)

	const ground = input.ground
	let mapGeom = null
	let groundGeom = null
	let anchorClumps = null
	let inkGrid = null, inkCells = 0, floorPts = [], footprintUsable = false
	let isWater = null
	let waterCenter = null
	if (ground) {
		// Grid-backed twin of paintedGroundSampler().isWater — same 256×256 pixels, same math.
		const S = ground.gridSize
		const grid = ground.grid
		const half = ground.sheetSize / 2
		isWater = (wx, wz) => {
			const i = Math.floor(((wx + half) / ground.sheetSize) * S)
			const j = Math.floor(((wz + half) / ground.sheetSize) * S)
			if (i < 0 || i >= S || j < 0 || j >= S) return null
			const o = (j * S + i) * 4
			if (grid[o + 3] <= 32) return null
			return grid[o + 2] > grid[o] + 20 && grid[o + 2] >= grid[o + 1]
		}
		waterCenter = ground.waterCenter
		const xs = pts.map(p => p[0]).sort((a, b) => a - b)
		const zs = pts.map(p => p[2]).sort((a, b) => a - b)
		const gq = (arr, f) => arr[Math.min(arr.length - 1, (f * (arr.length - 1)) | 0)]
		const x0 = gq(xs, 0.003), x1 = gq(xs, 0.997), z0 = gq(zs, 0.003), z1 = gq(zs, 0.997)
		mapGeom = {
			cx: (x0 + x1) / 2, cz: (z0 + z1) / 2,
			spanX: Math.max(1e-6, x1 - x0), spanZ: Math.max(1e-6, z1 - z0),
			...ground.target,
		}
		inkGrid = ground.inkGrid
		inkCells = ground.inkCells
		{
			const all = pts.filter(([, y]) => y <= aboveY)
			const step = Math.max(1, Math.floor(all.length / 4000))
			for (let i = 0; i < all.length; i += step) floorPts.push(all[i])
		}
		footprintUsable = inkCells >= 80 && floorPts.length >= 500
		const coolPts = pts.filter(([, y, , r, g, b]) => y <= aboveY && r + g + b > 90 && b > r + 8 && g >= r)
		if (coolPts.length >= 150 && ground.waterCells >= 100) {
			let mx = 0, mz2 = 0
			for (const [x, , z] of coolPts) { mx += x; mz2 += z }
			groundGeom = { coolPts, coolMean: [mx / coolPts.length, mz2 / coolPts.length] }
		}
		// Colour-anchor clumps: claim distinctive above-floor splat colour masses per class.
		const classes = ground.anchorClasses.map(k => ({ dir: k.dir, targets: k.targets, pts: [] }))
		for (const [x, y, z, r, g, b] of pts) {
			if (y <= aboveY || r + g + b < 105) continue // floor material and shadows carry no anchor evidence
			const pc = unitChroma(r, g, b)
			for (const k of classes) {
				if (k.dir == null
					? pc[3] < 18 && (r + g + b) / 3 > 80 && (r + g + b) / 3 < 215 // neutral: mid-bright grey
					: pc[3] >= 12 && pc[0] * k.dir[0] + pc[1] * k.dir[1] + pc[2] * k.dir[2] > 0.8) { k.pts.push([x, z]); break }
			}
		}
		const usable = classes.filter(k => k.pts.length >= 100)
		for (const k of usable) {
			// Component-wise median: robust against a minority of stray same-hue points.
			const xs2 = k.pts.map(p => p[0]).sort((a, b) => a - b)
			const zs2 = k.pts.map(p => p[1]).sort((a, b) => a - b)
			k.median = [xs2[xs2.length >> 1], zs2[zs2.length >> 1]]
			k.weight = Math.min(1, k.pts.length / 600)
		}
		if (usable.length) anchorClumps = usable
	}

	// Photo term prep: toward-camera axis for visible-surface selection. The capture
	// basis is right-handed (right = ŷ×eye, up = eye×right), so right×up = eye.
	const photo = input.photo
	const eye = [
		projRight[1] * projUp[2] - projRight[2] * projUp[1],
		projRight[2] * projUp[0] - projRight[0] * projUp[2],
		projRight[0] * projUp[1] - projRight[1] * projUp[0],
	]

	const baseCandidates = [0, 90, 180, 270]
	const offset = yawOffsetDeg
	// With ground evidence, sweep finely; without it, only the quarter candidates are decidable.
	const yawCandidates = [...new Set([
		...baseCandidates,
		...baseCandidates.map(yaw => yaw + offset),
		...baseCandidates.map(yaw => yaw - offset),
		...(groundGeom || anchorClumps ? Array.from({ length: 72 }, (_, i) => i * 5) : []),
	].map(yaw => Math.round((((yaw % 360) + 360) % 360) * 1000) / 1000))]
	// Handedness is only decidable with ground, anchor, or photo evidence; a mirrored
	// candidate must beat the best regular one by a real margin before we accept the flip.
	const mirrorCandidates = groundGeom || anchorClumps || photo ? [false, true] : [false]
	let bestYaw = null, bestMirror = false, bestScore = -Infinity
	const candidatesOut = []
	for (const mirror of mirrorCandidates) {
	for (const yaw of yawCandidates) {
		const th = (yaw * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th)
		const mz = mirror ? -1 : 1
		const uv = []
		for (const [x, y, z, r, g, b] of pts) {
			const wx = x * co + mz * z * si, wz = -x * si + mz * z * co
			uv.push([
				wx * projRight[0] + y * projRight[1] + wz * projRight[2],
				wx * projUp[0] + y * projUp[1] + wz * projUp[2],
				r, g, b, y,
				wx * eye[0] + y * eye[1] + wz * eye[2], // toward-camera depth for the photo term
			])
		}
		const us = uv.map(p => p[0]).sort((a, b) => a - b)
		const vs = uv.map(p => p[1]).sort((a, b) => a - b)
		const q = (arr, f) => arr[Math.min(arr.length - 1, (f * (arr.length - 1)) | 0)]
		const u0 = q(us, 0.003), u1 = q(us, 0.997), v0 = q(vs, 0.003), v1 = q(vs, 0.997)
		const splatOcc = new Set()
		const colorSums = new Map([...anchors.keys()].map(key => [key, [0, 0, 0]]))
		const rectCounts = new Array(normRects.length).fill(0)
		const RECT_PAD = 0.03
		// Photo term pass 1 collection: cell + depth + colour per in-frame point.
		const PG = photo?.size ?? 0
		const photoPts = photo ? [] : null
		let dMin = Infinity, dMax = -Infinity
		let n = 0
		for (const [u, v, r, g, b, wy, d] of uv) {
			const x = (u - u0) / Math.max(1e-9, u1 - u0)
			const y = (v - v0) / Math.max(1e-9, v1 - v0)
			if (x < 0 || x > 1 || y < 0 || y > 1) continue
			n++
			splatOcc.add(Math.min(YAW_GRID - 1, x * YAW_GRID | 0) * YAW_GRID + Math.min(YAW_GRID - 1, y * YAW_GRID | 0))
			if (photo) {
				const cell = Math.min(PG - 1, x * PG | 0) * PG + Math.min(PG - 1, y * PG | 0)
				photoPts.push(cell, d, r, g, b)
				if (d < dMin) dMin = d
				if (d > dMax) dMax = d
			}
			if (wy > aboveY) {
				for (let ri = 0; ri < normRects.length; ri++) {
					const [ru0, ru1, rv0, rv1] = normRects[ri]
					if (x >= ru0 - RECT_PAD && x <= ru1 + RECT_PAD && y >= rv0 - RECT_PAD && y <= rv1 + RECT_PAD) rectCounts[ri]++
				}
			}
			const cu = unitChroma(r, g, b)
			let bestKey = null, bestDot = 0.6 // require a decent chroma match to claim a point
			for (const [key, bc] of anchorChroma) {
				if (bc[3] < 10) {
					// A neutral anchor (grey rock, white stone) claims points that are also
					// neutral and of similar brightness instead of being discarded.
					if (cu[3] < 28 && bestKey == null) { // low-chroma, not strictly neutral: painted grey is blue-grey
						const anchorMean = (parseInt(key.slice(0, 2), 16) + parseInt(key.slice(2, 4), 16) + parseInt(key.slice(4, 6), 16)) / 3
						if (Math.abs((r + g + b) / 3 - anchorMean) < 60) bestKey = key
					}
					continue
				}
				if (cu[3] < 10) continue // grey/shadow points carry no direction for chromatic anchors
				const dot = cu[0] * bc[0] + cu[1] * bc[1] + cu[2] * bc[2]
				if (dot > bestDot) { bestDot = dot; bestKey = key }
			}
			if (bestKey) {
				const s = colorSums.get(bestKey)
				s[0] += x; s[1] += y; s[2]++
			}
		}
		// Photo term (render-and-compare): visible-surface colours vs the generated
		// image. Pass 1 finds each cell's nearest-to-camera depth; pass 2 averages
		// colours within a thin shell behind it — the surface the capture camera
		// actually saw; then a per-channel, mean-centred correlation against the
		// photo grid over cells both sides cover. Wrong quarters — and especially
		// mirrors, which geometry terms can't separate on symmetric scenes —
		// decorrelate hard because the image is the ground truth of the scene.
		let photoNcc = null
		if (photo && photoPts.length >= 500 * 5) {
			const shell = 0.08 * Math.max(1e-6, dMax - dMin)
			const near = new Float32Array(PG * PG).fill(-Infinity)
			for (let i = 0; i < photoPts.length; i += 5) {
				const cell = photoPts[i], d = photoPts[i + 1]
				if (d > near[cell]) near[cell] = d
			}
			const sums = new Float32Array(PG * PG * 3)
			const counts = new Uint32Array(PG * PG)
			for (let i = 0; i < photoPts.length; i += 5) {
				const cell = photoPts[i], d = photoPts[i + 1]
				if (d < near[cell] - shell) continue
				counts[cell]++
				sums[cell * 3] += photoPts[i + 2]
				sums[cell * 3 + 1] += photoPts[i + 3]
				sums[cell * 3 + 2] += photoPts[i + 4]
			}
			const shared = []
			for (let c = 0; c < PG * PG; c++) if (counts[c] && photo.cover[c]) shared.push(c)
			if (shared.length >= 30) {
				let ncc = 0
				for (let ch = 0; ch < 3; ch++) {
					let ma = 0, mb = 0
					for (const c of shared) { ma += sums[c * 3 + ch] / counts[c]; mb += photo.grid[c * 3 + ch] }
					ma /= shared.length; mb /= shared.length
					let ab = 0, aa = 0, bb = 0
					for (const c of shared) {
						const a = sums[c * 3 + ch] / counts[c] - ma
						const b = photo.grid[c * 3 + ch] - mb
						ab += a * b; aa += a * a; bb += b * b
					}
					ncc += aa > 1e-6 && bb > 1e-6 ? ab / Math.sqrt(aa * bb) : 0
				}
				photoNcc = ncc / 3
			}
		}
		// Water correlation: sharp peak at the true (yaw, mirror); collapses at wrong ones.
		let groundHit = 0, groundTot = 0
		let anchorWorldTerm = null
		let waterProx = null
		let footprintIoU = null
		if (mapGeom) {
			const swap = Math.abs(Math.round(yaw / 90)) % 2
			const gs = 0.5 * ((swap ? mapGeom.tSpanZ : mapGeom.tSpanX) / mapGeom.spanX
				+ (swap ? mapGeom.tSpanX : mapGeom.tSpanZ) / mapGeom.spanZ)
			const toWorld = (x, z) => {
				const dx = gs * (x - mapGeom.cx), dz = mz * gs * (z - mapGeom.cz)
				return [mapGeom.tcx + dx * co + dz * si, mapGeom.tcz - dx * si + dz * co]
			}
			if (groundGeom) {
				for (const [x, , z] of groundGeom.coolPts) {
					const [wx, wz] = toWorld(x, z)
					const water = isWater(wx, wz)
					if (water == null) continue
					groundTot++
					if (water) groundHit++
				}
			}
			// Small ponds drift past their own radius; centroid proximity degrades smoothly
			// instead of cliffing to zero.
			if (groundGeom && waterCenter) {
				const [wx, wz] = toWorld(groundGeom.coolMean[0], groundGeom.coolMean[1])
				const d = Math.hypot(wx - waterCenter[0], wz - waterCenter[1])
				waterProx = Math.max(0, 1 - d / (0.3 * Math.max(mapGeom.tSpanX, mapGeom.tSpanZ)))
			}
			if (footprintUsable) {
				const occ = new Uint8Array(FTP_G * FTP_G)
				for (const [x, , z] of floorPts) {
					const [wx, wz] = toWorld(x, z)
					const gx = Math.floor((wx - mapGeom.fx0) / mapGeom.fw * FTP_G)
					const gz = Math.floor((wz - mapGeom.fz0) / mapGeom.fh * FTP_G)
					if (gx >= 0 && gx < FTP_G && gz >= 0 && gz < FTP_G) occ[gz * FTP_G + gx] = 1
				}
				let inter = 0, occCells = 0
				for (let c = 0; c < FTP_G * FTP_G; c++) {
					if (occ[c]) { occCells++; if (inkGrid[c]) inter++ }
				}
				footprintIoU = inter / Math.max(1, inkCells + occCells - inter)
			}
			if (anchorClumps) {
				const reach = 0.4 * Math.max(mapGeom.tSpanX, mapGeom.tSpanZ)
				let sum = 0, wsum = 0
				for (const k of anchorClumps) {
					const [wx, wz] = toWorld(k.median[0], k.median[1])
					let best = Infinity
					for (const [tx, tz] of k.targets) best = Math.min(best, Math.hypot(wx - tx, wz - tz))
					sum += k.weight * Math.max(0, 1 - best / reach)
					wsum += k.weight
				}
				if (wsum > 0) anchorWorldTerm = sum / wsum
			}
		}
		let inter = 0
		for (const cell of splatOcc) if (occupancyTarget.has(cell)) inter++
		const iou = inter / Math.max(1, occupancyTarget.size + splatOcc.size - inter)
		let anchorTerm = 0, anchorWeight = 0
		for (const [key, a] of anchors) {
			const s = colorSums.get(key)
			const share = a[2] / blockMass
			if (!s[2] || share > 0.6) continue // the dominant colour is everywhere — no signal
			const w = Math.min(share, s[2] / Math.max(1, n))
			const d = Math.hypot(s[0] / s[2] - a[0] / a[2], s[1] / s[2] - a[1] / a[2])
			anchorTerm += w * (1 - Math.min(1, d * 1.5))
			anchorWeight += w
		}
		// Block coverage dominates: a quarter-turn that leaves any expected block's
		// projected rect without above-floor material cannot be the true orientation.
		const rectMin = Math.max(12, n * 0.0008)
		const covered = rectCounts.filter(count => count >= rectMin).length
		// The water term outweighs block coverage when there is enough painted-water evidence.
		const overlapFrac = groundTot >= 100 ? groundHit / groundTot : null
		const groundFrac = overlapFrac == null && waterProx == null ? null : Math.max(overlapFrac ?? 0, 0.8 * (waterProx ?? 0))
		const groundTermScore = groundFrac == null ? 0 : 2.5 * normRects.length * groundFrac
		const anchorTermScore = anchorWorldTerm == null ? 0 : 1.5 * normRects.length * anchorWorldTerm
		// The photo term is an absolute correlation (same target for every candidate),
		// so it weighs in directly — no cross-sweep normalization needed.
		const photoTermScore = photoNcc == null ? 0 : 3 * normRects.length * Math.max(0, photoNcc)
		// A mirrored seating is exotic; demand a decisive margin before accepting it.
		const baseScore = covered * 4 + iou + (anchorWeight ? 2 * (anchorTerm / anchorWeight) : 0) + groundTermScore + anchorTermScore + photoTermScore - (mirror ? 0.06 * normRects.length : 0)
		candidatesOut.push({ yaw, mirror, baseScore, ftp: footprintIoU, dbg: `${mirror ? "M" : ""}${yaw}°(blk ${covered}/${normRects.length} iou ${iou.toFixed(2)} col ${anchorWeight ? (anchorTerm / anchorWeight).toFixed(2) : "—"} wat ${groundFrac == null ? "—" : groundFrac.toFixed(2)} anc ${anchorWorldTerm == null ? "—" : anchorWorldTerm.toFixed(2)} ftp ${footprintIoU == null ? "—" : footprintIoU.toFixed(2)} pho ${photoNcc == null ? "—" : photoNcc.toFixed(2)})` })
	}
	}
	// Footprint IoU carries the drawn ground's outline, but its ABSOLUTE spread is small,
	// so min-max normalize it across the sweep before weighting.
	const ftpVals = candidatesOut.filter(c => c.ftp != null).map(c => c.ftp)
	const ftpMin = Math.min(...ftpVals), ftpMax = Math.max(...ftpVals)
	for (const c of candidatesOut) {
		const ftpNorm = c.ftp != null && ftpMax > ftpMin ? (c.ftp - ftpMin) / (ftpMax - ftpMin) : 0
		c.score = c.baseScore + 1.5 * normRects.length * ftpNorm
		if (c.score > bestScore) { bestScore = c.score; bestYaw = c.yaw; bestMirror = c.mirror }
	}
	const top = [...candidatesOut].sort((a, b) => b.score - a.score).slice(0, 8).map(c => `${c.score.toFixed(1)}:${c.dbg}`)
	return {
		yawDeg: bestYaw,
		mirrorZ: bestMirror,
		top,
		log: `[fit] scene yaw estimate → ${bestMirror ? "MIRROR+" : ""}${bestYaw}° over ${candidatesOut.length} candidates (top: ${top.join(" ")})`,
	}
}
