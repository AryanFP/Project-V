import type { AppSession, TranscriptionData } from "@mentra/sdk";
import type { User } from "../session/User";

interface SSEWriter {
  write: (data: string) => void;
  userId: string;
  close: () => void;
}

/**
 * TranscriptionManager — handles speech-to-text and SSE broadcasting for a single user.
 *
 * Final transcriptions are forwarded to the MasterAgent orchestrator, which
 * owns wake-word detection, mode commands, and Q&A routing. Every
 * transcription (partial or final) is also broadcast as a live caption.
 */
/**
 * One entry in the rolling transcript buffer.
 *
 * Only FINAL transcriptions land here — partials are noisy mid-utterance
 * snapshots and would duplicate text.
 */
interface TranscriptEntry {
  text: string;
  timestamp: number;
}

export class TranscriptionManager {
  private sseClients: Set<SSEWriter> = new Set();
  private unsubscribe: (() => void) | null = null;

  /**
   * Recent final transcriptions, oldest first.
   * Used by the memory agent's `rememberMoment` tool to grab the last ~10s
   * of user speech so a memory carries the surrounding spoken context
   * ("I'm putting my keys here for tonight" alongside the frames of keys).
   */
  private history: TranscriptEntry[] = [];
  /** Hard cap so a long session doesn't grow this unbounded. */
  private static readonly HISTORY_MAX_ENTRIES = 64;
  /** Anything older than this is pruned on each new entry. */
  private static readonly HISTORY_MAX_AGE_MS = 60_000;

  constructor(private user: User) {}

  /** Wire up the transcription listener on the glasses session */
  setup(session: AppSession): void {
    this.unsubscribe = session.events.onTranscription(
      (data: TranscriptionData) => {
        // Mark "wearer is speaking" on EVERY transcription event (partial
        // or final). This pauses the proactive watcher so it never speaks
        // over the wearer. Cheap signal — just a timestamp update.
        this.user.proactiveWatcher.noteWearerSpeech();

        if (data.isFinal) {
          console.log(
            `✅ Final transcription (${this.user.userId}): ${data.text}`,
          );
          this.pushToHistory(data.text);
          // Final → fully route (wake word, mode commands, Q&A).
          this.user.agent.handleUtterance(data.text);
        } else {
          // Partial → only used for early wake-word detection so the
          // activation sound fires the instant "Hey Gemini" is heard,
          // before the user finishes the sentence.
          this.user.agent.handlePartial(data.text);
        }
        this.broadcast(data.text, data.isFinal);
      },
    );
  }

  /**
   * Return the user's speech within the last `windowMs` milliseconds,
   * concatenated oldest-to-newest, single-spaced.
   *
   * Used by `rememberMoment` — the surrounding spoken context is often
   * the difference between a useful and useless memory ("I'm leaving my
   * keys here for tonight" vs. just the visual frame of keys).
   */
  recentText(windowMs = 10_000): string {
    const cutoff = Date.now() - windowMs;
    return this.history
      .filter((e) => e.timestamp >= cutoff)
      .map((e) => e.text.trim())
      .filter(Boolean)
      .join(" ");
  }

  private pushToHistory(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.history.push({ text: trimmed, timestamp: Date.now() });

    // Prune by age and size on every insert. Cheap; keeps memory bounded
    // even on a session that runs for hours.
    const cutoff = Date.now() - TranscriptionManager.HISTORY_MAX_AGE_MS;
    while (this.history.length > 0 && this.history[0].timestamp < cutoff) {
      this.history.shift();
    }
    while (this.history.length > TranscriptionManager.HISTORY_MAX_ENTRIES) {
      this.history.shift();
    }
  }

  /** Push a transcription event to all connected SSE clients */
  broadcast(text: string, isFinal: boolean): void {
    const payload = JSON.stringify({
      text,
      isFinal,
      timestamp: Date.now(),
      userId: this.user.userId,
    });

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

  /** Tear down listener and drop all SSE clients */
  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sseClients.clear();
    this.history = [];
  }
}
