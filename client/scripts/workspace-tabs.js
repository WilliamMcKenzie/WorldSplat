// daisyUI tabs with keyboard navigation.
export function renderWorkspaceTabs(container, tabs, activeID, { select, close, rename, add }) {
 const activeChanged = container.dataset.activeTab !== activeID
 container.dataset.activeTab = activeID || ""
 const focused = document.activeElement?.dataset.tabId
 const scroll = container.scrollLeft
 container.replaceChildren()
 for (const item of tabs) {
  const button = document.createElement("div")
  button.className = `tab${item.id === activeID ? " tab-active" : ""}`
  button.setAttribute("role", "tab")
  button.setAttribute("aria-selected", String(item.id === activeID))
  button.setAttribute("aria-controls", "canvas")
  button.setAttribute("aria-label", `${item.name}, ${item.type === "build" ? "build" : "splat"}${item.status && item.status !== "completed" ? `, ${item.status}` : ""}`)
  button.tabIndex = item.id === activeID ? 0 : -1
  button.dataset.tabId = item.id
  button.title = `${item.name} · ${item.type === "build" ? "Editable build" : "View-only splat"} — double-click to rename`
  button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${item.type === "build" ? "#3b82f6" : "#ef4444"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${item.type === "build"
   ? '<path d="M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5"/><path d="M12 12l8 -4.5"/><path d="M12 12l0 9"/><path d="M12 12l-8 -4.5"/>'
   : '<path d="M3 21v-4a4 4 0 1 1 4 4h-4"/><path d="M21 3a16 16 0 0 0 -12.8 10.2"/><path d="M21 3a16 16 0 0 1 -10.2 12.8"/><path d="M10.6 9a9 9 0 0 1 4.4 4.4"/><path d="M17 19a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2"/><path d="M3 5a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2"/>'}</svg>`
  button.append(document.createTextNode(item.name))
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
  button.addEventListener("click", () => select(item.id))
  button.addEventListener("dblclick", () => rename(item.id))
  button.addEventListener("keydown", event => {
   if (event.target !== button) return
   if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(item.id) }
   const index = tabs.findIndex(tab => tab.id === item.id)
   let target
   if (event.key === "ArrowRight") target = tabs[(index + 1) % tabs.length]
   if (event.key === "ArrowLeft") target = tabs[(index - 1 + tabs.length) % tabs.length]
   if (event.key === "Home") target = tabs[0]
   if (event.key === "End") target = tabs.at(-1)
   if (target) { event.preventDefault(); select(target.id); container.querySelector(`[data-tab-id="${CSS.escape(target.id)}"]`)?.focus() }
   if (event.key === "F2") { event.preventDefault(); rename(item.id) }
   if (event.key === "Delete" && tabs.length > 1) { event.preventDefault(); close(item.id) }
  })
  container.append(button)
 }
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
}
