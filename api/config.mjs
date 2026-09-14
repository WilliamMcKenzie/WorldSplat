const env = (name, fallback) => process.env[name] || fallback
const number = (name, fallback, min, max) => {
 const raw = process.env[name]
 const value = raw === undefined || raw === "" ? fallback : Number(raw)
 return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

// Public runtime configuration only. Provider credentials and backend session tokens never belong here.
export function runtimeConfig() {
 return {
  backend: {
   apiBaseURL: env("WS_API_BASE_URL", "https://worldsplat-api.lagso.com"),
   googleClientId: env("WS_GOOGLE_CLIENT_ID", "630555242435-8coioj3gsr4o348c61g8og189jbquagg.apps.googleusercontent.com"),
   loginEnabled: true,
   tabSchemaVersion: 1,
  },
  generation: { provider: "backend" },
  scene: {
   opacityFloor: number("WS_SCENE_OPACITY_FLOOR", 0.03, 0, 1),
   yOffset: number("WS_SCENE_Y_OFFSET", 0, -100, 100),
   yaw: number("WS_SCENE_YAW", 0, -360, 360),
   fitBboxPercentile: number("WS_SCENE_FIT_BBOX_PERCENTILE", 0, 0, 49),
  },
 }
}
export default {
 async fetch(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } })
  return new Response(request.method === "HEAD" ? null : JSON.stringify(runtimeConfig()), { headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" } })
 },
}
