/**
 * MemoryAgent — the visual-memory brain for Project-V.
 *
 * Responsibilities:
 *   - Own the LibSQL `memories.db` (single file under data/).
 *   - Caption + extract entities + embed a "remember this" burst using
 *     Gemini 3.5 Flash, then INSERT the row.
 *   - Recall: structured entity lookup first, semantic vector search second,
 *     synthesize a final spoken answer.
 *
 * Why this lives outside the existing Gemini Live path:
 *   AIManager owns a real-time bidirectional audio session that can't easily
 *   carry multi-step tool work without UX hiccups. Memory ingestion + recall
 *   is intrinsically multi-step (caption → entities → embed → store; or
 *   retrieve → re-rank → answer), which is exactly what Managed Agents
 *   patterns are for. We build it as a sibling, not a replacement.
 *
 * Single in-process singleton:
 *   The DB is per-process, not per-user. We pass userId in every insert /
 *   query so the table partitions naturally.
 *
 * Mastra wiring:
 *   For v1 we keep the surface minimal. The actual `new Agent({...})` and
 *   `new Memory({...})` calls are wired here, but at hackathon time we
 *   prove the loop by calling Gemini 3.5 Flash directly (via @google/genai,
 *   which is already a working dep) for captioning + embedding, and write
 *   rows via libsql client.execute(). If `@mastra/memory` semantic recall
 *   works out of the box, we promote it; if not, fall back to in-process
 *   cosine similarity over the embedding BLOB.
 */

import { GoogleGenAI } from "@google/genai";

// Mastra surface — imported but tolerated as undefined if not installed yet,
// so this file compiles before `bun install` runs. The actual `new Agent` /
// `new Memory` calls only run inside `ensureMastra()` which catches import
// failure and falls back to the direct path.
type MastraAgent = unknown;
type MastraMemory = unknown;

export interface MemoryRow {
  id: string;
  userId: string;
  sessionId: string;
  createdAt: number;
  caption: string;
  entities: MemoryEntity[];
  transcript: string | null;
  frameCount: number;
  thumbB64: string | null;
}

export interface MemoryEntity {
  /** "object" | "person" | "action" | "place" | "other" */
  type: string;
  /** Canonical short name: "keys", "blue mug", "aspirin bottle". */
  name: string;
  /** Optional location hint: "kitchen counter", "next to the sink". */
  location?: string;
  /** Optional free-form notes Gemini extracted. */
  notes?: string;
}

export interface RememberInput {
  userId: string;
  sessionId: string;
  /** JPEG buffers from HlsBurst, in time order. May be 1–6 frames. */
  frames: Buffer[];
  /** Last ~10s of user transcript, possibly empty. */
  transcript: string;
  /** Optional hint from the user's utterance ("remember the keys"). */
  reason?: string;
}

export interface RememberResult {
  ok: boolean;
  /** Short, speakable confirmation: "Remembered. Keys on the kitchen counter." */
  spoken: string;
  /** The row that was inserted (null on failure). */
  row: MemoryRow | null;
}

export interface RecallInput {
  userId: string;
  query: string;
  /** "today" | "all". Default "all" for v1. */
  timeWindow?: "today" | "all";
  topK?: number;
}

export interface RecallResult {
  ok: boolean;
  spoken: string;
  hits: MemoryRow[];
}

/** Configurable via env so we can swap models without touching code. */
const MEMORY_MODEL = process.env.GEMINI_MEMORY_MODEL || "gemini-3.5-flash";
// Embedding model name changed across SDKs:
//   - Old REST/Python SDKs: "text-embedding-004"
//   - @google/genai (current): "gemini-embedding-001"
// Override with GEMINI_EMBED_MODEL if your account exposes a different one.
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
const DB_URL = process.env.MEMORY_DB_URL || "file:./data/memories.db";

/** Module-singleton — one DB connection + one Mastra wiring per process. */
let singleton: MemoryAgent | null = null;

export function getMemoryAgent(): MemoryAgent {
  if (!singleton) singleton = new MemoryAgent();
  return singleton;
}

