import { GoogleGenAI, Modality, type Session, type LiveServerMessage } from "@google/genai";
import type { User } from "../session/User";
import { type Mode, MODE_PROMPTS, DEFAULT_MODE } from "../agent/modes";
import { TOOL_DECLARATIONS, executeTool } from "../agent/tools";

interface SSEWriter {
  write: (data: string) => void;
  userId: string;
  close: () => void;
}

/**
 * An AI conversation event broadcast to the frontend.
 *
 * - role "user"  → a question the user asked (sent once, always done:true)
 * - role "ai"    → the model's answer / narration (streamed: chunks then done)
 */
export interface AIResponseEvent {
  role: "user" | "ai";
  text: string;
  done: boolean;
  timestamp: number;
}

/**
 * Gemini Live model — must support `bidiGenerateContent` (the Live API).
 * gemini-3.1-flash-live-preview is audio-native: it does not support TEXT
 * output, so we request AUDIO + outputAudioTranscription and use the
 * transcript as the answer text. Override via GEMINI_LIVE_MODEL.
 */
const MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";

/**
 * AIManager — owns the Gemini Live session for a single user.
 *
 * The session is connected with a system prompt that depends on the current
 * mode (passive / active / outdoor / auto). Changing mode reconnects the
 * session with the new prompt. The MasterAgent orchestrator drives the mode.
 *
 * Pipeline:
 *   camera frames (webview WHEP <video>) ──┐
 *                                          ├─▶ Gemini Live ──▶ text
 *   utterances (TranscriptionManager) ─────┘                    │
 *                                                               ▼
 *                            SSE ──▶ webview  /  mode action ──▶ MasterAgent
 */
export class AIManager {
  private sseClients: Set<SSEWriter> = new Set();
  private genai: GoogleGenAI | null = null;
  private session: Session | null = null;
  private connecting = false;

  /** Mode the session is currently connected with. */
  private mode: Mode = DEFAULT_MODE;

  /** Accumulates the current turn's text so we can parse it as a whole. */
  private currentTurnText = "";

  // Audio: AIManager just writes PCM into the continuous pipeline owned by
  // AudioManager. No per-turn open/close/queue — the pipeline runs for the
  // whole session. See AudioManager for the design rationale.

  /**
   * Timestamp of the most recent audio chunk we got from Gemini. We
   * derive "is the AI speaking right now" from this rather than from a
   * latched boolean: a boolean can get stuck on if turnComplete never
   * fires (interrupted turns, tool-only turns, SDK glitches), which
   * locked the wearer out of the AI. A timestamp can never get stuck.
   *
   * Treat the AI as "speaking" if a chunk landed within the last
   * SPEAKING_GRACE_MS milliseconds.
   */
  private lastAudioChunkAt = 0;
  private static readonly SPEAKING_GRACE_MS = 1500;

  /** Most recent camera frame (base64 JPEG), sent to Gemini at ask() time. */
  private latestFrame: string | null = null;

  constructor(private user: User) {}

  /**
   * True while the AI is currently producing audio for the active turn.
   * Used to gate side-channel playAudio() calls that would clobber the
   * stream on the phone (it has one shared AudioPlayer instance).
   */
  isSpeaking(): boolean {
    if (this.lastAudioChunkAt === 0) return false;
    return Date.now() - this.lastAudioChunkAt < AIManager.SPEAKING_GRACE_MS;
  }

  /**
   * Was the AI emitting audio within the last `withinMs` ms?
   *
   * Used by MasterAgent to gate self-speech in the mic. We can't only check
   * isSpeaking(): mic-side STT lags the AI audio by ~1-2s, so a transcription
   * arrives AFTER the AI stopped speaking. Callers pass a window covering
   * that lag (~3-4s) to drop those tail transcriptions.
   */
  msSinceLastAudio(): number {
    if (this.lastAudioChunkAt === 0) return Number.POSITIVE_INFINITY;
    return Date.now() - this.lastAudioChunkAt;
  }

  /** True once a Live session is connected and usable. */
  isConnected(): boolean {
    return this.session !== null;
  }

  /** The mode the AI session is currently running. */
  getMode(): Mode {
    return this.mode;
  }

