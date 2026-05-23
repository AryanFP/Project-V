import type { AppSession, ManagedStreamStatus } from "@mentra/sdk";
import type { User } from "../session/User";

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
      // If the SDK still thinks a stream is open (e.g. left over from a
      // failed attempt on a prior session), stop it first — startManagedStream
      // throws "Already streaming" otherwise.
      const existing = await session.camera.checkExistingStream().catch(() => null);
      if (existing?.hasActiveStream) {
        console.log(`📹 Found existing stream for ${this.user.userId}, stopping it first`);
        await session.camera.stopManagedStream().catch(() => {});
      }

      // Managed stream with WebRTC enabled → sub-second WHEP playback.
      // No restreamDestinations — passing those would silently drop
      // WebRTC mode in favor of SRT/HLS.
      // We don't use the stream's audio anywhere — the AI talks through the
      // glasses speaker, the webview renders the WHEP video muted. The SDK
      // has no explicit "video only" flag, so we starve the audio path:
      // lowest sample rate + bitrate, no echo cancellation / noise
      // suppression. The publisher still emits audio (we can't stop that
      // from app code), but it's a minimum-effort stream we discard.
      const result = await session.camera.startManagedStream({
        quality: "720p",
        enableWebRTC: true,
        audio: {
          bitrate: 8_000,        // 8 kbps — the floor
          sampleRate: 8_000,     // 8 kHz — telephone-grade, minimal CPU
          echoCancellation: false,
          noiseSuppression: false,
        },
      });

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
        `📹 Livestream ready for ${this.user.userId} — webrtc=${result.webrtcUrl ?? "none"}`,
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
   * If a livestream is still up, stop it first — otherwise the glasses /
   * Cloudflare stream keeps running after the session ends. This is called
   * from User.cleanup() on session disconnect, so we must send the stop
   * request before the AppSession's WebSocket is gone.
   */
  destroy(): void {
    if (this.isStreamUp() && this.user.appSession) {
      console.log(`📹 Session ending — force-stopping livestream for ${this.user.userId}`);
      try {
        // Fire-and-forget: stopManagedStream() just sends a message; we can't
        // await here because the session is being torn down around us.
        this.user.appSession.camera.stopManagedStream();
      } catch (error) {
        console.error(`📹 Failed to stop livestream during cleanup for ${this.user.userId}:`, error);
      }
    }

    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sseClients.clear();
    // Don't call setLocalState here — User may already be tearing down, and
    // we don't want to broadcast/mirror a dead-final status during cleanup.
    this.state = { status: "inactive" };
    this.user.state.setStreamStatus("inactive");
  }
}
