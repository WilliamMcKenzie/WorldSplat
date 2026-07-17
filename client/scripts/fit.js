import * as THREE from "three"

// Seat a freshly reconstructed whole-scene Tripo splat into the block-out bounds. We:
//   1. gently cull the transparent haze + stray floaters Tripo leaves behind,
//   2. measure the robust content AABB (percentile extents, ignoring outliers),
//   3. uniformly fit the content onto the target footprint and seat its bottom on it.
//
// The stored model is upside-down (world-up = decreasing stored-Y), so the Y scale is
// negated (the proven flip) and the scene's BOTTOM is its MAX stored-Y.

const UP = new THREE.Vector3(0, 1, 0)

const IDENTITY_QUAT = new THREE.Quaternion()

function matrix3FromMatrix4(m) {
	const e = m.elements
	return [
		e[0], e[4], e[8],
		e[1], e[5], e[9],
		e[2], e[6], e[10],
	]
}

function covarianceFromSplat(scales, quaternion) {
	const m = new THREE.Matrix4().makeRotationFromQuaternion(quaternion)
	const e = m.elements
	const axes = [
		[e[0], e[1], e[2]],
		[e[4], e[5], e[6]],
		[e[8], e[9], e[10]],
	]
	const s2 = [scales.x * scales.x, scales.y * scales.y, scales.z * scales.z]
	const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0]
	for (let k = 0; k < 3; k++) {
		for (let r = 0; r < 3; r++) {
			for (let c = 0; c < 3; c++) cov[r * 3 + c] += axes[k][r] * axes[k][c] * s2[k]
		}
	}
	return cov
}

function transformCovariance(a, cov) {
	const ac = new Array(9).fill(0)
	const out = new Array(9).fill(0)
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 3; c++) {
			for (let k = 0; k < 3; k++) ac[r * 3 + c] += a[r * 3 + k] * cov[k * 3 + c]
		}
	}
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 3; c++) {
			for (let k = 0; k < 3; k++) out[r * 3 + c] += ac[r * 3 + k] * a[c * 3 + k]
		}
	}
	return out
}

function determinantColumns(x, y, z) {
	return x.x * (y.y * z.z - y.z * z.y) - y.x * (x.y * z.z - x.z * z.y) + z.x * (x.y * y.z - x.z * y.y)
}

function eigensystemSymmetric3(input) {
	const a = input.slice()
	const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]
	const pairs = [[0, 1, 1], [0, 2, 2], [1, 2, 5]]
	for (let iter = 0; iter < 32; iter++) {
		let p = 0, q = 1, idx = 1, best = 0
		for (const pair of pairs) {
			const mag = Math.abs(a[pair[2]])
			if (mag > best) { [p, q, idx] = pair; best = mag }
		}
		if (best < 1e-14) break

		const app = a[p * 3 + p], aqq = a[q * 3 + q], apq = a[idx]
		const angle = 0.5 * Math.atan2(2 * apq, aqq - app)
		const c = Math.cos(angle), s = Math.sin(angle)

		for (let k = 0; k < 3; k++) {
			if (k === p || k === q) continue
			const akp = a[k * 3 + p], akq = a[k * 3 + q]
			const np = c * akp - s * akq
			const nq = s * akp + c * akq
			a[k * 3 + p] = a[p * 3 + k] = np
			a[k * 3 + q] = a[q * 3 + k] = nq
		}
		a[p * 3 + p] = c * c * app - 2 * s * c * apq + s * s * aqq
		a[q * 3 + q] = s * s * app + 2 * s * c * apq + c * c * aqq
		a[p * 3 + q] = a[q * 3 + p] = 0

		for (let k = 0; k < 3; k++) {
			const vkp = v[k * 3 + p], vkq = v[k * 3 + q]
			v[k * 3 + p] = c * vkp - s * vkq
			v[k * 3 + q] = s * vkp + c * vkq
		}
	}

	const axes = [
		{ value: Math.max(0, a[0]), axis: new THREE.Vector3(v[0], v[3], v[6]).normalize() },
		{ value: Math.max(0, a[4]), axis: new THREE.Vector3(v[1], v[4], v[7]).normalize() },
		{ value: Math.max(0, a[8]), axis: new THREE.Vector3(v[2], v[5], v[8]).normalize() },
	].sort((l, r) => r.value - l.value)

	if (determinantColumns(axes[0].axis, axes[1].axis, axes[2].axis) < 0) axes[2].axis.multiplyScalar(-1)

	const matrix = new THREE.Matrix4().makeBasis(axes[0].axis, axes[1].axis, axes[2].axis)
	return {
		scales: new THREE.Vector3(Math.sqrt(axes[0].value), Math.sqrt(axes[1].value), Math.sqrt(axes[2].value)),
		quaternion: new THREE.Quaternion().setFromRotationMatrix(matrix).normalize(),
	}
}

