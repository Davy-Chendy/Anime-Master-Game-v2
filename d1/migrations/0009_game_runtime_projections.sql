PRAGMA foreign_keys = ON;

-- Room Durable Object is the live authority. D1 stores one compact, monotonic
-- recovery/history projection per game instead of writing every hot answer to
-- several indexed tables.
CREATE TABLE IF NOT EXISTS game_runtime_projections (
  game_session_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
