ALTER TABLE rooms
ADD COLUMN lobby_spectator_question_preview_enabled INTEGER NOT NULL DEFAULT 1
CHECK (lobby_spectator_question_preview_enabled IN (0, 1));

ALTER TABLE rooms
ADD COLUMN lobby_spectator_player_answers_enabled INTEGER NOT NULL DEFAULT 1
CHECK (lobby_spectator_player_answers_enabled IN (0, 1));
