export default {
 async fetch(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } })
  return new Response(request.method === "HEAD" ? null : "ok\n", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } })
 },
}
