import { GoogleGenAI } from "@google/genai";
import type { User } from "../session/User";

/**
 * ProactiveWatcher — server-side periodic scene watcher for "proactive" mode.
 *
 * Every ~3 seconds, takes the latest camera frame from AIManager and asks
 * a SEPARATE Gemini 3.5 Flash call: "is there anything a blind wearer
 * should know about right now? If yes, what?". When the answer is yes,
 * the narration is spoken through AudioManager.speak (SDK TTS), NOT
 * through the Gemini Live PCM pipeline — that keeps the wake-word voice
 * loop entirely untouched.
 *
 * Critically:
 *   - Two separate Gemini sessions in the same process: Live (owned by
 *     AIManager, wake-word Q&A) and Flash polling (owned here). They do
 *     NOT share state. If polling crashes, wake-word still works.
 *   - This watcher pauses while the wearer is speaking or the AI is
 *     mid-answer. The wearer's wake-word always wins.
 *   - Repetition is suppressed both by a recent-narration memory and by
 *     a hard cooldown between any two narrations.
 */

/** Poll interval. Every ~N seconds we check whether to narrate. */
const POLL_INTERVAL_MS = 3000;

/** Hard floor between consecutive narrations, regardless of content. */
const MIN_GAP_BETWEEN_NARRATIONS_MS = 8000;

/** How many recent narrations to remember for repetition suppression. */
const RECENT_NARRATIONS_KEEP = 4;

/** Window in which a wearer transcription pauses the watcher. */
const RECENT_WEARER_SPEECH_MS = 4000;

/** Window in which AI self-speech pauses the watcher (see AIManager). */
const RECENT_AI_SPEECH_MS = 4000;

const MODEL =
  process.env.GEMINI_PROACTIVE_MODEL || "gemini-3.5-flash";

interface ProactiveJudgement {
  shouldSpeak: boolean;
  /** The narration to say (1 short sentence). Only present when shouldSpeak. */
  narration?: string;
}

export class ProactiveWatcher {
  private genai: GoogleGenAI | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  /** Last AI-spoken narration text, plus timestamp (ms). */
  private recentNarrations: Array<{ text: string; at: number }> = [];
  /** Last time any narration was spoken — used for the hard cooldown. */
  private lastNarrationAt = 0;
  /** Last time the wearer was transcribed — gate against talking over them. */
  private lastWearerSpeechAt = 0;

  constructor(private user: User) {}

