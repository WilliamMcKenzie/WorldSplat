import * as THREE from "three"

// Canonical whole-scene isometric capture for the one-shot TripoSplat pipeline.

const captureSize = 1024
const background = new THREE.Color(0x000000)
// Light edges so the silhouette reads against the black background (dark edges would
// vanish on it). The flat-material pass keeps true colours for the material-ID map.
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })

// TRUE isometric: 45° azimuth + ~35.26° elevation (the (1,1,1) view), rendered with an
// ORTHOGRAPHIC camera so all three axes are equally foreshortened.
const ISO_THETA = Math.PI / 4 // azimuth, looking at the +X +Z corner
const ISO_PHI = Math.acos(1 / Math.sqrt(3)) // ≈54.74° polar angle from +Y (elevation ≈35.26°)
export const FRONT_THETA = ISO_THETA // azimuth subjects are captured from = the scene "front"
export const FRONT_PHI = ISO_PHI

// Keep generated guides aligned with the editor's default build view. This used to mirror
// X for older seating assumptions, which made captures come from the opposite front.
const MIRROR_CAPTURE_X = false

// Capture the complete block-out — floor and every primitive — in ONE camera pose.
// Alongside the visual guide, optionally render a semantic ID diagram in which every
// connected object group is one artificial solid colour. The image editor uses that
// second image as an inventory/mask reference, never as appearance guidance.
export async function captureWorld(renderer, scene, world, box, objectGroups = null, viewAngles = null) {
	// An unpainted drawable sheet is void, not a floor. Excluding it here prevents the
	// image editor from receiving even an invisible floor mesh as part of the subject.
	const floor = world.groundInkBounds?.() ? [world.ground] : []
	// Whole-scene blocks are volumetric scaffolding, but the white wireframe makes the
	// actual block boundaries explicit for the image model.
	const theta = Number.isFinite(viewAngles?.theta) ? viewAngles.theta : ISO_THETA
	const phi = Number.isFinite(viewAngles?.phi) ? viewAngles.phi : ISO_PHI
	// Stroke the painted ground's ink boundary in white for the capture only: the image
	// model follows a drawn line far better than prose, and without it the terrain outline
	// kept getting simplified into tidy ovals. The live texture is restored afterwards.
	const swapped = []
	let outlined = null
	if (floor.length && world.paint?.canvas && world.paint?.texture) {
		outlined = new THREE.CanvasTexture(outlinedGroundCanvas(world.paint.canvas))
		outlined.flipY = world.paint.texture.flipY
		outlined.colorSpace = world.paint.texture.colorSpace
		outlined.wrapS = world.paint.texture.wrapS
		outlined.wrapT = world.paint.texture.wrapT
		for (const mesh of floor) {
			if (mesh.material?.map === world.paint.texture) {
				swapped.push(mesh)
				mesh.material.map = outlined
				mesh.material.needsUpdate = true
			}
		}
	}
	try {
		const capture = await captureSubject(renderer, scene, world, [...floor, ...world.primitives], isoCamera(box, { theta, phi }), false, true, objectGroups)
		return { ...capture, theta, phi }
	} finally {
		for (const mesh of swapped) {
			mesh.material.map = world.paint.texture
			mesh.material.needsUpdate = true
		}
		outlined?.dispose()
	}
}

// A copy of the paint canvas with the drawn ink's boundary stroked in white: a white
// silhouette of the ink is stamped at eight offsets (a cheap dilation), then the real
// painting is drawn back on top, leaving a crisp white rim exactly along the outline.
function outlinedGroundCanvas(src) {
	const out = document.createElement("canvas")
	out.width = src.width
	out.height = src.height
	const ctx = out.getContext("2d")
	const mask = document.createElement("canvas")
	mask.width = src.width
	mask.height = src.height
	const mctx = mask.getContext("2d")
	mctx.drawImage(src, 0, 0)
	mctx.globalCompositeOperation = "source-in"
	mctx.fillStyle = "#ffffff"
	mctx.fillRect(0, 0, mask.width, mask.height)
	const d = Math.max(4, Math.round(src.width / 256))
	for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [d, -d], [-d, d], [-d, -d]]) ctx.drawImage(mask, dx, dy)
	ctx.drawImage(src, 0, 0)
	return out
}

