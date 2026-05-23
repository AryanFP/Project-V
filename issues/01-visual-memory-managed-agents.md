# 01 — Visual Memory via Mastra + Gemini 3.5 Flash

**Status:** Planning
**Hackathon:** Google I/O Hackathon, 2026-05-23 (today)
**Submission cutoff:** 5:00 PM PT
**Target prize:** Best Use of Managed Agents ($5K) + main pool

---

## 1. What we are building

A **visual memory layer** for Project-V (vision assistant for visually impaired users on Mentra Live smart glasses).

Today the glasses can answer "what's in front of me right now?" via Gemini Live. They see everything but remember nothing.

We are adding the ability for the wearer to say **"Hey Gemini, remember this"** and have the agent pull ~3 seconds of frames out of the active WebRTC livestream (via ffmpeg against the `hlsUrl`) plus the surrounding transcript context, then persist that as one searchable memory. Later, the wearer can ask **"where did I leave my keys?"** or **"did I take my pills today?"** and the agent retrieves the relevant moment and answers in audio through the existing pipeline.

**Important constraint:** while the WebRTC livestream is active, `session.camera.requestPhoto()` does NOT work — the glasses can stream OR shoot stills, not both. Project-V is always streaming during use. So frames during a "remember" must come from the live pipeline, not from `requestPhoto()`.

### Demo pitch (90 seconds on stage)

1. Walk past a kitchen, glance at keys, say "Hey Gemini, remember this." → glasses confirm.
2. Look at a pill bottle, say "Hey Gemini, remember I took my aspirin." → confirm.
3. Later: "Hey Gemini, where did I leave my keys?" → "On the kitchen counter, next to the blue mug, about 4 minutes ago."
4. "Did I take my aspirin today?" → "Yes, around 2:14 PM."

That's the entire pitch. Accessibility-first, emotionally resonant, demonstrates true agent memory over a continuous sensory stream.

---

## 2. Why this counts as Managed Agents

Gemini Live (what we use today) is a real-time bidirectional audio session. It is *not* the Managed Agents API.

**Managed Agents** is the hosted Gemini runtime designed for long-horizon, multi-step, sub-agent work. Memory ingestion + retrieval is intrinsically:

- **Long-horizon** — memories accumulate over hours of glasses-on time
- **Multi-step** — frame + transcript → caption → entity extraction → embed → store; on query → retrieve → re-rank → synthesize
- **Background / async** — the user doesn't wait for indexing
- **Sub-agent friendly** — one agent captions, one retrieves, one answers

This is the most appropriate Google API surface for this feature. The story for judges: *"Gemini Live is the user's ears and mouth. The Managed Agent is the user's memory."*

---

## 3. Model

**Gemini 3.5 Flash** — `gemini-3.5-flash`

- Multimodal (text + image + audio + video)
- Tool use / function calling
- 1M context window, 65k max output
- Thinking levels (use `low` for fast tool routing, `medium` for synthesis)
- GA, optimized for agentic + coding tasks

Used for:
- Captioning frames at remember-time
- Entity extraction from caption + transcript
- Retrieval re-ranking + answer synthesis on recall queries

Existing Gemini Live model (`gemini-3.1-flash-live-preview`) **stays** for the realtime audio loop — we are not replacing it. We are adding a sibling path.

---

## 4. Architecture

