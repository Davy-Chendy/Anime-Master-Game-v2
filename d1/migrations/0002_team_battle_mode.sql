PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS game_sessions_new (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  question_set_id TEXT NOT NULL REFERENCES question_sets(id) ON DELETE RESTRICT,
  presenter_player_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLAYING' CHECK (status IN ('QUESTION_SETUP', 'PLAYING', 'GAME_RESULT')),
  game_mode TEXT NOT NULL DEFAULT 'ROUND_REVEAL' CHECK (game_mode IN ('ROUND_REVEAL', 'BUZZER_FIRST_CORRECT', 'BUZZER_RANKED', 'TEAM_BATTLE')),
  current_question_index INTEGER NOT NULL DEFAULT 0 CHECK (current_question_index >= 0),
  current_reveal_round INTEGER NOT NULL DEFAULT 1 CHECK (current_reveal_round >= 1),
  revealed_blocks TEXT NOT NULL DEFAULT '[]',
  max_reveal_rounds INTEGER NOT NULL DEFAULT 3 CHECK (max_reveal_rounds >= 1),
  round_seconds INTEGER NOT NULL DEFAULT 60 CHECK (round_seconds >= 1),
  round_scores TEXT NOT NULL DEFAULT '[5,3,1]',
  team_battle_state TEXT,
  round_started_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT
);

INSERT INTO game_sessions_new (
  id,
  room_id,
  question_set_id,
  presenter_player_id,
  status,
  game_mode,
  current_question_index,
  current_reveal_round,
  revealed_blocks,
  max_reveal_rounds,
  round_seconds,
  round_scores,
  round_started_at,
  created_at,
  ended_at
)
SELECT
  id,
  room_id,
  question_set_id,
  presenter_player_id,
  status,
  game_mode,
  current_question_index,
  current_reveal_round,
  revealed_blocks,
  max_reveal_rounds,
  round_seconds,
  round_scores,
  round_started_at,
  created_at,
  ended_at
FROM game_sessions;

DROP TABLE game_sessions;
ALTER TABLE game_sessions_new RENAME TO game_sessions;

CREATE INDEX IF NOT EXISTS game_sessions_room_id_idx ON game_sessions (room_id);
CREATE INDEX IF NOT EXISTS game_sessions_question_set_id_idx ON game_sessions (question_set_id);

PRAGMA foreign_keys = ON;
