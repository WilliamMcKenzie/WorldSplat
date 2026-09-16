import assert from "node:assert/strict"
import test from "node:test"

import { cloneGroundStrokes, closeGroundStroke, paintGroundStroke, scribbleBoundary } from "../scripts/ground-strokes.js"

const box = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
const scribble = [[2, 2], [8, 3], [2, 4], [8, 5]]
const paint = points => ({ mode: "paint", color: "#587553", radius: 1, points })

function recordingContext() {
	const calls = []
	const ctx = { calls }
	for (const method of ["save", "restore", "beginPath", "moveTo", "lineTo", "closePath", "fill", "stroke", "arc"]) {
		ctx[method] = (...args) => calls.push([method, ...args])
	}
	return ctx
}

test("one closed boundary followed by an interior scribble fills on release", () => {
	const stroke = paint([...box, ...scribble])
	assert.equal(stroke.closed, undefined)
	assert.equal(closeGroundStroke(stroke), true)
	assert.deepEqual(scribbleBoundary(stroke), box)

	const ctx = recordingContext()
	paintGroundStroke(ctx, { width: 100, height: 100 }, stroke, 10)
	const methods = ctx.calls.map(call => call[0])
	assert.ok(methods.includes("closePath"))
	assert.ok(methods.includes("fill"))
	assert.equal(methods.filter(method => method === "fill").length, 2)
	assert.equal(ctx.globalCompositeOperation, "source-over")
})

test("open outlines, bare closed loops, and a single interior line do not fill", () => {
	for (const points of [box.slice(0, -1), box, [...box, [2, 2], [8, 8]], [...box.slice(0, -1), [0, 4], [3, 4], [8, 5], [3, 6], [8, 7]]]) {
		assert.equal(closeGroundStroke(paint(points)), false)
	}
})

test("two separate gestures cannot combine into a fill", () => {
	assert.equal(closeGroundStroke(paint(box)), false)
	assert.equal(closeGroundStroke(paint(scribble)), false)
})

test("an actual boundary crossing closes a loop without snapping endpoints", () => {
	const points = [[0, 0], [10, 0], [10, 10], [-1, 10], [-1, -1], [2, 2], ...scribble]
	assert.equal(closeGroundStroke(paint(points)), true)
	assert.equal(closeGroundStroke(paint([...box.slice(0, -1), [0.2, -0.2], ...scribble])), true)
})

test("tiny jitter, small loops, and scribbles outside the boundary do not fill", () => {
	const jitter = [[4, 4], [4.1, 4.1], [4, 4.2], [4.1, 4.3]]
	assert.equal(closeGroundStroke(paint([...box, ...jitter])), false)
	assert.equal(closeGroundStroke(paint([...box, [12, 2], [18, 3], [12, 4], [18, 5]])), false)
	assert.equal(closeGroundStroke(paint([...box, ...scribble].map(([x, y]) => [x / 10, y / 10]))), false)
})

test("visible brush overlap closes the boundary even when centerlines miss", () => {
	assert.equal(closeGroundStroke(paint([...box.slice(0, -1), [0, 0.5], ...scribble])), true)
})

test("an interior scribble still fills after briefly overshooting the outline", () => {
	assert.equal(closeGroundStroke(paint([...box, ...scribble, [12, 5]])), true)
	const loop = Array.from({length: 81}, (_, i) => [10 * Math.cos(i * Math.PI / 40), 10 * Math.sin(i * Math.PI / 40)])
	const hatch = [[6, -4], [5, 12], [4, -6], [2, 8], [0, -8], [-2, 8], [-4, -6]]
	assert.equal(closeGroundStroke(paint([...loop, ...hatch])), true)
})

test("scribble segments cannot cross outside a concave boundary", () => {
	const concave = [[0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10], [0, 0]]
	assert.equal(closeGroundStroke(paint([...concave, [1, 5], [9, 5], [1, 6], [9, 6]])), false)
})

test("recognition survives dense pointer sampling and serialization", () => {
	const points = [...box, ...scribble]
	const dense = points.flatMap((point, i) => i ? Array.from({length: 20}, (_, j) => point.map((v, axis) => points[i - 1][axis] + (v - points[i - 1][axis]) * (j + 1) / 20)) : [point])
	const stroke = paint(dense)
	assert.equal(closeGroundStroke(stroke), true)
	const restored = cloneGroundStrokes(JSON.parse(JSON.stringify([stroke])))[0]
	assert.deepEqual(scribbleBoundary(restored), scribbleBoundary(stroke))
})

test("eraser gestures remain open correction strokes", () => {
	const stroke = {
		mode: "erase",
		color: "#587553",
		radius: 1,
		points: [[-2, -2], [2, -2], [2, 2]],
	}
	assert.equal(closeGroundStroke(stroke), false)
	assert.equal(closeGroundStroke({ ...paint([...box, ...scribble]), mode: "erase" }), false)

	const ctx = recordingContext()
	paintGroundStroke(ctx, { width: 100, height: 100 }, stroke, 10)
	assert.equal(ctx.calls.filter(call => call[0] === "fill").length, 1)
	assert.equal(ctx.globalCompositeOperation, "destination-out")
})

test("closed state survives ground serialization", () => {
	const source = [{
		mode: "paint",
		color: "#587553",
		radius: 1,
		closed: true,
		points: [[0, 0], [1, 0], [1, 1]],
	}]
	const cloned = cloneGroundStrokes(source)
	assert.equal(cloned[0].closed, true)
	assert.notEqual(cloned[0].points, source[0].points)
	assert.notEqual(cloned[0].points[0], source[0].points[0])
})
