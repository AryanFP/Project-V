import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { sessions } from "../manager/SessionManager";

/**
 * GET /memory/capture-stream — SSE channel the webview subscribes to.
 *
 * The server emits `{ type: "capture", id, durationMs, fps, maxWidth }`
 * events when a memory "remember this" needs frames. The webview is
 * expected to grab frames from the WHEP <video> element and POST them
 * back via /api/memory/capture with the matching id.
 */
export function memoryCaptureStream(c: Context) {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "userId is required" }, 400);

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No user for ${userId}` }, 404);

  console.log(`[SSE Memory] Client connected for user: ${userId}`);

  return streamSSE(c, async (stream) => {
    const client = {
      write: (data: string) => stream.writeSSE({ data }),
      userId,
      close: () => stream.close(),
    };

    user.webviewBurst.addSSEClient(client);

    await stream.writeSSE({
      data: JSON.stringify({ type: "connected", userId }),
    });

    stream.onAbort(() => {
      console.log(`[SSE Memory] Client disconnected for user: ${userId}`);
      user.webviewBurst.removeSSEClient(client);
    });

    while (true) {
      await stream.sleep(30000);
    }
  });
}

/**
 * POST /memory/capture — webview uploads its captured frames.
 *
 * Body: { userId, id, frames: string[] } where each frame is a base64 JPEG
 * (with or without a data: prefix). `id` must match the SSE request the
 * server issued; otherwise it's treated as a stray (timed-out) upload.
 */
export async function memoryCapture(c: Context) {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "JSON body required" }, 400);
  }
  const { userId, id, frames } = body as {
    userId?: string;
    id?: string;
    frames?: unknown;
  };

  if (!userId) return c.json({ error: "userId is required" }, 400);
  if (!id) return c.json({ error: "id is required" }, 400);
  if (!Array.isArray(frames)) {
    return c.json({ error: "frames must be an array of base64 strings" }, 400);
  }

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No user for ${userId}` }, 404);

  const stringFrames = frames.filter(
    (f): f is string => typeof f === "string" && f.length > 0,
  );

  const accepted = user.webviewBurst.completeCapture(id, stringFrames);
  return c.json({
    success: accepted,
    received: stringFrames.length,
  });
}
