import type { Context } from "hono";
import { sessions } from "../manager/SessionManager";
import { getMemoryAgent } from "../agent/MemoryAgent";

/**
 * GET /memories?userId=…&limit=20
 *
 * Returns recent visual memories for the wearer, newest first. The webview
 * renders these in the Visual Memory grid. Each row includes the small
 * thumbnail JPEG (base64) so the grid can show real frames, not placeholders.
 *
 * Why a separate endpoint (not the MemoryAgent.recall flow):
 *   recall() does a semantic vector search + Gemini synthesis. This is just
 *   a read of the most recent rows for browsing — no model in the loop, no
 *   embedding cost. The route is `/memories` (plural) to distinguish from
 *   the existing `/memory/capture` and `/memory/capture-stream` routes
 *   which are for storage roundtrips.
 */
export async function listMemories(c: Context) {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "userId is required" }, 400);

  const user = sessions.get(userId);
  if (!user) return c.json({ error: `No user for ${userId}` }, 404);

  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") ?? "20", 10) || 20, 1),
    100,
  );

  try {
    const rows = await listRecentForUser(userId, limit);
    return c.json({ memories: rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[/memories] failed for ${userId}:`, msg);
    return c.json({ error: msg }, 500);
  }
}

/**
 * Pull the most recent N memories for a user directly from LibSQL.
 *
 * MemoryAgent already owns the libsql client + schema; we just reach in for
 * a read query. Reusing its client means we never open a second connection
 * to the same DB file — sqlite hates that on some filesystems.
 */
async function listRecentForUser(userId: string, limit: number) {
  const agent = getMemoryAgent();
  // ensureSchema runs the CREATE TABLE on first access — safe to call here
  // even before the first remember(). Reuse the same libsql client the
  // agent owns; opening a parallel connection to the same DB file is
  // fragile under sqlite on some filesystems.
  await agent.ensureSchema();
  const client = await agent.ensureLibsql();

  const result = await client.execute({
    sql: `
      SELECT id, user_id, session_id, created_at, caption, entities,
             transcript, frame_count, thumb_b64
      FROM memories
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
    args: [userId, limit],
  });

  return result.rows.map((r: any) => {
    let entities: unknown = [];
    try {
      entities = JSON.parse(String(r.entities ?? "[]"));
    } catch {
      entities = [];
    }
    return {
      id: String(r.id),
      userId: String(r.user_id),
      sessionId: String(r.session_id),
      createdAt: Number(r.created_at),
      caption: String(r.caption ?? ""),
      entities,
      transcript: r.transcript ? String(r.transcript) : null,
      frameCount: Number(r.frame_count ?? 0),
      thumbB64: r.thumb_b64 ? String(r.thumb_b64) : null,
    };
  });
}