```
                    ┌──────────────────────────────────────────┐
                    │           Mentra Live Glasses            │
                    │  camera ─┐         mic ─┐    speaker ◀── │
                    └──────────┼──────────────┼────────────────┘
                               │              │
                  WebRTC frames│       ASR text (transcription)
                               ▼              ▼
                    ┌──────────────────────────────────────────┐
                    │       Bun + Hono App (existing)          │
                    │                                          │
                    │  ┌────────────────┐  ┌────────────────┐  │
                    │  │ HlsBurst       │  │ Transcription  │  │
                    │  │ ffmpeg pull    │  │   Manager      │  │
                    │  │ hlsUrl, ~3s    │  │ (rolling text) │  │
                    │  └────────────────┘  └────────────────┘  │
                    │           │                  │           │
                    │           ▼                  ▼           │
                    │  ┌────────────────────────────────────┐  │
                    │  │   IntentRouter (NEW)               │  │
                    │  │   - "remember this"     ───────┐   │  │
                    │  │   - "where/when/did I…" ────┐  │   │  │
                    │  │   - everything else  ─┐     │  │   │  │
                    │  └───────────────────────┼─────┼──┼───┘  │
                    │                          │     │  │      │
                    │            ┌─────────────┘     │  │      │
                    │            ▼                   ▼  ▼      │
                    │   ┌─────────────────┐  ┌────────────────┐│
                    │   │ Gemini Live     │  │ Mastra Memory  ││
                    │   │ (existing ask)  │  │ Agent (NEW)    ││
                    │   └─────────────────┘  │ gemini-3.5-fl. ││
                    │            │           └────────────────┘│
                    │            │                   │         │
                    │            │           ┌───────┴──────┐  │
                    │            │           ▼              ▼  │
                    │            │   ┌────────────┐  ┌─────────┴┐
                    │            │   │ remember   │  │ recall    │
                    │            │   │ tool       │  │ tool      │
                    │            │   └─────┬──────┘  └─────┬─────┘
                    │            │         │               │     │
                    │            │         ▼               ▼     │
                    │            │   ┌──────────────────────────┐│
                    │            │   │ LibSQL (memories.db)     ││
                    │            │   │  - memories table        ││
                    │            │   │  - vector index          ││
                    │            │   └──────────────────────────┘│
                    │            ▼                               │
                    │   audio chunks ────────────────────────────┤
                    └──────────────────────────────────────────┘─┘
                                            │
                                            ▼ PCM stream
                                       glasses speaker
```

### Key principles

- **One audio output path**: both Gemini Live and the Mastra agent eventually produce text that goes through the existing `streamPcm` → speaker pipeline. We do NOT add a second response channel.
- **No continuous frame buffer**: the WebRTC livestream is brokered by Mentra cloud + Cloudflare Live Input; the Bun server doesn't have JPEGs in hand at rest. Frames are pulled **only when the user says "remember this"**.
- **Frame source = `hlsUrl` via ffmpeg**: `session.camera.startManagedStream()` already returns an `hlsUrl` alongside the WHEP URL. On remember, we spawn ffmpeg against `hlsUrl` for ~3s and pipe out JPEGs at ~2fps. ffmpeg is already in the container (AudioManager uses it for MP3 encoding). `requestPhoto()` is unavailable mid-stream and we do NOT use it.
- **HLS has ~4-10s delay vs live**: this is acceptable — for the demo cases (keys, pill bottle, signs) the user dwells on the subject for several seconds before saying "remember this". Demo coaching: look at the thing, *then* say it.
- **Transcript context comes for free**: TranscriptionManager already keeps recent transcript. We just slice the last ~10s of text at remember-time.
- **Mastra agent runs server-side**: it is not a separate service. Lives in the same Bun process.

---

## 5. Storage shape (LibSQL)

Single file: `data/memories.db`. One table + a vector index.

```sql
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,          -- ms since epoch
  caption       TEXT NOT NULL,             -- "keys on kitchen counter next to blue mug"
  entities      TEXT NOT NULL,             -- JSON: [{type, name, location?, ...}]
  transcript    TEXT,                      -- last ~10s of user speech around the moment
  frame_count   INTEGER NOT NULL,          -- how many frames the burst captured (typically 3-6)
  thumb_b64     TEXT,                      -- one representative frame as small jpeg base64
  embedding     F32_BLOB(768)              -- caption embedding (text-embedding-004)
);

CREATE INDEX memories_user_time ON memories(user_id, created_at DESC);
CREATE INDEX memories_vec ON memories(libsql_vector_idx(embedding));
```

Why this shape:
- `caption` does the heavy lifting for semantic search.
- `entities` lets us answer "where is X" with structured lookup before falling back to vector.
- `transcript` captures intent the camera missed ("I'm putting them here for tonight").
- `thumb_b64` lets the recall agent re-inspect the original moment via Gemini 3.5 Flash vision if needed.
- One embedding column — keep it simple.

---

## 6. Mastra integration

### Dependencies to add

```json
"@mastra/core": "^1.4.0",
"@mastra/memory": "latest",
"@mastra/libsql": "latest",
"@ai-sdk/google": "latest"
```

No new API keys. Google credentials already configured. Mastra itself is open-source, no account.

### Mirror what Mentra-AI does, extend where it doesn't

