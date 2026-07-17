import * as THREE from "three"

// The walkable ground, baked once from the generated splats into a complete
// heightfield: every cell inside the play bounds has exactly one height, no holes,
// no runtime fallbacks. Physics reads heightAt(); the Colliders debug view can draw
// the lattice so "what physics stands on" is visible against the rendered scene.
//
// Bake stages:
//   1. Bin ground-piece gaussians (genKind "floor"/"remainder") into CELL-sized XZ
//      cells; per cell, march a top-down ray: the surface is the gaussian top
//      (center + K·σ_vertical) at which accumulated opacity reaches TAU.
//   2. Trust: translucent cells (never reached TAU) are kept only where no solid
//      cell exists nearby — lone interior gaussians otherwise read as floor pockets
//      deep inside terrain.
//   3. Flood-fill every remaining cell of the play rect from its nearest kept cell,
//      so the field is total. Scenes with no ground piece at all bake flat.
//   4. Object augmentation: cells with no ground data but a solid object surface
//      near the filled level (decks, patios, the turf ring the segmentation claims
//      into object bases) take the object height — canopies far above stay ignored.

const OPACITY_FLOOR = 0.15 // below this a gaussian is invisible haze
const K = 0.8 // rendered skin extends ~0.8σ above a gaussian's center
const TAU = 0.85 // top-down opacity accumulation that counts as "surface"
const MIN_TOTAL = 0.3 // cells thinner than this hold no surface at all
const TRUST_R = 5 // translucent cells die within this many cells of a solid one
const AUGMENT_BAND = 3 // object surfaces join the ground only within this of the filled level

function estimateCells(meshes, cell) {
	const cells = new Map()
	const v = new THREE.Vector3()
	for (const mesh of meshes) {
		mesh.updateWorldMatrix(true, false)
		mesh.packedSplats.forEachSplat((_i, center, scales, quaternion, opacity) => {
			if (opacity < OPACITY_FLOOR) return
			v.copy(center).applyMatrix4(mesh.matrixWorld)
			if (!Number.isFinite(v.x + v.y + v.z)) return
			// World-vertical sigma: scales are LOCAL-axis sigmas (can be negative) —
			// project through the splat rotation; hypot absorbs the signs.
			const { x: qx, y: qy, z: qz, w: qw } = quaternion
			const sv = Math.hypot(
				2 * (qx * qy + qz * qw) * scales.x,
				(1 - 2 * (qx * qx + qz * qz)) * scales.y,
				2 * (qy * qz - qx * qw) * scales.z,
			)
			if (!Number.isFinite(sv)) return
			const key = `${Math.floor(v.x / cell)},${Math.floor(v.z / cell)}`
			let samples = cells.get(key)
			if (!samples) cells.set(key, (samples = []))
			samples.push({ top: v.y + K * sv, w: opacity })
		})
	}
	const out = new Map() // key -> { y, solid }
	for (const [key, samples] of cells) {
		let total = 0
		for (const s of samples) total += s.w
		if (total < MIN_TOTAL) continue
		samples.sort((a, b) => b.top - a.top) // march the ray from the sky down
		let acc = 0
		let y = samples[0].top // translucent cell → its topmost skin, never under it
		for (const s of samples) {
			acc += s.w
			if (acc >= TAU) {
				y = s.top
				break
			}
		}
		out.set(key, { y, solid: acc >= TAU })
	}
	return out
}

