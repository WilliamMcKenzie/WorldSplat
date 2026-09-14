import { backendConfig, loginWithGoogle } from "./backend.js"
let sdkPromise
export function loadGoogleIdentity() {
 if (globalThis.google?.accounts?.id) return Promise.resolve(globalThis.google.accounts.id)
 if (!sdkPromise) sdkPromise = new Promise((resolve, reject) => {
  const script = document.createElement("script")
  script.src = "https://accounts.google.com/gsi/client"
  script.async = true
  const timeout = setTimeout(() => reject(new Error("Google sign-in could not load. Check your connection or content blocker, then reload.")), 15000)
  script.onload = () => { clearTimeout(timeout); globalThis.google?.accounts?.id ? resolve(google.accounts.id) : reject(new Error("Google sign-in is unavailable.")) }
  script.onerror = () => { clearTimeout(timeout); reject(new Error("Google sign-in could not load. Please reload.")) }
  document.head.append(script)
 }).catch(error => { sdkPromise = null; throw error })
 return sdkPromise
}
export async function mountGoogleSignIn(element, { onSuccess, onError, onBusy = () => {} }) {
 const config = backendConfig()
 if (!config?.googleClientId) throw new Error("Google sign-in is not configured yet.")
 const identity = await loadGoogleIdentity()
 let busy = false
 identity.initialize({
  client_id: config.googleClientId,
  ux_mode: "popup",
  auto_select: false,
  callback: async response => {
   if (busy) return
   busy = true; onBusy(true)
   try { if (!response.credential) throw new Error("Google did not return a sign-in credential."); const user = await loginWithGoogle(response.credential); await onSuccess(user) }
   catch (error) { onError(error) }
   finally { busy = false; onBusy(false) }
  },
 })
 element.replaceChildren()
 identity.renderButton(element, { type: "standard", theme: "filled_black", size: "large", text: "signin_with", shape: "rectangular", width: 280 })
}
