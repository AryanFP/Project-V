import type { AppSession, ManagedStreamStatus } from "@mentra/sdk";
import type { User } from "../session/User";

/**
 * Constants mirrored from the sibling Livestreamer app
 * (Livestreamer/src/server/utils/constants.ts and stream.service.ts).
 * Livestreamer's stream lifecycle is rock-solid in production; we follow
 * its delays + timeouts exactly so a restart isn't a coin flip.
 */
/** How long to wait after stopManagedStream before assuming the stream is
 *  actually gone. Matches Livestreamer's STREAM_STOP_DELAY (2000ms). */
const STREAM_STOP_DELAY_MS = 2000;
/** Hard cap on a single startManagedStream call. Mirrors Livestreamer. */
const STREAM_START_TIMEOUT_MS = 45_000;

/**
 * Video config we send to startManagedStream. Mirrors Livestreamer's
 * buildVideoConfig(1) (1 Mbps, 720x480 @ 20fps) which is their default
 * preset for managed Cloudflare streams. The Mentra SDK accepts this shape
 * directly under the `video` key.
 *
 * Why NOT { quality: "720p", enableWebRTC: true, audio: {...} } anymore:
 *   - Livestreamer doesn't pass enableWebRTC at all (SDK enables WebRTC by
 *     default for managed streams) and doesn't pass an audio config.
 *   - The aggressive 8kHz/8kbps audio override we used to send was the most
 *     likely culprit for the SDP-negotiation flakiness we saw.
 */
const VIDEO_CONFIG = {
  width: 720,
  height: 480,
  bitrate: 1_000_000, // 1 Mbps
  frameRate: 20,
} as const;

interface SSEWriter {
  write: (data: string) => void;
  userId: string;
  close: () => void;
}

/**
 * Snapshot of the current livestream, broadcast to the frontend.
 *
 * `status` mirrors the cloud's ManagedStreamStatus lifecycle:
 *   inactive → initializing → preparing → active → stopping → stopped
 * (`error` can occur at any point).
 */
export interface LiveStreamState {
  status:
    | "inactive"
    | "initializing"
    | "preparing"
    | "active"
    | "stopping"
    | "stopped"
    | "error";
  /** WHEP playback URL — sub-second WebRTC. Only set once `status === "active"`. */
  webrtcUrl?: string;
  /** HLS fallback URL (higher latency). */
  hlsUrl?: string;
  /** Human-readable message, mainly for the `error` state. */
  message?: string;
}

/**
 * LiveStreamManager — owns the glasses → cloud → Cloudflare WebRTC livestream
 * for a single user.
 *
 * The app never touches WebRTC plumbing. It calls the SDK's managed-stream
 * API; the cloud creates the Cloudflare live input (WHIP ingest / WHEP
 * playback), tells the glasses to publish, and pushes status updates back.
 * This manager just drives that API and relays the resulting state — most
 * importantly the WHEP `webrtcUrl` — to connected SSE clients (the webview).
 */
export class LiveStreamManager {
  private sseClients: Set<SSEWriter> = new Set();
  private unsubscribe: (() => void) | null = null;

  /** Latest known state — replayed to every newly connected SSE client. */
  private state: LiveStreamState = { status: "inactive" };

  constructor(private user: User) {}

  /**
   * Wire up the managed-stream status listener on the glasses session.
   * Called from User.setAppSession().
   */
  setup(session: AppSession): void {
    this.unsubscribe = session.camera.onManagedStreamStatus(
      (status: ManagedStreamStatus) => {
        console.log(
          `📹 Managed stream status (${this.user.userId}): ${status.status}`,
        );

        this.setLocalState({
          status: status.status,
          webrtcUrl: status.webrtcUrl,
          hlsUrl: status.hlsUrl,
          message: status.message,
        });
      },
    );
  }