  /** True if the polling loop is running. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Start the polling loop. Idempotent — calling while running is a no-op.
   * Caller is responsible for only starting when proactive mode is active
   * AND the livestream is up.
   */
  start(): void {
    if (this.timer) return;
    console.log(
      `👁️  Proactive watcher started for ${this.user.userId} (every ${POLL_INTERVAL_MS}ms)`,
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  /**
   * Stop the polling loop. Safe to call when not running.
   * Does NOT clear recent-narration state — keep it across pauses so the
   * AI doesn't immediately repeat itself if proactive mode flips off + on.
   */
  stop(): void {
    if (!this.timer) return;
    console.log(`👁️  Proactive watcher stopped for ${this.user.userId}`);
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Stop + clear all state. Called from User.cleanup. */
  destroy(): void {
    this.stop();
    this.recentNarrations = [];
    this.lastNarrationAt = 0;
    this.lastWearerSpeechAt = 0;
    this.genai = null;
  }

  /**
   * Called by TranscriptionManager whenever the wearer's voice is heard.
   * Gives the watcher a hint to pause briefly so we don't talk over them.
   */
  noteWearerSpeech(): void {
    this.lastWearerSpeechAt = Date.now();
  }

  // ── Internals ───────────────────────────────────────────────────────

  /** Per-tick counter so log lines are easy to correlate. */
  private tickCount = 0;

  private async tick(): Promise<void> {
    this.tickCount++;
    const n = this.tickCount;

    if (this.inFlight) {
      console.log(`👁️  tick #${n} (${this.user.userId}): SKIP — prev call still in flight`);
      return;
    }

    const skipReason = this.pollSkipReason();
    if (skipReason) {
      console.log(`👁️  tick #${n} (${this.user.userId}): SKIP — ${skipReason}`);
      return;
    }

    const frame = this.user.ai.peekLatestFrame();
    if (!frame) {
      console.log(`👁️  tick #${n} (${this.user.userId}): SKIP — no frame yet`);
      return;
    }

    console.log(`👁️  tick #${n} (${this.user.userId}): asking Gemini…`);
    this.inFlight = true;
    const startedAt = Date.now();
    try {
      const judgement = await this.askGemini(frame);
      const dur = Date.now() - startedAt;
      if (!judgement.shouldSpeak || !judgement.narration) {
        console.log(
          `👁️  tick #${n} (${this.user.userId}): Gemini → silent (${dur}ms)`,
        );
        return;
      }

      // Repetition guard: skip if the new narration is too similar to a
      // recent one. Cheap exact-prefix check — good enough for the demo;
      // the prompt also forbids repetition.
      if (this.isRepetitive(judgement.narration)) {
        console.log(
          `👁️  tick #${n} (${this.user.userId}): Gemini → REPEAT-SUPPRESSED "${judgement.narration}" (${dur}ms)`,
        );
        return;
      }

      // Final skip check — the wearer may have started talking while
      // Gemini was thinking. Don't speak over them.
      const lateSkip = this.pollSkipReason();
      if (lateSkip) {
        console.log(
          `👁️  tick #${n} (${this.user.userId}): late-skip — ${lateSkip}`,
        );
        return;
      }

      console.log(
        `👁️  tick #${n} (${this.user.userId}): NARRATE "${judgement.narration}" (${Date.now() - startedAt}ms)`,
      );
      this.lastNarrationAt = Date.now();
      this.recentNarrations.push({ text: judgement.narration, at: Date.now() });
      if (this.recentNarrations.length > RECENT_NARRATIONS_KEEP) {
        this.recentNarrations.shift();
      }
      await this.user.audio.speak(judgement.narration).catch((err) => {
        console.warn(
          `👁️  audio.speak failed for ${this.user.userId}:`,
          err instanceof Error ? err.message : err,
        );
      });
    } catch (error) {
      console.warn(
        `👁️  Proactive tick failed for ${this.user.userId}:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Returns a human-readable skip reason, or null if we should proceed.
   * Used both before AND after the Gemini call (between thinking and
   * speaking, state may have changed — the wearer may have started
   * speaking, the AI may have started answering, etc.).
   */
  private pollSkipReason(): string | null {
    if (this.user.ai.isSpeaking()) return "AI is speaking";
    const sinceAi = this.user.ai.msSinceLastAudio();
    if (sinceAi < RECENT_AI_SPEECH_MS) return `AI spoke ${sinceAi}ms ago`;
    const sinceWearer = Date.now() - this.lastWearerSpeechAt;
    if (sinceWearer < RECENT_WEARER_SPEECH_MS) return `wearer spoke ${sinceWearer}ms ago`;
    const sinceNarration = Date.now() - this.lastNarrationAt;
    if (sinceNarration < MIN_GAP_BETWEEN_NARRATIONS_MS) return `last narration ${sinceNarration}ms ago (cooldown)`;
    const streamStatus = this.user.state.snapshot().streamStatus;
    if (streamStatus !== "active") return `stream is ${streamStatus}`;
    return null;
  }

  private isRepetitive(narration: string): boolean {
    const norm = normalize(narration);
    for (const r of this.recentNarrations) {
      const recent = normalize(r.text);
      // Exact match
      if (recent === norm) return true;
      // One contains the other (handles tiny rewording like "a chair" vs
      // "a wooden chair")
      if (recent.includes(norm) || norm.includes(recent)) return true;
    }
    return false;
  }

  private ensureGenai(): GoogleGenAI {
    if (this.genai) return this.genai;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    this.genai = new GoogleGenAI({ apiKey });
    return this.genai;
  }

  /**
   * Ask Gemini 3.5 Flash whether the current frame is worth narrating.
   *
   * Returns `{ shouldSpeak, narration? }`. Defaults to silence on parse
   * failure — the cost of false-positive chatter is high; false-negative
   * silence is cheap (the next tick is 3s away).
   */
  private async askGemini(jpegBase64: string): Promise<ProactiveJudgement> {
    const recent = this.recentNarrations
      .map((r) => `- "${r.text}"`)
      .join("\n") || "(none yet)";

    const prompt = [
      "You are the proactive eyes of a blind or low-vision wearer of smart",
      "glasses. You are being shown the wearer's current camera frame. Your",
      "job: decide whether something in this frame is WORTH telling the",
      "wearer about RIGHT NOW.",
      "",
      "CONTEXT: The wearer is at Shack15, 1 Ferry Building Suite 201, San",
      "Francisco. Timezone is Pacific (America/Los_Angeles). If you ever",
      "reference time, use Pacific Time in a natural format. Do not narrate",
      "the location itself unless it's actively useful (e.g. they walked into",
      "a new room within Shack15).",
      "",
      "Bias hard toward SILENCE. Only speak if a sighted friend standing",
      "next to the wearer would naturally lean over and say something. Good",
      "reasons to speak:",
      "  - a person is approaching the wearer, looking at them, waving, or",
      "    handing them something",
      "  - an obstacle, step, curb, or hazard is in their immediate path",
      "  - a sign / label / screen that is relevant to where they are",
      "  - the scene has materially changed (entered a new room, the lights",
      "    came on, someone arrived/left, something was placed in front of",
      "    them)",
      "",
      "Bad reasons to speak:",
      "  - the scene looks the same as before",
      "  - the wearer is sitting still looking at something static",
      "  - generic background description (\"there is a desk\", \"a wall\")",
      "  - repeating something already mentioned recently",
      "",
      "RECENT NARRATIONS YOU'VE ALREADY GIVEN (do NOT repeat these):",
      recent,
      "",
      "Return JSON ONLY, in this shape:",
      "  { \"shouldSpeak\": boolean,",
      "    \"narration\": string?  // one short sentence (≤15 words), only if shouldSpeak is true",
      "  }",
      "",
      "When in doubt, return { \"shouldSpeak\": false }.",
    ].join("\n");

    const genai = this.ensureGenai();
    const response = await genai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { data: jpegBase64, mimeType: "image/jpeg" } },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const text = response.text ?? "";
    const parsed = safeParseJson(text);
    if (!parsed || typeof parsed !== "object") {
      return { shouldSpeak: false };
    }
    const shouldSpeak = Boolean(parsed.shouldSpeak);
    const narration =
      typeof parsed.narration === "string" ? parsed.narration.trim() : "";
    if (!shouldSpeak || !narration) return { shouldSpeak: false };
    return { shouldSpeak: true, narration };
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}

function safeParseJson(text: string): any {
  if (!text) return null;
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}
