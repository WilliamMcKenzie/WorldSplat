import * as THREE from "three"
import { bakeGroundField } from "/scripts/ground-field.js"

// Third-person character controller for play mode (the Play tab). The body auto-spawns
// on the generated world and walks around: WASD moves relative to the camera, Space
// jumps, Shift sprints. Gravity + collide-and-slide run against voxel columns computed
// from the generated gaussians themselves, so collision hugs the actual splat content
// (a tree blocks at its trunk, and the canopy is only solid up where it is); the
// block-out primitives never block. No pointer lock: look is click-drag routed in by
// the host's pointer handlers, so nothing depends on Esc (Mac-friendly). Exit is the
// other view tabs.

const HEIGHT = 1.7 // body height in world units (the floor tile is 16 wide)
const RADIUS = 0.35 // horizontal half-width for collision
const WALK = 4.5 // units/sec
const SPRINT = 1.9 // multiplier while Shift held
const JUMP = 6.0 // initial jump velocity
const GRAVITY = 18 // downward accel
const CAM_DIST = 4.4 // default third-person camera distance
const CAM_MIN = 2.2
const CAM_MAX = 8
const HEAD = 1.45 // camera look-at height above the feet

// Splat-collider voxelization. Gaussian centers are binned into CELL-sized voxels;
// a voxel is solid once CELL_MIN_PTS sufficiently-opaque gaussians land in it, which
// rejects stray wisps. Solid voxels in the same XZ column fuse into one Box3 per
// contiguous vertical run (gaps wider than GAP_BINS cells stay open, so the player
// can walk under a canopy or through an archway).
const CELL = 0.4
const OPACITY_MIN = 0.35
const CELL_MIN_PTS = 3
const GAP_BINS = 2

// Terrain step limit: ground rising more than this above the feet blocks horizontal
// movement (a slope that steep is a wall); anything lower is walked straight up.
const STEP = 0.45

// buildBody makes a blocky mini-figure (boxes only, DB32 colours, accent shirt) with
// hip/shoulder pivot groups so update() can swing the limbs while walking. Its origin
// is at the feet, so positioning is just the feet point; forward is +Z (the face shows
// it). It is the instant placeholder — a rigged human model (loadAvatar) replaces it
// once loaded, falling back to this if the model can't load.
function buildBody() {
	const group = new THREE.Group()
	const figure = new THREE.Group() // the placeholder rig; loadAvatar swaps it out whole
	group.add(figure)
	const mat = color => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 })
	const limb = (material, w, h, d, x, pivotY) => {
		const pivot = new THREE.Group()
		pivot.position.set(x, pivotY, 0)
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
		mesh.position.y = -h / 2 // hang from the pivot so rotation.x swings like a joint
		pivot.add(mesh)
		figure.add(pivot)
		return pivot
	}
	const pants = mat(0x3a4466)
	const shirt = mat(0x5b6ee1)
	const skin = mat(0xeec39a)
	const hair = mat(0x663931)
	const legL = limb(pants, 0.17, 0.66, 0.22, -0.11, 0.72)
	const legR = limb(pants, 0.17, 0.66, 0.22, 0.11, 0.72)
	const armL = limb(shirt, 0.13, 0.52, 0.16, -0.3, 1.22)
	const armR = limb(shirt, 0.13, 0.52, 0.16, 0.3, 1.22)
	const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.52, 0.26), shirt)
	torso.position.y = 0.98
	figure.add(torso)
	const head = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.36, 0.34), skin)
	head.position.y = 1.44
	figure.add(head)
	const cap = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.36), hair)
	cap.position.y = 1.63
	figure.add(cap)
	const capBack = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.28, 0.06), hair)
	capBack.position.set(0, 1.5, -0.16) // the camera rides behind — hair, not bare skin
	figure.add(capBack)
	const eyes = mat(0x222034)
	for (const side of [-1, 1]) {
		const eye = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.02), eyes)
		eye.position.set(side * 0.09, 1.47, 0.175)
		figure.add(eye)
	}
	group.userData.isPlayer = true
	group.userData.placeholder = figure
	group.userData.limbs = { legL, legR, armL, armR }
	return group
}