// A true isometric (orthographic) camera framing `box`. Distance only sets the clip
// range (orthographic projection is scale-independent of distance, so the player's
// distance to the subject never affects framing). The frustum is fitted to the box's
// PROJECTED extents in camera space — a tight off-center crop around the structure as
// seen from this angle — not to the bounding sphere, whose slack varied with the
// player-derived view angle and wasted frame on empty black.
function isoCamera(box, angles = null) {
	const center = box.getCenter(new THREE.Vector3())
	const size = box.getSize(new THREE.Vector3())
	const radius = Math.max(0.3, 0.5 * Math.hypot(size.x, size.y, size.z)) // bounding-sphere radius
	const dist = Math.max(8, radius * 6)
	const theta = Number.isFinite(angles?.theta) ? angles.theta : ISO_THETA
	const phi = Number.isFinite(angles?.phi) ? angles.phi : ISO_PHI
	const camera = new THREE.OrthographicCamera(-radius, radius, radius, -radius, Math.max(0.01, dist - radius * 4), dist + radius * 4)
	camera.up.set(0, 1, 0)
	const offset = new THREE.Vector3().setFromSpherical(new THREE.Spherical(dist, phi, theta))
	if (MIRROR_CAPTURE_X) offset.x = -offset.x // mirror the viewpoint across X
	camera.position.copy(center).add(offset)
	camera.lookAt(center)
	camera.updateMatrixWorld(true)
	// Project the box's eight corners into camera space and frame the tightest square
	// that holds them (square because the capture target is square), plus a sliver of
	// black margin — just enough that the silhouette never touches the frame edge
	// (TripoSplat's background cutout needs that), tight so the image model spends
	// its pixels on the geometry instead of empty void (was 1.06).
	const corner = new THREE.Vector3()
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
	for (let i = 0; i < 8; i++) {
		corner.set(
			i & 1 ? box.max.x : box.min.x,
			i & 2 ? box.max.y : box.min.y,
			i & 4 ? box.max.z : box.min.z,
		).applyMatrix4(camera.matrixWorldInverse)
		minX = Math.min(minX, corner.x)
		maxX = Math.max(maxX, corner.x)
		minY = Math.min(minY, corner.y)
		maxY = Math.max(maxY, corner.y)
	}
	const half = Math.max(0.3, 0.5 * Math.max(maxX - minX, maxY - minY) * 1.02)
	const cx = (minX + maxX) / 2
	const cy = (minY + maxY) / 2
	camera.left = cx - half
	camera.right = cx + half
	camera.top = cy + half
	camera.bottom = cy - half
	camera.updateProjectionMatrix()
	return camera
}

// Project the original connected-object bounds into the exact camera frame used for
// generation. These known bounds replace the old second AI call that tried to rediscover
// the objects from the edited image. The image editor is instructed to preserve the composition, so
// source-geometry boxes are deterministic, instant, and do not consume more GPU time.
export function projectCaptureBoxes(objectGroups, groundBox, frameBox, angles = null) {
	const camera = isoCamera(frameBox, angles)
	const corner = new THREE.Vector3()
	const project = (box, padding = 0) => {
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
		for (let i = 0; i < 8; i++) {
			corner.set(
				i & 1 ? box.max.x : box.min.x,
				i & 2 ? box.max.y : box.min.y,
				i & 4 ? box.max.z : box.min.z,
			).project(camera)
			x0 = Math.min(x0, (corner.x * 0.5 + 0.5) * 1000)
			x1 = Math.max(x1, (corner.x * 0.5 + 0.5) * 1000)
			y0 = Math.min(y0, (-corner.y * 0.5 + 0.5) * 1000)
			y1 = Math.max(y1, (-corner.y * 0.5 + 0.5) * 1000)
		}
		return [y0 - padding, x0 - padding, y1 + padding, x1 + padding].map(value => Math.round(Math.min(1000, Math.max(0, value))))
	}
	const boxes = objectGroups.map((group, index) => ({ label: `object ${index + 1}`, box_2d: project(group.box, 15) }))
	if (groundBox && !groundBox.isEmpty()) boxes.unshift({ label: "terrain", box_2d: project(groundBox, 10) })
	return boxes
}

