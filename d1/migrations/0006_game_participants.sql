PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS game_participants (
  game_session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'PLAYER' CHECK (role IN ('PLAYER', 'SPECTATOR')),
  joined_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (game_session_id, player_id)
);

CREATE INDEX IF NOT EXISTS game_participants_game_idx
  ON game_participants (game_session_id, joined_at);
