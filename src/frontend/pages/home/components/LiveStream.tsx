import { useEffect, useRef, useState, useCallback } from "react";
import { Video, VideoOff, Loader2 } from "lucide-react";
import { Card, Button } from "../../../components/ui";
import { playWhepStream, type WhepSession } from "../../../lib/whepClient";

interface LiveStreamProps {
  userId: string;
  onLog?: (message: string) => void;
  /** Receives the underlying <video> element so other components (the AI
   *  panel) can sample frames from the same live feed. */
  onVideoRef?: (video: HTMLVideoElement | null) => void;
  /** Fires whenever the stream goes active / inactive. */
  onActiveChange?: (active: boolean) => void;
}

type StreamStatus =
  | "inactive"
  | "initializing"
  | "preparing"
  | "active"
  | "stopping"
  | "stopped"
  | "error";

interface LiveStreamState {
  status: StreamStatus;
  webrtcUrl?: string;
  hlsUrl?: string;
  message?: string;
}

const STATUS_LABEL: Record<StreamStatus, string> = {
  inactive: "Camera off",
  initializing: "Starting…",
  preparing: "Preparing stream…",
  active: "Live",
  stopping: "Stopping…",
  stopped: "Stream ended",
  error: "Stream error",
};

/**
 * LiveStream — shows the live WebRTC feed from the glasses camera.
 *
 * Subscribes to the server's livestream-status SSE for state (incl. the WHEP
 * `webrtcUrl`), and plays that URL into a <video> via the WHEP client.
 */
export function LiveStream({
  userId,
  onLog,
  onVideoRef,
  onActiveChange,
}: LiveStreamProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const whepRef = useRef<WhepSession | null>(null);
  const [state, setState] = useState<LiveStreamState>({ status: "inactive" });
  // Separate flags so a slow "start" request never disables the Stop button.
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  const log = useCallback(
    (msg: string) => {
      console.log(`[LiveStream] ${msg}`);
      onLog?.(msg);
    },
    [onLog],
  );

  // Subscribe to livestream status (SSE).
  useEffect(() => {
    if (!userId) return;
    let es: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      es = new EventSource(
        `/api/livestream-status?userId=${encodeURIComponent(userId)}`,
      );
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as LiveStreamState;
          setState(data);
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

  // Attach / detach the WHEP video player as the stream goes active/inactive.
  useEffect(() => {
    const video = videoRef.current;

    if (state.status === "active" && state.webrtcUrl && video && !whepRef.current) {
      log(`Connecting WebRTC player → ${state.webrtcUrl}`);
      playWhepStream(state.webrtcUrl, video)
        .then((session) => {
          whepRef.current = session;
          log("WebRTC player connected");
        })
        .catch((err) => {
          log(`WebRTC player failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    // Stream no longer active — tear the player down.
    if (state.status !== "active" && whepRef.current) {
      whepRef.current.close();
      whepRef.current = null;
    }
  }, [state.status, state.webrtcUrl, log]);

  // Clean up the peer connection on unmount.
  useEffect(() => {
    return () => {
      whepRef.current?.close();
      whepRef.current = null;
    };
  }, []);

  // Hand the <video> element to the parent (the AI panel samples frames
  // from it) once mounted.
  useEffect(() => {
    onVideoRef?.(videoRef.current);
    return () => onVideoRef?.(null);
  }, [onVideoRef]);

  // Report active/inactive transitions to the parent.
  useEffect(() => {
    onActiveChange?.(state.status === "active");
  }, [state.status, onActiveChange]);

  const startStream = async () => {
    setStarting(true);
    log("Requesting livestream start…");
    try {
      const res = await fetch("/api/livestream/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      if (!res.ok) log(`Start failed: ${data.error ?? res.status}`);
    } catch (err) {
      log(`Start failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStarting(false);
    }
  };

  const stopStream = async () => {
    setStopping(true);
    log("Requesting livestream stop…");
    try {
      await fetch("/api/livestream/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
    } catch (err) {
      log(`Stop failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStopping(false);
    }
  };

  const isActive = state.status === "active";
  const isPending =
    state.status === "initializing" ||
    state.status === "preparing" ||
    state.status === "stopping";
  // The stream is "up" (or coming up) whenever it isn't fully off — Stop
  // must stay clickable through the whole initializing→active window so a
  // slow/hung start can always be cancelled.
  const streamUp = isActive || isPending || starting;

  return (
    <Card className="overflow-hidden p-0">
      {/* Video surface */}
      <div className="relative aspect-video bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-contain"
        />

        {/* Placeholder when nothing is playing */}
        {!isActive && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/60">
            {isPending ? (
              <Loader2 className="w-8 h-8 animate-spin" />
            ) : (
              <VideoOff className="w-8 h-8" />
            )}
            <p className="text-sm">{STATUS_LABEL[state.status]}</p>
            {state.status === "error" && state.message && (
              <p className="text-xs text-red-400 max-w-xs text-center px-4">
                {state.message}
              </p>
            )}
          </div>
        )}

        {/* Live badge */}
        {isActive && (
          <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-red-600 px-2.5 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-white">
              Live
            </span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="p-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {STATUS_LABEL[state.status]}
        </span>
        {streamUp ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={stopStream}
            disabled={stopping}
          >
            <VideoOff className="w-3.5 h-3.5" />
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        ) : (
          <Button size="sm" onClick={startStream} disabled={starting}>
            <Video className="w-3.5 h-3.5" />
            {starting ? "Starting…" : "Go Live"}
          </Button>
        )}
      </div>
    </Card>
  );
}