// Render a guide (optionally with edge lines) + a flat material-ID map of `subject` alone, on a
// black background, with the dedicated `view` camera. Everything else — other block-out
// meshes, all splats, the sky dome, outlines, helpers, the placement preview — is hidden
// so Tripo only sees the subject on black. The shared scene camera is never touched.
function makeGroundCaptureTop(mesh, temporarySubjects) {
	// Ground tiles are thin boxes for editor picking, but generation captures need only
	// the painted TOP surface. If the side/back faces keep the same paint texture, an
	// isometric capture can show a second projected copy of the floor behind the real one.
	if (!mesh?.userData?.isGround || mesh.userData.isGroundSlopePreview) return null
	const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
	const material = new THREE.MeshBasicMaterial({
		color: source?.color?.clone?.() ?? new THREE.Color(0xffffff),
		map: source?.map ?? null,
		side: THREE.DoubleSide,
		depthTest: true,
		depthWrite: true,
		alphaTest: source?.alphaTest ?? 0,
	})
	const top = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
	top.name = `${mesh.name || mesh.userData.id || "ground"}_capture_top`
	top.position.copy(mesh.position)
	top.position.y += Math.abs(mesh.scale.y) * 0.5 + 0.002
	top.rotation.copy(mesh.rotation)
	top.rotateX(-Math.PI / 2)
	top.scale.set(mesh.scale.x, mesh.scale.z, 1)
	top.userData = { ...mesh.userData, isGroundCaptureTop: true }
	mesh.parent?.add(top)
	temporarySubjects.push(top)
	return top
}

async function captureSubject(renderer, scene, world, subject, view, includeMaterialMap = true, includeEdges = true, semanticGroups = null) {
	const target = new THREE.WebGLRenderTarget(captureSize, captureSize, { colorSpace: THREE.SRGBColorSpace })
	const temporarySubjects = []
	const normalizedSubject = subject.map(mesh => makeGroundCaptureTop(mesh, temporarySubjects) ?? mesh)
	const originalSubjectSet = new Set(subject)

	const hidden = []
	const shown = []
	for (const mesh of normalizedSubject) {
		if (mesh.visible) continue
		shown.push([mesh, mesh.visible])
		mesh.visible = true
	}
	for (const mesh of world.allBlockoutMeshes()) {
		if (originalSubjectSet.has(mesh)) {
			if (mesh.userData.isGround) {
				hidden.push([mesh, mesh.visible])
				mesh.visible = false
			}
			continue
		}
		hidden.push([mesh, mesh.visible])
		mesh.visible = false
	}
	// Hide every generated splat (the SparkRenderer draws them all).
	const spark = scene.userData.sparkRenderer
	const sparkVisible = spark?.visible
	if (spark) spark.visible = false

	// Hide the sky dome + any overlays so the background reads as pure black.
	const overlays = []
	scene.traverse(object => {
		if ((object.userData.sky || object.userData.isSelectionOutline || object.userData.isEdgeOutline || object.userData.isDebugHelper || object.userData.isPreview || object.userData.isFront || object.userData.isGizmo) && object.visible) {
			overlays.push(object)
			object.visible = false
		}
	})

	const swaps = applyFlatMaterials(normalizedSubject)
	const prevClear = renderer.getClearColor(new THREE.Color()).clone()
	const prevAlpha = renderer.getClearAlpha()

	const edges = includeEdges ? addEdges(normalizedSubject, world) : []
	const guide = await captureTarget(renderer, scene, view, target)
	for (const edge of edges) {
		edge.geometry.dispose()
		edge.removeFromParent()
	}
	const materialMap = includeMaterialMap ? await captureTarget(renderer, scene, view, target) : null
	const semanticMap = semanticGroups?.length
		? await captureSemanticMap(renderer, scene, view, target, swaps, semanticGroups)
		: null

	restoreMaterials(swaps)
	for (const mesh of temporarySubjects) {
		mesh.geometry.dispose()
		mesh.material.dispose()
		mesh.removeFromParent()
	}
	for (const object of overlays) object.visible = true
	if (spark) spark.visible = sparkVisible
	for (const [mesh, visible] of hidden) mesh.visible = visible
	for (const [mesh, visible] of shown) mesh.visible = visible
	renderer.setClearColor(prevClear, prevAlpha)
	target.dispose()
	return { guide, materialMap, semanticMap }
}