Mentra-AI uses `@mastra/core` only — agent + tools, no memory primitives, history hand-rolled in Mongo. We follow their **agent + tools** pattern exactly. We **add** `@mastra/memory` + LibSQL on top because visual memory is the whole feature.

### The memory agent

`src/server/agent/MemoryAgent.ts`:

```ts
import { Agent } from "@mastra/core";
import { Memory } from "@mastra/memory";
import { LibSQLStore, LibSQLVector } from "@mastra/libsql";

export function createMemoryAgent() {
  const memory = new Memory({
    storage: new LibSQLStore({ url: "file:./data/memories.db" }),
    vector: new LibSQLVector({ url: "file:./data/memories.db" }),
    embedder: google.embedding("text-embedding-004"),
    options: {
      semanticRecall: { topK: 5, messageRange: 0 },
      workingMemory: { enabled: false }, // off for v1 — keep scope tight
    },
  });

  return new Agent({
    id: "project-v-memory",
    name: "Visual Memory",
    model: google("gemini-3.5-flash"),
    instructions: buildMemoryAgentPrompt(),
    tools: { rememberMoment, recallMemories },
    memory,
  });
}
```

### Tools

Two tools, both in `src/server/agent/tools/`:

1. **`rememberMoment`** — input: `{ reason?: string }` (the user may say "remember the keys" — that hint is the reason). The tool calls `HlsBurst.capture()` which spawns ffmpeg against the active livestream's `hlsUrl` and pulls ~3 seconds of JPEG frames at ~2fps. It then sends those frames + the last ~10s of transcript to Gemini 3.5 Flash for caption + entity extraction, embeds the caption, inserts into LibSQL. Returns confirmation string for TTS.

2. **`recallMemories`** — input: `{ query: string, timeWindow?: "today" | "all" }`. Does (a) entity lookup against `entities` JSON if the query looks structured ("where is X"), (b) vector search via Mastra's `semanticRecall`, (c) returns top hits as structured text for the agent to synthesize a final answer.

### Why memory primitives + tools (not just one or the other)

- Mastra's `Memory` handles the embedding + vector store plumbing — we don't reinvent it.
- But our memory entries are **structured** (caption, entities, transcript, thumb) — not just chat messages. So we write our own `rememberMoment` tool that *uses* the underlying LibSQL store via Mastra's API. Cleanest split: Mastra owns the index, we own the schema.

---

## 7. Intent routing

In `User.ts` / `AIManager.ts` (the existing transcription handler), after wake-phrase detection, classify the user's utterance before routing:

- Contains `"remember"` (and verb-like position) → memory agent with `rememberMoment` allowed
- Contains recall patterns (`"where"`, `"when"`, `"did i"`, `"have i"`, `"what was"`) → memory agent with `recallMemories` allowed
- Otherwise → existing Gemini Live `ask()` path

Classification: simple regex first pass. If ambiguous, single Gemini 3.5 Flash call with `thinking: "low"` returning `"remember" | "recall" | "live"`. Cheap, ~200ms.

This is the **only** new branch we add to the existing flow. Everything else flows through the same code paths.

---

## 8. HLS burst (frame extraction from the active livestream)

`src/server/managers/HlsBurst.ts` (new):

- **On demand only.** Nothing runs in the background.
- `capture(durationMs = 3000)` → spawns ffmpeg against the current session's `hlsUrl`, runs for `durationMs`, pipes JPEG frames out via `image2pipe`. Returns `{ frames: Buffer[], startedAt, endedAt }`.
- One in-flight burst per User session — if a second `capture()` lands while one is running, return the existing promise.
- Reuses the ffmpeg binary already present in the container (AudioManager already spawns it for MP3 encoding — see `AudioManager.ts:104-126` for the spawn pattern to mirror).
- If `hlsUrl` is not available (livestream not active), returns an empty result and the tool falls back to an error message: *"I can only remember when the livestream is on."*

ffmpeg command shape:

```
ffmpeg -hide_banner -loglevel error \
  -i <hlsUrl> \
  -t 3 \
  -vf fps=2,scale=512:-2 \
  -f image2pipe -vcodec mjpeg pipe:1
```

This yields ~6 JPEG frames at 512px wide. Small, plenty for captioning, fast to upload to Gemini.

### Why HLS via ffmpeg (and why NOT the alternatives)

