export function sceneGenerationPrompt(scene = "", { hasGeometryReference = false, hasStyleReference = false, hasGround = true } = {}) {
	const geometryReference = hasGeometryReference
		? `Image 1 is the render. Image 2 is an exactly aligned structural map. Use its artificial colors only for mass placement and scale; never copy those colors or appearance.`
		: `Image 1 is the render to transform and the authoritative spatial reference.`
	// The style guide is always the LAST image the route sends (after the
	// block-out and any geometry map), so "final input image" stays correct.
	const styleReference = hasStyleReference
		? `\n\nThe final input image is a STYLE guide: copy ONLY its rendering style, palette, and material finish. Never take subject matter, objects, architecture, layout, or camera from it — what things ARE comes from the scene description alone.`
		: ""
	const objectSource = hasGeometryReference ? "Image 2" : "Image 1"
	const description = String(scene || "A coherent richly detailed environment").trim()

	// Objects-only scenes (no painted floor): the flat-ground block and the
	// terrain-color line are meaningless, and the building-shaped deblockify
	// examples pull free-standing subjects toward architecture (the epic-robot-
	// became-a-village incident) — this variant drops both.
	if (!hasGround) {
		return `${geometryReference}

Transform this block-out into: ${description}.

Make sure to add NO new objects: Only objects should be ones outlined in ${objectSource}.

The blocks are rough massing stand-ins, not final shapes: resolve each one into the naturally-shaped thing it represents; creatures and machines get their organic or mechanical silhouettes — so nothing still reads as a plain box; keep each footprint and size.${styleReference}

Same camera, same composition, same proportions — every block becomes the full-sized real thing it stands for, exactly in place. Crisp realistic materials with visible construction detail. Never a miniature, toy, or diorama. Pure black background: every pixel outside the terrain chunk stays flat #000000.`
	}

	return `${geometryReference}

Transform this block-out into: ${description}.

Make sure to add NO new objects: Only objects should be ones outlined in ${objectSource}.

Make sure all ground and terrain stays absolutely flat, no bumps or hills or mounds.

FLAT GROUND
FLAT GROUND
FLAT GROUND
平坦地面
無坡度
無顛簸
平坦

The blocks are rough massing stand-ins, not final shapes: resolve each one into the naturally-shaped thing it represents — buildings get pitched roofs, eaves and overhangs; creatures and machines get their organic or mechanical silhouettes — so nothing still reads as a plain box; keep each footprint and size.${styleReference}

Same camera, same composition, same proportions — every block becomes the full-sized real thing it stands for, exactly in place, and painted ground colors become the terrain features they mark. Crisp realistic materials with visible construction detail. Never a miniature, toy, or diorama. Pure black background: every pixel outside the terrain chunk stays flat #000000.`
}
