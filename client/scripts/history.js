// Persistent build history. Each completed generateWorld() build — the block-out at
// build time, its pristine one-shot scene splat, the prompt + a thumbnail — is saved to
// IndexedDB so prior builds survive reloads and can be restored without regenerating.
// Storage is split into a light `meta` store (prompt + thumbnail + manifest, listed
// cheaply in the history panel) and a heavy `splats` store (the RAW splat bytes,
// loaded only when a build is restored — restore re-runs the exact same cull/fit
// pipeline so it matches the original).

const DB_NAME = "worldsketch_builds"
const DB_VERSION = 1
const META_STORE = "meta"     // { id, ts, prompt, thumb, scene, primitives }
const SPLAT_STORE = "splats"  // { id, scene: Uint8Array }
const MAX_ENTRIES = 20        // cap so the splat blobs don't grow without bound

let dbPromise = null

function openDB() {
	if (dbPromise) return dbPromise
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION)
		req.onupgradeneeded = () => {
			const db = req.result
			if (!db.objectStoreNames.contains(META_STORE)) {
				const store = db.createObjectStore(META_STORE, { keyPath: "id", autoIncrement: true })
				store.createIndex("ts", "ts")
			}
			if (!db.objectStoreNames.contains(SPLAT_STORE)) {
				db.createObjectStore(SPLAT_STORE, { keyPath: "id" })
			}
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
	return dbPromise
}

// Save one completed one-shot build. The raw scene bytes are copied so the splat loader
// cannot detach the live buffer. Scene fit metadata and the serialized block-out are
// both needed to re-seat it on restore.
export async function addBuild({ prompt, thumb, scene, primitives, splat }) {
	if (!splat) throw new Error("cannot save build without a scene splat")
	const sceneBytes = splat.slice()
	const meta = {
		ts: Date.now(),
		prompt: prompt || "",
		thumb: thumb || "",
		scene: { ...(scene || {}) },
		primitives: primitives || "",
	}
	const db = await openDB()
	const id = await new Promise((resolve, reject) => {
		const t = db.transaction([META_STORE, SPLAT_STORE], "readwrite")
		const addReq = t.objectStore(META_STORE).add(meta)
		addReq.onsuccess = () => t.objectStore(SPLAT_STORE).put({ id: addReq.result, scene: sceneBytes })
		t.oncomplete = () => resolve(addReq.result)
		t.onerror = () => reject(t.error)
		t.onabort = () => reject(t.error)
	})
	await prune()
	return { ...meta, id }
}

// Newest-first list of lightweight build metadata (no splat bytes).
export async function listBuilds() {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const req = db.transaction(META_STORE, "readonly").objectStore(META_STORE).getAll()
		req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.ts - a.ts))
		req.onerror = () => reject(req.error)
	})
}

// The raw one-shot scene bytes for a build, or null if missing. The fallback reads
// one-shot entries saved before the storage shape was narrowed from a named map.
export async function getBuildSceneSplat(id) {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const req = db.transaction(SPLAT_STORE, "readonly").objectStore(SPLAT_STORE).get(id)
		req.onsuccess = () => resolve(req.result?.scene ?? req.result?.splats?.scene ?? null)
		req.onerror = () => reject(req.error)
	})
}

export async function deleteBuild(id) {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const t = db.transaction([META_STORE, SPLAT_STORE], "readwrite")
		t.objectStore(META_STORE).delete(id)
		t.objectStore(SPLAT_STORE).delete(id)
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
	})
}

export async function clearBuilds() {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const t = db.transaction([META_STORE, SPLAT_STORE], "readwrite")
		t.objectStore(META_STORE).clear()
		t.objectStore(SPLAT_STORE).clear()
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
	})
}

// Drop the oldest builds (and their splats) once we exceed MAX_ENTRIES.
async function prune() {
	const all = await listBuilds()
	const extra = all.slice(MAX_ENTRIES)
	if (!extra.length) return
	const db = await openDB()
	await new Promise((resolve, reject) => {
		const t = db.transaction([META_STORE, SPLAT_STORE], "readwrite")
		for (const entry of extra) {
			t.objectStore(META_STORE).delete(entry.id)
			t.objectStore(SPLAT_STORE).delete(entry.id)
		}
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
	})
}
