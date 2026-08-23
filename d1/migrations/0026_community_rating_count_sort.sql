CREATE INDEX question_sets_public_rating_count_idx
  ON question_sets (rating_count DESC, rating_avg DESC, created_at DESC, id DESC)
  WHERE is_public = 1;

CREATE INDEX question_sets_public_creation_rating_count_idx
  ON question_sets (creation_method, rating_count DESC, rating_avg DESC, created_at DESC, id DESC)
  WHERE is_public = 1;
