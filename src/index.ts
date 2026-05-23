/**
 * MentraOS Camera App - Fullstack Entry Point
 *
 * Uses Bun.serve() with HTML imports for the frontend
 * and Hono-based AppServer for the backend + MentraOS SDK.
 */

import { CameraApp } from "./server/CameraApp";
import { api } from "./server/routes/routes";
import { sessions } from "./server/manager/SessionManager";
import { createMentraAuthRoutes } from "@mentra/sdk";
import indexHtml from "./frontend/index.html";

// Configuration from environment
const PORT = parseInt(process.env.PORT || "3000", 10);
const PACKAGE_NAME = process.env.PACKAGE_NAME;
const API_KEY = process.env.MENTRAOS_API_KEY;
const COOKIE_SECRET = process.env.COOKIE_SECRET || API_KEY;

// Validate required environment variables
if (!PACKAGE_NAME) {
  console.error("PACKAGE_NAME environment variable is not set");
  process.exit(1);
}

if (!API_KEY) {
  console.error("MENTRAOS_API_KEY environment variable is not set");
  process.exit(1);
}

console.log("📸 Starting Camera App\n");
console.log(`   Package: ${PACKAGE_NAME}`);
console.log(`   Port: ${PORT}`);
console.log("");

// Initialize App (extends Hono via AppServer)
const app = new CameraApp({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,
  cookieSecret: COOKIE_SECRET,
});

// Mount Mentra auth routes for frontend token exchange
app.route(
  "/api/mentra/auth",
  createMentraAuthRoutes({
    apiKey: API_KEY,
    packageName: PACKAGE_NAME,
    cookieSecret: COOKIE_SECRET || "",
  }),
);

// Mount API routes
// @ts-ignore - Hono type compatibility
app.route("/api", api);

// Start the SDK app (registers SDK routes, checks version)
await app.start();

console.log(`✅ Camera app running at http://localhost:${PORT}`);
console.log(`   • Webview: http://localhost:${PORT}`);
console.log(`   • API: http://localhost:${PORT}/api/health`);
console.log("");

// Determine environment
const isDevelopment = process.env.NODE_ENV === "development";

// Serve static assets
const publicPath = `${process.cwd()}/src/public/assets`;

// Start Bun server with HMR support
Bun.serve({
  port: PORT,
  idleTimeout: 120, // 2 minutes for SSE connections
  development: isDevelopment && {
    hmr: true,
    console: true,
  },
  routes: {
    // Serve the React frontend at root
    "/": indexHtml,
    "/webview": indexHtml,
    "/webview/*": indexHtml,
  },
  fetch(request) {
    const url = new URL(request.url);

    // Serve static assets from /assets/
    if (url.pathname.startsWith("/assets/")) {
      const filePath = `${publicPath}${url.pathname.replace("/assets", "")}`;
      const file = Bun.file(filePath);
      return new Response(file);
    }

    // Handle all other requests through Hono app
    return app.fetch(request);
  },
});

if (isDevelopment) {
  console.log(`🔥 HMR enabled for development`);
}
console.log("");

// Graceful shutdown
const shutdown = async () => {
  console.log("\n🛑 Shutting down Camera App...");

  // Force-stop every active livestream BEFORE we tear down the SDK, so the
  // glasses + Cloudflare ingest stop publishing. If we wait for app.stop()
  // to fire onStop, the WS may already be tearing down and the stop calls
  // can no-op silently. Doing it here issues the stops while WebSockets
  // are still alive. liveStream.destroy() schedules a 200ms retry that
  // also lands before exit, since we await app.stop() right after.
  for (const user of sessions.all()) {
    try {
      console.log(`📹 Shutdown: force-stopping livestream for ${user.userId}`);
      user.liveStream.destroy();
    } catch (err) {
      console.error(`📹 Shutdown: failed to stop livestream for ${user.userId}:`, err);
    }
  }
  // Give the 200ms delayed retry + the checkExistingStream round-trip a
  // chance to finish before we kill the process.
  await new Promise((r) => setTimeout(r, 400));

  await app.stop();
  console.log("👋 Goodbye!");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Survive misbehaving SDK / WebSocket errors during teardown. The MentraOS
// SDK has paths (e.g. stopManagedStream while the WS is mid-reconnect) that
// throw or reject async — without these handlers, a session disconnect can
// crash the entire dev server. Logging the error is enough; the request
// that triggered it is already dead.
process.on("unhandledRejection", (reason) => {
  console.error(
    "⚠️  Unhandled promise rejection:",
    reason instanceof Error ? reason.stack ?? reason.message : reason,
  );
});
process.on("uncaughtException", (error) => {
  console.error("⚠️  Uncaught exception:", error.stack ?? error.message);
});