| Option                                | Verdict | Reason                                                                                              |
| ------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `session.camera.requestPhoto()` loop  | ❌      | Does NOT work while livestream is active. Glasses can stream OR shoot stills, not both.             |
| `hlsUrl` + ffmpeg (chosen)            | ✅      | ffmpeg already in container; pattern matches existing AudioManager spawn; HLS is documented + stable. |
| Decoding WHEP/WebRTC server-side      | ❌      | 2+ hour rabbit hole — needs a real WebRTC client + decoder in Bun. Hackathon-fatal.                 |
| `thumbnailUrl` (Cloudflare auto-thumb)| ❌      | One frame, unknown refresh rate, could be 30s stale. Demo killer.                                   |
| Frontend canvas grab (Plan B)         | ⚠️      | Already proven in `ai.ts:63-88` for the live AI vision path. Backup if HLS+ffmpeg has issues. Requires webview open. |

### Known caveat: HLS delay

HLS segments are typically 4-10s behind live. So the frames we capture for a "remember" are *the recent past*, not the instant of the command. For our demo cases (static subjects: keys on counter, pill bottle, sign) this is fine because the user dwells on the subject for several seconds before saying "remember this".

Demo coaching: **look at the thing for ~3 seconds, then say "Hey Gemini, remember this".** The frames we pull will be exactly what they were looking at.

Things to validate in the first 15 minutes of hacking:
- What is the actual HLS delay on Mentra's Cloudflare setup? Eyeball it: hold a stopwatch in front of the glasses, capture, compare frame time to wall time. If <3s we're golden. If >8s we coach harder.
- Does ffmpeg open the HLS URL cleanly from inside the Bun container? Test with one literal ffmpeg invocation before wiring anything.

---

## 9. Audio confirmation UX

When `rememberMoment` succeeds:
- Short "remembered" earcon (reuse the existing wake-phrase bing or play a distinct one)
- Then a one-line spoken confirmation: *"Remembered. Kitchen counter, set of keys."* — generated by Gemini 3.5 Flash from the caption.

When `recallMemories` succeeds:
- Direct spoken answer through the existing TTS / streamPcm path.

When either fails:
- Spoken: *"I couldn't remember that — try again."*

These all reuse the existing audio output pipeline. No new code in `AudioManager`.

---

## 10. Scope cuts (what we will NOT do today)

- ❌ Background auto-memory / passive sub-agent — explicit remember only
- ❌ Working memory / persona memory in Mastra (`workingMemory: false`)
- ❌ Per-user accounts beyond what MentraOS already gives us (single user_id from session)
- ❌ Memory editing / deletion UI
- ❌ Image embeddings (vision encoder) — caption embeddings only
- ❌ Episode summaries / rollups
- ❌ Cross-session frame buffer persistence

If we are ahead of schedule by 3 PM, the first stretch is **image embeddings** (Gemini multimodal embedding for the thumbnail) — enables "find the time I looked at something blue and round."

---

## 11. Task breakdown with time cutoffs

Hackathon clock: hacking starts 10:30 AM, submissions 5 PM. ~6.5 hours.

| Time     | Task                                                                                     | If behind, drop                          |
| -------- | ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| 10:30 AM | `bun add` Mastra deps; create `data/memories.db` schema; stub `MemoryAgent.ts`           | —                                        |
| 11:00 AM | `HlsBurst.ts` — spawn ffmpeg against `hlsUrl`, capture 3s of frames; verify it works inside container | If HLS unreachable: fall back to frontend canvas grab (`ai.ts:63-88` pattern) |
| 11:45 AM | `rememberMoment` tool: caption + entity extraction via Gemini 3.5 Flash; insert row      | Skip entity extraction, caption only     |
| 12:30 PM | LUNCH (eat fast, demo while eating)                                                      | —                                        |
| 1:00 PM  | `recallMemories` tool: semantic search via Mastra + entity lookup; agent synthesis       | Skip entity lookup; pure vector search   |
| 2:00 PM  | Intent router in `User.ts`; route "remember"/"where"/"did I" to memory agent             | —                                        |
| 2:45 PM  | Audio confirmations: remembered-earcon, success/failure spoken lines                     | Skip earcon, spoken confirmation only    |
| 3:15 PM  | **End-to-end test on actual glasses** — remember 3 things, recall all 3                  | This is the hard cutoff. Must work here. |
| 3:45 PM  | Polish demo script; rehearse the 90s pitch with the actual hardware                      | —                                        |
| 4:15 PM  | If green: image embeddings stretch goal. If red: cut features until green.               | —                                        |
| 4:30 PM  | Record demo video (60s submission requirement)                                           | NON-NEGOTIABLE                           |
| 4:45 PM  | Submit                                                                                   | NON-NEGOTIABLE                           |

