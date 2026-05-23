export interface Transcription {
  id: number;
  text: string;
  time: string;
  isFinal: boolean;
}

interface TranscriptionFeedProps {
  transcriptions: Transcription[];
}

/**
 * TranscriptionFeed — Paper-designed live transcription card.
 *
 * Same data shape as before (an array of partial/final transcription rows,
 * newest first). Each entry shows a colored dot (orange for partial, green
 * for final), a monospace timestamp, a status pill, and the transcribed
 * text. The first entry visually pops if it's still PARTIAL so the wearer's
 * companion can tell the system is actively listening.
 */
export function TranscriptionFeed({ transcriptions }: TranscriptionFeedProps) {
  const hasPartialAtTop = transcriptions[0]?.isFinal === false;

  return (
    <div className="flex flex-col w-full rounded-3xl overflow-hidden bg-white border border-solid border-[#E8EAED]">
      {/* Header */}
      <div className="flex items-center justify-between py-5 px-6 border-b border-solid border-[#E8EAED]">
        <div className="flex items-center gap-3.5">
          <div className="flex items-center justify-center rounded-xl shrink-0 bg-[#FEF7E0] w-10 h-10">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 18v3M7 14v7M11 10v11M15 6v15M19 12v9M23 8v9"
                stroke="#F29900"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div className="flex flex-col">
            <div className="font-['Roboto',system-ui,sans-serif] font-medium text-[#1F1F1F] text-base leading-tight">
              Live transcription
            </div>
            <div className="font-['Roboto',system-ui,sans-serif] text-[#5F6368] text-[13px]">
              Last 10 turns · partials replace in place
            </div>
          </div>
        </div>
        <div
          className={`flex items-center rounded-full py-1.5 px-3 gap-1.5 ${
            hasPartialAtTop ? "bg-[#FEF7E0]" : "bg-[#E6F4EA]"
          }`}
        >
          <div
            className={`rounded-full shrink-0 w-1.5 h-1.5 ${
              hasPartialAtTop ? "bg-[#F29900] animate-pulse" : "bg-[#188038]"
            }`}
          />
          <div
            className={`font-['Roboto',system-ui,sans-serif] font-medium text-xs ${
              hasPartialAtTop ? "text-[#B06000]" : "text-[#188038]"
            }`}
          >
            {hasPartialAtTop ? "Partial" : "Idle"}
          </div>
        </div>
      </div>

      <div className="flex flex-col py-4 px-4 gap-2 max-h-96 overflow-y-auto">
        {transcriptions.length === 0 ? (
          <div className="flex items-center justify-center py-10">
            <p className="font-['Roboto',system-ui,sans-serif] text-[#5F6368] text-sm">
              Listening for audio input…
            </p>
          </div>
        ) : (
          transcriptions.map((t) => <TranscriptionRow key={t.id} entry={t} />)
        )}
      </div>
    </div>
  );
}

function TranscriptionRow({ entry }: { entry: Transcription }) {
  const isPartial = !entry.isFinal;
  const rowBg = isPartial ? "bg-[#FEF7E0] border-[#FCE7B6]" : "bg-[#F8FAFC] border-[#E8EAED]";
  const dotColor = isPartial ? "bg-[#F29900]" : "bg-[#188038]";
  const timestampColor = isPartial ? "text-[#B06000]" : "text-[#3C4043]";
  const badgeBg = isPartial ? "bg-[#FCE7B6]" : "bg-[#E6F4EA]";
  const badgeText = isPartial ? "text-[#B06000]" : "text-[#137333]";

  return (
    <div
      className={`flex flex-col rounded-xl py-3 px-3.5 gap-1.5 border border-solid ${rowBg}`}
    >
      <div className="flex items-center gap-2">
        <div className={`shrink-0 rounded-full w-1.5 h-1.5 ${dotColor} ${isPartial ? "animate-pulse" : ""}`} />
        <div
          className={`grow font-['Roboto_Mono',system-ui,monospace] font-medium text-[11px] ${timestampColor}`}
          style={{ letterSpacing: "0.04em" }}
        >
          {entry.time}
        </div>
        <div className={`flex items-center rounded-full py-0.5 px-2 ${badgeBg}`}>
          <div
            className={`uppercase font-['Roboto',system-ui,sans-serif] font-semibold text-[10px] ${badgeText}`}
            style={{ letterSpacing: "0.08em" }}
          >
            {isPartial ? "Partial" : "Final"}
          </div>
        </div>
      </div>
      <div className="font-['Roboto',system-ui,sans-serif] text-[#1F1F1F] text-[13px] leading-snug">
        {isPartial ? `"…${entry.text.replace(/^…?/, "")}"` : entry.text}
      </div>
    </div>
  );
}
