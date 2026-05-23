import { spawn } from "bun";
import type { User } from "../session/User";

/**
 * Result of one capture burst.
 *
 * `frames` is JPEGs in time order. May be empty if ffmpeg couldn't open the
 * HLS URL fast enough — callers must handle the empty case (don't store an
 * empty memory).
 */
export interface BurstResult {
  frames: Buffer[];
  startedAt: number;
  endedAt: number;
}

/**
 * HlsBurst — pull a short burst of JPEG frames out of the active livestream.
 *
 * Why this exists:
 *   While `session.camera.startManagedStream()` is active, `requestPhoto()`
 *   does NOT work — the glasses can stream OR shoot stills, not both. Since
 *   Project-V is always streaming during use, the only way to get frames
 *   server-side mid-session is to pull them out of the live pipeline.
 *
 * How:
 *   The managed stream returns an `hlsUrl` alongside the WHEP URL (see
 *   LiveStreamManager.ts:138). We spawn ffmpeg against that URL, run for
 *   ~3 seconds, pipe out MJPEG. Same binary AudioManager already uses for
 *   PCM→MP3, so no new container dependency.
 *
 * Caveat:
 *   HLS has 4-10s of delay vs live. The frames we capture are the recent
 *   past, not the instant of the command. For the demo cases (keys, pill
 *   bottles, signs) the user dwells on the subject for several seconds
 *   before saying "remember this", so this is acceptable.
 *
 * Concurrency:
 *   One in-flight burst per user. If a second `capture()` lands while one
 *   is running, we return the existing promise — never spawn two ffmpegs
 *   against the same stream.
 */
export class HlsBurst {
  private inFlight: Promise<BurstResult> | null = null;

  constructor(private user: User) {}

  /**
   * Capture a burst of JPEG frames from the current livestream.
   *
   * Returns an empty `frames` array if no livestream is active, or if
   * ffmpeg failed/timed out without producing any frames. Callers should
   * NOT assume frames.length > 0.
   *
   * @param durationMs - how long ffmpeg runs (~3000 is the demo default)
   * @param fps        - target frame rate (~2 fps gives 6 frames in 3s)
   * @param maxWidth   - downscale long edge for fast Gemini upload
   */
  async capture(
    durationMs = 3000,
    fps = 2,
    maxWidth = 512,
  ): Promise<BurstResult> {
    if (this.inFlight) {
      console.log(
        `🎞️  HLS burst already in flight for ${this.user.userId} — reusing`,
      );
      return this.inFlight;
    }

    const hlsUrl = this.user.liveStream.getState().hlsUrl;
    if (!hlsUrl) {
      console.warn(
        `🎞️  No hlsUrl available for ${this.user.userId} — livestream not active?`,
      );
      const now = Date.now();
      return { frames: [], startedAt: now, endedAt: now };
    }

    this.inFlight = this.runBurst(hlsUrl, durationMs, fps, maxWidth)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * Run one ffmpeg burst.
   *
   * Frame extraction strategy: ffmpeg emits raw MJPEG on stdout via
   * `-f image2pipe -vcodec mjpeg`. Each JPEG starts with the SOI marker
   * `FF D8` and ends with the EOI marker `FF D9`. We accumulate stdout into
   * a buffer and split on those markers. Robust to chunked reads.
   */
  private async runBurst(
    hlsUrl: string,
    durationMs: number,
    fps: number,
    maxWidth: number,
  ): Promise<BurstResult> {
    const startedAt = Date.now();
    console.log(
      `🎞️  HLS burst start for ${this.user.userId} (${durationMs}ms @ ${fps}fps) — url=${hlsUrl}`,
    );

    // -loglevel warning: surface enough to debug (404s, no streams, etc.)
    //                    without flooding logs in the happy path.
    // -t <seconds>: hard duration cap
    // -vf fps=N,scale=W:-2: throttle + downscale, -2 keeps aspect ratio
    //                       and rounds height to an even integer
    // -f image2pipe -vcodec mjpeg: emit a stream of JPEG frames on stdout
    const durationSec = (durationMs / 1000).toFixed(2);
    const proc = spawn({
      cmd: [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "warning",
        "-i", hlsUrl,
        "-t", durationSec,
        "-vf", `fps=${fps},scale=${maxWidth}:-2`,
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "pipe:1",
      ],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Drain stderr in the background so we can log it on failure (or always
    // when no frames came out). Otherwise ffmpeg can block writing to a full
    // stderr pipe and we never see why it died.
    const stderrChunks: Buffer[] = [];
    const stderrStream = proc.stderr;
    if (stderrStream) {
      (async () => {
        const reader = stderrStream.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
              stderrChunks.push(Buffer.from(value));
            }
          }
        } catch {
          /* stream closed */
        } finally {
          reader.releaseLock();
        }
      })();
    }

    const frames: Buffer[] = [];

    try {
      // Hard wall-clock watchdog: ffmpeg might block on a slow HLS manifest.
      // Kill it after durationMs * 2 so we never wedge the caller.
      const watchdog = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
      }, durationMs * 2 + 5000);

      const stdout = proc.stdout;
      if (stdout) {
        await collectJpegs(stdout, frames);
      }
      clearTimeout(watchdog);
      await proc.exited;
    } catch (error) {
      console.error(
        `🎞️  HLS burst failed for ${this.user.userId}:`,
        error,
      );
      try {
        proc.kill();
      } catch {}
    }

