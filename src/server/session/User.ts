import { AppSession } from "@mentra/sdk";
import { PhotoManager } from "../manager/PhotoManager";
import { TranscriptionManager } from "../manager/TranscriptionManager";
import { AudioManager } from "../manager/AudioManager";
import { StorageManager } from "../manager/StorageManager";
import { InputManager } from "../manager/InputManager";
import { LiveStreamManager } from "../manager/LiveStreamManager";
import { AIManager } from "../manager/AIManager";
import { MasterAgent } from "../agent/MasterAgent";
import { UserState } from "./UserState";

/**
 * User — per-user state container.
 *
 * Composes all managers and holds the glasses AppSession.
 * Created when a user connects (glasses or webview) and
 * destroyed when the session is cleaned up.
 */
export class User {
  /** Active glasses connection, null when webview-only */
  appSession: AppSession | null = null;

  /** Photo capture, storage, and SSE broadcasting */
  photo: PhotoManager;

  /** Speech-to-text listener and SSE broadcasting */
  transcription: TranscriptionManager;

  /** Text-to-speech and audio control */
  audio: AudioManager;

  /** User preferences via MentraOS Simple Storage */
  storage: StorageManager;

  /** Button presses and touchpad gestures */
  input: InputManager;

  /** WebRTC managed livestream of the glasses camera */
  liveStream: LiveStreamManager;

  /** Gemini Live AI — sees the camera feed, answers spoken questions */
  ai: AIManager;

  /** Master orchestrator — owns the AI mode and routes utterances */
  agent: MasterAgent;

  /** Canonical session state (camera, mode, ai, …) for the AI to act on. */
  state: UserState;

  constructor(public readonly userId: string) {
    this.state = new UserState();
    this.photo = new PhotoManager(this);
    this.transcription = new TranscriptionManager(this);
    this.audio = new AudioManager(this);
    this.storage = new StorageManager(this);
    this.input = new InputManager(this);
    this.liveStream = new LiveStreamManager(this);
    this.ai = new AIManager(this);
    this.agent = new MasterAgent(this);
  }

  /** Wire up a glasses connection — sets up all event listeners */
  setAppSession(session: AppSession): void {
    this.appSession = session;
    this.state.setSessionConnected(true);
    this.transcription.setup(session);
    this.input.setup(session);
    this.liveStream.setup(session);
    this.agent.setup();
    // Open the continuous PCM→MP3→speaker pipeline up-front so AI audio
    // starts playing immediately on the first turn (no per-turn open delay).
    this.audio
      .startContinuousOutput()
      .catch((err) => console.error(`Failed to start audio pipeline for ${this.userId}:`, err));
    // Always-on AI: connect Gemini Live the moment the glasses are ready.
    // The wearer can't see the phone to tap "Connect" — it has to be there.
    this.ai
      .connect()
      .catch((err) => console.error(`Failed to auto-connect AI for ${this.userId}:`, err));
    console.log(`📸 Camera ready for ${this.userId}`);
  }

  /** Disconnect glasses but keep user alive (photos, SSE clients stay) */
  clearAppSession(): void {
    this.state.setSessionConnected(false);
    this.transcription.destroy();
    this.liveStream.destroy();
    this.ai.destroy();
    void this.audio.destroy();
    this.appSession = null;
  }

  /** Nuke everything — call on full disconnect */
  cleanup(): void {
    this.state.setSessionConnected(false);
    this.transcription.destroy();
    this.liveStream.destroy();
    this.ai.destroy();
    void this.audio.destroy();
    this.photo.destroy();
    this.appSession = null;
  }
}
