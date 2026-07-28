PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS game_result_archives (
  game_session_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  question_set_id TEXT NOT NULL,
  archive_version INTEGER NOT NULL,
  completed_at TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
