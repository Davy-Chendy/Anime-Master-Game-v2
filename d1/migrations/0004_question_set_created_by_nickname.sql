PRAGMA foreign_keys = ON;

ALTER TABLE question_sets ADD COLUMN created_by_nickname TEXT;

UPDATE question_sets
SET created_by_nickname = (
  SELECT players.nickname
  FROM players
  WHERE players.id = question_sets.created_by_player_id
  LIMIT 1
)
WHERE created_by_nickname IS NULL;
