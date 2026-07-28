ALTER TABLE question_sets
ADD COLUMN creation_method TEXT
CHECK (creation_method IS NULL OR creation_method IN ('player_manual', 'creation_tool_assisted'));

CREATE INDEX IF NOT EXISTS question_sets_public_creation_created_idx
  ON question_sets (is_public, creation_method, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS question_sets_public_creation_rating_idx
  ON question_sets (is_public, creation_method, rating_avg DESC, rating_count DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS question_sets_public_creation_play_count_idx
  ON question_sets (is_public, creation_method, play_count DESC, created_at DESC, id DESC);
