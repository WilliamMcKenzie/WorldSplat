// Serialize whole-workspace saves. A slow older request can never overwrite a newer edit.
export function createTabSync(save, onState = () => {}) {
 let pending = null, running = null, failed = false
 async function drain() {
  while (pending !== null) {
   const tabs = pending
   pending = null
   onState("saving")
   try { await save(tabs); failed = false }
   catch (error) { if (pending === null) pending = tabs; failed = true; onState("error", error); throw error }
  }
  onState("saved")
 }
 return {
  queue(tabs) { pending = structuredClone(tabs); onState("unsaved") },
  async flush() {
   if (running) { await running; if (pending !== null) return this.flush(); return }
   if (pending === null) return
   running = drain()
   try { await running } finally { running = null }
  },
  get dirty() { return pending !== null || running !== null || failed },
 }
}
