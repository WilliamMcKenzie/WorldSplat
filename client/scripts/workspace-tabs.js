// daisyUI's native tabs / tabs-box / tab / tab-active components with keyboard navigation.
export function renderWorkspaceTabs(container, tabs, activeID, { select, close, rename }) {
 const activeChanged = container.dataset.activeTab !== activeID
 container.dataset.activeTab = activeID || ""
 const focused = document.activeElement?.dataset.tabId
 const scroll = container.scrollLeft
 container.replaceChildren()
 for (const item of tabs) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = `tab${item.id === activeID ? " tab-active" : ""}`
  button.setAttribute("role", "tab")
  button.setAttribute("aria-selected", String(item.id === activeID))
  button.setAttribute("aria-controls", "canvas")
  button.setAttribute("aria-label", `${item.name}, ${item.type === "build" ? "build" : "splat"}${item.status && item.status !== "completed" ? `, ${item.status}` : ""}`)
  button.tabIndex = item.id === activeID ? 0 : -1
  button.dataset.tabId = item.id
  button.title = `${item.name} · ${item.type === "build" ? "Editable build" : "View-only splat"} — double-click to rename`
  button.textContent = item.name
  button.addEventListener("click", () => select(item.id))
  button.addEventListener("dblclick", () => rename(item.id))
  button.addEventListener("keydown", event => {
   const index = tabs.findIndex(tab => tab.id === item.id)
   let target
   if (event.key === "ArrowRight") target = tabs[(index + 1) % tabs.length]
   if (event.key === "ArrowLeft") target = tabs[(index - 1 + tabs.length) % tabs.length]
   if (event.key === "Home") target = tabs[0]
   if (event.key === "End") target = tabs.at(-1)
   if (target) { event.preventDefault(); select(target.id); container.querySelector(`[data-tab-id="${CSS.escape(target.id)}"]`)?.focus() }
   if (event.key === "F2") { event.preventDefault(); rename(item.id) }
   if (event.key === "Delete") { event.preventDefault(); close(item.id) }
  })
  container.append(button)
 }
 container.scrollLeft = scroll
 if (activeChanged) container.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" })
 if (focused) container.querySelector(`[data-tab-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
}
