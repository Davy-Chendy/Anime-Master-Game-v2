ALTER TABLE question_sets
ADD COLUMN manifest_version INTEGER
CHECK (manifest_version IS NULL OR manifest_version = 1);

ALTER TABLE question_sets
ADD COLUMN manifest_revision INTEGER NOT NULL DEFAULT 0
CHECK (manifest_revision >= 0);

ALTER TABLE question_sets
ADD COLUMN manifest_json TEXT;

DROP INDEX IF EXISTS question_sets_public_created_idx;
DROP INDEX IF EXISTS question_sets_public_rating_idx;
DROP INDEX IF EXISTS question_sets_public_play_count_idx;
DROP INDEX IF EXISTS question_sets_public_creation_created_idx;
DROP INDEX IF EXISTS question_sets_public_creation_rating_idx;
DROP INDEX IF EXISTS question_sets_public_creation_play_count_idx;

CREATE INDEX question_sets_public_created_idx
  ON question_sets (created_at DESC, id DESC)
  WHERE is_public = 1;

CREATE INDEX question_sets_public_rating_idx
  ON question_sets (rating_avg DESC, rating_count DESC, created_at DESC, id DESC)
  WHERE is_public = 1;

CREATE INDEX question_sets_public_play_count_idx
  ON question_sets (play_count DESC, created_at DESC, id DESC)
  WHERE is_public = 1;

CREATE INDEX question_sets_public_creation_created_idx
  ON question_sets (creation_method, created_at DESC, id DESC)
  WHERE is_public = 1;

CREATE INDEX question_sets_public_creation_rating_idx
  ON question_sets (creation_method, rating_avg DESC, rating_count DESC, created_at DESC, id DESC)
  WHERE is_public = 1;

CREATE INDEX question_sets_public_creation_play_count_idx
  ON question_sets (creation_method, play_count DESC, created_at DESC, id DESC)
  WHERE is_public = 1;

CREATE INDEX question_sets_private_cleanup_idx
  ON question_sets (updated_at, id)
  WHERE is_public = 0;

CREATE INDEX rooms_prepared_question_set_id_idx
  ON rooms (prepared_question_set_id)
  WHERE prepared_question_set_id IS NOT NULL;
