import { getStrokePoints, getStrokeOutlinePoints } from "../lib/perfect-freehand-1.2.3.js"

export function cloneGroundStrokes(strokes = []) {
	return strokes.map(stroke => ({
		mode: stroke.mode === "erase" ? "erase" : "paint",
		color: stroke.color,
		radius: stroke.radius,
		closed: stroke.mode !== "erase" && stroke.closed === true,
		points: stroke.points.map(point => [point[0], point[1]]),
	}))
}

function intersection(a, b, c, d) {
	const cross = (x, y) => x[0] * y[1] - x[1] * y[0]
	const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]]
	const denominator = cross(r, s)
	if (Math.abs(denominator) < 1e-10) return null
	const offset = [c[0] - a[0], c[1] - a[1]]
	const t = cross(offset, s) / denominator, u = cross(offset, r) / denominator
	return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { point: [a[0] + t * r[0], a[1] + t * r[1]], t } : null
}

function closestPoint(point, a, b) {
	const dx = b[0] - a[0], dy = b[1] - a[1]
	const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
	return [a[0] + t * dx, a[1] + t * dy]
}

function brushContact(a, b, c, d, radius) {
	const crossing = intersection(a, b, c, d)
	if (crossing) return { start: crossing.point }
	const pairs = [[closestPoint(a, c, d), a], [closestPoint(b, c, d), b], [c, closestPoint(c, a, b)], [d, closestPoint(d, a, b)]]
	const distance = ([p, q]) => Math.hypot(p[0] - q[0], p[1] - q[1])
	pairs.sort((p, q) => distance(p) - distance(q))
	return distance(pairs[0]) <= radius * 2 ? { start: pairs[0][0], end: pairs[0][1] } : null
}

function inside(point, polygon) {
	let result = false
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i], b = polygon[j]
		if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result
	}
	return result
}

function reversals(points, axis, distance) {
	let extreme = points[0][axis], direction = 0, count = 0
	for (const point of points.slice(1)) {
		const delta = point[axis] - extreme
		if (direction && delta * direction > 0) extreme = point[axis]
		else if (Math.abs(delta) >= distance) {
			if (direction) count++
			direction = Math.sign(delta)
			extreme = point[axis]
		}
	}
	return count
}

function interiorScribble(points, polygon, distance) {
	const interior = []
	let totalLength = 0, interiorLength = 0
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1], b = points[i]
		const length = Math.hypot(b[0] - a[0], b[1] - a[1])
		const at = t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
		const cuts = [0, 1]
		for (let edge = 1; edge < polygon.length; edge++) {
			const hit = intersection(a, b, polygon[edge - 1], polygon[edge])
			if (hit) cuts.push(hit.t)
		}
		cuts.sort((a, b) => a - b)
		totalLength += length
		for (let k = 1; k < cuts.length; k++) {
			if (cuts[k] === cuts[k - 1] || !inside(at((cuts[k] + cuts[k - 1]) / 2), polygon)) continue
			interiorLength += length * (cuts[k] - cuts[k - 1])
			interior.push(at(cuts[k - 1]), at(cuts[k]))
		}
	}
	return interiorLength >= distance * 4 && interiorLength >= totalLength * 0.65
		&& Math.max(reversals(interior, 0, distance), reversals(interior, 1, distance)) >= 2
}

// Closure means the painted brush overlaps itself; a mostly interior scribble
// can overshoot the border without cancelling the fill. Only this gesture counts.
export function scribbleBoundary(stroke) {
	if (!stroke || stroke.mode === "erase") return null
	const { points, radius } = stroke
	for (let i = 2; i < points.length - 1; i++) {
		for (let j = 0; j < i - 1; j++) {
			const hit = brushContact(points[i], points[i + 1], points[j], points[j + 1], radius)
			if (!hit) continue
			const polygon = [hit.start, ...points.slice(j + 1, i + 1), ...(hit.end ? [hit.end] : []), hit.start]
			const area = Math.abs(polygon.slice(1).reduce((sum, p, k) => sum + polygon[k][0] * p[1] - p[0] * polygon[k][1], 0)) / 2
			if (area < 16 * radius * radius) continue
			const tail = points.slice(i + 1)
			const distance = Math.max(radius * 2, Math.sqrt(area) * 0.15)
			if (interiorScribble(tail, polygon, distance)) return polygon
		}
	}
	return null
}

export function closeGroundStroke(stroke) {
	if (!stroke) return false
	stroke.closed = Boolean(scribbleBoundary(stroke))
	return stroke.closed
}

export function paintGroundStroke(ctx, canvas, stroke, worldSize) {
	if (!stroke?.points?.length) return
	const half = worldSize / 2
	const toCanvas = point => [
		((point[0] + half) / worldSize) * canvas.width,
		((point[1] + half) / worldSize) * canvas.height,
	]
	const radius = Math.max(0.001, stroke.radius) * (canvas.width / worldSize)
	const closed = stroke.closed && stroke.mode !== "erase" && stroke.points.length >= 3
	const boundary = closed ? scribbleBoundary(stroke) : null
	const points = stroke.points.map(toCanvas)
	if (closed && !boundary) points.push(points[0]) // preserve previously saved filled shapes
	const options = { size: radius * 2, thinning: 0, smoothing: 0.5, streamline: 0.5, last: true }
	const smoothed = getStrokePoints(points, options)
	const outline = getStrokeOutlinePoints(smoothed, options)
	const fill = boundary ? getStrokePoints(boundary.map(toCanvas), options).map(p => p.point) : smoothed.map(p => p.point)

	ctx.save()
	ctx.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over"
	ctx.fillStyle = stroke.color
	for (const polygon of closed ? [fill, outline] : [outline]) {
		ctx.beginPath()
		ctx.moveTo(...polygon[0])
		for (const point of polygon.slice(1)) ctx.lineTo(...point)
		ctx.closePath()
		ctx.fill()
	}
	ctx.restore()
}
