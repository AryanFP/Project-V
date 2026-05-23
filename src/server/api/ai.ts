import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { sessions } from "../manager/SessionManager";
import { isMode } from "../agent/modes";

/** POST /ai/connect — open the Gemini Live session for this user */
export async function connectAI(c: Context) {
  const { userId } = await c.req.json().catch(() => ({ userId: undefined }));
  if (!userId) return c.json({ error: "userId is required" }, 400);

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No user for ${userId}` }, 404);

  try {
    await user.ai.connect();
    return c.json({
      success: true,
      connected: user.ai.isConnected(),
      mode: user.ai.getMode(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
}

/** POST /ai/mode — manually switch the AI mode. Body: { userId, mode } */
export async function setAIMode(c: Context) {
  const { userId, mode } = await c.req
    .json()
    .catch(() => ({ userId: undefined, mode: undefined }));

  if (!userId) return c.json({ error: "userId is required" }, 400);
  if (!isMode(mode)) {
    return c.json({ error: "mode must be passive | active | outdoor | auto" }, 400);
  }

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No user for ${userId}` }, 404);

  try {
    await user.agent.setMode(mode, "manual");
    return c.json({ success: true, mode: user.ai.getMode() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
}

/** POST /ai/disconnect — close the Gemini Live session */
export async function disconnectAI(c: Context) {
  const { userId } = await c.req.json().catch(() => ({ userId: undefined }));
  if (!userId) return c.json({ error: "userId is required" }, 400);

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No user for ${userId}` }, 404);

  user.ai.destroy();
  return c.json({ success: true });
}

/**
 * POST /ai/frame — feed one camera frame to the AI.
 *
 * The glasses video never reaches the server (it streams glasses→Cloudflare
 * via WHIP), so the webview samples frames from its live <video> element and
 * posts them here. Body: { userId, frame } where `frame` is base64 JPEG
 * (with or without a data: prefix).
 */
export async function aiFrame(c: Context) {
  const { userId, frame } = await c.req
    .json()
    .catch(() => ({ userId: undefined, frame: undefined }));

  if (!userId) return c.json({ error: "userId is required" }, 400);
  if (typeof frame !== "string" || !frame) {
    return c.json({ error: "frame (base64 JPEG) is required" }, 400);
  }

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No user for ${userId}` }, 404);
  if (!user.ai.isConnected()) {
    return c.json({ error: "AI session not connected" }, 409);
  }

  // Strip a data URL prefix if the client sent one.
  const base64 = frame.includes(",") ? frame.slice(frame.indexOf(",") + 1) : frame;
  user.ai.sendFrame(base64);
  return c.json({ success: true });
}

/**
 * GET /ai-stream — SSE of AI response text.
 *
 * Streams Gemini's incremental answer chunks (and turn-complete markers)
 * to the webview.
 */
export function aiStream(c: Context) {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "userId is required" }, 400);

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No user for ${userId}` }, 404);

  console.log(`[SSE AI] Client connected for user: ${userId}`);

  return streamSSE(c, async (stream) => {
    const client = {
      write: (data: string) => stream.writeSSE({ data }),
      userId,
      close: () => stream.close(),
    };

    user.ai.addSSEClient(client);

    await stream.writeSSE({
      data: JSON.stringify({ type: "connected", userId }),
    });
    // Replay the current mode so a fresh client shows the right badge.
    await stream.writeSSE({
      data: JSON.stringify({ type: "mode", mode: user.ai.getMode(), userId }),
    });

    stream.onAbort(() => {
      console.log(`[SSE AI] Client disconnected for user: ${userId}`);
      user.ai.removeSSEClient(client);
    });

    while (true) {
      await stream.sleep(30000);
    }
  });
}
