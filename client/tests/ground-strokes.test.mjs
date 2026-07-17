import assert from "node:assert/strict"
import test from "node:test"

import { cloneGroundStrokes, closeGroundStroke, paintGroundStroke } from "../scripts/ground-strokes.js"

function recordingContext() {
	const calls = []
	const ctx = { calls }
	for (const method of ["save", "restore", "beginPath", "moveTo", "lineTo", "closePath", "fill", "stroke", "arc"]) {
		ctx[method] = (...args) => calls.push([method, ...args])
	}
	return ctx
}

test("paint gestures close into filled floor polygons", () => {
	const stroke = {
		mode: "paint",
		color: "#587553",
		radius: 1,
		points: [[-2, -2], [2, -2], [2, 2], [-2, 2]],
	}
	assert.equal(closeGroundStroke(stroke), true)

	const ctx = recordingContext()
	paintGroundStroke(ctx, { width: 100, height: 100 }, stroke, 10)
	const methods = ctx.calls.map(call => call[0])
	assert.ok(methods.includes("closePath"))
	assert.ok(methods.includes("fill"))
	assert.ok(methods.includes("stroke"))
	assert.ok(methods.indexOf("fill") < methods.indexOf("stroke"))
})

test("eraser gestures remain open correction strokes", () => {
	const stroke = {
		mode: "erase",
		color: "#587553",
		radius: 1,
		points: [[-2, -2], [2, -2], [2, 2]],
	}
	assert.equal(closeGroundStroke(stroke), false)

	const ctx = recordingContext()
	paintGroundStroke(ctx, { width: 100, height: 100 }, stroke, 10)
	assert.equal(ctx.calls.some(call => call[0] === "closePath"), false)
	assert.equal(ctx.calls.some(call => call[0] === "fill"), false)
	assert.equal(ctx.calls.some(call => call[0] === "stroke"), true)
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
