import type { Context } from "hono";

/**
 * GET /dev/user — dev-only escape hatch.
 *
 * Returns `{ userId: string | null }` derived from DEV_DEFAULT_USER_ID in
 * .env. Used by the localhost webview to skip the MentraOS auth handshake.
 * Disabled when NODE_ENV is "production".
 *
 * Why this exists as a server endpoint instead of a bundled env var:
 *   Bun's HTML bundler doesn't reliably substitute `BUN_PUBLIC_*` env vars
 *   into browser code across versions. Reading from the server is the only
 *   path that works deterministically — and a dev-only escape hatch is
 *   already trusting the local network, so one extra fetch is fine.
 */
export function getDevUser(c: Context) {
  if (process.env.NODE_ENV === "production") {
    return c.json({ userId: null });
  }
  const userId = process.env.DEV_DEFAULT_USER_ID || null;
  return c.json({ userId });
}
