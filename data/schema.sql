-- Project-V visual memory schema.
--
-- One file: data/memories.db. Created on first MemoryAgent boot if absent.
-- This file documents the schema; the actual CREATE statements run from
-- MemoryAgent.ts via libsql client.execute() (see src/server/agent/MemoryAgent.ts).
--
-- Why a single table:
--   The whole feature is "remember a moment, recall a moment". A moment is one
--   row. Caption + entities + transcript + thumb + embedding live together.
--   No joins, no migrations on hackathon day.

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,           -- ms since epoch
  caption       TEXT NOT NULL,              -- "keys on kitchen counter next to blue mug"
  entities      TEXT NOT NULL DEFAULT '[]', -- JSON array: [{type, name, location?, ...}]
  transcript    TEXT,                       -- last ~10s of user speech around the moment
  frame_count   INTEGER NOT NULL DEFAULT 0, -- how many JPEGs the burst captured
  thumb_b64     TEXT,                       -- one representative frame, small jpeg, base64
  embedding     F32_BLOB(768)               -- caption embedding (text-embedding-004)
);

CREATE INDEX IF NOT EXISTS memories_user_time
  ON memories(user_id, created_at DESC);

-- LibSQL native vector index. If this CREATE INDEX fails on Bun's bundled
-- libsql build, fall back to in-process cosine similarity over the embedding
-- BLOB (see MemoryAgent.recall()).
CREATE INDEX IF NOT EXISTS memories_vec
  ON memories(libsql_vector_idx(embedding));
