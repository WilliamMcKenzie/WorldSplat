import { getConfig } from "./api.js"
import { configureBackend, restoreAccount } from "./backend.js"
import { mountGoogleSignIn } from "./google-auth.js"
const errorBox = document.getElementById("hero-error")
const button = document.getElementById("google_sign_in")
const openEditor = document.getElementById("open_editor")
const showError = error => { errorBox.textContent = error.message || "Could not sign in. Please try again."; errorBox.classList.remove("hidden") }
try {
 configureBackend(await getConfig())
 const account = await restoreAccount()
 if (account) { button.classList.add("hidden"); openEditor.classList.remove("hidden") }
 else await mountGoogleSignIn(button, {
  onSuccess: () => location.assign("/app/"),
  onError: showError,
  onBusy: busy => { button.setAttribute("aria-busy", String(busy)); if (busy) errorBox.classList.add("hidden") },
 })
} catch (error) { showError(error) }
