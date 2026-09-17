// daisyUI tabs with keyboard navigation.
export function updateWorkspaceTabETAs(container, now = Date.now()) {
 for (const label of container.querySelectorAll('[data-eta-start]')) {
  const elapsed = Math.max(0, (now - Number(label.dataset.etaStart)) / 1000)
  const seconds = label.dataset.etaStage === 'splatting' ? Math.max(0, 20 - elapsed) : Math.max(0, 25 - elapsed) + 20
  label.textContent = seconds > 0 ? `~${Math.ceil(seconds / 5) * 5}s left` : 'Finishing…'
  label.parentElement.setAttribute('aria-description', label.textContent)
 }
}

export function renderWorkspaceTabs(container, tabs, activeID, { select, close, rename, add }) {
 const selectable = tabs.filter(item => !item.loading)
 const activeChanged = container.dataset.activeTab !== activeID
 container.dataset.activeTab = activeID || ""
 const focused = document.activeElement?.dataset.tabId
 const editingTab = container.querySelector('.tab-name-input')?.closest('[data-tab-id]')
 const editingInput = editingTab?.querySelector('.tab-name-input')
 const editingSelection = editingInput && [editingInput.selectionStart, editingInput.selectionEnd]
 const scroll = container.scrollLeft
 container.replaceChildren()
 for (const item of tabs) {
  if (editingTab?.dataset.tabId === item.id && item.id === activeID) { container.append(editingTab); continue }
  const button = document.createElement("div")
  button.className = `tab${item.id === activeID ? " tab-active" : ""}`
  button.setAttribute("role", "tab")
  button.setAttribute("aria-selected", String(item.id === activeID))
  button.setAttribute("aria-disabled", String(Boolean(item.loading)))
  button.setAttribute("aria-busy", String(Boolean(item.loading)))
  button.setAttribute("aria-controls", "canvas")
  button.setAttribute("aria-label", `${item.name}, ${item.type === "build" ? "build" : "splat"}${item.status && item.status !== "completed" ? `, ${item.status}` : ""}`)
  button.tabIndex = !item.loading && item.id === activeID ? 0 : -1
  button.dataset.tabId = item.id
  button.title = `${item.name} · ${item.type === "build" ? "Editable build" : "View-only splat"} — double-click to rename`
  button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${item.type === "build" ? "#3b82f6" : "#ef4444"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${item.type === "build"
   ? '<path d="M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5"/><path d="M12 12l8 -4.5"/><path d="M12 12l0 9"/><path d="M12 12l-8 -4.5"/>'
   : '<path d="M3 21v-4a4 4 0 1 1 4 4h-4"/><path d="M21 3a16 16 0 0 0 -12.8 10.2"/><path d="M21 3a16 16 0 0 1 -10.2 12.8"/><path d="M10.6 9a9 9 0 0 1 4.4 4.4"/><path d="M17 19a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2"/><path d="M3 5a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2"/>'}</svg>`
  const label = document.createElement("span")
  label.textContent = item.name
  if (item.loading) {
   const icon = button.querySelector("svg")
   icon.classList.add("tab-spinner")
   icon.innerHTML = '<path d="M12 3a9 9 0 1 1 -9 9"/>'
   button.title = `${item.name} · Loading splat…`
   label.textContent = 'Loading…'
   const startedAt = item.status === 'splatting' ? item.splatStartedAt : Date.parse(item.createdAt)
   if (['queued', 'rendering', 'splatting'].includes(item.status) && Number.isFinite(startedAt)) {
    label.dataset.etaStart = startedAt
    label.dataset.etaStage = item.status
   }
  }
  button.append(label)
  function startRename() {
   if (item.loading || button.querySelector('.tab-name-input')) return
   const input = document.createElement("input")
   input.className = "tab-name-input"
   input.setAttribute("aria-label", "Tab name")
   input.maxLength = 50
   input.value = item.name
   input.style.minWidth = `${label.getBoundingClientRect().width}px`
   let finished = false
   function finish(cancel = false) {
    if (finished) return
    finished = true
    const name = cancel ? item.name : input.value.trim() || item.name
    label.textContent = name
    input.replaceWith(label)
    button.setAttribute("aria-label", button.getAttribute("aria-label").replace(item.name, name))
    button.title = `${name} · ${item.type === "build" ? "Editable build" : "View-only splat"} — double-click to rename`
    closeButton.setAttribute("aria-label", `Close ${name}`)
    if (name !== item.name) { item.name = name; rename(item.id, name) }
   }
   input.addEventListener("blur", () => finish())
   input.addEventListener("click", event => event.stopPropagation())
   input.addEventListener("dblclick", event => event.stopPropagation())
   input.addEventListener("keydown", event => {
    event.stopPropagation()
    if (!event.isComposing && (event.key === "Enter" || event.key === "Escape")) {
     event.preventDefault(); finish(event.key === "Escape"); button.focus()
    }
   })
   label.replaceWith(input)
   input.focus(); input.select()
  }
  const dot = document.createElement("span")
  dot.className = `tab-unsaved${item.dirty && item.id === activeID ? "" : " hidden"}`
  dot.setAttribute("aria-hidden", "true")
  dot.title = "Unsaved changes"
  button.append(dot)
  const closeButton = document.createElement("button")
  closeButton.type = "button"
  closeButton.className = `tab-close${!item.dirty && item.id === activeID && tabs.length > 1 ? "" : " hidden"}`
  closeButton.setAttribute("aria-label", `Close ${item.name}`)
  closeButton.title = "Close tab"
  closeButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>'
  closeButton.addEventListener("click", event => { event.stopPropagation(); close(item.id) })
  closeButton.addEventListener("dblclick", event => event.stopPropagation())
  button.append(closeButton)
  if (item.dirty) button.setAttribute("aria-label", `${button.getAttribute("aria-label")}, unsaved changes`)
  button.addEventListener("click", () => { if (!item.loading && item.id !== activeID) select(item.id) })
  button.addEventListener("dblclick", startRename)
  button.addEventListener("keydown", event => {
   if (event.target !== button || item.loading) return
   if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(item.id) }
   const index = selectable.findIndex(tab => tab.id === item.id)
   let target
   if (event.key === "ArrowRight") target = selectable[(index + 1) % selectable.length]
   if (event.key === "ArrowLeft") target = selectable[(index - 1 + selectable.length) % selectable.length]
   if (event.key === "Home") target = selectable[0]
   if (event.key === "End") target = selectable.at(-1)
   if (target) { event.preventDefault(); select(target.id); container.querySelector(`[data-tab-id="${CSS.escape(target.id)}"]`)?.focus() }
   if (event.key === "F2") { event.preventDefault(); startRename() }
   if (event.key === "Delete" && tabs.length > 1) { event.preventDefault(); close(item.id) }
  })
  container.append(button)
 }
 updateWorkspaceTabETAs(container)
 const addButton = document.createElement("button")
 addButton.type = "button"
 addButton.className = "add-color-swatch btn btn-ghost btn-square self-center shrink-0"
 addButton.setAttribute("aria-label", "New build tab")
 addButton.title = "New build tab"
 addButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>'
 addButton.addEventListener("click", add)
 container.append(addButton)
 container.scrollLeft = scroll
 if (activeChanged) container.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" })
 if (focused) container.querySelector(`[data-tab-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
 if (editingInput?.isConnected) { editingInput.focus({ preventScroll: true }); editingInput.setSelectionRange(...editingSelection) }
}
