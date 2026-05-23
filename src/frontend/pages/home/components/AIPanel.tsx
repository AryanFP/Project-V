import { useEffect, useRef, useState, useCallback } from "react";
import { Sparkles, Eye, MessageCircle, TreePine, Wand2 } from "lucide-react";
import { Card, Button, ScrollArea } from "../../../components/ui";

interface AIPanelProps {
  userId: string;
  /** The live <video> element to sample camera frames from. */
  video: HTMLVideoElement | null;
  /** Whether the livestream is currently active (frames are available). */
  streamActive: boolean;
}

/** One entry in the conversation log — a question asked or an answer given. */
interface AIMessage {
  id: number;
  role: "user" | "ai";
  text: string;
  done: boolean;
}

type Mode = "passive" | "active" | "outdoor" | "auto";

/** Mode metadata for the selector buttons + badge. */
const MODE_INFO: Record<
  Mode,
  { label: string; icon: typeof Eye; hint: string }
> = {
  passive: { label: "Passive", icon: Eye, hint: "narrates meaningful changes" },
  active: { label: "Active", icon: MessageCircle, hint: "direct Q&A" },
  outdoor: { label: "Outdoor", icon: TreePine, hint: "hazards & navigation" },
  auto: { label: "Auto", icon: Wand2, hint: "adapts to the scene" },
};

const SELECTABLE_MODES: Mode[] = ["passive", "outdoor", "auto"];

/** How often to push a camera frame to the AI, in milliseconds. */
const FRAME_INTERVAL_MS = 1000;
/** Downscaled frame width sent to the AI — smaller = faster, cheaper. */
const FRAME_WIDTH = 640;

/**
 * AIPanel — shows the AI conversation and lets the wearer (or operator)
 * peek at state.
 *
 * The AI is ALWAYS-ON now: the server auto-connects Gemini Live the moment
 * the glasses session starts. This panel no longer has a Connect button.
 * It samples frames from the live <video> whenever the livestream is up,
 * subscribes to the AI's SSE stream for the conversation log, and reflects
 * the current state (mode + AI-connected) so we can see what the AI sees.
 */
