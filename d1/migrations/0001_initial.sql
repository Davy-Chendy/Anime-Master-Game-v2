PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL UNIQUE,
  host_player_id TEXT NOT NULL,
  game_status TEXT NOT NULL DEFAULT 'LOBBY',
  current_presenter_player_id TEXT,
  current_game_id TEXT,
  prepared_question_set_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  is_host INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS players_room_nickname_unique
  ON players (room_id, lower(nickname));
CREATE INDEX IF NOT EXISTS players_room_id_idx ON players (room_id);

CREATE TABLE IF NOT EXISTS question_sets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  created_by_player_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'uploaded' CHECK (source IN ('uploaded', 'community')),
  is_public INTEGER NOT NULL DEFAULT 0,
  image_urls_text TEXT,
  image_count INTEGER NOT NULL DEFAULT 0 CHECK (image_count >= 0),
  rating_avg REAL NOT NULL DEFAULT 0 CHECK (rating_avg >= 0 AND rating_avg <= 5),
  rating_count INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS question_sets_created_by_player_id_idx ON question_sets (created_by_player_id);
CREATE INDEX IF NOT EXISTS question_sets_public_created_idx ON question_sets (is_public, created_at DESC);
CREATE INDEX IF NOT EXISTS question_sets_public_rating_idx ON question_sets (is_public, rating_avg DESC, rating_count DESC);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  question_set_id TEXT NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  label_text TEXT,
  label_source TEXT CHECK (label_source IS NULL OR label_source IN ('manual', 'answer')),
  label_source_answer_id TEXT,
  label_updated_by_player_id TEXT,
  label_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS questions_question_set_id_order_idx ON questions (question_set_id, order_index);

CREATE TABLE IF NOT EXISTS game_sessions (
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

CREATE INDEX IF NOT EXISTS game_sessions_room_id_idx ON game_sessions (room_id);
CREATE INDEX IF NOT EXISTS game_sessions_question_set_id_idx ON game_sessions (question_set_id);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  game_session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  question_index INTEGER NOT NULL CHECK (question_index >= 0),
  reveal_round INTEGER NOT NULL CHECK (reveal_round >= 1),
  player_id TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (game_session_id, question_index, reveal_round, player_id)
);

CREATE INDEX IF NOT EXISTS answers_game_question_round_idx ON answers (game_session_id, question_index, reveal_round);
CREATE INDEX IF NOT EXISTS answers_game_question_player_idx ON answers (game_session_id, question_index, player_id);

CREATE TABLE IF NOT EXISTS buzzer_answers (
  id TEXT PRIMARY KEY,
  game_session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  question_index INTEGER NOT NULL CHECK (question_index >= 0),
  reveal_round INTEGER NOT NULL CHECK (reveal_round >= 1),
  player_id TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'correct', 'wrong')),
  score_awarded INTEGER NOT NULL DEFAULT 0 CHECK (score_awarded >= 0),
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  judged_at TEXT,
  judged_by_player_id TEXT,
  UNIQUE (game_session_id, question_index, reveal_round, player_id)
);

CREATE INDEX IF NOT EXISTS buzzer_answers_game_question_round_idx ON buzzer_answers (game_session_id, question_index, reveal_round, submitted_at);
CREATE INDEX IF NOT EXISTS buzzer_answers_game_question_player_idx ON buzzer_answers (game_session_id, question_index, player_id);

CREATE TABLE IF NOT EXISTS player_scores (
  id TEXT PRIMARY KEY,
  game_session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
  correct_count INTEGER NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  UNIQUE (game_session_id, player_id)
);

CREATE INDEX IF NOT EXISTS player_scores_game_score_idx ON player_scores (game_session_id, score DESC);

CREATE TABLE IF NOT EXISTS question_results (
  id TEXT PRIMARY KEY,
  game_session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  question_index INTEGER NOT NULL CHECK (question_index >= 0),
  player_id TEXT NOT NULL,
  scored_round INTEGER NOT NULL CHECK (scored_round >= 1),
  score_awarded INTEGER NOT NULL CHECK (score_awarded >= 0),
  judged_by_player_id TEXT NOT NULL,
  judged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (game_session_id, question_index, player_id)
);

CREATE INDEX IF NOT EXISTS question_results_game_question_idx ON question_results (game_session_id, question_index);

CREATE TABLE IF NOT EXISTS question_set_ratings (
  id TEXT PRIMARY KEY,
  question_set_id TEXT NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (question_set_id, player_id)
);

CREATE INDEX IF NOT EXISTS question_set_ratings_question_set_id_idx ON question_set_ratings (question_set_id);
