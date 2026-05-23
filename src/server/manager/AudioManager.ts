import { spawn, type Subprocess } from "bun";
import type { User } from "../session/User";
import type { AudioOutputStream } from "@mentra/sdk";

/** Gemini Live emits 24 kHz mono PCM16. */
const GEMINI_AUDIO_SAMPLE_RATE = 24000;

/**
 * AudioManager — text-to-speech and continuous audio output for a user.
 *
 * Audio design (copied from Mentra-Call's working pattern):
 *
 *   Gemini PCM16 chunks ──▶ ffmpeg (PCM→MP3) ──▶ SDK MP3 stream ──▶ glasses
 *
 * Critically, ONE long-lived stream + ffmpeg pipeline runs for the entire
 * glasses session — we never open/close per AI turn. That was the source
 * of "first works, rest don't": the SDK rejects a second open while the
 * first is still streaming, and the phone's ExoPlayer falls out of sync
 * between rapid open/close cycles. With one continuous stream, Gemini's
 * PCM just keeps flowing through ffmpeg → MP3 → speaker. Silence between
 * answers is just zero-bytes in the stream; the player keeps running.
 *
 * MP3 pass-through (not the SDK's pcm16 mode) is used because the SDK's
 * built-in lamejs encoder applies automatic gain normalization that causes
 * fade-out artifacts. ffmpeg with tuned flags gives clean low-latency MP3.
 */
export class AudioManager {
  private outputStream: AudioOutputStream | null = null;
  private ffmpeg: Subprocess | null = null;
  private starting: Promise<void> | null = null;
  /** Total PCM bytes written this session (logged periodically). */
  private bytesWritten = 0;
  /** Last byte count we logged at — used to throttle the PCM-flowing log. */
  private lastLoggedBytes = 0;

  constructor(private user: User) {}

  /** Speak text aloud on the glasses (SDK's server-side TTS). */
  async speak(text: string): Promise<void> {
    const session = this.user.appSession;
    if (!session) throw new Error("No active glasses session");
    await session.audio.speak(text);
  }

  /** Stop any currently playing audio. */
  async stopAudio(): Promise<void> {
    const session = this.user.appSession;
    if (!session) throw new Error("No active glasses session");
    await session.audio.stopAudio();
  }

  /**
   * Play a short action/feedback sound file (start-vision, end-vision, …)
   * on the glasses speaker without disturbing the continuous Gemini audio.
   *
   * The glasses fetch the URL themselves, so it must be PUBLICLY reachable —
   * use the PUBLIC_URL env var to point them at this server. If PUBLIC_URL
   * isn't set we skip (and log) rather than fail.
   *
   * Plays on track 0 (speaker) with stopOtherAudio=false so it mixes with
   * Gemini's MP3 stream (track 1 / app_audio) instead of interrupting it.
   *
   * @param assetPath - Path under /assets, e.g. "audio/start-vision.mp3".
   */
  async playActionSound(assetPath: string): Promise<void> {
    const session = this.user.appSession;
    if (!session) return;

    const baseUrl = process.env.PUBLIC_URL;
    if (!baseUrl) {
      console.warn(
        `🔉 Skipping action sound ${assetPath} — PUBLIC_URL not set ` +
          `(glasses fetch the file directly; localhost won't work).`,
      );
      return;
    }

    const url = `${baseUrl.replace(/\/$/, "")}/assets/${assetPath.replace(/^\//, "")}`;
    try {
      await session.audio.playAudio({
        audioUrl: url,
        trackId: 0, // speaker — separate from Gemini's app_audio track (1)
        stopOtherAudio: false, // don't interrupt the AI's voice
        volume: 1.0,
      });
    } catch (error) {
      console.warn(`🔉 Failed to play action sound ${assetPath}:`, error);
    }
  }

  /** True once the continuous PCM→MP3→glasses pipeline is ready. */
  isAudioReady(): boolean {
    return this.outputStream !== null && this.ffmpeg !== null;
  }

  /**
   * Tear down the current pipeline (if any) and start a fresh one.
   *
   * Used when the livestream transitions in/out of "active" — the phone's
   * WebRTC subsystem grabs audio focus on activation, and our existing
   * MP3 stream gets silenced. Restarting forces a new createOutputStream
   * which reclaims the audio path with stopOtherAudio=true.
   */
  async restartContinuousOutput(): Promise<void> {
    await this.destroy();
    await this.startContinuousOutput();
  }

