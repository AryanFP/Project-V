import { useEffect, useRef, useState, useCallback } from "react";
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
 * LiveStream — Paper-designed hero card showing the WebRTC feed from the
 * glasses camera + Go/Stop controls. Functionally identical to the prior
 * implementation; visual layout follows the Paper design.
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

    if (state.status !== "active" && whepRef.current) {
      whepRef.current.close();
      whepRef.current = null;
    }
  }, [state.status, state.webrtcUrl, log]);

  useEffect(() => {
    return () => {
      whepRef.current?.close();
      whepRef.current = null;
    };
  }, []);

  useEffect(() => {
    onVideoRef?.(videoRef.current);
    return () => onVideoRef?.(null);
  }, [onVideoRef]);

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
  const streamUp = isActive || isPending || starting;

  return (
    <div className="flex flex-col w-full rounded-3xl overflow-hidden bg-white border border-solid border-[#E8EAED]">
      {/* Video surface — Paper hero card */}
      <div
        className="relative w-full aspect-[16/10] flex items-center justify-center"
        style={{
          backgroundImage:
            "linear-gradient(135deg, #1a1a1d 0%, #0e0e10 100%)",
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`absolute inset-0 w-full h-full object-cover ${
            isActive ? "opacity-100" : "opacity-0"
          } transition-opacity duration-300`}
        />

        {/* Placeholder content when not playing — Paper's idle hero */}
        {!isActive && (
          <div className="relative flex flex-col items-center gap-4">
            <div className="flex items-center justify-center w-22 h-22 rounded-full bg-white/8 border border-solid border-white/18">
              {isPending ? (
                <div className="w-10 h-10 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              ) : (
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M23 7l-7 5 7 5V7z"
                    stroke="#FFFFFF"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                  <rect
                    x="1"
                    y="5"
                    width="15"
                    height="14"
                    rx="2"
                    stroke="#FFFFFF"
                    strokeWidth="1.5"
                  />
                </svg>
              )}
            </div>
            <p
              className="font-['Roboto',system-ui,sans-serif] text-white/70 text-[15px]"
              style={{ letterSpacing: "0.01em" }}
            >
              {state.status === "error" && state.message
                ? state.message
                : isPending
                ? STATUS_LABEL[state.status]
                : "Streaming the wearer's point of view"}
            </p>
          </div>
        )}

        {/* Live badge */}
        {isActive && (
          <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-[#D93025] px-2.5 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-white font-['Roboto',system-ui,sans-serif]">
              Live
            </span>
          </div>
        )}
      </div>

      {/* Footer with title + controls */}
      <div className="flex items-center justify-between w-full py-5 px-6">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center rounded-xl shrink-0 bg-[#FCE8E6] w-10 h-10">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M23 7l-7 5 7 5V7z" fill="#D93025" />
              <rect x="1" y="5" width="15" height="14" rx="2" fill="#D93025" />
            </svg>
          </div>
          <div className="flex flex-col">
            <div className="font-['Roboto',system-ui,sans-serif] font-medium text-[#1F1F1F] text-base leading-tight">
              Live camera
            </div>
            <div className="font-['Roboto',system-ui,sans-serif] text-[#5F6368] text-[13px]">
              {isActive
                ? "Broadcasting through Cloudflare · stills disabled while live"
                : STATUS_LABEL[state.status]}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {streamUp ? (
            <button
              type="button"
              onClick={stopStream}
              disabled={stopping}
              className="flex items-center rounded-full py-2.5 px-5 gap-2 bg-[#D93025] hover:bg-[#B7261E] transition-colors disabled:opacity-60"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect x="6" y="6" width="12" height="12" rx="1.5" fill="#FFFFFF" />
              </svg>
              <span className="font-['Roboto',system-ui,sans-serif] font-medium text-white text-sm">
                {stopping ? "Stopping…" : "Stop stream"}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={startStream}
              disabled={starting}
              className="flex items-center rounded-full py-2.5 px-5 gap-2 bg-[#0B57D0] hover:bg-[#0A4BB5] transition-colors disabled:opacity-60"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M5 3v18l15-9L5 3z" fill="#FFFFFF" />
              </svg>
              <span className="font-['Roboto',system-ui,sans-serif] font-medium text-white text-sm">
                {starting ? "Starting…" : "Go live"}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