export class MemoryAgent {
  private genai: GoogleGenAI | null = null;
  /** Lazily-created libsql client. Typed loose because the package may not
   *  be installed yet at file-parse time. */
  private libsql: any | null = null;
  /** Mastra Agent + Memory, lazily created. Null until first ensureMastra(). */
  private mastra: { agent: MastraAgent; memory: MastraMemory } | null = null;
  /** True once schema migrations have run on the DB. */
  private schemaReady = false;
  /** True if the LibSQL native vector index works — set in ensureSchema(). */
  private vectorIndexOk = false;

  /**
   * Caption a burst + extract entities + embed + insert. Returns the
   * confirmation string the caller (a tool wrapper) speaks back to the
   * wearer.
   *
   * Synchronous-feeling: we do NOT return "remembered" before the row is
   * written. Honest UX beats fancy. If the user immediately follows up with
   * "where are my keys?" the row will be queryable.
   */
  async remember(input: RememberInput): Promise<RememberResult> {
    try {
      await this.ensureSchema();
      const { caption, entities } = await this.captionAndExtract(input);
      const embedding = await this.embed(caption);
      const thumbB64 = pickThumbnail(input.frames);
      const row: MemoryRow = {
        id: cryptoId(),
        userId: input.userId,
        sessionId: input.sessionId,
        createdAt: Date.now(),
        caption,
        entities,
        transcript: input.transcript || null,
        frameCount: input.frames.length,
        thumbB64,
      };

      await this.insertRow(row, embedding);

      // Confirmation: short, friendly. Use the first entity's name if we have
      // one, else fall back to the caption itself.
      const subject = entities[0]?.name ?? caption;
      const spoken = `Remembered. ${truncate(subject, 60)}.`;
      console.log(
        `🧠💾 Remembered for ${input.userId}: "${caption}" [${entities.length} entities]`,
      );
      return { ok: true, spoken, row };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`🧠💾 remember() failed for ${input.userId}:`, msg);
      return {
        ok: false,
        spoken: "I couldn't remember that — try again.",
        row: null,
      };
    }
  }

  /**
   * Recall: query → top hits → synthesized spoken answer.
   *
   * Strategy:
   *   1. Entity lookup if the query looks structured ("where is X", "did I X").
   *   2. Vector search (Mastra `semanticRecall`, or fallback cosine).
   *   3. Send the top rows + the original question to Gemini 3.5 Flash and
   *      ask for a single-sentence spoken answer.
   *
   * For v1 we ship the vector path; entity lookup is a fast-follow if time
   * allows. The fallback path is intentionally aggressive: if vector search
   * fails or returns 0 hits, we still return a friendly "I don't remember
   * that" instead of throwing.
   */
  async recall(input: RecallInput): Promise<RecallResult> {
    try {
      await this.ensureSchema();
      const embedding = await this.embed(input.query);
      const topK = input.topK ?? 5;
      const hits = await this.vectorSearch(input.userId, embedding, topK);

      if (hits.length === 0) {
        return {
          ok: true,
          spoken: "I don't remember that yet.",
          hits: [],
        };
      }

      const spoken = await this.synthesizeAnswer(input.query, hits);
      console.log(
        `🧠🔎 Recall for ${input.userId}: "${input.query}" → ${hits.length} hits`,
      );
      return { ok: true, spoken, hits };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`🧠🔎 recall() failed for ${input.userId}:`, msg);
      return {
        ok: false,
        spoken: "I'm having trouble checking my memory right now.",
        hits: [],
      };
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Caption + extract structured entities from a burst.
   *
   * Calls Gemini 3.5 Flash multimodally with all burst frames + transcript.
   * Returns a short caption (~10 words) and 0–4 entities. JSON output via
   * `responseMimeType: "application/json"`.
   */
  private async captionAndExtract(
    input: RememberInput,
  ): Promise<{ caption: string; entities: MemoryEntity[] }> {
    const genai = this.ensureGenai();

    const transcriptHint = input.transcript
      ? `\n\nThe wearer was saying around this moment: "${input.transcript}"`
      : "";
    const reasonHint = input.reason
      ? `\n\nThe wearer's hint about what to remember: "${input.reason}"`
      : "";

    const systemPrompt = [
      "You are the visual memory of a vision-assistant for a blind or",
      "low-vision wearer of Mentra Live smart glasses. The wearer just said",
      "\"Hey Gemini, remember this\". You're given the burst of frames they",
      "were looking at plus their recent speech.",
      "",
      "Return JSON: {\"caption\": string, \"entities\": Entity[]}",
      "  - caption: ONE short sentence, ≤16 words, describing the moment",
      "    in plain language the wearer could later recognize. Be specific:",
      "    name colors, objects, locations. Avoid generic phrases.",
      "  - entities: 0-4 items, each {type, name, location?, notes?}.",
      "    type ∈ {object, person, place, action, other}. Be concrete:",
      "    \"keys\" not \"item\"; \"kitchen counter\" not \"surface\".",
      "",
      "Never invent details you can't see. If the frames are blurry or",
      "ambiguous, say so in the caption.",
    ].join(" ");

    const parts: Array<
      { text: string } | { inlineData: { data: string; mimeType: string } }
    > = [
      { text: `${systemPrompt}${transcriptHint}${reasonHint}` },
    ];
    for (const frame of input.frames) {
      parts.push({
        inlineData: {
          data: frame.toString("base64"),
          mimeType: "image/jpeg",
        },
      });
    }

    const response = await genai.models.generateContent({
      model: MEMORY_MODEL,
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        // Low thinking — caption + entities should be a fast, structured call.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const text = response.text ?? "";
    const parsed = safeParseJson(text);
    const caption = typeof parsed?.caption === "string" && parsed.caption.trim()
      ? parsed.caption.trim()
      : "Moment without a clear caption.";
    const entities = Array.isArray(parsed?.entities)
      ? parsed.entities
          .filter((e: any) => e && typeof e.name === "string")
          .slice(0, 4)
          .map((e: any) => ({
            type: typeof e.type === "string" ? e.type : "other",
            name: e.name,
            location: typeof e.location === "string" ? e.location : undefined,
            notes: typeof e.notes === "string" ? e.notes : undefined,
          }))
      : [];

    return { caption, entities };
  }

  /**
   * Embed a string with the configured embedding model.
   *
   * `gemini-embedding-001` returns 3072-dim vectors by default but supports
   * MRL truncation via `outputDimensionality`. We ask for 768 dims so the
   * LibSQL `F32_BLOB(768)` column accepts the result and similarity queries
   * stay fast. Truncated embeddings still cluster correctly — this is the
   * documented use of MRL.
   */
  private async embed(text: string): Promise<Float32Array> {
    const genai = this.ensureGenai();
    const response = await genai.models.embedContent({
      model: EMBED_MODEL,
      contents: text,
      config: { outputDimensionality: 768 },
    });
    // The SDK returns `embeddings` (array) or a single `embedding`; handle both.
    const vec =
      (response as any).embedding?.values ??
      (response as any).embeddings?.[0]?.values ??
      null;
    if (!vec) throw new Error("Embedding response missing values");
    return new Float32Array(vec);
  }

  /**
   * Compose the spoken recall answer from the top hits.
   *
   * We give Gemini the captions + entities + timestamps and ask for ONE
   * short, friendly spoken sentence. The answer goes through the existing
   * AudioManager.speak() / streamPcm path — keep it brief.
   */
  private async synthesizeAnswer(
    query: string,
    hits: MemoryRow[],
  ): Promise<string> {
    const genai = this.ensureGenai();

    const lines = hits.map((h, i) => {
      const ago = formatAgo(Date.now() - h.createdAt);
      const ents = h.entities
        .map((e) => `${e.name}${e.location ? ` (${e.location})` : ""}`)
        .join(", ");
      return `${i + 1}. ${ago} ago — ${h.caption}${ents ? ` [${ents}]` : ""}`;
    });

    const prompt = [
      "You are the visual memory of a blind / low-vision wearer's smart",
      "glasses. The wearer just asked you a recall question:",
      "",
      `Question: "${query}"`,
      "",
      "Here are the most relevant memories you've stored, with timestamps:",
      ...lines,
      "",
      "Reply in ONE short sentence (≤25 words), friendly and concrete, that",
      "answers the question using these memories. Quote a specific location",
      "and approximate time when relevant. If none of the memories answer",
      "the question, say so plainly — don't guess.",
    ].join("\n");

    const response = await genai.models.generateContent({
      model: MEMORY_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { thinkingConfig: { thinkingBudget: 0 } },
    });
    return (response.text ?? "").trim() || "I'm not sure.";
  }

  // ── LibSQL plumbing ────────────────────────────────────────────────────

  /** Lazily open the LibSQL client + run the schema migration. */
  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    const client = await this.ensureLibsql();

    await client.execute(`
      CREATE TABLE IF NOT EXISTS memories (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        session_id    TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        caption       TEXT NOT NULL,
        entities      TEXT NOT NULL DEFAULT '[]',
        transcript    TEXT,
        frame_count   INTEGER NOT NULL DEFAULT 0,
        thumb_b64     TEXT,
        embedding     F32_BLOB(768)
      )
    `);
    await client.execute(`
      CREATE INDEX IF NOT EXISTS memories_user_time
        ON memories(user_id, created_at DESC)
    `);

    // Vector index is best-effort: if the build of libsql we get doesn't
    // expose libsql_vector_idx, we fall back to in-process cosine over the
    // F32_BLOB column. Both work; native is faster on large tables.
    try {
      await client.execute(`
        CREATE INDEX IF NOT EXISTS memories_vec
          ON memories(libsql_vector_idx(embedding))
      `);
      this.vectorIndexOk = true;
    } catch (error) {
      console.warn(
        "🧠💾 LibSQL vector index unavailable — falling back to in-process cosine.",
        error instanceof Error ? error.message : error,
      );
      this.vectorIndexOk = false;
    }

    this.schemaReady = true;
  }

  private async insertRow(row: MemoryRow, embedding: Float32Array): Promise<void> {
    const client = await this.ensureLibsql();
    await client.execute({
      sql: `
        INSERT INTO memories
          (id, user_id, session_id, created_at, caption, entities,
           transcript, frame_count, thumb_b64, embedding)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, vector32(?))
      `,
      args: [
        row.id,
        row.userId,
        row.sessionId,
        row.createdAt,
        row.caption,
        JSON.stringify(row.entities),
        row.transcript,
        row.frameCount,
        row.thumbB64,
        `[${Array.from(embedding).join(",")}]`,
      ],
    });
  }

  /**
   * Vector search via LibSQL native KNN if available, else in-process cosine.
   */
  private async vectorSearch(
    userId: string,
    query: Float32Array,
    topK: number,
  ): Promise<MemoryRow[]> {
    const client = await this.ensureLibsql();

    if (this.vectorIndexOk) {
      const result = await client.execute({
        sql: `
          SELECT id, user_id, session_id, created_at, caption, entities,
                 transcript, frame_count, thumb_b64
          FROM vector_top_k('memories_vec', vector32(?), ?)
          JOIN memories ON memories.rowid = id
          WHERE memories.user_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
        args: [
          `[${Array.from(query).join(",")}]`,
          topK * 2, // overshoot to allow user-filter pruning
          userId,
          topK,
        ],
      });
      return result.rows.map(rowToMemory);
    }

    // Fallback: pull all rows for the user, cosine in JS. Fine for hundreds
    // of memories which is what a hackathon demo will have.
    const all = await client.execute({
      sql: `
        SELECT id, user_id, session_id, created_at, caption, entities,
               transcript, frame_count, thumb_b64, embedding
        FROM memories
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 500
      `,
      args: [userId],
    });
    type Scored = { row: MemoryRow; score: number };
    const scored: Scored[] = all.rows
      .map((r: any): Scored => {
        const emb = decodeF32Blob(r.embedding);
        const score = emb ? cosine(query, emb) : -Infinity;
        return { row: rowToMemory(r), score };
      })
      .filter((s: Scored) => Number.isFinite(s.score))
      .sort((a: Scored, b: Scored) => b.score - a.score)
      .slice(0, topK);
    return scored.map((s: Scored) => s.row);
  }

  // ── Lazy resource creation ────────────────────────────────────────────

  private ensureGenai(): GoogleGenAI {
    if (this.genai) return this.genai;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    this.genai = new GoogleGenAI({ apiKey });
    return this.genai;
  }

  /**
   * Open the LibSQL client. Imported dynamically so the rest of the file
   * type-checks even before `bun install` runs.
   */
  private async ensureLibsql(): Promise<any> {
    if (this.libsql) return this.libsql;
    // @ts-ignore — package added to package.json; install at hackathon time.
    const libsqlModule = await import("@libsql/client");
    this.libsql = libsqlModule.createClient({ url: DB_URL });
    return this.libsql;
  }

  /**
   * Wire the Mastra agent + memory primitives.
   *
   * Kept behind a flag — for v1 the loop runs without Mastra, using direct
   * Gemini calls + LibSQL writes. Once `@mastra/memory` is verified to
   * work on Bun, we promote: same tools, same schema, but the agent's
   * generate() loop runs through Mastra's runner. Tools below already
   * import this lazily.
   */
  async ensureMastra(): Promise<{ agent: MastraAgent; memory: MastraMemory } | null> {
    if (this.mastra) return this.mastra;
    try {
      // @ts-ignore — optional at install time
      const [{ Agent }, { Memory }, { LibSQLStore, LibSQLVector }, googleProvider] =
        await Promise.all([
          // @ts-ignore
          import("@mastra/core"),
          // @ts-ignore
          import("@mastra/memory"),
          // @ts-ignore
          import("@mastra/libsql"),
          // @ts-ignore
          import("@ai-sdk/google"),
        ]);
      const memory = new Memory({
        storage: new LibSQLStore({ id: "project-v-memory-store", url: DB_URL }),
        vector: new LibSQLVector({ id: "project-v-memory-vector", url: DB_URL }),
        embedder: googleProvider.google.embedding(EMBED_MODEL),
        options: {
          semanticRecall: { topK: 5, messageRange: 0 },
          workingMemory: { enabled: false },
        },
      });
      const agent = new Agent({
        id: "project-v-memory",
        name: "Visual Memory",
        model: googleProvider.google(MEMORY_MODEL),
        instructions:
          "You are the visual memory for a vision-assistant on smart glasses. " +
          "When asked, recall the most relevant stored memory.",
        memory,
      });
      this.mastra = { agent, memory };
      return this.mastra;
    } catch (error) {
      console.warn(
        "🧠💾 Mastra not available — using direct Gemini + LibSQL path.",
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function pickThumbnail(frames: Buffer[]): string | null {
  if (frames.length === 0) return null;
  // Middle frame is usually the most representative (the user's gaze
  // stabilizes after the first frame and before they move on). Cheap heuristic.
  const mid = Math.floor(frames.length / 2);
  return frames[mid].toString("base64");
}

function safeParseJson(text: string): any {
  if (!text) return null;
  // Tolerate ```json fences ChatGPT-style.
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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

function formatAgo(deltaMs: number): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

function cryptoId(): string {
  // crypto.randomUUID() is on globalThis under Bun.
  // @ts-ignore
  return (globalThis.crypto as Crypto).randomUUID();
}

function rowToMemory(r: any): MemoryRow {
  let entities: MemoryEntity[] = [];
  try {
    entities = JSON.parse(r.entities ?? "[]");
  } catch {
    entities = [];
  }
  return {
    id: String(r.id),
    userId: String(r.user_id),
    sessionId: String(r.session_id),
    createdAt: Number(r.created_at),
    caption: String(r.caption ?? ""),
    entities,
    transcript: r.transcript ? String(r.transcript) : null,
    frameCount: Number(r.frame_count ?? 0),
    thumbB64: r.thumb_b64 ? String(r.thumb_b64) : null,
  };
}

function decodeF32Blob(blob: unknown): Float32Array | null {
  if (!blob) return null;
  // LibSQL returns BLOBs as Uint8Array (or Buffer under Bun).
  if (blob instanceof Uint8Array) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }
  if (Array.isArray(blob)) {
    return new Float32Array(blob);
  }
  return null;
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? -Infinity : dot / denom;
}