  /**
   * Start the continuous output pipeline for this session.
   *
   * Idempotent — safe to call repeatedly. Stays open until destroy() so
   * Gemini audio for every turn flows through the same stream.
   */
  async startContinuousOutput(): Promise<void> {
    if (this.outputStream && this.ffmpeg) return;
    if (this.starting) return this.starting;

    const session = this.user.appSession;
    if (!session) throw new Error("No active glasses session");

    this.starting = (async () => {
      try {
        // SDK output stream in MP3 pass-through mode.
        const stream = await session.audio.createOutputStream({
          format: "mp3",
          sampleRate: GEMINI_AUDIO_SAMPLE_RATE,
          channels: 1,
          stopOtherAudio: true,
        });

        // ffmpeg: stdin = raw PCM16 @ 24 kHz mono, stdout = streamed MP3.
        // Flags tuned for lowest latency — see Mentra-Call for the
        // explanation of each. lamejs (the SDK's internal pcm16 encoder)
        // doesn't expose these.
        const ffmpeg = spawn({
          cmd: [
            "ffmpeg",
            "-probesize", "32",
            "-analyzeduration", "0",
            "-f", "s16le",
            "-ar", String(GEMINI_AUDIO_SAMPLE_RATE),
            "-ac", "1",
            "-i", "pipe:0",
            "-codec:a", "libmp3lame",
            "-b:a", "64k",
            "-reservoir", "0",      // flush MP3 frames immediately
            "-write_xing", "0",     // no Xing header — streaming, not seeking
            "-f", "mp3",
            "-fflags", "+nobuffer+flush_packets",
            "-flush_packets", "1",
            "pipe:1",
          ],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });

        // Pump ffmpeg's MP3 output into the SDK stream as it's produced.
        const reader = ffmpeg.stdout.getReader();
        (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value && value.length > 0) {
                stream.write(value);
              }
            }
          } catch {
            /* stream closed or ffmpeg killed — fine */
          }
        })();

        this.outputStream = stream;
        this.ffmpeg = ffmpeg;
        console.log(`🔊 Continuous audio pipeline ready for ${this.user.userId}`);
      } catch (error) {
        console.error(`🔊 Failed to start audio pipeline for ${this.user.userId}:`, error);
        // Clean up partial state.
        this.outputStream = null;
        this.ffmpeg = null;
        throw error;
      } finally {
        this.starting = null;
      }
    })();

    return this.starting;
  }

  /**
   * Write a chunk of PCM16 (24 kHz mono) audio to the pipeline.
   *
   * If the pipeline isn't ready yet this no-ops — callers should ensure
   * startContinuousOutput() has resolved before sending chunks. AIManager
   * gates on isAudioReady() during connect.
   */
  writePcm(pcm: Buffer): void {
    if (!this.ffmpeg) {
      console.warn(
        `🔊 writePcm called with no ffmpeg pipeline (${pcm.length}B dropped) for ${this.user.userId}`,
      );
      return;
    }
    try {
      const stdin = this.ffmpeg.stdin as import("bun").FileSink;
      stdin.write(pcm);
      stdin.flush(); // force ffmpeg to emit MP3 frames now, not later
      this.bytesWritten += pcm.length;

      // Log every ~1s of buffered speech so we can verify chunks are flowing.
      // PCM16 mono @ 24 kHz = 48,000 B/s.
      const bytesPerSec = GEMINI_AUDIO_SAMPLE_RATE * 2;
      if (this.bytesWritten - this.lastLoggedBytes >= bytesPerSec) {
        const seconds = (this.bytesWritten / bytesPerSec).toFixed(1);
        console.log(
          `🔊 PCM flowing (${this.user.userId}) — ${this.bytesWritten}B written (~${seconds}s)`,
        );
        this.lastLoggedBytes = this.bytesWritten;
      }
    } catch (error) {
      console.error(`🔊 Failed to write PCM for ${this.user.userId}:`, error);
    }
  }

  /** Tear down the pipeline. Called from User cleanup. */
  async destroy(): Promise<void> {
    const ffmpeg = this.ffmpeg;
    const stream = this.outputStream;
    this.ffmpeg = null;
    this.outputStream = null;

    if (this.bytesWritten > 0) {
      const seconds = (this.bytesWritten / 2 / GEMINI_AUDIO_SAMPLE_RATE).toFixed(1);
      console.log(`🔊 Audio pipeline closing for ${this.user.userId} — ${this.bytesWritten}B PCM (~${seconds}s) written this session`);
    }

    try {
      (ffmpeg?.stdin as import("bun").FileSink | undefined)?.end();
    } catch {}
    try {
      ffmpeg?.kill();
    } catch {}
    // Give ffmpeg a moment to flush its trailing buffer before closing
    // the SDK stream (matches Mentra-Call's teardown ordering).
    if (stream) {
      setTimeout(() => {
        stream.end().catch(() => {});
      }, 500);
    }
  }
}
