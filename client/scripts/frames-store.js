// Persistent frame state. Build snapshots are small JSON — one record, rewritten whole
// on every debounced change and restored at boot, so past builds survive reloads.
// Splat frames are deliberately absent: their data is the fitted GPU splats, and the
// build-history store (history.js) already keeps the durable raw bytes for those.

const DB_NAME = "worldsketch_frames"
const DB_VERSION = 1
const STORE = "state"
const KEY = "frames"

let dbPromise = null

function openDB() {
	if (dbPromise) return dbPromise
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION)
		req.onupgradeneeded = () => {
			const db = req.result
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" })
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
	return dbPromise
}

// The saved frames state from the last session, or null if nothing was ever saved.
export async function loadFramesState() {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY)
		req.onsuccess = () => resolve(req.result?.state ?? null)
		req.onerror = () => reject(req.error)
	})
}

// Remove the saved record entirely so the next boot looks like a first visit.
export async function clearFramesState() {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const t = db.transaction(STORE, "readwrite")
		t.objectStore(STORE).delete(KEY)
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
		t.onabort = () => reject(t.error)
	})
}

// Overwrite the single saved record with the current state (last write wins).
export async function saveFramesState(state) {
	const db = await openDB()
	return new Promise((resolve, reject) => {
		const t = db.transaction(STORE, "readwrite")
		t.objectStore(STORE).put({ key: KEY, state })
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
		t.onabort = () => reject(t.error)
	})
}
