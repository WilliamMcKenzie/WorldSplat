import { getConfig } from "./api.js"
import { configureBackend, restoreAccount } from "./backend.js"
try {
 configureBackend(await getConfig())
 await restoreAccount()
} catch (error) {
 console.warn("Account unavailable:", error)
}
await import("/scripts/renderer.js?v=canvas-examples-2")