  /**
   * Open the Gemini Live session with the current mode's prompt.
   * Idempotent — safe to call repeatedly. Reads GEMINI_API_KEY.
   */
  async connect(): Promise<void> {
    if (this.session || this.connecting) return;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

    this.connecting = true;
    console.log(`🧠 Connecting Gemini Live for ${this.user.userId} (mode: ${this.mode})`);

    try {
      this.genai = new GoogleGenAI({ apiKey });

      this.session = await this.genai.live.connect({
        model: MODEL,
        config: {
          // Audio-native model: AUDIO out + transcription gives us text.
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          // Voice: British English, female. languageCode drives the accent;
          // `Aoede` is a female prebuilt Gemini Live voice. Override via
          // GEMINI_VOICE.
          speechConfig: {
            languageCode: "en-GB",
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: process.env.GEMINI_VOICE || "Aoede",
              },
            },
          },
          systemInstruction: {
            parts: [{ text: MODE_PROMPTS[this.mode] }],
          },
          // Tools the model can call — see agent/tools.ts. Gemini decides
          // when to call them; we execute server-side and send the result
          // back via session.sendToolResponse().
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        },
        callbacks: {
          onopen: () => {
            console.log(
              `🧠 Gemini Live connected for ${this.user.userId} (model: ${MODEL}, mode: ${this.mode})`,
            );
            this.user.state.setAiConnected(true);
          },
          onmessage: (msg: LiveServerMessage) => this.handleServerMessage(msg),
          onerror: (e) => {
            console.error(`🧠 Gemini Live error for ${this.user.userId}: ${e.message}`);
            this.broadcast({ role: "ai", text: `AI error: ${e.message}`, done: true, timestamp: Date.now() });
          },
          onclose: (e) => {
            console.warn(
              `🧠 Gemini Live closed for ${this.user.userId} — code=${e.code} reason="${e.reason || "(none)"}"`,
            );
            this.session = null;
            this.lastAudioChunkAt = 0;
            this.user.state.setAiConnected(false);
          },
        },
      });
    } catch (error) {
      console.error(`🧠 Gemini Live connect failed for ${this.user.userId}:`, error);
      this.session = null;
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Switch the AI to a new mode.
   *
   * The mode is baked into the session's system prompt, so this closes and
   * reopens the Live session with the new prompt. No-op if already in `mode`.
   */
  async setMode(mode: Mode): Promise<void> {
    if (mode === this.mode) return;
    console.log(`🧭 AI mode: ${this.mode} → ${mode} for ${this.user.userId}`);
    this.mode = mode;
    this.user.state.setMode(mode);
    this.broadcastMode();

    // Reconnect with the new prompt if a session is up.
    if (this.session || this.connecting) {
      // Stop any audio still playing from the old session's turn. The
      // continuous pipeline stays open across reconnects.
      await this.user.audio.stopAudio().catch(() => {});
      try {
        this.session?.close();
      } catch {
        /* already closed */
      }
      this.session = null;
      this.connecting = false;
      await this.connect();
    }
  }

  /**
   * Receive a camera frame from the webview.
   *
   * We do NOT stream frames continuously to Gemini — that would make the
   * model narrate on its own. Instead we keep only the latest frame and
   * send it to Gemini at question time (see ask()), so the AI sees the
   * camera only when the wearer explicitly asks "Hey Gemini, …".
   *
   * @param jpegBase64 - Base64-encoded JPEG (no data: prefix).
   */
  sendFrame(jpegBase64: string): void {
    this.latestFrame = jpegBase64;
  }

  /**
   * Send a question to the model.
   *
   * The current camera frame is attached to the turn so the model can
   * answer based on what the wearer sees right now. Frames are NOT streamed
   * continuously (see sendFrame) — this is the only point the model gets
   * visual input, which keeps the AI silent until explicitly asked.
   */
  ask(text: string): void {
    if (!text.trim()) return;

    // Echo to the webview conversation log.
    console.log(`🧠 Utterance for ${this.user.userId}: "${text}"`);
    this.broadcast({ role: "user", text, done: true, timestamp: Date.now() });

    if (!this.session) {
      console.warn(`🧠 ask() ignored — no Gemini session for ${this.user.userId}`);
      this.broadcast({
        role: "ai",
        text: "AI is not connected — reconnect and try again.",
        done: true,
        timestamp: Date.now(),
      });
      return;
    }

    // Build the turn:
    //   1) Current session state — so Gemini answers state questions truthfully
    //      ("is the camera on?") and knows whether it can see right now.
    //   2) The user's question.
    //   3) The latest camera frame (only if a frame is actually available).
    const stateBlock = this.user.state.toPromptContext();
    const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [
      { text: `${stateBlock}\n\n${text}` },
    ];
    if (this.latestFrame) {
      parts.push({
        inlineData: { data: this.latestFrame, mimeType: "image/jpeg" },
      });
    }

    this.currentTurnText = "";
    this.session.sendClientContent({
      turns: [{ role: "user", parts }],
      turnComplete: true,
    });
  }

  /** Route a Gemini server message into incremental SSE events. */
  private handleServerMessage(msg: LiveServerMessage): void {
    // Tool calls — Gemini wants us to run a function (set_camera, set_mode,
    // get_state). Execute and respond on the same session.
    const toolCalls = msg.toolCall?.functionCalls;
    if (toolCalls && toolCalls.length > 0) {
      void this.handleToolCalls(toolCalls);
      // Tool calls may arrive in the same message as content; fall through
      // to continue processing audio/text.
    }

    // Answer/narration text arrives as outputTranscription chunks. Stream
    // them to the webview the instant they land — the frontend accumulates
    // chunks into the current AI message, so the user sees the answer
    // building up word-by-word (ChatGPT-style).
    const transcript = msg.serverContent?.outputTranscription?.text;
    if (transcript) {
      this.currentTurnText += transcript; // kept only for the final log line
      this.broadcast({ role: "ai", text: transcript, done: false, timestamp: Date.now() });
    }

    // The model's spoken answer arrives as inline PCM16 audio chunks.
    // Write them straight into the continuous audio pipeline — no per-turn
    // open/close, no queuing. ffmpeg encodes to MP3 on the fly and the
    // SDK stream plays it. The pipeline lives for the entire session.
    for (const part of msg.serverContent?.modelTurn?.parts ?? []) {
      const inline = part.inlineData;
      if (inline?.data && inline.mimeType?.startsWith("audio/")) {
        // Refresh the speaking timestamp on every chunk. isSpeaking()
        // returns true while chunks keep flowing and naturally expires
        // SPEAKING_GRACE_MS after they stop — no stuck-true state.
        this.lastAudioChunkAt = Date.now();
        this.user.audio.writePcm(Buffer.from(inline.data, "base64"));
      }
    }

    // If the model interrupts itself, stop the current playback. The
    // continuous pipeline stays open; only the in-flight audio is cut.
    if (msg.serverContent?.interrupted) {
      this.lastAudioChunkAt = 0;
      void this.user.audio.stopAudio().catch(() => {});
    }

    if (!msg.serverContent?.turnComplete) return;
    // Don't zero lastAudioChunkAt here — let the grace window finish
    // naturally so the self-speech gate stays armed for the trailing STT
    // (the mic-side transcription lags a beat behind the audio).

    // Turn complete — close out the streaming AI message in the webview.
    // The text itself was already streamed chunk-by-chunk above; this is
    // just the "done" marker.
    const full = this.currentTurnText.trim();
    this.currentTurnText = "";
    if (full) console.log(`🧠 Answer for ${this.user.userId}: "${full}"`);
    this.broadcast({ role: "ai", text: "", done: true, timestamp: Date.now() });

    // Tell the orchestrator the AI just stopped talking. If expect_reply
    // was called this turn, this is when MasterAgent fires the follow-up
    // cue and opens the listening window.
    this.user.agent.onAiTurnComplete();
  }

  /**
   * Execute one or more tool calls and send the results back to Gemini.
   * Gemini then composes a natural-language reply incorporating the result.
   */
  private async handleToolCalls(
    calls: NonNullable<NonNullable<LiveServerMessage["toolCall"]>["functionCalls"]>,
  ): Promise<void> {
    if (!this.session) return;
    const responses = await Promise.all(
      calls.map(async (call) => {
        const result = await executeTool(this.user, call);
        return {
          id: call.id,
          name: call.name,
          response: result as unknown as Record<string, unknown>,
        };
      }),
    );
    try {
      this.session.sendToolResponse({ functionResponses: responses });
    } catch (error) {
      console.error(`🛠 sendToolResponse failed for ${this.user.userId}:`, error);
    }
  }

  /** Push an AI response event to every connected SSE client. */
  private broadcast(event: AIResponseEvent): void {
    const payload = JSON.stringify({ type: "message", ...event, userId: this.user.userId });
    this.send(payload);
  }

  /** Tell SSE clients the current mode. */
  broadcastMode(): void {
    this.send(JSON.stringify({ type: "mode", mode: this.mode, userId: this.user.userId }));
  }

  private send(payload: string): void {
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

  /** Close the Live session, stop audio, and drop all SSE clients. */
  destroy(): void {
    // Stop anything still playing on the glasses. The continuous audio
    // pipeline is owned by AudioManager and torn down in User.cleanup().
    void this.user.audio.stopAudio().catch(() => {});
    try {
      this.session?.close();
    } catch {
      /* already closed */
    }
    this.session = null;
    this.genai = null;
    this.connecting = false;
    this.lastAudioChunkAt = 0;
    this.latestFrame = null;
    this.sseClients.clear();
  }
}

