import type { User } from "../../session/User";
import { getMemoryAgent } from "../MemoryAgent";

/**
 * rememberMoment — server-side tool invoked when the wearer says
 * "Hey Gemini, remember this".
 *
 * Pulls a 3-second burst of JPEG frames from the active livestream via
 * HlsBurst, grabs the last ~10s of transcript context, hands the bundle
 * to the MemoryAgent for captioning + embedding + insertion. Returns the
 * confirmation string that the caller speaks back through AudioManager.
 *
 * Note on UX: this is intentionally SYNCHRONOUS from the wearer's
 * perspective — the confirmation only fires once the row is written.
 * If we returned "remembered" early and the user immediately asked
 * "where are my keys?" the row wouldn't exist yet. Honest beats fancy.
 */
export interface RememberMomentInput {
  /** Optional hint extracted from the utterance, e.g. "the keys". */
  reason?: string;
  /** How long to pull frames for (ms). Default 3000. */
  durationMs?: number;
}

export interface RememberMomentResult {
  ok: boolean;
  /** Speakable confirmation/failure string. */
  spoken: string;
  /** Memory id on success, null on failure. */
  memoryId: string | null;
}

export async function rememberMoment(
  user: User,
  input: RememberMomentInput = {},
): Promise<RememberMomentResult> {
  const sessionId = user.appSession ? sessionIdFor(user) : "no-session";
  const durationMs = input.durationMs ?? 3000;

  // 1. Pull the frame burst from the webview (which is playing the live
  //    WHEP stream and can captureStream + draw to canvas at any moment).
  //    Cloudflare HLS would 404 here — HLS segments take 30-90s to appear
  //    after a stream goes active, so we don't use it. See HlsBurst.ts for
  //    the dormant alternative.
  //
  // Frame budget: 3 frames @ 384px wide. The wearer is dwelling on a static
  // subject (keys, pill bottle, sign) so 3 frames is plenty. Keeps the JSON
  // upload small (~60-100 KB total) so a slow venue Wi-Fi doesn't blow the
  // watchdog. fps=1 over 3s gives exactly 3 captures.
  const burst = await user.webviewBurst.capture(durationMs, 1, 384);
  if (burst.frames.length === 0) {
    return {
      ok: false,
      spoken: "I can only remember when the camera is on and the viewer is open.",
      memoryId: null,
    };
  }

  // 2. Surrounding transcript context (last ~10s of FINAL transcriptions).
  const transcript = user.transcription.recentText(10_000);

  // 3. Hand off to MemoryAgent.
  const result = await getMemoryAgent().remember({
    userId: user.userId,
    sessionId,
    frames: burst.frames,
    transcript,
    reason: input.reason,
  });

  return {
    ok: result.ok,
    spoken: result.spoken,
    memoryId: result.row?.id ?? null,
  };
}

/**
 * Stable session id for a user's current glasses connection.
 *
 * MentraOS SDK doesn't expose a stable session id we can rely on, so we
 * derive one from the user id + the moment the AppSession was attached.
 * That's enough granularity to attribute memories to a wearer-session for
 * later filtering ("what did I see in this session?").
 */
function sessionIdFor(user: User): string {
  return `${user.userId}:${user.sessionEpoch}`;
}
