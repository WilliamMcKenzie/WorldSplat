function dot(a, b) {
	return a.x * b.x + a.y * b.y + a.z * b.z
}

// Signed world-space distance from axisPoint to the point on an infinite axis line
// closest to the cursor ray. This removes pixel sensitivity from face dragging: the
// grabbed point is solved against the live camera ray on every pointer event.
export function closestAxisDistance(rayOrigin, rayDirection, axisPoint, axisDirection) {
	const wx = axisPoint.x - rayOrigin.x
	const wy = axisPoint.y - rayOrigin.y
	const wz = axisPoint.z - rayOrigin.z
	const axisLengthSq = dot(axisDirection, axisDirection)
	const rayLengthSq = dot(rayDirection, rayDirection)
	const crossDot = dot(axisDirection, rayDirection)
	const denominator = axisLengthSq * rayLengthSq - crossDot * crossDot
	if (denominator <= 1e-8 * axisLengthSq * rayLengthSq) return null

	const axisToOrigin = axisDirection.x * wx + axisDirection.y * wy + axisDirection.z * wz
	const rayToOrigin = rayDirection.x * wx + rayDirection.y * wy + rayDirection.z * wz
	const distance = (crossDot * rayToOrigin - rayLengthSq * axisToOrigin) / denominator
	return Number.isFinite(distance) ? distance : null
}
