PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS question_snapshots (
  game_session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  question_index INTEGER NOT NULL CHECK (question_index >= 0),
  eligible_player_count INTEGER NOT NULL CHECK (eligible_player_count >= 0),
  eligible_player_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (game_session_id, question_index)
);

CREATE TABLE IF NOT EXISTS question_eligible_players (
  game_session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  question_index INTEGER NOT NULL CHECK (question_index >= 0),
  player_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (game_session_id, question_index, player_id)
);

CREATE INDEX IF NOT EXISTS question_eligible_players_game_question_idx
  ON question_eligible_players (game_session_id, question_index);
