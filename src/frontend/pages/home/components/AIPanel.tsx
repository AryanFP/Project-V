import { useEffect, useRef, useState, useCallback } from "react";

interface AIPanelProps {
  userId: string;
  /** The live <video> element to sample camera frames from. */
  video: HTMLVideoElement | null;
  /** Whether the livestream is currently active (frames are available). */
  streamActive: boolean;
}

type Mode = "proactive" | "active" | "outdoor" | "auto";
type AISource = "live" | "proactive" | "memory";

/** One entry in the conversation log. */
interface AIMessage {
  id: number;
  role: "user" | "ai";
  text: string;
  done: boolean;
  source: AISource;
  /** Wall-clock time we received this message — used for the "2:14 pm" label. */
  at: number;
}

/** How often to push a camera frame to the AI. */
const FRAME_INTERVAL_MS = 1000;
/** Downscaled frame width sent to the AI. */
const FRAME_WIDTH = 640;

/**
 * AIPanel — Paper-designed assistant card.
 *
 * Functionally identical to the prior version:
 *   - subscribes to /api/ai-stream for the conversation log (Gemini Live
 *     answers + proactive narrations + memory confirmations)
 *   - samples camera frames at 1 fps and POSTs to /api/ai/frame for the
 *     wake-word Q&A path
 *   - lets the wearer / operator switch mode
 *
 * Visual structure follows the Paper export: header with brand mark +
 * "Proactive · watching camera" pill; two-up mode tiles (Proactive / Active);
 * conversation list with per-source bubbles; "Listening" footer.
 */
