import type { User } from "../session/User";

interface SSEWriter {
  write: (data: string) => void;
  userId: string;
  close: () => void;
}

/**
 * One in-flight capture request.
 *
 * The server publishes a `capture` SSE event with this id; the webview
 * grabs frames from the live <video>, POSTs them back to /api/memory/capture
 * with the same id, and the matching pending entry resolves.
 */
interface Pending {
  id: string;
  resolve: (result: BurstResult) => void;
  /** Watchdog timer — fires if the webview never responds. */
  timer: ReturnType<typeof setTimeout>;
}

export interface BurstResult {
  frames: Buffer[];
  startedAt: number;
  endedAt: number;
}

/**
 * WebviewBurst — request a short burst of JPEG frames from the webview,
 * which samples the existing WHEP <video> element.
 *
 * Why this exists (vs HlsBurst):
 *   Cloudflare's HLS playlist exists at the moment the stream goes active
 *   but the first segment takes 30-90s to publish — ffmpeg gets a 404 if
 *   you try to read it immediately. WHEP/WebRTC is live the instant the
 *   stream is active, and the webview is already playing it. So we ask the
 *   webview to do the captureStream/canvas/JPEG work and POST it back.
 *
 * Why this doesn't pollute the live AI frame path:
 *   AIPanel already runs a periodic `/api/ai/frame` POST for the realtime
 *   Q&A flow. We use a SEPARATE endpoint + SSE channel so memory bursts
 *   never compete with that loop and the bursts don't accidentally get
 *   used as live frames.
 *
 * Concurrency:
 *   One in-flight burst per user. A second capture() during an active one
 *   returns the same promise.
 */
export class WebviewBurst {
  /** SSE clients listening for capture requests (the webviews). */
  private sseClients: Set<SSEWriter> = new Set();
  /** id → pending entry. Resolved by completeCapture() when frames arrive. */
  private pending: Map<string, Pending> = new Map();
  /** Reused promise while one burst is in flight. */
  private inFlight: Promise<BurstResult> | null = null;

  constructor(private user: User) {}

  /**
   * Ask the webview to capture a burst of frames from the live <video>.
   *
   * Resolves with `{ frames: [] }` if no webview is connected or the burst
   * times out. Callers MUST check `frames.length > 0` before storing.
   *
   * @param durationMs - how long the webview samples for (default 3000)
   * @param fps        - target frame rate (default 2 → ~6 frames in 3s)
   * @param maxWidth   - downscale long edge for fast Gemini upload
   */
  async capture(
    durationMs = 3000,
    fps = 2,
    maxWidth = 512,
  ): Promise<BurstResult> {
    if (this.inFlight) {
      console.log(
        `🎞️  Webview burst already in flight for ${this.user.userId} — reusing`,
      );
      return this.inFlight;
    }

    // Bail early if no webview is connected to receive the request. We
    // can't capture frames without one — the server has no JPEGs of its own.
    if (this.sseClients.size === 0) {
      console.warn(
        `🎞️  No webview connected for ${this.user.userId} — cannot capture frames`,
      );
      const now = Date.now();
      return { frames: [], startedAt: now, endedAt: now };
    }

    const id = cryptoId();
    const startedAt = Date.now();
    console.log(
      `🎞️  Webview burst requested for ${this.user.userId} (${durationMs}ms @ ${fps}fps, id=${id})`,
    );

    this.inFlight = new Promise<BurstResult>((resolve) => {
      // Watchdog: if the webview never POSTs back, resolve with empty frames
      // so the caller (rememberMoment) can fail gracefully with a spoken
      // "I couldn't remember that" instead of hanging forever.
      //
      // Margin: capture takes `durationMs`, then the webview uploads frames.
      // At 512px JPEG q=0.7 each frame is ~50-100 KB; 6 frames = ~300-600 KB
      // of base64 over a single fetch. On a slow venue Wi-Fi the upload alone
      // can take 3-5s. Be generous — a failed remember is a worse UX than a
      // slow one.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          console.warn(
            `🎞️  Webview burst ${id} timed out for ${this.user.userId} — no frames received`,
          );
          resolve({ frames: [], startedAt, endedAt: Date.now() });
        }
      }, durationMs + 15_000);

      this.pending.set(id, {
        id,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        timer,
      });

      // Broadcast the capture request to every connected webview. Only one
      // is expected, but it's cheap to fan out.
      const payload = JSON.stringify({
        type: "capture",
        id,
        durationMs,
        fps,
        maxWidth,
        userId: this.user.userId,
      });
      for (const client of this.sseClients) {
        try {
          client.write(payload);
        } catch {
          this.sseClients.delete(client);
        }
      }
    });

    return this.inFlight.finally(() => {
      this.inFlight = null;
    });
  }

  /**
   * Called by the `/api/memory/capture` POST handler when the webview
   * uploads its captured frames. `frames` is an array of base64 JPEG
   * strings (with or without a `data:` prefix).
   */
  completeCapture(id: string, framesB64: string[]): boolean {
    const pending = this.pending.get(id);
    if (!pending) {
      console.warn(
        `🎞️  Webview burst ${id} completion for ${this.user.userId} — no pending entry (timed out?)`,
      );
      return false;
    }
    this.pending.delete(id);

    const startedAt = Date.now(); // best-effort; the SSE event time is lost
    const frames: Buffer[] = framesB64
      .map((b64) => {
        const base = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
        try {
          return Buffer.from(base, "base64");
        } catch {
          return Buffer.alloc(0);
        }
      })
      .filter((buf) => buf.length > 0);

    console.log(
      `🎞️  Webview burst ${id} delivered ${frames.length} frames for ${this.user.userId}`,
    );
    pending.resolve({ frames, startedAt, endedAt: Date.now() });
    return true;
  }

  // ── SSE plumbing ────────────────────────────────────────────────────

  addSSEClient(client: SSEWriter): void {
    this.sseClients.add(client);
  }

  removeSSEClient(client: SSEWriter): void {
    this.sseClients.delete(client);
  }

  destroy(): void {
    // Resolve any in-flight bursts with empty frames so callers don't hang.
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ frames: [], startedAt: 0, endedAt: 0 });
    }
    this.pending.clear();
    this.sseClients.clear();
  }
}

function cryptoId(): string {
  // crypto.randomUUID() is on globalThis under Bun.
  // @ts-ignore
  return (globalThis.crypto as Crypto).randomUUID();
}
