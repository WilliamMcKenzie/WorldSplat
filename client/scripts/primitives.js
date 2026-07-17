import * as THREE from "three"

const colors = {
	box: "#9b9b9b",
}

export function createPrimitive(type, id, seed = {}) {
	type = "box"
	const baseColor = seed.color ?? colors[type]
	const material = new THREE.MeshStandardMaterial({
		color: baseColor,
		roughness: 0.86,
		metalness: 0,
		// Push the faces a hair deeper in the depth buffer so the edge outlines (plain lines,
		// unaffected by polygon offset) always render crisply on top instead of stippling.
		polygonOffset: true,
		polygonOffsetFactor: 1,
		polygonOffsetUnits: 1,
	})
	const mesh = new THREE.Mesh(geometryFor(), material)
	mesh.userData = { id, type, locked: Boolean(seed.locked), baseColor: material.color.getHexString() }
	mesh.position.fromArray(seed.position ?? [0, 0.5, 0])
	mesh.rotation.fromArray(seed.rotation ?? [0, 0, 0])
	// An explicit `seed.scale` wins outright; it is used when reloading saved primitives.
	mesh.scale.fromArray(seed.scale ?? defaultScale().map((v) => v * (seed.scaleFactor ?? 1)))
	addEdgeOutline(mesh, baseColor)
	return mesh
}

// --- Edge outlines ------------------------------------------------------------
// Every block-out mesh carries a line outline on its edges, tinted to the mesh's own
// base colour at 70% brightness, so adjacent blocks read as distinct volumes.
// The outline is a child of its mesh (it follows moves/scales/rolls for free) and is
// flagged with userData.isEdgeOutline so captures and hide-paths can switch it off.

const EDGE_DARKEN = 0.7 // "30% darker" than the base colour

function edgeOutlineColor(baseColor) {
	const color = new THREE.Color(baseColor)
	color.convertLinearToSRGB() // darken in display space so the 30% matches what the eye sees
	color.multiplyScalar(EDGE_DARKEN)
	color.convertSRGBToLinear()
	return color
}

function addEdgeOutline(mesh, baseColor, { threshold = 1 } = {}) {
	const edges = new THREE.LineSegments(
		new THREE.EdgesGeometry(mesh.geometry, threshold),
		new THREE.LineBasicMaterial({ color: edgeOutlineColor(baseColor) }),
	)
	edges.name = "edge_outline"
	edges.userData.isEdgeOutline = true
	mesh.add(edges)
	return edges
}

export function updateEdgeOutlineColor(mesh, baseColor) {
	const edges = mesh?.children.find(child => child.userData.isEdgeOutline)
	if (edges) edges.material.color.copy(edgeOutlineColor(baseColor))
}

export function setEdgeOutlineVisible(mesh, visible) {
	const edges = mesh?.children.find(child => child.userData.isEdgeOutline)
	if (edges) edges.visible = visible
}

export function disposeObject(object) {
	object.traverse(child => {
		if (child.geometry) child.geometry.dispose()
		if (child.material) {
			const materials = Array.isArray(child.material) ? child.material : [child.material]
			for (const material of materials) material.dispose()
		}
	})
	object.removeFromParent()
}

function geometryFor() {
	return new THREE.BoxGeometry(1, 1, 1)
}

function defaultScale() {
	return [1, 1, 1]
}
