import type { Mode } from "../agent/modes";

/**
 * A snapshot of everything the AI (and the wearer) needs to know about
 * the current session — the camera, the livestream, the AI's own mode.
 *
 * One source of truth. Code reads/writes via UserState. The AI reads it
 * via context injection on every ask(), and via the get_state tool.
 */
export interface UserStateSnapshot {
  /** Glasses session connected? */
  sessionConnected: boolean;
  /**
   * Camera permission/availability per the glasses. We don't physically
   * "turn the camera on" — instead this reflects whether the livestream
   * (which is what makes the camera feed available to the AI) is up.
   */
  cameraOn: boolean;
  /** WebRTC livestream lifecycle status. */
  streamStatus:
    | "inactive"
    | "initializing"
    | "preparing"
    | "active"
    | "stopping"
    | "stopped"
    | "error";
  /** Gemini Live session connected and ready? */
  aiConnected: boolean;
  /** Active AI mode. */
  mode: Mode;
  /** Has the AI ever had at least one frame to look at this session? */
  hasFrame: boolean;
}

/** A subscriber notified whenever any state field changes. */
export type UserStateListener = (snapshot: UserStateSnapshot) => void;

/**
 * UserState — per-user observable state container.
 *
 * Holds the canonical truth (camera on, mode, etc.) so:
 *   - Code has one place to look ("is the camera on?" → state.snapshot.cameraOn)
 *   - The AI gets injected the same snapshot on every turn
 *   - The webview can subscribe via SSE and stay in sync
 *
 * Mutators (set*) return whether something actually changed, which lets
 * callers avoid spurious "okay, switching" voice confirmations.
 */
export class UserState {
  private state: UserStateSnapshot = {
    sessionConnected: false,
    cameraOn: false,
    streamStatus: "inactive",
    aiConnected: false,
    mode: "passive",
    hasFrame: false,
  };

  private listeners = new Set<UserStateListener>();

  snapshot(): UserStateSnapshot {
    return { ...this.state };
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: UserStateListener): () => void {
    this.listeners.add(listener);
    // Replay current state immediately so new subscribers are in sync.
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  setSessionConnected(on: boolean): boolean {
    return this.update({ sessionConnected: on });
  }

  setStreamStatus(status: UserStateSnapshot["streamStatus"]): boolean {
    const cameraOn = status === "active";
    return this.update({ streamStatus: status, cameraOn });
  }

  setAiConnected(on: boolean): boolean {
    return this.update({ aiConnected: on });
  }

  setMode(mode: Mode): boolean {
    return this.update({ mode });
  }

  markFrameSeen(): boolean {
    if (this.state.hasFrame) return false;
    return this.update({ hasFrame: true });
  }

  /** Apply a partial update, emit if anything actually changed. */
  private update(patch: Partial<UserStateSnapshot>): boolean {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof UserStateSnapshot)[]) {
      if (this.state[key] !== patch[key]) {
        // Per-key copy — we re-narrow via `unknown` to satisfy the TS
        // checker since each field has its own type but we're iterating
        // by string key.
        (this.state as unknown as Record<string, unknown>)[key] =
          patch[key] as unknown;
        changed = true;
      }
    }
    if (changed) {
      const snap = this.snapshot();
      for (const l of this.listeners) {
        try {
          l(snap);
        } catch {
          /* listener errors must not affect other listeners */
        }
      }
    }
    return changed;
  }

  /**
   * Render the snapshot as a short text block for injection into Gemini's
   * prompt — concise so it doesn't bloat the system instruction every turn.
   */
  toPromptContext(): string {
    const s = this.state;
    return [
      `[CURRENT STATE]`,
      `- camera: ${s.cameraOn ? "on" : "off"} (livestream: ${s.streamStatus})`,
      `- ai mode: ${s.mode}`,
      `- seen any frames yet: ${s.hasFrame ? "yes" : "no"}`,
    ].join("\n");
  }
}
