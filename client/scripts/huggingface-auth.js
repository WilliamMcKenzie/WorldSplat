const HF_ORIGIN = "https://huggingface.co"
const DEFAULT_CONFIG = {
	oauthClientId: "91581ad0-d16c-4f49-9746-cff21b50ac9e",
	redirectUrl: "",
}

const CALLBACK_KEYS = {
	verifier: "worldsketch.hf.verifier",
	state: "worldsketch.hf.state",
	prompt: "worldsketch.hf.pendingPrompt",
}
const SESSION_KEY = "worldsketch.hf.session"

let config = { ...DEFAULT_CONFIG }
let accessToken = ""
let tokenExpiresAt = 0
let user = null
const listeners = new Set()

function snapshot() {
	return { signedIn: Boolean(accessToken), user }
}

function emit() {
	const current = snapshot()
	for (const listener of listeners) listener(current)
}

function persistSession() {
	if (!accessToken) {
		sessionStorage.removeItem(SESSION_KEY)
		return
	}
	sessionStorage.setItem(SESSION_KEY, JSON.stringify({ accessToken, tokenExpiresAt, user }))
}

function clearSession() {
	for (const key of Object.values(CALLBACK_KEYS)) sessionStorage.removeItem(key)
	sessionStorage.removeItem(SESSION_KEY)
	accessToken = ""
	tokenExpiresAt = 0
	user = null
}

function restoreSession() {
	try {
		const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null")
		if (!saved?.accessToken) return
		const expiresAt = Number(saved.tokenExpiresAt) || 0
		if (expiresAt && Date.now() >= expiresAt) {
			sessionStorage.removeItem(SESSION_KEY)
			return
		}
		accessToken = saved.accessToken
		tokenExpiresAt = expiresAt
		user = saved.user ?? null
	} catch {
		sessionStorage.removeItem(SESSION_KEY)
	}
}

restoreSession()

function randomUrlSafe(bytes = 32) {
	const data = crypto.getRandomValues(new Uint8Array(bytes))
	let binary = ""
	for (const byte of data) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

async function sha256UrlSafe(value) {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
	let binary = ""
	for (const byte of digest) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function redirectUrl() {
	return config.redirectUrl || `${location.origin}/`
}

function cleanCallbackUrl() {
	const url = new URL(location.href)
	for (const key of ["code", "state", "error", "error_description"]) url.searchParams.delete(key)
	history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`)
}

export function configureHuggingFaceAuth(next = {}) {
	config = {
		oauthClientId: next.oauthClientId ?? DEFAULT_CONFIG.oauthClientId,
		redirectUrl: next.redirectUrl ?? DEFAULT_CONFIG.redirectUrl,
	}
	emit()
}

export function onHuggingFaceAuthChange(listener) {
	listeners.add(listener)
	listener(getHuggingFaceAuth())
	return () => listeners.delete(listener)
}

export function getHuggingFaceAuth() {
	if (accessToken && tokenExpiresAt && Date.now() >= tokenExpiresAt) {
		clearSession()
		emit()
	}
	return snapshot()
}

export function getHuggingFaceAccessToken() {
	return getHuggingFaceAuth().signedIn ? accessToken : ""
}

export async function signInHuggingFace(pendingPrompt = "") {
	if (!config.oauthClientId) throw new Error("Hugging Face sign-in is not configured")
	const verifier = randomUrlSafe(64)
	const state = randomUrlSafe(24)
	sessionStorage.setItem(CALLBACK_KEYS.verifier, verifier)
	sessionStorage.setItem(CALLBACK_KEYS.state, state)
	if (pendingPrompt) sessionStorage.setItem(CALLBACK_KEYS.prompt, pendingPrompt)
	else sessionStorage.removeItem(CALLBACK_KEYS.prompt)

	const authorize = new URL(`${HF_ORIGIN}/oauth/authorize`)
	authorize.search = new URLSearchParams({
		client_id: config.oauthClientId,
		redirect_uri: redirectUrl(),
		response_type: "code",
		scope: "openid profile inference-api",
		state,
		code_challenge: await sha256UrlSafe(verifier),
		code_challenge_method: "S256",
	}).toString()
	location.assign(authorize)
}

export async function finishHuggingFaceSignIn() {
	const params = new URLSearchParams(location.search)
	const oauthError = params.get("error")
	const code = params.get("code")
	if (!oauthError && !code) return { handled: false, prompt: "" }
	if (oauthError) {
		const detail = params.get("error_description") || oauthError
		for (const key of Object.values(CALLBACK_KEYS)) sessionStorage.removeItem(key)
		cleanCallbackUrl()
		throw new Error(`Hugging Face sign-in failed: ${detail}`)
	}

	const expectedState = sessionStorage.getItem(CALLBACK_KEYS.state)
	const verifier = sessionStorage.getItem(CALLBACK_KEYS.verifier)
	const returnedState = params.get("state")
	const prompt = sessionStorage.getItem(CALLBACK_KEYS.prompt) || ""
	for (const key of Object.values(CALLBACK_KEYS)) sessionStorage.removeItem(key)
	cleanCallbackUrl()
	if (!verifier || !expectedState || returnedState !== expectedState) {
		throw new Error("Hugging Face sign-in could not be verified. Please try again.")
	}

	const response = await fetch(`${HF_ORIGIN}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: config.oauthClientId,
			code,
			code_verifier: verifier,
			grant_type: "authorization_code",
			redirect_uri: redirectUrl(),
		}),
	})
	const result = await response.json().catch(() => ({}))
	if (!response.ok || !result.access_token) {
		throw new Error(result.error_description || result.error || "Hugging Face sign-in failed")
	}
	accessToken = result.access_token
	tokenExpiresAt = result.expires_in ? Date.now() + Number(result.expires_in) * 1000 : 0
	try {
		const whoami = await fetch(`${HF_ORIGIN}/api/whoami-v2`, { headers: { Authorization: `Bearer ${accessToken}` } })
		if (whoami.ok) user = await whoami.json()
	} catch {
		user = null
	}
	persistSession()
	emit()
	return { handled: true, prompt }
}

export function signOutHuggingFaceAuth() {
	clearSession()
	emit()
}
