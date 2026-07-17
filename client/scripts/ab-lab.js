import { getConfig } from "/scripts/api.js"
import { configureHuggingFaceAuth, getHuggingFaceAuth } from "/scripts/huggingface-auth.js"
import {
	buildSplatOnHuggingFace,
	configureHuggingFace,
	detailImageOnHuggingFace,
	imageStepUsesCredits,
} from "/scripts/huggingface.js"
import { promptPresets } from "/scripts/generation-prompt-presets.js"

const el = id => document.getElementById(id)

const runtimeConfig = await getConfig()
configureHuggingFace(runtimeConfig?.generation)
configureHuggingFaceAuth(runtimeConfig?.generation)
if (!getHuggingFaceAuth().signedIn) el("auth_warning").classList.remove("hidden")

let controller = null

for (const [container, textarea] of [["presets_a", "prompt_a"], ["presets_b", "prompt_b"]]) {
	for (const preset of promptPresets) {
		const button = document.createElement("button")
		button.className = "btn btn-ghost btn-xs"
		button.textContent = preset.label
		button.title = `Fill with the ${preset.label} prompt`
		button.addEventListener("click", () => {
			const hasGeometryReference = Boolean(el("geometry_image").files[0])
			el(textarea).value = preset.build(el("scene_text").value, { hasGeometryReference })
		})
		el(container).append(button)
	}
}

function parseSeeds(text) {
	const seeds = text.split(/[\s,]+/).map(Number).filter(n => Number.isInteger(n) && n >= 0)
	return seeds.length ? seeds : [101]
}

function setStatus(text) {
	el("status_line").textContent = text
}

function download(blob, name) {
	const link = document.createElement("a")
	link.href = URL.createObjectURL(blob)
	link.download = name
	link.click()
	setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
}

function addResultCard({ variant, seed, blob, viaCredits = false }) {
	const card = document.createElement("div")
	card.className = "card bg-base-100 border border-base-300 shadow"
	const url = URL.createObjectURL(blob)
	// Tag each cell with its route — Space and credits cells must not be compared.
	const route = viaCredits ? " · credits" : ""
	card.innerHTML = `
		<figure><img class="result-img" src="${url}" alt="Prompt ${variant} seed ${seed}"></figure>
		<div class="card-body p-3 flex-row items-center justify-between">
			<span class="font-semibold text-sm">Prompt ${variant} · seed ${seed}${route}</span>
			<div class="flex gap-2">
				<button class="btn btn-ghost btn-xs" data-save>Save PNG</button>
				<button class="btn btn-outline btn-xs" data-splat>Build splat</button>
			</div>
		</div>`
	card.querySelector("[data-save]").addEventListener("click", () => download(blob, `ab-${variant}-${seed}.png`))
	card.querySelector("[data-splat]").addEventListener("click", async event => {
		const button = event.currentTarget
		button.disabled = true
		try {
			const bytes = await buildSplatOnHuggingFace({
				image: blob,
				seed,
				onProgress: (fraction, label) => setStatus(`Splat ${variant}·${seed}: ${label}`),
			})
			download(new Blob([bytes]), `ab-${variant}-${seed}.splat`)
			setStatus(`Splat ${variant}·${seed} downloaded — rename to obj-001.splat or floor.splat to seat it in the app`)
		} catch (error) {
			setStatus(String(error?.message || error))
		} finally {
			button.disabled = false
		}
	})
	el("results").append(card)
}

async function run() {
	const image = el("input_image").files[0]
	if (!image) return setStatus("Pick a block-out image first")
	const geometryImage = el("geometry_image").files[0] ?? null
	// Style reference: sent as an extra input image (fal multi-image queue on the
	// credits route, extra gallery image on multi-image Spaces). The model only
	// copies its art style if the prompt says so — the presets don't.
	const styleImage = el("style_image").files[0] ?? null
	const variants = [
		{ variant: "A", prompt: el("prompt_a").value.trim() },
		{ variant: "B", prompt: el("prompt_b").value.trim() },
	].filter(entry => entry.prompt)
	if (!variants.length) return setStatus("Fill in at least Prompt A")
	const seeds = parseSeeds(el("seeds_input").value)

	controller = new AbortController()
	el("run_btn").disabled = true
	el("cancel_btn").classList.remove("hidden")
	el("results").replaceChildren()
	const total = seeds.length * variants.length
	let done = 0
	try {
		for (const seed of seeds) {
			for (const { variant, prompt } of variants) {
				setStatus(`Running ${done + 1}/${total} — Prompt ${variant} · seed ${seed}…`)
				// The image route always follows the live app's config (inference
				// credits by default), so A/B verdicts transfer 1:1 to production.
				// Compare cells only within one route: seeds do not reproduce
				// across backends.
				const viaCredits = imageStepUsesCredits()
				const blob = await detailImageOnHuggingFace({
					prompt,
					image,
					geometryImage,
					styleImage,
					seed,
					signal: controller.signal,
					onProgress: (fraction, label) => setStatus(`${done + 1}/${total} — ${variant}·${seed}: ${label}`),
				})
				addResultCard({ variant, seed, blob, viaCredits })
				done += 1
			}
		}
		setStatus(`Done — ${done}/${total} images`)
	} catch (error) {
		setStatus(error?.name === "AbortError" ? `Cancelled after ${done}/${total}` : String(error?.message || error))
	} finally {
		el("run_btn").disabled = false
		el("cancel_btn").classList.add("hidden")
		controller = null
	}
}

el("run_btn").addEventListener("click", run)
el("cancel_btn").addEventListener("click", () => controller?.abort())
