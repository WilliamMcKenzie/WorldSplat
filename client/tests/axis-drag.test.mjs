import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const source = await readFile(new URL("../scripts/axis-drag.js", import.meta.url), "utf8")
const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
const { closestAxisDistance } = await import(moduleURL)

const v = (x, y, z) => ({ x, y, z })
const normalized = (x, y, z) => {
	const length = Math.hypot(x, y, z)
	return v(x / length, y / length, z / length)
}

test("keeps an orthographic cursor ray locked to the grabbed axis point", () => {
	const distance = closestAxisDistance(
		v(2.75, 1, 5),
		v(0, 0, -1),
		v(0, 1, 0),
		v(1, 0, 0),
	)
	assert.ok(Math.abs(distance - 2.75) < 1e-9)
})

test("solves the grabbed point exactly for a perspective camera ray", () => {
	const distance = closestAxisDistance(
		v(0, 0, 5),
		normalized(3, 0, -5),
		v(0, 0, 0),
		v(1, 0, 0),
	)
	assert.ok(Math.abs(distance - 3) < 1e-9)
})

test("returns zero for the original ray through the grabbed point", () => {
	const distance = closestAxisDistance(
		v(4, 3, 8),
		normalized(-3, -2, -7),
		v(1, 1, 1),
		normalized(1, 1, 0),
	)
	assert.ok(Math.abs(distance) < 1e-9)
})

test("reports a parallel cursor ray so the editor can use its screen fallback", () => {
	assert.equal(closestAxisDistance(v(0, 0, 0), v(1, 0, 0), v(2, 1, 0), v(1, 0, 0)), null)
})
