ALTER TABLE question_sets
ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0 CHECK (play_count >= 0);

ALTER TABLE game_sessions
ADD COLUMN completed_normally_at TEXT;

CREATE TABLE IF NOT EXISTS completed_question_set_plays (
  game_session_id TEXT PRIMARY KEY,
  question_set_id TEXT NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS completed_question_set_plays_question_set_id_idx
  ON completed_question_set_plays (question_set_id);

CREATE INDEX IF NOT EXISTS question_sets_public_play_count_idx
  ON question_sets (is_public, play_count DESC, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS increment_question_set_play_count
AFTER INSERT ON completed_question_set_plays
FOR EACH ROW
BEGIN
  UPDATE question_sets
  SET play_count = play_count + 1
  WHERE id = NEW.question_set_id;
END;
