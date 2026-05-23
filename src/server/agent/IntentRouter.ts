/**
 * IntentRouter — classify a post-wake-phrase utterance into one of three
 * routes:
 *
 *   "remember" — store a moment (WebviewBurst → MemoryAgent.remember)
 *   "recall"   — retrieve a moment (MemoryAgent.recall)
 *   "live"     — fall through to existing Gemini Live ask() flow
 *
 * Why this exists (separate from MasterAgent.handleUtterance):
 *   The "remember this" and "where are my keys?" intents need different
 *   plumbing than live Q&A — they hit the memory pipeline, not Gemini Live.
 *   Doing the classification here keeps the existing flow untouched on the
 *   "live" path.
 *
 * Classifier design:
 *   Regex routing was too fragile — real wearers said "do you know where I
 *   put the walkie-talkie?" and the regex missed it. Now we use a Gemini
 *   3.5 Flash classifier with structured JSON output (thinkingBudget: 0
 *   for speed).
 *
 *   We still keep a fast-path regex for unambiguous cases ("remember this",
 *   "where are my keys") so the common cases don't pay the ~200ms model
 *   round-trip. Ambiguous utterances fall through to the classifier.
 */

import { GoogleGenAI } from "@google/genai";

export type Intent = "remember" | "recall" | "live";

export interface RoutedIntent {
  intent: Intent;
  /**
   * For "remember": optional hint Gemini will use as `reason`
   *   ("the keys" from "remember the keys").
   * For "recall": the cleaned query
   *   ("where are my keys" from "Hey Gemini, where are my keys?").
   * For "live": the original question unchanged.
   */
  payload: string;
}

const CLASSIFIER_MODEL =
  process.env.GEMINI_INTENT_MODEL || "gemini-3.5-flash";

// Reused across calls so we don't re-construct the client per utterance.
let genai: GoogleGenAI | null = null;
function ensureGenai(): GoogleGenAI {
  if (genai) return genai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  genai = new GoogleGenAI({ apiKey });
  return genai;
}

/**
 * Fast-path regex matches for unambiguous utterances. Returns null if the
 * utterance isn't clearly one intent — then we fall through to the model.
 *
 * Bias: only fire on patterns where misclassification is impossible.
 *   - "remember this/that/it" — clearly a store command
 *   - "do you remember … X" — clearly a recall (NOT a store)
 *   - "where are/is/did" — clearly a recall
 *
 * Everything else (e.g. "could you remember the walkie-talkie") goes to
 * the model so the human-intent decision isn't left to a regex.
 */
function fastPath(utterance: string): RoutedIntent | null {
  const t = utterance.trim();

  // Recall first — "remember when" / "do you remember" must NOT be stores.
  if (/\b(?:do you remember|remember when)\b/i.test(t)) {
    return { intent: "recall", payload: t };
  }
  if (/\bwhere (?:is|are|did|was|were)\b/i.test(t)) {
    return { intent: "recall", payload: t };
  }
  if (/\bwhen did i\b/i.test(t)) {
    return { intent: "recall", payload: t };
  }

  // Imperative store: "remember this/that/it" with no question marker.
  if (/\bremember\s+(?:this|that|it)\b/i.test(t) && !/\?/.test(t)) {
    return { intent: "remember", payload: extractRememberReason(t) };
  }

  return null;
}

/**
 * Classify an utterance with Gemini 3.5 Flash.
 *
 * Returns `{ intent, payload }`. On any error (no API key, network, parse
 * failure) defaults to `live` — that's the graceful fallback because Gemini
 * Live will then answer normally from the current frame.
 */