### Hard cuts if behind at 3:15 PM

In order:
1. Drop entity extraction — caption + embedding only
2. Drop earcon + spoken confirmation polish — return text only, no TTS for confirms
3. Drop intent classifier — hardcode `remember` keyword detection only
4. Drop "did I X today?" temporal queries — only support "where is X"

The demo MUST work at 3:15 PM in some form. If by 3:15 we cannot remember+recall a single object on the actual glasses, we cut ALL stretch and ship the smallest possible loop.

---

## 12. Risks

| Risk                                                          | Likelihood | Mitigation                                                                                       |
| ------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `@mastra/memory` API surface differs from docs / breaking     | Med        | Read source under `node_modules/@mastra/memory` first thing. If broken, fall back to direct LibSQL queries — keep `rememberMoment`/`recallMemories` tool interface stable. |
| LibSQL vector ext not bundled in Bun                          | Low        | Verify in first 15 minutes. Fallback: cosine similarity in-process over rows.                    |
| HLS URL not reachable from inside Bun container               | Med        | Validate at 11 AM with a single literal ffmpeg invocation. Plan B: instrument the frontend webview to capture canvas frames + POST to server (the path at `ai.ts:63-88` already does this for the live AI flow). |
| HLS delay too high (>8s) for credible demo                    | Med        | Coach the demo: look at subject for 3s before saying "remember this". If still unworkable, drop to single-frame memory using `thumbnailUrl`. |
| ffmpeg spawn pattern differs from AudioManager's              | Low        | Mirror `AudioManager.ts:104-126` spawn shape; use `Bun.spawn` with pipe stdio. Same binary, same container. |
| Gemini 3.5 Flash captioning too slow (>2s)                    | Med        | Use `thinking: "low"`. Caption async — return "remembered" immediately, finalize in background.  |
| User asks "where are my keys?" before async captioning finishes | Med      | The "remembered" confirmation only fires AFTER caption + insert complete. No async background work for v1 — keep the loop synchronous even if it's 2-3s. Honest UX over fancy. |
| Intent router misclassifies "remember when…" recall as remember | Med      | Patterns are ordered: recall patterns checked first.                                             |
| Two pipelines (Live + Memory) race on audio output            | High       | Live `ask()` and memory agent share `AudioManager.streamPcm`. Add a simple lock: memory agent waits for any active Live response to finish before speaking. |

---

## 13. Open questions to resolve before coding

- [ ] Confirm `@mastra/memory` + `@mastra/libsql` install cleanly on Bun (test in first 5 minutes)
- [ ] Confirm `text-embedding-004` is reachable via `@ai-sdk/google` with our existing creds
- [ ] Confirm `gemini-3.5-flash` is available on our Google account (hackathon temp accounts provision day-of — may need to verify at 9 AM)
- [ ] Validate ffmpeg can open `hlsUrl` from inside the Bun container. One literal command, no integration. Pass/fail in 5 minutes.
- [ ] Measure HLS delay on the Mentra/Cloudflare path. Stopwatch test. Sets the demo coaching script.
- [ ] Confirm the `hlsUrl` returned by `startManagedStream()` is fetchable without auth headers (most Cloudflare HLS is, but verify).
- [ ] Decide thumbnail jpeg quality + size (target <50 KB per memory)
- [ ] Decide wake-phrase variant for memory commands: is `"Hey Gemini, remember this"` reliably detected by the existing MasterAgent wake phrases, or do we need to add `"remember"` as an additional trigger?

---

## 14. What goes in the README update

After we ship, update `README.md` to reflect:
- Project-V is a **vision assistant for visually impaired users on Mentra Live**
- Open-source, built on the open-source MentraOS SDK
- Features: live scene Q&A (Gemini Live) + visual memory (Mastra + Gemini 3.5 Flash Managed Agents)
- Hackathon attribution + link to demo video

README rewrite is a 4:30 PM task, not now.
