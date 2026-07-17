function formatSeconds(value) {
	const total = Math.max(0, Math.round(Number(value)))
	if (total < 60) return `${total} second${total === 1 ? "" : "s"}`
	const minutes = Math.floor(total / 60)
	const seconds = total % 60
	const minuteText = `${minutes} minute${minutes === 1 ? "" : "s"}`
	return seconds ? `${minuteText} ${seconds} second${seconds === 1 ? "" : "s"}` : minuteText
}

function retrySentence(message) {
	const match = message.match(/try again in\s+([^\n.]+)/i)
	return match ? ` You can try again in ${match[1].trim()}.` : ""
}

function providerDetails(message) {
	return ` Hugging Face details: ${message}`
}

export function friendlyHuggingFaceError(error, {
	useInferenceCredits = false,
	inferenceTask = "the inference-credit image step",
} = {}) {
	const message = String(error?.message || error || "Generation failed")
	if (/requested GPU duration.*larger than the maximum allowed/i.test(message)) {
		const requested = message.match(/requested GPU duration\s*\(\s*(\d+(?:\.\d+)?)s\s*\)/i)?.[1]
		const amount = requested ? ` ${formatSeconds(requested)}` : " a longer GPU session"
		return new Error(`This Space requests${amount} for one GPU run, which is above your account's per-run limit. Choose a Space with a shorter reservation.${providerDetails(message)}`)
	}
	if (/gpu task aborted/i.test(message)) {
		return new Error(`Hugging Face stopped the model before it finished. The failed run may still have used GPU time; check your ZeroGPU usage before trying again.${providerDetails(message)}`)
	}

	const reservation = message.match(/(\d+(?:\.\d+)?)s\s+requested\s+vs\.?\s*(\d+(?:\.\d+)?)s\s+left/i)
	if (reservation) {
		const requested = formatSeconds(reservation[1])
		const remaining = formatSeconds(reservation[2])
		return new Error(`Hugging Face declined this GPU reservation. This Space requested ${requested}, but your account had ${remaining} remaining.${retrySentence(message)}${providerDetails(message)}`)
	}

	if (/daily.*(?:run|task).*(?:cap|limit|exceed)|runs?.*per.*day|too many.*gpu.*(?:job|task)/i.test(message)) {
		return new Error(`Hugging Face declined this GPU job because your account's daily run limit was reached.${retrySentence(message)}${providerDetails(message)}`)
	}
	if (useInferenceCredits && /inference.*(?:permission|scope)|missing.*inference-api|(?:^|\D)(?:401|403)(?:\D|$)/i.test(message)) {
		return new Error(`Hugging Face did not allow ${inferenceTask}. Sign out and sign in again so WorldSketch can request the inference-api permission.${providerDetails(message)}`)
	}
	if (useInferenceCredits && /inference.*credit|monthly.*credit|insufficient.*credit|payment required|(?:^|\D)402(?:\D|$)/i.test(message)) {
		return new Error(`Hugging Face could not run ${inferenceTask}. Check your monthly inference credit or billing settings.${providerDetails(message)}`)
	}

	if (/quota|gpu.?time|exceeded.*usage/i.test(message)) {
		return new Error(`Hugging Face declined this GPU job. Your account may have hit its daily run limit, a previous reservation may still be counted, or less GPU time may remain than this Space requests.${retrySentence(message)}${providerDetails(message)}`)
	}
	if (/space.*(sleep|unavailable|not found)|503|502/i.test(message)) {
		return new Error("A required Hugging Face Space is unavailable right now. Please try again later.")
	}
	return error instanceof Error ? error : new Error(message)
}