export async function routeIntent(utterance: string): Promise<RoutedIntent> {
  const trimmed = utterance.trim();
  if (!trimmed) return { intent: "live", payload: "" };

  const fast = fastPath(trimmed);
  if (fast) return fast;

  try {
    const ai = ensureGenai();
    const response = await ai.models.generateContent({
      model: CLASSIFIER_MODEL,
      contents: [
        {
          role: "user",
          parts: [{ text: buildClassifierPrompt(trimmed) }],
        },
      ],
      config: {
        responseMimeType: "application/json",
        // Minimum thinking — this is a routing call, not reasoning work.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const text = response.text ?? "";
    const parsed = safeParseJson(text);
    const rawIntent = (parsed?.intent ?? "").toString().toLowerCase();
    const intent: Intent =
      rawIntent === "remember" || rawIntent === "recall" || rawIntent === "live"
        ? (rawIntent as Intent)
        : "live";

    if (intent === "remember") {
      const hint =
        typeof parsed?.subject === "string" && parsed.subject.trim().length > 0
          ? parsed.subject.trim()
          : extractRememberReason(trimmed);
      return { intent, payload: hint };
    }
    if (intent === "recall") {
      const query =
        typeof parsed?.query === "string" && parsed.query.trim().length > 0
          ? parsed.query.trim()
          : trimmed;
      return { intent, payload: query };
    }
    return { intent: "live", payload: trimmed };
  } catch (error) {
    console.warn(
      `🧠⚠️  Intent classifier failed, defaulting to live: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { intent: "live", payload: trimmed };
  }
}

function buildClassifierPrompt(utterance: string): string {
  return [
    "You are the intent router for a vision-assistant on smart glasses worn",
    "by a blind / low-vision user. Classify the wearer's utterance into one",
    "of three intents:",
    "",
    "  - \"remember\": the wearer wants to STORE what they're currently",
    "    looking at into long-term visual memory. Examples:",
    "      \"remember this\"",
    "      \"could you remember the walkie-talkie\"",
    "      \"save this for me\"",
    "      \"note that I took my pills\"",
    "",
    "  - \"recall\": the wearer wants to RETRIEVE a previously stored memory.",
    "    Examples:",
    "      \"where are my keys\"",
    "      \"do you know where I put the walkie-talkie\"",
    "      \"have you seen my wallet\"",
    "      \"when did I last see the bottle\"",
    "      \"did I take my pills today\"",
    "",
    "  - \"live\": anything else — current-scene Q&A, general questions,",
    "    chit-chat, mode commands, system questions. Examples:",
    "      \"what time is it\"",
    "      \"describe what I'm looking at\"",
    "      \"set mode to outdoor\"",
    "      \"who won the world cup\"",
    "",
    "Critical disambiguations:",
    "  - \"do you remember X\" / \"remember when …\" = recall, NOT remember.",
    "  - \"remember to do X\" = live (it's a future-tense reminder, not a",
    "    visual memory). For now we don't store those.",
    "  - If the wearer asks a question about a previously-stored object",
    "    (\"where is the …\", \"have you seen …\") it's a recall even if",
    "    they don't use the word \"remember\".",
    "",
    "Return JSON ONLY in this exact shape:",
    "  { \"intent\": \"remember\" | \"recall\" | \"live\",",
    "    \"subject\": string?,   // for \"remember\": short noun phrase of WHAT to remember (\"the walkie-talkie\"), or \"\" if not specified",
    "    \"query\": string?      // for \"recall\": the cleaned natural-language question to search memory with",
    "  }",
    "",
    `Wearer utterance: "${utterance.replace(/"/g, '\\"')}"`,
  ].join("\n");
}

/**
 * Pull the "what to remember" hint out of an imperative utterance.
 *
 * Used by the fast-path AND as the fallback when the model didn't return
 * a `subject` field.
 *
 *   "remember this"                       → ""
 *   "remember the keys"                   → "the keys"
 *   "remember I took aspirin"             → "I took aspirin"
 *   "could you remember this please"      → ""
 *   "please remember the medicine bottle" → "the medicine bottle"
 */
export function extractRememberReason(utterance: string): string {
  const verb = utterance.match(
    /\b(?:remember|memorize|save|store|note|log|jot)\b/i,
  );
  const tail = verb
    ? utterance.slice((verb.index ?? 0) + verb[0].length)
    : utterance;
  return tail
    .replace(/^\s*(?:this|that|it|down)\b/gi, "")
    .replace(/\b(?:please|thanks?(?:\s+you)?)\b/gi, "")
    .replace(/[,.\s:!?-]+$/, "")
    .replace(/^[,.\s:!?-]+/, "")
    .trim();
}

function safeParseJson(text: string): any {
  if (!text) return null;
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}
