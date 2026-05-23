airity

**A vision assistant for blind and low-vision wearers, running on Mentra Live smart glasses.**

Built at the [Google I/O Hackathon](https://cerebralvalley.ai/e/google-io-hackathon/) — Shack15, San Francisco — on **May 23, 2026**, against the prompt:

> *Build something that's never been built before with Gemini 3.5 Flash.*

---

## What it does

Clairity is the wearer's eyes. The glasses see what they see, and a small team of Gemini models work together to:

1. **Narrate the world proactively** — when something meaningful changes in front of the wearer (a person approaches, a hazard appears, they enter a new room), Clairity speaks up on its own. When nothing has changed, it stays silent.
2. **Answer questions on demand** — *"Hey Gemini, what am I looking at?"* / *"Hey Gemini, what time is it?"* triggers a wake-word Q&A turn with the live camera frame attached.
3. **Remember moments** — *"Hey Gemini, remember this"* captures the current scene plus the surrounding speech, captions it with Gemini 3.5 Flash, extracts structured entities, and embeds the result into a long-term visual memory.
4. **Recall on natural-language query** — *"Hey Gemini, where did I put my walkie-talkie?"* runs semantic vector search across stored memories and answers with the time and place.

All four behaviors share one user-facing surface: the glasses speaker. The wearer never sees a screen.

---

## The Gemini 3.5 Flash story

Clairity uses **three distinct Gemini surfaces, each chosen for what it's actually good at**:

| Surface | Model | Why this one |
| --- | --- | --- |
| **Realtime voice loop** | `gemini-3.1-flash-live-preview` (Gemini Live API) | Audio-native, bidirectional, sub-second turn latency. Owns wake-word Q&A. |
| **Proactive watcher + memory captioner + recall synthesizer** | `gemini-3.5-flash` | Frontier-quality vision + structured JSON output + tool-friendly. Three independent agent loops all hit this model with `thinkingBudget: 0` for snappy decisions. |
| **Memory embeddings** | `gemini-embedding-001` (768-dim via MRL truncation) | Semantic vector store for recall. Lives in LibSQL with a native vector index. |

The **proactive watcher** is the headline use of Gemini 3.5 Flash. Every 3 seconds it asks Flash a single multimodal question — *"Anything worth telling the wearer about, right now?"* — and lets the model decide whether to break silence. The judge prompt is strict about not narrating unchanged scenes; the model holds itself to it. This is sub-agent deployment in the spirit of the Managed Agents pitch: a small, fast, repeatedly-invoked specialist that owns one decision.

The **memory pipeline** chains Flash calls into a multi-step workflow:

1. *Caption + entity extract* — burst of 3 frames in → JSON `{caption, entities[]}` out.
2. *Embed* — caption → 768-dim vector.
3. *Recall synthesize* — query + top-K nearest memories → one-sentence spoken answer.

Each step is a separate Flash call with structured output. The whole thing runs in under 3 seconds end-to-end on a real glasses session.

The **intent router** is a fourth Flash use: a fast classifier that decides whether a wake-word utterance is a remember command, a recall query, or a live Q&A. Hand-rolled regex couldn't keep up with real wearer phrasings (*"could you remember the walkie-talkie for me, please?"*), so Flash with `thinkingBudget: 0` runs the routing in ~150ms.

---

## Stack

### Hardware

- **Mentra Live** — open-source smart glasses with onboard camera + mic + bone-conduction speaker.

### Frontend (companion webview)

- **React 19** + **Tailwind v4** + **Bun** as the bundler
- **WHEP** (WebRTC-HTTP Egress Protocol) playback of the live camera feed, served by Cloudflare Stream via the MentraOS managed-stream pipeline
- **Server-Sent Events** for the conversation log, transcription feed, livestream status, and proactive-capture requests
- Google Sans + Roboto + Roboto Mono via Google Fonts
- Logo + branding designed to look at home in the Google design language

### Backend (Bun)

- **Bun** runtime + **Hono** HTTP framework
- **MentraOS SDK** (`@mentra/sdk`) — owns the glasses session lifecycle, camera, mic, audio output, livestream control
- **`@google/genai`** SDK for all Gemini calls (Live, 3.5 Flash, embeddings)
- **Mastra** (`@mastra/core`, `@mastra/memory`, `@mastra/libsql`) — Agent + Memory framework, ready to wire as the orchestration layer for the recall path
- **LibSQL** (`@libsql/client`) — embedded SQLite with native `F32_BLOB` + `vector_top_k` for the memory store. Single `data/memories.db` file. No external database.
- **ffmpeg** — `Bun.spawn`'d for two pipelines:
  - PCM16 → MP3 streaming into the glasses speaker (low-latency mode flags)
  - HLS frame extraction (kept as a dormant fallback path; not active in v1)

### Audio pipeline

```
Gemini Live PCM16 ─▶ ffmpeg (lame-mp3, low-latency) ─▶ SDK MP3 stream ─▶ glasses speaker
                                                                ▲
proactive narration / memory confirmation ── session.audio.speak() ─┘  (SDK TTS, same speaker)
```

A single continuous output stream runs for the whole session — no per-turn open/close, no audio focus race between the realtime PCM path and the SDK TTS path used by proactive + memory.

### Memory storage

```sql
CREATE TABLE memories (
  id, user_id, session_id, created_at,
  caption,             -- "keys on kitchen counter next to blue mug"
  entities,            -- JSON: [{type, name, location?, notes?}]
  transcript,          -- last ~10s of speech around the moment
  frame_count,
  thumb_b64,           -- small JPEG for the gallery
  embedding F32_BLOB(768)
);

CREATE INDEX memories_vec ON memories(libsql_vector_idx(embedding));
```

Vector search via LibSQL's native KNN; in-process cosine similarity fallback if the native index isn't available.

---

## Architecture diagram

```
                    ┌──────────────────────────────────────────┐
                    │           Mentra Live Glasses            │
                    │  camera + mic + speaker                  │
                    └──────────┬───────────────────┬───────────┘
                               │ WebRTC ingest     │ ASR text + audio out
                               ▼                   ▼
                    ┌──────────────────────────────────────────┐
                    │         Bun + Hono + Mentra SDK          │
                    │                                          │
                    │  ┌──────────────┐    ┌───────────────┐   │
                    │  │ LiveStream   │    │ Transcription │   │
                    │  │  Manager     │    │   Manager     │   │
                    │  └──────┬───────┘    └───────┬───────┘   │
                    │         │                    │           │
                    │         ▼                    ▼           │
                    │    Cloudflare      ┌──────────────────┐  │
                    │     WHEP feed      │  MasterAgent     │  │
                    │         │          │  (wake-word +    │  │
                    │         │          │   intent router) │  │
                    │         │          └────┬─────┬───────┘  │
                    │         │               │     │          │
                    │         │     ┌─────────┘     │          │
                    │         │     ▼               ▼          │
                    │         │  ┌────────────┐  ┌──────────┐  │
                    │         │  │  AIManager │  │ Memory   │  │
                    │         │  │  (Gemini   │  │ Agent    │  │
                    │         │  │   Live)    │  │ (Flash + │  │
                    │         │  └────────────┘  │ LibSQL)  │  │
                    │         │                  └──────────┘  │
                    │         ▼                                │
                    │   ┌────────────┐     ┌─────────────────┐ │
                    │   │ Proactive  │     │ Webview Burst   │ │
                    │   │ Watcher    │     │ (frame capture  │ │
                    │   │ (3s Flash  │     │  from <video>)  │ │
                    │   │  ticks)    │     └─────────────────┘ │
                    │   └────────────┘                         │
                    └──────────────────────────────────────────┘
                               │                   │
                               ▼                   ▼
                    ┌──────────────────────────────────────────┐
                    │       Companion Webview (React)          │
                    │   - WHEP video player                    │
                    │   - Conversation log (per-source bubbles)│
                    │   - Visual Memory gallery                │
                    │   - Live Transcription card              │
                    └──────────────────────────────────────────┘
```

---

## What's new at this hackathon

Everything in this README beyond "Mentra glasses + Cloudflare streaming." Specifically all built during the May 23, 2026 event:

- **Intent router** with regex fast-path + Gemini 3.5 Flash classifier fallback ([`src/server/agent/IntentRouter.ts`](src/server/agent/IntentRouter.ts))
- **Memory agent** — Gemini 3.5 Flash caption + entity extraction + embeddings + LibSQL store ([`src/server/agent/MemoryAgent.ts`](src/server/agent/MemoryAgent.ts))
- **Proactive watcher** — 3-second polling loop with repetition guard, cooldown, and gating against wearer/AI speech ([`src/server/manager/ProactiveWatcher.ts`](src/server/manager/ProactiveWatcher.ts))
- **Webview frame burst** — server signals the browser via SSE, browser samples the live WHEP `<video>` to canvas, POSTs JPEGs back ([`src/server/manager/WebviewBurst.ts`](src/server/manager/WebviewBurst.ts), [`src/frontend/.../MemoryCaptureBridge.tsx`](src/frontend/pages/home/components/MemoryCaptureBridge.tsx))
- **Memory listing endpoint** for the visual memory gallery ([`src/server/api/memories.ts`](src/server/api/memories.ts))
- **Multi-source AI conversation panel** — live / proactive / memory each rendered with their own badge ([`src/frontend/.../AIPanel.tsx`](src/frontend/pages/home/components/AIPanel.tsx))
- **Reliable stream restart** — mirrored from the sibling Livestreamer app: stop-then-verify with 2s delays, 45s timeout + disconnect race, WHEP retry with 5s backoff ([`src/server/manager/LiveStreamManager.ts`](src/server/manager/LiveStreamManager.ts), [`src/frontend/lib/whepClient.ts`](src/frontend/lib/whepClient.ts))
- **Proactive mode rename** + system prompts (`passive` → `proactive`) so the wearer can toggle between *"narrate the world for me"* and *"silent until I ask"*
- **Google Sans / Roboto UI** designed to fit the Gemini visual language
- **Location + timezone awareness** baked into prompts (Pacific Time, Shack15)

The plan docs that drove the build are in [`issues/`](issues/) — they exist because we wrote them up *before* coding to lock in scope and time-box hard cuts.

---

## Run it

```bash
# Prereqs: Bun + ffmpeg + a Gemini API key + Mentra developer account
bun install
cp .env.example .env   # fill in MENTRAOS_API_KEY + GEMINI_API_KEY
bun run dev
```

Open `http://localhost:3000/` in a browser as the companion view, or open the registered Public URL from the MentraOS app on the phone.

### Required env vars

```
PORT=3000
PACKAGE_NAME=com.yourname.clairity
MENTRAOS_API_KEY=...                    # from console.mentra.glass
GEMINI_API_KEY=...                      # from ai.google.dev
PUBLIC_URL=https://<your-ngrok>.app     # so glasses can fetch sound assets
```

### Optional env vars

```
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
GEMINI_MEMORY_MODEL=gemini-3.5-flash
GEMINI_INTENT_MODEL=gemini-3.5-flash
GEMINI_PROACTIVE_MODEL=gemini-3.5-flash
GEMINI_EMBED_MODEL=gemini-embedding-001
MEMORY_DB_URL=file:./data/memories.db
DEV_DEFAULT_USER_ID=you@mentra.glass    # dev-only localhost escape hatch
```

---

## Hackathon submission notes

- **Public repo** — yes ✅
- **One-minute demo video** — in the submission form
- **All work done at the event** — yes; the starting point was the upstream `MentraOS-Camera-Example-App` (the photo-stream template). Everything in [`src/server/agent/`](src/server/agent/), the proactive watcher, the memory pipeline, the visual memory grid, the intent router, the WHEP retry logic, the Paper-designed UI, and the location-aware prompts is new at this event.
- **Team** — Aryan Farhang (solo)
- **Targeting** — main prize pool **and** the $5K "Best Use of Managed Agents" award. Our argument: three independent Gemini 3.5 Flash sub-agents (proactive watcher, memory captioner, intent router) running alongside a Gemini Live foreground loop is the Managed Agents pattern in practice — long-horizon background work, multi-step pipelines, structured-output specialists, all orchestrated to make a single accessibility experience feel like one assistant.

---

## License

MIT. Built on the open-source MentraOS SDK and the open-source Mentra Live hardware.