export function AIPanel({ userId, video, streamActive }: AIPanelProps) {
  const [aiConnected, setAiConnected] = useState(false);
  const [mode, setMode] = useState<Mode>("passive");
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const msgIdRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── AI response SSE — runs the whole time the user has a session. ──
  useEffect(() => {
    if (!userId) return;
    let es: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      es = new EventSource(`/api/ai-stream?userId=${encodeURIComponent(userId)}`);
      es.onopen = () => setAiConnected(true);
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "connected") return;

          // Mode updates — reflect the current orchestrator mode.
          if (data.type === "mode") {
            if (data.mode) setMode(data.mode as Mode);
            return;
          }

          // Everything else is a conversation message.
          const role: "user" | "ai" = data.role === "user" ? "user" : "ai";

          setMessages((prev) => {
            // A user question always arrives complete in a single event.
            if (role === "user") {
              return [
                { id: msgIdRef.current++, role, text: data.text ?? "", done: true },
                ...prev,
              ].slice(0, 20);
            }

            // AI answers stream: accumulate into the open AI message if the
            // newest entry is an unfinished AI message.
            const last = prev[0];
            if (last && last.role === "ai" && !last.done) {
              const updated = [...prev];
              updated[0] = {
                ...last,
                text: last.text + (data.text ?? ""),
                done: data.done,
              };
              return updated;
            }
            // Skip a lone empty turn-complete marker.
            if (!data.text && data.done) return prev;
            return [
              { id: msgIdRef.current++, role, text: data.text ?? "", done: data.done },
              ...prev,
            ].slice(0, 20);
          });
        } catch {
          /* ignore malformed frames */
        }
      };
      es.onerror = () => {
        setAiConnected(false);
        es?.close();
        reconnect = setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      setAiConnected(false);
      es?.close();
      if (reconnect) clearTimeout(reconnect);
    };
  }, [userId]);

  // ── Frame sampling loop ──────────────────────────────────────────
  useEffect(() => {
    if (!aiConnected || !streamActive || !video) return;

    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    const canvas = canvasRef.current;

    const sendFrame = async () => {
      if (video.videoWidth === 0) return; // not playing yet
      const scale = FRAME_WIDTH / video.videoWidth;
      canvas.width = FRAME_WIDTH;
      canvas.height = Math.round(video.videoHeight * scale);

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
      try {
        await fetch("/api/ai/frame", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, frame: dataUrl }),
        });
      } catch {
        /* a dropped frame is fine — the next one is ~1s away */
      }
    };

    const timer = setInterval(sendFrame, FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [aiConnected, streamActive, video, userId]);

  const log = useCallback((msg: string) => console.log(`[AIPanel] ${msg}`), []);

  /** Manually switch the AI mode. The SSE 'mode' event confirms it. */
  const changeMode = async (next: Mode) => {
    if (next === mode) return;
    log(`Switching mode → ${next}`);
    try {
      const res = await fetch("/api/ai/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, mode: next }),
      });
      const data = await res.json();
      if (!res.ok) log(`Mode switch failed: ${data.error ?? res.status}`);
    } catch (err) {
      log(`Mode switch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const ModeIcon = MODE_INFO[mode].icon;

  return (
    <Card className="p-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">AI Assistant</span>
          {/* AI status dot */}
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                aiConnected ? "bg-chart-4" : "bg-muted-foreground/40 animate-pulse"
              }`}
            />
            {aiConnected ? "connected" : "connecting…"}
          </span>
          {aiConnected && (
            <>
              {/* Current-mode badge */}
              <span className="flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-medium">
                <ModeIcon className="w-3 h-3" />
                {MODE_INFO[mode].label}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {streamActive ? "watching camera" : "camera off"}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Mode selector — manual override. Active mode is wake-word only,
          so it isn't a button; it shows as the badge when a Q&A is live. */}
      {aiConnected && (
        <div className="flex gap-1.5 p-2.5 border-b">
          {SELECTABLE_MODES.map((m) => {
            const Icon = MODE_INFO[m].icon;
            const isCurrent = mode === m;
            return (
              <button
                key={m}
                onClick={() => changeMode(m)}
                title={MODE_INFO[m].hint}
                className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                  isCurrent
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {MODE_INFO[m].label}
              </button>
            );
          })}
        </div>
      )}

      {/* Conversation log — questions asked + answers given, newest first */}
      <ScrollArea className="h-56">
        <div className="p-3 space-y-2">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8 px-3">
              {aiConnected
                ? 'Say "Hey Gemini, …" — try "turn on the camera", "switch to outdoor mode", or just ask what you see.'
                : "Waiting for the glasses session…"}
            </p>
          ) : (
            messages.map((m) =>
              m.role === "user" ? (
                // A question the user asked.
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] p-2.5 rounded-lg bg-primary text-primary-foreground text-sm">
                    <span className="block text-[10px] uppercase tracking-wider opacity-70 mb-0.5">
                      You asked
                    </span>
                    {m.text}
                  </div>
                </div>
              ) : (
                // An answer from the AI.
                <div key={m.id} className="flex justify-start">
                  <div className="max-w-[85%] p-2.5 rounded-lg bg-muted/50 text-sm text-foreground">
                    <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                      Gemini
                    </span>
                    {m.text || (
                      <span className="text-muted-foreground italic">thinking…</span>
                    )}
                    {!m.done && m.text && (
                      <span className="inline-block w-1.5 h-3 ml-0.5 bg-foreground/50 animate-pulse align-middle" />
                    )}
                  </div>
                </div>
              ),
            )
          )}
        </div>
      </ScrollArea>
    </Card>
  );
}