export function AIPanel({ userId, video, streamActive }: AIPanelProps) {
  const [aiConnected, setAiConnected] = useState(false);
  const [mode, setMode] = useState<Mode>("proactive");
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const msgIdRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── AI response SSE ──────────────────────────────────────────────
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

          if (data.type === "mode") {
            if (data.mode) setMode(data.mode as Mode);
            return;
          }

          const role: "user" | "ai" = data.role === "user" ? "user" : "ai";
          const source: AISource =
            data.source === "proactive" || data.source === "memory"
              ? data.source
              : "live";

          setMessages((prev) => {
            const now = Date.now();
            if (role === "user") {
              return [
                {
                  id: msgIdRef.current++,
                  role,
                  text: data.text ?? "",
                  done: true,
                  source,
                  at: now,
                },
                ...prev,
              ].slice(0, 20);
            }

            // AI answers stream — accumulate into the open AI message if it
            // exists AND the source matches. Proactive narrations and memory
            // confirmations arrive complete (done:true) and must never merge
            // into an in-flight live answer.
            const last = prev[0];
            if (
              last &&
              last.role === "ai" &&
              !last.done &&
              last.source === source
            ) {
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
              {
                id: msgIdRef.current++,
                role,
                text: data.text ?? "",
                done: data.done,
                source,
                at: now,
              },
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
      if (video.videoWidth === 0) return;
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
        /* dropped frame is fine */
      }
    };

    const timer = setInterval(sendFrame, FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [aiConnected, streamActive, video, userId]);

  const log = useCallback((msg: string) => console.log(`[AIPanel] ${msg}`), []);

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

  // Reverse chronological → display chronological (oldest at top, newest
  // at bottom) so the conversation reads naturally like a chat.
  const ordered = [...messages].reverse();

  return (
    <div className="flex flex-col w-full rounded-3xl overflow-hidden bg-white border border-solid border-[#E8EAED]">
      {/* Header */}
      <div className="flex items-center justify-between py-5 px-6 border-b border-solid border-[#E8EAED]">
        <div className="flex items-center gap-3.5">
          <div
            className="flex items-center justify-center rounded-xl shrink-0 w-10 h-10"
            style={{
              backgroundImage:
                "linear-gradient(135deg, #4796E3 0%, #9168C0 50%, #E25361 100%)",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2l2.39 7.36L22 12l-7.61 2.64L12 22l-2.39-7.36L2 12l7.61-2.64L12 2z"
                fill="#FFFFFF"
              />
            </svg>
          </div>
          <div className="flex flex-col">
            <div
              className="font-['Roboto',system-ui,sans-serif] font-medium text-[#1F1F1F] text-lg leading-tight"
              style={{ letterSpacing: "-0.005em" }}
            >
              Gemini Assistant
            </div>
            <div className="flex items-center gap-1.5">
              <div
                className={`rounded-full shrink-0 w-1.5 h-1.5 ${
                  aiConnected ? "bg-[#188038]" : "bg-[#80868B] animate-pulse"
                }`}
              />
              <div className="font-['Roboto',system-ui,sans-serif] text-[#5F6368] text-[13px]">
                {aiConnected
                  ? "Connected · gemini-3.1-flash-live"
                  : "Connecting…"}
              </div>
            </div>
          </div>
        </div>

        {/* Mode pill on the right */}
        {aiConnected && (
          <div
            className={`flex items-center rounded-full py-2 px-3.5 gap-2 ${
              mode === "active" ? "bg-[#F1F3F4]" : "bg-[#E8F0FE]"
            }`}
          >
            {mode === "active" ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"
                  fill="#5F6368"
                />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
                  stroke="#0B57D0"
                  strokeWidth="2"
                />
                <circle cx="12" cy="12" r="3" stroke="#0B57D0" strokeWidth="2" />
              </svg>
            )}
            <div
              className={`font-['Roboto',system-ui,sans-serif] font-medium text-[13px] ${
                mode === "active" ? "text-[#5F6368]" : "text-[#0B57D0]"
              }`}
            >
              {mode === "active"
                ? "Active · wake word only"
                : mode === "proactive"
                ? streamActive
                  ? "Proactive · watching camera"
                  : "Proactive · camera off"
                : mode === "outdoor"
                ? "Outdoor · navigation priority"
                : "Auto · adapts to scene"}
            </div>
          </div>
        )}
      </div>

      {/* Mode tiles — Proactive vs Active. Outdoor + Auto are still
          selectable via voice but we keep this UI to the two demo headlines. */}
      {aiConnected && (
        <div className="flex p-4 gap-2.5 border-b border-solid border-[#E8EAED]">
          <ModeTile
            label="Proactive"
            description="Narrates meaningful changes in the scene"
            active={mode === "proactive"}
            tone="blue"
            badgeText={mode === "proactive" ? "ON" : "OFF"}
            onClick={() => changeMode("proactive")}
          />
          <ModeTile
            label="Active"
            description='Silent until "Hey Gemini" is heard'
            active={mode === "active"}
            tone="red"
            badgeText="WAKE"
            onClick={() => changeMode("active")}
          />
        </div>
      )}

      {/* Conversation */}
      <div className="flex flex-col py-5 px-6 gap-4">
        <div className="flex items-center justify-between">
          <div
            className="uppercase font-['Roboto',system-ui,sans-serif] font-medium text-[#5F6368] text-[11px]"
            style={{ letterSpacing: "0.1em" }}
          >
            Conversation
          </div>
          <div className="font-['Roboto',system-ui,sans-serif] text-[#5F6368] text-xs">
            Voice + camera · last 60s in context
          </div>
        </div>

        <div className="flex flex-col gap-4 max-h-96 overflow-y-auto pr-1">
          {ordered.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <p className="font-['Roboto',system-ui,sans-serif] text-[#5F6368] text-sm">
                {aiConnected
                  ? 'Say "Hey Gemini, …" to start a conversation.'
                  : "Waiting for the glasses session…"}
              </p>
            </div>
          ) : (
            ordered.map((m) => <MessageBubble key={m.id} message={m} />)
          )}
        </div>

        {/* "Listening" footer pill */}
        <div className="flex items-center mt-2 rounded-full py-3.5 px-4.5 gap-3 bg-[#F8FAFC] border border-solid border-[#E8EAED]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"
              fill="#0B57D0"
            />
            <path
              d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"
              stroke="#0B57D0"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <div className="grow font-['Roboto',system-ui,sans-serif] text-[#5F6368] text-[15px]">
            Say "Hey Gemini, …" to ask, remember, or recall
          </div>
          <div className="flex items-center rounded-full py-1 px-2.5 gap-1.5 bg-white border border-solid border-[#E8EAED]">
            <div
              className={`rounded-full shrink-0 w-1.5 h-1.5 ${
                aiConnected ? "bg-[#188038]" : "bg-[#80868B] animate-pulse"
              }`}
            />
            <div className="font-['Roboto',system-ui,sans-serif] font-medium text-[#3C4043] text-xs">
              {aiConnected ? "Listening" : "Offline"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

interface ModeTileProps {
  label: string;
  description: string;
  active: boolean;
  tone: "blue" | "red";
  badgeText: string;
  onClick: () => void;
}

function ModeTile({
  label,
  description,
  active,
  tone,
  badgeText,
  onClick,
}: ModeTileProps) {
  const blue = tone === "blue";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 flex-col rounded-2xl p-4 gap-3 text-left transition-colors border border-solid ${
        active && blue
          ? "bg-[#E8F0FE] border-[#D2E3FC]"
          : active && !blue
          ? "bg-[#FCE8E6] border-[#F4C7C3]"
          : "bg-white border-[#E8EAED] hover:bg-[#F8FAFC]"
      }`}
    >
      <div className="flex items-center justify-between">
        <div
          className={`flex items-center justify-center rounded-full shrink-0 w-9 h-9 ${
            blue ? "bg-[#0B57D0]" : "bg-[#FCE8E6]"
          }`}
        >
          {blue ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
                stroke="#FFFFFF"
                strokeWidth="2"
              />
              <circle cx="12" cy="12" r="3" fill="#FFFFFF" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"
                fill="#D93025"
              />
            </svg>
          )}
        </div>
        <div
          className={`flex items-center justify-center rounded-full py-1 px-2 ${
            active && blue
              ? "bg-[#0B57D0]"
              : active && !blue
              ? "bg-[#D93025]"
              : "bg-[#F1F3F4]"
          }`}
        >
          <div
            className="uppercase font-['Roboto',system-ui,sans-serif] font-semibold text-[10px]"
            style={{
              letterSpacing: "0.08em",
              color: active ? "#FFFFFF" : "#5F6368",
            }}
          >
            {badgeText}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div
          className={`font-['Roboto',system-ui,sans-serif] font-medium text-[15px] ${
            active && blue
              ? "text-[#0B57D0]"
              : active && !blue
              ? "text-[#B7261E]"
              : "text-[#1F1F1F]"
          }`}
        >
          {label}
        </div>
        <div
          className={`font-['Roboto',system-ui,sans-serif] text-xs ${
            active && blue
              ? "text-[#1967D2]"
              : active && !blue
              ? "text-[#B7261E]"
              : "text-[#5F6368]"
          }`}
        >
          {description}
        </div>
      </div>
    </button>
  );
}

function MessageBubble({ message }: { message: AIMessage }) {
  const isUser = message.role === "user";
  const timeLabel = new Date(message.at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  if (isUser) {
    return (
      <div className="flex items-start justify-end gap-3">
        <div className="flex flex-col items-end gap-1.5 max-w-[80%]">
          <div
            className="uppercase font-['Roboto',system-ui,sans-serif] font-medium text-[#5F6368] text-[11px]"
            style={{ letterSpacing: "0.06em" }}
          >
            You · {timeLabel.toLowerCase()}
          </div>
          <div className="rounded-tl-[18px] rounded-tr-md rounded-br-[18px] rounded-bl-[18px] py-3.5 px-4.5 bg-[#0B57D0]">
            <div className="font-['Roboto',system-ui,sans-serif] text-white text-[15px] leading-snug">
              {message.text}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-center shrink-0 rounded-full bg-[#E8EAED] w-8 h-8">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="8" r="4" fill="#5F6368" />
            <path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8" fill="#5F6368" />
          </svg>
        </div>
      </div>
    );
  }

  // AI side — per-source label + optional tool pill (for memory).
  const sourceLabel =
    message.source === "proactive"
      ? "Gemini · proactive"
      : message.source === "memory"
      ? "Gemini · memory"
      : "Gemini";

  return (
    <div className="flex items-start gap-3">
      <div
        className="flex items-center justify-center shrink-0 rounded-full w-8 h-8"
        style={{
          backgroundImage:
            "linear-gradient(135deg, #4796E3 0%, #9168C0 50%, #E25361 100%)",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 2l2.39 7.36L22 12l-7.61 2.64L12 22l-2.39-7.36L2 12l7.61-2.64L12 2z"
            fill="#FFFFFF"
          />
        </svg>
      </div>
      <div className="flex flex-col gap-1.5 max-w-[80%]">
        <div
          className="uppercase font-['Roboto',system-ui,sans-serif] font-medium text-[#5F6368] text-[11px]"
          style={{ letterSpacing: "0.06em" }}
        >
          {sourceLabel} · {timeLabel.toLowerCase()}
        </div>
        {message.source === "memory" && (
          <div className="flex items-center self-start rounded-full py-2 px-3 gap-2 bg-[#FEF7E0]">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="#B06000" strokeWidth="2" />
              <path
                d="M12 6v6l4 2"
                stroke="#B06000"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <div
              className="font-['Roboto_Mono',system-ui,monospace] font-medium text-[#B06000] text-[11px]"
              style={{ letterSpacing: "0.04em" }}
            >
              memory tool
            </div>
          </div>
        )}
        <div
          className={`rounded-tl-md rounded-tr-[18px] rounded-br-[18px] rounded-bl-[18px] py-3.5 px-4.5 ${
            message.source === "proactive"
              ? "bg-[#E8F0FE] border border-solid border-[#D2E3FC]"
              : "bg-[#F1F3F4]"
          }`}
        >
          <div className="font-['Roboto',system-ui,sans-serif] text-[#1F1F1F] text-[15px] leading-snug">
            {message.text || (
              <span className="text-[#80868B] italic">thinking…</span>
            )}
            {!message.done && message.text && (
              <span className="inline-block w-1.5 h-3 ml-0.5 bg-[#5F6368] animate-pulse align-middle" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
