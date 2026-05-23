import { useEffect, useRef } from "react";

interface MemoryCaptureBridgeProps {
  userId: string;
  /** The live WHEP <video> element from LiveStream — same ref AIPanel uses. */
  video: HTMLVideoElement | null;
}

interface CaptureRequest {
  type: "capture";
  id: string;
  /** How long to sample for, ms. */
  durationMs: number;
  /** Target frame rate. */
  fps: number;
  /** Downscale long edge to this many px. */
  maxWidth: number;
}

/**
 * MemoryCaptureBridge — headless component that fulfills server-side
 * "remember this" requests by sampling frames from the live WHEP <video>.
 *
 * Flow:
 *   1. Subscribes to /api/memory/capture-stream SSE.
 *   2. On a `capture` event, samples `durationMs * fps / 1000` frames from
 *      the existing <video> via canvas.toDataURL.
 *   3. POSTs the frames back to /api/memory/capture with the request id.
 *
 * This is the Plan B from the issue spec (HLS+ffmpeg was Plan A, but
 * Cloudflare HLS 404s for ~60s after a stream goes active). WebRTC/WHEP is
 * live the instant the stream is up, so doing the capture in the browser
 * just works.
 *
 * Renders nothing — the only output is the network side-effect.
 */
export function MemoryCaptureBridge({ userId, video }: MemoryCaptureBridgeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Pin the video element in a ref so the SSE effect doesn't need to
  // re-subscribe every time the parent re-renders.
  const videoRef = useRef<HTMLVideoElement | null>(video);
  useEffect(() => {
    videoRef.current = video;
  }, [video]);

  useEffect(() => {
    if (!userId) return;
    let es: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      es = new EventSource(
        `/api/memory/capture-stream?userId=${encodeURIComponent(userId)}`,
      );
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data?.type === "capture") {
            void handleCapture(data as CaptureRequest);
          }
        } catch {
          /* ignore malformed events */
        }
      };
      es.onerror = () => {
        es?.close();
        reconnect = setTimeout(connect, 3000);
      };
    };

    const handleCapture = async (req: CaptureRequest) => {
      const v = videoRef.current;
      if (!v || v.videoWidth === 0) {
        console.warn(
          `[MemoryCapture] No live video — replying with 0 frames for ${req.id}`,
        );
        await uploadFrames(req.id, []);
        return;
      }

      // Reuse a single canvas across captures.
      if (!canvasRef.current) {
        canvasRef.current = document.createElement("canvas");
      }
      const canvas = canvasRef.current;

      const scale = req.maxWidth / v.videoWidth;
      canvas.width = req.maxWidth;
      canvas.height = Math.max(1, Math.round(v.videoHeight * scale));

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        await uploadFrames(req.id, []);
        return;
      }

      const intervalMs = Math.max(50, Math.round(1000 / Math.max(1, req.fps)));
      const totalFrames = Math.max(1, Math.round(req.durationMs / intervalMs));

      console.log(
        `[MemoryCapture] ${req.id} — sampling ${totalFrames} frames over ${req.durationMs}ms`,
      );

      const frames: string[] = [];
      const t0 = performance.now();
      for (let i = 0; i < totalFrames; i++) {
        try {
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          // Quality 0.55 — caption-grade; Gemini 3.5 Flash captions reliably
          // down to ~0.5. We're sending the bytes over Wi-Fi to the server
          // which then re-sends them to Google, so every KB matters.
          const dataUrl = canvas.toDataURL("image/jpeg", 0.55);
          frames.push(dataUrl);
        } catch (err) {
          console.warn(`[MemoryCapture] drawImage failed:`, err);
        }
        if (i < totalFrames - 1) {
          await sleep(intervalMs);
        }
      }

      const totalKb = Math.round(
        frames.reduce((acc, f) => acc + f.length, 0) / 1024,
      );
      console.log(
        `[MemoryCapture] ${req.id} — captured ${frames.length} frames (~${totalKb} KB) in ${Math.round(performance.now() - t0)}ms, uploading`,
      );
      const uploadStart = performance.now();
      await uploadFrames(req.id, frames);
      console.log(
        `[MemoryCapture] ${req.id} — upload finished in ${Math.round(performance.now() - uploadStart)}ms`,
      );
    };

    const uploadFrames = async (id: string, frames: string[]) => {
      try {
        await fetch("/api/memory/capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, id, frames }),
        });
      } catch (err) {
        console.warn(`[MemoryCapture] upload failed for ${id}:`, err);
      }
    };

    connect();
    return () => {
      es?.close();
      if (reconnect) clearTimeout(reconnect);
    };
  }, [userId]);

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
