// Serialize whole-workspace saves. A slow older request can never overwrite a newer edit.
const fingerprint = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)

export function createTabSync(save, onState = () => {}, initialTabs = []) {
 let pending = null, running = null, failed = false
 let saved = structuredClone(initialTabs), requested = structuredClone(initialTabs)
 async function drain() {
  while (pending !== null) {
   const tabs = pending
   pending = null
   onState("saving")
   try { await save(tabs); saved = structuredClone(tabs); failed = false }
   catch (error) { if (pending === null) pending = tabs; failed = true; onState("error", error); throw error }
  }
  onState("saved")
 }
 return {
  queue(tabs) { pending = structuredClone(tabs); requested = structuredClone(tabs); onState("unsaved") },
  queueTab(tabs, id) {
   this.queue(tabs.flatMap(tab => {
    const value = tab.id === id ? tab : requested.find(item => item.id === tab.id)
    return value ? [value] : []
   }))
  },
  isTabDirty(tab) { return fingerprint(tab) !== fingerprint(saved.find(item => item.id === tab.id)) },
  hasChanges(tabs) { return fingerprint(tabs) !== fingerprint(saved) },
  normalizeSavedTab(tab) {
   const previous = saved.find(item => item.id === tab.id)
   requested = requested.map(item => item.id === tab.id && fingerprint(item) === fingerprint(previous) ? structuredClone(tab) : item)
   saved = saved.map(item => item.id === tab.id ? structuredClone(tab) : item)
  },
  async flush() {
   if (running) { await running; if (pending !== null) return this.flush(); return }
   if (pending === null) return
   running = drain()
   try { await running } finally { running = null }
  },
  get dirty() { return pending !== null || running !== null || failed },
 }
}