  /**
   * Start a managed WebRTC livestream.
   *
   * Resolves once the cloud reports the stream ready (URLs available).
   * Status updates also arrive asynchronously via onManagedStreamStatus,
   * so SSE clients see the full lifecycle regardless.
   */
  async start(): Promise<LiveStreamState> {
    const session = this.user.appSession;
    if (!session) throw new Error("No active glasses session");

    if (this.state.status === "active" || this.state.status === "preparing") {
      console.log(`📹 Livestream already running for ${this.user.userId}`);
      return this.state;
    }

    console.log(`📹 Starting WebRTC livestream for ${this.user.userId}`);
    this.setLocalState({ status: "initializing" });

    // Snapshot the session we started with. If a session error tears down
    // this manager mid-request, `this.user.appSession` may point at a NEW
    // session by the time the request settles — guard against writing stale
    // state onto it.
    const startedWith = session;

    try {
      // ─── STOP existing stream with verify ─────────────────────────────
      // Mirror Livestreamer's stopExistingStreamIfNeeded: stop, wait 2s,
      // verify it's actually gone, wait another 2s if not. Without these
      // delays we routinely got "Managed stream failed" when restarting
      // because the cloud was still mid-teardown when we issued start().
      await this.stopExistingStreamIfNeeded(session);

      // ─── START with 45s timeout + disconnect race ─────────────────────
      // Livestreamer wraps startManagedStream in Promise.race against
      // (a) a 45s timeout and (b) the session-disconnected event. Either
      // racing rejection beats the SDK silently hanging on a flaky WS.
      // SDK enables WebRTC by default for managed streams — we don't pass
      // enableWebRTC, audio, or quality (see VIDEO_CONFIG comment above).
      const result = await this.runStartWithTimeout(session, { video: VIDEO_CONFIG });

      // The session may have been replaced while we awaited.
      if (this.user.appSession !== startedWith) {
        console.warn(`📹 Session changed during start for ${this.user.userId}, discarding result`);
        return this.state;
      }

      this.setLocalState({
        status: "active",
        webrtcUrl: result.webrtcUrl,
        hlsUrl: result.hlsUrl,
      });
      console.log(
        `📹 Livestream ready for ${this.user.userId} — webrtc=${result.webrtcUrl ?? "none"} hls=${result.hlsUrl ?? "none"}`,
      );
      return this.state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`📹 Livestream failed for ${this.user.userId}:`, message);
      // Only write error state if this manager still owns the live session.
      if (this.user.appSession === startedWith || this.user.appSession === null) {
        this.setLocalState({ status: "error", message });
      }
      throw error;
    }
  }

  /**
   * Stop any existing managed stream and wait for it to fully tear down
   * before returning. Mirrors Livestreamer's stopExistingStreamIfNeeded
   * (Livestreamer/src/server/services/stream.service.ts:22-74).
   *
   * Steps:
   *   1. checkExistingStream — does the cloud think one is active?
   *   2. If yes, call stopManagedStream + wait STREAM_STOP_DELAY_MS (2s).
   *   3. checkExistingStream again to verify the stop actually landed.
   *   4. If STILL active, wait another 2s. (No third check — past this
   *      point we'd rather attempt start() than block forever.)
   *
   * All errors swallowed: cleanup is best-effort. The subsequent start()
   * call will surface any real problem.
   */
  private async stopExistingStreamIfNeeded(session: AppSession): Promise<void> {
    try {
      const existing = await session.camera.checkExistingStream().catch(() => null);
      if (!existing?.hasActiveStream) return;

      console.log(
        `📹 Found existing managed stream for ${this.user.userId}, stopping it first…`,
      );
      await session.camera.stopManagedStream().catch((e) =>
        console.warn(
          `📹 stopManagedStream during pre-start failed for ${this.user.userId}:`,
          e instanceof Error ? e.message : e,
        ),
      );
      await sleep(STREAM_STOP_DELAY_MS);

      // Verify it actually stopped (Livestreamer's "stopped?" recheck).
      const recheck = await session.camera.checkExistingStream().catch(() => null);
      if (recheck?.hasActiveStream) {
        console.log(
          `📹 Stream still active for ${this.user.userId} after stop — waiting another ${STREAM_STOP_DELAY_MS}ms…`,
        );
        await sleep(STREAM_STOP_DELAY_MS);
      }
    } catch (error) {
      console.warn(
        `📹 pre-start cleanup error for ${this.user.userId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Race startManagedStream against three rejection paths:
   *   1. Session disconnect — onDisconnected fires before the start
   *      resolves. Rejects with a clear "glasses disconnected" error so
   *      callers don't burn 45s on a dead connection.
   *   2. 45s wall-clock timeout — the SDK sometimes hangs silently when
   *      WiFi flaps. Rejecting lets a retry attempt start fresh.
   *   3. startManagedStream itself resolves/rejects.
   *
   * Mirrors Livestreamer's startManagedStream wrapper
   * (Livestreamer/src/server/services/stream.service.ts:143-193). The
   * cleanup block runs in `finally` so the listener + timer are released
   * even when the start resolves successfully.
   */
  private async runStartWithTimeout(
    session: AppSession,
    options: { video: typeof VIDEO_CONFIG },
  ): Promise<{ webrtcUrl?: string; hlsUrl?: string }> {
    const streamPromise = session.camera.startManagedStream(options as any);

    const cleanup: {
      disconnectUnsubscribe?: () => void;
      timeoutId?: ReturnType<typeof setTimeout>;
    } = {};

    const disconnectPromise = new Promise<never>((_, reject) => {
      const handler = () =>
        reject(
          new Error(
            "Glasses disconnected during stream start. Reconnect to WiFi and try again.",
          ),
        );
      // SDK returns an unsubscribe fn we must call in finally.
      try {
        cleanup.disconnectUnsubscribe = session.events.onDisconnected(handler);
      } catch {
        /* SDK may not expose this in older builds — best-effort. */
      }
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      cleanup.timeoutId = setTimeout(
        () =>
          reject(new Error("Stream start timeout — request took too long")),
        STREAM_START_TIMEOUT_MS,
      );
    });

    try {
      return (await Promise.race([streamPromise, disconnectPromise, timeoutPromise])) as {
        webrtcUrl?: string;
        hlsUrl?: string;
      };
    } finally {
      cleanup.disconnectUnsubscribe?.();
      if (cleanup.timeoutId) clearTimeout(cleanup.timeoutId);
    }
  }

  /** Stop the current managed livestream. */
  async stop(): Promise<void> {
    const session = this.user.appSession;
    if (!session) throw new Error("No active glasses session");

    console.log(`📹 Stopping livestream for ${this.user.userId}`);
    this.setLocalState({ status: "stopping" });

    try {
      await session.camera.stopManagedStream();
      this.setLocalState({ status: "stopped" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`📹 Failed to stop livestream for ${this.user.userId}:`, message);
      this.setLocalState({ status: "error", message });
    }
  }

  /** Current livestream state — used to seed a new SSE client. */
  getState(): LiveStreamState {
    return this.state;
  }

  /**
   * Set the local state, mirror it into UserState (so the AI sees it), and
   * broadcast over SSE. Single chokepoint for all status transitions.
   */
  private setLocalState(state: LiveStreamState): void {
    this.state = state;
    this.user.state.setStreamStatus(state.status);
    this.broadcastState();
  }

  /** Push the current state to every connected SSE client. */
  private broadcastState(): void {
    const payload = JSON.stringify({ ...this.state, userId: this.user.userId });
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  addSSEClient(client: SSEWriter): void {
    this.sseClients.add(client);
  }

  removeSSEClient(client: SSEWriter): void {
    this.sseClients.delete(client);
  }

  /** True if a stream is running or coming up. */
  private isStreamUp(): boolean {
    return (
      this.state.status === "active" ||
      this.state.status === "initializing" ||
      this.state.status === "preparing"
    );
  }

  /**
   * Tear down the manager.
   *
   * Force-stops the livestream UNCONDITIONALLY — we don't trust our local
   * state, because the SDK can lose its status WS without ever telling us
   * the stream went down. Worst case the stop call is a no-op; best case
   * we save the wearer's bandwidth + Cloudflare minutes that would
   * otherwise leak after the session ends.
   *
   * Strategy:
   *   1. Best-effort `stopManagedStream()` on the local AppSession.
   *   2. A second attempt 200ms later — covers a transient
   *      CONNECTING / CLOSING window where the first call no-ops.
   *   3. Also issue checkExistingStream → stopManagedStream on the live
   *      session if it survives the cleanup race.
   *
   * Every leg is swallowed (sync throw AND async reject), so the dev
   * server can't crash even if the SDK is mid-reconnect.
   */
  destroy(): void {
    const session = this.user.appSession;
    if (session) {
      console.log(
        `📹 Session ending — force-stopping livestream for ${this.user.userId} (local state=${this.state.status})`,
      );

      // Attempt 1: immediate stop. Don't gate on local state — if the SDK
      // thinks there's no stream this is a cheap no-op; if there IS one we
      // catch it before the AppSession's WebSocket goes away.
      this.safeStopManagedStream(session, "attempt-1-immediate");

      // Attempt 2: retry once after a beat. Covers the case where the WS
      // was CONNECTING / CLOSING at attempt-1's call site. We can't await
      // here (cleanup is sync), so schedule and forget.
      setTimeout(() => {
        const stillSession = this.user.appSession;
        // After 200ms the User may have been recycled — only target the
        // ORIGINAL session we started cleanup with, never a new one.
        if (stillSession === session || stillSession === null) {
          this.safeStopManagedStream(session, "attempt-2-delayed");
        }
      }, 200);

      // Attempt 3: ask the cloud "is there a stream up?" and stop it if so.
      // This catches the edge case where our local state says inactive but
      // the cloud still has an orphan stream open (which has bitten us
      // before — see start()'s checkExistingStream path).
      this.safeCheckAndStop(session);
    } else {
      console.log(
        `📹 Session ending — no AppSession on ${this.user.userId}, cannot send stop`,
      );
    }

    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sseClients.clear();
    // Don't call setLocalState here — User may already be tearing down, and
    // we don't want to broadcast/mirror a dead-final status during cleanup.
    this.state = { status: "inactive" };
    this.user.state.setStreamStatus("inactive");
  }

  /**
   * Best-effort wrapper for session.camera.stopManagedStream().
   *
   * Swallows BOTH sync throws (WS in CONNECTING/CLOSING state throws
   * synchronously from send()) AND async rejections (cloud returned an
   * error or the WS closed mid-call). Either is fine here — the goal is
   * "make a noise at the cloud telling it to shut the stream down" and
   * we've done our part as long as the call was issued.
   */
  private safeStopManagedStream(session: AppSession, tag: string): void {
    try {
      const promise = session.camera.stopManagedStream();
      if (promise && typeof (promise as Promise<unknown>).catch === "function") {
        (promise as Promise<unknown>).catch((error) => {
          console.error(
            `📹 [${tag}] stopManagedStream rejected for ${this.user.userId}:`,
            error instanceof Error ? error.message : error,
          );
        });
      } else {
        console.log(
          `📹 [${tag}] stopManagedStream issued for ${this.user.userId}`,
        );
      }
    } catch (error) {
      console.error(
        `📹 [${tag}] stopManagedStream threw for ${this.user.userId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Ask the cloud whether ANY managed stream is still attributed to this
   * session — and if so, stop it. Belt-and-suspenders against the case
   * where our local state went stale and `stopManagedStream` on its own
   * was a no-op because the SDK didn't think a stream existed.
   *
   * Fully async + fire-and-forget; rejections logged, never thrown.
   */
  private safeCheckAndStop(session: AppSession): void {
    void (async () => {
      try {
        const existing = await session.camera.checkExistingStream();
        if (existing?.hasActiveStream) {
          console.log(
            `📹 [attempt-3-check] cloud reports stream still active for ${this.user.userId}, sending stop`,
          );
          this.safeStopManagedStream(session, "attempt-3-check");
        }
      } catch (error) {
        // checkExistingStream itself can fail mid-cleanup — that's fine,
        // we've already issued attempts 1 and 2.
        console.error(
          `📹 [attempt-3-check] checkExistingStream failed for ${this.user.userId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    })();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
