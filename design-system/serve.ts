/** Serve the generated gallery with Bun's HTTP server. */

const DIST = `${import.meta.dir}/web`;

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4173),
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${DIST}${path}`);
    if (await file.exists()) {
      return new Response(file, {
        headers: { "cache-control": "no-store" },
      });
    }
    return new Response("No gallery yet. Run: bun run ds", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});

console.log(`design system on http://localhost:${server.port}`);