function transformSplatShape(scales, quaternion, linear) {
	return eigensystemSymmetric3(transformCovariance(linear, covarianceFromSplat(scales, quaternion)))
}

function percentile(sorted, q) {
	if (!sorted.length) return 0
	const pos = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
	return sorted[pos]
}

export async function fitSplatToBox(source, box, opts = {}) {
	const opacityFloor = opts.opacityFloor ?? 0.03 // drop only near-transparent haze/wisp gaussians (WS_OPACITY_FLOOR)
	const loQ = opts.spanLo ?? 0 // robust extent percentiles, so a few strays
	const hiQ = opts.spanHi ?? 1 // can't blow up the measured size
	const cullAmount = Math.min(1, Math.max(0, opts.cullAmount ?? 1))
	const cullHeightFraction = Math.min(1, Math.max(0, opts.cullHeightFraction ?? 1))

	const packed = source.packedSplats
	const total = packed?.numSplats ?? 0
	if (!total) return null

	const xs = new Float32Array(total)
	const ys = new Float32Array(total)
	const zs = new Float32Array(total)
	const maxScales = new Float32Array(total)
	const opacities = new Float32Array(total)
	const keep = new Uint8Array(total).fill(1)

	packed.forEachSplat((i, center, scales, quaternion, opacity) => {
		xs[i] = center.x
		ys[i] = center.y
		zs[i] = center.z
		maxScales[i] = Math.max(scales.x, scales.y, scales.z)
		opacities[i] = opacity
		if (opacity < opacityFloor) keep[i] = 0
	})
	const opacityKeep = Uint8Array.from(keep)

	let survivors = 0
	for (let i = 0; i < total; i++) {
		if (!keep[i]) continue
		survivors++
	}
	// Keep fitting robust even when every gaussian is below the opacity threshold. The
	// threshold is a cull candidate detector; the global amount slider owns removal.
	if (!survivors) keep.fill(1)
	const renderKeep = new Uint8Array(total)
	for (let i = 0; i < total; i++) renderKeep[i] = opacityKeep[i] && keep[i] ? 1 : 0

	// Robust content extents from the opacity-filtered gaussians.
	const keptX = []
	const keptY = []
	const keptZ = []
	for (let i = 0; i < total; i++) {
		if (!keep[i]) continue
		keptX.push(xs[i])
		keptY.push(ys[i])
		keptZ.push(zs[i])
	}
	if (!keptX.length) return null
	keptX.sort((a, b) => a - b)
	keptY.sort((a, b) => a - b)
	keptZ.sort((a, b) => a - b)

	const minX = percentile(keptX, loQ)
	const maxX = percentile(keptX, hiQ)
	const minZ = percentile(keptZ, loQ)
	const maxZ = percentile(keptZ, hiQ)
	const topStoredY = percentile(keptY, loQ) // world-up top (min stored-Y)
	const bottomStoredY = percentile(keptY, hiQ) // world-up bottom (max stored-Y)

	const spanX = Math.max(1e-4, maxX - minX)
	const spanZ = Math.max(1e-4, maxZ - minZ)
	const spanY = Math.max(1e-4, bottomStoredY - topStoredY)
	const centerX = (minX + maxX) / 2
	const centerZ = (minZ + maxZ) / 2

	// Wisp cull, applied after generation: the one-shot reconstruction leaves
	// long, translucent streak gaussians ("wisps") hanging around the scene.
	// Real surface gaussians are tiny next to the scene extent, so anything
	// stretching past the strength-mapped fraction of the largest span while
	// still translucent is a wisp. Opaque large gaussians survive — those are
	// legitimate ground/wall sheets. Strength 0 disables; 0.5 is the original
	// fixed 4%-of-span threshold; 1 trims streaks down to 1.5% of the span.
	const wispStrength = Math.min(1, Math.max(0, opts.wispCullStrength ?? 0.5))
	const wispFraction = wispStrength <= 0.5
		? 0.08 + (0.04 - 0.08) * (wispStrength * 2)
		: 0.04 + (0.015 - 0.04) * ((wispStrength - 0.5) * 2)
	const wispScale = wispFraction * Math.max(spanX, spanY, spanZ)
	const wispDrop = new Uint8Array(total)
	if (wispStrength > 0) {
		for (let i = 0; i < total; i++) {
			if (maxScales[i] > wispScale && opacities[i] < 0.6) wispDrop[i] = 1
		}
	}

	// Fit X/Z with one uniform scale so the one-shot scene keeps its reconstructed
	// proportions. Y deliberately shares that scale instead of being forced to the box.
	// Compute yaw quarter-step early: for a 90°/270° yaw the mesh's stored X axis maps to
	// world Z and vice versa, so the per-axis fits must be cross-assigned before scaling.
	const yawDeg = opts.yawDeg ?? 0
	const quarter = Math.abs(Math.round(yawDeg / 90)) % 2

	const xFit = (box.max.x - box.min.x) / spanX
	const zFit = (box.max.z - box.min.z) / spanZ
	// After a 90°/270° yaw: stored-X fills world-Z (needs targetZ/spanX) and stored-Z fills
	// world-X (needs targetX/spanZ).  Swap the effective fits so sx/sz target the right axis.
	const effXFit = quarter ? (box.max.z - box.min.z) / spanX : xFit
	const effZFit = quarter ? (box.max.x - box.min.x) / spanZ : zFit
	const scale = 0.5 * (effXFit + effZFit)
	if (!Number.isFinite(scale) || scale <= 0) return null
	const sx = scale, sy = scale, sz = scale
	const seatStoredY = bottomStoredY

	// Compact survivors to the front of the packed buffer, baking the final fit into each
	// gaussian center and ellipsoid.
	let kept = 0
	const targetCenterX = (box.min.x + box.max.x) / 2
	const targetCenterZ = (box.min.z + box.max.z) / 2
	const posY = box.min.y + sy * seatStoredY
	const yOffset = opts.yOffset ?? 0
	const yaw = yawDeg ? new THREE.Quaternion().setFromAxisAngle(UP, (yawDeg * Math.PI) / 180) : IDENTITY_QUAT
	// Handedness correction: a reconstruction whose horizontal frame is MIRRORED relative
	// to the capture can never be seated by yaw alone — negate Z (before the yaw) to flip
	// it back. The covariance bake below uses the same linear map, so ellipsoids follow.
	const mirrorZ = opts.mirrorZ ? -1 : 1
	const transformMatrix = new THREE.Matrix4().compose(new THREE.Vector3(), yaw, new THREE.Vector3(sx, -sy, sz * mirrorZ))
	const linear = matrix3FromMatrix4(transformMatrix)
	const transformedOffset = new THREE.Vector3()
	// Build robust bottom/top ranges from valid fitted material before deciding whether a
	// cleanup candidate is low or high. Local XZ stacks keep a short rock from inheriting
	// a lighthouse's height elsewhere in the scene.
	const heightCellSize = Math.max(0.25, Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 64)
	const heightKey = (x, z) => `${Math.floor((x - box.min.x) / heightCellSize)},${Math.floor((z - box.min.z) / heightCellSize)}`
	const heightSamples = new Map()
	const allHeightSamples = []
	for (let i = 0; i < total; i++) {
		if (!renderKeep[i]) continue
		transformedOffset
			.set(sx * (xs[i] - centerX), -sy * ys[i], mirrorZ * sz * (zs[i] - centerZ))
			.applyQuaternion(yaw)
		const x = targetCenterX + transformedOffset.x
		const y = posY + yOffset + transformedOffset.y
		const z = targetCenterZ + transformedOffset.z
		allHeightSamples.push(y)
		const key = heightKey(x, z)
		let samples = heightSamples.get(key)
		if (!samples) heightSamples.set(key, samples = [])
		samples.push(y)
	}
	const robustHeightRange = samples => {
		if (!samples?.length) return null
		samples.sort((a, b) => a - b)
		const low = samples[Math.floor((samples.length - 1) * 0.01)]
		const high = samples[Math.ceil((samples.length - 1) * 0.99)]
		return { low, high: Math.max(low, high) }
	}
	const globalHeightRange = robustHeightRange(allHeightSamples) ?? { low: box.min.y + yOffset, high: box.max.y + yOffset }
	const heightRanges = new Map()
	for (const [key, samples] of heightSamples) heightRanges.set(key, robustHeightRange(samples))
	const heightRangeAt = (x, z) => heightRanges.get(heightKey(x, z)) ?? globalHeightRange
	const cullHash = (x, y, z) => {
		const value = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123
		return value - Math.floor(value)
	}
	const mayCullAt = (x, y, z) => {
		if (cullAmount <= 0) return false
		if (cullHeightFraction < 1) {
			const range = heightRangeAt(x, z)
			const height = Math.max(0.05, range.high - range.low)
			const basePad = Math.min(0.1, height * 0.03)
			if (y > range.low + height * cullHeightFraction + basePad) return false
		}
		return cullAmount >= 1 || cullHash(x, y, z) < cullAmount
	}

	packed.forEachSplat((i, center, scales, quaternion, opacity, color) => {
		transformedOffset
			.set(sx * (center.x - centerX), -sy * center.y, mirrorZ * sz * (center.z - centerZ))
			.applyQuaternion(yaw)
		const nextX = targetCenterX + transformedOffset.x
		const nextY = posY + yOffset + transformedOffset.y
		const nextZ = targetCenterZ + transformedOffset.z
		if (wispDrop[i]) return
		const mayCull = mayCullAt(nextX, nextY, nextZ)
		if (!renderKeep[i] && mayCull) return
		center.set(nextX, nextY, nextZ)
		const transformedShape = transformSplatShape(scales, quaternion, linear)
		packed.setSplat(kept, center, transformedShape.scales, transformedShape.quaternion, opacity, color)
		kept++
	})
	if (!kept) return null
	packed.numSplats = kept
	packed.needsUpdate = true

	// Spark 2.x collapses a SplatMesh object's scale to a single averaged value before
	// rendering. With the required Y mirror and non-uniform fits, that average can cancel
	// toward zero (wide houses became dots). The fitted affine is therefore baked above into
	// every gaussian center and covariance, leaving the Spark object transform as identity.
	source.position.set(0, 0, 0)
	source.quaternion.identity()
	source.scale.set(1, 1, 1)
	console.log(`[fit] ${source.name || "?"}  target=(${(box.max.x-box.min.x).toFixed(3)}×${(box.max.y-box.min.y).toFixed(3)}×${(box.max.z-box.min.z).toFixed(3)})  span=(${spanX.toFixed(3)}×${spanY.toFixed(3)}×${spanZ.toFixed(3)})  bakedScale=(${sx.toFixed(3)},${(-sy).toFixed(3)},${sz.toFixed(3)})  keep=${kept}`)

	// The seated content AABB in plot-local space, for the "Bounds" debug overlay. A yaw near
	// 90°/270° swaps the X/Z extents (approximate for off-axis yawDeg — it's a debug box).
	const halfX = (quarter ? sz * spanZ : sx * spanX) / 2
	const halfZ = (quarter ? sx * spanX : sz * spanZ) / 2
	const floorY = box.min.y + yOffset
	source.userData.contentBox = new THREE.Box3(
		new THREE.Vector3(targetCenterX - halfX, floorY, targetCenterZ - halfZ),
		new THREE.Vector3(targetCenterX + halfX, floorY + sy * spanY, targetCenterZ + halfZ),
	)
	return source
}
