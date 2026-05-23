# 02 — Proactive Mode (formerly "passive")

**Status:** Planning → implementing
**Builds on:** 01-visual-memory-managed-agents.md
**Goal:** Make the AI a self-aware ambient guide that proactively narrates
meaningful changes in the wearer's view, without being asked.

---

## 1. The pitch

Today the AI is silent until the wearer says "Hey Gemini". In **proactive
mode**, the AI watches the scene and speaks up on its own when something
worth knowing happens — a person approaches, a hand goes up in a crowd, a
new sign appears, the wearer enters a new space.

Two modes, honest names:
- **proactive** — AI watches, narrates meaningful changes, silent otherwise.
- **active** — AI is silent until asked. (Today's wake-word-only behavior.)

The pre-existing `outdoor` and `auto` stay as-is — they're already
narration modes biased differently in their system prompts.

---

## 2. Why "proactive" instead of "passive"

"Passive" was confusing because the AI is doing the most work in that mode
— it's actively watching frames and deciding when to speak. "Proactive"
matches what's happening: the AI initiates conversation instead of waiting
to be asked.

This is a rename of an existing mode, not a new mode. Behavior was already
narration-on-changes in [modes.ts:60-73](../src/server/agent/modes.ts).
The system prompt stays. Just the identifier changes.

---

## 3. Architecture — the simple version

The user already had this insight: **let the AI decide when to speak.**
Gemini Live is a bidirectional streaming session designed exactly for this
— you feed it tokens/audio/images, it streams back audio/text whenever it
wants. We don't need a polling loop. We just feed it frames continuously
and trust the system prompt to gate when it talks.

```
        glasses camera
              │
              ▼
   WHEP video → webview <video>
              │
   ┌──────────┴───────────┐
   │ AIPanel frame loop   │ ── samples ~1 fps ── canvas → JPEG
   │ (already exists)     │
   └──────────────────────┘
              │
              ▼
       POST /api/ai/frame
              │
              ▼
   AIManager.sendFrame()
              │
        ┌─────┴─────┐
        │ proactive │── stream into Gemini Live continuously
        │   mode?   │   (model decides when to narrate)
        │           │
        │ other     │── stash latestFrame only, attach at ask()-time
        │ modes     │   (today's behavior)
        └───────────┘
```

The only structural change: in proactive mode, every incoming frame is
pushed into the live Gemini session immediately (via
`session.sendClientContent` with the frame as a `user`-role turn that does
NOT mark `turnComplete`). The model treats the stream as ambient input.
When its system prompt's silence rules fire, it emits no response. When
something noteworthy happens, it speaks.

In active/outdoor/auto modes, behavior is unchanged: frames are stashed
but not streamed, attached only at ask()-time.

---

## 4. The hard parts and how we handle them

| Risk | Mitigation |
|---|---|
| AI narrates constantly (chatter) | System prompt is strict: "stay silent unless something materially changes." Already in place at [modes.ts:60-73](../src/server/agent/modes.ts). |
| AI repeats itself | Live session has conversation memory — it remembers what it already said. Plus the rules in the prompt forbid repetition. |
| AI talks while wearer is speaking | Already gated. Wearer utterances enter the same Gemini Live session via `ask()`; the model handles turn-taking. |
| AI talks while wearer is mid-question | The existing wake-word path routes utterances through `ask()` which sends `turnComplete: true`. Model treats that as a turn boundary. |
| Self-speech feedback (AI hears its own voice in mic) | Already handled in [MasterAgent.isLikelySelfSpeech()](../src/server/agent/MasterAgent.ts) — drops transcriptions within 4s of last AI audio chunk. |
| Cost | One Gemini Live session per user — already running. Adding ~1 fps frame stream increases tokens but not session count. |
| Mode switching mid-flight | `AIManager.setMode()` reconnects the Gemini Live session with the new system prompt. Continuous frame streaming naturally restarts on the new session. |

---

## 5. Implementation plan

### Step 1: Rename `passive` → `proactive` everywhere
Files affected:
- [modes.ts](../src/server/agent/modes.ts) — `Mode` union, `MODES` array, `MODE_LABEL`, `MODE_PROMPTS` keys, `DEFAULT_MODE`, system prompt header
- [tools.ts](../src/server/agent/tools.ts) — `set_mode` tool description mentions the modes
- Any frontend references to mode labels (`MODE_LABEL` is the source of truth, so a single change propagates)
- Default mode stays the same — wearer launches into proactive narration if streaming is on

### Step 2: Continuous frame streaming in AIManager
- Add `streamFrame(jpegBase64)` private method that sends a frame as a `user`-role turn with `turnComplete: false` — non-terminal input the model can attend to.
- In `sendFrame()`, branch on current mode:
  - `proactive` → call `streamFrame()` immediately (in addition to stashing as `latestFrame`).
  - other modes → today's behavior (stash only).
- Throttle: cap effective rate at ~1 fps server-side so the webview's existing periodic frame loop (currently 1s in [AIPanel](../src/frontend/pages/home/components/AIPanel.tsx#L157)) doesn't accidentally hit Gemini's limits. The 1s cadence is already in place — no change to the frontend needed.

### Step 3: Reset frame loop on mode change
- When `setMode()` reconnects the Gemini Live session, the frame-streaming side just continues — next `sendFrame()` arrival on the new session honors the new mode's behavior. No special handling needed.

### Step 4: Verify safety gates
- Wake-word `ask()` still works in proactive mode (model handles interleaving turn-completing user input with continuous frame stream).
- `isLikelySelfSpeech()` still gates self-feedback.
- Audio output pipeline already accepts continuous narration without per-turn open/close.

### Step 5: Demo coaching
The demo line: *"Look — when something happens it just tells me."* Then walk somewhere or have someone walk up to you. AI should narrate. Then stand still — silence.

---

## 6. Scope cuts

- ❌ Adaptive cadence (perceptual hash, motion detection) — the AI itself paces.
- ❌ Per-event throttle bookkeeping in the server — the model's prompt handles repetition.
- ❌ "Hazard priority" enforcement — `outdoor` mode is already the hazard-biased prompt; proactive is general-purpose.
- ❌ Webview toggle button — voice command via `set_mode` tool is already wired.

---

## 7. Open questions

- [ ] Does Gemini Live's `sendClientContent` accept `turnComplete: false` for a frame-only turn? Need to verify; docs suggest yes (you can stream input).
- [ ] Will the model's auto-narration cadence feel natural? If too chatty, tighten the system prompt. If too quiet, add a once-per-30s "you may comment on the scene now" timer nudge (cheap fallback).

---

## 8. Demo arc (60 seconds)

1. Glasses on, livestream up.
2. Webview shows mode = **proactive**.
3. Walk past a colleague. AI: *"Someone in a blue shirt just walked past on your left."*
4. Stop, look at a sign. AI: *"You're outside Room 200, the registration desk."*
5. Look at a static wall for 10s. **Silence.** This is the punchline — the AI isn't chatter, it's a guide.
6. Say *"Hey Gemini, switch to active."* AI: *"Switched to active mode."* and goes quiet permanently until next wake-word.
