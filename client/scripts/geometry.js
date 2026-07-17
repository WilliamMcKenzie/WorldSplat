import * as THREE from "three"

// Group connected block-out primitives for one-shot scene segmentation and selection.
// A cluster of face-snapped, touching, or overlapping blocks is one logical object
// (for example, a house made from walls, roof, and door). Ground is deliberately not
// part of this graph, so separate objects resting on it remain distinct.

const TOUCH_EPS = 0.06 // world units of slack so snapped-face neighbours read as touching

const _corner = new THREE.Vector3()

// AABB of a single primitive in world/plot-local space. The world group sits at the
// origin with no transform, so the two frames coincide. Computed from the geometry's
// bounding box (not setFromObject) so selection-outline children never inflate it.
export function primitiveBox(mesh, target = new THREE.Box3()) {
	if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
	const bb = mesh.geometry.boundingBox
	mesh.updateMatrixWorld(true)
	target.makeEmpty()
	for (let i = 0; i < 8; i++) {
		_corner.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z)
		_corner.applyMatrix4(mesh.matrixWorld)
		target.expandByPoint(_corner)
	}
	return target
}

// Group primitives by touching-box connectivity (union-find). Each group carries its
// source meshes and their union AABB for selection and segmentation matching.
export function computeObjects(primitives) {
	const n = primitives.length
	if (!n) return []
	const boxes = primitives.map(p => primitiveBox(p))
	const expanded = boxes.map(b => b.clone().expandByScalar(TOUCH_EPS))

	const parent = [...Array(n).keys()]
	const find = i => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			if (expanded[i].intersectsBox(expanded[j])) parent[find(i)] = find(j)
		}
	}

	const groups = new Map()
	for (let i = 0; i < n; i++) {
		const root = find(i)
		if (!groups.has(root)) groups.set(root, [])
		groups.get(root).push(i)
	}

	return [...groups.values()].map(idxs => {
		const box = new THREE.Box3()
		for (const i of idxs) box.union(boxes[i])
		return { primitives: idxs.map(i => primitives[i]), box }
	})
}
