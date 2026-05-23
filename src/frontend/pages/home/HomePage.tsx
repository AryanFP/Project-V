import { useState, useEffect, useCallback, useRef } from "react";
import { LiveStream } from "./components/LiveStream";
import { AIPanel } from "./components/AIPanel";
import { MemoryCaptureBridge } from "./components/MemoryCaptureBridge";
import { VisualMemoryGrid } from "./components/VisualMemoryGrid";
import {
  TranscriptionFeed,
  type Transcription,
} from "./components/TranscriptionFeed";

interface HomePageProps {
  userId: string;
}

/**
 * HomePage — Paper-designed Clairity dashboard.
 *
 * Layout, top to bottom:
 *   1. Brand header with the rainbow-eye Clairity logo + user pill
 *   2. Live camera hero card (LiveStream)
 *   3. Gemini Assistant card (AIPanel) — mode tiles + conversation
 *   4. Visual Memory gallery (VisualMemoryGrid) — today / yesterday / older
 *   5. Live Transcription card (TranscriptionFeed)
 *
 * Headless: MemoryCaptureBridge fulfills "remember this" frame uploads.
 */
export default function HomePage({ userId }: HomePageProps) {
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const idCounter = useRef(Date.now());

  // Shared with AIPanel + MemoryCaptureBridge so they sample frames from
  // the same live <video> the LiveStream component owns.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [streamActive, setStreamActive] = useState(false);

  // Bumped whenever a memory was just saved or recalled — VisualMemoryGrid
  // refetches when this changes so the new card appears immediately
  // instead of waiting on the 15s poll.
  const [memoryRefreshKey, setMemoryRefreshKey] = useState(0);

  // Lightweight console-only logger for the LiveStream component.
  const addLog = useCallback((message: string) => {
    console.log(`[Clairity] ${message}`);
  }, []);

  // Listen for memory-source AI messages on the same SSE stream the
  // AIPanel uses, so we can refresh the grid as soon as a remember
  // completes. (Cheap to open a second EventSource — they're streamed
  // events, not new TCP for each event.)
  useEffect(() => {
    if (!userId) return;
    let es: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      es = new EventSource(`/api/ai-stream?userId=${encodeURIComponent(userId)}`);
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data?.source === "memory" && data?.role === "ai" && data?.done) {
            setMemoryRefreshKey((k) => k + 1);
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      es.onerror = () => {
        es?.close();
        reconnect = setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      es?.close();
      if (reconnect) clearTimeout(reconnect);
    };
  }, [userId]);

  // Connect to the SSE transcription stream (live captions).
  useEffect(() => {
    if (!userId) return;
    let eventSource: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      try {
        eventSource = new EventSource(
          `/api/transcription-stream?userId=${encodeURIComponent(userId)}`,
        );

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "connected") return;

            setTranscriptions((prev) => {
              const entry: Transcription = {
                id: idCounter.current++,
                text: data.text,
                time: new Date(data.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                }),
                isFinal: data.isFinal,
              };

              if (data.isFinal) {
                if (prev.length > 0 && !prev[0].isFinal) {
                  const updated = [...prev];
                  updated[0] = { ...entry, id: updated[0].id };
                  return updated.slice(0, 10);
                }
                return [entry, ...prev].slice(0, 10);
              }
              if (prev.length === 0 || prev[0].isFinal) {
                return [entry, ...prev].slice(0, 10);
              }
              const updated = [...prev];
              updated[0] = { ...entry, id: updated[0].id };
              return updated;
            });
          } catch {
            /* ignore malformed frames */
          }
        };

        eventSource.onerror = () => {
          eventSource?.close();
          reconnect = setTimeout(connect, 3000);
        };
      } catch {
        /* will retry via onerror path */
      }
    };

    connect();
    return () => {
      eventSource?.close();
      if (reconnect) clearTimeout(reconnect);
    };
  }, [userId]);

  const shortUser =
    userId && userId.length > 24 ? `${userId.substring(0, 24)}…` : userId;

  return (
    <div
      className="min-h-screen bg-white antialiased"
      style={{ fontSynthesis: "none" }}
    >
      <div className="max-w-5xl mx-auto px-4 md:px-6 pt-8 pb-24 flex flex-col gap-6">
        {/* Brand header */}
        <div className="flex items-center justify-between w-full pt-2 px-1">
          <div className="flex items-center gap-2">
            <img
              src="/assets/icons/gemini-clairty.png"
              alt="Clairity"
              className="w-18 h-18 object-contain"
            />
            <div className="flex flex-col gap-0.5">
              <div
                className="font-['Roboto',system-ui,sans-serif] font-medium text-[#505050] text-[20px] md:text-[34px] leading-tight"
                style={{ letterSpacing: "-0.01em" }}
              >
                Gemini Clairity
              </div>
  
            </div>
          </div>
          {shortUser && (
            <div></div>
          )}
        </div>

        {/* Live camera hero */}
        <LiveStream
          userId={userId}
          onLog={addLog}
          onVideoRef={setVideo}
          onActiveChange={setStreamActive}
        />

        {/* AI assistant */}
        <AIPanel userId={userId} video={video} streamActive={streamActive} />

        {/* Headless: fulfills "remember this" frame captures from the live <video>. */}
        <MemoryCaptureBridge userId={userId} video={video} />

        {/* Visual memory gallery */}
        <VisualMemoryGrid userId={userId} refreshKey={memoryRefreshKey} />

        {/* Live transcription */}
        <TranscriptionFeed transcriptions={transcriptions} />
      </div>
    </div>
  );
}
