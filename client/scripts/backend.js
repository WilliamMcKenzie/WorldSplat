// Account data lives on the backend. Only the revocable bearer is stored locally.
export const SESSION_KEY = "worldsplat.session"
let configuration = null
let currentUser = null
const listeners = new Set()
export class APIError extends Error {
 constructor(message, status) { super(message); this.name = "APIError"; this.status = status }
}
export function configureBackend(config) {
 const backend = config?.backend
 if (!backend || typeof backend.googleClientId !== "string") throw new Error("WorldSplat could not load its sign-in settings. Please reload.")
 const url = new URL(backend.apiBaseURL || location.origin)
 if (url.origin !== location.origin && url.protocol !== "https:") throw new Error("The backend must use HTTPS.")
 configuration = { ...backend, apiBaseURL: url.origin }
 return configuration
}
export function backendConfig() { return configuration }
export function sessionToken() { try { return localStorage.getItem(SESSION_KEY) || "" } catch { return "" } }
export function getAccount() { return currentUser }
export function onAccountChange(callback) { listeners.add(callback); return () => listeners.delete(callback) }
function publish(user) { currentUser = user; for (const callback of listeners) callback(user) }
export function clearSession() { try { localStorage.removeItem(SESSION_KEY) } catch {}; publish(null) }
export async function apiRequest(path, { method = "GET", body, signal, headers = {}, authenticated = true, blob = false, bearer = sessionToken() } = {}) {
 if (!configuration) throw new Error("Backend settings have not loaded.")
 if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid API path")
 const requestHeaders = new Headers(headers)
 if (authenticated) {
  if (!bearer) throw new APIError("Please sign in with Google to continue.", 401)
  requestHeaders.set("Authorization", `Bearer ${bearer}`)
 }
 if (body !== undefined && !(body instanceof FormData)) {
  requestHeaders.set("Content-Type", "application/json")
  body = JSON.stringify(body)
 }
 let response
 try { response = await fetch(configuration.apiBaseURL + path, { method, headers: requestHeaders, body, signal, cache: "no-store", credentials: "omit" }) }
 catch (error) { if (error.name === "AbortError") throw error; throw new APIError("Could not reach WorldSplat. Check your connection and try again.", 0) }
 if (!response.ok) {
  const data = await response.json().catch(() => ({}))
  if (response.status === 401 && authenticated && bearer === sessionToken()) clearSession()
  throw new APIError(data.error || `WorldSplat request failed (${response.status}).`, response.status)
 }
 if (response.status === 204) return null
 return blob ? response.blob() : response.json()
}
export async function restoreAccount() {
 if (!sessionToken()) return null
 try { const user = await apiRequest("/me"); publish(user); return user }
 catch (error) { if (error.status === 401) return null; throw error }
}
export async function loginWithGoogle(credential) {
 const result = await apiRequest("/login", { method: "POST", body: { token: credential }, authenticated: false })
 if (!result.token || !result.user?.id) throw new Error("Sign-in did not complete. Please try again.")
 try { localStorage.setItem(SESSION_KEY, result.token) }
 catch { throw new Error("Allow browser storage for this site to stay signed in.") }
 publish(result.user)
 return result.user
}
export async function logout() {
 try { if (sessionToken()) await apiRequest("/logout", { method: "POST" }) }
 finally { clearSession(); globalThis.google?.accounts?.id?.disableAutoSelect() }
}
export async function saveTabs(tabs, bearer = sessionToken()) { return apiRequest("/save_tabs", { method: "POST", body: { tabs }, bearer }) }
export async function listJobs() { return (await apiRequest("/jobs?limit=100")).jobs }
export function getJob(id) { return apiRequest(`/jobs/${encodeURIComponent(id)}`) }
export function jobAsset(id, kind) { return apiRequest(`/jobs/${encodeURIComponent(id)}/assets/${kind}`, { blob: true }) }
export async function submitRender({ prompt, snapshot, depth, wireframe, requestID, signal }) {
 const body = new FormData()
 body.set("prompt", prompt)
 for (const [name, image] of Object.entries({ render: snapshot, depth, wireframe })) body.set(name, image, `${name}.png`)
 return apiRequest("/render", { method: "POST", body, headers: { "Idempotency-Key": requestID }, signal })
}
if (typeof window !== "undefined") window.addEventListener("storage", event => {
 if (event.key === SESSION_KEY && event.oldValue !== event.newValue) { publish(null); location.replace("/") }
})
