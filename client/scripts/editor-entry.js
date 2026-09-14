import { getConfig } from "./api.js"
import { configureBackend, restoreAccount, onAccountChange } from "./backend.js"
const startup = document.getElementById("editor_startup")
try {
 configureBackend(await getConfig())
 const user = await restoreAccount()
 if (!user) location.replace("/")
 else {
  onAccountChange(account => { if (!account) location.replace("/") })
  await import("/scripts/renderer.js?v=google-tabs-1")
  startup.remove()
 }
} catch (error) {
 console.error("Editor startup failed:", error)
 startup.querySelector("p").textContent = error.message || "Your workspace could not load. Please reload."
 startup.querySelector("button").classList.remove("hidden")
}
