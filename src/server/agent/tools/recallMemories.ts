import type { User } from "../../session/User";
import { getMemoryAgent } from "../MemoryAgent";

/**
 * recallMemories — server-side tool invoked when the wearer asks a recall
 * question like "where are my keys?" or "did I take my pills today?".
 *
 * Strategy lives in MemoryAgent.recall(): semantic vector search against
 * the stored captions, then Gemini 3.5 Flash composes a short spoken
 * answer from the top hits. We don't do entity-lookup fast-path in v1 —
 * vector search over a few dozen captions is plenty fast and avoids
 * brittle regexes.
 */
export interface RecallMemoriesInput {
  /** The wearer's natural-language question. */
  query: string;
  /** Optional: limit to today's memories. Default "all". */
  timeWindow?: "today" | "all";
  /** Optional: how many hits to feed into synthesis. Default 5. */
  topK?: number;
}

export interface RecallMemoriesResult {
  ok: boolean;
  /** Speakable answer. */
  spoken: string;
  /** Number of memories that contributed to the answer. */
  hitCount: number;
}

export async function recallMemories(
  user: User,
  input: RecallMemoriesInput,
): Promise<RecallMemoriesResult> {
  const query = (input.query ?? "").trim();
  if (!query) {
    return {
      ok: false,
      spoken: "What do you want me to remember?",
      hitCount: 0,
    };
  }

  const result = await getMemoryAgent().recall({
    userId: user.userId,
    query,
    timeWindow: input.timeWindow ?? "all",
    topK: input.topK ?? 5,
  });

  return {
    ok: result.ok,
    spoken: result.spoken,
    hitCount: result.hits.length,
  };
}
