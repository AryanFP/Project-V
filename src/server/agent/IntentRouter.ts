/**
 * IntentRouter — classify a post-wake-phrase utterance into one of three
 * routes:
 *
 *   "remember" — store a moment (HlsBurst → MemoryAgent.remember)
 *   "recall"   — retrieve a moment (MemoryAgent.recall)
 *   "live"     — fall through to existing Gemini Live ask() flow
 *
 * Why a separate router:
 *   The "remember this" and "where are my keys?" intents need different
 *   plumbing than live Q&A — they hit the memory pipeline, not Gemini Live.
 *   Doing the classification in MasterAgent.handleUtterance() keeps the
 *   existing flow untouched on the "live" path.
 *
 * Why regex (and not a model call):
 *   Latency. Wake-phrase → spoken response should feel snappy. A model
 *   classifier adds 200-400ms for an intent that's well-served by simple
 *   pattern matching for the demo cases. If a real-world utterance fools
 *   the regex, the worst case is the wrong route — and "live" is always
 *   a graceful fallback because it just goes to Gemini Live.
 *
 * Ordering matters:
 *   Recall is checked BEFORE remember. "Remember when I…" is a recall
 *   query, not a store command. The recall regex looks for question
 *   intent first, so it wins ties.
 */

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

/**
 * Recall patterns. Question forms first, "did I…" / "have I…" follow.
 * Order doesn't matter inside the array; any match wins.
 */
const RECALL_PATTERNS: RegExp[] = [
  /\bwhere (?:is|are|did|was|were)\b/i,
  /\bwhen did i\b/i,
  /\bdid i\b/i,
  /\bhave i\b/i,
  /\bwhat (?:was|did i see|was i)\b/i,
  /\bwhich .*(?:was|did i)\b/i,
  /\bremember when\b/i, // "Remember when I…" is a recall, not a store
  /\bdo you remember\b/i,
  /\bhow long (?:ago|since)\b/i,
];

/**
 * Remember patterns. Imperative + a "remember"-ish verb, possibly with
 * an object hint ("remember the keys", "remember I took my pills").
 *
 * The "do you remember" / "remember when" forms are recall — they're
 * matched first by RECALL_PATTERNS above and won't reach here.
 */
const REMEMBER_PATTERNS: RegExp[] = [
  /^\s*remember\b/i,
  /^\s*(?:please\s+)?(?:save|store|note|log) (?:this|that)\b/i,
  /^\s*take note\b/i,
];

export function routeIntent(utterance: string): RoutedIntent {
  const trimmed = utterance.trim();
  if (!trimmed) return { intent: "live", payload: "" };

  // Recall first — "remember when…" is a recall, not a store.
  for (const re of RECALL_PATTERNS) {
    if (re.test(trimmed)) {
      return { intent: "recall", payload: trimmed };
    }
  }

  for (const re of REMEMBER_PATTERNS) {
    if (re.test(trimmed)) {
      return {
        intent: "remember",
        payload: extractRememberReason(trimmed),
      };
    }
  }

  return { intent: "live", payload: trimmed };
}

/**
 * Pull the "what to remember" hint out of an imperative utterance.
 *
 *   "remember this"           → ""
 *   "remember the keys"       → "the keys"
 *   "remember I took aspirin" → "I took aspirin"
 *
 * Empty string is fine — MemoryAgent uses the visual content as the
 * primary signal; the reason is just a hint.
 */
function extractRememberReason(utterance: string): string {
  const stripped = utterance
    .replace(/^\s*(?:please\s+)?(?:remember|save|store|note|log|take note)\b/i, "")
    .replace(/^\s*(?:this|that)\b/i, "")
    .replace(/^[,.\s:-]+/, "")
    .trim();
  return stripped;
}
