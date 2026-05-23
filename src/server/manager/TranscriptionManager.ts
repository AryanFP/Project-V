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
export class TranscriptionManager {
  private sseClients: Set<SSEWriter> = new Set();
  private unsubscribe: (() => void) | null = null;

  constructor(private user: User) {}

  /** Wire up the transcription listener on the glasses session */
  setup(session: AppSession): void {
    this.unsubscribe = session.events.onTranscription(
      (data: TranscriptionData) => {
        if (data.isFinal) {
          console.log(
            `✅ Final transcription (${this.user.userId}): ${data.text}`,
          );
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
  }
}
