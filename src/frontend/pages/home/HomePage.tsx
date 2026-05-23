import { useState, useEffect, useCallback, useRef } from "react";
import { Camera } from "lucide-react";
import { Badge } from "../../components/ui";
import { LiveStream } from "./components/LiveStream";
import { AIPanel } from "./components/AIPanel";
import {
  TranscriptionFeed,
  type Transcription,
} from "./components/TranscriptionFeed";

interface HomePageProps {
  userId: string;
}

/**
 * HomePage — live camera stream + live captions.
 *
 * Pared down to just two things: the WebRTC livestream of the glasses
 * camera, and the real-time transcription captions beneath it.
 */
export default function HomePage({ userId }: HomePageProps) {
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const idCounter = useRef(Date.now());

  // Shared with AIPanel so it can sample frames from the live <video>.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [streamActive, setStreamActive] = useState(false);

  // Lightweight console-only logger for the LiveStream component.
  const addLog = useCallback((message: string) => {
    console.log(`[Clairity] ${message}`);
  }, []);

  // Connect to the SSE transcription stream (captions).
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
                time: new Date(data.timestamp).toLocaleTimeString(),
                isFinal: data.isFinal,
              };

              // Replace the leading partial with the updated partial/final;
              // otherwise prepend a fresh entry.
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

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center">
            <Camera className="w-4 h-4 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Clairity</h1>
            <p className="text-xs text-muted-foreground">Live camera & captions</p>
          </div>
        </div>
        <Badge variant="outline" className="font-mono text-xs mt-2">
          {userId && userId.length > 20
            ? `${userId.substring(0, 20)}...`
            : userId}
        </Badge>
      </div>

      {/* Live camera stream */}
      <LiveStream
        userId={userId}
        onLog={addLog}
        onVideoRef={setVideo}
        onActiveChange={setStreamActive}
      />

      {/* AI assistant — sees the camera feed, answers spoken questions */}
      <AIPanel userId={userId} video={video} streamActive={streamActive} />

      {/* Live captions */}
      <TranscriptionFeed transcriptions={transcriptions} />
    </div>
  );
}
