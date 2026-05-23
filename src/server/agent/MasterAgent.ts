import type { User } from "../session/User";
import type { Mode } from "./modes";
import { routeIntent } from "./IntentRouter";
import { rememberMoment } from "./tools/rememberMoment";
import { recallMemories } from "./tools/recallMemories";

/**
 * Wake phrase: "Hey Gemini". STT mangles both words, so we tolerate common
 * mishearings. Optional "Hey" — bare "Gemini" also works.
 */
const HEY_VARIANTS = ["hey", "hi", "ay", "a"];
const GEMINI_VARIANTS = ["gemini", "jiminy", "geminy", "gemeni", "jiminey", "gemoni", "jimena"];
const WAKE_REGEX = new RegExp(
  `^["'\`.,\\s]*(?:(?:${HEY_VARIANTS.join("|")})[,\\s]+)?(?:${GEMINI_VARIANTS.join("|")})\\b`,
  "i",
);

/**
 * MasterAgent — the orchestrator.
 *
 * The AI is wake-word-gated: it only responds to "Hey Gemini, …". A
 * wake-word utterance is sent straight to the AI as a question — there is
 * NO per-question mode flip. (The old design switched to an "active" mode
 * and reverted 8s later; that reconnected the Gemini session and tore down
 * the audio stream mid-answer, cutting off playback.)
 *
 * Mode here just flavors the AI's behavior/prompt. It changes only on an
 * explicit request — a webview button or a voice command Gemini recognizes
 * — never automatically per question.
 */
export class MasterAgent {
  /**
   * Whether the activation sound has already played for the current
   * utterance. Set when we detect the wake phrase in a PARTIAL transcript;
   * cleared when the FINAL transcription arrives (end of utterance).
   * Prevents double-binging the same sentence.
   */
  private wakeFiredThisUtterance = false;

  /** Timestamp (ms) the wake sound played, so we can compute the residual
   *  wait for the post-bing pause. 0 = hasn't fired this utterance. */
  private wakeFiredAt = 0;

  /**
   * Window (ms) from the AI's last audio chunk during which an incoming
   * transcription is assumed to be the AI hearing itself in the mic, not
   * a real wearer utterance. Covers STT's ~1-2s lag plus a margin so a
   * full-sentence AI answer's trailing transcript still lands inside the
   * gate. Set higher if you still see self-feedback, lower if it eats
   * real fast follow-ups.
   */
  private static readonly SELF_SPEECH_COOLDOWN_MS = 4000;

  constructor(private user: User) {}

  /**
   * Wire the orchestrator to the AI session. Called once at session setup.
   *
   * Voice-driven mode changes now go through Gemini's set_mode TOOL (see
   * agent/tools.ts) — no per-utterance JSON-sentinel handler needed here.
   * The tool executor calls user.agent.setMode() directly.
   */
  setup(): void {
    /* no-op: tool wiring lives in agent/tools.ts */
  }

  /** The mode currently active. */
  getMode(): Mode {
    return this.user.ai.getMode();
  }

  /**
   * Called by AIManager when the AI's current turn finishes speaking.
   * Currently a no-op — follow-up windows were removed because the
   * acoustic feedback loop (glasses speaker → mic → STT → AI) made them
   * impossible to keep open safely. Every interaction now requires
   * "Hey Gemini". Kept on the interface so AIManager doesn't need to
   * change in lockstep, and so future additions hook here.
   */
  onAiTurnComplete(): void {
    /* no-op for now */
  }

  /**
   * True if the AI is talking right now OR talked within the last few
   * seconds (the mic-side STT lags the speaker by 1-2s, so finals arrive
   * AFTER the AI stopped). Anchored to the AI's last audio chunk in time
   * — never gets stuck on. If the AI never speaks (tool-only turn), this
   * is always false, so the user is never wrongly muted.
   */
  private isLikelySelfSpeech(): boolean {
    return this.user.ai.msSinceLastAudio() < MasterAgent.SELF_SPEECH_COOLDOWN_MS;
  }

  /**
   * Called for every PARTIAL transcription as the wearer is still speaking.
   *
   * The job is one thing only: as soon as "Hey Gemini" appears at the start
   * of the partial, fire the activation sound. We don't ask the AI anything
   * yet — we wait for the final transcript so we have the full question.
   * The bing happens NOW so the wearer hears the cue mid-sentence.
   */
  handlePartial(text: string): void {
    if (this.wakeFiredThisUtterance) return;
    if (!this.user.ai.isConnected()) return;
    if (this.isLikelySelfSpeech()) return;  // mic is picking up the AI itself
    if (extractWakeQuestion(text) === null) return;

    this.wakeFiredThisUtterance = true;
    this.wakeFiredAt = Date.now();
    console.log(`🔔 Wake word heard in partial — playing activation sound (${this.user.userId})`);
    this.playActivationCue("wake word in partial");
  }

