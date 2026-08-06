ALTER TABLE rooms
ADD COLUMN lobby_team_presenter_block_enabled INTEGER NOT NULL DEFAULT 0
CHECK (lobby_team_presenter_block_enabled IN (0, 1));
