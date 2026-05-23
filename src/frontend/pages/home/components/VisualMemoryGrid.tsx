import { useEffect, useState, useCallback } from "react";

interface MemoryRow {
  id: string;
  userId: string;
  sessionId: string;
  createdAt: number;
  caption: string;
  entities: Array<{ type: string; name: string; location?: string; notes?: string }>;
  transcript: string | null;
  frameCount: number;
  thumbB64: string | null;
}

interface VisualMemoryGridProps {
  userId: string;
  /** Triggers a refetch when this changes — used to update right after a
   *  fresh "remember this" capture lands. */
  refreshKey?: number;
}

/** Refresh cadence even when no remember event fires. */
const POLL_INTERVAL_MS = 15_000;
/** How many memories to fetch per request. */
const PAGE_SIZE = 20;

/**
 * VisualMemoryGrid — Paper-designed gallery of stored visual memories.
 *
 * Fetches /api/memories, groups by day (Today / Yesterday / older dates),
 * renders the thumbnail JPEG (from thumb_b64) over a colored chip for the
 * dominant entity type. Empty state shows a hint to say "remember this".
 *
 * No new dependency on the existing components — this is a new card slotted
 * into HomePage between AIPanel and the transcription feed.
 */
export function VisualMemoryGrid({ userId, refreshKey }: VisualMemoryGridProps) {
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchMemories = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/memories?userId=${encodeURIComponent(userId)}&limit=${PAGE_SIZE}`,
      );
      const data = await res.json();
      if (Array.isArray(data?.memories)) {
        setMemories(data.memories as MemoryRow[]);
      }
    } catch {
      /* network blip — next poll will retry */
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Initial + when a fresh memory is added (refreshKey bump).
  useEffect(() => {
    void fetchMemories();
  }, [fetchMemories, refreshKey]);

  // Periodic poll so the grid stays roughly fresh.
  useEffect(() => {
    const t = setInterval(fetchMemories, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [fetchMemories]);

  const groups = groupByDay(memories);

  return (
    <div className="flex flex-col w-full rounded-3xl overflow-hidden bg-white border border-solid border-[#E8EAED]">
      {/* Header */}
      <div className="flex items-center justify-between py-5 px-6 border-b border-solid border-[#E8EAED]">
        <div className="flex items-center gap-3.5">
          <div className="flex items-center justify-center rounded-xl shrink-0 bg-[#E6F4EA] w-10 h-10">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18a8 8 0 110-16 8 8 0 010 16z"
                fill="#188038"
              />
              <path d="M12.5 7H11v6l5.25 3.15.75-1.23L12.5 12.25V7z" fill="#188038" />
            </svg>
          </div>
          <div className="flex flex-col">
            <div
              className="font-['Roboto',system-ui,sans-serif] font-medium text-[#1F1F1F] text-lg leading-tight"
              style={{ letterSpacing: "-0.005em" }}
            >
              Visual memory
            </div>
            <div className="font-['Roboto',system-ui,sans-serif] text-[#5F6368] text-[13px]">
              {memories.length === 0
                ? loading
                  ? "Loading saved moments…"
                  : "No moments saved yet"
                : `${memories.length} moments saved · embedded with gemini-embedding-001`}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col py-5 px-6 gap-4">
        {memories.length === 0 ? (
          <div className="flex items-center justify-center py-10">
            <p className="font-['Roboto',system-ui,sans-serif] text-[#5F6368] text-sm text-center max-w-md">
              Say{" "}
              <span className="font-medium text-[#1F1F1F]">"Hey Gemini, remember this"</span>{" "}
              while the camera is on. Your moments will appear here for later recall.
            </p>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="flex flex-col gap-4">
              {/* Day section divider */}
              <div className="flex items-center gap-3">
                <div
                  className="font-['Roboto',system-ui,sans-serif] font-medium text-[#1F1F1F] text-[13px]"
                  style={{ letterSpacing: "0.02em" }}
                >
                  {g.label}
                </div>
                <div className="grow h-px bg-[#E8EAED]" />
                <div className="font-['Roboto',system-ui,sans-serif] text-[#80868B] text-xs">
                  {g.dateLabel} · {g.items.length} {g.items.length === 1 ? "moment" : "moments"}
                </div>
              </div>

              {/* 3-up grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {g.items.map((m) => (
                  <MemoryCard key={m.id} memory={m} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Memory card ────────────────────────────────────────────────────────

function MemoryCard({ memory }: { memory: MemoryRow }) {
  const primary = memory.entities[0];
  const tone = entityTone(primary?.type);

  // Thumbnail: prefer the real frame, fall back to a tone-colored gradient.
  const thumbSrc = memory.thumbB64
    ? `data:image/jpeg;base64,${memory.thumbB64}`
    : null;

  // Friendly label: first entity name, else first ~6 words of caption.
  const label = primary?.name ?? truncateWords(memory.caption, 8);
  // Location line: entity location, else just the relative time + transcript
  // snippet.
  const ago = formatAgo(Date.now() - memory.createdAt);
  const locationLine = primary?.location
    ? `${capitalize(primary.location)} · ${ago} ago`
    : `${ago} ago`;

  const timeLabel = new Date(memory.createdAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="flex flex-col rounded-2xl overflow-hidden bg-white border border-solid border-[#E8EAED]">
      <div
        className="relative w-full h-40 shrink-0"
        style={{
          backgroundImage: thumbSrc ? undefined : tone.gradient,
        }}
      >
        {thumbSrc && (
          <img
            src={thumbSrc}
            alt={memory.caption}
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
        {/* Tag chip (top-left) */}
        <div className="top-2.5 left-2.5 flex items-center rounded-full py-1 px-2.5 gap-1.5 absolute bg-white/92 backdrop-blur-sm">
          <div className="rounded-full shrink-0 w-1.5 h-1.5" style={{ background: tone.dot }} />
          <div
            className="uppercase font-['Roboto',system-ui,sans-serif] font-medium text-[11px]"
            style={{ letterSpacing: "0.04em", color: tone.dot }}
          >
            {tone.label}
          </div>
        </div>
        {/* Timestamp chip (bottom-right) */}
        <div
          className="bottom-2.5 right-2.5 rounded-md py-1 px-2 absolute backdrop-blur-sm bg-black/48"
          style={{ backdropFilter: "blur(4px)" }}
        >
          <div
            className="uppercase font-['Roboto_Mono',system-ui,monospace] font-medium text-white text-[10px]"
            style={{ letterSpacing: "0.04em" }}
          >
            {timeLabel}
          </div>
        </div>
      </div>
      <div className="flex flex-col py-3.5 px-4 gap-1.5">
        <div className="font-['Roboto',system-ui,sans-serif] font-medium text-[#1F1F1F] text-sm leading-snug">
          {capitalize(label)}
        </div>
        <div className="font-['Roboto',system-ui,sans-serif] text-[#5F6368] text-xs leading-snug line-clamp-2">
          {capitalize(locationLine)}
        </div>
      </div>
    </div>
  );
}

// ── Grouping + tone helpers ────────────────────────────────────────────

interface DayGroup {
  label: string;
  dateLabel: string;
  items: MemoryRow[];
}

function groupByDay(memories: MemoryRow[]): DayGroup[] {
  if (memories.length === 0) return [];
  const today = startOfDay(Date.now());
  const yesterday = today - 24 * 60 * 60 * 1000;

  const map = new Map<number, MemoryRow[]>();
  for (const m of memories) {
    const k = startOfDay(m.createdAt);
    const arr = map.get(k) ?? [];
    arr.push(m);
    map.set(k, arr);
  }
  // Newest day first.
  return Array.from(map.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([k, items]) => {
      let label = new Date(k).toLocaleDateString([], { weekday: "long" });
      if (k === today) label = "Today";
      else if (k === yesterday) label = "Yesterday";
      const dateLabel = new Date(k).toLocaleDateString([], {
        month: "short",
        day: "numeric",
      });
      return { label, dateLabel, items };
    });
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface Tone {
  label: string;
  dot: string;
  /** CSS gradient used as a placeholder when there's no thumbnail. */
  gradient: string;
}

/** Map an entity type to a chip color + gradient backdrop. */
function entityTone(type: string | undefined): Tone {
  switch ((type ?? "").toLowerCase()) {
    case "person":
      return {
        label: "Person",
        dot: "#6B1DA8",
        gradient: "linear-gradient(135deg, #E0D4F7 0%, #9168C0 100%)",
      };
    case "place":
      return {
        label: "Location",
        dot: "#137164",
        gradient: "linear-gradient(135deg, #D9F2E5 0%, #5BB996 100%)",
      };
    case "action":
      return {
        label: "Action",
        dot: "#B06000",
        gradient: "linear-gradient(135deg, #FCE7B6 0%, #E2A03C 100%)",
      };
    case "object":
      return {
        label: "Object",
        dot: "#188038",
        gradient: "linear-gradient(135deg, #D6EBDB 0%, #59A36C 100%)",
      };
    default:
      return {
        label: "Memory",
        dot: "#0B57D0",
        gradient: "linear-gradient(135deg, #D2E3FC 0%, #6E9DDC 100%)",
      };
  }
}

function formatAgo(deltaMs: number): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

function truncateWords(s: string, n: number): string {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length <= n) return s;
  return words.slice(0, n).join(" ") + "…";
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