    const endedAt = Date.now();
    const exitCode = proc.exitCode;

    // If we got no frames, dump ffmpeg's stderr — that's where the actual
    // "no such stream", "404", "Invalid data" message lives. Without this
    // a silent failure is impossible to debug.
    if (frames.length === 0) {
      const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
      console.warn(
        `🎞️  HLS burst produced 0 frames for ${this.user.userId} ` +
          `(exit=${exitCode}, ${endedAt - startedAt}ms). ` +
          `ffmpeg stderr:\n${stderrText || "(empty)"}`,
      );
    } else {
      console.log(
        `🎞️  HLS burst end for ${this.user.userId} — ${frames.length} frames in ${endedAt - startedAt}ms (exit=${exitCode})`,
      );
    }
    return { frames, startedAt, endedAt };
  }
}

/**
 * Read an MJPEG byte stream and push each complete JPEG into `out`.
 *
 * JPEG framing inside `image2pipe -vcodec mjpeg` is:
 *   each frame = SOI marker (FF D8) ... EOI marker (FF D9)
 * Frames are concatenated back-to-back. We accumulate bytes and split on
 * the EOI marker — each split yields one complete JPEG (the SOI is the
 * leading bytes of the next chunk).
 */
async function collectJpegs(
  stream: ReadableStream<Uint8Array>,
  out: Buffer[],
): Promise<void> {
  const reader = stream.getReader();
  let pending = Buffer.alloc(0);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      pending = Buffer.concat([pending, Buffer.from(value)]);

      // Split on EOI (FF D9). Each completed chunk ends right after the EOI.
      let searchFrom = 0;
      while (true) {
        const eoi = indexOfPair(pending, 0xff, 0xd9, searchFrom);
        if (eoi === -1) break;
        const end = eoi + 2; // include the marker bytes
        const jpeg = pending.subarray(0, end);

        // Validate SOI prefix — guards against any stray bytes ffmpeg may
        // emit before the first frame.
        if (jpeg.length >= 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8) {
          out.push(Buffer.from(jpeg));
        }
        pending = pending.subarray(end);
        searchFrom = 0;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Find the first index where bytes[i]=a and bytes[i+1]=b, starting at `from`. */
function indexOfPair(
  buf: Buffer,
  a: number,
  b: number,
  from: number,
): number {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === a && buf[i + 1] === b) return i;
  }
  return -1;
}
