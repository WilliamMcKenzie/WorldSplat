export default {
	fetch(request) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("method not allowed\n", {
				status: 405,
				headers: { Allow: "GET, HEAD" },
			})
		}
		return new Response(request.method === "HEAD" ? null : "ok\n", {
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		})
	},
}