  /**
   * Handle one final transcription from the wearer.
   *
   * Only "Hey Gemini, …" reaches the AI; everything else is ignored (it
   * still shows as a caption via TranscriptionManager). Only call with
   * `isFinal` transcriptions.
   */
  handleUtterance(text: string): void {
    // End of utterance — snapshot then reset the wake gate so the next
    // sentence can re-arm the activation sound.
    const wakeAlreadyFired = this.wakeFiredThisUtterance;
    const wakeFiredAtSnapshot = this.wakeFiredAt;
    this.wakeFiredThisUtterance = false;
    this.wakeFiredAt = 0;

    const trimmed = text.trim();
    if (!trimmed) return;

    // Drop transcriptions that are the AI hearing its own voice through the
    // glasses mic. Without this gate the AI sends its answer back to itself
    // as a "user reply" → another expect_reply → infinite feedback loop.
    if (this.isLikelySelfSpeech()) {
      console.log(`🔇 Ignoring self-speech (${this.user.userId}): "${trimmed}"`);
      return;
    }

    if (!this.user.ai.isConnected()) {
      // No AI session — nothing to route to.
      return;
    }

    const question = extractWakeQuestion(trimmed);
    if (question === null) {
      // No wake phrase — AI stays silent.
      return;
    }

    // If the wake phrase only showed up in the final (no matching partial
    // first), play the activation sound now as a fallback.
    let bingStartedAt = wakeFiredAtSnapshot;
    if (!wakeAlreadyFired) {
      console.log(`🔔 Wake word in final only — playing activation sound (${this.user.userId})`);
      this.playActivationCue("wake word in final");
      bingStartedAt = Date.now();
    }

    if (question.length === 0) {
      console.log(`🟡 Wake word with no question (${this.user.userId})`);
      return;
    }

    // Hold the question for 2 seconds after the activation sound started
    // so the bing finishes playing before Gemini's voice takes over. With
    // partial-detection, the bing usually fired 1-2s ago while the wearer
    // was still talking, so the residual wait is small or zero.
    const elapsed = Date.now() - bingStartedAt;
    const wait = Math.max(0, 2000 - elapsed);
    setTimeout(() => {
      void this.route(question);
    }, wait);
  }

  /**
   * Route a post-wake-phrase utterance.
   *
   *   "remember this" / "save the keys"     → memory store path
   *   "where are my keys?" / "did I take X" → memory recall path
   *   anything else                         → existing Gemini Live ask()
   *
   * Memory branches speak their result through AudioManager.speak() (the
   * SDK's server-side TTS), which is separate from the continuous Gemini
   * Live PCM pipeline. They DON'T touch the Gemini Live session, so the
   * existing realtime flow is untouched.
   */
  private async route(question: string): Promise<void> {
    const { intent, payload } = await routeIntent(question);

    if (intent === "remember") {
      console.log(`🧠💾 Intent: remember (${this.user.userId}) — "${payload}"`);
      try {
        const result = await rememberMoment(this.user, { reason: payload });
        await this.user.audio.speak(result.spoken).catch(() => {});
      } catch (error) {
        console.error(`🧠💾 rememberMoment failed for ${this.user.userId}:`, error);
        await this.user.audio
          .speak("I couldn't remember that — try again.")
          .catch(() => {});
      }
      return;
    }

    if (intent === "recall") {
      console.log(`🧠🔎 Intent: recall (${this.user.userId}) — "${payload}"`);
      try {
        const result = await recallMemories(this.user, { query: payload });
        await this.user.audio.speak(result.spoken).catch(() => {});
      } catch (error) {
        console.error(`🧠🔎 recallMemories failed for ${this.user.userId}:`, error);
        await this.user.audio
          .speak("I'm having trouble checking my memory right now.")
          .catch(() => {});
      }
      return;
    }

    // Default: existing Gemini Live path.
    this.user.ai.ask(question);
  }

  /**
   * Switch mode. `source` is for logging only (manual button, voice command).
   * Changing mode reconnects the Gemini session, so this is deliberately
   * NOT done per question — only on explicit user intent.
   */
  async setMode(mode: Mode, source: string): Promise<void> {
    if (mode === this.getMode()) return;
    console.log(`🧭 MasterAgent: mode → ${mode} (${source}) for ${this.user.userId}`);
    await this.user.ai.setMode(mode);
  }

  /**
   * Play the activation cue — but only if the AI isn't currently speaking.
   *
   * Why: the phone has a single shared AudioPlayer. Calling playAudio()
   * during a Gemini turn does `player.replace(url)` and silently swaps the
   * source, killing the in-flight stream and dropping the rest of the
   * answer. Skipping the bing when speaking preserves the answer.
   */
  private playActivationCue(reason: string): void {
    if (this.user.ai.isSpeaking()) {
      console.log(`🔕 Skipping activation cue (${reason}) — AI is speaking (${this.user.userId})`);
      return;
    }
    void this.user.audio.playActionSound("audio/start-vision.mp3");
  }
}

/**
 * If `text` starts with the wake phrase, return the question after it
 * (wake phrase stripped). Returns null when there is no wake phrase.
 */
function extractWakeQuestion(text: string): string | null {
  const match = text.match(WAKE_REGEX);
  if (!match) return null;
  return text.slice(match[0].length).replace(/^["'`.,!?\s]+/, "").trim();
}
