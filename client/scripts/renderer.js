import * as THREE from "three"
import { PackedSplats, SparkRenderer, SplatMesh } from "spark"
import { zip, unzip } from "fflate"
import { getConfig } from "/scripts/api.js"
import { captureWorld, projectCaptureBoxes, FRONT_THETA, FRONT_PHI } from "/scripts/capture.js?v=tight-crop-1"
import {
	configureHuggingFace,
	generateSceneOnHuggingFace,
	getHuggingFaceAuth,
	imageStepUsesCredits,
	signOutHuggingFace,
} from "/scripts/huggingface.js?v=no-floor-1"
import { createGenerationImageDebugger } from "/scripts/generation-debug-images.js?v=flux-preview-1"
import { fitSplatToBox } from "/scripts/fit.js?v=wisp-cull-2"
import { computeObjects } from "/scripts/geometry.js"
import { closestAxisDistance } from "/scripts/axis-drag.js?v=direct-tools-1"
import { createPlayer } from "/scripts/player.js"
import { createPrimitive, disposeObject, setEdgeOutlineVisible, updateEdgeOutlineColor } from "/scripts/primitives.js?v=direct-tools-1"
import { addBuild, listBuilds, getBuildSceneSplat, deleteBuild, clearBuilds } from "/scripts/history.js"
import { clearFramesState, loadFramesState, saveFramesState } from "/scripts/frames-store.js"
import { loadDefaultBuildSeeds } from "/scripts/default-builds.js"
import { estimateYawFromData } from "/scripts/yaw-core.js?v=yaw-1" // main-thread fallback when the yaw worker can't start
import { createSky } from "/scripts/sky.js"
import { cloneGroundStrokes, closeGroundStroke, paintGroundStroke } from "/scripts/ground-strokes.js"

const root = document.getElementById("canvas")
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.03, 400)
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: false, powerPreference: "high-performance" })
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const scratch = new THREE.Vector3()
const MAX_AUTOMATIC_SEGMENT_SPLATS = 180_000
const localUp = new THREE.Vector3(0, 1, 0)
const localFaceNormal = new THREE.Vector3()
const placementNormal = new THREE.Vector3()
const rollAxis = new THREE.Vector3()
const rollQuat = new THREE.Quaternion()
const normalMatrix = new THREE.Matrix3()
const scaleParentMatrix = new THREE.Matrix3()
const scaleAxisDir = new THREE.Vector3()
const tmpScale = new THREE.Vector3()
const tmpWorld = new THREE.Vector3()
const tmpFace = new THREE.Vector3()
const tmpDelta = new THREE.Vector3()
const gizmoRayPoint = new THREE.Vector3()
const gizmoPlane = new THREE.Plane()
const gizmoAxisWorld = new THREE.Vector3()
const gizmoCameraDir = new THREE.Vector3()
const gizmoPlaneNormal = new THREE.Vector3()
const primitiveMovePlane = new THREE.Plane()
const primitiveMovePoint = new THREE.Vector3()
const backgroundColor = new THREE.Color(0xf5f4f1) // landing page's --panel: the stage colour behind the splat

const shapeTools = new Set(["box"])
const selectionTools = new Set(["pointer", "move"]) // both select; move also shows the translate widget
const floorSize = 16 // editor scale unit used for camera and brush sizing
const groundThickness = 0.05
const groundTopY = groundThickness // Y of the drawable sheet's top surface
const baseGroundColor = "#587553" // default terrain; painted regions layer on top
const WORKSPACE_SCALE = 3
const GROUND_SHEET_SIZE = 48 * WORKSPACE_SCALE // 144 world units: 3× the previous drawable/buildable sheet
// THE project accent — tabs, colliders, primary button. The landing page's ink
// black; also set in styles.css as --ink. Splat selection instead wears the sky
// highlight (styles.css --hl-sky) so a live selection pops against the scene.
const accent = 0x0d0d0c
const selectionAccent = 0x7fc8f8

const defaultFitSettings = {
	yOffset: 0,
	opacityFloor: 0.03,
	fitBboxPercentile: 0,
	yawDeg: 0,
}
let sceneFit = { ...defaultFitSettings }

// Temporary safety switch: preserve every source gaussian and skip the ground-scar
// repair pass regardless of any saved developer-slider values. Flip this back to true
// when culling and hole filling are ready to be re-enabled.
const SEGMENTATION_CLEANUP_ENABLED = false

// Two stages: Build the block-out, then View the one-shot generated scene.
let uiTab = "build"

let activeTool = "pointer"
let activeColor = baseGroundColor // first strokes CREATE ground, so start on the terrain green
let activeBrushScale = 1
let selectedPrimitive = null
let placementPreview = null
let drag = null
let nextPrimitiveId = 1
let generating = false
let splatting = false // a SPLAT generation is in flight (drives the View tab's disabled+spinner gate)
let generationAbort = null
const generationImageDebugger = createGenerationImageDebugger()

// Temporary inspection aid: keep the exact images sent through the one-shot pipeline
// available through the DevTools preview helper until the next generation replaces them.
function clearGenerationDebugImages() {
	generationImageDebugger.clear()
}

function logGenerationDebugImage(key, label, blob) {
	generationImageDebugger.log(key, label, blob)
}

// Raw one-shot scene bytes + metadata kept in memory for ZIP export and re-fitting.
let sceneSplat = null
let sceneSession = null

// Debug overlays. "Colliders" re-shows the source primitives as a wireframe over the
// generated splats; "Bounds" draws each splat's seated content AABB.
const colliderColor = accent
const boundsColor = accent
let showColliders = false
let showBounds = false
let showSplatFloor = true
// Automatic per-object separation after generation is OFF by default: it runs
// synchronously over every gaussian and freezes the tab for seconds. The devtools
// checkbox turns it back on; "Apply to current scene" can always separate after the fact.
let autoSegmentationEnabled = false
try { autoSegmentationEnabled = localStorage.getItem("worldsketch.autoSegmentation") === "true" } catch {}
let devControlsVisible = false
let rawSplatPreview = null
let rawOrbitSnapshot = null
const segmentationTuneDefaults = {
	voxelCells: 96,
	minBlob: 520,
	bridgeCut: 0.45,
	colorSplit: 1,
	terrainBias: 0.51,
	skirtGuardMinRise: 5.92,
	cullAmount: 100,
	cleanupReach: 0.44,
	wispCull: 0.5, // 0.5 = fit.js's original fixed thresholds; 0 disables the wisp cull

	preCullIntensity: 1.0,
	postCullIntensity: 1.0,
	floorBand: 0.9,
	baseDetachStrength: 0.84,
	baseDetachHeight: 1.2,
	baseDetachRadius: 2,
	baseColumnMinHeight: 1.6,
	wispAggression: 0.77,
	detachedCullPct: 0.03422446964537663,
	edgeOutliers: 0.2,
	groundSmooth: 0.63,
	groundFill: 0.6,
	groundFillMaxHeight: 0.25,
	scarDilation: 1,
	scarBaseHeight: 0.85,
	scarBaseSurface: 1.1,
}
const segmentationTuning = { ...segmentationTuneDefaults }
const clamp01 = value => Math.min(1, Math.max(0, value))
const lerp = (a, b, t) => a + (b - a) * clamp01(t)
const percent = value => `${Math.round(clamp01(value) * 100)}%`
const adjustableSegmentationKeys = new Set([
	"minBlob", "bridgeCut", "colorSplit", "terrainBias", "baseDetachStrength",
	"skirtGuardMinRise", "wispAggression", "detachedCullPct", "cullAmount",
	"cleanupReach", "wispCull", "edgeOutliers", "groundSmooth", "groundFill", "groundFillMaxHeight",
])
try {
	const saved = JSON.parse(localStorage.getItem("worldsketch.segmentationTuning") || "{}")
	for (const key of Object.keys(segmentationTuning)) {
		if (!adjustableSegmentationKeys.has(key)) continue
		const value = Number(saved[key])
		if (Number.isFinite(value)) segmentationTuning[key] = value
	}
} catch {}

const els = {
	status: document.getElementById("status"),
	chatDock: document.querySelector(".chat-dock"),
	progress: document.getElementById("progress"),
	progressTrack: document.getElementById("progress_track"),
	progressFill: document.getElementById("progress_fill"),
	progressLabel: document.getElementById("progress_label"),
	progressPercent: document.getElementById("progress_percent"),
	toolButtons: [...document.querySelectorAll("[data-tool]")],
	viewTabs: [...document.querySelectorAll("[data-view-tab]")],
	colorGrid: document.querySelector(".swatch-grid"),
	paletteFlyout: document.getElementById("palette_flyout"),
	penColorDot: document.getElementById("pen_color_dot"),
	colorSwatches: [...document.querySelectorAll("[data-color]")],
	addColor: document.getElementById("add_color_btn"),
	colorPop: document.getElementById("color_pop"),
	colorPopSv: document.getElementById("color_pop_sv"),
	colorPopSvThumb: document.getElementById("color_pop_sv_thumb"),
	colorPopHue: document.getElementById("color_pop_hue"),
	colorPopHueThumb: document.getElementById("color_pop_hue_thumb"),
	colorPopPreview: document.getElementById("color_pop_preview"),
	colorPopHex: document.getElementById("color_pop_hex"),
	colorPopAdd: document.getElementById("color_pop_add"),
	brushSlider: document.getElementById("brush_size_slider"),
	brushSizeDot: document.getElementById("brush_size_dot"),
	generate: document.getElementById("generate_btn"),
	viewToolButtons: [...document.querySelectorAll("[data-view-tool]")],
	viewTransformOverlay: document.getElementById("view_transform_overlay"),
	viewLassoPath: document.getElementById("view_lasso_path"),
	viewSelectionFrame: document.getElementById("view_selection_frame"),
	viewSelectionBox: document.getElementById("view_selection_box"),
	viewRotateStem: document.getElementById("view_rotate_stem"),
	viewRotateHandle: document.getElementById("view_rotate_handle"),
	viewMoveHandle: document.getElementById("view_move_handle"),
	viewScaleHandles: [...document.querySelectorAll("[data-view-scale-handle]")],
	framesPanel: document.getElementById("frames_panel"),
	framesTitle: document.getElementById("frames_title"),
	framesCount: document.getElementById("frames_count"),
	framesList: document.getElementById("frames_list"),
	frameAdd: document.getElementById("frame_add_btn"),
	flyBtn: document.getElementById("fly_btn"),
	playHint: document.getElementById("play_hint"),
	flyHint: document.getElementById("fly_hint"),
	shotChips: document.getElementById("shot_chips"),
	shotAdd: document.getElementById("shot_add_btn"),
	shotPlay: document.getElementById("shot_play_btn"),
	shotExport: document.getElementById("shot_export_btn"),
	chatForm: document.getElementById("chat_form"),
	chatPrompt: document.getElementById("chat_prompt"),
	sceneShot: document.getElementById("scene_shot_btn"),
	viewRawSplat: document.getElementById("view_raw_splat_input"),
	uploadSceneSplat: document.getElementById("upload_scene_splat_input"),
	downloadPrims: document.getElementById("download_prims_btn"),
	uploadPrims: document.getElementById("upload_prims_input"),
	downloadZip: document.getElementById("download_zip_btn"),
	uploadZip: document.getElementById("upload_zip_input"),
	showColliders: document.getElementById("show_colliders_input"),
	showBounds: document.getElementById("show_splat_box_input"),
	showSplatFloor: document.getElementById("show_splat_floor_input"),
	settingsBtn: document.getElementById("settings_btn"),
	settingsMenu: document.getElementById("settings_menu"),
	settingsPopover: document.getElementById("settings_popover"),
	historyToggle: document.getElementById("history_toggle_btn"),
	historyPanel: document.getElementById("history_panel"),
	historyList: document.getElementById("history_list"),
	historyCount: document.getElementById("history_count"),
	historyClear: document.getElementById("history_clear_btn"),
	historyClose: document.getElementById("history_close_btn"),
	historyEmpty: document.getElementById("history_empty"),
	hfSignOut: document.getElementById("hf_sign_out_btn"),
}

renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setClearColor(backgroundColor, 1)
root.appendChild(renderer.domElement)

const sky = createSky()
scene.add(sky)
const sparkRenderer = new SparkRenderer({ renderer })
scene.add(sparkRenderer)
scene.userData.sparkRenderer = sparkRenderer // hidden during captures so splats never leak in
scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5d42, 2.25))
const sun = new THREE.DirectionalLight(0xffffff, 1.8)
sun.position.set(5, 8, 3)
scene.add(sun)

// Toggle a primitive between its solid look and a wireframe-over-everything collider
// overlay by mutating its OWN material, so disposeObject stays correct.
function setColliderStyle(mesh, on) {
	const mat = mesh.material
	if (on) {
		if (!mesh.userData.colliderSnapshot) {
			mesh.userData.colliderSnapshot = {
				wireframe: mat.wireframe, transparent: mat.transparent, opacity: mat.opacity,
				depthTest: mat.depthTest, depthWrite: mat.depthWrite,
				color: mat.color.getHex(), renderOrder: mesh.renderOrder, map: mat.map,
			}
		}
		mat.wireframe = true
		mat.transparent = true
		mat.opacity = 0.9
		mat.depthTest = false
		mat.depthWrite = false
		mat.map = null
		mat.color.set(colliderColor)
		mesh.renderOrder = 999
		mat.needsUpdate = true
		setEdgeOutlineVisible(mesh, false) // the green wireframe replaces the base-colour outline
	} else if (mesh.userData.colliderSnapshot) {
		const s = mesh.userData.colliderSnapshot
		mat.wireframe = s.wireframe
		mat.transparent = s.transparent
		mat.opacity = s.opacity
		mat.depthTest = s.depthTest
		mat.depthWrite = s.depthWrite
		mat.map = s.map
		mat.color.setHex(s.color)
		mesh.renderOrder = s.renderOrder
		mat.needsUpdate = true
		mesh.userData.colliderSnapshot = null
		setEdgeOutlineVisible(mesh, true)
	}
}

function setPickableHidden(mesh, on) {
	const mat = mesh.material
	if (on) {
		if (!mesh.userData.pickableSnapshot) {
			mesh.userData.pickableSnapshot = {
				transparent: mat.transparent, opacity: mat.opacity, depthTest: mat.depthTest,
				depthWrite: mat.depthWrite, color: mat.color.getHex(), renderOrder: mesh.renderOrder,
				map: mat.map, wireframe: mat.wireframe,
			}
		}
		mesh.visible = true
		mat.transparent = true
		mat.opacity = 0
		mat.depthTest = false
		mat.depthWrite = false
		mat.wireframe = false
		mesh.renderOrder = 1001
		mat.needsUpdate = true
		setEdgeOutlineVisible(mesh, false) // an invisible pickable must not leave its outline floating
	} else if (mesh.userData.pickableSnapshot) {
		const s = mesh.userData.pickableSnapshot
		mat.transparent = s.transparent
		mat.opacity = s.opacity
		mat.depthTest = s.depthTest
		mat.depthWrite = s.depthWrite
		mat.map = s.map
		mat.wireframe = s.wireframe
		mat.color.setHex(s.color)
		mesh.renderOrder = s.renderOrder
		mat.needsUpdate = true
		mesh.userData.pickableSnapshot = null
		setEdgeOutlineVisible(mesh, true)
	}
}

function setPaintToolBlockStyle(mesh, on) {
	if (mesh.userData.isGround) return
	const mat = mesh.material
	if (on) {
		if (!mesh.userData.paintToolSnapshot) {
			mesh.userData.paintToolSnapshot = {
				transparent: mat.transparent,
				opacity: mat.opacity,
				depthWrite: mat.depthWrite,
				renderOrder: mesh.renderOrder,
			}
		}
		mat.transparent = true
		mat.opacity = 0.38
		mat.depthWrite = false
		mesh.renderOrder = 4
		mat.needsUpdate = true
	} else if (mesh.userData.paintToolSnapshot) {
		const s = mesh.userData.paintToolSnapshot
		mat.transparent = s.transparent
		mat.opacity = s.opacity
		mat.depthWrite = s.depthWrite
		mesh.renderOrder = s.renderOrder
		mat.needsUpdate = true
		mesh.userData.paintToolSnapshot = null
	}
}

function refreshPaintToolBlockStyle() {
	const on = uiTab === "build" && activeTool === "paint"
	for (const mesh of world.primitives) setPaintToolBlockStyle(mesh, on)
}

// A paintable canvas texture for terrain guides (rivers, paths, rock) that the one-shot
// scene edit turns into real materials.
// baseColor null → a fully TRANSPARENT canvas (the drawable ground sheet starts as
// void; strokes create the ground). Painted tiles/blocks keep their opaque base fill.
function createPaintSurface(baseColor, size = 1024) {
	const canvas = document.createElement("canvas")
	canvas.width = canvas.height = size
	const ctx = canvas.getContext("2d", { willReadFrequently: true })
	if (baseColor) {
		ctx.fillStyle = baseColor
		ctx.fillRect(0, 0, canvas.width, canvas.height)
	}
	const texture = new THREE.CanvasTexture(canvas)
	texture.colorSpace = THREE.SRGBColorSpace
	texture.anisotropy = renderer.capabilities.getMaxAnisotropy() // keep painted terrain crisp at the grazing angles a zoomed-out orbit produces
	return { canvas, ctx, texture }
}

function groundPaintData(tile = world.ground) {
	if (!tile?.userData?.paint) return { size: GROUND_SHEET_SIZE, complete: true, strokes: [] }
	const complete = tile.userData.paintStrokesComplete !== false
	const data = {
		size: GROUND_SHEET_SIZE,
		complete,
		strokes: cloneGroundStrokes(tile.userData.paintStrokes),
	}
	if (!complete) {
		data.image = tile.userData.paintStrokeBaseImage
			?? tile.userData.paint.canvas.toDataURL("image/png")
	}
	return data
}

function paintGroundStrokeData(surface, strokes, worldSize = GROUND_SHEET_SIZE, clear = true) {
	const { canvas, ctx, texture } = surface
	if (clear) ctx.clearRect(0, 0, canvas.width, canvas.height)
	for (const stroke of strokes) {
		paintGroundStroke(ctx, canvas, stroke, worldSize)
	}
	texture.needsUpdate = true
}

async function loadGroundPaintImage(surface, source) {
	if (!source) return
	await new Promise(resolve => {
		const img = new Image()
		img.onload = () => {
			surface.ctx.drawImage(img, 0, 0, surface.canvas.width, surface.canvas.height)
			resolve()
		}
		img.onerror = () => { console.warn("restore ground: image decode failed"); resolve() }
		img.src = source
	})
}

async function applyGroundPaintData(data, tile = world.ground) {
	if (!tile?.userData?.paint) return
	const surface = tile.userData.paint
	surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height)
	let strokes = []
	let complete = true
	let baseImage = null
	if (typeof data === "string") {
		baseImage = data
		complete = false
		await loadGroundPaintImage(surface, baseImage)
	} else if (data && typeof data === "object") {
		strokes = cloneGroundStrokes(data.strokes)
		baseImage = typeof data.image === "string" ? data.image : null
		complete = data.complete !== false && !baseImage
		if (baseImage) await loadGroundPaintImage(surface, baseImage)
		paintGroundStrokeData(surface, strokes, Number(data.size) || GROUND_SHEET_SIZE, false)
	}
	if (!complete && !baseImage) {
		// Be defensive with hand-authored/imported data that claims to be incomplete
		// without supplying its base. Preserve the rendered result as the new base.
		baseImage = surface.canvas.toDataURL("image/png")
		strokes = []
	}
	tile.userData.paintStrokes = strokes
	tile.userData.paintStrokesComplete = complete
	tile.userData.paintStrokeBaseImage = baseImage
	tile.userData.paintedColors = new Set(strokes.filter(stroke => stroke.mode === "paint").map(stroke => stroke.color))
	tile.userData.paintVersion = (tile.userData.paintVersion || 0) + 1
	tile.userData.paintCache = null
	surface.texture.needsUpdate = true
}

function recordGroundPaintPoint(tile, point, erase) {
	if (!drag || drag.mode !== "paint" || !tile?.userData?.isGround || !point) return
	let active = drag.groundStroke
	if (!active || active.tile !== tile) {
		const stroke = {
			mode: erase ? "erase" : "paint",
			color: activeColor.toLowerCase(),
			radius: Number((activeBrushScale * 0.8).toFixed(4)),
			points: [],
		}
		;(tile.userData.paintStrokes ??= []).push(stroke)
		active = drag.groundStroke = { tile, stroke }
	}
	const next = [Number(point.x.toFixed(4)), Number(point.z.toFixed(4))]
	const previous = active.stroke.points.at(-1)
	if (!previous || Math.hypot(next[0] - previous[0], next[1] - previous[1]) >= 0.02) {
		active.stroke.points.push(next)
	}
}

// Push the broad ground planes slightly deeper in the depth buffer so whatever rests on
// them (blocks seated 6mm up, slope previews, splat skirts) wins the depth contest
// cleanly. Depth-only: captured guide images are colour-identical.
function applyGroundDepthBias(material) {
	material.polygonOffset = true
	material.polygonOffsetFactor = 1
	material.polygonOffsetUnits = 1
}

// Lazily give a block its own paintable canvas-texture the first time it is drawn on,
// so the paintbrush works on any primitive exactly like it does on the ground. The
// canvas starts filled with the block's current colour so painting layers on top.
function ensurePaintSurface(mesh) {
	if (mesh.userData.isGround) return mesh.userData.paint ?? world.paint
	if (mesh.userData.paint) return mesh.userData.paint
	if (mesh.userData.type === "box") atlasBoxUVs(mesh.geometry)
	mesh.userData.baseColor = mesh.material.color.getHexString() // remember it before white-out
	const surface = createPaintSurface("#" + mesh.material.color.getHexString())
	mesh.material.map = surface.texture
	mesh.material.color.set(0xffffff) // let the painted texture show its true colours
	mesh.material.needsUpdate = true
	mesh.userData.paint = surface
	return surface
}

// A box's six faces all share the same [0,1] UV square, so one canvas would mirror the
// same mark onto every face. Repack the faces into a 3×2 atlas so each paints alone.
function atlasBoxUVs(geometry) {
	if (geometry.userData.atlased) return
	const uv = geometry.attributes.uv
	const cols = 3
	const rows = 2
	for (let face = 0; face < 6; face++) {
		const col = face % cols
		const row = Math.floor(face / cols)
		for (let k = 0; k < 4; k++) {
			const i = face * 4 + k
			uv.setXY(i, (col + uv.getX(i)) / cols, (row + uv.getY(i)) / rows)
		}
	}
	uv.needsUpdate = true
	geometry.userData.atlased = true
}

// Clip the brush to the atlas cell the hit landed in, so a stroke near a face edge
// doesn't bleed into the neighbouring face's cell.
function clipToAtlasCell(ctx, canvas, uv) {
	const cols = 3
	const rows = 2
	const col = Math.min(cols - 1, Math.max(0, Math.floor(uv.x * cols)))
	const row = Math.min(rows - 1, Math.max(0, Math.floor(uv.y * rows)))
	const w = canvas.width / cols
	const h = canvas.height / rows
	ctx.beginPath()
	ctx.rect(col * w, (rows - 1 - row) * h, w, h) // canvas y is flipped versus UV v
	ctx.clip()
}

function brushRadiiForHit(hit, canvas, worldSize) {
	const worldRadius = activeBrushScale * 0.8
	if (hit.object.userData.type !== "box" || hit.object.userData.isGround) {
		const radius = Math.max(6, (worldRadius * canvas.width) / worldSize)
		return { x: radius, y: radius }
	}
	const cellW = canvas.width / 3
	const cellH = canvas.height / 2
	const { width, height } = hitFaceWorldSize(hit)
	return {
		x: Math.max(6, (worldRadius * cellW) / width),
		y: Math.max(6, (worldRadius * cellH) / height),
	}
}

function hitFaceWorldSize(hit) {
	if (!hit.object.geometry.boundingBox) hit.object.geometry.computeBoundingBox()
	const size = hit.object.geometry.boundingBox.getSize(new THREE.Vector3())
	size.multiply(hit.object.scale).set(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z))
	const normal = hit.face?.normal ?? new THREE.Vector3(0, 1, 0)
	const ax = Math.abs(normal.x)
	const ay = Math.abs(normal.y)
	const az = Math.abs(normal.z)
	if (ax >= ay && ax >= az) return { width: Math.max(0.001, size.z), height: Math.max(0.001, size.y) }
	if (ay >= ax && ay >= az) return { width: Math.max(0.001, size.x), height: Math.max(0.001, size.z) }
	return { width: Math.max(0.001, size.x), height: Math.max(0.001, size.y) }
}

// The single world: one paintable ground sheet, block-out primitives, and the one-shot
// scene splat plus the movable pieces segmented from it.
class World {
	constructor() {
		this.size = floorSize
		this.group = new THREE.Group()
		scene.add(this.group)
		this.primitives = []
		this.generated = [] // { mesh }
		this.boundsHelpers = []
		this.state = "draft"
		this.prompt = ""
		this.baseGroundColor = baseGroundColor

		// The ground is one large DRAWABLE SHEET, not a fixed plot: its paint canvas starts
		// fully transparent (alphaTest clips undrawn texels), and the paint tool creates
		// ground wherever the user strokes. Where nothing is drawn there simply is no ground.
		this.paint = createPaintSurface(null, 2048)
		this.ground = createPrimitive("box", "ground", {
			position: [0, groundThickness / 2, 0],
			scale: [GROUND_SHEET_SIZE, groundThickness, GROUND_SHEET_SIZE],
			color: baseGroundColor,
			locked: true,
		})
		this.ground.material.map = this.paint.texture
		this.ground.userData.baseColor = baseGroundColor.replace("#", "")
		this.ground.material.color.set(0xffffff) // let the painted texture show its true colours
		this.ground.material.alphaTest = 0.5 // undrawn canvas = no ground (void)
		applyGroundDepthBias(this.ground.material)
		this.ground.material.needsUpdate = true
		this.ground.userData.isGround = true
		this.ground.userData.isGroundSheet = true
		this.ground.userData.paint = this.paint
		this.ground.userData.paintStrokes = []
		this.ground.userData.paintStrokesComplete = true
		this.ground.userData.paintStrokeBaseImage = null
		setEdgeOutlineVisible(this.ground, false) // the sheet's square outline would read as a plot border around the void
		this.group.add(this.ground)

	}

	// World-space bounds of the DRAWN ground (null when nothing is drawn yet). Sampled
	// from a downscaled alpha scan so it stays exact after erasing, and cheap enough to
	// call per generation. Canvas x → world +X, canvas y → world +Z (top-down mapping).
	groundInkBounds() {
		const S = 128 * WORKSPACE_SCALE // retain the previous world-space scan precision on the larger sheet
		const probe = document.createElement("canvas")
		probe.width = probe.height = S
		const pctx = probe.getContext("2d", { willReadFrequently: true })
		pctx.clearRect(0, 0, S, S)
		pctx.drawImage(this.paint.canvas, 0, 0, S, S)
		const data = pctx.getImageData(0, 0, S, S).data
		let minX = S, maxX = -1, minZ = S, maxZ = -1
		for (let j = 0; j < S; j++) {
			for (let i = 0; i < S; i++) {
				if (data[(j * S + i) * 4 + 3] <= 32) continue
				if (i < minX) minX = i
				if (i > maxX) maxX = i
				if (j < minZ) minZ = j
				if (j > maxZ) maxZ = j
			}
		}
		if (maxX < 0) return null
		const half = GROUND_SHEET_SIZE / 2
		return new THREE.Box3(
			new THREE.Vector3(-half + (minX / S) * GROUND_SHEET_SIZE, 0, -half + (minZ / S) * GROUND_SHEET_SIZE),
			new THREE.Vector3(-half + ((maxX + 1) / S) * GROUND_SHEET_SIZE, groundTopY + 0.01, -half + ((maxZ + 1) / S) * GROUND_SHEET_SIZE),
		)
	}

	allBlockoutMeshes() {
		return [this.ground, ...this.primitives]
	}

	raycastables() {
		return [this.ground, ...this.primitives].filter(mesh => mesh.visible)
	}

	selectables() {
		return [this.ground, ...this.primitives].filter(mesh => mesh.visible)
	}

	addPrimitive(type, hit) {
		const mesh = createPrimitive(type, `prim_${String(nextPrimitiveId++).padStart(3, "0")}`, { color: activeColor, scaleFactor: activeBrushScale })
		placeMeshOnSurface(mesh, hit)
		this.group.worldToLocal(mesh.position)
		mesh.userData.world = this
		recordSupport(mesh, hit)
		this.primitives.push(mesh)
		this.group.add(mesh)
		return mesh
	}

	removePrimitive(mesh) {
		const index = this.primitives.indexOf(mesh)
		if (index >= 0) this.primitives.splice(index, 1)
		// Re-seat anything that was resting on the deleted block onto whatever the
		// deleted block was resting on, so the attachment forest has no dangling refs.
		for (const p of this.primitives) {
			if (p.userData.support === mesh) p.userData.support = mesh.userData.support ?? null
		}
		if (selectedPrimitive === mesh) selectPrimitive(null)
		disposeObject(mesh)
	}

	paintAt(hit, erase = false) {
		const uv = hit.uv
		if (!uv) return
		const surface = ensurePaintSurface(hit.object)
		if (!surface) return
		// Remember each colour painted onto a primitive (or the ground), so it joins that
		// subject's palette for the hue lock — e.g. red berry spots become an available
		// colour, and a painted blue river joins the floor's palette. Record on the tile,
		// not a transient curved-surface mesh (those are rebuilt on every height change).
		const paintTarget = hit.object.userData.tile ?? hit.object
		if (!erase) (paintTarget.userData.paintedColors ??= new Set()).add(activeColor)
		paintTarget.userData.paintVersion = (paintTarget.userData.paintVersion || 0) + 1 // invalidate the snapshot paint cache
		const { canvas, ctx, texture } = surface
		const px = uv.x * canvas.width
		const py = (1 - uv.y) * canvas.height
		const isSheet = Boolean(hit.object.userData.isGroundSheet || hit.object.userData.tile?.userData?.isGroundSheet)
		if (paintTarget.userData.isGround) recordGroundPaintPoint(paintTarget, hit.point, erase)
		const radius = brushRadiiForHit(hit, canvas, isSheet ? GROUND_SHEET_SIZE : this.size)
		ctx.save()
		if (hit.object.userData.type === "box" && !hit.object.userData.isGround) clipToAtlasCell(ctx, canvas, uv)
		if (erase) ctx.globalCompositeOperation = "destination-out" // erasing the sheet removes the ground itself
		ctx.fillStyle = activeColor
		// Pointer events arrive far apart on fast drags — a round-capped LINE from the
		// previous stamp keeps the stroke continuous (vital when strokes CREATE ground).
		const last = drag?.paintLast
		if (last && last.object === hit.object && radius.x === radius.y) {
			ctx.strokeStyle = activeColor
			ctx.lineWidth = radius.x * 2
			ctx.lineCap = "round"
			ctx.beginPath()
			ctx.moveTo(last.px, last.py)
			ctx.lineTo(px, py)
			ctx.stroke()
		} else {
			ctx.beginPath()
			ctx.ellipse(px, py, radius.x, radius.y, 0, 0, Math.PI * 2)
			ctx.fill()
		}
		ctx.restore()
		if (drag) drag.paintLast = { object: hit.object, px, py }
		texture.needsUpdate = true
	}

	// Seat a generated splat. Splats render only in View, which hides the block-out.
	addGenerated(mesh) {
		const record = { mesh }
		this.generated.push(record)
		this.group.add(mesh)
		mesh.visible = uiTab !== "build"
	}

	// Tear down a previous generation: drop the splats, restore the editable block-out.
	resetGenerated() {
		clearRawSplatPreview()
		for (const { mesh } of this.generated) disposeObject(mesh)
		this.generated.length = 0 // in place — this array belongs to the active View frame
		this.setBoundsVisible(false)
		setPickableHidden(this.ground, false)
		this.ground.visible = true
		setColliderStyle(this.ground, false)
		for (const primitive of this.primitives) {
			setPickableHidden(primitive, false)
			primitive.visible = true
			setColliderStyle(primitive, false)
		}
		this.state = "draft"
		applyUiTab() // re-assert per-tab visibility (a View-tab reset must not reveal the block-out)
	}

	setCollidersVisible(show) {
		if (this.state !== "generated") return
		if (show) {
			setPickableHidden(this.ground, false)
			this.ground.visible = true
			setColliderStyle(this.ground, true)
		} else {
			setColliderStyle(this.ground, false)
			setPickableHidden(this.ground, true)
			this.ground.visible = true
		}
		for (const primitive of this.primitives) {
			if (show) {
				setPickableHidden(primitive, false)
				primitive.visible = true
				setColliderStyle(primitive, true)
			} else {
				setColliderStyle(primitive, false)
				setPickableHidden(primitive, true)
			}
		}
	}

	setBoundsVisible(show) {
		for (const helper of this.boundsHelpers) {
			this.group.remove(helper)
			disposeObject(helper)
		}
		this.boundsHelpers = []
		if (!show || this.state !== "generated") return
		for (const { mesh } of this.generated) {
			if (!showSplatFloor && mesh.userData.genKind === "floor") continue
			const box = mesh.userData.contentBox
			if (!box) continue
			const helper = new THREE.Box3Helper(box, boundsColor)
			helper.material.depthTest = false
			helper.renderOrder = 998
			helper.userData.isDebugHelper = true
			this.group.add(helper)
			this.boundsHelpers.push(helper)
		}
	}
}

const world = new World()

// --- Translation gizmo ------------------------------------------------------

const gizmoAxes = [
	{ name: "x", color: 0xe44b4b, dir: new THREE.Vector3(1, 0, 0) },
	{ name: "y", color: 0x4caf50, dir: new THREE.Vector3(0, 1, 0) }, // standard axis colours: X red, Y green, Z blue
	{ name: "z", color: 0x3b82f6, dir: new THREE.Vector3(0, 0, 1) },
]

function createGizmoAxis({ name, color, dir }) {
	const group = new THREE.Group()
	group.userData.isGizmo = true
	group.userData.axis = name
	const material = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false })
	const hitMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.001, depthTest: false, depthWrite: false })
	const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.95, 12), material)
	shaft.position.y = 0.48
	const cone = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.34, 20), material)
	cone.position.y = 1.12
	const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.45, 12), hitMaterial)
	hit.position.y = 0.72
	hit.userData.isGizmoHandle = true
	hit.userData.axis = name
	group.add(shaft, cone, hit)
	group.quaternion.setFromUnitVectors(localUp, dir)
	group.renderOrder = 1000
	group.traverse(object => {
		object.userData.isGizmo = true
		object.renderOrder = 1000
	})
	return group
}

const transformGizmo = new THREE.Group()
transformGizmo.visible = false
transformGizmo.userData.isGizmo = true
const gizmoHandleMeshes = []
for (const axis of gizmoAxes) {
	const group = createGizmoAxis(axis)
	const handle = group.children.find(child => child.userData.isGizmoHandle)
	if (handle) gizmoHandleMeshes.push(handle)
	transformGizmo.add(group)
}
scene.add(transformGizmo)

function selectedGizmoPosition(out = new THREE.Vector3()) {
	if (!selectedPrimitive) return out.set(0, 0, 0)
	if (!selectedPrimitive.geometry.boundingBox) selectedPrimitive.geometry.computeBoundingBox()
	selectedPrimitive.updateWorldMatrix(true, false)
	const box = selectedPrimitive.geometry.boundingBox.clone().applyMatrix4(selectedPrimitive.matrixWorld)
	box.getCenter(out)
	return out
}

function updateTransformGizmo() {
	const show = Boolean(selectedPrimitive) && activeTool === "move" && !generating && uiTab === "build"
	transformGizmo.visible = show
	if (!show) return
	selectedGizmoPosition(transformGizmo.position)
	const dist = Math.max(1, camera.position.distanceTo(transformGizmo.position))
	const scale = Math.min(2.2, Math.max(0.8, dist * 0.055))
	transformGizmo.scale.setScalar(scale)
}

function gizmoHit(event) {
	if (!transformGizmo.visible) return null
	const handles = gizmoHandleMeshes.filter(mesh => mesh.parent?.visible)
	return handles.length ? raycast(event, handles) : null
}

function gizmoAxisVector(axis) {
	if (axis === "x") return new THREE.Vector3(1, 0, 0)
	if (axis === "y") return new THREE.Vector3(0, 1, 0)
	return new THREE.Vector3(0, 0, 1)
}

function intersectGizmoPlane(event, out) {
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	return raycaster.ray.intersectPlane(gizmoPlane, out)
}

function startGizmoDrag(event, handle) {
	if (!selectedPrimitive) return false
	const axis = handle.userData.axis
	gizmoAxisWorld.copy(gizmoAxisVector(axis)).normalize()
	camera.getWorldDirection(gizmoCameraDir)
	gizmoPlaneNormal.copy(gizmoCameraDir).addScaledVector(gizmoAxisWorld, -gizmoCameraDir.dot(gizmoAxisWorld))
	if (gizmoPlaneNormal.lengthSq() < 1e-5) {
		gizmoPlaneNormal.set(axis === "y" ? 1 : 0, axis === "y" ? 0 : 1, 0)
	}
	gizmoPlaneNormal.normalize()
	gizmoPlane.setFromNormalAndCoplanarPoint(gizmoPlaneNormal, transformGizmo.position)
	if (!intersectGizmoPlane(event, gizmoRayPoint)) return false
	const startScalar = gizmoRayPoint.clone().sub(transformGizmo.position).dot(gizmoAxisWorld)
	const subtree = objectClusterOf(selectedPrimitive)
	beginBuildAction() // undo checkpoint: gizmo move (popped again if nothing moves)
	drag = {
		mode: "gizmo",
		pointerId: event.pointerId,
		mesh: selectedPrimitive,
		axis,
		axisWorld: gizmoAxisWorld.clone(),
		origin: transformGizmo.position.clone(),
		startScalar,
		subtree,
		startPositions: [selectedPrimitive, ...subtree].map(mesh => mesh.getWorldPosition(new THREE.Vector3())),
		actionPushed: true,
	}
	renderer.domElement.setPointerCapture(event.pointerId)
	renderer.domElement.classList.add("is-dragging")
	return true
}

function updateGizmoDrag(event) {
	if (!intersectGizmoPlane(event, gizmoRayPoint)) return
	const currentScalar = gizmoRayPoint.clone().sub(drag.origin).dot(drag.axisWorld)
	const delta = currentScalar - drag.startScalar
	if (Math.abs(delta) < 1e-6) return
	drag.mutated = true // the checkpoint pushed at drag start is now earned
	tmpDelta.copy(drag.axisWorld).multiplyScalar(delta)
	const moved = [drag.mesh, ...drag.subtree]
	for (let i = 0; i < moved.length; i++) {
		tmpWorld.copy(drag.startPositions[i]).add(tmpDelta)
		moved[i].parent.worldToLocal(tmpWorld)
		moved[i].position.copy(tmpWorld)
	}
	updateTransformGizmo()
}

// Dragging a block directly with the Move tool keeps the exact grabbed point under
// the cursor on a horizontal plane. The axis gizmo remains available for constrained
// and vertical movement.
function startPrimitiveMoveDrag(event, mesh, hit) {
	selectPrimitive(mesh)
	if (mesh.userData.isGround || mesh.userData.locked) return false
	primitiveMovePlane.setFromNormalAndCoplanarPoint(localUp, hit.point)
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	if (!raycaster.ray.intersectPlane(primitiveMovePlane, primitiveMovePoint)) return false
	const members = [mesh, ...objectClusterOf(mesh)]
	beginBuildAction()
	drag = {
		mode: "primitive-move",
		pointerId: event.pointerId,
		plane: primitiveMovePlane.clone(),
		startPoint: primitiveMovePoint.clone(),
		members: members.map(member => ({
			mesh: member,
			startWorld: member.getWorldPosition(new THREE.Vector3()),
		})),
		actionPushed: true,
		mutated: false,
	}
	renderer.domElement.setPointerCapture(event.pointerId)
	renderer.domElement.classList.add("is-dragging")
	return true
}

function updatePrimitiveMoveDrag(event) {
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	if (!raycaster.ray.intersectPlane(drag.plane, primitiveMovePoint)) return
	tmpDelta.copy(primitiveMovePoint).sub(drag.startPoint)
	if (tmpDelta.lengthSq() < 1e-12) return
	drag.mutated = true
	for (const member of drag.members) {
		tmpWorld.copy(member.startWorld).add(tmpDelta)
		member.mesh.parent.worldToLocal(tmpWorld)
		member.mesh.position.copy(tmpWorld)
	}
	updateTransformGizmo()
}

// --- Tools / palette --------------------------------------------------------

// Contextual palette (tldraw/FigJam style): the colour + brush flyout only shows
// when the active tool consumes them (pen paints, box places coloured blocks) or
// a primitive is selected for recolouring. Everything else keeps a slim rail.
const paletteTools = new Set(["paint", "box"])

function updatePaletteFlyout() {
	const open = paletteTools.has(activeTool) || Boolean(selectedPrimitive)
	els.paletteFlyout?.classList.toggle("open", open)
	els.paletteFlyout?.setAttribute("aria-hidden", String(!open))
	if (!open) toggleColorPop(false) // the picker never outlives its flyout
}

function setActiveTool(tool) {
	const previous = activeTool
	activeTool = tool
	renderer.domElement.style.removeProperty("cursor")
	// Keep the selection when hopping between the two selection tools (pointer ↔ move).
	if (previous !== tool && !(selectionTools.has(previous) && selectionTools.has(tool))) selectPrimitive(null)
	for (const button of els.toolButtons) button.classList.toggle("active", button.dataset.tool === tool)
	renderer.domElement.classList.toggle("is-pointer", tool === "pointer")
	renderer.domElement.classList.toggle("is-move", tool === "move")
	renderer.domElement.classList.toggle("is-eraser", tool === "eraser")
	renderer.domElement.classList.toggle("is-placing", shapeTools.has(tool))
	renderer.domElement.classList.toggle("is-painting", tool === "paint")
	renderer.domElement.classList.toggle("is-scaling", tool === "scale")
	renderer.domElement.classList.toggle("is-rotating", tool === "rotate")
	refreshPaintToolBlockStyle()
	syncPlacementPreview()
	updateTransformGizmo()
	updatePaletteFlyout()
}

function syncPlacementPreview() {
	if (!shapeTools.has(activeTool) || uiTab !== "build") {
		if (placementPreview) disposeObject(placementPreview)
		placementPreview = null
		return
	}
	if (placementPreview?.userData.type === activeTool) return
	if (placementPreview) disposeObject(placementPreview)
	placementPreview = createPrimitive(activeTool, "preview", { color: activeColor, scaleFactor: activeBrushScale })
	placementPreview.userData.type = activeTool
	placementPreview.userData.isPreview = true
	placementPreview.material.transparent = true
	placementPreview.material.opacity = 0.45
	placementPreview.material.depthWrite = false
	// Ghost the preview's edge outline to match its translucent body.
	const previewEdges = placementPreview.children.find(child => child.userData.isEdgeOutline)
	if (previewEdges) {
		previewEdges.material.transparent = true
		previewEdges.material.opacity = 0.5
	}
	scene.add(placementPreview)
}

function selectPrimitive(mesh) {
	selectedPrimitive = mesh
	if (mesh) syncActiveColorFromSelection(mesh)
	updateTransformGizmo()
	updatePaletteFlyout()
}

function setActiveColorOnly(color) {
	activeColor = color
	if (els.penColorDot) els.penColorDot.style.background = color
	if (placementPreview) {
		placementPreview.material.color.set(color)
		placementPreview.userData.baseColor = placementPreview.material.color.getHexString()
		updateEdgeOutlineColor(placementPreview, color)
	}
	for (const swatch of els.colorSwatches) {
		swatch.classList.toggle("active", swatch.dataset.color.toLowerCase() === color.toLowerCase())
	}
}

function syncActiveColorFromSelection(mesh) {
	const hex = "#" + (mesh.userData.baseColor ?? mesh.material.color.getHexString())
	setActiveColorOnly(hex)
}

function applyColor(color) {
	setActiveColorOnly(color)
	if (selectedPrimitive) {
		const current = `#${selectedPrimitive.userData.baseColor ?? selectedPrimitive.material.color.getHexString()}`
		if (current.toLowerCase() !== color.toLowerCase()) beginBuildAction() // undo checkpoint: recolour
		selectedPrimitive.material.color.set(color)
		selectedPrimitive.userData.baseColor = selectedPrimitive.material.color.getHexString()
		updateEdgeOutlineColor(selectedPrimitive, color)
	}
}

// The palette is user-editable (add via the picker popover, hover-x to remove) and
// persists across sessions. Removing a swatch never touches colours already painted
// into the world — the palette only feeds the picker UI.
const DEFAULT_PALETTE = ["#587553", "#6abe30", "#8f563b", "#d9a066", "#847e87", "#306082", "#ac3232", "#eec39a"]
const PALETTE_STORE_KEY = "worldsketch.palette"

function loadPalette() {
	try {
		const saved = JSON.parse(localStorage.getItem(PALETTE_STORE_KEY))
		if (Array.isArray(saved) && saved.length && saved.every(c => /^#[0-9a-f]{6}$/i.test(c))) {
			return saved.map(c => c.toLowerCase())
		}
	} catch { /* corrupt store — fall back to defaults */ }
	return DEFAULT_PALETTE.slice()
}

let palette = loadPalette()

function savePalette() {
	try { localStorage.setItem(PALETTE_STORE_KEY, JSON.stringify(palette)) } catch { /* private mode */ }
}

function renderPalette() {
	for (const swatch of els.colorSwatches) swatch.remove()
	els.colorSwatches = palette.map(hex => {
		const swatch = document.createElement("button")
		swatch.type = "button"
		swatch.className = "color-swatch btn btn-ghost btn-square"
		swatch.dataset.color = hex
		swatch.setAttribute("aria-label", hex)
		swatch.title = hex
		const dot = document.createElement("span")
		dot.style.background = hex
		swatch.appendChild(dot)
		if (palette.length > 1) {
			const del = document.createElement("span")
			del.className = "swatch-del"
			del.title = "Remove color"
			del.setAttribute("role", "button")
			del.setAttribute("aria-label", `Remove ${hex}`)
			del.textContent = "×"
			del.addEventListener("click", event => {
				event.stopPropagation()
				removePaletteColor(hex)
			})
			swatch.appendChild(del)
		}
		swatch.addEventListener("click", () => applyColor(hex))
		els.colorGrid.insertBefore(swatch, els.addColor)
		return swatch
	})
	setActiveColorOnly(activeColor) // re-mark the active swatch
}

function addPaletteColor(color) {
	const hex = color.toLowerCase()
	if (!palette.includes(hex)) {
		palette.push(hex)
		savePalette()
		renderPalette()
	}
	applyColor(hex)
}

function removePaletteColor(hex) {
	if (palette.length <= 1) return // never empty the palette
	palette = palette.filter(c => c !== hex)
	savePalette()
	renderPalette()
	if (activeColor.toLowerCase() === hex) applyColor(palette[0])
}

function applyBrushScale(scale) {
	activeBrushScale = scale
	if (placementPreview) placementPreview.userData.type = null
	syncPlacementPreview()
	if (Number(els.brushSlider.value) !== scale) els.brushSlider.value = scale
	const t = (scale - Number(els.brushSlider.min)) / (Number(els.brushSlider.max) - Number(els.brushSlider.min))
	els.brushSizeDot.style.setProperty("--brush-dot", `${(0.4 + t * 0.65).toFixed(3)}rem`)
}

// --- Colour picker popover ---------------------------------------------------
// Replaces the native OS colour dialog (which opened as a floating panel in the
// screen corner) with the canvas-app standard: an anchored popover holding an
// SV square, a hue strip and a hex field.

const picker = { h: 0, s: 0, v: 0 } // seeded from the active colour on open

function normalizeHex(value) {
	const raw = String(value).trim().replace(/^#/, "").toLowerCase()
	if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`
	if (/^[0-9a-f]{3}$/.test(raw)) return `#${[...raw].map(c => c + c).join("")}`
	return null
}

function hexToHsv(hex) {
	const n = parseInt(hex.slice(1), 16)
	const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255
	const max = Math.max(r, g, b), d = max - Math.min(r, g, b)
	let h = 0
	if (d) {
		if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
		else if (max === g) h = ((b - r) / d + 2) * 60
		else h = ((r - g) / d + 4) * 60
	}
	return { h, s: max ? d / max : 0, v: max }
}

function hsvToHex({ h, s, v }) {
	const f = n => {
		const k = (n + h / 60) % 6
		const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
		return Math.round(c * 255).toString(16).padStart(2, "0")
	}
	return `#${f(5)}${f(3)}${f(1)}`
}

// Push the picker state into the popover widgets. `fromHex` keeps the hex field
// untouched while the user is typing in it.
function syncPicker({ fromHex = false } = {}) {
	if (!els.colorPop) return
	const hex = hsvToHex(picker)
	els.colorPopSv.style.setProperty("--pop-hue", `hsl(${picker.h}, 100%, 50%)`)
	els.colorPopSvThumb.style.left = `${picker.s * 100}%`
	els.colorPopSvThumb.style.top = `${(1 - picker.v) * 100}%`
	els.colorPopHueThumb.style.left = `${picker.h / 360 * 100}%`
	els.colorPopPreview.style.background = hex
	if (!fromHex) els.colorPopHex.value = hex
}

function toggleColorPop(open) {
	if (!els.colorPop) return
	const show = open ?? els.colorPop.classList.contains("hidden")
	els.colorPop.classList.toggle("hidden", !show)
	els.addColor?.setAttribute("aria-expanded", String(show))
	if (show) {
		Object.assign(picker, hexToHsv(normalizeHex(activeColor) ?? "#639bff"))
		syncPicker()
		els.colorPopHex?.focus()
	}
}

function bindPickerDrag(el, apply) {
	if (!el) return
	el.addEventListener("pointerdown", event => {
		event.preventDefault()
		el.setPointerCapture(event.pointerId)
		const move = ev => {
			const rect = el.getBoundingClientRect()
			const x = Math.min(Math.max((ev.clientX - rect.left) / rect.width, 0), 1)
			const y = Math.min(Math.max((ev.clientY - rect.top) / rect.height, 0), 1)
			apply(x, y)
			syncPicker()
		}
		move(event)
		el.addEventListener("pointermove", move)
		el.addEventListener("pointerup", () => el.removeEventListener("pointermove", move), { once: true })
	})
}

// --- Build / View tabs --------------------------------------------------------
// Two tabs over the same world. Build: the editable block-out (primitives + ground
// tiles) with every generated splat hidden — all block-out editing lives here. View:
// the generated splats. The tabs are DECOUPLED after generation: Build edits never
// move existing splats (regenerate to reflect them), and View has its own lasso/group
// transform workflow that acts on the splat meshes alone.

const emptyViewHint = "Nothing generated yet — hit Generate and the View tab fills in"

function setUiTab(tab) {
	if (tab === uiTab) return
	if (tab === "play" && rawSplatPreview) return // raw inspection is orbit-only, like fly
	const wasPlay = uiTab === "play"
	uiTab = tab
	if (tab !== "build") selectPrimitive(null) // View has no block-out selection / gizmo
	if (tab !== "view") deselectSplat() // splat selection is a View-only thing
	if (tab === "view" && !world.generated.length) setStatus(emptyViewHint)
	else if (els.status.textContent === emptyViewHint) setStatus("")
	if (tab === "play") enterPlay()
	else if (wasPlay) exitPlay()
	applyUiTab()
}

function applyUiTab() {
	const building = uiTab === "build"
	document.body.classList.toggle("tab-view", uiTab === "view") // CSS strips all UI but the tabs in View
	document.body.classList.toggle("tab-play", uiTab === "play") // CSS strips everything but the tabs + hint in Play
	for (const button of els.viewTabs) {
		button.classList.toggle("active", button.dataset.viewTab === uiTab)
		button.setAttribute("aria-selected", String(button.dataset.viewTab === uiTab))
	}
	if (els.chatPrompt) els.chatPrompt.placeholder = "Describe your scene..."
	// Splats render only in the View tab.
	for (const { mesh } of world.generated) {
		mesh.visible = !building && (showSplatFloor || mesh.userData.genKind !== "floor")
	}
	if (building) {
		// The full editable block-out, whatever the generation state.
		for (const mesh of world.allBlockoutMeshes()) {
			setColliderStyle(mesh, false)
			setPickableHidden(mesh, false)
			mesh.visible = true
		}
	} else if (showColliders && world.state === "generated") {
		world.setCollidersVisible(true) // debug overlay: wireframe block-out over the splats
	} else {
		// View renders splats ONLY — no blocks, no floor plate. True hiding (visible=false)
		// keeps the block-out out of both drawing and the lasso's splat-only hit testing.
		for (const mesh of world.allBlockoutMeshes()) {
			setColliderStyle(mesh, false)
			mesh.visible = false
		}
	}
	refreshPaintToolBlockStyle()
	syncPlacementPreview()
	updateTransformGizmo()
	syncViewGate()
	renderFramesPanel()
}

// --- Raycasting / placement -------------------------------------------------

function pointerFromEvent(event) {
	const rect = renderer.domElement.getBoundingClientRect()
	pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
	pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
}

function raycast(event, objects, recursive = false) {
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	return raycaster.intersectObjects(objects, recursive)[0] ?? null
}

function paintGroundHit(event) {
	return world.ground.visible ? raycast(event, [world.ground]) : null
}

function surfaceHit(event, exclude = null) {
	const skip = exclude instanceof Set ? exclude : exclude ? new Set([exclude]) : null
	const objects = world.raycastables().filter(mesh => !(skip?.has(mesh)))
	const hit = raycast(event, objects)
	if (!hit) return null
	const normal = hit.face?.normal ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0)
	normalMatrix.getNormalMatrix(hit.object.matrixWorld)
	normal.applyMatrix3(normalMatrix).normalize()
	return { point: hit.point.clone(), normal, object: hit.object, face: hit.face, uv: hit.uv }
}

function placeMeshOnSurface(mesh, hit) {
	if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
	const anchor = placementAnchor(hit)
	const normal = placementNormalFromHit(hit)
	const bottom = mesh.geometry.boundingBox.min.y * Math.abs(mesh.scale.y)
	alignMeshToNormal(mesh, normal)
	mesh.position.copy(anchor).addScaledVector(normal, -bottom + 0.006)
}

// Blocks land exactly where the cursor points — on the ground AND anywhere on another
// block's face (no snapping to the face centre). Orientation still snaps to the face
// (placementNormalFromHit), only the position is free. Elevated ground maps the hit
// onto the curved surface height.
function placementAnchor(hit) {
	return hit.point.clone()
}

function placementNormalFromHit(hit) {
	if (hit.object.userData.isGround || hit.object.userData.locked) {
		return hit.normal.clone()
	}
	const axis = hitFaceAxis(hit)
	localFaceNormal.set(0, 0, 0)
	localFaceNormal[axis.name] = axis.sign
	normalMatrix.getNormalMatrix(hit.object.matrixWorld)
	return placementNormal.copy(localFaceNormal).applyMatrix3(normalMatrix).normalize().clone()
}

function hitFaceAxis(hit) {
	const normal = hit.face?.normal ?? localUp
	localFaceNormal.copy(normal).normalize()
	const x = Math.abs(localFaceNormal.x)
	const y = Math.abs(localFaceNormal.y)
	const z = Math.abs(localFaceNormal.z)
	if (x >= y && x >= z) return { name: "x", sign: Math.sign(localFaceNormal.x) || 1 }
	if (y >= x && y >= z) return { name: "y", sign: Math.sign(localFaceNormal.y) || 1 }
	return { name: "z", sign: Math.sign(localFaceNormal.z) || 1 }
}

function alignMeshToNormal(mesh, normal) {
	if (mesh.userData.manualRotation) return
	mesh.quaternion.setFromUnitVectors(localUp, normal)
}

// --- Attachment graph -------------------------------------------------------
// Every block remembers the block it was seated on (`support`) and which face of
// that support it sits against (`supportAxis`, in the support's local space). The
// support forest only drives the SCALE drag now (a growing face has to know which
// blocks are seated on it); moving and rotating treat the whole connected cluster
// as the object — see objectClusterOf.

function recordSupport(mesh, hit) {
	const onPrim = Boolean(hit) && !hit.object.userData.isGround && !hit.object.userData.locked && world.primitives.includes(hit.object)
	mesh.userData.support = onPrim ? hit.object : null
	mesh.userData.supportAxis = onPrim ? hitFaceAxis(hit) : { name: "y", sign: 1 }
}

// All blocks transitively seated on `mesh` (its dependents), nearest first. Only the
// scale drag uses this narrow face-seated view; everything else uses objectClusterOf.
function collectSupportSubtree(mesh) {
	const out = []
	const seen = new Set([mesh])
	const stack = [mesh]
	while (stack.length) {
		const parent = stack.pop()
		for (const p of world.primitives) {
			if (p.userData.support === parent && !seen.has(p)) {
				seen.add(p)
				out.push(p)
				stack.push(p)
			}
		}
	}
	return out
}

// Every OTHER block in the same connected cluster as `mesh` — "the object". Blocks
// count as connected generally (touching or overlapping, the same computeObjects rule
// used by scene segmentation), not just when one was placed on the other's face,
// so grabbing or rotating any block of an object carries the whole object with it.
function objectClusterOf(mesh) {
	const group = computeObjects(world.primitives).find(g => g.primitives.includes(mesh))
	return group ? group.primitives.filter(p => p !== mesh) : []
}

// Local-space centre of the bounding box.
function boundsCenter(mesh, out) {
	if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
	const b = mesh.geometry.boundingBox
	return out.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2)
}

// Local-space centre of the bounding-box face facing `axis` (e.g. {name:"y",sign:1} = top).
function faceLocalPoint(mesh, axis, out) {
	if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
	const b = mesh.geometry.boundingBox
	boundsCenter(mesh, out)
	out[axis.name] = axis.sign > 0 ? b.max[axis.name] : b.min[axis.name]
	return out
}

function updatePlacement(event) {
	if (!placementPreview) return
	const hit = surfaceHit(event)
	if (!hit) {
		placementPreview.visible = false
		return
	}
	placementPreview.visible = true
	placeMeshOnSurface(placementPreview, hit)
}

// --- Camera (single orbit around the world) ---------------------------------

const orbit = {
	target: new THREE.Vector3(0, floorSize * 0.05, 0),
	radius: floorSize * 2.3,
	theta: FRONT_THETA, // open the editor at the same isometric angle objects are captured from
	phi: FRONT_PHI,
}

function updateCamera() {
	if (camMode !== "orbit") return // fly/playback own the camera; orbit params still update silently
	orbit.phi = Math.max(0.12, Math.min(Math.PI * 0.49, orbit.phi))
	// Raw inspection changes only the camera: the uploaded splat itself remains untouched.
	// Its native scale can be far outside the editor's normal 4..128 orbit range.
	const minRadius = rawSplatPreview ? 0.001 : 4
	const maxRadius = rawSplatPreview ? 1e7 : Math.max(floorSize * 8, GROUND_SHEET_SIZE * 2)
	orbit.radius = Math.max(minRadius, Math.min(maxRadius, orbit.radius))
	camera.up.set(0, 1, 0)
	camera.position.copy(orbit.target).add(scratch.setFromSpherical(new THREE.Spherical(orbit.radius, orbit.phi, orbit.theta)))
	camera.lookAt(orbit.target)
	// Scale the near plane with zoom: a fixed 0.03 near starves the depth buffer of
	// precision at distance, so contact edges (blocks seated 6mm above the ground, slope
	// previews, splat/mesh intersections) z-fight once zoomed out. Nothing ever sits
	// within 2% of the orbit radius from the camera, so raising it never clips geometry.
	camera.near = rawSplatPreview ? Math.max(0.00001, orbit.radius / 10000) : Math.min(2, Math.max(0.03, orbit.radius * 0.02))
	camera.far = rawSplatPreview ? Math.max(400, orbit.radius * 20) : Math.max(400, orbit.radius * 2.5)
	camera.fov = 50
	camera.updateProjectionMatrix()
}

function startOrbit(event) {
	drag = { mode: "orbit", pointerId: event.pointerId, x: event.clientX, y: event.clientY }
	renderer.domElement.setPointerCapture(event.pointerId)
}

function updateOrbit(event) {
	const dx = event.clientX - drag.x
	const dy = event.clientY - drag.y
	drag.x = event.clientX
	drag.y = event.clientY
	orbit.theta -= dx * 0.006
	orbit.phi -= dy * 0.006
	updateCamera()
}

// --- First-person fly camera + camera path shots ---------------------------------
// Fly: pointer-lock WASD like a game (Space/Q–E vertical, Shift boost, scroll speed).
// Shots: saved camera poses in the cam bar; Play flies the camera through them
// Spline-style — centripetal Catmull-Rom for position, quaternion slerp for the look,
// eased per segment so each shot settles before leaving. Shots persist with the
// frames state, so a composed path survives reloads.

let camMode = "orbit" // "orbit" | "fly" | "anim" | "play" — anything but "orbit" owns the camera
const fly = {
	keys: new Set(),
	yaw: 0,
	pitch: 0,
	vel: new THREE.Vector3(),
	speed: floorSize * 0.9,
}
const camShots = []
let nextShotId = 0
let camAnim = null
const SHOT_SEGMENT_MS = 2000

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13 -8z"></path></svg>'
const STOP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z"></path></svg>'

function enterFly() {
	if (camMode === "fly" || rawSplatPreview) return
	stopCamPlayback()
	camMode = "fly"
	const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ")
	fly.yaw = euler.y
	fly.pitch = euler.x
	fly.vel.set(0, 0, 0)
	fly.keys.clear()
	camera.near = 0.03
	camera.far = 400
	camera.updateProjectionMatrix()
	els.flyBtn?.blur() // Space must fly up, not re-click the still-focused button
	syncFlyUi()
	// Pointer lock is the good path (raw deltas, hidden cursor), but fly must survive
	// without it — some browsers/embeds refuse the lock; look then rides plain mouse
	// moves, whose events carry the same movementX/Y deltas.
	try {
		renderer.domElement.requestPointerLock()?.catch?.(() => {})
	} catch { /* unsupported — unlocked fly still works */ }
}

function exitFly() {
	if (camMode !== "fly") return
	camMode = "orbit"
	fly.keys.clear()
	if (document.pointerLockElement === renderer.domElement) document.exitPointerLock()
	orbitFromCamera()
	syncFlyUi()
}

function syncFlyUi() {
	els.flyBtn?.classList.toggle("active", camMode === "fly")
	els.flyHint?.classList.toggle("hidden", camMode !== "fly")
	document.body.classList.toggle("is-flying", camMode === "fly")
}

// The browser releases the lock itself on Esc — treat any lock loss mid-flight as the
// exit signal. (Unlocked fly exits through the Escape branch of the fly key handler.)
document.addEventListener("pointerlockchange", () => {
	if (!document.pointerLockElement && camMode === "fly") exitFly()
})

function flyLook(event) {
	fly.yaw -= event.movementX * 0.0022
	fly.pitch = Math.max(-1.55, Math.min(1.55, fly.pitch - event.movementY * 0.0022))
	camera.quaternion.setFromEuler(new THREE.Euler(fly.pitch, fly.yaw, 0, "YXZ"))
}

function updateFlyCamera(dt) {
	const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
	const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize()
	const wish = new THREE.Vector3()
	if (fly.keys.has("KeyW")) wish.add(forward)
	if (fly.keys.has("KeyS")) wish.sub(forward)
	if (fly.keys.has("KeyD")) wish.add(right)
	if (fly.keys.has("KeyA")) wish.sub(right)
	if (fly.keys.has("Space") || fly.keys.has("KeyE")) wish.y += 1
	if (fly.keys.has("ControlLeft") || fly.keys.has("ControlRight") || fly.keys.has("KeyQ")) wish.y -= 1
	if (wish.lengthSq() > 0) {
		const boost = fly.keys.has("ShiftLeft") || fly.keys.has("ShiftRight") ? 3 : 1
		wish.normalize().multiplyScalar(fly.speed * boost)
	}
	fly.vel.lerp(wish, 1 - Math.exp(-dt * 12)) // short ease so starts/stops feel flown, not teleported
	camera.position.addScaledVector(fly.vel, dt)
}

document.addEventListener("keydown", event => {
	if (camMode !== "fly") return
	if (event.code === "Escape") {
		exitFly()
		return
	}
	fly.keys.add(event.code)
	if (event.code === "Space") event.preventDefault() // page scroll
})

document.addEventListener("keyup", event => fly.keys.delete(event.code))

// Rebuild the orbit rig around wherever flying/playback left the camera, so leaving
// those modes doesn't snap the view: pivot where the view ray meets the ground, or a
// stable distance ahead when looking at the horizon or up.
function orbitFromCamera() {
	const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
	const reach = forward.y < -0.05
		? Math.min(floorSize * 8, Math.max(4, -camera.position.y / forward.y))
		: floorSize
	orbit.target.copy(camera.position).addScaledVector(forward, reach)
	const sph = new THREE.Spherical().setFromVector3(new THREE.Vector3().subVectors(camera.position, orbit.target))
	orbit.radius = sph.radius
	orbit.theta = sph.theta
	orbit.phi = sph.phi
	updateCamera()
}

// --- Third-person play mode (the Play tab) -----------------------------------------
// The player walks the generated splats using voxel columns computed from the
// gaussians themselves (player.js owns the physics and WASD; the block-out primitives
// never collide). The renderer routes input: a pointer drag on
// the canvas is camera look, wheel is zoom. The drawable sheet is flat, so ground
// height is constant; the walkable area is the rectangle of drawn ink, captured once
// per play session. Pixel ratio drops to 1x during play to cut splat fill cost.

const playBounds = new THREE.Box3()
let playColliderHelpers = null // debug: the Colliders toggle draws the player's boxes in Play
let playGroundHelper = null // debug: the baked ground heightfield lattice, same toggle

const player = createPlayer({
	camera,
	world,
	groundHeightAt: () => groundTopY,
	clampToGround: (pos, radius) => {
		pos.x = Math.max(playBounds.min.x + radius, Math.min(playBounds.max.x - radius, pos.x))
		pos.z = Math.max(playBounds.min.z + radius, Math.min(playBounds.max.z - radius, pos.z))
	},
	getBounds: () => playBounds,
})

function enterPlay() {
	if (camMode === "fly") exitFly()
	stopCamPlayback()
	camMode = "play"
	const ink = world.groundInkBounds()
	if (ink) playBounds.copy(ink)
	else playBounds.set(new THREE.Vector3(-floorSize / 2, 0, -floorSize / 2), new THREE.Vector3(floorSize / 2, groundTopY, floorSize / 2))
	player.spawn(playBounds.getCenter(new THREE.Vector3()))
	player.attach()
	syncPlayColliderHelpers()
	camera.near = 0.05
	camera.far = 400
	camera.fov = 50
	camera.updateProjectionMatrix()
	renderer.setPixelRatio(1)
	els.playHint?.classList.remove("hidden")
}

function exitPlay() {
	if (camMode !== "play") return
	camMode = "orbit"
	player.hide()
	player.detach()
	syncPlayColliderHelpers()
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
	els.playHint?.classList.add("hidden")
	orbitFromCamera()
}

// syncPlayColliderHelpers draws what physics actually stands on whenever the
// Colliders debug toggle is on during play: the baked ground heightfield as a
// lattice, plus the collision boxes (one merged LineSegments each — helper-per-box
// would be thousands of draw calls). Torn down otherwise.
function syncPlayColliderHelpers() {
	if (playColliderHelpers) {
		playColliderHelpers.geometry.dispose()
		playColliderHelpers.material.dispose()
		scene.remove(playColliderHelpers)
		playColliderHelpers = null
	}
	if (playGroundHelper) {
		playGroundHelper.geometry.dispose()
		playGroundHelper.material.dispose()
		scene.remove(playGroundHelper)
		playGroundHelper = null
	}
	if (camMode !== "play" || !showColliders) return
	const field = player.groundField()
	if (field) {
		playGroundHelper = new THREE.LineSegments(field.toDebugGeometry(), new THREE.LineBasicMaterial({ color: 0x2f9e44, transparent: true, opacity: 0.6 }))
		scene.add(playGroundHelper)
	}
	const boxes = player.colliderBoxes()
	if (!boxes.length) return
	const edge = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
	const positions = new Float32Array(boxes.length * edge.length * 6)
	let o = 0
	const corner = i => (box, out) => out.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
	const corners = Array.from({ length: 8 }, (_, i) => corner(i))
	const p = new THREE.Vector3()
	for (const box of boxes) {
		for (const [a, b] of edge) {
			corners[a](box, p)
			positions[o++] = p.x; positions[o++] = p.y; positions[o++] = p.z
			corners[b](box, p)
			positions[o++] = p.x; positions[o++] = p.y; positions[o++] = p.z
		}
	}
	const geometry = new THREE.BufferGeometry()
	geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
	playColliderHelpers = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: colliderColor, transparent: true, opacity: 0.5 }))
	scene.add(playColliderHelpers)
}

function updatePlayLook(event) {
	player.addLook(event.clientX - drag.x, event.clientY - drag.y)
	drag.x = event.clientX
	drag.y = event.clientY
}

function addCamShot() {
	camShots.push({
		id: ++nextShotId,
		position: camera.position.toArray(),
		quaternion: camera.quaternion.toArray(),
	})
	renderShotChips()
	persistFramesSoon()
}

function deleteCamShot(id) {
	const i = camShots.findIndex(s => s.id === id)
	if (i < 0) return
	camShots.splice(i, 1)
	if (camShots.length < 2) stopCamPlayback()
	renderShotChips()
	persistFramesSoon()
}

function applyCamShot(shot) {
	camera.position.fromArray(shot.position)
	camera.quaternion.fromArray(shot.quaternion)
	if (camMode === "fly") {
		const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ")
		fly.yaw = euler.y
		fly.pitch = euler.x
	} else {
		orbitFromCamera()
	}
}

function renderShotChips() {
	if (!els.shotChips) return
	els.shotChips.replaceChildren()
	camShots.forEach((shot, i) => {
		const chip = document.createElement("button")
		chip.className = "shot-chip"
		chip.type = "button"
		chip.textContent = String(i + 1)
		chip.title = `Jump to shot ${i + 1}`
		chip.addEventListener("click", () => {
			stopCamPlayback()
			applyCamShot(shot)
		})
		const del = document.createElement("span") // buttons can't nest — span with a click
		del.className = "shot-del"
		del.textContent = "×"
		del.title = "Delete this shot"
		del.addEventListener("click", event => {
			event.stopPropagation()
			deleteCamShot(shot.id)
		})
		chip.appendChild(del)
		els.shotChips.appendChild(chip)
	})
	if (els.shotPlay) els.shotPlay.disabled = camShots.length < 2
	if (els.shotExport) els.shotExport.disabled = camShots.length < 2
}

const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

function playCamPath() {
	if (camMode === "anim") {
		stopCamPlayback()
		return
	}
	if (camShots.length < 2) return
	if (camMode === "fly") exitFly()
	camAnim = {
		start: performance.now(),
		duration: (camShots.length - 1) * SHOT_SEGMENT_MS,
		curve: new THREE.CatmullRomCurve3(camShots.map(s => new THREE.Vector3().fromArray(s.position)), false, "centripetal", 0.5),
		quats: camShots.map(s => new THREE.Quaternion().fromArray(s.quaternion)),
	}
	camMode = "anim"
	document.body.classList.add("is-cam-playing")
	if (els.shotPlay) {
		els.shotPlay.blur() // keep Space/Enter from toggling playback invisibly later
		els.shotPlay.innerHTML = STOP_ICON
		els.shotPlay.title = "Stop the camera path"
	}
}

function stopCamPlayback() {
	if (camMode !== "anim") return
	camMode = "orbit"
	camAnim = null
	document.body.classList.remove("is-cam-playing")
	if (els.shotPlay) {
		els.shotPlay.innerHTML = PLAY_ICON
		els.shotPlay.title = "Play the camera path through the shots"
	}
	if (camRecorder) {
		const rec = camRecorder
		camRecorder = null // stopping flushes the last chunk, then onstop downloads the file
		rec.stop()
	}
	orbitFromCamera()
}

// Export = record the play-through. The recording is taken straight off the WebGL
// canvas (captureStream), so it is exclusively the rendered world — DOM UI, hints and
// the cursor physically cannot appear in the file, matching the GUI-free playback.
let camRecorder = null

function exportCamPath() {
	if (camShots.length < 2 || camMode === "anim") return
	if (typeof MediaRecorder === "undefined" || !renderer.domElement.captureStream) {
		setStatus("Video export isn't supported in this browser")
		return
	}
	const stream = renderer.domElement.captureStream(60)
	const mime = ["video/webm;codecs=vp9", "video/webm"].find(m => MediaRecorder.isTypeSupported(m))
	const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 12_000_000 } : undefined)
	const chunks = []
	rec.ondataavailable = event => {
		if (event.data.size) chunks.push(event.data)
	}
	rec.onstop = () => {
		for (const track of stream.getTracks()) track.stop()
		downloadBlob(new Blob(chunks, { type: rec.mimeType || "video/webm" }), `flythrough-${Date.now()}.webm`)
	}
	rec.start()
	camRecorder = rec
	playCamPath()
	if (camMode !== "anim") { // playback refused to start — don't leave a recorder running
		camRecorder = null
		rec.onstop = () => stream.getTracks().forEach(track => track.stop())
		rec.stop()
	}
}

function updateCamAnim(now) {
	if (!camAnim) return
	// Clamp below as well as above: the first rAF timestamp after Play can sit BEFORE
	// the performance.now() captured at start (rAF stamps are vsync-aligned), and a
	// negative t would index the spline at points[-1] and crash the render loop.
	const t = Math.min(1, Math.max(0, (now - camAnim.start) / camAnim.duration))
	const segs = camAnim.quats.length - 1
	// CatmullRomCurve3.getPoint maps its parameter per segment, so (i + eased) / segs
	// samples segment i at the eased local weight — position and look stay in step.
	const x = Math.min(t * segs, segs - 1e-6)
	const i = Math.floor(x)
	const eased = easeInOutCubic(x - i)
	camera.position.copy(camAnim.curve.getPoint((i + eased) / segs))
	camera.quaternion.slerpQuaternions(camAnim.quats[i], camAnim.quats[i + 1], eased)
	if (t >= 1) stopCamPlayback()
}

// --- Primitive transform drags (scale / roll) -------------------------------

function startPrimitiveDrag(event, mesh, hit = null) {
	selectPrimitive(mesh)
	if (mesh.userData.isGround || mesh.userData.locked) return
	if (selectionTools.has(activeTool)) return
	const worldPosition = mesh.getWorldPosition(new THREE.Vector3())
	beginBuildAction() // undo checkpoint: scale / rotate (popped again if nothing moves)
	drag = {
		mode: activeTool === "rotate" ? "roll" : "scale",
		actionPushed: true,
		pointerId: event.pointerId,
		mesh,
		startX: event.clientX,
		startY: event.clientY,
		startScale: mesh.scale.clone(),
		startQuaternion: mesh.quaternion.clone(),
		rollAxis: rollAxis.copy(worldPosition).sub(camera.position).normalize().clone(),
		rollCenter: objectScreenPosition(worldPosition),
		startAngle: 0,
	}
	drag.startAngle = pointerScreenAngle(event, drag.rollCenter)
	if (drag.mode === "scale") setupScaleDrag(mesh, hit)
	if (drag.mode === "roll") setupRollDrag(mesh)
	renderer.domElement.setPointerCapture(event.pointerId)
	renderer.domElement.classList.add("is-dragging")
}

// Capture the rotating block's pivot and the start pose of every dependent, so the
// whole stack can turn as one rigid body and seated faces stay connected.
function setupRollDrag(mesh) {
	drag.roll = {
		pivot: mesh.getWorldPosition(new THREE.Vector3()),
		members: objectClusterOf(mesh).map(m => ({
			mesh: m,
			startPos: m.getWorldPosition(new THREE.Vector3()),
			startQuat: m.quaternion.clone(),
		})),
	}
}

function resizeCursorFromScreenVector(x, y) {
	const ax = Math.abs(x)
	const ay = Math.abs(y)
	if (ax > ay * 1.8) return "ew-resize"
	if (ay > ax * 1.8) return "ns-resize"
	return x * y >= 0 ? "nwse-resize" : "nesw-resize"
}

function scaleScreenFallback(point, axisWorld) {
	const start = objectScreenPosition(point)
	const end = objectScreenPosition(tmpFace.copy(point).add(axisWorld))
	const x = end.x - start.x
	const y = end.y - start.y
	const pixelsPerWorldUnit = Math.hypot(x, y)
	if (pixelsPerWorldUnit < 1e-4) {
		return { x: 0, y: -1, worldUnitsPerPixel: Math.max(0.001, orbit.radius / 900), cursor: "ns-resize" }
	}
	return {
		x: x / pixelsPerWorldUnit,
		y: y / pixelsPerWorldUnit,
		worldUnitsPerPixel: 1 / pixelsPerWorldUnit,
		cursor: resizeCursorFromScreenVector(x, y),
	}
}

function updateScaleHoverCursor(event) {
	if (activeTool !== "scale" || drag || uiTab !== "build") {
		renderer.domElement.style.removeProperty("cursor")
		return
	}
	const hit = raycast(event, world.selectables())
	if (!hit?.object || hit.object.userData.isGround || hit.object.userData.locked) {
		renderer.domElement.style.removeProperty("cursor")
		return
	}
	const axis = hitFaceAxis(hit)
	hit.object.updateWorldMatrix(true, false)
	normalMatrix.getNormalMatrix(hit.object.matrixWorld)
	scaleAxisDir.set(0, 0, 0)
	scaleAxisDir[axis.name] = axis.sign
	scaleAxisDir.applyMatrix3(normalMatrix).normalize()
	renderer.domElement.style.cursor = scaleScreenFallback(hit.point, scaleAxisDir).cursor
}

// Capture the exact grabbed face point, its outward world axis, the opposite pinned
// face, and every dependent stack. Pointer movement is solved in world space instead
// of applying an arbitrary scale-per-pixel sensitivity.
function setupScaleDrag(mesh, hit = null) {
	mesh.updateWorldMatrix(true, false)
	mesh.parent.updateWorldMatrix(true, false)
	const pickedAxis = hit ? hitFaceAxis(hit) : { name: "y", sign: 1 }
	const anchorAxis = { name: pickedAxis.name, sign: -pickedAxis.sign }
	const anchorLocal = faceLocalPoint(mesh, anchorAxis, new THREE.Vector3())
	const anchorWorld = mesh.localToWorld(anchorLocal.clone())
	const grabbedWorld = hit?.point?.clone?.() ?? mesh.localToWorld(faceLocalPoint(mesh, pickedAxis, new THREE.Vector3()))
	if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
	const bounds = mesh.geometry.boundingBox
	const localSpan = Math.max(1e-6, bounds.max[pickedAxis.name] - bounds.min[pickedAxis.name])
	scaleAxisDir.set(0, 0, 0)
	scaleAxisDir[pickedAxis.name] = pickedAxis.sign
	scaleAxisDir.applyQuaternion(mesh.quaternion)
	scaleParentMatrix.setFromMatrix4(mesh.parent.matrixWorld)
	scaleAxisDir.applyMatrix3(scaleParentMatrix)
	const worldUnitsPerScale = Math.max(1e-6, scaleAxisDir.length() * localSpan)
	const axisWorld = scaleAxisDir.normalize().clone()
	const screenFallback = scaleScreenFallback(grabbedWorld, axisWorld)
	const children = []
	for (const child of world.primitives) {
		if (child.userData.support !== mesh) continue
		const axis = child.userData.supportAxis ?? { name: "y", sign: 1 }
		const faceLocal = faceLocalPoint(mesh, axis, new THREE.Vector3())
		const subtree = [child, ...collectSupportSubtree(child)]
		children.push({
			faceLocal,
			startFaceWorld: mesh.localToWorld(faceLocal.clone()),
			subtree,
			startPos: subtree.map(m => m.getWorldPosition(new THREE.Vector3())),
		})
	}
	drag.scale = {
		mesh,
		axis: pickedAxis.name,
		axisWorld,
		grabbedWorld,
		worldUnitsPerScale,
		screenFallback,
		anchorLocal,
		anchorWorld,
		children,
	}
	renderer.domElement.style.cursor = screenFallback.cursor
}

function updatePrimitiveDrag(event) {
	if (drag.mode === "scale") {
		updateScaleDrag(event)
		return
	}
	if (drag.mode === "roll") {
		const delta = pointerScreenAngle(event, drag.rollCenter) - drag.startAngle
		if (Math.abs(delta) < 1e-6) return
		drag.mutated = true // the checkpoint pushed at drag start is now earned
		rollQuat.setFromAxisAngle(drag.rollAxis, delta)
		drag.mesh.quaternion.copy(rollQuat).multiply(drag.startQuaternion)
		drag.mesh.userData.manualRotation = true
		// Orbit each dependent around the rotating block's centre and spin it by the same
		// amount, so the whole stack turns rigidly and stays face-to-face.
		for (const m of drag.roll.members) {
			tmpWorld.copy(m.startPos).sub(drag.roll.pivot).applyQuaternion(rollQuat).add(drag.roll.pivot)
			world.group.worldToLocal(tmpWorld)
			m.mesh.position.copy(tmpWorld)
			m.mesh.quaternion.copy(rollQuat).multiply(m.startQuat)
			m.mesh.userData.manualRotation = true
		}
		return
	}
}

function updateScaleDrag(event) {
	const s = drag.scale
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	let worldDistance = closestAxisDistance(raycaster.ray.origin, raycaster.ray.direction, s.grabbedWorld, s.axisWorld)
	if (worldDistance == null) {
		const dx = event.clientX - drag.startX
		const dy = event.clientY - drag.startY
		worldDistance = (dx * s.screenFallback.x + dy * s.screenFallback.y) * s.screenFallback.worldUnitsPerPixel
	}
	const axis = s.axis
	const newScale = drag.startScale.clone()
	newScale[axis] = Math.max(0.05, drag.startScale[axis] + worldDistance / s.worldUnitsPerScale)
	if (Math.abs(newScale[axis] - drag.startScale[axis]) < 1e-6) return
	drag.mutated = true // the checkpoint pushed at drag start is now earned
	s.mesh.scale.copy(newScale)
	// Pin the opposite grabbed face so dragging outward grows and inward shrinks.
	tmpScale.copy(s.anchorLocal).multiply(newScale).applyQuaternion(s.mesh.quaternion)
	tmpWorld.copy(s.anchorWorld)
	s.mesh.parent.worldToLocal(tmpWorld)
	s.mesh.position.copy(tmpWorld).sub(tmpScale)
	s.mesh.updateWorldMatrix(true, false)
	// Drag every dependent stack along with the face it is seated on.
	for (const rec of s.children) {
		tmpFace.copy(rec.faceLocal)
		s.mesh.localToWorld(tmpFace)
		tmpDelta.copy(tmpFace).sub(rec.startFaceWorld)
		for (let i = 0; i < rec.subtree.length; i++) {
			tmpWorld.copy(rec.startPos[i]).add(tmpDelta)
			rec.subtree[i].parent.worldToLocal(tmpWorld)
			rec.subtree[i].position.copy(tmpWorld)
		}
	}
}

function objectScreenPosition(worldPosition) {
	const rect = renderer.domElement.getBoundingClientRect()
	const projected = worldPosition.clone().project(camera)
	return {
		x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
		y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
	}
}

function pointerScreenAngle(event, center) {
	return Math.atan2(event.clientY - center.y, event.clientX - center.x)
}

// --- Paint ------------------------------------------------------------------

function startPaint(event, erase = false) {
	beginBuildAction() // undo checkpoint: one paint stroke
	drag = { mode: "paint", pointerId: event.pointerId, erase, actionPushed: true, mutated: true }
	renderer.domElement.setPointerCapture(event.pointerId)
	paintAtEvent(event)
}

function paintAtEvent(event) {
	const hit = paintGroundHit(event)
	if (!hit) return
	world.paintAt(hit, Boolean(drag?.erase))
}

function finishGroundPaintStroke() {
	const active = drag?.groundStroke
	if (!active || !closeGroundStroke(active.stroke)) return
	const surface = active.tile.userData.paint
	paintGroundStroke(surface.ctx, surface.canvas, active.stroke, GROUND_SHEET_SIZE)
	active.tile.userData.paintVersion = (active.tile.userData.paintVersion || 0) + 1
	active.tile.userData.paintCache = null
	surface.texture.needsUpdate = true
}

// --- View-tab lasso + group transform ----------------------------------------
// A freehand screen-space lasso selects the semantic SplatMesh pieces produced by the
// one-shot segmentation pass. One contextual frame then owns all three transforms:
// drag inside to move, a corner to scale uniformly, or the top handle to rotate. The
// transforms act only on generated splats and never feed back into the Build block-out.

let viewTool = "orbit" // "orbit" | "lasso"
const selectedSplatMeshes = new Set()

const splatProxyMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false })
const splatSelectionMaterial = new THREE.LineBasicMaterial({ color: selectionAccent, transparent: true, opacity: 0.9 })
const splatDragPlane = new THREE.Plane()
const splatRotQuat = new THREE.Quaternion()
const splatDragPoint = new THREE.Vector3()
const splatWorldBounds = new THREE.Box3()
const splatBoxCorner = new THREE.Vector3()
const viewHandleHitRadius = 15

// Known source-geometry boxes projected through the generation camera
// ({label, box_2d:[y0,x0,y1,x1]} in 0-1000 image coords). They are deterministic,
// persisted with the build, and used as segmentation evidence + a per-piece wisp clip.
let sceneImageBoxes = null
window.__wsSetImageBoxes = boxes => {
	sceneImageBoxes = boxes
	if (sceneSession) sceneSession.imageBoxes = boxes
	scheduleSegmentationRetune()
	return `image boxes set (${boxes?.length ?? 0})`
}

function ensureSplatProxies() {
	for (const { mesh } of world.generated) {
		// Uncertain/unmatched reconstruction material stays visible as scene context, but
		// is deliberately not selectable or movable with a semantic object.
		if (mesh.userData.genKind === "remainder") continue
		if (mesh.userData.splatProxy?.parent === mesh) continue
		const cb = mesh.userData.contentBox
		if (!cb) continue
		const size = cb.getSize(new THREE.Vector3())
		const centre = cb.getCenter(new THREE.Vector3())
		if (mesh.userData.genKind === "floor") { // floor content boxes carry huge Y headroom — use a thin slab at ground level
			size.y = 0.6
			centre.y = cb.min.y + 0.3
		}
		const proxy = new THREE.Mesh(
			new THREE.BoxGeometry(Math.max(0.2, size.x), Math.max(0.2, size.y), Math.max(0.2, size.z)),
			splatProxyMaterial,
		)
		proxy.position.copy(centre)
		proxy.userData.isSplatProxy = true
		const outline = new THREE.LineSegments(new THREE.EdgesGeometry(proxy.geometry), splatSelectionMaterial)
		outline.userData.isSelectionOutline = true
		outline.visible = false
		proxy.add(outline)
		proxy.userData.outline = outline
		mesh.userData.splatProxy = proxy
		mesh.add(proxy)
	}
}

function setSplatSelection(meshes, append = false) {
	ensureSplatProxies()
	if (!append) deselectSplat()
	for (const mesh of meshes) {
		if (!mesh || mesh.userData.genKind !== "object") continue
		selectedSplatMeshes.add(mesh)
		const outline = mesh.userData.splatProxy?.userData.outline
		if (outline) outline.visible = true
	}
	syncViewTransformOverlay()
}

function deselectSplat() {
	for (const mesh of selectedSplatMeshes) {
		const outline = mesh.userData.splatProxy?.userData.outline
		if (outline) outline.visible = false
	}
	selectedSplatMeshes.clear()
	syncViewTransformOverlay()
}

function pruneSplatSelection() {
	const live = new Set(world.generated.map(record => record.mesh))
	for (const mesh of selectedSplatMeshes) {
		if (live.has(mesh)) continue
		const outline = mesh.userData.splatProxy?.userData.outline
		if (outline) outline.visible = false
		selectedSplatMeshes.delete(mesh)
	}
}

function raycastSplatProxies(event) {
	ensureSplatProxies()
	const proxies = world.generated
		.filter(g => g.mesh.userData.genKind === "object")
		.map(g => g.mesh.userData.splatProxy)
		.filter(Boolean)
	if (!proxies.length) return null
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	const hits = raycaster.intersectObjects(proxies, false)
	if (hits.length < 2) return hits[0] ?? null
	// Proxy boxes can overlap. Prefer the object whose projected centre is closest
	// to the pointer, using ray distance only as a stable tie-breaker.
	const projected = new THREE.Vector3()
	let best = hits[0]
	let bestScore = Infinity
	for (const hit of hits) {
		hit.object.getWorldPosition(projected).project(camera)
		const score = Math.hypot(projected.x - pointer.x, projected.y - pointer.y) + hit.distance * 1e-5
		if (score < bestScore) {
			best = hit
			bestScore = score
		}
	}
	return best
}

function forEachSplatBoxCorner(mesh, visit) {
	const box = mesh.userData.contentBox
	if (!box || box.isEmpty()) return
	mesh.updateWorldMatrix(true, false)
	for (const x of [box.min.x, box.max.x]) {
		for (const y of [box.min.y, box.max.y]) {
			for (const z of [box.min.z, box.max.z]) {
				splatBoxCorner.set(x, y, z)
				mesh.localToWorld(splatBoxCorner)
				visit(splatBoxCorner)
			}
		}
	}
}

function projectSplatScreenBounds(mesh) {
	const rect = renderer.domElement.getBoundingClientRect()
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
	forEachSplatBoxCorner(mesh, point => {
		point.project(camera)
		if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.z < -1.2 || point.z > 1.2) return
		const x = rect.left + (point.x * 0.5 + 0.5) * rect.width
		const y = rect.top + (-point.y * 0.5 + 0.5) * rect.height
		minX = Math.min(minX, x)
		minY = Math.min(minY, y)
		maxX = Math.max(maxX, x)
		maxY = Math.max(maxY, y)
	})
	return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

function selectedSplatPivot(bottom = false) {
	splatWorldBounds.makeEmpty()
	for (const mesh of selectedSplatMeshes) {
		forEachSplatBoxCorner(mesh, point => splatWorldBounds.expandByPoint(point))
	}
	if (splatWorldBounds.isEmpty()) return null
	const pivot = splatWorldBounds.getCenter(new THREE.Vector3())
	if (bottom) pivot.y = splatWorldBounds.min.y
	return pivot
}

function viewSelectionGeometry() {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
	for (const mesh of selectedSplatMeshes) {
		const bounds = projectSplatScreenBounds(mesh)
		if (!bounds) continue
		minX = Math.min(minX, bounds.minX)
		minY = Math.min(minY, bounds.minY)
		maxX = Math.max(maxX, bounds.maxX)
		maxY = Math.max(maxY, bounds.maxY)
	}
	if (!Number.isFinite(minX)) return null
	const pad = 9
	minX -= pad
	minY -= pad
	maxX += pad
	maxY += pad
	const pivot = selectedSplatPivot(false)
	const move = pivot ? objectScreenPosition(pivot) : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
	return {
		minX, minY, maxX, maxY, move,
		rotate: { x: (minX + maxX) / 2, y: minY - 30 },
		corners: {
			nw: { x: minX, y: minY }, ne: { x: maxX, y: minY },
			se: { x: maxX, y: maxY }, sw: { x: minX, y: maxY },
		},
	}
}

function syncViewTransformOverlay() {
	pruneSplatSelection()
	const active = uiTab === "view" && viewTool === "lasso" && !rawSplatPreview
	els.viewTransformOverlay?.classList.toggle("hidden", !active)
	if (!active) {
		els.viewSelectionFrame?.classList.add("hidden")
		els.viewLassoPath?.classList.add("hidden")
		return
	}
	const geometry = viewSelectionGeometry()
	els.viewSelectionFrame?.classList.toggle("hidden", !geometry)
	if (!geometry) return
	const width = Math.max(1, geometry.maxX - geometry.minX)
	const height = Math.max(1, geometry.maxY - geometry.minY)
	els.viewSelectionBox.setAttribute("x", geometry.minX)
	els.viewSelectionBox.setAttribute("y", geometry.minY)
	els.viewSelectionBox.setAttribute("width", width)
	els.viewSelectionBox.setAttribute("height", height)
	els.viewRotateStem.setAttribute("x1", geometry.rotate.x)
	els.viewRotateStem.setAttribute("y1", geometry.minY)
	els.viewRotateStem.setAttribute("x2", geometry.rotate.x)
	els.viewRotateStem.setAttribute("y2", geometry.rotate.y)
	els.viewRotateHandle.setAttribute("cx", geometry.rotate.x)
	els.viewRotateHandle.setAttribute("cy", geometry.rotate.y)
	els.viewMoveHandle.setAttribute("cx", geometry.move.x)
	els.viewMoveHandle.setAttribute("cy", geometry.move.y)
	for (const handle of els.viewScaleHandles) {
		const point = geometry.corners[handle.dataset.viewScaleHandle]
		handle.setAttribute("x", point.x - 6)
		handle.setAttribute("y", point.y - 6)
	}
}

function viewTransformHit(event) {
	const geometry = viewSelectionGeometry()
	if (!geometry) return null
	const point = { x: event.clientX, y: event.clientY }
	if (Math.hypot(point.x - geometry.rotate.x, point.y - geometry.rotate.y) <= viewHandleHitRadius) return "rotate"
	for (const corner of Object.values(geometry.corners)) {
		if (Math.hypot(point.x - corner.x, point.y - corner.y) <= viewHandleHitRadius) return "scale"
	}
	if (point.x >= geometry.minX && point.x <= geometry.maxX && point.y >= geometry.minY && point.y <= geometry.maxY) return "move"
	return null
}

function setViewTransformCursor(mode = null) {
	renderer.domElement.classList.toggle("is-splat-move", mode === "move")
	renderer.domElement.classList.toggle("is-splat-scale", mode === "scale")
	renderer.domElement.classList.toggle("is-splat-rotate", mode === "rotate")
}

function startSplatGroupDrag(event, mode) {
	const pivot = selectedSplatPivot(mode === "scale")
	if (!pivot || !selectedSplatMeshes.size) return false
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	splatDragPlane.set(localUp, -pivot.y)
	const startPoint = raycaster.ray.intersectPlane(splatDragPlane, splatDragPoint)
		? splatDragPoint.clone()
		: pivot.clone()
	const members = [...selectedSplatMeshes].map(mesh => ({
		mesh,
		position: mesh.position.clone(),
		quaternion: mesh.quaternion.clone(),
		scale: mesh.scale.clone(),
	}))
	drag = {
		mode: `splat-${mode}`,
		pointerId: event.pointerId,
		members,
		pivot,
		startPoint,
		startX: event.clientX,
		startY: event.clientY,
		rollAxis: pivot.clone().sub(camera.position).normalize(),
		rollCenter: objectScreenPosition(pivot),
	}
	drag.startAngle = pointerScreenAngle(event, drag.rollCenter)
	renderer.domElement.setPointerCapture(event.pointerId)
	renderer.domElement.classList.add("is-dragging")
	return true
}

function startSplatLasso(event) {
	drag = {
		mode: "splat-lasso",
		pointerId: event.pointerId,
		append: event.shiftKey,
		points: [{ x: event.clientX, y: event.clientY }],
	}
	renderer.domElement.setPointerCapture(event.pointerId)
	els.viewLassoPath.classList.remove("hidden")
	syncSplatLassoPath()
}

function syncSplatLassoPath() {
	const points = drag?.mode === "splat-lasso" ? drag.points : []
	if (!points.length) {
		els.viewLassoPath.classList.add("hidden")
		els.viewLassoPath.setAttribute("d", "")
		return
	}
	const [first, ...rest] = points
	const closed = points.length > 2 ? " Z" : ""
	els.viewLassoPath.setAttribute("d", `M ${first.x} ${first.y}${rest.map(point => ` L ${point.x} ${point.y}`).join("")}${closed}`)
}

function updateSplatLasso(event) {
	const point = { x: event.clientX, y: event.clientY }
	const last = drag.points.at(-1)
	if (Math.hypot(point.x - last.x, point.y - last.y) < 3) return
	drag.points.push(point)
	syncSplatLassoPath()
}

function pointInPolygon(point, polygon) {
	let inside = false
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i], b = polygon[j]
		if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
	}
	return inside
}

function cross2d(a, b, c) {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function pointOnSegment(point, a, b) {
	return Math.abs(cross2d(a, b, point)) < 1e-6 &&
		point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) &&
		point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)
}

function segmentsIntersect(a, b, c, d) {
	const abC = cross2d(a, b, c), abD = cross2d(a, b, d)
	const cdA = cross2d(c, d, a), cdB = cross2d(c, d, b)
	if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true
	return (Math.abs(abC) < 1e-6 && pointOnSegment(c, a, b)) ||
		(Math.abs(abD) < 1e-6 && pointOnSegment(d, a, b)) ||
		(Math.abs(cdA) < 1e-6 && pointOnSegment(a, c, d)) ||
		(Math.abs(cdB) < 1e-6 && pointOnSegment(b, c, d))
}

function polygonOverlapsBounds(polygon, bounds) {
	const corners = [
		{ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
		{ x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY },
	]
	if (polygon.some(point => point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY)) return true
	if (corners.some(point => pointInPolygon(point, polygon))) return true
	for (let i = 0; i < polygon.length; i++) {
		const a = polygon[i], b = polygon[(i + 1) % polygon.length]
		for (let j = 0; j < corners.length; j++) {
			if (segmentsIntersect(a, b, corners[j], corners[(j + 1) % corners.length])) return true
		}
	}
	return false
}

function finishSplatLasso(event) {
	updateSplatLasso(event)
	const points = drag.points
	const minX = Math.min(...points.map(point => point.x))
	const minY = Math.min(...points.map(point => point.y))
	const maxX = Math.max(...points.map(point => point.x))
	const maxY = Math.max(...points.map(point => point.y))
	let meshes = []
	if (points.length < 3 || Math.max(maxX - minX, maxY - minY) < 8) {
		const hit = raycastSplatProxies(event)
		if (hit?.object?.parent) meshes = [hit.object.parent]
	} else {
		meshes = world.generated
			.map(record => record.mesh)
			.filter(mesh => mesh.visible && mesh.userData.genKind === "object")
			.filter(mesh => {
				const bounds = projectSplatScreenBounds(mesh)
				return bounds && polygonOverlapsBounds(points, bounds)
			})
	}
	setSplatSelection(meshes, drag.append)
	els.viewLassoPath.classList.add("hidden")
	els.viewLassoPath.setAttribute("d", "")
}

// Drag on the horizontal plane through the grab point; hold Shift to move vertically.
function updateSplatMove(event) {
	if (event.shiftKey) {
		const dy = (drag.startY - event.clientY) * 0.02
		for (const member of drag.members) {
			member.mesh.position.set(member.position.x, member.position.y + dy, member.position.z)
		}
		if (Math.abs(dy) > 0.001) drag.mutated = true
		return
	}
	splatDragPlane.set(localUp, -drag.startPoint.y)
	pointerFromEvent(event)
	raycaster.setFromCamera(pointer, camera)
	if (!raycaster.ray.intersectPlane(splatDragPlane, splatDragPoint)) return
	const dx = splatDragPoint.x - drag.startPoint.x
	const dz = splatDragPoint.z - drag.startPoint.z
	for (const member of drag.members) {
		member.mesh.position.set(member.position.x + dx, member.position.y, member.position.z + dz)
	}
	if (Math.hypot(dx, dz) > 0.001) drag.mutated = true
}

// Uniform group scale from the combined bottom centre so the selection stays seated
// while the objects and all spacing between them grow or shrink together.
function updateSplatScale(event) {
	const delta = (event.clientX - drag.startX) - (event.clientY - drag.startY)
	const factor = Math.min(6, Math.max(0.15, Math.exp(delta * 0.01)))
	for (const member of drag.members) {
		member.mesh.scale.copy(member.scale).multiplyScalar(factor)
		member.mesh.position.copy(member.position).sub(drag.pivot).multiplyScalar(factor).add(drag.pivot)
	}
	if (Math.abs(factor - 1) > 0.001) drag.mutated = true
}

// Pointer angle around the selection centre rotates every member and its offset from the
// shared pivot, preserving the selected arrangement as one rigid group.
function updateSplatRotate(event) {
	const angle = pointerScreenAngle(event, drag.rollCenter) - drag.startAngle
	splatRotQuat.setFromAxisAngle(drag.rollAxis, angle)
	for (const member of drag.members) {
		member.mesh.quaternion.copy(splatRotQuat).multiply(member.quaternion)
		member.mesh.position.copy(member.position).sub(drag.pivot).applyQuaternion(splatRotQuat).add(drag.pivot)
	}
	if (Math.abs(angle) > 0.001) drag.mutated = true
}

function setViewTool(tool) {
	if (tool !== "orbit" && tool !== "lasso") return
	viewTool = tool
	for (const button of els.viewToolButtons) button.classList.toggle("active", button.dataset.viewTool === tool)
	renderer.domElement.classList.toggle("is-splat-lasso", tool === "lasso")
	setViewTransformCursor()
	syncViewTransformOverlay()
}

// --- Pointer routing --------------------------------------------------------

function pointerDown(event) {
	if (camMode === "fly") return // pointer-locked flight: clicks are not scene input
	if (camMode === "anim") {
		stopCamPlayback() // any click on the world cancels the flythrough
		return
	}
	if (camMode === "play") {
		// Any button drags the third-person camera; everything else about play is keyboard.
		event.preventDefault()
		drag = { mode: "play-look", pointerId: event.pointerId, x: event.clientX, y: event.clientY }
		renderer.domElement.setPointerCapture(event.pointerId)
		return
	}
	// Right-drag is always camera orbit, regardless of the active Build/View tool.
	// Route it before any tool hit-testing so it can never paint, place, select, or
	// transform scene content.
	if (event.button === 2) {
		event.preventDefault()
		startOrbit(event)
		return
	}
	if (event.button !== 0) return
	if (generating) {
		startOrbit(event) // only camera movement while generating
		return
	}
	if (rawSplatPreview) {
		startOrbit(event) // raw view is deliberately inspection-only
		return
	}
	if (uiTab === "view") {
		if (viewTool === "lasso") {
			const transform = selectedSplatMeshes.size ? viewTransformHit(event) : null
			if (transform && startSplatGroupDrag(event, transform)) return
			startSplatLasso(event)
			return
		}
		startOrbit(event)
		return
	}

	const hitGizmo = gizmoHit(event)
	if (hitGizmo?.object && startGizmoDrag(event, hitGizmo.object)) return

	if (activeTool === "paint") {
		if (paintGroundHit(event)) startPaint(event)
		else startOrbit(event)
		return
	}

	if (shapeTools.has(activeTool)) {
		const hit = surfaceHit(event)
		if (hit) {
			beginBuildAction() // undo checkpoint: block placement
			world.addPrimitive(activeTool, hit)
		} else startOrbit(event)
		return
	}

	// pointer / move / scale / rotate / eraser act on a selectable block-out mesh under the cursor.
	const hit = raycast(event, world.selectables())
	// The drawable ground sheet is not selectable: its colour comes from painting.
	// Only the eraser interacts with it here (removing
	// drawn ground); every other tool treats a sheet hit — ink or void — as empty space.
	if (hit?.object?.userData.isGroundSheet && activeTool !== "eraser") {
		if (selectionTools.has(activeTool)) selectPrimitive(null)
		startOrbit(event)
		return
	}
	if (hit?.object) {
		if (activeTool === "eraser") {
			if (hit.object.userData.isGroundSheet || hit.object.userData.tile?.userData?.isGroundSheet) {
				startPaint(event, true) // erasing the sheet removes drawn ground (stroke, not select)
				return
			}
			if (hit.object.userData.isGround || hit.object.userData.locked) {
				selectPrimitive(hit.object)
				return
			}
			beginBuildAction() // undo checkpoint: block removal
			world.removePrimitive(hit.object)
			return
		}
		if (activeTool === "scale" || activeTool === "rotate") startPrimitiveDrag(event, hit.object, hit)
		else if (activeTool === "move") startPrimitiveMoveDrag(event, hit.object, hit)
		else selectPrimitive(hit.object)
		return
	}
	if (selectionTools.has(activeTool)) selectPrimitive(null)
	startOrbit(event)
}

renderer.domElement.addEventListener("pointerdown", pointerDown)
renderer.domElement.addEventListener("contextmenu", event => event.preventDefault())

renderer.domElement.addEventListener("pointermove", event => {
	if (camMode === "fly") {
		flyLook(event)
		return
	}
	if (camMode === "anim") return
	if (drag?.mode === "orbit") updateOrbit(event)
	else if (drag?.mode === "play-look") updatePlayLook(event)
	else if (drag?.mode === "paint") paintAtEvent(event)
	else if (drag?.mode === "gizmo") updateGizmoDrag(event)
	else if (drag?.mode === "primitive-move") updatePrimitiveMoveDrag(event)
	else if (drag?.mode === "splat-lasso") updateSplatLasso(event)
	else if (drag?.mode === "splat-move") updateSplatMove(event)
	else if (drag?.mode === "splat-scale") updateSplatScale(event)
	else if (drag?.mode === "splat-rotate") updateSplatRotate(event)
	else if (drag && ["scale", "roll"].includes(drag.mode)) updatePrimitiveDrag(event)
	else if (uiTab === "build" && !generating) {
		if (activeTool === "scale") updateScaleHoverCursor(event)
		else updatePlacement(event)
	}
	else if (uiTab === "view" && viewTool === "lasso") setViewTransformCursor(viewTransformHit(event))
})

renderer.domElement.addEventListener("pointerup", event => {
	if (drag?.pointerId === event.pointerId) {
		if (drag.mode === "splat-lasso") finishSplatLasso(event)
		if (drag.mode === "paint") {
			paintAtEvent(event) // make the release position the polygon's final vertex
			finishGroundPaintStroke()
		}
		if (drag.actionPushed && !drag.mutated) activeBuildHistory()?.undo.pop() // drag never moved — drop its checkpoint
		if (drag.mutated) persistFramesSoon() // a drag can outlive the debounce its checkpoint armed
		renderer.domElement.releasePointerCapture(event.pointerId)
		drag = null
		renderer.domElement.classList.remove("is-dragging")
		renderer.domElement.style.removeProperty("cursor")
		updateTransformGizmo()
		if (activeTool === "scale") updateScaleHoverCursor(event)
		syncViewTransformOverlay()
		if (uiTab === "view" && viewTool === "lasso") setViewTransformCursor(viewTransformHit(event))
	}
})

renderer.domElement.addEventListener("pointerleave", () => {
	if (!drag) renderer.domElement.style.removeProperty("cursor")
})

renderer.domElement.addEventListener("wheel", event => {
	event.preventDefault()
	if (camMode === "fly") { // scroll tunes cruise speed instead of zoom
		fly.speed = Math.max(floorSize * 0.05, Math.min(floorSize * 8, fly.speed * (event.deltaY > 0 ? 0.9 : 1.1)))
		return
	}
	if (camMode === "anim") return
	if (camMode === "play") {
		player.zoom(event.deltaY)
		return
	}
	orbit.radius *= event.deltaY > 0 ? 1.08 : 0.92
	updateCamera()
}, { passive: false })

// --- Frames ---------------------------------------------------------------------
// Build and View keep independent frame lists. Planning adds a Build frame and one-shot
// generation adds a Splat frame instead of overwriting the previous world.

let frameSeq = 0
const frames = { build: [], view: [] }
const activeFrameId = { build: 0, view: 0 }

function frameLabel(tab, n) {
	return tab === "build" ? `Build ${n}` : `Result ${n}`
}

function syncWorldState() {
	world.state = world.generated.length ? "generated" : "draft"
}

function renderFramesPanel() {
	if (!els.framesList) return
	const tab = uiTab === "play" ? "view" : uiTab // Play shares View's splat frames (panel hidden there)
	const building = tab === "build"
	const panelTitle = building ? "Builds" : "Results"
	const addTitle = building ? "New build" : "New result"
	els.framesTitle.textContent = panelTitle
	if (els.framesCount) els.framesCount.textContent = String(frames[tab].length)
	if (els.framesPanel) els.framesPanel.setAttribute("aria-label", panelTitle)
	if (els.frameAdd) {
		els.frameAdd.title = addTitle
		els.frameAdd.setAttribute("aria-label", addTitle)
	}
	els.framesList.replaceChildren()
	let activeRow = null
	for (const frame of frames[tab]) {
		const active = frame.id === activeFrameId[tab]
		const item = document.createElement("li")
		item.className = "frame-item" + (active ? " is-active" : "")
		const row = document.createElement("button")
		row.className = "frame-row" + (active ? " menu-active" : "")
		row.type = "button"
		row.setAttribute("aria-pressed", String(active))
		if (active) activeRow = row
		const name = document.createElement("span")
		name.className = "frame-name"
		name.textContent = frame.name
		name.title = frame.name
		const del = document.createElement("button")
		del.className = "frame-del btn btn-ghost btn-xs btn-square"
		del.type = "button"
		del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"></path><path d="M18 6l-12 12"></path></svg>'
		del.title = `Delete ${frame.name}`
		del.setAttribute("aria-label", `Delete ${frame.name}`)
		del.addEventListener("click", event => {
			event.stopPropagation()
			deleteFrame(tab, frame.id)
		})
		row.append(name)
		row.addEventListener("click", () => activateFrame(tab, frame.id))
		item.append(row, del)
		els.framesList.appendChild(item)
	}
	activeRow?.scrollIntoView({ block: "nearest" })
	persistFramesSoon() // every frame add/delete/switch re-renders, so this catches them all
}

// -- Build frames: snapshots of the whole block-out (prims + tiles + heights + paint). --

function pushBuildFrame(name) {
	const frame = { id: ++frameSeq, name: name ?? frameLabel("build", frames.build.length + 1), snapshot: null }
	frames.build.push(frame)
	activeFrameId.build = frame.id
	renderFramesPanel()
	return frame
}

function snapshotActiveBuildFrame() {
	const current = frames.build.find(f => f.id === activeFrameId.build)
	if (current) current.snapshot = snapshotBuildWorld()
}

function snapshotBuildWorld() {
	return {
		prims: serializePrimitives(),
		baseGroundColor: world.baseGroundColor,
		prompt: world.prompt,
	}
}

// --- Build undo/redo (per build frame) ------------------------------------------
// Snapshot-based: every mutating interaction checkpoints the whole block-out first
// (cheap thanks to the paint cache); undo/redo swap whole snapshots. The stacks live
// on the ACTIVE build frame, so history is localized per build (and per tab).

let buildHistoryBusy = false

function activeBuildHistory() {
	const frame = frames.build.find(f => f.id === activeFrameId.build)
	return frame ? (frame.history ??= { undo: [], redo: [] }) : null
}

// Checkpoint the current state before a mutation. Drags call this on pointer-down and
// pop it again if nothing actually moved (see the pointerup handler).
function beginBuildAction() {
	const h = activeBuildHistory()
	if (!h) return
	h.undo.push(snapshotBuildWorld())
	if (h.undo.length > 30) h.undo.shift()
	h.redo.length = 0
	persistFramesSoon() // the debounced save runs after the mutation this checkpoints
}

async function undoBuild() {
	const h = activeBuildHistory()
	if (!h?.undo.length || buildHistoryBusy) return
	buildHistoryBusy = true
	try {
		const snap = h.undo.pop()
		h.redo.push(snapshotBuildWorld())
		await applyBuildSnapshot(snap)
		persistFramesSoon()
	} finally {
		buildHistoryBusy = false
	}
}

async function redoBuild() {
	const h = activeBuildHistory()
	if (!h?.redo.length || buildHistoryBusy) return
	buildHistoryBusy = true
	try {
		const snap = h.redo.pop()
		h.undo.push(snapshotBuildWorld())
		await applyBuildSnapshot(snap)
		persistFramesSoon()
	} finally {
		buildHistoryBusy = false
	}
}

function emptyBuildSnapshot() {
	return {
		prims: { version: 4, ground: { size: GROUND_SHEET_SIZE, complete: true, strokes: [] }, primitives: [] },
		baseGroundColor,
		prompt: "",
	}
}

async function seedDefaultBuildFrames() {
	const seeds = await loadDefaultBuildSeeds()
	for (const seed of seeds) {
		frames.build.push({
			id: ++frameSeq,
			name: seed.name,
			snapshot: { prims: seed.prims, baseGroundColor, prompt: "" },
		})
	}
	const first = frames.build[0]
	if (!first) return false
	activeFrameId.build = first.id
	await applyBuildSnapshot(first.snapshot)
	renderFramesPanel()
	syncViewGate()
	return true
}

async function applyBuildSnapshot(snap) {
	// Persistence guard: while a snapshot is being applied the live world is half-built,
	// so serializeFramesState must not re-snapshot the active frame from it.
	applyingBuildSnapshot++
	try {
		await applyBuildSnapshotInner(snap)
	} finally {
		applyingBuildSnapshot--
	}
}

async function applyBuildSnapshotInner(snap) {
	selectPrimitive(null)
	for (const mesh of [...world.primitives]) world.removePrimitive(mesh)
	// The drawable ground sheet is permanent — restoring a snapshot means wiping the ink
	// and drawing the snapshot's painting back onto the same canvas (alpha included).
	const sheet = world.ground
	const t0 = snap.tiles?.[0]
	let storedGround = snap.prims?.ground ?? null
	if (Array.isArray(t0?.strokes) && t0.strokesComplete !== false) {
		storedGround = { size: GROUND_SHEET_SIZE, complete: true, strokes: t0.strokes }
	} else if (t0?.paint) {
		// Older/incomplete snapshots have no full vector history. Their exact current
		// image becomes the new immutable base; future paint is stored as strokes over it.
		storedGround = t0.paint
	}
	await applyGroundPaintData(storedGround, sheet)
	world.baseGroundColor = snap.baseGroundColor ?? baseGroundColor
	world.prompt = snap.prompt ?? ""
	const prims = snap.prims?.primitives ?? []
	const created = prims.map(p => {
		if (!p?.type) return null
		const mesh = createPrimitive(p.type, `prim_${String(nextPrimitiveId++).padStart(3, "0")}`, {
			color: p.color,
			position: p.position,
			rotation: p.rotation,
			scale: p.scale,
			locked: p.locked,
		})
		mesh.userData.world = world
		world.primitives.push(mesh)
		world.group.add(mesh)
		return mesh
	})
	created.forEach((mesh, i) => {
		const p = prims[i]
		if (!mesh) return
		mesh.userData.support = Number.isInteger(p?.support) ? created[p.support] ?? null : null
		mesh.userData.supportAxis = p?.supportAxis ?? { name: "y", sign: 1 }
	})
	syncWorldState()
	applyUiTab()
}

// -- Splat frames: each generation run seats into its own frame's record list. --

function beginNewSplatFrame() {
	// Hide every existing frame's splats; the new frame becomes the live target that
	// world.addGenerated() seats into.
	for (const f of frames.view) for (const rec of f.records) rec.mesh.visible = false
	const frame = { id: ++frameSeq, name: frameLabel("view", frames.view.length + 1), records: [] }
	frames.view.push(frame)
	activeFrameId.view = frame.id
	world.generated = frame.records
	syncWorldState()
	renderFramesPanel()
	return frame
}

async function activateFrame(tab, id) {
	if (generating) return
	const frame = frames[tab].find(f => f.id === id)
	if (!frame || activeFrameId[tab] === id) return
	if (tab === "build") {
		snapshotActiveBuildFrame()
		activeFrameId.build = id
		await applyBuildSnapshot(frame.snapshot ?? emptyBuildSnapshot())
	} else {
		deselectSplat() // the selection belongs to the frame being left
		activeFrameId.view = id
		for (const f of frames.view) for (const rec of f.records) rec.mesh.visible = false
		world.generated = frame.records
		syncWorldState()
		applyUiTab()
	}
	renderFramesPanel()
	syncViewGate()
}

async function deleteFrame(tab, id) {
	if (generating) return
	const list = frames[tab]
	const idx = list.findIndex(f => f.id === id)
	if (idx < 0) return
	const frame = list[idx]
	if (tab === "view") for (const rec of frame.records) disposeObject(rec.mesh)
	list.splice(idx, 1)
	if (activeFrameId[tab] === id) {
		activeFrameId[tab] = 0
		if (tab === "build") {
			const next = list.at(-1)
			if (next) {
				activeFrameId.build = next.id
				await applyBuildSnapshot(next.snapshot ?? emptyBuildSnapshot())
			} else {
				// Build is the first stage now, so deleting its last frame immediately
				// replaces it with a fresh empty build.
				await applyBuildSnapshot(emptyBuildSnapshot())
				pushBuildFrame()
				snapshotActiveBuildFrame()
			}
		} else {
			const next = list.at(-1)
			if (next) {
				activeFrameId.view = next.id
				world.generated = next.records
				for (const rec of next.records) rec.mesh.visible = uiTab !== "build"
			} else {
				world.generated = []
				if (uiTab !== "build") setUiTab("build")
			}
			syncWorldState()
			applyUiTab()
		}
	}
	renderFramesPanel()
	syncViewGate()
}

function addFrameForActiveTab() {
	if (generating) return
	if (uiTab === "build") {
		snapshotActiveBuildFrame()
		pushBuildFrame()
		applyBuildSnapshot(emptyBuildSnapshot())
	} else {
		beginNewSplatFrame()
		applyUiTab()
	}
	renderFramesPanel()
}

// --- Frame persistence -----------------------------------------------------------
// Build frames survive reloads: every frame change (and every block-out edit, debounced)
// writes the serialized list to IndexedDB, and boot restores it. Splat frames are not
// persisted — their meshes exist only as fitted GPU splats; the Build
// history panel (history.js) is the durable store for generated splats.

let applyingBuildSnapshot = 0
let persistTimer = 0

function serializeFramesState() {
	// Live edits land in their frames before writing — unless a snapshot swap is mid-
	// flight, when the active frame's stored snapshot is already the truth.
	if (!applyingBuildSnapshot && !buildHistoryBusy) {
		snapshotActiveBuildFrame()
	}
	return {
		frameSeq,
		activeBuildId: activeFrameId.build,
		// Undo/redo stacks (frame.history) stay session-local — 30 snapshots per frame
		// is too heavy to rewrite on every edit.
		build: frames.build.map(f => ({ id: f.id, name: f.name, snapshot: f.snapshot })),
		camShots: camShots.map(s => ({ position: [...s.position], quaternion: [...s.quaternion] })),
	}
}

function persistFramesSoon() {
	clearTimeout(persistTimer)
	persistTimer = setTimeout(persistFramesNow, 800)
}

function persistFramesNow() {
	clearTimeout(persistTimer)
	if (wipingAccountData) return // a fresh-account wipe is in flight — don't resurrect state
	saveFramesState(serializeFramesState()).catch(err => console.warn("Frame save failed:", err))
}

// Dev-panel "Simulate new account": wipe everything a first-time visitor wouldn't have
// (saved frames, splat history, worldsketch.* settings — the HF sign-in stays) and
// reload, so the boot path seeds two random default maps exactly like a fresh browser.
let wipingAccountData = false

async function simulateNewAccount() {
	if (wipingAccountData) return
	wipingAccountData = true // also blocks the pagehide flush from re-saving during reload
	setStatus("Wiping saved data…")
	const wipes = await Promise.allSettled([clearFramesState(), clearBuilds()])
	for (const wipe of wipes) {
		if (wipe.status === "rejected") console.warn("Account wipe step failed:", wipe.reason)
	}
	try {
		for (const key of Object.keys(localStorage)) {
			if (key.startsWith("worldsketch.")) localStorage.removeItem(key)
		}
	} catch {}
	location.reload()
}

// Flush on tab-hide/close — the debounce window would otherwise drop the last edits.
addEventListener("pagehide", persistFramesNow)
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") persistFramesNow()
})

// Rebuild the frame lists from the last session and re-enter the active build frame.
// Returns false (leaving state untouched) when there is nothing saved, so boot can
// fall through to the fresh-world path.
async function restoreFramesState() {
	let saved = null
	try {
		saved = await loadFramesState()
	} catch (err) {
		console.warn("Frame restore failed:", err)
	}
	if (!saved?.build?.length) return false
	frames.build = saved.build.map(f => ({ id: f.id, name: f.name, snapshot: f.snapshot ?? null }))
	frameSeq = Math.max(saved.frameSeq ?? 0, ...frames.build.map(f => f.id), 0)
	const buildFrame = frames.build.find(f => f.id === saved.activeBuildId) ?? frames.build.at(-1)
	activeFrameId.build = buildFrame.id
	camShots.length = 0
	for (const s of saved.camShots ?? []) {
		if (Array.isArray(s?.position) && Array.isArray(s?.quaternion)) {
			camShots.push({ id: ++nextShotId, position: s.position, quaternion: s.quaternion })
		}
	}
	renderShotChips()
	await applyBuildSnapshot(buildFrame.snapshot ?? emptyBuildSnapshot())
	renderFramesPanel()
	syncViewGate()
	return true
}

// --- Generation -------------------------------------------------------------

function setStatus(message) {
	const text = String(message ?? "")
	// Server errors can be whole HTML pages — keep the toast a toast.
	els.status.textContent = text.length > 220 ? text.slice(0, 220) + "…" : text
	els.status.classList.toggle("hidden", !text)
}

function showProgress(done, total, label) {
	els.progress.classList.remove("hidden")
	els.chatDock.classList.add("is-showing-progress")
	const pct = total ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0
	els.progressFill.style.width = `${pct}%`
	els.progressPercent.textContent = `${pct}%`
	els.progressTrack.setAttribute("aria-valuenow", String(pct))
	if (label !== undefined) els.progressLabel.textContent = label
}

function hideProgress() {
	els.progress.classList.add("hidden")
	els.chatDock.classList.remove("is-showing-progress")
	els.progressFill.style.width = "0%"
	els.progressPercent.textContent = "0%"
	els.progressTrack.setAttribute("aria-valuenow", "0")
}

function yieldForProgressPaint() {
	return new Promise(resolve => requestAnimationFrame(() => window.setTimeout(resolve, 0)))
}

function syncGenerateButton() {
	els.generate.disabled = generating
	els.generate.classList.toggle("is-disabled", generating)
	const signedIn = getHuggingFaceAuth().signedIn
	els.generate.title = generating ? "Generating…" : signedIn ? "Generate with Hugging Face" : "Sign in with Hugging Face to generate"
	els.generate.setAttribute("aria-label", signedIn ? "Generate world" : "Sign in with Hugging Face and generate")
	// Make the frozen state visible: not-allowed cursor over both canvases, and no
	// placement affordance left glowing.
	document.body.classList.toggle("is-generating", generating)
	if (generating) {
		if (placementPreview) placementPreview.visible = false // no frozen ghost block mid-air
	}
	syncViewGate()
}

// Build is always available; View unlocks once the single scene splat has landed.
function syncTabGates() {
	const gate = (name, count, busy) => {
		const btn = els.viewTabs.find(button => button.dataset.viewTab === name)
		if (!btn) return
		btn.classList.remove("hidden")
		btn.disabled = busy || count === 0 // always visible; greyed until it has content
		btn.classList.toggle("is-loading", busy)
	}
	gate("build", frames.build.length, false)
	gate("view", frames.view.length, splatting)
	gate("play", frames.view.length, splatting) // Play walks the generated splats, so it unlocks with View
	// With only Build available the bar is pure chrome — show it once a second tab
	// has content (or is being generated, so the View spinner stays visible). On
	// reveal it fades in FROM white (see .tabs-enter in styles.css) instead of popping.
	const tabBar = document.querySelector(".view-tabs")
	if (tabBar) {
		const collapse = frames.view.length === 0 && !splatting
		if (collapse) {
			tabBar.classList.add("hidden")
			tabBar.classList.remove("tabs-enter")
		} else if (tabBar.classList.contains("hidden")) {
			tabBar.classList.remove("hidden")
			tabBar.classList.add("tabs-enter")
		}
	}
}
const syncViewGate = syncTabGates // existing call sites

function setDevControlsVisible(visible) {
	devControlsVisible = Boolean(visible)
	document.body.classList.toggle("dev-controls-visible", devControlsVisible)
	if (!devControlsVisible) toggleSettings(false)
	else syncBuildGeometryJson(true)
}

function toggleDevControls() {
	setDevControlsVisible(!devControlsVisible)
}

let segmentationTunePanel = null
let segmentationTuneAutoRetune = true
let segmentationTuneTimer = null
let segmentationTuneRunning = false
let segmentationTuneQueued = false
let buildGeometryJsonField = null
let buildGeometryJsonStatus = null
let buildGeometryJsonLastSynced = ""
let buildGeometryJsonLastCheck = 0
let buildGeometryJsonApplying = false
let buildGeometryJsonHasError = false
const segmentationTuneControls = [
	{
		id: "small-objects", group: "Find objects", label: "Keep small objects", min: 0, max: 1, step: 0.01, format: percent,
		description: "Higher values keep smaller rocks, bushes, and props.", low: "Fewer", high: "More",
		read: () => 1 - clamp01((segmentationTuning.minBlob - 40) / 960),
		write: value => { segmentationTuning.minBlob = Math.round(lerp(1000, 40, value) / 20) * 20 },
	},
	{
		id: "touching-objects", group: "Find objects", key: "bridgeCut", label: "Separate touching objects", min: 0, max: 1, step: 0.01, format: percent,
		description: "Higher values break thin joins between nearby objects.", low: "Keep together", high: "Split apart",
	},
	{
		id: "ground-color", group: "Find objects", key: "colorSplit", label: "Use color at the ground", min: 0, max: 1, step: 0.01, format: percent,
		description: "Uses a color change at the base to separate an object from the ground.", low: "Ignore color", high: "Rely on color",
	},
	{
		id: "low-ground", group: "Find objects", key: "terrainBias", label: "Leave low shapes on the ground", min: 0, max: 1, step: 0.01, format: percent,
		description: "Higher values keep mound-like shapes as part of the ground.", low: "Favor objects", high: "Favor ground",
	},
	{
		id: "clean-bases", group: "Clean object edges", key: "baseDetachStrength", label: "Clean around object bases", min: 0, max: 1, step: 0.01, format: percent,
		description: "Removes nearby ground that has become stuck to a tall object.", low: "Keep nearby ground", high: "Cleaner bases",
	},
	{
		id: "short-objects", group: "Clean object edges", label: "Protect short objects", min: 0, max: 1, step: 0.01, format: percent,
		description: "Higher values are less likely to trim low rocks, bushes, and crates.", low: "Less protection", high: "More protection",
		read: () => clamp01(segmentationTuning.skirtGuardMinRise / 8),
		write: value => { segmentationTuning.skirtGuardMinRise = value * 8 },
	},
	{
		id: "stray-pieces", group: "Clean object edges", label: "Remove stray pieces", min: 0, max: 1, step: 0.01, format: percent,
		description: "Removes entire small components that are disconnected from an object.", low: "Keep fine detail", high: "Remove more",
		read: () => {
			const detached = Math.pow(clamp01(segmentationTuning.detachedCullPct / 0.12), 1 / 4.8)
			return clamp01((segmentationTuning.wispAggression + detached) / 2)
		},
		write: value => {
			segmentationTuning.wispAggression = value
			segmentationTuning.detachedCullPct = 0.12 * Math.pow(value, 4.8)
		},
	},
	{
		id: "edge-outliers", group: "Clean object edges", key: "edgeOutliers", label: "Cull isolated edge splats", min: 0, max: 1, step: 0.01, format: percent,
		description: "Trims unusually sparse splats on the outer edge, even when a thin strand still connects them.", low: "Keep wispy edges", high: "Trim sparse edges",
	},
	{
		id: "cleanup-amount", group: "Overall cleanup", key: "cullAmount", label: "Cleanup amount", min: 0, max: 100, step: 1, format: value => `${Math.round(value)}%`,
		description: "Controls how much unwanted material is removed.", low: "Keep everything", high: "Remove all found",
	},
	{
		id: "wisp-cull", group: "Overall cleanup", key: "wispCull", label: "Remove floating wisps", min: 0, max: 1, step: 0.01, format: percent,
		description: "Culls the long translucent streak gaussians the reconstruction leaves floating around the scene.", low: "Off", high: "Aggressive",
	},
	{
		id: "cleanup-reach", group: "Overall cleanup", key: "cleanupReach", label: "Cleanup height", min: 0, max: 1, step: 0.01, format: percent,
		description: "Measures from each object's own bottom to its top.", low: "Object base", high: "Object top",
	},
	{
		id: "ground-smooth", group: "Repair the ground", key: "groundSmooth", label: "Smooth ground left behind by objects", min: 0, max: 1, step: 0.01, format: percent,
		description: "Removes raised object remnants before the ground is filled.", low: "Keep existing shape", high: "Flatten to ground",
	},
	{
		id: "ground-repair", group: "Repair the ground", key: "groundFill", label: "Fill holes left by objects", min: 0, max: 1, step: 0.01, format: percent,
		description: "Adds matching material directly on the local ground surface.", low: "Off", high: "Stronger fill",
	},
	{
		id: "ground-fill-height", group: "Repair the ground", key: "groundFillMaxHeight", label: "Highest height to fill", min: 0, max: 1, step: 0.01, format: percent,
		description: "Measured from the bottom to the top of each original object.", low: "Object base", high: "Object top",
	},
]

const readSegmentationControl = control => control.read ? control.read() : segmentationTuning[control.key]
const writeSegmentationControl = (control, value) => {
	if (control.write) control.write(value)
	else segmentationTuning[control.key] = value
}

function saveSegmentationTuning() {
	try { localStorage.setItem("worldsketch.segmentationTuning", JSON.stringify(segmentationTuning)) } catch {}
}

function segmentationConfigText() {
	const sliderValues = segmentationTuneControls.map(control => {
		const value = readSegmentationControl(control)
		return `- ${control.label}: ${control.format(value)}`
	})
	const exactValues = Object.fromEntries(
		[...adjustableSegmentationKeys].map(key => [key, segmentationTuning[key]]),
	)
	return [
		"WorldSketch object separation config",
		...sliderValues,
		"",
		"Exact values for defaults:",
		JSON.stringify(exactValues, null, 2),
	].join("\n")
}

async function copyTextToClipboard(text) {
	try {
		if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable")
		await navigator.clipboard.writeText(text)
		return
	} catch {
		const textarea = document.createElement("textarea")
		textarea.value = text
		textarea.setAttribute("readonly", "")
		textarea.style.position = "fixed"
		textarea.style.opacity = "0"
		document.body.appendChild(textarea)
		textarea.select()
		const copied = document.execCommand("copy")
		textarea.remove()
		if (!copied) throw new Error("Could not copy config")
	}
}

function buildGeometryJsonText() {
	return JSON.stringify({ version: 4, ground: groundPaintData(), primitives: serializePrimitiveList() }, null, 2)
}

function setBuildGeometryJsonStatus(message, state = "") {
	if (!buildGeometryJsonStatus) return
	buildGeometryJsonStatus.textContent = message
	buildGeometryJsonStatus.dataset.state = state
}

function syncBuildGeometryJson(force = false, now = performance.now()) {
	if (!buildGeometryJsonField || (!devControlsVisible && !force)) return
	if (!force && now - buildGeometryJsonLastCheck < 160) return
	buildGeometryJsonLastCheck = now
	const current = buildGeometryJsonText()
	const dirty = buildGeometryJsonField.value !== buildGeometryJsonLastSynced
	if (dirty && !force) {
		if (!buildGeometryJsonHasError) {
			setBuildGeometryJsonStatus(
				current === buildGeometryJsonLastSynced
					? "Edited — apply JSON to update the build"
					: "Build changed — apply JSON or refresh",
				"dirty",
			)
		}
		return
	}
	buildGeometryJsonField.value = current
	buildGeometryJsonLastSynced = current
	buildGeometryJsonHasError = false
	const strokeCount = world.ground?.userData?.paintStrokes?.length ?? 0
	setBuildGeometryJsonStatus(`${world.primitives.length} block${world.primitives.length === 1 ? "" : "s"} · ${strokeCount} floor stroke${strokeCount === 1 ? "" : "s"} · live`, "live")
}

function validatedGroundPaintJson(value) {
	if (value == null) return value
	if (typeof value === "string") {
		if (!value.startsWith("data:image/")) throw new Error("Ground image must be an embedded data:image URL")
		return value
	}
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("Ground must be a floor-paint object or null")
	const size = Number(value.size ?? GROUND_SHEET_SIZE)
	if (!Number.isFinite(size) || size <= 0) throw new Error("Ground size must be greater than 0")
	if (!Array.isArray(value.strokes)) throw new Error("Ground needs a strokes array")
	const strokes = value.strokes.map((stroke, index) => {
		if (!stroke || !["paint", "erase"].includes(stroke.mode)) {
			throw new Error(`Floor stroke ${index + 1} mode must be paint or erase`)
		}
		if (!/^#[0-9a-f]{6}$/i.test(stroke.color)) {
			throw new Error(`Floor stroke ${index + 1} color must look like #aabbcc`)
		}
		const radius = Number(stroke.radius)
		if (!Number.isFinite(radius) || radius <= 0) throw new Error(`Floor stroke ${index + 1} radius must be greater than 0`)
		if (!Array.isArray(stroke.points) || !stroke.points.length) throw new Error(`Floor stroke ${index + 1} needs at least one point`)
		const points = stroke.points.map((point, pointIndex) => {
			if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
				throw new Error(`Floor stroke ${index + 1}, point ${pointIndex + 1} needs numeric X and Z values`)
			}
			return [point[0], point[1]]
		})
		return {
			mode: stroke.mode,
			color: stroke.color.toLowerCase(),
			radius,
			closed: stroke.mode !== "erase" && stroke.closed === true,
			points,
		}
	})
	const image = typeof value.image === "string" && value.image.startsWith("data:image/") ? value.image : null
	const complete = value.complete !== false && !image
	if (value.complete === false && !image) throw new Error("Incomplete ground data needs its base image")
	return { size, complete, strokes, ...(image ? { image } : {}) }
}

function validatedBuildGeometryJson(text) {
	let parsed
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		throw new Error(`Invalid JSON: ${error.message}`)
	}
	const primitives = Array.isArray(parsed) ? parsed : parsed?.primitives
	if (!Array.isArray(primitives)) throw new Error('Expected a "primitives" array')
	const finiteVector = (value, name, index, positive = false) => {
		if (!Array.isArray(value) || value.length < 3 || value.slice(0, 3).some(number => !Number.isFinite(number))) {
			throw new Error(`Block ${index + 1} needs a numeric ${name} array with 3 values`)
		}
		if (positive && value.slice(0, 3).some(number => number <= 0)) {
			throw new Error(`Block ${index + 1} scale values must be greater than 0`)
		}
	}
	for (let index = 0; index < primitives.length; index++) {
		const primitive = primitives[index]
		if (!primitive || primitive.type !== "box") throw new Error(`Block ${index + 1} must have type "box"`)
		finiteVector(primitive.position, "position", index)
		finiteVector(primitive.rotation, "rotation", index)
		finiteVector(primitive.scale, "scale", index, true)
		if (primitive.color != null && !/^#[0-9a-f]{6}$/i.test(primitive.color)) {
			throw new Error(`Block ${index + 1} color must look like #aabbcc`)
		}
		if (primitive.support != null && (!Number.isInteger(primitive.support) || primitive.support < 0 || primitive.support >= primitives.length)) {
			throw new Error(`Block ${index + 1} support must be another block's array index or null`)
		}
		if (primitive.supportAxis != null) {
			const { name, sign } = primitive.supportAxis
			if (!["x", "y", "z"].includes(name) || ![-1, 1].includes(sign)) {
				throw new Error(`Block ${index + 1} supportAxis needs x/y/z and sign -1 or 1`)
			}
		}
	}
	for (let index = 0; index < primitives.length; index++) {
		const visited = new Set([index])
		let support = primitives[index].support
		while (Number.isInteger(support)) {
			if (visited.has(support)) throw new Error(`Block ${index + 1} has a circular support link`)
			visited.add(support)
			support = primitives[support]?.support
		}
	}
	const geometry = { version: 4, primitives }
	if (!Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, "ground")) {
		geometry.ground = validatedGroundPaintJson(parsed.ground)
	}
	return geometry
}

async function applyBuildGeometryJson() {
	if (!buildGeometryJsonField || buildGeometryJsonApplying) return
	if (generating) {
		buildGeometryJsonHasError = true
		setBuildGeometryJsonStatus("Wait for generation to finish", "error")
		return
	}
	let geometry
	try {
		geometry = validatedBuildGeometryJson(buildGeometryJsonField.value)
	} catch (error) {
		buildGeometryJsonHasError = true
		setBuildGeometryJsonStatus(error.message, "error")
		return
	}
	try {
		await replaceBuildGeometry(geometry)
		setStatus(`Applied JSON build with ${world.primitives.length} block${world.primitives.length === 1 ? "" : "s"}`)
	} catch (error) {
		buildGeometryJsonHasError = true
		setBuildGeometryJsonStatus(error.message || "Could not apply geometry", "error")
	}
}

async function replaceBuildGeometry(geometry) {
	if (buildGeometryJsonApplying) throw new Error("Another geometry update is already running")
	buildGeometryJsonApplying = true
	beginBuildAction()
	try {
		const file = new File([JSON.stringify(geometry)], "build-geometry.json", { type: "application/json" })
		const applied = await applyPrimitives(file, { staged: true })
		if (!applied) throw new Error("Could not apply geometry")
		revealPrimitivesBottomUp()
		syncBuildGeometryJson(true)
	} catch (error) {
		const rollback = activeBuildHistory()?.undo.pop()
		if (rollback) await applyBuildSnapshot(rollback)
		throw error
	} finally {
		buildGeometryJsonApplying = false
	}
}

// Staggered bottom-up reveal after a whole-build replacement (Apply JSON / generated
// geometry). The build state is already final — meshes, support links, and persistence
// all see the finished build; only visibility is staggered, so an interrupted reveal
// can simply snap everything visible.
let buildRevealToken = 0

// Total reveal duration in seconds, set by the "Build-up time" slider in the dev panel.
// 0 = instant (no stagger).
let buildRevealSeconds = 2.5
try {
	const storedRevealSeconds = localStorage.getItem("worldsketch.buildRevealSeconds")
	if (storedRevealSeconds !== null) {
		const seconds = Number(storedRevealSeconds)
		if (Number.isFinite(seconds) && seconds >= 0) buildRevealSeconds = Math.min(10, seconds)
	}
} catch {}

async function revealPrimitivesBottomUp() {
	if (uiTab !== "build") return // View owns block-out visibility (blocks stay hidden there)
	if (buildRevealSeconds <= 0) return // instant: applyUiTab already showed everything
	const token = ++buildRevealToken
	const meshes = [...world.primitives].sort(
		(a, b) => (a.position.y - a.scale.y / 2) - (b.position.y - b.scale.y / 2),
	)
	// applyUiTab just force-showed the whole block-out; re-hide it in the same microtask
	// (before the next render frame) so the reveal starts from an empty ground.
	for (const mesh of meshes) mesh.visible = false
	// Time-based (not one-block-per-tick) so browser timer throttling can't stretch the
	// reveal: late ticks show every block whose moment has passed and the whole build
	// always lands in the slider's duration.
	const delay = Math.max(16, (buildRevealSeconds * 1000) / Math.max(1, meshes.length))
	const start = performance.now()
	let shown = 0
	while (shown < meshes.length) {
		if (token !== buildRevealToken || uiTab !== "build") break
		const due = Math.min(meshes.length, Math.max(shown + 1, Math.ceil((performance.now() - start) / delay)))
		while (shown < due) meshes[shown++].visible = true
		await new Promise(resolve => window.setTimeout(resolve, delay))
	}
	// Whatever interrupted the loop, never leave Build-tab blocks hidden.
	if (uiTab === "build") for (const mesh of meshes) mesh.visible = true
}

// Generation cutscene: the moment the splat is ready the UI steps aside and the
// editor replays the product promise in the View tab — the original block-out
// constructs bottom-up, flashes white-hot, and vanishes as the freshly
// generated splats take its place; then the UI fades back in (body.cutscene
// drives the CSS fade on .ui). The block materials are the editor's REAL
// materials, so everything touched here is restored in the finally block.
const CUTSCENE_BUILD_MS = 700
const CUTSCENE_FLASH_MS = 200
const CUTSCENE_HOLD_MS = 200 // beat on the fresh splats before the UI returns

function cutsceneTween(ms, step) {
	return new Promise(resolve => {
		const start = performance.now()
		const frame = () => {
			const t = Math.min(1, (performance.now() - start) / ms)
			step(t)
			if (t < 1) requestAnimationFrame(frame)
			else resolve()
		}
		requestAnimationFrame(frame)
	})
}

// Ground the block-out onto the SEATED splat for the show. The splat is fitted
// to the block-out only loosely (uniform content-box fit, its own floor level),
// so raw block poses read as "a different place" when the swap lands. Anchoring
// floor-to-floor — the block-out's ground top onto the splat floor's surface —
// plus an XZ centre match and a footprint scale puts every block exactly where
// its splat counterpart will appear. Returns a rig group inside world.group;
// identity when the splat is too sparse to judge.
function cutsceneGroundingRig() {
	const rig = new THREE.Group()
	world.group.add(rig)
	try {
		const box = wholeSceneBox() // the frame the splat was seated against
		const xs = [], ys = [], zs = [], floorYs = []
		const point = new THREE.Vector3()
		for (const { mesh } of world.generated) {
			if (!mesh.packedSplats?.forEachSplat) continue
			mesh.updateMatrix()
			const isFloor = mesh.userData.genKind === "floor"
			let i = 0
			mesh.packedSplats.forEachSplat((_i, center) => {
				if (i++ % 16) return // a 1/16 sample is plenty for percentile bounds
				if (![center.x, center.y, center.z].every(Number.isFinite)) return
				point.copy(center).applyMatrix4(mesh.matrix)
				xs.push(point.x); ys.push(point.y); zs.push(point.z)
				if (isFloor) floorYs.push(point.y)
			})
		}
		if (xs.length < 100) return rig // too sparse to judge — leave the blocks in place
		const pct = (arr, p) => { arr.sort((a, b) => a - b); return arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] }
		const sx0 = pct(xs, 0.02), sx1 = pct(xs, 0.98)
		const sz0 = pct(zs, 0.02), sz1 = pct(zs, 0.98)
		// The splat "floor level" objects stand on: the segmented floor piece's
		// median height, or (monolith scenes) just above the content's bottom.
		const splatFloorY = floorYs.length >= 50 ? pct(floorYs, 0.5) : pct(ys, 0.03)
		const bw = Math.max(0.001, box.max.x - box.min.x)
		const bd = Math.max(0.001, box.max.z - box.min.z)
		const s = Math.min(2, Math.max(0.5, ((sx1 - sx0) / bw + (sz1 - sz0) / bd) / 2))
		const anchorBlock = new THREE.Vector3((box.min.x + box.max.x) / 2, groundTopY, (box.min.z + box.max.z) / 2)
		const anchorSplat = new THREE.Vector3((sx0 + sx1) / 2, splatFloorY, (sz0 + sz1) / 2)
		rig.scale.setScalar(s)
		rig.position.copy(anchorSplat).sub(anchorBlock.multiplyScalar(s))
	} catch (error) {
		console.warn("cutscene grounding skipped:", error)
	}
	return rig
}

async function playGenerationCutscene() {
	const blocks = world.allBlockoutMeshes()
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !blocks.length || !world.generated.length) {
		setUiTab("view")
		frameGeneratedSplats()
		return
	}
	document.body.classList.add("cutscene")
	setUiTab("view")
	frameGeneratedSplats()
	// Everything below runs before the next frame paints, so the stage opens
	// empty: splats held back, blocks staged invisible for the build-up.
	for (const { mesh } of world.generated) mesh.visible = false
	const meshes = [...blocks].sort(
		(a, b) => (a.position.y - a.scale.y / 2) - (b.position.y - b.scale.y / 2),
	)
	// Move the blocks into the grounding rig for the show — plain add() keeps
	// their LOCAL transforms, so handing them back to world.group afterwards
	// restores the editor's exact poses with no bookkeeping.
	const rig = cutsceneGroundingRig()
	for (const mesh of meshes) {
		setColliderStyle(mesh, false)
		mesh.visible = false
		rig.add(mesh)
	}
	const saved = meshes.map(mesh => ({
		emissive: mesh.material.emissive.getHex(),
		intensity: mesh.material.emissiveIntensity,
		edges: mesh.children
			.filter(child => child.userData.isEdgeOutline)
			.map(edge => ({ edge, base: edge.material.color.clone() })),
	}))
	try {
		// Bottom-up build, elapsed-fraction paced so it always lands in
		// CUTSCENE_BUILD_MS no matter how many blocks there are — no per-tick
		// minimum, or a small build (a handful of blocks) sprints in ~100ms.
		const start = performance.now()
		let shown = 0
		while (shown < meshes.length) {
			const elapsed = performance.now() - start
			const due = Math.min(meshes.length, Math.ceil((elapsed / CUTSCENE_BUILD_MS) * meshes.length))
			while (shown < due) meshes[shown++].visible = true
			await new Promise(resolve => window.setTimeout(resolve, 16))
		}
		// Every block ramps to white-hot…
		for (let i = 0; i < meshes.length; i++) {
			meshes[i].material.emissive.set(0xffffff)
			meshes[i].material.emissiveIntensity = 0
		}
		await cutsceneTween(CUTSCENE_FLASH_MS, t => {
			for (let i = 0; i < meshes.length; i++) {
				meshes[i].material.emissiveIntensity = t
				for (const { edge, base } of saved[i].edges) edge.material.color.copy(base).lerp(cutsceneWhite, t)
			}
		})
		// …and vanishes — the splats appear exactly where the blocks stood.
		for (const mesh of meshes) mesh.visible = false
		for (const { mesh } of world.generated) {
			mesh.visible = showSplatFloor || mesh.userData.genKind !== "floor"
		}
		await new Promise(resolve => window.setTimeout(resolve, CUTSCENE_HOLD_MS))
	} finally {
		for (let i = 0; i < meshes.length; i++) {
			meshes[i].material.emissive.setHex(saved[i].emissive)
			meshes[i].material.emissiveIntensity = saved[i].intensity
			for (const { edge, base } of saved[i].edges) edge.material.color.copy(base)
			world.group.add(meshes[i]) // hand back with the original local pose
		}
		rig.removeFromParent()
		applyUiTab() // re-assert canonical View visibility whatever happened
		document.body.classList.remove("cutscene") // CSS fades the UI back in
	}
}
const cutsceneWhite = new THREE.Color(0xffffff)
window.__wsPlayCutscene = playGenerationCutscene // devtools: replay the reveal on the current scene

function scheduleSegmentationRetune() {
	if (!segmentationTuneAutoRetune) return
	if (!sceneSplat) return
	window.clearTimeout(segmentationTuneTimer)
	segmentationTuneTimer = window.setTimeout(() => { retuneCurrentSceneSegmentation() }, 350)
}

// Dev-panel scene flips: mirror the fitted splat pieces about the seat centre
// to eyeball orientation problems (Tripo's random mirroring) without a re-fit.
// Spark drops the mirror sign of a negative mesh scale (the seating pipeline
// bakes mirrorZ into the gaussians for the same reason), so each flip REBUILDS
// every piece's splat data: centres reflected about the scene-box centre, each
// gaussian's quaternion conjugated for the reflection (for a flip of axis a,
// negate the two OTHER imaginary components). A mirror is its own inverse, so
// toggling a box twice restores the exact original data.
async function applySceneFlip(axis) {
	if (!world.generated.length) return
	deselectSplat() // the rebuild replaces mesh identities
	const center = wholeSceneBox().getCenter(new THREE.Vector3())
	const local = new THREE.Vector3()
	const p = new THREE.Vector3()
	const q = new THREE.Quaternion()
	for (const record of [...world.generated]) {
		const old = record.mesh
		if (!old.packedSplats?.forEachSplat) continue
		old.updateMatrix()
		local.copy(center).applyMatrix4(old.matrix.clone().invert()) // mirror plane in the mesh's own frame
		const mirrored = new SplatMesh({
			constructSplats: splats => {
				old.packedSplats.forEachSplat((_i, ctr, scales, quaternion, opacity, color) => {
					p.copy(ctr)
					if (axis === "x") { p.x = 2 * local.x - p.x; q.set(quaternion.x, -quaternion.y, -quaternion.z, quaternion.w) }
					else if (axis === "y") { p.y = 2 * local.y - p.y; q.set(-quaternion.x, quaternion.y, -quaternion.z, quaternion.w) }
					else { p.z = 2 * local.z - p.z; q.set(-quaternion.x, -quaternion.y, quaternion.z, quaternion.w) }
					splats.pushSplat(p, scales, q, opacity, color)
				})
			},
		})
		await mirrored.initialized
		mirrored.position.copy(old.position)
		mirrored.quaternion.copy(old.quaternion)
		mirrored.scale.copy(old.scale)
		mirrored.userData = old.userData
		mirrored.visible = old.visible
		world.group.add(mirrored)
		record.mesh = mirrored
		world.group.remove(old)
		old.dispose?.()
	}
}

function createSegmentationTunePanel() {
	if (segmentationTunePanel) return
	const panel = document.createElement("aside")
	panel.className = "tuning-panel"
	panel.setAttribute("aria-label", "Developer controls")
	panel.innerHTML = `
		<header class="tuning-head">
			<div>
				<strong>Developer controls</strong>
				<span>Edit Build geometry and tune object separation</span>
			</div>
			<label class="tuning-live" title="Carve each generation into movable per-object pieces. Freezes the tab for a few seconds, so it is off by default; 'Apply to current scene' can still separate afterwards."><input type="checkbox" data-tune-auto-segment> Separate objects</label>
			<label class="tuning-live"><input type="checkbox" data-tune-live checked> Retune live</label>
		</header>
		<div class="tuning-groups"></div>
		<section class="tuning-group">
			<h3>Flip fitted scene</h3>
			<div class="tuning-flips" title="Mirror the seated splat pieces about the scene centre — a quick orientation check without re-fitting. Applies to the CURRENT scene; a new generation starts unflipped.">
				<label class="tuning-live"><input type="checkbox" data-tune-flip="x"> Flip X</label>
				<label class="tuning-live"><input type="checkbox" data-tune-flip="y"> Flip Y</label>
				<label class="tuning-live"><input type="checkbox" data-tune-flip="z"> Flip Z</label>
			</div>
		</section>
		<section class="build-json-group">
			<div class="build-json-head">
				<h3>Build JSON</h3>
				<span data-build-json-status></span>
			</div>
			<p>Includes blocks and editable floor paint. Applying replaces both when a ground field is present.</p>
			<textarea data-build-json spellcheck="false" aria-label="Build JSON"></textarea>
			<div class="build-json-actions">
				<button type="button" data-build-json-apply>Apply JSON</button>
				<button type="button" data-build-json-refresh>Refresh from Build</button>
			</div>
			<label class="build-json-speed">
				<span>Build-up time <output data-build-speed-out></output></span>
				<input type="range" min="0" max="8" step="0.5" data-build-speed aria-label="Build-up time in seconds">
			</label>
		</section>
		<footer class="tuning-actions">
			<button type="button" data-tune-retune>Apply to current scene</button>
			<button type="button" data-tune-copy>Copy config</button>
			<button type="button" data-tune-reset>Restore defaults</button>
			<button type="button" data-tune-fresh-account title="Wipe all saved builds, splat history, and settings, then reload as a first-time visitor (stays signed in)">Simulate new account</button>
		</footer>
	`
	const groupsEl = panel.querySelector(".tuning-groups")
	let currentGroup = ""
	let groupEl = null
	for (const control of segmentationTuneControls) {
		if (control.group !== currentGroup) {
			currentGroup = control.group
			groupEl = document.createElement("section")
			groupEl.className = "tuning-group"
			groupEl.innerHTML = `<h3>${control.group}</h3>`
			groupsEl.appendChild(groupEl)
		}
		const row = document.createElement("label")
		row.className = "tuning-row"
		row.innerHTML = `
			<span><span>${control.label}</span><output></output></span>
			<small>${control.description}</small>
			<input type="range" min="${control.min}" max="${control.max}" step="${control.step}" data-tune-id="${control.id}">
			<span class="tuning-range-labels"><span>${control.low}</span><span>${control.high}</span></span>
		`
		const input = row.querySelector("input")
		const output = row.querySelector("output")
		const sync = () => {
			const value = readSegmentationControl(control)
			input.value = String(value)
			output.textContent = control.format(value)
		}
		input.addEventListener("input", () => {
			const value = Number(input.value)
			if (!Number.isFinite(value)) return
			writeSegmentationControl(control, value)
			output.textContent = control.format(value)
			saveSegmentationTuning()
			scheduleSegmentationRetune()
		})
		sync()
		groupEl.appendChild(row)
	}
	panel.querySelector("[data-tune-live]")?.addEventListener("change", event => {
		segmentationTuneAutoRetune = Boolean(event.target.checked)
	})
	const autoSegmentInput = panel.querySelector("[data-tune-auto-segment]")
	if (autoSegmentInput) {
		autoSegmentInput.checked = autoSegmentationEnabled
		autoSegmentInput.addEventListener("change", () => {
			autoSegmentationEnabled = autoSegmentInput.checked
			try { localStorage.setItem("worldsketch.autoSegmentation", String(autoSegmentationEnabled)) } catch {}
			setStatus(autoSegmentationEnabled
				? "New generations will be separated into movable objects (freezes the tab briefly)"
				: "New generations stay as one piece — use Apply to current scene to separate later")
		})
	}
	buildGeometryJsonField = panel.querySelector("[data-build-json]")
	buildGeometryJsonStatus = panel.querySelector("[data-build-json-status]")
	buildGeometryJsonField?.addEventListener("input", () => {
		buildGeometryJsonHasError = false
		buildGeometryJsonLastCheck = -Infinity
		syncBuildGeometryJson()
	})
	buildGeometryJsonField?.addEventListener("keydown", event => {
		if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return
		event.preventDefault()
		applyBuildGeometryJson()
	})
	panel.querySelector("[data-build-json-apply]")?.addEventListener("click", () => applyBuildGeometryJson())
	panel.querySelector("[data-build-json-refresh]")?.addEventListener("click", () => syncBuildGeometryJson(true))
	panel.querySelector("[data-tune-fresh-account]")?.addEventListener("click", () => simulateNewAccount())
	const buildSpeedInput = panel.querySelector("[data-build-speed]")
	const buildSpeedOut = panel.querySelector("[data-build-speed-out]")
	const syncBuildSpeed = () => {
		if (buildSpeedOut) buildSpeedOut.textContent = buildRevealSeconds > 0 ? `${buildRevealSeconds}s` : "instant"
	}
	if (buildSpeedInput) {
		buildSpeedInput.value = String(buildRevealSeconds)
		syncBuildSpeed()
		buildSpeedInput.addEventListener("input", () => {
			const value = Number(buildSpeedInput.value)
			if (!Number.isFinite(value) || value < 0) return
			buildRevealSeconds = value
			try { localStorage.setItem("worldsketch.buildRevealSeconds", String(value)) } catch {}
			syncBuildSpeed()
		})
	}
	panel.querySelector("[data-tune-retune]")?.addEventListener("click", () => retuneCurrentSceneSegmentation())
	{
		const flipInputs = [...panel.querySelectorAll("[data-tune-flip]")]
		for (const input of flipInputs) {
			input.addEventListener("change", async () => {
				for (const other of flipInputs) other.disabled = true
				try {
					await applySceneFlip(input.dataset.tuneFlip)
				} catch (error) {
					console.warn("scene flip failed:", error)
				} finally {
					for (const other of flipInputs) other.disabled = false
				}
			})
		}
	}
	panel.querySelector("[data-tune-copy]")?.addEventListener("click", async event => {
		const button = event.currentTarget
		const originalLabel = button.textContent
		try {
			await copyTextToClipboard(segmentationConfigText())
			button.textContent = "Copied!"
		} catch {
			button.textContent = "Copy failed"
		}
		window.setTimeout(() => { button.textContent = originalLabel }, 1600)
	})
	panel.querySelector("[data-tune-reset]")?.addEventListener("click", () => {
		Object.assign(segmentationTuning, segmentationTuneDefaults)
		saveSegmentationTuning()
		for (const input of panel.querySelectorAll("[data-tune-id]")) {
			const control = segmentationTuneControls.find(c => c.id === input.dataset.tuneId)
			const output = input.closest(".tuning-row")?.querySelector("output")
			const value = readSegmentationControl(control)
			input.value = String(value)
			if (output) output.textContent = control.format(value)
		}
		scheduleSegmentationRetune()
	})
	document.body.appendChild(panel)
	segmentationTunePanel = panel
	syncBuildGeometryJson(true)
}

createSegmentationTunePanel()

function fitSettingsFromConfig(cfg) {
	const scoped = cfg?.scene ?? {}
	const value = (key, fallbackKey = key) => (
		scoped[key] ?? scoped[fallbackKey] ?? defaultFitSettings[key] ?? defaultFitSettings[fallbackKey]
	)
	const number = (key, fallbackKey = key) => {
		const n = Number(value(key, fallbackKey))
		return Number.isFinite(n) ? n : defaultFitSettings[key]
	}
	return {
		yOffset: number("yOffset"),
		opacityFloor: number("opacityFloor"),
		fitBboxPercentile: number("fitBboxPercentile"),
		yawDeg: number("yawDeg", "yaw"),
	}
}

function applyRuntimeConfig(cfg) {
	sceneFit = fitSettingsFromConfig(cfg)
}

// --- Scene yaw estimation ------------------------------------------------------
// Tripo's returned orientation is CONTENT-DEPENDENT — saved runs needed different
// quarter-turns under the same pipeline, with and without terrain — so no fixed yaw
// knob can seat every reconstruction facing its block-out. Estimate the quarter-turn
// per run instead: project the raw splat and the guide blocks through the capture camera
// and pick the yaw whose silhouette overlaps best AND whose distinct colour masses (a
// blue roof, brown crates) land where the same-coloured blocks are.
// Validated offline against runs 0101/0102/0104 (3/3 with wide margins); monochrome
// content falls back to silhouette-only, which is genuinely ambiguous ±90 there.
const ISO_PROJ_RIGHT = [1 / Math.sqrt(2), 0, -1 / Math.sqrt(2)] // capture camera basis
const ISO_PROJ_UP = [-1 / Math.sqrt(6), 2 / Math.sqrt(6), -1 / Math.sqrt(6)]
const YAW_GRID = 32
const YAW_FTP_GRID = 64 // footprint raster resolution — must match FTP_G in yaw-core.js

function captureProjectionBasis(theta = FRONT_THETA, phi = FRONT_PHI) {
	const eye = new THREE.Vector3().setFromSpherical(new THREE.Spherical(1, phi, theta))
	const right = new THREE.Vector3(0, 1, 0).cross(eye).normalize()
	const up = new THREE.Vector3().crossVectors(eye, right).normalize()
	return {
		right: [right.x, right.y, right.z],
		up: [up.x, up.y, up.z],
		yawOffsetDeg: THREE.MathUtils.radToDeg(theta - FRONT_THETA),
	}
}

async function guideOccupancy(blob) {
	if (!blob || typeof createImageBitmap !== "function") return null
	let bitmap
	try {
		bitmap = await createImageBitmap(blob)
		const size = 128
		const canvas = document.createElement("canvas")
		canvas.width = canvas.height = size
		const ctx = canvas.getContext("2d", { willReadFrequently: true })
		ctx.drawImage(bitmap, 0, 0, size, size)
		const data = ctx.getImageData(0, 0, size, size).data
		const pixels = []
		let minX = size, maxX = -1, minY = size, maxY = -1
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const o = (y * size + x) * 4
				if (data[o + 3] <= 20 || data[o] + data[o + 1] + data[o + 2] <= 30) continue
				pixels.push([x, y])
				minX = Math.min(minX, x); maxX = Math.max(maxX, x)
				minY = Math.min(minY, y); maxY = Math.max(maxY, y)
			}
		}
		if (!pixels.length) return null
		const out = new Set()
		for (const [x, y] of pixels) {
			const gx = Math.min(YAW_GRID - 1, Math.floor(((x - minX) / Math.max(1, maxX - minX + 1)) * YAW_GRID))
			// Canvas Y points down; ISO_PROJ_UP points up.
			const gy = Math.min(YAW_GRID - 1, Math.floor(((maxY - y) / Math.max(1, maxY - minY + 1)) * YAW_GRID))
			out.add(gx * YAW_GRID + gy)
		}
		return out
	} catch {
		return null
	} finally {
		bitmap?.close?.()
	}
}

function unitChroma(r, g, b) {
	const m = (r + g + b) / 3
	const v = [r - m, g - m, b - m]
	const l = Math.hypot(v[0], v[1], v[2])
	return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l, l] : [0, 0, 0, 0]
}

// Painted-ground colour sampler for the yaw estimator. Distinctive painted features (a
// pond, mud paths) sit at KNOWN world positions on the paint canvas, so the true yaw is
// the one that lands the splat's near-floor colours on them — far stronger evidence than
// any silhouette heuristic. "Distinctive" = quantized colour differs from the dominant
// (base terrain) colour; a monochrome ground returns null (no directional signal).
function paintedGroundSampler() {
	if (!world.groundInkBounds()) return null
	const S = 256
	const canvas = document.createElement("canvas")
	canvas.width = canvas.height = S
	const ctx = canvas.getContext("2d", { willReadFrequently: true })
	ctx.clearRect(0, 0, S, S)
	ctx.drawImage(world.paint.canvas, 0, 0, S, S)
	const data = ctx.getImageData(0, 0, S, S).data
	const binOf = o => ((data[o] >> 5) << 6) | ((data[o + 1] >> 5) << 3) | (data[o + 2] >> 5)
	const bins = new Map()
	for (let o = 0; o < data.length; o += 4) {
		if (data[o + 3] <= 32) continue
		const k = binOf(o)
		bins.set(k, (bins.get(k) ?? 0) + 1)
	}
	if (!bins.size) return null
	let dominant = -1, dominantCount = 0, painted = 0
	for (const [k, c] of bins) { painted += c; if (c > dominantCount) { dominantCount = c; dominant = k } }
	if (painted - dominantCount < painted * 0.04) return null
	let waterCells = 0, waterSumX = 0, waterSumZ = 0
	const half = GROUND_SHEET_SIZE / 2
	for (let o = 0; o < data.length; o += 4) {
		if (data[o + 3] > 32 && data[o + 2] > data[o] + 20 && data[o + 2] >= data[o + 1]) {
			waterCells++
			const px = (o / 4) % S, pz = Math.floor(o / 4 / S)
			waterSumX += (px + 0.5) / S * GROUND_SHEET_SIZE - half
			waterSumZ += (pz + 0.5) / S * GROUND_SHEET_SIZE - half
		}
	}
	const waterCenter = waterCells ? [waterSumX / waterCells, waterSumZ / waterCells] : null
	const binColor = k => [((k >> 6) & 7) * 32 + 16, ((k >> 3) & 7) * 32 + 16, (k & 7) * 32 + 16]
	const dominantColor = dominant < 0 ? null : binColor(dominant)
	// Every painted colour covering >3% of the ink (base terrain, paths, dirt patches):
	// splat material in these hues is GROUND, so guide-block colours matching them make
	// unreliable anchors (a brown stump anchor pulled toward a brown painted path).
	const prominentColors = [...bins.entries()].filter(([, c]) => c > painted * 0.03).map(([k]) => binColor(k))
	const cellAt = (wx, wz) => {
		const i = Math.floor(((wx + half) / GROUND_SHEET_SIZE) * S)
		const j = Math.floor(((wz + half) / GROUND_SHEET_SIZE) * S)
		if (i < 0 || i >= S || j < 0 || j >= S) return -1
		const o = (j * S + i) * 4
		return data[o + 3] <= 32 ? -1 : o
	}
	return {
		waterCells,
		waterCenter,
		dominantColor,
		prominentColors,
		data, // raw S×S RGBA pixels — lets the yaw worker replicate sample/isWater as pure data
		size: S,
		sample(wx, wz) {
			const o = cellAt(wx, wz)
			if (o < 0) return null
			return { r: data[o], g: data[o + 1], b: data[o + 2], distinct: binOf(o) !== dominant }
		},
		// Painted water = blue over red (hue order survives style transfer; brightness does not).
		isWater(wx, wz) {
			const o = cellAt(wx, wz)
			if (o < 0) return null
			return data[o + 2] > data[o] + 20 && data[o + 2] >= data[o + 1]
		},
	}
}

// Downsample a generation image into a content-bounds-normalized colour grid for
// the estimator's render-and-compare term. Same conventions as guideOccupancy:
// content bounds from non-background pixels, canvas Y flipped so the grid's v
// axis points up like the projection basis. Background = transparent, near-black
// (the capture's empty surround), or near-white (the image model's plain backdrop).
const PHOTO_GRID = 20
async function imageColorGrid(blob) {
	if (!blob || typeof createImageBitmap !== "function") return null
	let bitmap
	try {
		bitmap = await createImageBitmap(blob)
		const size = 160
		const canvas = document.createElement("canvas")
		canvas.width = canvas.height = size
		const ctx = canvas.getContext("2d", { willReadFrequently: true })
		ctx.drawImage(bitmap, 0, 0, size, size)
		const data = ctx.getImageData(0, 0, size, size).data
		const keep = []
		let minX = size, maxX = -1, minY = size, maxY = -1
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const o = (y * size + x) * 4
				const sum = data[o] + data[o + 1] + data[o + 2]
				if (data[o + 3] <= 20 || sum <= 30 || sum >= 735) continue
				keep.push([x, y, data[o], data[o + 1], data[o + 2]])
				minX = Math.min(minX, x); maxX = Math.max(maxX, x)
				minY = Math.min(minY, y); maxY = Math.max(maxY, y)
			}
		}
		if (keep.length < size * size * 0.04) return null // nearly empty — no usable photo evidence
		const G = PHOTO_GRID
		const sums = new Float32Array(G * G * 3)
		const counts = new Uint32Array(G * G)
		for (const [x, y, r, g, b] of keep) {
			const gx = Math.min(G - 1, Math.floor(((x - minX) / Math.max(1, maxX - minX + 1)) * G))
			const gy = Math.min(G - 1, Math.floor(((maxY - y) / Math.max(1, maxY - minY + 1)) * G))
			const cell = gx * G + gy
			counts[cell]++
			sums[cell * 3] += r; sums[cell * 3 + 1] += g; sums[cell * 3 + 2] += b
		}
		const cellPixels = (size / G) ** 2 * ((maxX - minX + 1) * (maxY - minY + 1)) / (size * size)
		const grid = new Float32Array(G * G * 3)
		const cover = new Uint8Array(G * G)
		for (let c = 0; c < G * G; c++) {
			if (counts[c] < Math.max(2, cellPixels * 0.25)) continue // mostly background
			cover[c] = 1
			grid[c * 3] = sums[c * 3] / counts[c]
			grid[c * 3 + 1] = sums[c * 3 + 1] / counts[c]
			grid[c * 3 + 2] = sums[c * 3 + 2] / counts[c]
		}
		return { grid: [...grid], cover: [...cover], size: G }
	} catch {
		return null
	} finally {
		bitmap?.close?.()
	}
}

async function estimateSceneYaw(bytes, meshes, guide = null, captureAngles = null, photoImage = null) {
	const basis = captureAngles ? captureProjectionBasis(captureAngles.theta, captureAngles.phi) : { right: ISO_PROJ_RIGHT, up: ISO_PROJ_UP, yawOffsetDeg: 0 }
	const projRight = basis.right
	const projUp = basis.up
	// The drawable ground sheet's geometry is always the full workspace canvas, not the actual
	// painted outline, so it would swamp the normalized comparison. Real blocks provide
	// the reliable position/colour anchors for both grounded and object-only scenes.
	meshes = meshes?.filter(mesh => !mesh.userData.isGroundSheet && mesh.geometry)
	if (!meshes?.length || bytes.length < 32 * 100) return null
	// Project every block's sampled volume: occupancy silhouette + per-colour anchors.
	const corner = new THREE.Vector3()
	const blockUV = []
	const blockRects = [] // per-mesh projected uv bounds — every block must be "explained"
	for (const mesh of meshes) {
		const color = new THREE.Color(`#${mesh.userData.baseColor ?? mesh.material.color.getHexString()}`)
		const key = color.getHexString()
		mesh.updateWorldMatrix(true, false)
		const geo = mesh.geometry.boundingBox ?? (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox)
		const vol = mesh.scale.x * mesh.scale.y * mesh.scale.z
		const rect = [Infinity, -Infinity, Infinity, -Infinity]
		for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) {
			corner.set(
				geo.min.x + (a / 2) * (geo.max.x - geo.min.x),
				geo.min.y + (b / 2) * (geo.max.y - geo.min.y),
				geo.min.z + (c / 2) * (geo.max.z - geo.min.z),
			).applyMatrix4(mesh.matrixWorld)
			const pu = corner.x * projRight[0] + corner.y * projRight[1] + corner.z * projRight[2]
			const pv = corner.x * projUp[0] + corner.y * projUp[1] + corner.z * projUp[2]
			blockUV.push([pu, pv, key, vol / 27])
			rect[0] = Math.min(rect[0], pu); rect[1] = Math.max(rect[1], pu)
			rect[2] = Math.min(rect[2], pv); rect[3] = Math.max(rect[3], pv)
		}
		blockRects.push(rect)
	}
	let bu0 = Infinity, bu1 = -Infinity, bv0 = Infinity, bv1 = -Infinity
	for (const [u, v] of blockUV) { bu0 = Math.min(bu0, u); bu1 = Math.max(bu1, u); bv0 = Math.min(bv0, v); bv1 = Math.max(bv1, v) }
	// Ground scenes: the splat (and guide) span the whole painted terrain, so block
	// anchors must be expressed in that same frame — the blocks' own extent is a
	// different, incompatible space, and comparing centroids across the two frames made
	// the colour term prefer the wrong quarter-turn (run 0112: picked 0°, truth 90°).
	if (world.groundInkBounds()) {
		const domain = wholeSceneBox()
		bu0 = Infinity; bu1 = -Infinity; bv0 = Infinity; bv1 = -Infinity
		for (let c = 0; c < 8; c++) {
			corner.set(
				c & 1 ? domain.max.x : domain.min.x,
				c & 2 ? domain.max.y : domain.min.y,
				c & 4 ? domain.max.z : domain.min.z,
			)
			const u = corner.x * projRight[0] + corner.y * projRight[1] + corner.z * projRight[2]
			const v = corner.x * projUp[0] + corner.y * projUp[1] + corner.z * projUp[2]
			bu0 = Math.min(bu0, u); bu1 = Math.max(bu1, u)
			bv0 = Math.min(bv0, v); bv1 = Math.max(bv1, v)
		}
	}
	const normRects = blockRects.map(([u0, u1, v0, v1]) => [
		(u0 - bu0) / Math.max(1e-9, bu1 - bu0), (u1 - bu0) / Math.max(1e-9, bu1 - bu0),
		(v0 - bv0) / Math.max(1e-9, bv1 - bv0), (v1 - bv0) / Math.max(1e-9, bv1 - bv0),
	])
	const blockOcc = new Set()
	const anchors = new Map() // colour key -> [Σux, Σvy, Σw]
	let blockMass = 0
	for (const [u, v, key, w] of blockUV) {
		const x = (u - bu0) / Math.max(1e-9, bu1 - bu0)
		const y = (v - bv0) / Math.max(1e-9, bv1 - bv0)
		blockOcc.add(Math.min(YAW_GRID - 1, x * YAW_GRID | 0) * YAW_GRID + Math.min(YAW_GRID - 1, y * YAW_GRID | 0))
		const a = anchors.get(key) ?? anchors.set(key, [0, 0, 0]).get(key)
		a[0] += x * w; a[1] += y * w; a[2] += w
		blockMass += w
	}
	// The actual capture contains the exact projected silhouette and spacing, including
	// irregular bases made from blocks. It is a stronger yaw target than the sparse 3×3×3
	// block samples above. Keep those samples for colour anchors and as a fallback for
	// older sessions where no guide can be rendered.
	const occupancyTarget = await guideOccupancy(guide) ?? blockOcc
	// Parse guide hexes directly — THREE.Color would convert them to the linear working
	// space, while the splat's stored colour bytes (and unitChroma) are display sRGB.
	const anchorChroma = new Map([...anchors.keys()].map(key => [key, unitChroma(
		parseInt(key.slice(0, 2), 16), parseInt(key.slice(2, 4), 16), parseInt(key.slice(4, 6), 16),
	)]))

	// Ground evidence (painted-sheet pixels, footprint raster, colour-anchor classes) is
	// prepared here as plain data. The heavy work — splat sampling and the candidate
	// sweep — runs in yaw-core.js inside a Web Worker so this step no longer freezes the
	// tab; the scoring terms and their reasoning live there now.
	const groundSampler = world.groundInkBounds() ? paintedGroundSampler() : null
	let ground = null
	if (groundSampler) {
		const target = wholeSceneBox()
		const tGeom = {
			tcx: (target.min.x + target.max.x) / 2, tcz: (target.min.z + target.max.z) / 2,
			tSpanX: target.max.x - target.min.x, tSpanZ: target.max.z - target.min.z,
		}
		const padX = tGeom.tSpanX * 0.05, padZ = tGeom.tSpanZ * 0.05
		tGeom.fx0 = tGeom.tcx - tGeom.tSpanX / 2 - padX
		tGeom.fz0 = tGeom.tcz - tGeom.tSpanZ / 2 - padZ
		tGeom.fw = tGeom.tSpanX + 2 * padX
		tGeom.fh = tGeom.tSpanZ + 2 * padZ
		// Footprint registration target: the drawn ground outline rasterized over the
		// target box (rotation- and mirror-sensitive everywhere — see run 0170).
		const inkGrid = new Uint8Array(YAW_FTP_GRID * YAW_FTP_GRID)
		let inkCells = 0
		for (let gz = 0; gz < YAW_FTP_GRID; gz++) {
			for (let gx = 0; gx < YAW_FTP_GRID; gx++) {
				const wx = tGeom.fx0 + (gx + 0.5) / YAW_FTP_GRID * tGeom.fw
				const wz = tGeom.fz0 + (gz + 0.5) / YAW_FTP_GRID * tGeom.fh
				if (groundSampler.sample(wx, wz)) { inkGrid[gz * YAW_FTP_GRID + gx] = 1; inkCells++ }
			}
		}
		// Colour-anchor classes: the splat's DISTINCTIVE colour masses must land near the
		// same-coloured guide blocks (run 0163). Colours near the painted terrain's
		// dominant chroma (bush green ≈ grass) carry no signal and are skipped.
		const paintedChromas = (groundSampler.prominentColors ?? []).map(c => unitChroma(...c))
		const matchesPainted = cc => paintedChromas.some(pcc => (cc[3] < 12) === (pcc[3] < 12) && (cc[3] < 12 || cc[0] * pcc[0] + cc[1] * pcc[1] + cc[2] * pcc[2] > 0.85))
		const anchorClasses = [] // { dir:[3]|null(neutral), targets:[[x,z]] }
		for (const mesh of meshes) {
			const hex = mesh.userData.baseColor ?? mesh.material.color.getHexString()
			const cc = unitChroma(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16))
			const neutral = cc[3] < 12 // grey blocks anchor on NEUTRALITY instead of a chroma direction
			if (!neutral && cc[3] < 25) continue // weak chroma: neither a colour nor a grey landmark
			if (matchesPainted(cc)) continue // ≈ a painted terrain colour — ground would pollute it
			mesh.updateWorldMatrix(true, false)
			const wp = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld)
			const existing = anchorClasses.find(k => (k.dir == null) === neutral && (neutral || k.dir[0] * cc[0] + k.dir[1] * cc[1] + k.dir[2] * cc[2] > 0.9))
			if (existing) existing.targets.push([wp.x, wp.z])
			else anchorClasses.push({ dir: neutral ? null : [cc[0], cc[1], cc[2]], targets: [[wp.x, wp.z]] })
		}
		ground = {
			grid: groundSampler.data,
			gridSize: groundSampler.size,
			sheetSize: GROUND_SHEET_SIZE,
			waterCells: groundSampler.waterCells,
			waterCenter: groundSampler.waterCenter,
			target: tGeom,
			inkGrid,
			inkCells,
			anchorClasses,
		}
	}

	// The bytes copy is rebuilt per attempt: a transferred buffer is unusable afterwards,
	// and the fallback must never receive a detached one.
	// Render-and-compare evidence: the generated image IS the ground truth of what
	// the splat depicts from the capture camera, so a colour grid of it separates
	// mirrored candidates that fool every geometric term (see yaw-core's photo term).
	// Prefer the detailed output image (the splat's colours reproduce it); the
	// block-out guide is a weaker fallback for replays that only saved the capture.
	const photo = await imageColorGrid(photoImage) ?? await imageColorGrid(guide)
	const buildInput = () => ({
		bytes: bytes.slice(),
		projRight,
		projUp,
		yawOffsetDeg: basis.yawOffsetDeg,
		blocks: {
			normRects,
			blockOcc: [...blockOcc],
			occupancyTarget: occupancyTarget === blockOcc ? null : [...occupancyTarget],
			anchors: [...anchors],
			anchorChroma: [...anchorChroma],
			blockMass,
		},
		ground,
		photo,
	})
	let result = null
	try {
		result = await runYawEstimateJob(buildInput())
	} catch (error) {
		console.warn("[fit] yaw worker unavailable — estimating on the main thread:", error)
		result = estimateYawFromData(buildInput())
	}
	if (!result) return null
	if (result.error) {
		console.warn("[fit] yaw estimate failed:", result.error)
		return null
	}
	console.log(result.log)
	window.__wsLastYaw = { yawDeg: result.yawDeg, mirrorZ: result.mirrorZ, top: result.top.slice(0, 4) }
	return { yawDeg: result.yawDeg, mirrorZ: result.mirrorZ }
}

// One shared yaw worker, one job at a time. Both call sites run under the generating
// lock, but the chain guards against overlap anyway; only the splat-bytes buffer is
// transferred (it is by far the largest input — the pixel grids are just cloned).
let yawWorker = null
let yawWorkerChain = Promise.resolve()

function runYawEstimateJob(input) {
	const run = () => new Promise((resolve, reject) => {
		try {
			yawWorker ??= new Worker("/scripts/yaw-worker.js?v=yaw-1", { type: "module" })
		} catch (error) {
			reject(error)
			return
		}
		const worker = yawWorker
		const cleanup = () => {
			worker.removeEventListener("message", onMessage)
			worker.removeEventListener("error", onError)
		}
		const onMessage = event => { cleanup(); resolve(event.data) }
		const onError = event => {
			cleanup()
			yawWorker = null
			worker.terminate()
			reject(event.error ?? new Error(event.message || "yaw worker failed"))
		}
		worker.addEventListener("message", onMessage)
		worker.addEventListener("error", onError)
		worker.postMessage(input, [input.bytes.buffer])
	})
	const job = yawWorkerChain.then(run, run)
	yawWorkerChain = job.catch(() => {})
	return job
}

// Bounds used by both generation and saved-session re-fitting. The ground contributes
// only its DRAWN extent (the transparent sheet around the painting is void, not scene).
function wholeSceneBox() {
	const box = new THREE.Box3()
	const ink = world.groundInkBounds()
	if (ink) box.union(ink)
	for (const mesh of world.primitives) box.union(new THREE.Box3().setFromObject(mesh))
	return box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 1, 2)) : box
}

// Carve the single seated scene splat into independently movable pieces. The primary
// path projects fitted gaussians back through the canonical capture camera and assigns
// them to masks made from the block-out's connected object groups. This keeps one object
// together even when its single-view reconstruction is several disconnected shells
// (crate lid/front/sides), while unmatched haze or hallucinated terrain stays in a static
// remainder. The older content-only voxel splitter remains as a fallback when the guide
// masks cannot confidently recover every expected object.
function segmentSceneSplat(hasGround = true) {
	const record = world.generated.find(g => g.mesh.userData.genName === "scene")
	const packed = record?.mesh.packedSplats
	if (!packed?.forEachSplat) return

	// ---- The dials ------------------------------------------------------------------
	const FLOOR_BAND = segmentationTuning.floorBand // height above local floor that still counts as ground; RAISE if objects grab turf, LOWER if short props vanish into the floor
	const FRINGE_LOW = 0.25 // fringe claim floor: below this stays ground even under a blob (the "contact patch" an object leaves behind)
	const FRINGE_DILATE = 1 // fringe claim reach in voxels beyond the blob's own footprint; raise if object bases get clipped, lower if bases grab a turf ring
	const CELL = 0.5 // floor height-map cell (world units)
	// Resolve every scene at roughly the same voxel density. A fixed world-space voxel
	// made compact scenes far too coarse: the visible gap between two props could land in
	// adjacent voxels and 26-connectivity would merge them into one object. A 200-cell
	// target across the longest scene axis cleanly separates those gaps while remaining
	// small enough for the bridge/core pass below.
	const VOX_TARGET_CELLS = segmentationTuning.voxelCells
	const VOX_MIN = 0.01
	const VOX_MAX = 0.25
	// Master culling intensities (100% = the tuned defaults). PRE scales the stages that
	// fold raw material into the ground BEFORE objects are decided (tuft folding, turf
	// trim, base detach, image-box gate); POST scales the strippers that clean pieces
	// AFTER segmentation (skirt guard band, skin cull band, wisp prune, speck cull,
	// image-box clip tightness).
	const PRE_CULL = Math.max(0, segmentationTuning.preCullIntensity ?? 1)
	const POST_CULL = Math.max(0, segmentationTuning.postCullIntensity ?? 1)
	// Global cleanup controls. Amount is the deterministic fraction of detected candidates
	// removed. Reach is a fraction of each object's own robust bottom-to-top height.
	const CULL_AMOUNT = SEGMENTATION_CLEANUP_ENABLED ? clamp01((segmentationTuning.cullAmount ?? 100) / 100) : 0
	const CULL_HEIGHT_FRACTION = clamp01(segmentationTuning.cleanupReach ?? 0.25)
	const MIN_BLOB = Math.max(40, segmentationTuning.minBlob * PRE_CULL) // smaller blobs (grass tufts) fold back into the ground
	const ERODE = 2 // floor-map min-filter radius in cells; raise for very wide flat-bottomed objects faking an elevated floor
	const SKIN_FLATNESS = 0.45 // pancake test: thinnest axis under this fraction of the median axis
	const SKIN_UPRIGHT = 0.75 // ...and lying flat (|vertical component of thin axis| above this) → ground skin, stays behind
	const SKIN_BAND_PAD = 0.4 * POST_CULL // how far above FLOOR_BAND the skin cull still applies
	const BRIDGE_MIN_NEIGHBORS = Math.round(1 + clamp01(segmentationTuning.bridgeCut) * 4) // bridge cutting: higher splits more thin links
	const BRIDGE_MIN_DENSITY = Math.round(1 + clamp01(segmentationTuning.bridgeCut) * 8) // higher peels sparse bridges more aggressively
	const CORE_MIN_VOXELS = Math.round(30 + clamp01(segmentationTuning.bridgeCut) * 120) // a peeled component must be substantial before it can split a blob
	const COLOR_SPLIT = clamp01(segmentationTuning.colorSplit ?? 0) // higher = stronger ground-contact colour boundaries
	// Color is supporting evidence, not an object detector. Keep a safety floor so 100%
	// does not treat normal shading as a new object, and never trust near-black voxels
	// whose apparent colour is mostly shadow noise.
	const COLOR_SPLIT_THRESHOLD = lerp(0.65, 0.10, COLOR_SPLIT) // chromaticity distance; brightness-independent
	const COLOR_SPLIT_DARK_MEAN = lerp(30, 14, COLOR_SPLIT)
	const COLOR_SPLIT_GROUND_PAD = 1.25 // colour cuts matter most around contact/ground-level material changes

	// Pass 1: positions + XZ bounds.
	const n = packed.numSplats
	const pxs = new Float32Array(n)
	const pys = new Float32Array(n)
	const pzs = new Float32Array(n)
	const prgb = new Uint8Array(n * 3) // display-sRGB bytes for mask colour affinity
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
	packed.forEachSplat((i, center, _scales, _quaternion, _opacity, color) => {
		pxs[i] = center.x
		pys[i] = center.y
		pzs[i] = center.z
		if (color) {
			prgb[i * 3] = Math.min(255, Math.max(0, color.r * 255 + 0.5)) | 0
			prgb[i * 3 + 1] = Math.min(255, Math.max(0, color.g * 255 + 0.5)) | 0
			prgb[i * 3 + 2] = Math.min(255, Math.max(0, color.b * 255 + 0.5)) | 0
		}
		if (center.x < minX) minX = center.x
		if (center.x > maxX) maxX = center.x
		if (center.y < minY) minY = center.y
		if (center.y > maxY) maxY = center.y
		if (center.z < minZ) minZ = center.z
		if (center.z > maxZ) maxZ = center.z
	})
	const spanX = Math.max(1e-3, maxX - minX)
	const spanY = Math.max(1e-3, maxY - minY)
	const spanZ = Math.max(1e-3, maxZ - minZ)
	const VOX = Math.max(VOX_MIN, Math.min(VOX_MAX, Math.max(spanX, spanY, spanZ) / VOX_TARGET_CELLS))

	// ---- Image-box projection (source-geometry evidence) -------------------------------
	// Project every seated gaussian into the generated image's frame (the capture ortho
	// camera is fully known: stored capture angles + the wholeSceneBox framing), so
	// the block-out's projected object boxes become usable per-gaussian evidence: material
	// inside an object's box is that object; material outside EVERY box is haze/wisp. The
	// image prompt requires composition preservation, and IMG_BOX_PAD below allows modest
	// detail growth or fitting drift around the source silhouette.
	let imgU = null, imgV = null // 0-1000 image coords per gaussian
	let imageObjectBoxes = null, imageTerrainBox = null, imageFeatureBoxes = []
	if (sceneImageBoxes?.length) {
		const basis = captureProjectionBasis(
			Number.isFinite(sceneSession?.captureTheta) ? sceneSession.captureTheta : FRONT_THETA,
			Number.isFinite(sceneSession?.capturePhi) ? sceneSession.capturePhi : FRONT_PHI,
		)
		const frameBox = wholeSceneBox()
		const c = frameBox.getCenter(new THREE.Vector3())
		const size = frameBox.getSize(new THREE.Vector3())
		const half = Math.max(0.3, 0.5 * Math.hypot(size.x, size.y, size.z)) * 1.12
		const uc = c.x * basis.right[0] + c.y * basis.right[1] + c.z * basis.right[2]
		const vc = c.x * basis.up[0] + c.y * basis.up[1] + c.z * basis.up[2]
		imgU = new Float32Array(n)
		imgV = new Float32Array(n)
		for (let i = 0; i < n; i++) {
			const u = pxs[i] * basis.right[0] + pys[i] * basis.right[1] + pzs[i] * basis.right[2]
			const v = pxs[i] * basis.up[0] + pys[i] * basis.up[1] + pzs[i] * basis.up[2]
			imgU[i] = ((u - uc) / (2 * half) + 0.5) * 1000
			imgV[i] = (1 - ((v - vc) / (2 * half) + 0.5)) * 1000
		}
		// Ground features (ponds, paths) are terrain when custom/dev boxes include them;
		// only true object groups count as objectness evidence.
		const groundish = /terrain|pond|water|lake|path|road|shadow|ground/
		imageObjectBoxes = sceneImageBoxes.filter(b => Array.isArray(b.box_2d) && !groundish.test((b.label ?? "").toLowerCase()))
		imageTerrainBox = sceneImageBoxes.find(b => (b.label ?? "").toLowerCase() === "terrain" && Array.isArray(b.box_2d))?.box_2d ?? null
		imageFeatureBoxes = sceneImageBoxes.filter(b => Array.isArray(b.box_2d) && /pond|water|lake|puddle|path|road/.test((b.label ?? "").toLowerCase())).map(b => b.box_2d)
		console.log(`[segment] image boxes → ${imageObjectBoxes.length} object box(es)${imageTerrainBox ? " + terrain" : ""} projected onto ${n} gaussians`)
	}
	const IMG_BOX_PAD = 40 // 0-1000 units of slack for fit/composition misalignment
	const inImageBox = (i, box, pad = IMG_BOX_PAD) =>
		imgV[i] >= box[0] - pad && imgU[i] >= box[1] - pad && imgV[i] <= box[2] + pad && imgU[i] <= box[3] + pad
	const imageObjectness = indices => {
		if (!imageObjectBoxes) return null
		let inBox = 0
		for (const i of indices) if (imageObjectBoxes.some(b => inImageBox(i, b.box_2d))) inBox++
		return inBox / Math.max(1, indices.length)
	}

	// Local floor height map: per-cell low percentile of gaussian heights. A MAP, not a
	// single plane — the drawn ground has real relief. Sparse cells inherit the median.
	const gw = Math.max(1, Math.min(96, Math.ceil(spanX / CELL)))
	const gh = Math.max(1, Math.min(96, Math.ceil(spanZ / CELL)))
	const cellOfXZ = (x, z) => {
		const cx = Math.min(gw - 1, Math.max(0, Math.floor(((x - minX) / spanX) * gw)))
		const cz = Math.min(gh - 1, Math.max(0, Math.floor(((z - minZ) / spanZ) * gh)))
		return cz * gw + cx
	}
	const cellHeights = Array.from({ length: gw * gh }, () => [])
	for (let i = 0; i < n; i++) cellHeights[cellOfXZ(pxs[i], pzs[i])].push(pys[i])
	const floorLevel = new Float32Array(gw * gh).fill(NaN)
	const validLevels = []
	for (let c = 0; c < gw * gh; c++) {
		const hs = cellHeights[c]
		if (hs.length < 6) continue
		hs.sort((a, b) => a - b)
		floorLevel[c] = hs[Math.floor(hs.length * 0.3)]
		validLevels.push(floorLevel[c])
	}
	validLevels.sort((a, b) => a - b)
	const globalFloor = validLevels.length ? validLevels[Math.floor(validLevels.length / 2)] : 0
	for (let c = 0; c < gw * gh; c++) if (Number.isNaN(floorLevel[c])) floorLevel[c] = globalFloor
	// Erode (min-filter) the floor map: cells under a WIDE object see only the object's
	// own surface and estimate a "floor" partway up it, which left the object's lower
	// body behind as a shell when the piece moved. A cell's floor can never sit above
	// its neighbourhood's lowest estimate, so take the neighbourhood minimum — the floor
	// under a rock comes from the grass around it.
	// The RAW (un-eroded) map is the actual local terrain SURFACE — kept for the turf
	// trim below, which needs "how high is the ground right here", not the eroded
	// lower bound used to seed object blobs.
	const rawFloorLevel = Float32Array.from(floorLevel)
	// 3×3 MAX of the raw floor = a contamination-resistant "local surface": under a
	// wide object or at a plate-edge cliff the cell's own raw value sits partway up the
	// object / down the cliff face; the neighbourhood maximum recovers the true nearby
	// terrain top for hug tests.
	const surfLevel = new Float32Array(gw * gh)
	for (let cz = 0; cz < gh; cz++) {
		for (let cx = 0; cx < gw; cx++) {
			let high = -Infinity
			for (let dz = -1; dz <= 1; dz++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nx = cx + dx, nz = cz + dz
					if (nx < 0 || nx >= gw || nz < 0 || nz >= gh) continue
					const v = floorLevel[nz * gw + nx]
					if (v > high) high = v
				}
			}
			surfLevel[cz * gw + cx] = high
		}
	}
	const erodedLevel = new Float32Array(gw * gh)
	for (let cz = 0; cz < gh; cz++) {
		for (let cx = 0; cx < gw; cx++) {
			let low = Infinity
			for (let dz = -ERODE; dz <= ERODE; dz++) {
				for (let dx = -ERODE; dx <= ERODE; dx++) {
					const nx = cx + dx
					const nz = cz + dz
					if (nx < 0 || nx >= gw || nz < 0 || nz >= gh) continue
					const v = floorLevel[nz * gw + nx]
					if (v < low) low = v
				}
			}
			erodedLevel[cz * gw + cx] = low
		}
	}
	floorLevel.set(erodedLevel)
	const cullHash = (x, y, z, salt = 0) => {
		const value = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + salt * 19.19) * 43758.5453123
		return value - Math.floor(value)
	}
	let cleanupHeightRanges = new Map()
	const refreshCleanupHeightRanges = labels => {
		const heights = new Map()
		for (let i = 0; i < n; i++) {
			const label = labels[i]
			if (label < 0) continue
			let values = heights.get(label)
			if (!values) heights.set(label, values = [])
			values.push(pys[i])
		}
		cleanupHeightRanges = new Map()
		for (const [label, values] of heights) {
			values.sort((a, b) => a - b)
			// Ignore the outer 1% so a single high/low reconstruction fleck cannot redefine
			// where an object's bottom or top is.
			const low = values[Math.floor((values.length - 1) * 0.01)]
			const high = values[Math.ceil((values.length - 1) * 0.99)]
			cleanupHeightRanges.set(label, { low, high: Math.max(low, high) })
		}
	}
	const withinCullHeight = (x, y, z, label = null) => {
		if (CULL_HEIGHT_FRACTION >= 1) return true
		const range = cleanupHeightRanges.get(label)
		if (range) {
			const height = Math.max(VOX, range.high - range.low)
			const basePad = Math.min(VOX, height * 0.03)
			return y <= range.low + height * CULL_HEIGHT_FRACTION + basePad
		}
		// Ground/remainder candidates have no object label. Keep their fallback local to
		// the terrain baseline; true object candidates use the per-piece range above.
		if (hasGround) return y <= floorLevel[cellOfXZ(x, z)] + Math.max(VOX, spanY * CULL_HEIGHT_FRACTION)
		return y <= minY + spanY * CULL_HEIGHT_FRACTION
	}
	const mayCullAt = (x, y, z, salt = 0, label = null) => {
		if (CULL_AMOUNT <= 0 || !withinCullHeight(x, y, z, label)) return false
		return CULL_AMOUNT >= 1 || cullHash(x, y, z, salt) < CULL_AMOUNT
	}
	const mayCullIndex = (i, salt = 0, label = blobOf[i]) => mayCullAt(pxs[i], pys[i], pzs[i], salt, label)

	// Object groups from the block-out: the source of expected-object COUNT, rough
	// layout, size, and palette. The splat's own content decides what actually exists
	// and where (the image model drifts objects several units from their clusters, so
	// projected block masks must never directly own gaussians); the groups are matched
	// to content blobs after flood fill instead.
	const semanticGroups = computeObjects(world.primitives)

	// Flood fill (26-connected voxel components) over everything ABOVE the floor band.
	const VOFF = 128 // voxel index offset keeps negative heights positive
	const voxels = new Map() // packed voxel key -> { idx, blob, kx, ky, kz, sr, sg, sb, y, chroma, nearGround }
	for (let i = 0; i < n; i++) {
		if (hasGround && pys[i] <= floorLevel[cellOfXZ(pxs[i], pzs[i])] + FLOOR_BAND) continue
		const kx = Math.floor((pxs[i] - minX) / VOX)
		const kz = Math.floor((pzs[i] - minZ) / VOX)
		const ky = Math.floor(pys[i] / VOX) + VOFF
		const key = (kx * 2048 + kz) * 2048 + ky
		let v = voxels.get(key)
		if (!v) voxels.set(key, v = { idx: [], blob: -1, kx, ky, kz, sr: 0, sg: 0, sb: 0, y: 0, chroma: null, nearGround: false })
		v.idx.push(i)
		v.sr += prgb[i * 3]
		v.sg += prgb[i * 3 + 1]
		v.sb += prgb[i * 3 + 2]
		v.y += pys[i]
	}
	for (const v of voxels.values()) {
		const inv = 1 / Math.max(1, v.idx.length)
		const r = v.sr * inv
		const g = v.sg * inv
		const b = v.sb * inv
		const sum = r + g + b
		const mean = sum / 3
		v.chroma = sum > 1e-6 ? [r / sum, g / sum, b / sum, mean] : [1 / 3, 1 / 3, 1 / 3, mean]
		if (hasGround) {
			const x = minX + (v.kx + 0.5) * VOX
			const z = minZ + (v.kz + 0.5) * VOX
			v.nearGround = v.y * inv <= surfLevel[cellOfXZ(x, z)] + FLOOR_BAND + COLOR_SPLIT_GROUND_PAD
		}
	}
	const canFloodConnect = (a, b, dy) => {
		if (!COLOR_SPLIT) return true
		// With ground present, color may cut only a same-height contact seam. Requiring both
		// voxels to be near the ground and preserving every vertical link keeps a striped or
		// shaded lighthouse together even at 100%.
		if (hasGround && (dy !== 0 || !(a.nearGround && b.nearGround))) return true
		if (a.chroma[3] < COLOR_SPLIT_DARK_MEAN && b.chroma[3] < COLOR_SPLIT_DARK_MEAN) return true
		const d = Math.hypot(a.chroma[0] - b.chroma[0], a.chroma[1] - b.chroma[1], a.chroma[2] - b.chroma[2])
		return d <= COLOR_SPLIT_THRESHOLD
	}
	const blobs = [] // { count, cols:Set<packed kx,kz> }
	let colorCuts = 0
	for (const [key, seedVox] of voxels) {
		if (seedVox.blob >= 0) continue
		const id = blobs.length
		const blob = { count: 0, cols: new Set() }
		blobs.push(blob)
		seedVox.blob = id
		const stack = [key]
		while (stack.length) {
			const cur = voxels.get(stack.pop())
			blob.count += cur.idx.length
			blob.cols.add(cur.kx * 4096 + cur.kz)
			for (let dx = -1; dx <= 1; dx++) {
				for (let dz = -1; dz <= 1; dz++) {
					for (let dy = -1; dy <= 1; dy++) {
						if (!dx && !dz && !dy) continue
						const nk = ((cur.kx + dx) * 2048 + (cur.kz + dz)) * 2048 + (cur.ky + dy)
						const nb = voxels.get(nk)
						if (nb && nb.blob < 0) {
							if (!canFloodConnect(cur, nb, dy)) {
								colorCuts++
								continue
							}
							nb.blob = id
							stack.push(nk)
						}
					}
				}
			}
		}
	}
	if (colorCuts) console.log(`[segment] color split → ${colorCuts} voxel link(s) cut (strength ${Math.round(COLOR_SPLIT * 100)}%, threshold ${COLOR_SPLIT_THRESHOLD.toFixed(3)})`)
	// Bridge cutting: two SEPARATE objects often flood-fill into one blob through a thin
	// bridge — a chain of grass tufts between them, a contact seam, one diagonal voxel
	// kiss. Bridge voxels have few in-blob neighbours; real surfaces are dense sheets.
	// Peel the low-neighbour skin, find the fat CORES that remain, and if a blob holds
	// two or more cores, grow them back over the peeled voxels (multi-source BFS) and
	// split the blob along that watershed. Peeled remnants that reach no core rejoin
	// whichever side claims them; sub-blobs that end up tiny fold into the ground later.
	const blobVoxKeys = new Map() // blob id -> its voxel keys
	for (const [key, v] of voxels) {
		let arr = blobVoxKeys.get(v.blob)
		if (!arr) blobVoxKeys.set(v.blob, arr = [])
		arr.push(key)
	}
	const neighborKeys = v => {
		const out = []
		for (let dx = -1; dx <= 1; dx++) {
			for (let dz = -1; dz <= 1; dz++) {
				for (let dy = -1; dy <= 1; dy++) {
					if (!dx && !dz && !dy) continue
					out.push(((v.kx + dx) * 2048 + (v.kz + dz)) * 2048 + (v.ky + dy))
				}
			}
		}
		return out
	}
	let splits = 0
	for (const [blobId, keys] of blobVoxKeys) {
		if (blobs[blobId].count < MIN_BLOB || keys.length < CORE_MIN_VOXELS * 2) continue
		const inBlob = new Set(keys)
		// Peel: survivors need in-blob company AND real gaussian density. Thin chains fail
		// the first test; wispy grass-bridge voxels (a handful of gaussians where object
		// surfaces pack dozens) fail the second.
		const survivors = new Set()
		for (const key of keys) {
			const v = voxels.get(key)
			if (v.idx.length < BRIDGE_MIN_DENSITY) continue
			let count = 0
			for (const nk of neighborKeys(v)) if (inBlob.has(nk)) count++
			if (count >= BRIDGE_MIN_NEIGHBORS) survivors.add(key)
		}
		// Cores = connected components of the survivors.
		const coreOf = new Map()
		const coreSizes = []
		for (const key of survivors) {
			if (coreOf.has(key)) continue
			const label = coreSizes.length
			coreSizes.push(0)
			const stack = [key]
			coreOf.set(key, label)
			while (stack.length) {
				const cur = stack.pop()
				coreSizes[coreOf.get(cur)]++
				for (const nk of neighborKeys(voxels.get(cur))) {
					if (survivors.has(nk) && !coreOf.has(nk)) {
						coreOf.set(nk, coreOf.get(cur))
						stack.push(nk)
					}
				}
			}
		}
		const bigCores = coreSizes.map((s, i) => (s >= CORE_MIN_VOXELS ? i : -1)).filter(i => i >= 0)
		if (bigCores.length < 2) continue // one solid core (or none) — nothing to split
		// Grow the big cores back over the whole blob: multi-source BFS, first come wins.
		const owner = new Map()
		const queue = []
		const coreRank = new Map(bigCores.map((c, i) => [c, i]))
		for (const [key, label] of coreOf) {
			if (!coreRank.has(label)) continue
			owner.set(key, coreRank.get(label))
			queue.push(key)
		}
		for (let qi = 0; qi < queue.length; qi++) {
			const cur = queue[qi]
			for (const nk of neighborKeys(voxels.get(cur))) {
				if (inBlob.has(nk) && !owner.has(nk)) {
					owner.set(nk, owner.get(cur))
					queue.push(nk)
				}
			}
		}
		// Relabel: rank 0 keeps this blob id, every further core becomes a new blob.
		const newIds = bigCores.map((_, i) => (i === 0 ? blobId : blobs.push({ count: 0, cols: new Set() }) - 1))
		for (const key of keys) {
			const rank = owner.get(key) ?? 0
			voxels.get(key).blob = newIds[rank]
		}
		splits += bigCores.length - 1
	}
	if (splits) { // recompute per-blob stats after relabeling
		for (const b of blobs) {
			b.count = 0
			b.cols = new Set()
		}
		for (const v of voxels.values()) {
			const b = blobs[v.blob]
			b.count += v.idx.length
			b.cols.add(v.kx * 4096 + v.kz)
		}
	}

	const minBlob = hasGround ? MIN_BLOB : Math.max(40, Math.floor(MIN_BLOB / 4))
	const blobOf = new Int32Array(n).fill(-1)
	for (const v of voxels.values()) {
		const keep = blobs[v.blob].count >= minBlob // tiny floor blobs stay ground; object-only specks attach below
		if (keep) for (const gi of v.idx) blobOf[gi] = v.blob
	}
	const bigBlobIds = blobs.map((b, id) => id).filter(id => blobs[id].count >= minBlob)
	if (!hasGround && !bigBlobIds.length && blobs.length) {
		bigBlobIds.push(blobs.reduce((best, blob, id) => blob.count > blobs[best].count ? id : best, 0))
		for (const v of voxels.values()) if (v.blob === bigBlobIds[0]) for (const gi of v.idx) blobOf[gi] = bigBlobIds[0]
	}
	refreshCleanupHeightRanges(blobOf)

	// ---- Turf trim ---------------------------------------------------------------------
	// Lumpy terrain rises above the (eroded-floor + band) threshold, flood-fills into any
	// object standing on it, and the object then tears a whole slab of grass out of the
	// ground when moved. Standing terrain betrays itself per COLUMN: the blob's content
	// there is a thin skin (small vertical span) hugging the RAW local floor surface.
	// Object walls are tall columns, and overhanging canopy is thin but ELEVATED — both
	// survive. Turf columns touching a real object column are kept as its contact ring.
	if (hasGround && bigBlobIds.length && CULL_AMOUNT > 0) {
		const bigSet = new Set(bigBlobIds)
		// Tuning history: 1.3/1.6 removes terrain slabs completely but eats squat stumps
		// (their turf-tested columns CONNECT to the surrounding slab patch, so a patch-
		// size filter cannot save them) and leaves a large mound remnant that outbids
		// small groups. 1.0/1.2 keeps every object assignment correct on all regression
		// scenes at the cost of a moderate grass skirt on objects standing in lumpy
		// terrain. Correct identity wins.
		const TURF_SPAN = 1.0 * PRE_CULL // thinner vertical extent than any believable object wall
		const TURF_TOP = 1.2 * PRE_CULL // ...and no higher than this above the raw local surface
		// Extra safety for squat isolated objects: turf patches smaller than this many
		// connected columns are left with their blob.
		const MIN_TURF_PATCH = 25
		const colStats = new Map() // blobId -> Map(colKey -> {minKy, maxKy, voxs})
		for (const v of voxels.values()) {
			if (!bigSet.has(v.blob)) continue
			let cols = colStats.get(v.blob)
			if (!cols) colStats.set(v.blob, cols = new Map())
			const key = v.kx * 4096 + v.kz
			let c = cols.get(key)
			if (!c) cols.set(key, c = { minKy: v.ky, maxKy: v.ky, voxs: [] })
			c.minKy = Math.min(c.minKy, v.ky)
			c.maxKy = Math.max(c.maxKy, v.ky)
			c.voxs.push(v)
		}
		let turfGaussians = 0
		for (const [blobId, cols] of colStats) {
			const turfKeys = new Set()
			for (const [key, c] of cols) {
				const span = (c.maxKy - c.minKy + 1) * VOX
				if (span >= TURF_SPAN) continue
				const colX = minX + (Math.floor(key / 4096) + 0.5) * VOX
				const colZ = minZ + ((key % 4096) + 0.5) * VOX
				const top = (c.maxKy + 1 - VOFF) * VOX
				if (top < rawFloorLevel[cellOfXZ(colX, colZ)] + TURF_TOP) turfKeys.add(key)
			}
			// Contact-ring test against the FROZEN turf set — deciding against a mutating
			// set lets "keep" cascade inward and spare the entire grass slab.
			const frozenTurf = new Set(turfKeys)
			const isContactRing = key => {
				const kx = Math.floor(key / 4096), kz = key % 4096
				for (let dx = -1; dx <= 1; dx++) {
					for (let dz = -1; dz <= 1; dz++) {
						const nk = (kx + dx) * 4096 + (kz + dz)
						if (cols.has(nk) && !frozenTurf.has(nk)) return true
					}
				}
				return false
			}
			// Connected components of the trimmable turf: patches smaller than
			// MIN_TURF_PATCH are squat-object bodies, not terrain — leave them alone.
			const trimmable = new Set([...frozenTurf].filter(key => !isContactRing(key)))
			const seenCols = new Set()
			const finalTrim = new Set()
			for (const seed of trimmable) {
				if (seenCols.has(seed)) continue
				const comp = []
				const stack = [seed]
				seenCols.add(seed)
				while (stack.length) {
					const cur = stack.pop()
					comp.push(cur)
					const kx = Math.floor(cur / 4096), kz = cur % 4096
					for (let dx = -1; dx <= 1; dx++) {
						for (let dz = -1; dz <= 1; dz++) {
							const nk = (kx + dx) * 4096 + (kz + dz)
							if (trimmable.has(nk) && !seenCols.has(nk)) { seenCols.add(nk); stack.push(nk) }
						}
					}
				}
				if (comp.length >= MIN_TURF_PATCH) for (const key of comp) finalTrim.add(key)
			}
			for (const key of finalTrim) {
				const c = cols.get(key)
				let columnRemoved = 0
				let columnRemaining = 0
				for (const v of c.voxs) {
					let voxelRemaining = 0
					for (const gi of v.idx) {
						if (blobOf[gi] !== blobId) continue
						if (mayCullIndex(gi)) {
							blobOf[gi] = -1
							turfGaussians++
							columnRemoved++
						} else {
							voxelRemaining++
							columnRemaining++
						}
					}
					if (!voxelRemaining) v.blob = -1
				}
				blobs[blobId].count -= columnRemoved
				if (!columnRemaining) {
					blobs[blobId].cols.delete(key)
					cols.delete(key)
				}
			}
		}
		if (turfGaussians) console.log(`[segment] turf trim → ${turfGaussians} standing-terrain gaussian(s) returned to ground`)
	}

	// ---- Base detach -------------------------------------------------------------------
	// Single-view splats often smear the base of vertical objects into the horizontal
	// terrain. That creates a same-blob "skirt" that moves with trees/towers. Unlike
	// colour splitting, this uses shape: tall columns prove object mass, while low
	// neighbouring columns close to the local surface are terrain and should stay ground.
	if (hasGround && bigBlobIds.length && CULL_AMOUNT > 0 && segmentationTuning.baseDetachStrength > 0) {
		const strength = clamp01(segmentationTuning.baseDetachStrength * PRE_CULL)
		const detachHeight = segmentationTuning.baseDetachHeight
		const detachRadius = Math.max(0, Math.round(segmentationTuning.baseDetachRadius))
		const columnMinHeight = segmentationTuning.baseColumnMinHeight
		const columnPad = lerp(0.45, 0.05, strength)
		const lowPad = lerp(0.65, 0.12, strength)
		const minLowPatch = Math.round(lerp(36, 4, strength))
		const bigSet = new Set(bigBlobIds)
		const colStats = new Map() // blobId -> Map(colKey -> { minY, maxY, voxs })
		for (const v of voxels.values()) {
			if (!bigSet.has(v.blob)) continue
			let cols = colStats.get(v.blob)
			if (!cols) colStats.set(v.blob, cols = new Map())
			const key = v.kx * 4096 + v.kz
			let c = cols.get(key)
			if (!c) cols.set(key, c = { minY: Infinity, maxY: -Infinity, voxs: [] })
			for (const gi of v.idx) {
				if (pys[gi] < c.minY) c.minY = pys[gi]
				if (pys[gi] > c.maxY) c.maxY = pys[gi]
			}
			c.voxs.push(v)
		}
		let detachedGaussians = 0
		let detachedColumns = 0
		for (const [blobId, cols] of colStats) {
			const tallCols = new Set()
			for (const [key, c] of cols) {
				const kx = Math.floor(key / 4096), kz = key % 4096
				const colX = minX + (kx + 0.5) * VOX
				const colZ = minZ + (kz + 0.5) * VOX
				const surface = surfLevel[cellOfXZ(colX, colZ)]
				if (c.maxY - surface >= columnMinHeight && c.maxY - c.minY >= columnMinHeight * 0.7) tallCols.add(key)
			}
			if (!tallCols.size) continue
			const nearTall = key => {
				const kx = Math.floor(key / 4096), kz = key % 4096
				for (let dx = -detachRadius; dx <= detachRadius; dx++) {
					for (let dz = -detachRadius; dz <= detachRadius; dz++) {
						if (Math.max(Math.abs(dx), Math.abs(dz)) > detachRadius) continue
						if (tallCols.has((kx + dx) * 4096 + (kz + dz))) return true
					}
				}
				return false
			}
			const lowSkirt = new Set()
			for (const [key, c] of cols) {
				if (tallCols.has(key) || !nearTall(key)) continue
				const kx = Math.floor(key / 4096), kz = key % 4096
				const colX = minX + (kx + 0.5) * VOX
				const colZ = minZ + (kz + 0.5) * VOX
				const surface = surfLevel[cellOfXZ(colX, colZ)]
				if (c.maxY <= surface + detachHeight + lowPad && c.maxY - c.minY <= detachHeight + columnPad) lowSkirt.add(key)
			}
			const seen = new Set()
			const finalDetach = new Set()
			for (const seed of lowSkirt) {
				if (seen.has(seed)) continue
				const comp = []
				const stack = [seed]
				seen.add(seed)
				while (stack.length) {
					const cur = stack.pop()
					comp.push(cur)
					const kx = Math.floor(cur / 4096), kz = cur % 4096
					for (let dx = -1; dx <= 1; dx++) {
						for (let dz = -1; dz <= 1; dz++) {
							const nk = (kx + dx) * 4096 + (kz + dz)
							if (lowSkirt.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk) }
						}
					}
				}
				if (comp.length >= minLowPatch) for (const key of comp) finalDetach.add(key)
			}
			for (const key of finalDetach) {
				const c = cols.get(key)
				let columnRemoved = 0
				let columnRemaining = 0
				for (const v of c.voxs) {
					let voxelRemaining = 0
					for (const gi of v.idx) {
						if (blobOf[gi] === blobId) {
							if (mayCullIndex(gi)) {
								blobOf[gi] = -1
								detachedGaussians++
								columnRemoved++
							} else {
								voxelRemaining++
								columnRemaining++
							}
						}
					}
					if (!voxelRemaining) v.blob = -1
				}
				blobs[blobId].count -= columnRemoved
				if (columnRemoved) detachedColumns++
				if (!columnRemaining) blobs[blobId].cols.delete(key)
			}
		}
		if (detachedGaussians) console.log(`[segment] base detach → ${detachedGaussians} skirt gaussian(s) across ${detachedColumns} column(s) returned to ground`)
	}

	// ---- Blob ↔ guide-group matching --------------------------------------------------
	// The image model repeatedly paints objects several units away from their guide
	// clusters (and at different scales), so ownership must be decided by matching the
	// splat's own content blobs to the expected objects — by position, size, and
	// palette — never by projecting block masks onto gaussians. One group may win
	// several blobs (a tree that reconstructs as disconnected crown shells); a blob no
	// group can explain (a hallucinated campfire) stays with the ground, visibly
	// present but never movable as a false object.
	let groupNames = null // bigBlobIds-aligned names once matching succeeds
	let flipScene = false // set when the mirrored orientation explains the layout better
	if (semanticGroups.length && bigBlobIds.length) {
		const sceneSpan = Math.max(spanX, spanY, spanZ)
		const groups = semanticGroups.map((group, gi) => {
			const center = group.box.getCenter(new THREE.Vector3())
			const palette = group.primitives.map(mesh => {
				const hex = mesh.userData.baseColor ?? mesh.material.color.getHexString()
				const cr = parseInt(hex.slice(0, 2), 16), cg = parseInt(hex.slice(2, 4), 16), cb = parseInt(hex.slice(4, 6), 16)
				// Display sRGB on purpose: splat colour bytes are sRGB too.
				return [...unitChroma(cr, cg, cb), (cr + cg + cb) / 3]
			})
			const volume = group.primitives.reduce((sum, mesh) => sum + Math.abs(mesh.scale.x * mesh.scale.y * mesh.scale.z), 0)
			return { gi, group, center, height: Math.max(0.5, group.box.max.y - group.box.min.y), volume: Math.max(0.05, volume), palette }
		})
		// Per-blob stats + per-(blob,group) palette agreement in one pass.
		const stats = new Map(bigBlobIds.map(id => [id, {
			n: 0, cx: 0, cz: 0, minY: Infinity, maxY: -Infinity,
			weight: 0, cr: 0, cg: 0, cb: 0, nearSurf: 0, aboveSurf: 0,
			match: new Float64Array(groups.length),
		}]))
		for (let i = 0; i < n; i++) {
			const s = stats.get(blobOf[i])
			if (!s) continue
			s.n++; s.cx += pxs[i]; s.cz += pzs[i]
			s.cr += prgb[i * 3]; s.cg += prgb[i * 3 + 1]; s.cb += prgb[i * 3 + 2]
			if (hasGround) {
				const surfaceDelta = pys[i] - surfLevel[cellOfXZ(pxs[i], pzs[i])]
				if (Math.abs(surfaceDelta) < 1.0) s.nearSurf++
				if (surfaceDelta > 1.35) s.aboveSurf++
			}
			if (pys[i] < s.minY) s.minY = pys[i]
			if (pys[i] > s.maxY) s.maxY = pys[i]
			const pc = unitChroma(prgb[i * 3], prgb[i * 3 + 1], prgb[i * 3 + 2])
			const pMean = (prgb[i * 3] + prgb[i * 3 + 1] + prgb[i * 3 + 2]) / 3
			// Dark points carry proportionally less colour evidence — near-black shadow
			// shells contribute none (they were outbidding real objects), while an object
			// that is merely painted dark (a shaded wooden post, mean ~35) keeps half its
			// vote instead of being silenced by a hard cutoff.
			const evidence = Math.min(1, Math.max(0, (pMean - 15) / 40))
			s.weight += evidence
			if (!evidence) continue
			for (const g of groups) {
				let affinity = 0
				for (const [cr, cg, cb, clen, cmean] of g.palette) {
					const a = clen < 10 || pc[3] < 10
						// Painted "grey" rock is really a slightly blue-grey (chroma length
						// 15–25) AND its stored splat colours are ambient-darkened well below
						// the block hex, so match neutral anchors on low chroma with only a
						// gentle brightness falloff — the strict test made grey palettes match
						// NOTHING and the rock blob lost its own group.
						? (clen < 10 && pc[3] < 28 ? 1 - Math.min(1, Math.abs(pMean - cmean) / 200) : 0)
						: pc[0] * cr + pc[1] * cg + pc[2] * cb
					if (a > affinity) affinity = a
				}
				if (affinity > 0.5) s.match[g.gi] += evidence
			}
		}
		for (const s of stats.values()) { s.cx /= Math.max(1, s.n); s.cz /= Math.max(1, s.n) }
		// Surface-hugging blobs are NOT excluded from matching any more: a squat bush/rock
		// is geometrically indistinguishable from a mound remnant, and the old hard
		// prefilter silently ate real squat props (runs 0158–0162: every unmatched group
		// traced back to it). Instead each blob carries a continuous "terrainish" score:
		// matching costs extra (a mound must EARN a group on position+size+mass+palette),
		// unclaimed terrainish blobs fold into ground with no dropped-blob penalty (a mound
		// costs nothing to leave), and everything else behaves exactly as before.
		const terrainish = new Map()
		if (hasGround) {
			for (const id of bigBlobIds) {
				const s = stats.get(id)
				const near = s.nearSurf / Math.max(1, s.n)
				const elevated = s.aboveSurf / Math.max(1, s.n)
				const t = Math.min(1, Math.max(0, (near - 0.55) / 0.3)) * Math.min(1, Math.max(0, (0.22 - elevated) / 0.22))
				terrainish.set(id, t)
			}
		}
		const hardTerrain = id => {
			if (!hasGround) return false
			const s = stats.get(id)
			const height = s.maxY - s.minY
			const near = s.nearSurf / Math.max(1, s.n)
			const elevated = s.aboveSurf / Math.max(1, s.n)
			return (near > 0.82 && elevated < 0.2) || (near > 0.6 && elevated < 0.12 && height < 2.2)
		}
		const TERRAIN_BIAS = clamp01(segmentationTuning.terrainBias ?? 0.45)
		const matchBlobIds = [...bigBlobIds]
		const terrainBlobIds = new Set() // filled AFTER assignment with unclaimed terrainish blobs
		// Per-blob image objectness: fraction of the blob that projects inside ANY detected
		// object box. A dune mound impersonating a shrub projects onto empty sand (run 0170:
		// both "claimed shrubs" scored 0%) — it must not win a group over paying this cost.
		const boxObjness = new Map()
		if (imageObjectBoxes?.length && imgU) {
			const counts = new Map(matchBlobIds.map(id => [id, [0, 0]]))
			for (let i = 0; i < n; i++) {
				const c = counts.get(blobOf[i])
				if (!c) continue
				c[1]++
				if (imageObjectBoxes.some(b => inImageBox(i, b.box_2d))) c[0]++
			}
			for (const [id, [inBox, tot]] of counts) boxObjness.set(id, inBox / Math.max(1, tot))
		}

		// GLOBALLY optimal one-to-one assignment (branch & bound over the few groups).
		// Greedy failed in practice: a drifted tent sitting where the tree's cluster was
		// is locally the tree's cheapest blob, which then strands the real (drifted)
		// tree entirely — while the total-cost-minimal assignment pairs both correctly.
		const UNMATCHED_GROUP_COST = 2.0 // leaving a group empty must beat only absurd pairings
		// The artwork's global scale drifts (objects painted ~2× their cluster height),
		// so compare RELATIVE heights — each side normalized by its own tallest — and
		// the shared exaggeration cancels while rank/size ordering still discriminates.
		const maxBlobH = Math.max(1, ...matchBlobIds.map(id => Math.max(0.3, stats.get(id).maxY - stats.get(id).minY)))
		const maxGroupH = Math.max(...groups.map(g => g.height))
		// Relative MASS (blob point count vs guide cluster volume, each normalized by its
		// own largest) is the one signal the image model cannot lie about: a hallucinated
		// neon wisp whose colour perfectly mimics a guide block is still a few thousand
		// points impersonating a cluster that expects tens of thousands.
		const maxBlobN = Math.max(1, ...matchBlobIds.map(id => stats.get(id).n))
		const maxGroupVol = Math.max(...groups.map(g => g.volume))
		// Yaw self-correction: the estimator's one plausible failure is the 180° mirror
		// (quarter turns fail its block-coverage term outright, but a near-symmetric
		// silhouette can flip). Blobs and groups are both known here, so score the
		// assignment in BOTH orientations — mirroring the group centers about the scene
		// content center — and if the mirrored world explains the layout decisively
		// better, rigidly flip every seated piece afterwards. Run 0118 seated mirrored:
		// the wisp stole the tree group and the tower landed 11u from its cluster.
		const cx0 = (minX + maxX) / 2
		const cz0 = (minZ + maxZ) / 2
		const paletteAffinity = (palette, r, g, b) => {
			const pc = unitChroma(r, g, b)
			const pMean = (r + g + b) / 3
			let best = 0
			for (const [cr, cg, cb, clen, cmean] of palette) {
				const a = clen < 10 || pc[3] < 10
					? (clen < 10 && pc[3] < 28 ? 1 - Math.min(1, Math.abs(pMean - cmean) / 200) : 0)
					: pc[0] * cr + pc[1] * cg + pc[2] * cb
				if (a > best) best = a
			}
			return best
		}
		const buildCosts = mirror => {
			const out = new Map() // `${id}:${gi}` -> cost
			for (const id of matchBlobIds) {
				const s = stats.get(id)
				const blobHN = Math.max(0.3, s.maxY - s.minY) / maxBlobH
				const mr = s.cr / Math.max(1, s.n), mg = s.cg / Math.max(1, s.n), mb = s.cb / Math.max(1, s.n)
				const meanChroma = unitChroma(mr, mg, mb)[3]
				for (const g of groups) {
					const gx = mirror ? 2 * cx0 - g.center.x : g.center.x
					const gz = mirror ? 2 * cz0 - g.center.z : g.center.z
					const dxz = Math.hypot(s.cx - gx, s.cz - gz) / Math.max(1e-6, sceneSpan)
					const sizeTerm = Math.abs(Math.log(blobHN / (g.height / maxGroupH)))
					const massTerm = Math.abs(Math.log((s.n / maxBlobN) / (g.volume / maxGroupVol)))
					const colourTerm = 1 - s.match[g.gi] / Math.max(1, s.weight)
					// A NEON blob (mean chroma far beyond any painted material) that this
					// group's palette cannot explain is almost certainly an effect the model
					// invented (a glowing magic wisp) — it must not impersonate a real object.
					// A group that genuinely asked for a saturated colour keeps its claim.
					const hallucTerm = meanChroma > 70 && paletteAffinity(g.palette, mr, mg, mb) < 0.5 ? 0.5 : 0
					const terrainTerm = (terrainish.get(id) ?? 0) * TERRAIN_BIAS
					const boxTerm = boxObjness.has(id) ? 0.8 * (1 - boxObjness.get(id)) : 0
					out.set(`${id}:${g.gi}`, dxz * 1.0 + sizeTerm * 0.3 + massTerm * 0.3 + colourTerm * 0.8 + hallucTerm + terrainTerm + boxTerm)
				}
			}
			return out
		}
		let costOf = buildCosts(false)
		{
			const colSum = new Map(matchBlobIds.map(id => [id, [0, 0, 0]]))
			for (let i = 0; i < n; i++) {
				const cs = colSum.get(blobOf[i])
				if (!cs) continue
				cs[0] += prgb[i * 3]; cs[1] += prgb[i * 3 + 1]; cs[2] += prgb[i * 3 + 2]
			}
			for (const id of matchBlobIds) {
				const s = stats.get(id)
				const cs = colSum.get(id).map(v => (v / Math.max(1, s.n)) | 0)
				console.log(`[segment]   blob ${id}: ${s.n} pts @ (${s.cx.toFixed(1)}, ${s.cz.toFixed(1)}) h ${(s.maxY - s.minY).toFixed(1)} rgb(${cs.join(",")})${boxObjness.has(id) ? ` obj ${Math.round(boxObjness.get(id) * 100)}%` : ""} | ${groups.map(g => `g${g.gi + 1}:${costOf.get(`${id}:${g.gi}`).toFixed(2)}`).join(" ")}`)
			}
		}
		// A large content blob that NO assignment explains is expensive: dumping a whole
		// drifted tree into the static ground to buy a marginally cheaper pairing is
		// exactly the failure this matcher exists to prevent. Blobs that can attach to
		// an assigned neighbour (crown shells, prop fragments) cost nothing to leave
		// unassigned — the attachment pass below will fold them in.
		const ATTACH = 0.35 * sceneSpan
		// NOTE: scaling this penalty down for "terrain-hugging" blobs (nearSurf fraction
		// vs the raw floor) was tried to stop trimmed mound remnants from claiming small
		// groups — but short wide objects (a rock) hug the contaminated raw floor just
		// as much, lost their protection, and the 4-object regression scene scrambled.
		// Keep the penalty purely size-based until a signal separates rocks from mounds.
		const droppedPenalty = id => hardTerrain(id) ? 0 : 0.6 * Math.min(1, stats.get(id).n / Math.max(1, 0.04 * n))
		const leafPenalty = () => {
			let sum = 0
			for (const id of matchBlobIds) {
				if (usedBlobs.has(id)) continue
				const s = stats.get(id)
				let attachable = false
				for (const uid of usedBlobs) {
					const p = stats.get(uid)
					if (Math.hypot(s.cx - p.cx, s.cz - p.cz) <= ATTACH) { attachable = true; break }
				}
				if (!attachable) sum += droppedPenalty(id)
			}
			return sum
		}
		let bestAssign = null, bestTotal = Infinity
		const currentAssign = new Map()
		const usedBlobs = new Set()
		const searchGroups = [...groups]
		let activeCosts = costOf
		const assignSearch = (gIdx, total) => {
			if (total >= bestTotal) return // penalties are non-negative, so pair-sum is a valid lower bound
			if (gIdx === searchGroups.length) {
				const full = total + leafPenalty()
				if (full < bestTotal) { bestTotal = full; bestAssign = new Map(currentAssign) }
				return
			}
			const gi = searchGroups[gIdx].gi
			for (const id of matchBlobIds) {
				if (usedBlobs.has(id)) continue
				// The image is authoritative about non-objects: a blob projecting onto empty
				// terrain (< 8% inside any detected object box) cannot claim a group at all —
				// leaving the group unmatched lets the colour carve recover the real content.
				if (boxObjness.has(id) && boxObjness.get(id) < 0.08) continue
				const c = activeCosts.get(`${id}:${gi}`)
				if (c >= UNMATCHED_GROUP_COST) continue
				usedBlobs.add(id); currentAssign.set(gi, id)
				assignSearch(gIdx + 1, total + c)
				usedBlobs.delete(id); currentAssign.delete(gi)
			}
			assignSearch(gIdx + 1, total + UNMATCHED_GROUP_COST) // this group stays empty
		}
		assignSearch(0, 0)
		const normalAssign = bestAssign, normalTotal = bestTotal
		// Second pass with mirrored group centers — a decisive win means the scene was
		// seated 180° off and every piece must be rigidly flipped after building.
		bestAssign = null; bestTotal = Infinity
		activeCosts = buildCosts(true)
		assignSearch(0, 0)
		if (bestTotal < normalTotal - 0.2) {
			flipScene = true
			costOf = activeCosts
			console.warn(`[segment] mirrored layout wins (${bestTotal.toFixed(2)} vs ${normalTotal.toFixed(2)}) — seated yaw was 180° off; flipping all pieces`)
		} else {
			bestAssign = normalAssign
			bestTotal = normalTotal
		}
		const blobGroup = new Map() // blob id -> group index
		const groupPrimary = new Map() // group index -> primary blob id
		for (const [gi, id] of bestAssign ?? []) {
			blobGroup.set(id, gi)
			groupPrimary.set(gi, id)
		}

		// Colour-guided carve: an unmatched group whose palette is DISTINCT from its
		// nearest assigned blob's group often reconstructs FUSED to that neighbour (run
		// 0163: the grey stone painted against the bush came back as one blob). Carve out
		// the donor's connected sub-clump whose colour the unmatched group explains
		// decisively better than the donor's own palette. Unlike the old geometric carve
		// (removed for slicing coherent objects on count disagreements), this fires only
		// on colour evidence and leaves the donor intact when there is none.
		for (const g of groups) {
			if (groupPrimary.has(g.gi)) continue
			let donorId = null, donorD = Infinity
			for (const id of groupPrimary.values()) {
				const s = stats.get(id)
				if (!s) continue // blobs minted by an earlier carve have no stats entry
				const d = Math.hypot(s.cx - g.center.x, s.cz - g.center.z)
				if (d < donorD) { donorD = d; donorId = id }
			}
			if (donorId == null || donorD > 0.45 * sceneSpan) continue
			const CV = Math.max(VOX * 2, 0.35)
			const carveComponent = (pointFilter, donorGroup) => {
				const cells = new Map()
				for (let i = 0; i < n; i++) {
					if (!pointFilter(i)) continue
					const kx = Math.floor((pxs[i] - minX) / CV), ky = Math.floor(pys[i] / CV) + 256, kz = Math.floor((pzs[i] - minZ) / CV)
					const key = (kx * 4096 + kz) * 4096 + ky
					let c = cells.get(key)
					if (!c) cells.set(key, c = { idx: [], sr: 0, sg: 0, sb: 0, kx, ky, kz, take: false })
					c.idx.push(i)
					c.sr += prgb[i * 3]; c.sg += prgb[i * 3 + 1]; c.sb += prgb[i * 3 + 2]
				}
				const gNeutral = g.palette.every(pal => pal[3] < 12)
				const donorChromatic = donorGroup ? donorGroup.palette.every(pal => pal[3] >= 25) : false
				for (const c of cells.values()) {
					const m = 1 / Math.max(1, c.idx.length)
					const aG = paletteAffinity(g.palette, c.sr * m, c.sg * m, c.sb * m)
					let aD = donorGroup ? paletteAffinity(donorGroup.palette, c.sr * m, c.sg * m, c.sb * m) : 0
					// A low-chroma cell has no reliable hue direction: a warm-grey rock "matches"
					// brown at dot ~0.95. When the wanted group is NEUTRAL and the donor is
					// saturated, neutrality itself is the discriminator — drop the donor claim.
					if (gNeutral && donorChromatic && unitChroma(c.sr * m, c.sg * m, c.sb * m)[3] < 26) aD = 0
					c.take = aG > 0.55 && aG > aD + 0.1
				}
				const seen = new Set()
				let best = null, bestScore = 0
				for (const [key, seed] of cells) {
					if (!seed.take || seen.has(key)) continue
					const comp = []
					const stack = [key]
					seen.add(key)
					while (stack.length) {
						const cur = stack.pop()
						comp.push(cur)
						const cc = cells.get(cur)
						for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
							const nk = ((cc.kx + dx) * 4096 + (cc.kz + dz)) * 4096 + (cc.ky + dy)
							const nb = cells.get(nk)
							if (nb?.take && !seen.has(nk)) { seen.add(nk); stack.push(nk) }
						}
					}
					const pts = comp.reduce((sum, k) => sum + cells.get(k).idx.length, 0)
					// The image knows where the missing object IS: weight components by how
					// much of them projects into a detected object box, so a big same-colour
					// fringe elsewhere cannot outbid the real (smaller) content.
					let objFrac = 0
					if (imageObjectBoxes?.length && imgU && !flipScene) {
						let inBox = 0
						for (const k of comp) for (const i of cells.get(k).idx) {
							if (imageObjectBoxes.some(b => inImageBox(i, b.box_2d))) inBox++
						}
						objFrac = inBox / Math.max(1, pts)
					}
					const score = pts * (1 + 3 * objFrac)
					if (score > bestScore) { bestScore = score; best = { comp, pts } }
				}
				return best ? { cells, comp: best.comp, pts: best.pts } : null
			}
			// Try every nearby fused-neighbour blob (nearest first — run 0163's stone fused
			// into the SECOND-nearest neighbour), then the GROUND itself: a squat object
			// often sits entirely below the floor band and never becomes a blob at all —
			// its distinctly-coloured mass is still recoverable from the ground layer.
			const reach = 0.45 * sceneSpan
			const donorCandidates = [...new Set(groupPrimary.values())]
				.filter(id => stats.has(id)) // carved blobs have no stats entry
				.map(id => ({ id, d: Math.hypot(stats.get(id).cx - g.center.x, stats.get(id).cz - g.center.z) }))
				.filter(c => c.d <= reach)
				.sort((a, b) => a.d - b.d)
			let carved = null
			// Image-first: if a detected object box is still UNCLAIMED by every assigned
			// blob, the missing object is exactly there — carve group-palette material
			// (from ground or any piece) whose projection falls inside that box.
			if (imageObjectBoxes?.length && imgU && !flipScene) {
				const claimedIds = new Set(groupPrimary.values())
				const unclaimedBoxes = imageObjectBoxes.filter(b => {
					let inBox = 0, tot = 0
					for (const id of claimedIds) {
						const st = stats.get(id)
						if (!st) continue
						tot += st.n
					}
					for (let i = 0; i < n; i++) {
						if (!claimedIds.has(blobOf[i])) continue
						if (inImageBox(i, b.box_2d, 0)) inBox++
					}
					return tot === 0 || inBox / Math.max(1, tot) < 0.05
				})
				for (const b of unclaimedBoxes) {
					const attempt = carveComponent(i => inImageBox(i, b.box_2d, 15) && (blobOf[i] < 0 || !claimedIds.has(blobOf[i])), null)
					if (attempt && attempt.pts >= 120 && (!carved || attempt.pts > carved.pts)) carved = attempt
				}
				if (carved) console.log(`[segment] image-first carve pool → group ${g.gi + 1} found ${carved.pts} pt(s) inside an unclaimed box`)
			}
			for (const cand of donorCandidates) {
				if (carved && carved.pts >= 150) break
				const candGroup = groups.find(k => k.gi === blobGroup.get(cand.id))
				const attempt = carveComponent(i => blobOf[i] === cand.id, candGroup)
				if (attempt && attempt.pts >= 150 && (!carved || attempt.pts > carved.pts)) carved = attempt
			}
			if (!carved || carved.pts < 120) {
				carved = carveComponent(i => blobOf[i] < 0 && Math.hypot(pxs[i] - g.center.x, pzs[i] - g.center.z) <= reach, null)
			}
			console.log(`[segment] carve probe g${g.gi + 1}: best component ${carved ? carved.pts : 0} pt(s) across ${donorCandidates.length} donor(s) + ground`)
			if (!carved || carved.pts < 120) continue
			const { cells, comp: bestComp } = carved
			const carvedPts = carved.pts
			const newId = blobs.length
			blobs.push({ count: 0, cols: new Set() })
			for (const key of bestComp) {
				for (const i of cells.get(key).idx) {
					if (blobOf[i] >= 0) blobs[blobOf[i]].count--
					blobOf[i] = newId
					blobs[newId].count++
					blobs[newId].cols.add(Math.floor((pxs[i] - minX) / VOX) * 4096 + Math.floor((pzs[i] - minZ) / VOX))
				}
			}
			blobGroup.set(newId, g.gi)
			groupPrimary.set(g.gi, newId)
			console.log(`[segment] colour carve → group ${g.gi + 1} took ${carvedPts} gaussian(s) out of its fused neighbour blob`)
		}

		// Disconnected reconstructed islands must stay independently movable. Older code
		// attached nearby secondary blobs (crown shells, fragments) to a matched guide
		// group, but that made visibly separate splat islands move as one object. Keep
		// every substantial non-terrain blob as its own piece instead.
		for (const id of matchBlobIds) {
			if (!blobGroup.has(id) && hardTerrain(id)) terrainBlobIds.add(id)
		}
		if (terrainBlobIds.size) console.log(`[segment] terrain fold → ${terrainBlobIds.size} unclaimed surface-hugging blob(s) into ground after matching`)
		const blobIndicesOf = id => {
			const out = []
			for (let i = 0; i < n; i++) if (blobOf[i] === id) out.push(i)
			return out
		}
		const detachedObjectIds = matchBlobIds
			.filter(id => {
				if (blobGroup.has(id) || terrainBlobIds.has(id)) return false
				const s = stats.get(id)
				if (hasGround && s.nearSurf / Math.max(1, s.n) > 0.7) return false
				// Image evidence: a blob that projects outside every detected object box is
				// reconstruction haze / a glow effect, not a movable prop — fold it into the
				// ground instead of promoting it to a detached piece. (Skipped for flipped
				// scenes: the 180° piece correction breaks the image-frame correspondence.)
				if (imageObjectBoxes && !flipScene) {
					const blobIndices = blobIndicesOf(id)
					const objness = imageObjectness(blobIndices)
					const wholeBlobCullable = blobIndices.length > 0
						&& blobIndices.every(i => withinCullHeight(pxs[i], pys[i], pzs[i], id))
						&& mayCullIndex(blobIndices[0])
					if (wholeBlobCullable && objness != null && objness < Math.min(0.9, 0.3 * PRE_CULL)) {
						console.log(`[segment] image-box gate → blob ${id} (${s.n} pts, ${Math.round(objness * 100)}% in object boxes) folded into ground`)
						terrainBlobIds.add(id)
						return false
					}
				}
				return true
			})
			.sort((a, b) => stats.get(b).n - stats.get(a).n)

		// Do not carve unmatched guide groups out of a donor blob. That fallback made
		// independent handles, but it also sliced coherent objects in half whenever the
		// guide count disagreed with the reconstructed content. A merged object is safer
		// than a broken object; unmatched groups stay without a generated piece.
		const unmatchedGroups = groups.filter(g => !groupPrimary.has(g.gi))
		for (const g of unmatchedGroups) {
			console.warn(`[segment] group ${g.gi + 1} has no matching content blob`)
		}

		// Relabel only true same-object claims. Detached blobs are deliberately NOT
		// relabeled to a nearby primary id, so disconnected islands become separate pieces.
		const relabel = new Map()
		for (const [id, gi] of blobGroup) relabel.set(id, groupPrimary.get(gi))
		for (let i = 0; i < n; i++) {
			const to = relabel.get(blobOf[i])
			if (to != null && to !== blobOf[i]) blobOf[i] = to
		}
		for (const [id, to] of relabel) {
			if (to === id) continue
			for (const col of blobs[id].cols) blobs[to].cols.add(col)
			blobs[to].count += blobs[id].count
			blobs[id].count = 0
		}
		const matchedIds = [...groupPrimary.entries()].sort((a, b) => a[0] - b[0])
		bigBlobIds.length = 0
		bigBlobIds.push(...matchedIds.map(([, id]) => id), ...detachedObjectIds)
		groupNames = [
			...matchedIds.map(([gi]) => `obj-${String(gi + 1).padStart(3, "0")}`),
			...detachedObjectIds.map((_, i) => `obj-detached-${String(i + 1).padStart(3, "0")}`),
		]
		const detachedSet = new Set(detachedObjectIds)
		const dropped = matchBlobIds.filter(id => !blobGroup.has(id) && !detachedSet.has(id)).length
		console.log(`[segment] blob match → ${groupPrimary.size}/${groups.length} group(s) claimed, ${detachedObjectIds.length} detached object blob(s), ${dropped} unexplained + ${terrainBlobIds.size} terrain blob(s) folded into ground`)
		window.__wsSegClaims = `${groupPrimary.size}/${groups.length} claimed, ${detachedObjectIds.length} detached, ${dropped} unexplained, ${terrainBlobIds.size} terrain-folded`
	}

	// Never force unassigned specks into the nearest floorless object. Reconstruction
	// grass, haze, and detached hallucinations are precisely the material that made a
	// moved crate drag unrelated fragments with it. They stay visible in a static,
	// non-selectable remainder instead.

	// Base-fringe claim: floor-band gaussians directly under a blob's (dilated) footprint
	// and above the fringe floor join that blob, so objects keep their contact base.
	const dilatedCols = new Map() // blob id -> Set of packed columns
	for (const blobId of bigBlobIds) {
		const out = new Set()
		for (const col of blobs[blobId].cols) {
			const kx = Math.floor(col / 4096)
			const kz = col % 4096
			// Dilation: object bases flare outward past the columns their upper body
			// occupies (rock skirts), and the fringe claim should still catch them.
			for (let dx = -FRINGE_DILATE; dx <= FRINGE_DILATE; dx++) for (let dz = -FRINGE_DILATE; dz <= FRINGE_DILATE; dz++) out.add((kx + dx) * 4096 + (kz + dz))
		}
		dilatedCols.set(blobId, out)
	}
	for (let i = 0; hasGround && i < n; i++) {
		if (blobOf[i] >= 0) continue
		const floor = floorLevel[cellOfXZ(pxs[i], pzs[i])]
		if (pys[i] <= floor + FRINGE_LOW || pys[i] > floor + FLOOR_BAND) continue
		const col = Math.floor((pxs[i] - minX) / VOX) * 4096 + Math.floor((pzs[i] - minZ) / VOX)
		for (const [blobId, cols] of dilatedCols) {
			if (cols.has(col)) {
				blobOf[i] = blobId
				break
			}
		}
	}

	// Build the pieces: one per matched group (guide order) when matching ran, else one
	// per big blob (largest first = obj-001); plus the ground rest.
	const makePart = name => ({ name, packed: new PackedSplats(), bounds: new THREE.Box3() })
	const ground = makePart(hasGround ? "scene-ground" : "scene-remainder")
	const ranked = groupNames ? [...bigBlobIds] : [...bigBlobIds].sort((a, b) => blobs[b].count - blobs[a].count)
	const blobParts = new Map(ranked.map((id, i) => [id, makePart(groupNames?.[i] ?? `obj-${String(i + 1).padStart(3, "0")}`)]))

	// SUPPORT-ABOVE guard (the decisive skirt killer, applied per gaussian at the very
	// end): a surface-hugging point belongs to an object only if the object's own tall
	// mass stands (nearly) directly above it. An object's contact base always has its
	// body overhead; grabbed turf, mound skin, and plate-edge cliff strips have open
	// air. Support must come from points GENUINELY above the raw local surface, so a
	// mound's own skin can never vouch for the skin below it.
	const SURF_HUG = 1.2 * POST_CULL // within this of the raw local surface = "surface-hugging"
	const SUPPORT_WINDOW = 2.0 // object mass within this far above rescues a hugger
	const SUPPORT_REACH = 2 // ...searching this many floor cells around (covers wide bases)
	// The definitive terrain-surface map: built ONLY from ground-labeled gaussians, so
	// it is immune to the contamination that poisoned every floor statistic so far —
	// raw percentiles read partway up tall objects (culling a tower's lower half) and
	// eroded minima read down cliff faces (letting plate-edge strips ride along). Per
	// cell: high percentile of ground-point heights; object-covered cells borrow from
	// their neighbourhood.
	let groundSurf = null
	if (hasGround) {
		const cellPts = Array.from({ length: gw * gh }, () => [])
		for (let i = 0; i < n; i++) {
			if (blobParts.has(blobOf[i])) continue // objects must not define the terrain
			cellPts[cellOfXZ(pxs[i], pzs[i])].push(pys[i])
		}
		groundSurf = new Float32Array(gw * gh).fill(NaN)
		for (let c = 0; c < gw * gh; c++) {
			const hs = cellPts[c]
			if (hs.length < 4) continue
			hs.sort((a, b) => a - b)
			groundSurf[c] = hs[Math.floor(hs.length * 0.85)]
		}
		// Object-covered cells: take the highest ground surface within reach, growing
		// the search ring until something is found; last resort = eroded floor + 1.
		for (let cz = 0; cz < gh; cz++) {
			for (let cx = 0; cx < gw; cx++) {
				const c = cz * gw + cx
				if (!Number.isNaN(groundSurf[c])) continue
				let found = NaN
				for (let r = 1; r <= 4 && Number.isNaN(found); r++) {
					let high = -Infinity
					for (let dz = -r; dz <= r; dz++) {
						for (let dx = -r; dx <= r; dx++) {
							const nx = cx + dx, nz = cz + dz
							if (nx < 0 || nx >= gw || nz < 0 || nz >= gh) continue
							const v = groundSurf[nz * gw + nx]
							if (!Number.isNaN(v) && v > high) high = v
						}
					}
					if (high > -Infinity) found = high
				}
				groundSurf[c] = Number.isNaN(found) ? floorLevel[c] + 1 : found
			}
		}
	}
	// Interior orphan claim: if segmentation left free-floating gaussians inside an
	// object's current volume, pull them into that object before packing pieces. This
	// fixes visible remnants that stay behind when moving a tent/tree/etc. Ground-level
	// material is excluded here and still falls through to the ground/cull path.
	let interiorClaimed = 0
	const interiorClaimMask = new Uint8Array(n)
	if (blobParts.size) {
		const PAD = Math.max(VOX * 4, 0.75)
		const YPAD = Math.max(VOX * 4, 0.8)
		const envelopes = new Map([...blobParts.keys()].map(label => [label, {
			minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity,
			cx: 0, cy: 0, cz: 0, n: 0,
		}]))
		for (let i = 0; i < n; i++) {
			const e = envelopes.get(blobOf[i])
			if (!e) continue
			e.n++; e.cx += pxs[i]; e.cy += pys[i]; e.cz += pzs[i]
			e.minX = Math.min(e.minX, pxs[i]); e.maxX = Math.max(e.maxX, pxs[i])
			e.minY = Math.min(e.minY, pys[i]); e.maxY = Math.max(e.maxY, pys[i])
			e.minZ = Math.min(e.minZ, pzs[i]); e.maxZ = Math.max(e.maxZ, pzs[i])
		}
		for (const e of envelopes.values()) {
			if (!e.n) continue
			e.cx /= e.n; e.cy /= e.n; e.cz /= e.n
		}
		for (let i = 0; i < n; i++) {
			if (blobParts.has(blobOf[i])) continue
			if (hasGround && pys[i] <= groundSurf[cellOfXZ(pxs[i], pzs[i])] + 0.35) continue
			let bestLabel = null, bestD = Infinity
			for (const [label, e] of envelopes) {
				if (!e) continue
				if (!e.n) continue
				if (pxs[i] < e.minX - PAD || pxs[i] > e.maxX + PAD) continue
				if (pys[i] < e.minY - YPAD || pys[i] > e.maxY + YPAD) continue
				if (pzs[i] < e.minZ - PAD || pzs[i] > e.maxZ + PAD) continue
				const d = Math.hypot(pxs[i] - e.cx, pys[i] - e.cy, pzs[i] - e.cz)
				if (d < bestD) { bestD = d; bestLabel = label }
			}
			if (bestLabel != null) {
				blobOf[i] = bestLabel
				interiorClaimMask[i] = 1
				interiorClaimed++
			}
		}
	}
	if (interiorClaimed) console.log(`[segment] interior orphan claim → ${interiorClaimed} gaussian(s) pulled into enclosing object(s)`)
	// Matching, fringe recovery, and orphan claims can relabel or extend a piece. Rebuild
	// its robust vertical range before any final cleanup uses the relative-height slider.
	refreshCleanupHeightRanges(blobOf)
	const supportY = hasGround ? new Map([...blobParts.keys()].map(id => [id, new Float32Array(gw * gh).fill(Infinity)])) : null
	if (supportY) {
		for (let i = 0; i < n; i++) {
			const sup = supportY.get(blobOf[i])
			if (!sup) continue
			const cell = cellOfXZ(pxs[i], pzs[i])
			if (pys[i] <= groundSurf[cell] + SURF_HUG) continue // huggers are not support
			if (pys[i] < sup[cell]) sup[cell] = pys[i]
		}
	}
	const supportedFromAbove = (label, x, z, y) => {
		const sup = supportY.get(label)
		const cx = Math.min(gw - 1, Math.max(0, Math.floor(((x - minX) / spanX) * gw)))
		const cz = Math.min(gh - 1, Math.max(0, Math.floor(((z - minZ) / spanZ) * gh)))
		for (let dz = -SUPPORT_REACH; dz <= SUPPORT_REACH; dz++) {
			for (let dx = -SUPPORT_REACH; dx <= SUPPORT_REACH; dx++) {
				const nx = cx + dx, nz = cz + dz
				if (nx < 0 || nx >= gw || nz < 0 || nz >= gh) continue
				if (sup[nz * gw + nx] - y < SUPPORT_WINDOW) return true
			}
		}
		return false
	}
	// Pre-compute guard decisions with a piece-level safety valve: a SQUAT object
	// (post, low rock) barely rises above lumpy surroundings, so nearly all of it reads
	// "unsupported" — stripping it would delete the object outright. If the guard wants
	// more than 60% of a piece, that piece is squat: leave it whole (a small skirt on a
	// stump beats a missing stump). Tall objects lose only their grabbed fringe.
	const cullMask = supportY ? new Uint8Array(n) : null
	if (cullMask) {
		// The guard exists for TALL objects (a tower's plate-edge strip, a tree's turf
		// skirt). A squat, rounded prop (bush, rock, crate) hugs the surface all over —
		// its own lower foliage reads "unsupported" and gets stranded in the ground when
		// the object is moved (run 0159's bush left half its leaves behind). Pieces that
		// barely rise above the local surface skip the guard entirely.
		const GUARD_MIN_RISE = segmentationTuning.skirtGuardMinRise ?? 4.2
		const totalOf = new Map([...blobParts.keys()].map(id => [id, 0]))
		const cullOf = new Map([...blobParts.keys()].map(id => [id, 0]))
		const riseOf = new Map([...blobParts.keys()].map(id => [id, 0]))
		for (let i = 0; i < n; i++) {
			const label = blobOf[i]
			if (!blobParts.has(label)) continue
			if (interiorClaimMask[i]) continue
			totalOf.set(label, totalOf.get(label) + 1)
			const rise = pys[i] - groundSurf[cellOfXZ(pxs[i], pzs[i])]
			if (rise > riseOf.get(label)) riseOf.set(label, rise)
			if (rise <= SURF_HUG && mayCullIndex(i) && !supportedFromAbove(label, pxs[i], pzs[i], pys[i])) {
				cullMask[i] = 1
				cullOf.set(label, cullOf.get(label) + 1)
			}
		}
		for (const [label, culled] of cullOf) {
			if (culled / Math.max(1, totalOf.get(label)) > 0.6 || riseOf.get(label) < GUARD_MIN_RISE) {
				for (let i = 0; i < n; i++) if (blobOf[i] === label) cullMask[i] = 0
			}
		}
	}

	// Per-piece image box: the detected box that best covers the piece's projection.
	// Gaussians of the piece that project OUTSIDE that (padded) box are wisps/haze the 3D
	// heuristics missed — return them to the ground. Pieces with no confident box are
	// left untouched, as are flipped scenes (image frame no longer corresponds).
	const pieceImageBox = new Map()
	if (imageObjectBoxes?.length && !flipScene) {
		for (const [label] of blobParts) {
			const counts = new Array(imageObjectBoxes.length).fill(0)
			let total = 0
			for (let i = 0; i < n; i++) {
				if (blobOf[i] !== label) continue
				total++
				for (let b = 0; b < imageObjectBoxes.length; b++) {
					if (inImageBox(i, imageObjectBoxes[b].box_2d, 0)) counts[b]++
				}
			}
			let best = -1, bestCount = 0
			for (let b = 0; b < imageObjectBoxes.length; b++) if (counts[b] > bestCount) { bestCount = counts[b]; best = b }
			const coverage = bestCount / Math.max(1, total)
			let cu = 0, cv = 0
			for (let i = 0; i < n; i++) { if (blobOf[i] === label) { cu += imgU[i]; cv += imgV[i] } }
			cu /= Math.max(1, total); cv /= Math.max(1, total)
			const centers = imageObjectBoxes.map(b => `${b.label}@(${Math.round((b.box_2d[1] + b.box_2d[3]) / 2)},${Math.round((b.box_2d[0] + b.box_2d[2]) / 2)})`).join(" ")
			console.log(`[segment] piece box → ${blobParts.get(label)?.name}: proj centroid (${Math.round(cu)},${Math.round(cv)}); best "${best >= 0 ? imageObjectBoxes[best].label : "—"}" covers ${Math.round(coverage * 100)}% of ${total} pts | boxes: ${centers}`)
			if (best >= 0 && coverage >= 0.5) pieceImageBox.set(label, imageObjectBoxes[best].box_2d)
		}
	} else if (imageObjectBoxes?.length && flipScene) {
		console.log("[segment] piece box clip skipped: scene was 180°-flipped after seating")
	}
	let imageBoxClipped = 0

	// Ink footprint sampler, shared by the off-edge shadow cull below and the backfill
	// gate: plain paint-canvas alpha, deliberately independent of colour content.
	let onInk = null
	if (hasGround && world.groundInkBounds() && world.paint?.canvas) {
		const INK_S = 128 * WORKSPACE_SCALE // keep the off-edge mask as precise as it was on the old canvas
		const probe = document.createElement("canvas")
		probe.width = probe.height = INK_S
		const pctx = probe.getContext("2d", { willReadFrequently: true })
		pctx.drawImage(world.paint.canvas, 0, 0, INK_S, INK_S)
		const inkAlpha = pctx.getImageData(0, 0, INK_S, INK_S).data
		const inkHalf = GROUND_SHEET_SIZE / 2
		onInk = (wx, wz) => {
			const ii = Math.floor(((wx + inkHalf) / GROUND_SHEET_SIZE) * INK_S)
			const jj = Math.floor(((wz + inkHalf) / GROUND_SHEET_SIZE) * INK_S)
			if (ii < 0 || ii >= INK_S || jj < 0 || jj >= INK_S) return false
			return inkAlpha[(jj * INK_S + ii) * 4 + 3] > 32
		}
	}
	let offEdgeShadowCulled = 0

	const skinNormal = new THREE.Vector3()
	let skinCulled = 0
	let unsupportedCulled = 0
	let wispCulled = 0
	let edgeOutlierCulled = 0
	packed.forEachSplat((i, center, scales, quaternion, opacity, color) => {
		let part = blobParts.get(blobOf[i]) ?? ground
		// Surface-hugging material with no object mass overhead is grabbed terrain —
		// return it to the ground no matter how it ended up in the piece (flood fill,
		// fringe claim, or shared-blob partition).
		if (cullMask && part !== ground && cullMask[i]) {
			part = ground
			unsupportedCulled++
		}
		// Image-box wisp clip: this gaussian belongs to a piece whose visible extent is
		// known from the generated image; material projecting outside it is not the object.
		if (part !== ground && mayCullIndex(i) && pieceImageBox.has(blobOf[i]) && !inImageBox(i, pieceImageBox.get(blobOf[i]), Math.max(5, (IMG_BOX_PAD + 20) * (2 - Math.min(2, POST_CULL))))) {
			part = ground
			imageBoxClipped++
		}
		// Water/path features are terrain even where an object's box overlaps them (a palm
		// leaning over its pond): NEAR-FLOOR piece material projecting inside a detected
		// pond/path box is the feature's rim, not the object — leave it with the ground.
		if (part !== ground && mayCullIndex(i) && imgU && !flipScene && imageFeatureBoxes.length
			&& hasGround && center.y <= floorLevel[cellOfXZ(center.x, center.z)] + FLOOR_BAND + 0.8
			&& imageFeatureBoxes.some(b => inImageBox(i, b, 10))) {
			part = ground
			imageBoxClipped++
		}
		// Razor-thin, lying-flat pancakes near floor level are ground SKIN, not object —
		// leave them with the ground even when they sit inside the object's footprint
		// (they sneak in via the fringe claim and read as floor patches when moved).
		// Genuine object material nearby survives: rock skirts are chunky (not razor
		// thin) and tent walls are thin but stand upright (normal not vertical).
		if (hasGround && part !== ground && mayCullIndex(i) && center.y <= floorLevel[cellOfXZ(center.x, center.z)] + FLOOR_BAND + SKIN_BAND_PAD) {
			const ax = Math.abs(scales.x)
			const ay = Math.abs(scales.y)
			const az = Math.abs(scales.z)
			let minAxis = 0
			let minS = ax
			if (ay < minS) { minAxis = 1; minS = ay }
			if (az < minS) { minAxis = 2; minS = az }
			const midS = Math.max(Math.min(ax, ay), Math.min(Math.max(ax, ay), az)) // median scale
			if (minS < midS * SKIN_FLATNESS) {
				skinNormal.set(minAxis === 0 ? 1 : 0, minAxis === 1 ? 1 : 0, minAxis === 2 ? 1 : 0).applyQuaternion(quaternion)
				if (Math.abs(skinNormal.y) > SKIN_UPRIGHT) {
					part = ground
					skinCulled++
				}
			}
		}
		// Reconstructed DROP SHADOWS spill past the drawn terrain edge as dark smears in
		// the ground layer. Outside the ink footprint there is no drawn ground at all, so
		// dark material there is shadow/haze — drop it. Bright material (the terrain's own
		// painted edge overhang) stays.
		if (part === ground && mayCullIndex(i) && onInk && color && !onInk(center.x, center.z)
			&& (color.r + color.g + color.b) / 3 < 0.24) {
			offEdgeShadowCulled++
			return
		}
		part.packed.pushSplat(center, scales, quaternion, opacity, color)
		part.bounds.expandByPoint(center)
	})

	// Post-segmentation wisp prune: now that object pieces are already built, trim only
	// tiny disconnected islands from each final object. This must not feed back into
	// blob matching, group creation, bounds used for patching, or detached-object splits.
	const WISP_VOX = Math.min(0.25, Math.max(VOX * 1.5, 0.06))
	const wispDrive = clamp01(segmentationTuning.wispAggression * POST_CULL)
	const WISP_MIN_POINTS = Math.round(lerp(40, 280, wispDrive))
	const WISP_REL_POINTS = lerp(0.005, 0.065, wispDrive)
	const WISP_MIN_VOXELS = Math.round(lerp(8, 160, wispDrive))
	const WISP_MIN_AVG_NEIGHBORS = lerp(1.5, 4.25, wispDrive)
	const pruneObjectPartWisps = (part, removedPart = ground, { keepOnlyMain = false, label = null } = {}) => {
		if (CULL_AMOUNT <= 0 || part.packed.numSplats < 160) return 0
		const WOFF = 4096
		const entries = []
		const objVoxels = new Map()
		const keyOf = (kx, ky, kz) => (kx * 8192 + kz) * 8192 + ky
		part.packed.forEachSplat((i, center, scales, quaternion, opacity, color) => {
			const entry = {
				center: center.clone(),
				scales: scales.clone(),
				quaternion: quaternion.clone(),
				opacity,
				color: color?.clone?.() ?? color,
			}
			entries.push(entry)
			const kx = Math.floor((center.x - minX) / WISP_VOX)
			const kz = Math.floor((center.z - minZ) / WISP_VOX)
			const ky = Math.floor(center.y / WISP_VOX) + WOFF
			const key = keyOf(kx, ky, kz)
			let voxel = objVoxels.get(key)
			if (!voxel) objVoxels.set(key, voxel = { idx: [], kx, ky, kz, seen: false })
			voxel.idx.push(i)
		})
		if (objVoxels.size < WISP_MIN_VOXELS * 2) return 0
		const neighborCount = voxel => {
			let count = 0
			for (let dx = -1; dx <= 1; dx++) {
				for (let dz = -1; dz <= 1; dz++) {
					for (let dy = -1; dy <= 1; dy++) {
						if (!dx && !dz && !dy) continue
						if (objVoxels.has(keyOf(voxel.kx + dx, voxel.ky + dy, voxel.kz + dz))) count++
					}
				}
			}
			return count
		}
		const components = []
		for (const [seedKey, seedVoxel] of objVoxels) {
			if (seedVoxel.seen) continue
			const component = { points: 0, voxels: 0, neighborSum: 0, indices: [] }
			const stack = [seedKey]
			seedVoxel.seen = true
			while (stack.length) {
				const key = stack.pop()
				const voxel = objVoxels.get(key)
				component.points += voxel.idx.length
				component.voxels++
				component.neighborSum += neighborCount(voxel)
				component.indices.push(...voxel.idx)
				for (let dx = -1; dx <= 1; dx++) {
					for (let dz = -1; dz <= 1; dz++) {
						for (let dy = -1; dy <= 1; dy++) {
							if (!dx && !dz && !dy) continue
							const nextKey = keyOf(voxel.kx + dx, voxel.ky + dy, voxel.kz + dz)
							const next = objVoxels.get(nextKey)
							if (next && !next.seen) {
								next.seen = true
								stack.push(nextKey)
							}
						}
					}
				}
			}
			components.push(component)
		}
		if (components.length < 2) return 0
		components.sort((a, b) => b.points - a.points)
		const pointLimit = Math.max(WISP_MIN_POINTS, components[0].points * WISP_REL_POINTS)
		const remove = new Uint8Array(entries.length)
		let removed = 0
		for (const component of components.slice(1)) {
			const avgNeighbors = component.neighborSum / Math.max(1, component.voxels)
			const tiny = component.points < pointLimit
			const sparse = component.voxels < WISP_MIN_VOXELS || avgNeighbors < WISP_MIN_AVG_NEIGHBORS
			if (!keepOnlyMain && (!tiny || !sparse)) continue
			for (const i of component.indices) {
				const center = entries[i].center
				if (!mayCullAt(center.x, center.y, center.z, 0, label)) continue
				remove[i] = 1
				removed++
			}
		}
		if (!removed) return 0
		const kept = new PackedSplats()
		const nextBounds = new THREE.Box3()
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]
			if (remove[i]) {
				if (removedPart) {
					removedPart.packed.pushSplat(entry.center, entry.scales, entry.quaternion, entry.opacity, entry.color)
					removedPart.bounds.expandByPoint(entry.center)
				}
			} else {
				kept.pushSplat(entry.center, entry.scales, entry.quaternion, entry.opacity, entry.color)
				nextBounds.expandByPoint(entry.center)
			}
		}
		part.packed = kept
		part.bounds = nextBounds
		return removed
	}

	// Final sparse-edge pass. Component pruning above cannot catch a wisp that remains
	// attached by one thin strand, so this looks at occupied-voxel density along each
	// piece's outer shell. A candidate must be both topologically exposed and far less
	// populated than a typical local neighbourhood. The per-piece budget prevents an
	// aggressive slider value from eroding a legitimate thin object wholesale.
	const EDGE_VOX = Math.min(0.4, Math.max(WISP_VOX * 1.4, 0.09))
	const edgeOutlierDrive = clamp01((segmentationTuning.edgeOutliers ?? 0) * POST_CULL * CULL_AMOUNT)
	const pruneSparseEdgeOutliers = part => {
		const total = part.packed.numSplats
		if (edgeOutlierDrive <= 0 || total < 240) return 0

		const EOFF = 8192
		const keyOf = (kx, ky, kz) => (kx * 16384 + kz) * 16384 + ky
		const edgeVoxels = new Map()
		let minKx = Infinity, maxKx = -Infinity
		let minKy = Infinity, maxKy = -Infinity
		let minKz = Infinity, maxKz = -Infinity
		part.packed.forEachSplat((i, center) => {
			const kx = Math.floor((center.x - minX) / EDGE_VOX)
			const ky = Math.floor(center.y / EDGE_VOX) + EOFF
			const kz = Math.floor((center.z - minZ) / EDGE_VOX)
			const key = keyOf(kx, ky, kz)
			let voxel = edgeVoxels.get(key)
			if (!voxel) edgeVoxels.set(key, voxel = { kx, ky, kz, indices: [], localPoints: 0, neighbors: 0 })
			voxel.indices.push(i)
			if (kx < minKx) minKx = kx
			if (kx > maxKx) maxKx = kx
			if (ky < minKy) minKy = ky
			if (ky > maxKy) maxKy = ky
			if (kz < minKz) minKz = kz
			if (kz > maxKz) maxKz = kz
		})
		if (edgeVoxels.size < 8) return 0

		const localCounts = []
		for (const voxel of edgeVoxels.values()) {
			let localPoints = 0
			let neighbors = 0
			for (let dx = -1; dx <= 1; dx++) {
				for (let dy = -1; dy <= 1; dy++) {
					for (let dz = -1; dz <= 1; dz++) {
						const nearby = edgeVoxels.get(keyOf(voxel.kx + dx, voxel.ky + dy, voxel.kz + dz))
						if (!nearby) continue
						localPoints += nearby.indices.length
						if (dx || dy || dz) neighbors++
					}
				}
			}
			voxel.localPoints = localPoints
			voxel.neighbors = neighbors
			localCounts.push(localPoints)
		}
		localCounts.sort((a, b) => a - b)
		const medianLocalPoints = localCounts[Math.floor(localCounts.length / 2)]
		const shellDepth = Math.floor(lerp(0, 3, edgeOutlierDrive))
		const maxNeighbors = Math.round(lerp(1, 12, edgeOutlierDrive))
		const densityLimit = Math.max(2, medianLocalPoints * lerp(0.04, 0.55, edgeOutlierDrive))
		const candidates = []
		for (const voxel of edgeVoxels.values()) {
			const depth = Math.min(
				voxel.kx - minKx, maxKx - voxel.kx,
				voxel.ky - minKy, maxKy - voxel.ky,
				voxel.kz - minKz, maxKz - voxel.kz,
			)
			if (depth > shellDepth || voxel.neighbors > maxNeighbors || voxel.localPoints > densityLimit) continue
			candidates.push({
				voxel,
				score: voxel.localPoints / Math.max(1, medianLocalPoints) + voxel.neighbors / 26 + depth * 0.05,
			})
		}
		// A uniformly sparse piece has no dense body to distinguish from an outlier. Leave
		// it intact instead of trimming a valid thin prop such as a pole or bare branch.
		if (!candidates.length || edgeVoxels.size - candidates.length < Math.max(4, edgeVoxels.size * 0.2)) return 0
		candidates.sort((a, b) => a.score - b.score)

		const removalBudget = Math.max(1, Math.floor(total * lerp(0.001, 0.06, edgeOutlierDrive)))
		const remove = new Uint8Array(total)
		let removed = 0
		candidateLoop: for (const { voxel } of candidates) {
			for (const i of voxel.indices) {
				remove[i] = 1
				removed++
				if (removed >= removalBudget) break candidateLoop
			}
		}
		if (!removed) return 0

		const kept = new PackedSplats()
		const nextBounds = new THREE.Box3()
		part.packed.forEachSplat((i, center, scales, quaternion, opacity, color) => {
			if (remove[i]) return
			kept.pushSplat(center, scales, quaternion, opacity, color)
			nextBounds.expandByPoint(center)
		})
		part.packed = kept
		part.bounds = nextBounds
		return removed
	}
	for (const [label, part] of blobParts) {
		const removed = pruneObjectPartWisps(part, ground, { label })
		if (removed) {
			wispCulled += removed
			console.log(`[segment] wisp prune ${part.name} → ${removed} disconnected gaussian(s) returned to ground after segmentation`)
		}
	}
	const moveCullablePartToGround = (label, part) => {
		let moved = 0
		const kept = new PackedSplats()
		const keptBounds = new THREE.Box3()
		part.packed.forEachSplat((_i, center, scales, quaternion, opacity, color) => {
			if (mayCullAt(center.x, center.y, center.z, 0, label)) {
				ground.packed.pushSplat(center, scales, quaternion, opacity, color)
				ground.bounds.expandByPoint(center)
				moved++
			} else {
				kept.pushSplat(center, scales, quaternion, opacity, color)
				keptBounds.expandByPoint(center)
			}
		})
		part.packed = kept
		part.bounds = keptBounds
		return moved
	}
	const largestNamedObject = Math.max(1, ...[...blobParts.values()]
		.filter(part => !part.name.startsWith("obj-detached-"))
		.map(part => part.packed.numSplats))
	const detachedCullLimit = Math.max(120, largestNamedObject * segmentationTuning.detachedCullPct * POST_CULL)
	for (const [label, part] of blobParts) {
		if (!part.name.startsWith("obj-detached-")) continue
		if (part.packed.numSplats > detachedCullLimit) continue
		const moved = moveCullablePartToGround(label, part)
		if (moved) {
			wispCulled += moved
			console.log(`[segment] detached wisp prune ${part.name} → ${moved} gaussian(s) returned to ground`)
		}
	}
	let scarPatchSplats = 0
	let scarRemnantsCulled = 0
	if (SEGMENTATION_CLEANUP_ENABLED && hasGround && groundSurf && blobParts.size) {
		const SCAR_DILATE_CELLS = segmentationTuning.scarDilation // square width: 1 = 1×1, 2 = 2×2, 3 = 3×3 scar cells
		const SCAR_BASE_HEIGHT_BAND = segmentationTuning.scarBaseHeight // only splats this far above an object's lowest point can create scar cells
		const SCAR_BASE_SURFACE_BAND = segmentationTuning.scarBaseSurface // and only if they are still near the terrain surface
		const GROUND_SMOOTH = clamp01(segmentationTuning.groundSmooth ?? 0.8)
		const GROUND_FILL = clamp01(segmentationTuning.groundFill ?? 0.5)
		const GROUND_FILL_MAX_HEIGHT = clamp01(segmentationTuning.groundFillMaxHeight ?? 0.25)
		const SCAR_RAISED_CULL = lerp(0.55, 0.015, GROUND_SMOOTH) // stronger smoothing removes material closer to the repaired floor
		const SCAR_NEARBY_COLOR_RADIUS = 8 // larger = sample terrain colour farther away from the scar
		const SCAR_TARGET_SPLATS = Math.round(lerp(0, 36, GROUND_FILL)) // higher = denser/more opaque-looking fill
		const SCAR_MAX_SPLATS = 32 // cap to avoid runaway fill cost
		const SCAR_SCALE_MIN = lerp(0.22, 0.72, GROUND_FILL) // larger = each filler splat covers more cell area
		const SCAR_SCALE_JITTER = lerp(0.08, 0.38, GROUND_FILL)
		const SCAR_HEIGHT = 0.006 // tiny z-fighting offset; repair height itself is the measured local floor
		const SCAR_THICKNESS = 0.018
		const SCAR_OPACITY = lerp(0.55, 0.98, GROUND_FILL)
		const SCAR_SHADE_MIN = 0.95
		const SCAR_SHADE_JITTER = 0.1
		const SCAR_CELL_MARGIN = 0.05 // keeps random filler centers inside each terrain cell
		const smoothFootprintDrive = GROUND_SMOOTH * GROUND_SMOOTH
		const scarDilateRadius = Math.max(0, Math.floor(SCAR_DILATE_CELLS / 2)) + Math.round(3 * smoothFootprintDrive)
		const scarCells = new Uint8Array(gw * gh)
		const repairFillCeiling = new Float32Array(gw * gh).fill(Infinity)
		const footprintCells = new Map()
		for (const [label, part] of blobParts) {
			if (!part.packed.numSplats || part.bounds.isEmpty()) continue
			const partHeight = Math.max(VOX, part.bounds.max.y - part.bounds.min.y)
			const originalRange = cleanupHeightRanges.get(label)
			const originalBottom = originalRange?.low ?? part.bounds.min.y
			const originalHeight = Math.max(VOX, (originalRange?.high ?? part.bounds.max.y) - originalBottom)
			// Keep the tiny allowance needed by the anti-z-fighting offset when the
			// slider is at 0%, while still treating that setting as the object's base.
			const fillCeiling = originalBottom
				+ originalHeight * GROUND_FILL_MAX_HEIGHT
				+ Math.min(VOX * 0.5, originalHeight * 0.03)
			// Low smoothing follows only the contact patch. At 100%, every occupied XZ
			// column of the object contributes, catching wider upper shell sections too.
			const footprintTop = part.bounds.min.y + lerp(Math.min(partHeight, SCAR_BASE_HEIGHT_BAND), partHeight, smoothFootprintDrive)
			const surfaceReach = lerp(SCAR_BASE_SURFACE_BAND, partHeight + VOX, smoothFootprintDrive)
			part.packed.forEachSplat((_i, center) => {
				const cell = cellOfXZ(center.x, center.z)
				if (center.y > footprintTop) return
				if (GROUND_SMOOTH < 0.999 && center.y > groundSurf[cell] + surfaceReach) return
				const currentCeiling = footprintCells.get(cell)
				footprintCells.set(cell, currentCeiling == null ? fillCeiling : Math.min(currentCeiling, fillCeiling))
			})
		}
		for (const [cell, fillCeiling] of footprintCells) {
			const cx = cell % gw
			const cz = Math.floor(cell / gw)
			for (let dz = -scarDilateRadius; dz <= scarDilateRadius; dz++) {
				for (let dx = -scarDilateRadius; dx <= scarDilateRadius; dx++) {
					const nx = cx + dx, nz = cz + dz
					if (nx < 0 || nx >= gw || nz < 0 || nz >= gh) continue
					const targetCell = nz * gw + nx
					scarCells[targetCell] = 1
					repairFillCeiling[targetCell] = Math.min(repairFillCeiling[targetCell], fillCeiling)
				}
			}
		}
		if (scarCells.some(Boolean)) {
			// Infer the floor beneath each object from nearby cells outside its footprint.
			// Object remnants cannot lift this target because scar cells never vote for it.
			const repairFloorHeight = Float32Array.from(groundSurf)
			for (let cz = 0; cz < gh; cz++) {
				for (let cx = 0; cx < gw; cx++) {
					const targetCell = cz * gw + cx
					if (!scarCells[targetCell]) continue
					let samples = []
					for (let r = 1; r <= SCAR_NEARBY_COLOR_RADIUS && !samples.length; r++) {
						for (let dz = -r; dz <= r; dz++) {
							for (let dx = -r; dx <= r; dx++) {
								const nx = cx + dx, nz = cz + dz
								if (nx < 0 || nx >= gw || nz < 0 || nz >= gh) continue
								const cell = nz * gw + nx
								if (scarCells[cell]) continue
								const wx = minX + (nx + 0.5) * (spanX / gw)
								const wz = minZ + (nz + 0.5) * (spanZ / gh)
								if (onInk && !onInk(wx, wz)) continue
								samples.push(groundSurf[cell])
							}
						}
					}
					samples.sort((a, b) => a - b)
					repairFloorHeight[targetCell] = samples.length
						? samples[Math.floor(samples.length / 2)]
						: floorLevel[targetCell]
				}
			}
			const rebuiltGround = new PackedSplats()
			const rebuiltBounds = new THREE.Box3()
			const scarCellCount = new Int32Array(gw * gh)
			const scarCellColor = Array.from({ length: gw * gh }, () => [0, 0, 0])
			const smoothingEnabled = GROUND_SMOOTH > 0
			const smoothCullAmount = Math.max(GROUND_SMOOTH, CULL_AMOUNT)
			ground.packed.forEachSplat((_i, center, scales, quaternion, opacity, color) => {
				const cell = cellOfXZ(center.x, center.z)
				const amountAllowsCull = smoothCullAmount >= 1 || cullHash(center.x, center.y, center.z, 83) < smoothCullAmount
				if (smoothingEnabled && scarCells[cell] && center.y > repairFloorHeight[cell] + SCAR_RAISED_CULL && amountAllowsCull) {
					scarRemnantsCulled++
					return
				}
				rebuiltGround.pushSplat(center, scales, quaternion, opacity, color)
				rebuiltBounds.expandByPoint(center)
				scarCellCount[cell]++
				if (color) {
					const acc = scarCellColor[cell]
					acc[0] += color.r
					acc[1] += color.g
					acc[2] += color.b
				}
			})
			ground.packed = rebuiltGround
			ground.bounds = rebuiltBounds
			const patchCenter = new THREE.Vector3()
			const patchScales = new THREE.Vector3()
			const patchQuat = new THREE.Quaternion()
			const patchColor = new THREE.Color()
			const cellW = spanX / gw
			const cellD = spanZ / gh
			const fallbackColor = new THREE.Color(world.baseGroundColor || baseGroundColor)
			const hash01 = (cx, cz, k, salt = 0) => {
				const v = Math.sin((cx + 1) * 173.9 + (cz + 1) * 269.5 + (k + 1) * 97.1 + salt * 41.7) * 43758.5453
				return v - Math.floor(v)
			}
			const terrainSampleForCell = (cx, cz) => {
				for (let r = 1; r <= SCAR_NEARBY_COLOR_RADIUS; r++) {
					const acc = [0, 0, 0, 0]
					for (let dz = -r; dz <= r; dz++) {
						for (let dx = -r; dx <= r; dx++) {
							const nx = cx + dx, nz = cz + dz
							if (nx < 0 || nx >= gw || nz < 0 || nz >= gh) continue
							const cell = nz * gw + nx
							if (scarCells[cell]) continue
							const count = scarCellCount[cell]
							if (!count) continue
							const c = scarCellColor[cell]
							acc[0] += c[0]
							acc[1] += c[1]
							acc[2] += c[2]
							acc[3] += count
						}
					}
					if (acc[3]) return {
						color: patchColor.setRGB(acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]).clone(),
						height: repairFloorHeight[cz * gw + cx],
					}
				}
				return null
			}
			let scarSkippedSkyCells = 0
			let scarSkippedHighCells = 0
			for (let cz = 0; cz < gh; cz++) {
				for (let cx = 0; cx < gw; cx++) {
					const cell = cz * gw + cx
					if (!scarCells[cell]) continue
					const sample = terrainSampleForCell(cx, cz)
					if (!sample) {
						scarSkippedSkyCells++
						continue
					}
					const patchHeight = sample.height + SCAR_HEIGHT
					if (patchHeight > repairFillCeiling[cell]) {
						scarSkippedHighCells++
						continue
					}
					const color = sample.color || fallbackColor
					// Fill actual missing density only. Expanded smoothing cells that already have
					// enough floor material are left untouched rather than overpainted.
					const need = Math.min(SCAR_MAX_SPLATS, Math.max(0, SCAR_TARGET_SPLATS - scarCellCount[cell]))
					for (let k = 0; k < need; k++) {
						const ox = SCAR_CELL_MARGIN + hash01(cx, cz, k, 1) * (1 - SCAR_CELL_MARGIN * 2)
						const oz = SCAR_CELL_MARGIN + hash01(cx, cz, k, 2) * (1 - SCAR_CELL_MARGIN * 2)
						const scale = SCAR_SCALE_MIN + hash01(cx, cz, k, 3) * SCAR_SCALE_JITTER
						const shade = SCAR_SHADE_MIN + hash01(cx, cz, k, 4) * SCAR_SHADE_JITTER
						patchScales.set(cellW * scale, SCAR_THICKNESS, cellD * scale)
						patchQuat.setFromAxisAngle(localUp, hash01(cx, cz, k, 5) * Math.PI)
						patchColor.setRGB(Math.min(1, color.r * shade), Math.min(1, color.g * shade), Math.min(1, color.b * shade))
						patchCenter.set(
							minX + (cx + ox) * cellW,
							patchHeight,
							minZ + (cz + oz) * cellD,
						)
						ground.packed.pushSplat(patchCenter, patchScales, patchQuat, SCAR_OPACITY, patchColor)
						ground.bounds.expandByPoint(patchCenter)
						scarPatchSplats++
					}
				}
			}
			if (scarSkippedSkyCells) console.log(`[segment] ground scar flatten skipped ${scarSkippedSkyCells} sky/unanchored scar cell(s)`)
			if (scarSkippedHighCells) console.log(`[segment] ground scar flatten skipped ${scarSkippedHighCells} cell(s) above the object-relative fill ceiling`)
		}
		if (scarPatchSplats || scarRemnantsCulled) console.log(`[segment] ground scar flatten → ${scarPatchSplats} filler + ${scarRemnantsCulled} raised remnant gaussian(s) under object footprint(s)`)
	}
	if (ground.packed.numSplats) {
		const removed = pruneObjectPartWisps(ground, null, { keepOnlyMain: true })
		if (removed) {
			wispCulled += removed
			console.log(`[segment] floor wisp prune → ${removed} disconnected gaussian(s) deleted from ground`)
		}
	}
	for (const part of [...blobParts.values(), ground]) {
		const removed = pruneSparseEdgeOutliers(part)
		if (!removed) continue
		edgeOutlierCulled += removed
		console.log(`[segment] sparse edge prune ${part.name} → ${removed} isolated outer gaussian(s) deleted`)
	}

	// Collapse guard: when the seating/matching went wrong, everything lands in ground
	// and the pruning passes delete most of the scene (observed: 15% survival vs ~93%
	// healthy). Keeping the seated monolith is strictly better — retune can recover it.
	const KEEP_MIN = 0.5
	let survivors = ground.packed.numSplats
	for (const part of blobParts.values()) survivors += part.packed.numSplats
	if (survivors < n * KEEP_MIN) {
		console.warn(`[segment] collapse guard → kept scene unsegmented: survivors ${survivors}/${n} (${(survivors / n * 100).toFixed(0)}%) below ${KEEP_MIN * 100}% — ground ${ground.packed.numSplats}, ${blobParts.size} object blob(s)`)
		window.__wsSegLast = { collapsed: true, survivors, total: n, summary: window.__wsSegClaims ?? null }
		return
	}

	// Swap the monolith for its pieces inside the same view-frame records array.
	const idx = world.generated.indexOf(record)
	if (idx >= 0) world.generated.splice(idx, 1)
	disposeObject(record.mesh)
	const seatPiece = (part, kind) => {
		if (!part.packed.numSplats) return 0
		const mesh = new SplatMesh({ packedSplats: part.packed })
		mesh.userData.genName = part.name
		mesh.userData.genKind = kind
		mesh.userData.contentBox = part.bounds.clone()
		if (flipScene) {
			// The matcher proved the seating was mirrored: rotate every piece 180° about
			// the scene content center. contentBox stays in mesh-local space, so proxies
			// and gizmos follow the transform for free.
			mesh.rotation.y = Math.PI
			mesh.position.set(minX + maxX, 0, minZ + maxZ)
		}
		const c = part.bounds.getCenter(new THREE.Vector3())
		console.log(`[segment]   ${part.name} (${kind}): ${part.packed.numSplats} splats @ (${c.x.toFixed(1)}, ${c.y.toFixed(1)}, ${c.z.toFixed(1)})${flipScene ? " [flipped]" : ""}`)
		world.addGenerated(mesh)
		return 1
	}
	let pieces = seatPiece(ground, hasGround ? "floor" : "remainder")
	for (const id of ranked) pieces += seatPiece(blobParts.get(id), "object")
	const remainder = hasGround
		? `${blobs.length - bigBlobIds.length} tuft(s) folded into ground, ${skinCulled} floor-skin + ${unsupportedCulled} unsupported-surface + ${wispCulled} disconnected-wisp + ${edgeOutlierCulled} sparse-edge + ${imageBoxClipped} image-box-clipped + ${offEdgeShadowCulled} off-edge-shadow gaussian(s) left behind`
		: `${ground.packed.numSplats} unmatched gaussian(s) kept as static remainder`
	console.log(`[segment] content → ${pieces} piece(s) from ${n} gaussians (${bigBlobIds.length} object blob(s), ${splits} bridge split(s), voxel ${VOX.toFixed(3)}, ${remainder})`)
	window.__wsSegLast = {
		pieces: world.generated.filter(g => g.mesh.userData.genKind === "object").map(g => {
			const c = g.mesh.userData.contentBox?.getCenter(new THREE.Vector3())
			return { name: g.mesh.userData.genName, splats: g.mesh.packedSplats?.numSplats, at: c ? [Number(c.x.toFixed(1)), Number(c.z.toFixed(1))] : null }
		}),
		summary: window.__wsSegClaims ?? null,
	}
}

// Whole-scene generation: one capture, one image edit, one TripoSplat call.
async function generateWorld(prompt) {
	if (generating) return
	const hasGround = Boolean(world.groundInkBounds())
	if (!hasGround && !world.primitives.length) {
		// The status line is CSS-hidden, so surface the hint where the user is looking.
		els.chatPrompt.value = ""
		els.chatPrompt.placeholder = "Draw some ground with the paint tool first…"
		return
	}
	if (!getHuggingFaceAuth().signedIn) {
		snapshotActiveBuildFrame()
		location.assign("/")
		return
	}
	generating = true
	splatting = true
	world.prompt = prompt
	window.posthog?.capture("generate_started", { has_ground: hasGround, prompt_length: prompt.length })
	syncGenerateButton()
	setStatus("")
	clearRawSplatPreview()
	beginNewSplatFrame()
	setUiTab("build")
	showProgress(0, 1, "Capturing complete scene…")
	clearGenerationDebugImages()

	try {
		const genStart = performance.now()
		const cfg = await getConfig()
		applyRuntimeConfig(cfg)
		configureHuggingFace(cfg?.generation)
		generationAbort = new AbortController()

		const box = wholeSceneBox()
		const subjectMeshes = hasGround ? world.allBlockoutMeshes() : [...world.primitives]
		const objectGroups = computeObjects(world.primitives)
		const tCap = performance.now()
		// Capture from the isometric corner NEAREST the user's current view, not the raw
		// orbit angles: quarter-turn offsets keep the whole proven seating geometry intact
		// (the yaw estimator's candidate set stays exact and fit.js's 90°/270° extent swap
		// is exact, not approximate), while an arbitrary azimuth/elevation seeds Tripo with
		// a viewpoint the seating pipeline can only approximate.
		const QUARTER = Math.PI / 2
		const viewAngles = {
			theta: FRONT_THETA + Math.round((orbit.theta - FRONT_THETA) / QUARTER) * QUARTER,
			phi: FRONT_PHI,
		}
		const capture = await captureWorldQuiet(renderer, scene, world, box, objectGroups, viewAngles)
		logGenerationDebugImage("capture", "Block-out capture sent to the image model", capture.guide)
		logGenerationDebugImage("structure", imageStepUsesCredits()
			? "Aligned structural map (not sent on the inference-credit route)"
			: "Aligned structural map sent to the image model", capture.semanticMap)
		const captureMs = performance.now() - tCap
		// The image editor is asked to preserve the camera and composition, so the original object
		// bounds remain the most reliable boxes for later splat segmentation.
		sceneImageBoxes = projectCaptureBoxes(objectGroups, world.groundInkBounds(), box, capture)

		sceneSplat = null
		sceneSession = null
		let generatedOutputImage = null
		showProgress(0, 100, "Sending the scene to Hugging Face…")
		const { bytes } = await generateSceneOnHuggingFace({
			prompt,
			image: capture.guide,
			geometryImage: capture.semanticMap,
			hasGround: Boolean(world.groundInkBounds()), // objects-only scenes get the no-floor prompt variant
			signal: generationAbort.signal,
			onProgress: (fraction, label) => showProgress(Math.round(fraction * 100), 100, label),
			onImageReady: image => {
				generatedOutputImage = image // orientation ground truth for the yaw/mirror estimate
				logGenerationDebugImage("output", "Final detailed image sent to TripoSplat", image)
			},
		})
		showProgress(97, 100, "Analyzing the 3D scene…")
		await yieldForProgressPaint()
		// Fit a copy so sceneSplat retains the pristine TripoSplat bytes for ZIP/history.
		// Preserve the one-shot reconstruction's proportions with a uniform fit. The
		// terrain and objects share one cloud, so independently forcing X and Z onto the
		// block-out footprint would stretch/compress every object along with the floor.
		// Estimate every one-shot scene's quarter-turn from its content. The config yaw is
		// only a fallback when a scene is too monochrome or symmetric to disambiguate.
		const captureYawDeg = captureProjectionBasis(capture.theta, capture.phi).yawOffsetDeg
		const sceneEstimate = await estimateSceneYaw(bytes, subjectMeshes, capture.guide, capture, generatedOutputImage)
		const sceneYawDeg = sceneEstimate?.yawDeg ?? (sceneFit.yawDeg + captureYawDeg)
		const sceneMirrorZ = sceneEstimate?.mirrorZ ?? false
		showProgress(98, 100, "Loading the 3D scene…")
		await yieldForProgressPaint()
		const seatedScene = await seatScene(bytes.slice(), box, {
			yawDeg: sceneYawDeg,
			mirrorZ: sceneMirrorZ,
			yOffset: sceneFit.yOffset,
		})
		sceneSplat = bytes
		sceneSession = {
			hasGround,
			yawDeg: sceneYawDeg,
			mirrorZ: sceneMirrorZ,
			captureTheta: capture.theta,
			capturePhi: capture.phi,
			imageBoxes: sceneImageBoxes,
		}
		// Carve the one splat into per-object pieces so View can move them; a segmentation
		// failure must never sink the completed generation — the monolith is a fine fallback.
		// Off by default (it freezes the tab); the devtools checkbox opts back in, and the
		// dev panel's "Apply to current scene" can still separate this scene afterwards.
		const splatCount = seatedScene?.packedSplats?.numSplats ?? 0
		const tooDenseToSegment = splatCount > MAX_AUTOMATIC_SEGMENT_SPLATS
		const segmentationSkipped = !autoSegmentationEnabled || tooDenseToSegment
		showProgress(99, 100, segmentationSkipped ? "Finalizing the 3D scene…" : "Separating scene objects…")
		await yieldForProgressPaint()
		if (tooDenseToSegment) {
			console.warn(`[segment] skipped automatic separation for ${splatCount.toLocaleString()} splats to keep the browser responsive`)
		} else if (!autoSegmentationEnabled) {
			console.log("[segment] automatic separation is off (devtools checkbox) — scene kept as one piece")
		} else {
			try { segmentSceneSplat(hasGround) } catch (error) { console.warn("segment:", error) }
		}

		console.log(`[timing] whole scene ${((performance.now() - genStart) / 1000).toFixed(1)}s — one capture ${(captureMs / 1000).toFixed(1)}s · one texture edit · one TripoSplat request`)

		world.state = "generated"
		splatting = false
		applyOverlayVisibility()
		await playGenerationCutscene()
		saveBuildToHistory(world.prompt)
		window.posthog?.capture("generate_completed", { duration_s: Math.round((performance.now() - genStart) / 1000) })
		showProgress(1, 1, "Done")
		if (tooDenseToSegment) setStatus("Scene loaded as one piece because it was too dense to separate safely in the browser")
		window.setTimeout(hideProgress, 1000)
	} catch (error) {
		window.posthog?.capture("generate_failed", { error: error?.message })
		setStatus(error.message || "Generation failed")
		hideProgress()
	} finally {
		generationAbort = null
		generating = false
		splatting = false
		syncGenerateButton()
	}
}

async function retuneCurrentSceneSegmentation() {
	const bytes = sceneSplat
	if (!bytes || !sceneSession) {
		setStatus("No raw scene splat available to retune")
		return
	}
	if (generating || splatting) {
		segmentationTuneQueued = true
		return
	}
	if (segmentationTuneRunning) {
		segmentationTuneQueued = true
		return
	}
	segmentationTuneRunning = true
	segmentationTuneQueued = false
	try {
		deselectSplat()
		setStatus("Updating object separation…")
		sceneImageBoxes = sceneSession.imageBoxes ?? sceneImageBoxes
		const hasGround = sceneSession.hasGround !== false
		world.resetGenerated()
		const box = wholeSceneBox()
		await seatScene(bytes.slice(), box, {
			yawDeg: Number.isFinite(sceneSession.yawDeg) ? sceneSession.yawDeg : sceneFit.yawDeg,
			mirrorZ: Boolean(sceneSession.mirrorZ),
			yOffset: sceneFit.yOffset,
		})
		try { segmentSceneSplat(hasGround) }
		catch (error) { console.warn("retune segment:", error) }
		world.state = "generated"
		splatting = false
		setUiTab("view")
		frameGeneratedSplats()
		applyOverlayVisibility()
		setStatus("")
	} catch (error) {
		console.warn("retune segmentation:", error)
		setStatus(error.message || "Retune failed")
	} finally {
		segmentationTuneRunning = false
		if (segmentationTuneQueued) {
			segmentationTuneQueued = false
			window.setTimeout(() => retuneCurrentSceneSegmentation(), 0)
		}
	}
}

async function seatScene(bytes, box, { yawDeg = 0, yOffset = 0, mirrorZ = false, fileName = "scene.splat" } = {}) {
	const raw = new SplatMesh({ fileBytes: bytes, fileName })
	await raw.initialized
	const fitted = await fitSplatToBox(raw, box, {
		yawDeg,
		mirrorZ,
		yOffset,
		opacityFloor: SEGMENTATION_CLEANUP_ENABLED ? sceneFit.opacityFloor : 0,
		spanLo: sceneFit.fitBboxPercentile,
		spanHi: 1 - sceneFit.fitBboxPercentile,
		cullAmount: SEGMENTATION_CLEANUP_ENABLED ? clamp01((segmentationTuning.cullAmount ?? 100) / 100) : 0,
		cullHeightFraction: SEGMENTATION_CLEANUP_ENABLED ? clamp01(segmentationTuning.cleanupReach ?? 0.25) : 0,
		wispCullStrength: clamp01(segmentationTuning.wispCull ?? 0.5), // independent of the cleanup switch
	})
	if (!fitted) {
		disposeObject(raw)
		throw new Error("scene: splat had no usable bounds after culling")
	}
	fitted.userData.genName = "scene"
	fitted.userData.genKind = "scene"
	world.addGenerated(fitted)
	return fitted
}

function clearRawSplatPreview() {
	if (!rawSplatPreview) return
	disposeObject(rawSplatPreview)
	rawSplatPreview = null
	world.group.visible = true
	if (rawOrbitSnapshot) {
		orbit.target.copy(rawOrbitSnapshot.target)
		orbit.radius = rawOrbitSnapshot.radius
		orbit.theta = rawOrbitSnapshot.theta
		orbit.phi = rawOrbitSnapshot.phi
		rawOrbitSnapshot = null
		updateCamera()
	}
}

// Point the camera at the exact stored center bounds (the upright flip is baked into
// the gaussians before this runs, so the bounds are already right-side-up).
function frameRawSplat(mesh) {
	const bounds = new THREE.Box3()
	let count = 0
	mesh.packedSplats?.forEachSplat((_i, center) => {
		if (![center.x, center.y, center.z].every(Number.isFinite)) return
		bounds.expandByPoint(center)
		count++
	})
	if (!count || bounds.isEmpty()) return
	const sphere = bounds.getBoundingSphere(new THREE.Sphere())
	orbit.target.copy(sphere.center)
	orbit.radius = Math.max(0.001, sphere.radius * 2.75)
	updateCamera()
}

function expandByTransformedBox(out, box, matrix) {
	if (!box || box.isEmpty()) return
	for (const x of [box.min.x, box.max.x]) {
		for (const y of [box.min.y, box.max.y]) {
			for (const z of [box.min.z, box.max.z]) {
				out.expandByPoint(scratch.set(x, y, z).applyMatrix4(matrix))
			}
		}
	}
}

function frameGeneratedSplats() {
	const bounds = new THREE.Box3()
	let count = 0
	for (const { mesh } of world.generated) {
		if (!mesh?.visible && uiTab === "view") continue
		mesh.updateWorldMatrix(true, false)
		if (mesh.userData.contentBox && !mesh.userData.contentBox.isEmpty()) {
			expandByTransformedBox(bounds, mesh.userData.contentBox, mesh.matrixWorld)
			count++
			continue
		}
		mesh.packedSplats?.forEachSplat((_i, center) => {
			if (![center.x, center.y, center.z].every(Number.isFinite)) return
			bounds.expandByPoint(mesh.localToWorld(center.clone()))
			count++
		})
	}
	if (!count || bounds.isEmpty()) return
	const sphere = bounds.getBoundingSphere(new THREE.Sphere())
	orbit.target.copy(sphere.center)
	orbit.radius = Math.max(0.001, sphere.radius * 2.75)
	updateCamera()
}

// Developer-only raw viewer: instantiate the file directly and add it to the scene.
// Deliberately bypasses seatScene/fitSplatToBox and the session/export pipeline.
async function viewRawSplat(file) {
	if (!file || generating) return
	generating = true
	syncGenerateButton()
	setStatus("")
	showProgress(0, 1, "Loading raw splat...")
	let raw = null
	try {
		world.resetGenerated()
		sceneSplat = null
		sceneSession = null
		const bytes = new Uint8Array(await file.arrayBuffer())
		raw = new SplatMesh({ fileBytes: bytes, fileName: file.name })
		await raw.initialized

		rawOrbitSnapshot = {
			target: orbit.target.clone(),
			radius: orbit.radius,
			theta: orbit.theta,
			phi: orbit.phi,
		}
		// Turn the upload upright: stored splat files are Y-inverted vs the world. Bake a
		// 180° X-rotation into the gaussians (a rotation, not a mirror — handedness kept).
		{
			const flip = new THREE.Quaternion(1, 0, 0, 0) // 180° about X
			const packed = raw.packedSplats
			packed?.forEachSplat((i, center, scales, quaternion, opacity, color) => {
				center.set(center.x, -center.y, -center.z)
				quaternion.premultiply(flip)
				packed.setSplat(i, center, scales, quaternion, opacity, color)
			})
			if (packed) packed.needsUpdate = true
		}

		rawSplatPreview = raw
		raw = null
		world.group.visible = false
		scene.add(rawSplatPreview)
		selectPrimitive(null)
		frameRawSplat(rawSplatPreview)

		const count = rawSplatPreview.packedSplats?.numSplats
		const detail = Number.isFinite(count) ? ` (${count.toLocaleString()} gaussians)` : ""
		setStatus(`Viewing ${file.name} raw${detail} - no fitting or transforms. Press Esc to return.`)
		showProgress(1, 1, "Done")
		window.setTimeout(hideProgress, 700)
	} catch (error) {
		if (raw) disposeObject(raw)
		clearRawSplatPreview()
		setStatus(error.message || "Raw splat upload failed")
		hideProgress()
	} finally {
		generating = false
		syncGenerateButton()
	}
}

// Fit one uploaded whole-scene splat against the current block-out.
async function uploadSceneSplat(file) {
	if (!file || generating) return
	generating = true
	splatting = true
	syncGenerateButton()
	setStatus("")
	try {
		const cfg = await getConfig()
		applyRuntimeConfig(cfg)
		clearRawSplatPreview()
		beginNewSplatFrame()
		sceneSplat = null
		sceneSession = null

		showProgress(0, 1, "Loading scene splat...")
		const bytes = new Uint8Array(await file.arrayBuffer())
		const hasGround = Boolean(world.groundInkBounds())
		await seatScene(bytes.slice(), wholeSceneBox(), {
			yawDeg: sceneFit.yawDeg,
			yOffset: sceneFit.yOffset,
			fileName: file.name,
		})
		sceneSplat = bytes
		sceneSession = { hasGround, yawDeg: sceneFit.yawDeg, mirrorZ: false }
		try { segmentSceneSplat(hasGround) } catch (error) { console.warn("segment uploaded scene:", error) }
		world.state = "generated"
		splatting = false
		setUiTab("view")
		frameGeneratedSplats()
		applyOverlayVisibility()
		setStatus(`Loaded ${file.name}`)
		showProgress(1, 1, "Done")
		window.setTimeout(hideProgress, 1000)
	} catch (error) {
		setStatus(error.message || "Upload failed")
		hideProgress()
	} finally {
		generating = false
		splatting = false
		syncGenerateButton()
	}
}

function serializePrimitiveList() {
	const index = new Map(world.primitives.map((mesh, i) => [mesh, i]))
	return world.primitives.map(mesh => ({
		type: mesh.userData.type,
		position: mesh.position.toArray(),
		rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
		scale: mesh.scale.toArray(),
		color: `#${mesh.userData.baseColor ?? mesh.material.color.getHexString()}`,
		locked: Boolean(mesh.userData.locked),
		support: mesh.userData.support ? index.get(mesh.userData.support) ?? null : null,
		supportAxis: mesh.userData.supportAxis ?? { name: "y", sign: 1 },
	}))
}

// Serialize the block-out primitives to a plain object (shared by download and ZIP export).
function serializePrimitives() {
	return {
		version: 4,
		// New paint is stored as editable world-space strokes. Older raster-only builds
		// retain one exact base image with later strokes layered over it.
		ground: groundPaintData(),
		primitives: serializePrimitiveList(),
	}
}

// Save the block-out primitives to a JSON file so a layout can be saved and fully
// reloaded — including the support/attachment forest (saved as array indices, since the
// links are by-reference) so seated stacks survive a round-trip.
function downloadPrimitives() {
	const blob = new Blob([JSON.stringify(serializePrimitives(), null, 2)], { type: "application/json" })
	downloadBlob(blob, `primitives-${Date.now()}.json`)
}

// Export the current one-shot scene (splat + primitives + fit metadata) as a ZIP so it
// can be re-fitted later without regenerating. The ZIP contains:
//   primitives.json  — block-out scene (same format as the standalone primitive download)
//   scene.json       — scene orientation/capture metadata
//   splats/scene.splat — pristine Tripo bytes for the complete scene
async function downloadZip() {
	if (!sceneSplat || !sceneSession) { setStatus("Nothing to export — generate first"); return }
	const enc = new TextEncoder()
	const files = {
		"primitives.json": [enc.encode(JSON.stringify(serializePrimitives(), null, 2)), { level: 6 }],
		"scene.json": [enc.encode(JSON.stringify({ version: 2, scene: sceneSession }, null, 2)), { level: 6 }],
		"splats/scene.splat": [sceneSplat, { level: 0 }],
	}
	try {
		await new Promise((resolve, reject) => {
			zip(files, (err, data) => {
				if (err) { reject(err); return }
				downloadBlob(new Blob([data], { type: "application/zip" }), `worldsketch-${Date.now()}.zip`)
				resolve()
			})
		})
	} catch (err) {
		setStatus("ZIP export failed: " + (err.message || err))
	}
}

// Load a previously exported one-shot ZIP, replace the block-out with the stored
// primitives, then re-seat its complete-scene splat without regenerating.
async function uploadZip(file) {
	if (!file || generating) return
	generating = true
	splatting = true
	syncGenerateButton()
	setStatus("")
	try {
		const raw = new Uint8Array(await file.arrayBuffer())
		const files = await new Promise((resolve, reject) => unzip(raw, (err, data) => err ? reject(err) : resolve(data)))

		const primBytes = files["primitives.json"]
		const sceneBytes = files["scene.json"]
		if (!primBytes) throw new Error("ZIP missing primitives.json")
		if (!sceneBytes) throw new Error("ZIP missing scene.json")

		const sceneData = JSON.parse(new TextDecoder().decode(sceneBytes))
		// Accept the earlier one-shot manifest shape, but never restore its object/floor entries.
		const sceneMetadata = sceneData.scene ?? sceneData.subjects?.find(item => item.name === "scene" || item.kind === "scene")
		if (!sceneMetadata) throw new Error("ZIP has no one-shot scene in scene.json")
		const splatBytes = files["splats/scene.splat"]
		if (!splatBytes) throw new Error("ZIP missing splats/scene.splat")

		await applyStoredBuild({
			primitives: primBytes,
			sceneMetadata,
			splatBytes,
		})
		setStatus("Re-fitted scene")
	} catch (err) {
		setStatus(err.message || "Re-fit failed")
		hideProgress()
	} finally {
		generating = false
		splatting = false
		syncGenerateButton()
	}
}

// Shared re-fit core for ZIP re-fit and history restore. Only the one-shot scene is a
// persisted generation unit; movable object/floor pieces are derived by segmentation
// after the pristine scene splat is seated.
async function applyStoredBuild({ primitives, sceneMetadata, splatBytes }) {
	if (!sceneMetadata) throw new Error("Build has no one-shot scene")
	if (!splatBytes) throw new Error("Build is missing its scene splat")
	const primBytes = primitives instanceof Uint8Array
		? primitives
		: new TextEncoder().encode(typeof primitives === "string" ? primitives : JSON.stringify(primitives))

	// Frames: a restored build gets its own Build frame AND its own Splat frame, so
	// whatever was open before survives untouched.
	snapshotActiveBuildFrame()
	pushBuildFrame()
	beginNewSplatFrame()

	// Reload primitives (resets generated state, rebuilds block-out). Must be the
	// lock-free core — this path runs under the caller's `generating` lock.
	await applyPrimitives(new File([primBytes], "primitives.json", { type: "application/json" }))

	// Pull fresh scene fit params from the server so .env tuning also applies to restores.
	applyRuntimeConfig(await getConfig())

	sceneSplat = null
	sceneSession = null
	world.resetGenerated()
	showProgress(0, 1, "Re-fitting scene…")

	const box = wholeSceneBox()
	const hasGround = sceneMetadata.hasGround !== false
	const sourcePrimitives = hasGround ? world.allBlockoutMeshes() : [...world.primitives]
	let yawDeg = sceneFit.yawDeg
	let mirrorZ = false
	const params = new URLSearchParams(location.search)
	const forcedYaw = params.get("forceYaw")
	if (forcedYaw != null && Number.isFinite(Number(forcedYaw))) {
		yawDeg = Number(forcedYaw)
		mirrorZ = params.get("forceMirror") === "1"
	} else {
		const captureAngles = {
			theta: Number.isFinite(sceneMetadata.captureTheta) ? sceneMetadata.captureTheta : FRONT_THETA,
			phi: Number.isFinite(sceneMetadata.capturePhi) ? sceneMetadata.capturePhi : FRONT_PHI,
		}
		let guide = null
		try { guide = (await captureWorldQuiet(renderer, scene, world, box, null, captureAngles)).guide }
		catch (error) { console.warn("capture restored yaw guide:", error) }
		const estimate = await estimateSceneYaw(splatBytes, sourcePrimitives, guide, captureAngles)
		yawDeg = estimate?.yawDeg ?? (Number.isFinite(sceneMetadata.yawDeg) ? sceneMetadata.yawDeg : sceneFit.yawDeg)
		mirrorZ = estimate?.mirrorZ ?? Boolean(sceneMetadata.mirrorZ)
	}

	await seatScene(splatBytes.slice(), box, { yawDeg, mirrorZ, yOffset: sceneFit.yOffset })
	sceneSplat = splatBytes
	sceneSession = { ...sceneMetadata, hasGround, yawDeg, mirrorZ }
	sceneImageBoxes = sceneSession.imageBoxes ?? null
	try { segmentSceneSplat(hasGround) }
	catch (error) { console.warn("segment restored scene:", error) }

	world.state = "generated"
	splatting = false // unlock the View gate before switching to it
	setUiTab("view")
	frameGeneratedSplats()
	applyOverlayVisibility()
	showProgress(1, 1, "Done")
	window.setTimeout(hideProgress, 1000)
}

// Load a primitives JSON file (from downloadPrimitives), replacing the current block-out
// and restoring the support links once every mesh exists. The user-facing input handler
// guards on the `generating` lock; applyPrimitives is the lock-free core so ZIP/history
// restores (which run UNDER that lock) can swap the block-out too — the guarded wrapper
// silently skipped the import there, leaving every restore without its primitives.
async function uploadPrimitives(file) {
	if (!file || generating) return
	await applyPrimitives(file)
}

// `staged: true` creates the meshes hidden so revealPrimitivesBottomUp can show them
// one at a time without a single fully-visible flash frame in between.
async function applyPrimitives(file, { staged = false } = {}) {
	if (!file) return
	let parsed
	try {
		parsed = JSON.parse(await file.text())
	} catch {
		setStatus("Invalid primitives file (not JSON)")
		return false
	}
	const prims = Array.isArray(parsed) ? parsed : parsed?.primitives
	if (!Array.isArray(prims)) {
		setStatus("No primitives found in file")
		return false
	}
	const hasGround = !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, "ground")
	let parsedGround = null
	if (hasGround) {
		try {
			parsedGround = validatedGroundPaintJson(parsed.ground)
		} catch (error) {
			setStatus(error.message || "Invalid ground paint data")
			return false
		}
	}

	buildRevealToken++ // stop any in-flight reveal before its meshes are swapped out
	world.resetGenerated() // back to an editable draft before swapping the block-out
	selectPrimitive(null)
	for (const mesh of [...world.primitives]) world.removePrimitive(mesh)

	// Pass 1: create every mesh (kept index-aligned with `prims`, null for bad entries).
	const created = prims.map(p => {
		if (!p?.type) return null
		const mesh = createPrimitive(p.type, `prim_${String(nextPrimitiveId++).padStart(3, "0")}`, {
			color: p.color,
			position: p.position,
			rotation: p.rotation,
			scale: p.scale,
			locked: p.locked,
		})
		mesh.userData.world = world
		if (staged) mesh.visible = false
		world.primitives.push(mesh)
		world.group.add(mesh)
		return mesh
	})

	// Pass 2: resolve support indices -> mesh refs now that all meshes exist.
	prims.forEach((p, i) => {
		const mesh = created[i]
		if (!mesh) return
		mesh.userData.support = Number.isInteger(p?.support) ? created[p.support] ?? null : null
		mesh.userData.supportAxis = p?.supportAxis ?? { name: "y", sign: 1 }
	})

	// Files that carry a ground key own the floor paint too. V4 stores editable strokes;
	// V3 image strings still load as an exact raster base for backward compatibility.
	if (hasGround) await applyGroundPaintData(parsedGround)

	syncWorldState()
	applyUiTab()
	persistFramesSoon()
	syncBuildGeometryJson(true)
	setStatus(`Loaded ${world.primitives.length} primitive${world.primitives.length === 1 ? "" : "s"}`)
	return true
}

function applyOverlayVisibility() {
	applyUiTab() // owns block-out vs splat visibility (incl. the colliders overlay in View)
	world.setBoundsVisible(showBounds)
}

// Capture the exact one-shot scene guide used by generation. This is intentionally not
// the current editor camera; it is the canonical image sent through the scene-wide
// texture edit and then to TripoSplat.
async function screenshotScene() {
	try {
		const cap = await captureWorldQuiet(renderer, scene, world, wholeSceneBox())
		downloadBlob(cap.guide, `scene-${Date.now()}.png`)
	} catch (err) {
		setStatus("Scene screenshot failed: " + (err.message || err))
	}
}

function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob)
	const a = document.createElement("a")
	a.href = url
	a.download = filename
	document.body.appendChild(a)
	a.click()
	a.remove()
	URL.revokeObjectURL(url)
}

// --- Build history ----------------------------------------------------------

let historyOpen = false

// Render the current scene to a small offscreen target and return a JPEG data URL for
// the history thumbnail. Independent of the live framebuffer (same render-to-target
// trick as screenshotScene). Returns "" on any failure — a thumb is never essential.
function captureThumb(maxW = 320) {
	try {
		const fullW = renderer.domElement.width
		const fullH = renderer.domElement.height
		if (!fullW || !fullH) return ""
		const scale = Math.min(1, maxW / fullW)
		const w = Math.max(1, Math.round(fullW * scale))
		const h = Math.max(1, Math.round(fullH * scale))
		const target = new THREE.WebGLRenderTarget(w, h)
		try {
			renderer.setRenderTarget(target)
			renderer.render(scene, camera)
			const pixels = new Uint8Array(w * h * 4)
			renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels)
			const canvas = document.createElement("canvas")
			canvas.width = w
			canvas.height = h
			const ctx = canvas.getContext("2d")
			const image = ctx.createImageData(w, h)
			for (let y = 0; y < h; y++) {
				const src = y * w * 4
				const dst = (h - y - 1) * w * 4 // GL reads bottom-up; flip to top-down
				image.data.set(pixels.subarray(src, src + w * 4), dst)
			}
			ctx.putImageData(image, 0, 0)
			return canvas.toDataURL("image/jpeg", 0.62)
		} finally {
			renderer.setRenderTarget(null)
			target.dispose()
		}
	} catch {
		return ""
	}
}

// Snapshot the just-completed build (block-out + pristine scene splat + prompt + a
// thumbnail) into persistent history. Best-effort: never blocks or breaks
// generation if storage fails. Fired (not awaited) from generateWorld.
async function saveBuildToHistory(prompt) {
	if (!sceneSplat || !sceneSession) return
	const thumb = captureThumb()
	const primitives = JSON.stringify(serializePrimitives())
	try {
		await addBuild({ prompt, thumb, scene: sceneSession, primitives, splat: sceneSplat })
		await refreshHistoryPanel()
	} catch (err) {
		console.warn("history save failed:", err.message || err)
	}
}

function relTime(ts) {
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
	if (s < 60) return "just now"
	const m = Math.round(s / 60)
	if (m < 60) return `${m}m ago`
	const h = Math.round(m / 60)
	if (h < 24) return `${h}h ago`
	return `${Math.round(h / 24)}d ago`
}

// Rebuild the history panel list from IndexedDB (newest first). Also keeps the count
// badge + empty-state in sync so it's right whether the panel is open or closed.
async function refreshHistoryPanel() {
	if (!els.historyList) return
	let builds = []
	try { builds = await listBuilds() } catch (err) { console.warn("history list failed:", err.message || err) }
	if (els.historyCount) els.historyCount.textContent = builds.length ? String(builds.length) : ""
	if (els.historyEmpty) els.historyEmpty.classList.toggle("hidden", builds.length > 0)
	els.historyList.replaceChildren()
	for (const b of builds) els.historyList.appendChild(historyItem(b))
}

function historyItem(b) {
	const item = document.createElement("div")
	item.className = "history-item"

	const thumbBtn = document.createElement("button")
	thumbBtn.className = "history-thumb"
	thumbBtn.title = "Restore this build"
	if (b.thumb) {
		const img = document.createElement("img")
		img.src = b.thumb
		img.alt = b.prompt || "build"
		thumbBtn.appendChild(img)
	} else {
		thumbBtn.textContent = "—"
	}
	thumbBtn.addEventListener("click", () => restoreBuild(b.id))

	const meta = document.createElement("button")
	meta.className = "history-meta"
	const title = document.createElement("div")
	title.className = "history-title"
	title.textContent = b.prompt?.trim() || "Untitled build"
	title.title = b.prompt || ""
	const sub = document.createElement("div")
	sub.className = "history-sub"
	sub.textContent = `one-shot · ${relTime(b.ts)}`
	meta.append(title, sub)
	meta.addEventListener("click", () => restoreBuild(b.id))

	const del = document.createElement("button")
	del.className = "history-del"
	del.title = "Delete this build"
	del.textContent = "×"
	del.addEventListener("click", async event => {
		event.stopPropagation()
		try { await deleteBuild(b.id) } catch (err) { console.warn(err) }
		await refreshHistoryPanel()
	})

	item.append(thumbBtn, meta, del)
	return item
}

// Restore a stored build: swap in its block-out and re-seat its scene splat from IndexedDB
// without regenerating. Replaces the current scene (same as ZIP re-fit).
async function restoreBuild(id) {
	if (generating) return
	let entry, splatBytes
	try {
		entry = (await listBuilds()).find(b => b.id === id)
		splatBytes = await getBuildSceneSplat(id)
	} catch {
		setStatus("Couldn't load that build")
		return
	}
	if (!entry || !splatBytes) { setStatus("That build is no longer available"); await refreshHistoryPanel(); return }
	generating = true
	splatting = true
	syncGenerateButton()
	setStatus("")
	try {
		// Accept metadata from one-shot entries saved before history was narrowed to one scene.
		const sceneMetadata = entry.scene ?? entry.subjects?.find(item => item.name === "scene" || item.kind === "scene")
		await applyStoredBuild({
			primitives: entry.primitives,
			sceneMetadata,
			splatBytes,
		})
		world.prompt = entry.prompt || ""
		if (els.chatPrompt) els.chatPrompt.value = world.prompt
		setStatus("Restored scene from history")
	} catch (err) {
		setStatus(err.message || "Restore failed")
		hideProgress()
	} finally {
		generating = false
		splatting = false
		syncGenerateButton()
	}
}

function toggleHistoryPanel(open) {
	historyOpen = open ?? !historyOpen
	if (historyOpen && els.settingsPopover) toggleSettings(false) // close settings so the two panels don't overlap
	els.historyPanel?.classList.toggle("hidden", !historyOpen)
	els.historyToggle?.classList.toggle("active", historyOpen)
	if (historyOpen) refreshHistoryPanel()
}

function toggleSettings(open) {
	const next = open ?? els.settingsPopover.classList.contains("hidden")
	els.settingsPopover.classList.toggle("hidden", !next)
	els.settingsBtn.setAttribute("aria-expanded", String(next))
}

// --- UI wiring --------------------------------------------------------------

for (const button of els.toolButtons) button.addEventListener("click", () => setActiveTool(button.dataset.tool))
for (const button of els.viewToolButtons) button.addEventListener("click", () => setViewTool(button.dataset.viewTool))
for (const button of els.viewTabs) button.addEventListener("click", () => setUiTab(button.dataset.viewTab))
els.frameAdd?.addEventListener("click", addFrameForActiveTab)

els.flyBtn?.addEventListener("click", enterFly)
els.shotAdd?.addEventListener("click", addCamShot)
els.shotPlay?.addEventListener("click", playCamPath)
els.shotExport?.addEventListener("click", exportCamPath)

els.status?.addEventListener("click", () => setStatus("")) // the error toast dismisses on click
renderPalette()
els.brushSlider.addEventListener("input", () => applyBrushScale(Number(els.brushSlider.value)))

els.addColor?.addEventListener("click", () => toggleColorPop())
bindPickerDrag(els.colorPopSv, (x, y) => { picker.s = x; picker.v = 1 - y })
bindPickerDrag(els.colorPopHue, x => { picker.h = x * 360 })
els.colorPopHex?.addEventListener("input", () => {
	const hex = normalizeHex(els.colorPopHex.value)
	if (!hex) return
	Object.assign(picker, hexToHsv(hex))
	syncPicker({ fromHex: true })
})
els.colorPopHex?.addEventListener("keydown", event => {
	if (event.key === "Enter") {
		event.preventDefault()
		els.colorPopAdd?.click()
	}
})
els.colorPopAdd?.addEventListener("click", () => {
	addPaletteColor(hsvToHex(picker))
	toggleColorPop(false)
})
// Click anywhere outside the picker closes it (the + button toggles it itself).
document.addEventListener("pointerdown", event => {
	if (!els.colorPop || els.colorPop.classList.contains("hidden")) return
	if (els.colorPop.contains(event.target) || els.addColor?.contains(event.target)) return
	toggleColorPop(false)
})

els.sceneShot?.addEventListener("click", async () => {
	try {
		await screenshotScene()
	} catch (error) {
		setStatus(error.message || "Floor screenshot failed")
	}
})

els.viewRawSplat?.addEventListener("change", async event => {
	toggleSettings(false)
	await viewRawSplat(event.target.files[0])
	event.target.value = "" // let the same file be re-selected
})

els.uploadSceneSplat?.addEventListener("change", async event => {
	await uploadSceneSplat(event.target.files[0])
	event.target.value = "" // let the same file be re-selected
})

els.downloadPrims?.addEventListener("click", downloadPrimitives)

els.uploadPrims?.addEventListener("change", async event => {
	await uploadPrimitives(event.target.files[0])
	event.target.value = "" // let the same file be re-selected
})

els.downloadZip?.addEventListener("click", downloadZip)

els.uploadZip?.addEventListener("change", async event => {
	await uploadZip(event.target.files[0])
	event.target.value = "" // let the same file be re-selected
})

els.showColliders?.addEventListener("change", () => {
	showColliders = els.showColliders.checked
	applyUiTab() // colliders overlay only means something in the View tab; Build already shows the block-out
	syncPlayColliderHelpers() // in Play it draws the player's voxel collision boxes instead
})

els.showBounds?.addEventListener("change", () => {
	showBounds = els.showBounds.checked
	world.setBoundsVisible(showBounds)
})

els.showSplatFloor?.addEventListener("change", () => {
	showSplatFloor = els.showSplatFloor.checked
	applyUiTab()
	world.setBoundsVisible(showBounds)
})

els.settingsBtn?.addEventListener("click", event => {
	event.stopPropagation() // don't let the document handler immediately re-close it
	toggleSettings()
})

document.addEventListener("click", event => {
	if (!els.settingsMenu?.contains(event.target)) toggleSettings(false)
})

document.addEventListener("keydown", event => {
	// Ctrl/Cmd+Z undoes, Ctrl+Y (or Ctrl/Cmd+Shift+Z) redoes the active Build frame.
	// Text inputs keep their native undo; View has nothing to undo.
	const key = event.key.toLowerCase()
	if ((event.ctrlKey || event.metaKey) && (key === "z" || key === "y")) {
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
		event.preventDefault()
		if (generating || drag) return
		const isRedo = key === "y" || event.shiftKey
		if (uiTab === "build") isRedo ? redoBuild() : undoBuild()
		return
	}
	if (!event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && (event.code === "Backquote" || event.key === "~")) {
		event.preventDefault()
		toggleDevControls()
		return
	}
	// "o" hides/shows every piece of UI at once (panels, rails, devtools — everything
	// except the canvas), for clean screenshots and recordings.
	if (!event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && key === "o") {
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target?.isContentEditable) return
		event.preventDefault()
		document.body.classList.toggle("hide-ui")
		return
	}
	if (event.key === "Escape") {
		const settingsOpen = !els.settingsPopover.classList.contains("hidden")
		if (els.colorPop && !els.colorPop.classList.contains("hidden")) toggleColorPop(false)
		else if (settingsOpen) toggleSettings(false)
		else if (camMode === "anim") stopCamPlayback()
		else if (uiTab === "play") setUiTab("view")
		else if (rawSplatPreview) {
			world.resetGenerated()
			setStatus("")
		}
		else if (uiTab === "view" && selectedSplatMeshes.size) deselectSplat()
	}
})

// Dev chrome (the camera bar and the Builds panel) appears only while the
// browser devtools are open. Docked devtools shrink the page's inner size
// against the window's outer size — the classic size-delta heuristic. An
// UNDOCKED devtools window is invisible to this check; dock it to get the
// dev chrome.
const applyDevtoolsChrome = () => {
	const open = window.outerWidth - window.innerWidth > 160 || window.outerHeight - window.innerHeight > 160
	document.body.classList.toggle("devtools-open", open)
}
applyDevtoolsChrome()
window.addEventListener("resize", applyDevtoolsChrome)
window.setInterval(applyDevtoolsChrome, 1000)

els.historyToggle?.addEventListener("click", () => toggleHistoryPanel())

els.historyClear?.addEventListener("click", async () => {
	try { await clearBuilds() } catch (err) { console.warn(err) }
	await refreshHistoryPanel()
})

els.historyClose?.addEventListener("click", () => toggleHistoryPanel(false))

// The chat bar has one job in whole-scene mode: splat the current Build in one shot.
els.chatForm.addEventListener("submit", event => {
	event.preventDefault()
	if (els.generate.disabled) return
	const prompt = els.chatPrompt.value.trim()
	generateWorld(prompt).catch(error => setStatus(error.message || "Could not start generation"))
})

els.hfSignOut?.addEventListener("click", () => {
	signOutHuggingFace()
	location.assign("/")
})

window.addEventListener("resize", () => {
	camera.aspect = window.innerWidth / window.innerHeight
	camera.updateProjectionMatrix()
	renderer.setPixelRatio(camMode === "play" ? 1 : Math.min(window.devicePixelRatio, 2)) // resize also fires when the window moves to a monitor with a different DPI
	renderer.setSize(window.innerWidth, window.innerHeight)
})

// The capture pipeline swaps LIVE scene materials (flat ID / semantic colours, edge
// lines, black clear) and awaits image encoding mid-swap; a single main-loop frame in
// that window paints the whole viewport in those colours — an ugly inverted flash on
// every generate. Hold the visible render while any capture is in flight: the last
// real frame simply persists on screen for the few hundred milliseconds it takes.
let worldCaptureDepth = 0

async function captureWorldQuiet(...args) {
	worldCaptureDepth++
	try {
		return await captureWorld(...args)
	} finally {
		worldCaptureDepth--
	}
}

let lastAnimateTime = performance.now()

function animate(now = performance.now()) {
	const dt = Math.min(0.05, (now - lastAnimateTime) / 1000) // clamp: a background tab must not teleport the fly camera
	lastAnimateTime = now
	syncBuildGeometryJson(false, now)
	if (camMode === "fly") updateFlyCamera(dt)
	else if (camMode === "anim") updateCamAnim(now)
	else if (camMode === "play") player.update(dt)
	sky.position.copy(camera.position)
	updateTransformGizmo()
	syncViewTransformOverlay()
	if (!worldCaptureDepth) renderer.render(scene, camera) // captures swap live materials — don't show them
	requestAnimationFrame(animate)
}

const runtimeConfig = await getConfig()
applyRuntimeConfig(runtimeConfig)
configureHuggingFace(runtimeConfig?.generation)

setActiveTool("pointer")
applyColor(activeColor)
applyBrushScale(activeBrushScale)
if (!(await restoreFramesState())) {
	// Nothing saved from an earlier session — seed two random checked-in default maps.
	try {
		await seedDefaultBuildFrames()
	} catch (error) {
		console.warn("Default build seed failed:", error)
		pushBuildFrame()
		snapshotActiveBuildFrame()
	}
}
applyUiTab()
updateCamera()
syncGenerateButton()
if (world.prompt) els.chatPrompt.value = world.prompt
refreshHistoryPanel() // populate the count badge from any builds saved in earlier sessions
requestAnimationFrame(animate)
