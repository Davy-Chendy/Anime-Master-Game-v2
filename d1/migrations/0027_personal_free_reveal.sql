ALTER TABLE rooms
ADD COLUMN lobby_personal_reveal_mode TEXT NOT NULL DEFAULT 'GRID'
CHECK (lobby_personal_reveal_mode IN ('GRID', 'FREE_RECT'));

ALTER TABLE game_sessions
ADD COLUMN personal_reveal_state TEXT;
