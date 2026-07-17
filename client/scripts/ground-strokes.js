export function cloneGroundStrokes(strokes = []) {
	return strokes.map(stroke => ({
		mode: stroke.mode === "erase" ? "erase" : "paint",
		color: stroke.color,
		radius: stroke.radius,
		closed: stroke.mode !== "erase" && stroke.closed === true,
		points: stroke.points.map(point => [point[0], point[1]]),
	}))
}

export function closeGroundStroke(stroke) {
	if (!stroke || stroke.mode === "erase" || stroke.points.length < 3) return false
	stroke.closed = true
	return true
}

export function paintGroundStroke(ctx, canvas, stroke, worldSize) {
	if (!stroke?.points?.length) return
	const half = worldSize / 2
	const toCanvas = point => [
		((point[0] + half) / worldSize) * canvas.width,
		((point[1] + half) / worldSize) * canvas.height,
	]
	const radius = Math.max(0.001, stroke.radius) * (canvas.width / worldSize)

	ctx.save()
	ctx.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over"
	ctx.fillStyle = stroke.color
	ctx.strokeStyle = stroke.color
	ctx.lineWidth = radius * 2
	ctx.lineCap = "round"
	ctx.lineJoin = "round"

	if (stroke.points.length === 1) {
		const [x, y] = toCanvas(stroke.points[0])
		ctx.beginPath()
		ctx.arc(x, y, radius, 0, Math.PI * 2)
		ctx.fill()
	} else {
		const [x0, y0] = toCanvas(stroke.points[0])
		ctx.beginPath()
		ctx.moveTo(x0, y0)
		for (let i = 1; i < stroke.points.length; i++) {
			const [x, y] = toCanvas(stroke.points[i])
			ctx.lineTo(x, y)
		}
		if (stroke.closed && stroke.mode !== "erase" && stroke.points.length >= 3) {
			ctx.closePath()
			ctx.fill()
		}
		ctx.stroke()
	}
	ctx.restore()
}
