PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS game_question_projections (
  game_session_id TEXT NOT NULL,
  question_index INTEGER NOT NULL,
  projection_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (game_session_id, question_index)
);
