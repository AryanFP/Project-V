import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { sessions } from "../manager/SessionManager";

/** POST /livestream/start — begin a WebRTC managed livestream on the glasses */
export async function startLiveStream(c: Context) {
  const { userId } = await c.req.json().catch(() => ({ userId: undefined }));
  if (!userId) return c.json({ error: "userId is required" }, 400);

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No user for ${userId}` }, 404);
  if (!user.appSession) {
    return c.json({ error: "No active glasses session" }, 409);
  }

  try {
    const state = await user.liveStream.start();
    return c.json({ success: true, ...state });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
}

/** POST /livestream/stop — stop the current livestream */
export async function stopLiveStream(c: Context) {
  const { userId } = await c.req.json().catch(() => ({ userId: undefined }));
  if (!userId) return c.json({ error: "userId is required" }, 400);

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No user for ${userId}` }, 404);

  try {
    await user.liveStream.stop();
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
}

/**
 * GET /livestream-status — SSE for real-time livestream status.
 *
 * Pushes the current LiveStreamState (status + webrtcUrl) on connect and on
 * every change, so the webview can render the WHEP video as soon as the
 * stream goes `active`.
 */
export function liveStreamStatus(c: Context) {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "userId is required" }, 400);

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No user for ${userId}` }, 404);

  console.log(`[SSE LiveStream] Client connected for user: ${userId}`);

  return streamSSE(c, async (stream) => {
    const client = {
      write: (data: string) => stream.writeSSE({ data }),
      userId,
      close: () => stream.close(),
    };

    user.liveStream.addSSEClient(client);

    // Replay the current state so a late-joining viewer is in sync.
    await stream.writeSSE({
      data: JSON.stringify({ ...user.liveStream.getState(), userId }),
    });

    stream.onAbort(() => {
      console.log(`[SSE LiveStream] Client disconnected for user: ${userId}`);
      user.liveStream.removeSSEClient(client);
    });

    while (true) {
      await stream.sleep(30000);
    }
  });
}