// Render each logical object in one unmistakable flat ID colour. Ground is deliberately
// left in its original flat material so its painted alpha silhouette remains exact; only
// the bright artificial colours are object IDs. This is a diagram, not a texture source.
async function captureSemanticMap(renderer, scene, view, target, swaps, groups) {
	const groupOf = new Map()
	groups.forEach((group, id) => group.primitives.forEach(mesh => groupOf.set(mesh, id)))
	const restore = []
	for (const [mesh, _original, temporary] of swaps) {
		const id = groupOf.get(mesh)
		restore.push([temporary, temporary.color.clone(), temporary.map, temporary.alphaTest])
		if (id == null) {
			// Keep the ground texture attached so its transparent painted outline survives,
			// but tint it dark so it cannot be confused with a bright object ID.
			temporary.color.setHex(0x303030)
			temporary.needsUpdate = true
			continue
		}
		// Golden-ratio hue stepping keeps IDs distinct without repeating when a manual
		// block-out contains more objects than a small fixed palette could represent.
		temporary.color.setHSL((0.96 + id * 0.61803398875) % 1, 1, id % 2 ? 0.48 : 0.62)
		temporary.map = null
		temporary.alphaTest = 0
		temporary.needsUpdate = true
	}
	const result = await captureTarget(renderer, scene, view, target)
	for (const [material, color, map, alphaTest] of restore) {
		material.color.copy(color)
		material.map = map
		material.alphaTest = alphaTest
		material.needsUpdate = true
	}
	return result
}

// Replace each subject mesh's material with an unlit flat one (true colour, plus the
// ground's paint texture if present) so the capture is shadowless reference albedo and
// the material-ID map reads cleanly.
function applyFlatMaterials(meshes) {
	const swaps = []
	for (const mesh of meshes) {
		if (!mesh.material) continue
		const original = mesh.material
		const source = Array.isArray(original) ? original[0] : original
		const color = source?.color?.clone?.() ?? new THREE.Color(0x888888)
		mesh.material = new THREE.MeshBasicMaterial({
			color,
			map: source?.map ?? null,
			side: THREE.DoubleSide,
			depthTest: true,
			depthWrite: true,
			// The drawable ground sheet clips its undrawn (transparent) texels — carry the
			// alpha test so the capture shows the painted silhouette on pure black, not a
			// giant opaque square.
			alphaTest: source?.alphaTest ?? 0,
		})
		swaps.push([mesh, original, mesh.material])
	}
	return swaps
}

function restoreMaterials(swaps) {
	for (const [mesh, original, temporary] of swaps) {
		mesh.material = original
		temporary.dispose()
	}
}

function addEdges(meshes, world) {
	const edges = []
	for (const mesh of meshes) {
		// EdgesGeometry knows only the sheet's outer box, not the alpha-painted ground
		// silhouette. Outlining it drew a large white diamond even when the sheet was empty.
		if (!mesh.geometry || mesh.userData.isGroundSlopePreview || mesh.userData.isGroundSheet) continue
		const edge = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMaterial)
		edge.position.copy(mesh.position)
		edge.quaternion.copy(mesh.quaternion)
		edge.scale.copy(mesh.scale)
		edge.renderOrder = 20
		world.group.add(edge)
		edges.push(edge)
	}
	return edges
}

function captureTarget(renderer, scene, camera, target) {
	renderer.setRenderTarget(target)
	renderer.setClearColor(background, 1)
	renderer.clear()
	renderer.render(scene, camera)

	const pixels = new Uint8Array(captureSize * captureSize * 4)
	renderer.readRenderTargetPixels(target, 0, 0, captureSize, captureSize, pixels)
	renderer.setRenderTarget(null)

	return pixelsToBlob(pixels)
}

function pixelsToBlob(pixels) {
	const canvas = document.createElement("canvas")
	canvas.width = captureSize
	canvas.height = captureSize
	const context = canvas.getContext("2d")
	const image = context.createImageData(captureSize, captureSize)

	for (let y = 0; y < captureSize; y++) {
		const src = y * captureSize * 4
		const dst = (captureSize - y - 1) * captureSize * 4
		image.data.set(pixels.subarray(src, src + captureSize * 4), dst)
	}

	context.putImageData(image, 0, 0)
	return new Promise(resolve => canvas.toBlob(resolve, "image/png"))
}
