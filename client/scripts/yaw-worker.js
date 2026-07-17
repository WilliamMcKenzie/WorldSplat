// Web Worker wrapper for the scene yaw/mirror estimator. The heavy candidate sweep runs
// here so the UI thread never freezes during "Analyzing the 3D scene…". One job at a
// time (renderer serializes posts); any thrown error is reported back as { error }.
import { estimateYawFromData } from "/scripts/yaw-core.js?v=yaw-1"

self.onmessage = event => {
	let result = null
	try {
		result = estimateYawFromData(event.data)
	} catch (error) {
		result = { error: String(error?.message ?? error) }
	}
	self.postMessage(result)
}