export function bakeGroundField({ pieces, cell, bounds, flatY }) {
	let groundMeshes = []
	let objectMeshes = []
	for (const { mesh } of pieces) {
		if (!mesh.packedSplats) continue
		const kind = mesh.userData.genKind
		if (kind === "floor" || kind === "remainder") groundMeshes.push(mesh)
		else if (kind === "object") objectMeshes.push(mesh)
		// "scene" monoliths (collapse-guard fallback) are unsegmented — bake flat.
	}
	if (!groundMeshes.length && objectMeshes.length) {
		// No ground bucket at all (everything segmented as objects): the objects ARE the
		// ground — bake the walk surface from them directly. Steep sides still block
		// movement via the step limit, so walls/roofs stay unclimbable from below.
		groundMeshes = objectMeshes
		objectMeshes = []
	}

	// Stage 1+2: estimate ground cells, then drop untrusted translucent ones.
	const raw = estimateCells(groundMeshes, cell)
	const kept = new Map()
	for (const [key, c] of raw) {
		if (!c.solid) {
			const [ix, iz] = key.split(",").map(Number)
			let nearSolid = false
			for (let dz = -TRUST_R; dz <= TRUST_R && !nearSolid; dz++) {
				for (let dx = -TRUST_R; dx <= TRUST_R; dx++) {
					if (raw.get(`${ix + dx},${iz + dz}`)?.solid) {
						nearSolid = true
						break
					}
				}
			}
			if (nearSolid) continue
		}
		kept.set(key, c.y)
	}

	// The field covers the play rect (plus a margin so bilinear reads never fall off).
	const minIx = Math.floor(bounds.min.x / cell) - 2
	const maxIx = Math.floor(bounds.max.x / cell) + 2
	const minIz = Math.floor(bounds.min.z / cell) - 2
	const maxIz = Math.floor(bounds.max.z / cell) + 2
	const cols = maxIx - minIx + 1
	const rows = maxIz - minIz + 1
	const heights = new Float32Array(cols * rows).fill(NaN)
	const hasData = new Uint8Array(cols * rows)
	const idx = (ix, iz) => (iz - minIz) * cols + (ix - minIx)
	const inRect = (ix, iz) => ix >= minIx && ix <= maxIx && iz >= minIz && iz <= maxIz

	// Stage 3: seed with kept cells, flood-fill the rest from the nearest seed
	// (multi-source BFS, 4-connected). No seeds at all → flat sheet.
	const queue = []
	for (const [key, y] of kept) {
		const [ix, iz] = key.split(",").map(Number)
		if (!inRect(ix, iz)) continue
		const i = idx(ix, iz)
		heights[i] = y
		hasData[i] = 1
		queue.push([ix, iz])
	}
	if (!queue.length) heights.fill(flatY)
	for (let q = 0; q < queue.length; q++) {
		const [ix, iz] = queue[q]
		const y = heights[idx(ix, iz)]
		for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const nx = ix + dx
			const nz = iz + dz
			if (!inRect(nx, nz)) continue
			const ni = idx(nx, nz)
			if (!Number.isNaN(heights[ni])) continue
			heights[ni] = y
			queue.push([nx, nz])
		}
	}

	// Stage 4: object surfaces near the filled level replace fill-guesses (decks,
	// patios, turf rings live in object pieces). Real ground data always wins.
	if (objectMeshes.length) {
		const objCells = estimateCells(objectMeshes, cell)
		for (const [key, c] of objCells) {
			if (!c.solid) continue
			const [ix, iz] = key.split(",").map(Number)
			if (!inRect(ix, iz)) continue
			const i = idx(ix, iz)
			if (hasData[i]) continue
			if (Math.abs(c.y - heights[i]) <= AUGMENT_BAND) {
				heights[i] = c.y
				hasData[i] = 1
			}
		}
	}

	// heightAt: bilinear over cell centers, indices clamped to the rect — total.
	function heightAt(x, z) {
		const gx = Math.min(maxIx - 1e-6, Math.max(minIx, x / cell - 0.5))
		const gz = Math.min(maxIz - 1e-6, Math.max(minIz, z / cell - 0.5))
		const x0 = Math.floor(gx)
		const z0 = Math.floor(gz)
		const fx = gx - x0
		const fz = gz - z0
		const x1 = Math.min(maxIx, x0 + 1)
		const z1 = Math.min(maxIz, z0 + 1)
		const h00 = heights[idx(x0, z0)]
		const h10 = heights[idx(x1, z0)]
		const h01 = heights[idx(x0, z1)]
		const h11 = heights[idx(x1, z1)]
		return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz
	}

	// Debug lattice: one line segment per cell edge, at cell-center heights, so the
	// Colliders view shows the exact surface physics stands on.
	function toDebugGeometry() {
		const segs = []
		for (let iz = minIz; iz <= maxIz; iz++) {
			for (let ix = minIx; ix <= maxIx; ix++) {
				const x = (ix + 0.5) * cell
				const z = (iz + 0.5) * cell
				const y = heights[idx(ix, iz)]
				if (ix < maxIx) segs.push(x, y, z, x + cell, heights[idx(ix + 1, iz)], z)
				if (iz < maxIz) segs.push(x, y, z, x, heights[idx(ix, iz + 1)], z + cell)
			}
		}
		const geometry = new THREE.BufferGeometry()
		geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segs), 3))
		return geometry
	}

	return { heightAt, toDebugGeometry, cell, hasDataAt: (ix, iz) => (inRect(ix, iz) ? Boolean(hasData[idx(ix, iz)]) : false) }
}
