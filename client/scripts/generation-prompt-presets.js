import { sceneGenerationPrompt } from "/scripts/generation-prompt.js?v=no-floor-1"

function geometryLine(hasGeometryReference) {
	return hasGeometryReference
		? `Image 1 is the render. Image 2 is an exactly aligned structural map. Use its artificial colors only for mass placement and scale; never copy those colors or appearance.`
		: `Image 1 is the render to transform and the authoritative spatial reference.`
}

function sceneText(scene) {
	return String(scene || "A coherent richly detailed environment").trim()
}

// Candidate prompts for A/B testing. "Current" is the live pipeline prompt (the
// minimal variant, which won the 2026-07-15 round). This round attacks the
// opposite failure: outputs staying BLOCKY with flat placeholder textures —
// the model preserves the block-out's shading instead of resolving it into
// real materials. Each candidate uses a different lever to force realism;
// all keep the settled constraints (no new objects, flat ground, hue
// preservation from the color round, black void, full scale).
// The 2026-07-15 color candidates were retired after that round's verdict —
// see git history if they're ever needed again.
export const promptPresets = [
	{
		key: "current",
		label: "Current",
		build: (scene, opts) => sceneGenerationPrompt(scene, opts),
	},
	{
		// Lever: reframe the OUTPUT MEDIUM — a photograph cannot contain flat
		// placeholder shading, so the model must resolve every surface.
		key: "photograph",
		label: "Photograph",
		build: (scene, { hasGeometryReference = false } = {}) => `${geometryLine(hasGeometryReference)}

Transform this block-out into: ${sceneText(scene)}.

The output is a PHOTOGRAPH of the real, finished place — not a render, not a model, not a diorama. Every flat placeholder surface must become a physically real material: stone with mortar lines and chipped edges, wood with grain and splits, metal with scratches and dulled reflections, ground with packed dirt, gravel and wear paths. Keep each region's original hue while realizing it as a real material. Add no new objects; same camera, composition and proportions at full architectural scale; the ground stays perfectly flat. Every pixel outside the terrain chunk stays flat black (#000000).`,
	},
	{
		// Lever: name the JOB — a material pass with an explicit failure
		// condition ("zero flat surfaces survive") the model can check itself.
		key: "material-pass",
		label: "Material pass",
		build: (scene, { hasGeometryReference = false } = {}) => `Transform this block-out into: ${sceneText(scene)}.

${geometryLine(hasGeometryReference)}

This is a MATERIAL PASS, and its rule is absolute: zero flat, untextured or single-color surfaces may survive into the output. Assign every block and every painted ground region a specific real-world material, then render that material's micro-detail — grain, seams, joints, weathering streaks, edge wear, and subtle tonal variation inside the region's own hue. Interpret each block as the full structure it stands for. Add no new objects; keep the camera, layout and proportions unchanged at real-world scale; the ground stays perfectly flat; flat black (#000000) beyond the terrain chunk.`,
	},
	{
		// Lever: demote the INPUT — declare the block-out's shading disposable
		// so preserving it reads as failure, and grant bold reinterpretation
		// within each footprint.
		key: "replace-all",
		label: "Replace all",
		build: (scene, { hasGeometryReference = false } = {}) => `${geometryLine(hasGeometryReference)}

The block-out is only a massing model: its flat shading and blocky surfaces are placeholders, and NONE of them may survive into the output. Rebuild the scene as the real place it represents — ${sceneText(scene)} — with every surface resolved into believable, worn, textured reality. Reinterpret boldly within each footprint: facades, roofing, trim, doors and windows, ground treatment. Move nothing and add no new objects. Keep each region's hue, the exact camera, composition and proportions at full scale, and a perfectly flat ground. Flat black (#000000) outside the terrain chunk.`,
	},
	{
		// Lever: match the DOWNSTREAM AESTHETIC — a photogrammetry scan is what
		// a good gaussian splat looks like, so aim the image model straight at it.
		key: "photogrammetry",
		label: "3D scan",
		build: (scene, { hasGeometryReference = false } = {}) => `${geometryLine(hasGeometryReference)}

Transform this block-out into: ${sceneText(scene)}.

Render it as a photogrammetry capture of a real location: dense photographic surface detail everywhere, natural sunlight with soft shadows, true-to-life materials showing wear, dirt and age — nothing stylized, smoothed or toy-like. Every placeholder surface becomes scanned reality in its original hue. Add no new objects; same camera, composition and proportions at real-world scale; the ground stays perfectly flat; every pixel beyond the terrain chunk is flat black (#000000).`,
	},
]