// groundHeightAt(x, z) is the host's flat sheet Y — the bake's last resort when the
// scene has no ground pieces at all. clampToGround(pos, radius) keeps the feet inside
// the walkable ink bounds; getBounds() returns that rect (the baked field covers it).
export function createPlayer({ camera, world, groundHeightAt, clampToGround, getBounds }) {
	const body = buildBody()
	body.visible = false
	world.group.add(body)

	const pos = new THREE.Vector3() // feet position, world/plot-local coords (world.group is identity)
	const vel = new THREE.Vector3()
	const keys = new Set()
	let facing = 0 // body yaw
	let camYaw = 0 // azimuth of the camera around the body
	let camPolar = 1.05 // polar angle from +Y (smaller = looking down from higher)
	let camDist = CAM_DIST
	let onGround = false
	let colliders = [] // Box3[] world-space voxel columns from the generated splats
	let field = null // the baked ground heightfield — total over the play rect, no holes
	let walkPhase = 0 // stride cycle, advances with ground speed
	let walkSwing = 0 // limb swing amplitude, eases in/out so stopping doesn't freeze mid-stride
	let mixer = null // AnimationMixer once the rigged avatar is in; null = placeholder rig
	let animActions = null // { idle, walk, run } clip actions
	let activeAction = null

	// loadAvatar swaps the blocky placeholder for a rigged human — the Mixamo soldier
	// bundled from the three.js examples (Idle/Walk/Run clips) at /assets/soldier.glb.
	// Any failure just keeps the placeholder.
	async function loadAvatar() {
		try {
			const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js")
			const gltf = await new GLTFLoader().loadAsync("/assets/soldier.glb")
			const model = gltf.scene
			const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3())
			model.scale.setScalar(HEIGHT / size.y)
			model.rotation.y = Math.PI // authored facing -Z; the body's forward is +Z
			const clip = name => THREE.AnimationClip.findByName(gltf.animations, name)
			mixer = new THREE.AnimationMixer(model)
			animActions = { idle: mixer.clipAction(clip("Idle")), walk: mixer.clipAction(clip("Walk")), run: mixer.clipAction(clip("Run")) }
			activeAction = animActions.idle
			activeAction.play()
			body.remove(body.userData.placeholder)
			body.add(model)
		} catch (error) {
			console.warn("player avatar model failed, keeping placeholder:", error)
		}
	}
	loadAvatar()

	const forward = new THREE.Vector3()
	const right = new THREE.Vector3()
	const offset = new THREE.Vector3()
	const spherical = new THREE.Spherical()

	// splatColliders voxelizes every non-floor generated piece into world-space column
	// boxes. Centers come out of PackedSplats in mesh-local space, so each is pushed
	// through the piece's matrixWorld — pieces moved/scaled in the View tab collide
	// where they render.
	function splatColliders() {
		const boxes = []
		const v = new THREE.Vector3()
		for (const { mesh } of world.generated) {
			if (mesh.userData.genKind === "floor" || !mesh.packedSplats) continue
			mesh.updateWorldMatrix(true, false)
			const counts = new Map() // "ix,iy,iz" voxel key -> gaussian count
			mesh.packedSplats.forEachSplat((_i, center, _scales, _quaternion, opacity) => {
				if (opacity < OPACITY_MIN) return
				v.copy(center).applyMatrix4(mesh.matrixWorld)
				if (!Number.isFinite(v.x + v.y + v.z)) return // a NaN center poisons its voxel key into a degenerate sky-spanning box
				const key = `${Math.floor(v.x / CELL)},${Math.floor(v.y / CELL)},${Math.floor(v.z / CELL)}`
				counts.set(key, (counts.get(key) ?? 0) + 1)
			})
			const columns = new Map() // "ix,iz" -> solid iy bins
			for (const [key, n] of counts) {
				if (n < CELL_MIN_PTS) continue
				const [ix, iy, iz] = key.split(",").map(Number)
				const ck = `${ix},${iz}`
				let ys = columns.get(ck)
				if (!ys) columns.set(ck, (ys = []))
				ys.push(iy)
			}
			for (const [ck, ys] of columns) {
				const [ix, iz] = ck.split(",").map(Number)
				ys.sort((a, b) => a - b)
				let lo = ys[0]
				let hi = ys[0]
				const flush = () => boxes.push(new THREE.Box3(
					new THREE.Vector3(ix * CELL, lo * CELL, iz * CELL),
					new THREE.Vector3((ix + 1) * CELL, (hi + 1) * CELL, (iz + 1) * CELL),
				))
				for (let k = 1; k < ys.length; k++) {
					if (ys[k] - hi > GAP_BINS) {
						flush()
						lo = ys[k]
					}
					hi = ys[k]
				}
				flush()
			}
		}
		return boxes
	}

	function buildColliders() {
		// Colliders come from the splats only — the block-out primitives never block,
		// so a mismatched block-out can't leave phantom walls.
		return splatColliders()
	}

	// openGroundCell spirals out from a cell looking for real standing room: a cell
	// with observed ground data (not fill-guesses) and body clearance from the collider
	// columns (not inside a deck, wall, or trunk; canopies overhead don't count).
	function openGroundCell(cx, cz, maxR = 24) {
		const probe = new THREE.Vector3()
		for (let r = 0; r <= maxR; r++) {
			for (let dz = -r; dz <= r; dz++) {
				for (let dx = -r; dx <= r; dx++) {
					if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
					const ix = cx + dx
					const iz = cz + dz
					if (!field.hasDataAt(ix, iz)) continue
					const x = (ix + 0.5) * CELL
					const z = (iz + 0.5) * CELL
					const y = field.heightAt(x, z)
					// Prefer open, level footing: reject crests/lips (steep immediate
					// neighbors read as teetering) and basins (anything much higher within
					// a couple of body-widths means a pit, a junk pocket, or a cliff base).
					let uneven = false
					for (let nz = -4; nz <= 4 && !uneven; nz++) {
						for (let nx = -4; nx <= 4; nx++) {
							const ny = field.heightAt(x + nx * CELL, z + nz * CELL)
							const near = Math.max(Math.abs(nx), Math.abs(nz)) <= 1
							if ((near && Math.abs(ny - y) > STEP) || ny - y > 2) {
								uneven = true
								break
							}
						}
					}
					if (uneven) continue
					// Only cells inside the walkable ink bounds — otherwise the clamp
					// later drags xz back with a stale, wrong y.
					probe.set(x, y, z)
					clampToGround(probe, RADIUS)
					if (Math.abs(probe.x - x) > 1e-6 || Math.abs(probe.z - z) > 1e-6) continue
					let blocked = false
					for (const box of colliders) {
						if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue
						if (box.max.y > y + 0.1 && box.min.y < y + HEIGHT) {
							blocked = true
							break
						}
					}
					if (!blocked) return { x, z, y }
				}
			}
		}
		return null
	}

	// spawn bakes the ground field and colliders, then drops the body at the nearest
	// open floor cell to the requested point (the plot center is often inside a deck
	// or building). Fallback: field height at the hint, lifted onto any collider
	// column covering it.
	function spawn(point) {
		pos.set(point.x, 0, point.z)
		clampToGround(pos, RADIUS)
		field = bakeGroundField({ pieces: world.generated, cell: CELL, bounds: getBounds(), flatY: groundHeightAt(pos.x, pos.z) })
		colliders = buildColliders()
		const open = openGroundCell(Math.floor(pos.x / CELL), Math.floor(pos.z / CELL))
		if (open) {
			pos.set(open.x, open.y, open.z)
			clampToGround(pos, RADIUS)
		} else {
			pos.y = field.heightAt(pos.x, pos.z)
			for (const box of colliders) {
				if (pos.x >= box.min.x && pos.x <= box.max.x && pos.z >= box.min.z && pos.z <= box.max.z && box.max.y > pos.y) pos.y = box.max.y
			}
		}
		console.log(`[play] spawn feet (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}) — ${open ? "open cell" : "fallback placement"}`)
		vel.set(0, 0, 0)
		camYaw = 0
		camPolar = 1.05
		camDist = CAM_DIST
		onGround = true
		body.visible = true
		body.position.copy(pos)
		body.rotation.y = facing
		syncCamera()
	}

	function hide() {
		body.visible = false
		keys.clear()
	}

	// addLook rotates the third-person camera around the body (click-drag).
	function addLook(dx, dy) {
		camYaw -= dx * 0.005
		camPolar = Math.max(0.35, Math.min(1.45, camPolar + dy * 0.004))
	}

	function zoom(deltaY) {
		camDist = Math.max(CAM_MIN, Math.min(CAM_MAX, camDist * (deltaY > 0 ? 1.1 : 0.9)))
	}

	function syncCamera() {
		offset.setFromSpherical(spherical.set(camDist, camPolar, camYaw))
		camera.position.copy(pos).add(offset)
		camera.up.set(0, 1, 0)
		camera.lookAt(pos.x, pos.y + HEAD, pos.z)
	}

	// camForward is the horizontal direction from the camera toward the body — WASD moves
	// relative to it, so "W" always walks into the screen regardless of look angle.
	function updateBasis() {
		forward.set(pos.x - camera.position.x, 0, pos.z - camera.position.z)
		if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1)
		forward.normalize()
		right.set(-forward.z, 0, forward.x) // screen-right (D strafes right)
	}

	function update(dt) {
		if (!body.visible) return
		dt = Math.min(dt, 0.05) // clamp so a stutter can't tunnel through walls
		updateBasis()

		// Jump uses last frame's grounded state.
		if (keys.has("Space") && onGround) {
			vel.y = JUMP
			onGround = false
		}

		// Vertical integrate.
		vel.y -= GRAVITY * dt
		const prevFeet = pos.y
		pos.y += vel.y * dt
		onGround = false

		// Land on the baked ground — always exactly on it. Being under the surface is
		// impossible by construction: horizontal moves below refuse to enter cells more
		// than STEP above the feet, so the snap here can never exceed a step.
		const floorY = field.heightAt(pos.x, pos.z)
		if (pos.y <= floorY) {
			pos.y = floorY
			vel.y = 0
			onGround = true
		}

		// Land on top of a collider column: only when descending through its top face.
		if (vel.y <= 0) {
			for (const box of colliders) {
				if (pos.x < box.min.x || pos.x > box.max.x || pos.z < box.min.z || pos.z > box.max.z) continue
				if (prevFeet >= box.max.y - 1e-3 && pos.y < box.max.y) {
					pos.y = box.max.y
					vel.y = 0
					onGround = true
				}
			}
		}

		// Horizontal move from input, relative to the camera basis. Terrain acts as a
		// wall: a destination whose ground is more than STEP above the feet is refused,
		// per axis, so the player slides along steep rises instead of entering them
		// (grounded or airborne — a jump clears a ledge only when the feet actually rise
		// above it).
		const speed = WALK * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? SPRINT : 1)
		let mx = 0, mz = 0
		if (keys.has("KeyW")) { mx += forward.x; mz += forward.z }
		if (keys.has("KeyS")) { mx -= forward.x; mz -= forward.z }
		if (keys.has("KeyD")) { mx += right.x; mz += right.z }
		if (keys.has("KeyA")) { mx -= right.x; mz -= right.z }
		const len = Math.hypot(mx, mz)
		if (len > 1e-4) {
			const stepX = (mx / len) * speed * dt
			const stepZ = (mz / len) * speed * dt
			const limit = pos.y + STEP
			if (field.heightAt(pos.x + stepX, pos.z + stepZ) <= limit) {
				pos.x += stepX
				pos.z += stepZ
			} else if (field.heightAt(pos.x + stepX, pos.z) <= limit) {
				pos.x += stepX
			} else if (field.heightAt(pos.x, pos.z + stepZ) <= limit) {
				pos.z += stepZ
			}
			facing = Math.atan2(mx, mz) // face the move direction
		}

		resolveHorizontal()
		clampToGround(pos, RADIUS)

		// Animate: the rigged avatar crossfades Idle/Walk/Run; the placeholder rig
		// counter-swings its limbs. Airborne or idle both ease back to rest.
		const striding = len > 1e-4 && onGround
		if (mixer) {
			const sprinting = keys.has("ShiftLeft") || keys.has("ShiftRight")
			const target = striding ? (sprinting ? animActions.run : animActions.walk) : animActions.idle
			if (target !== activeAction) {
				activeAction.fadeOut(0.2)
				target.reset().fadeIn(0.2).play()
				activeAction = target
			}
			mixer.update(dt)
		} else {
			if (striding) walkPhase += speed * dt * 3.1
			walkSwing += ((striding ? 1 : 0) - walkSwing) * Math.min(1, dt * 10)
			const swing = Math.sin(walkPhase) * 0.8 * walkSwing
			const { legL, legR, armL, armR } = body.userData.limbs
			legL.rotation.x = swing
			legR.rotation.x = -swing
			armL.rotation.x = -swing * 0.7
			armR.rotation.x = swing * 0.7
		}

		body.position.copy(pos)
		body.rotation.y = facing
		syncCamera()
	}

	// resolveHorizontal pushes the body out of any primitive it overlaps (footprint fattened
	// by RADIUS), along the shallowest of the four side faces — collide-and-slide.
	function resolveHorizontal() {
		const feetY = pos.y
		const headY = pos.y + HEIGHT
		for (const box of colliders) {
			if (headY <= box.min.y || feetY >= box.max.y) continue // no vertical overlap → not a wall here
			const minx = box.min.x - RADIUS, maxx = box.max.x + RADIUS
			const minz = box.min.z - RADIUS, maxz = box.max.z + RADIUS
			if (pos.x <= minx || pos.x >= maxx || pos.z <= minz || pos.z >= maxz) continue
			const dxL = pos.x - minx, dxR = maxx - pos.x
			const dzL = pos.z - minz, dzR = maxz - pos.z
			const m = Math.min(dxL, dxR, dzL, dzR)
			if (m === dxL) pos.x = minx
			else if (m === dxR) pos.x = maxx
			else if (m === dzL) pos.z = minz
			else pos.z = maxz
		}
	}

	// Keyboard is owned here so WASD never collides with the editor's shortcuts; listeners
	// are attached only between attach()/detach().
	function onKeyDown(e) {
		if (e.repeat) return
		keys.add(e.code)
		if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(e.code)) e.preventDefault()
	}
	function onKeyUp(e) { keys.delete(e.code) }

	function attach() {
		window.addEventListener("keydown", onKeyDown)
		window.addEventListener("keyup", onKeyUp)
	}
	function detach() {
		window.removeEventListener("keydown", onKeyDown)
		window.removeEventListener("keyup", onKeyUp)
		keys.clear()
	}

	// Dev diagnostic (console): window.__wsPlayDebug(x, z) dumps the ground-piece
	// gaussian column, the baked field heights nearby (with data/fill flags), and the
	// feet position — this answers "what does physics actually stand on there".
	window.__wsPlayDebug = (x, z) => {
		const v = new THREE.Vector3()
		const out = []
		for (const { mesh } of world.generated) {
			const kind = mesh.userData.genKind
			if ((kind !== "floor" && kind !== "remainder") || !mesh.packedSplats) continue
			mesh.updateWorldMatrix(true, false)
			mesh.packedSplats.forEachSplat((_i, center, _s, _q, opacity) => {
				v.copy(center).applyMatrix4(mesh.matrixWorld)
				if (Math.abs(v.x - x) <= CELL / 2 && Math.abs(v.z - z) <= CELL / 2) out.push({ y: Number(v.y.toFixed(2)), o: Number(opacity.toFixed(2)) })
			})
		}
		out.sort((a, b) => b.y - a.y)
		const cells = {}
		for (let dz = -2; dz <= 2; dz++) {
			for (let dx = -2; dx <= 2; dx++) {
				const ix = Math.floor(x / CELL) + dx
				const iz = Math.floor(z / CELL) + dz
				if (!field) continue
				cells[`${ix},${iz}`] = `${field.heightAt((ix + 0.5) * CELL, (iz + 0.5) * CELL).toFixed(2)}${field.hasDataAt(ix, iz) ? "" : " (fill)"}`
			}
		}
		return { column: out.slice(0, 25), total: out.length, cells, ground: field ? Number(field.heightAt(x, z).toFixed(2)) : null, feet: pos.toArray().map(n => Number(n.toFixed(2))) }
	}

	return { body, spawn, hide, update, addLook, zoom, attach, detach, colliderBoxes: () => colliders, groundField: () => field }
}
