ALTER TABLE rooms ADD COLUMN lobby_game_mode TEXT NOT NULL DEFAULT 'ROUND_REVEAL'
  CHECK (lobby_game_mode IN ('ROUND_REVEAL', 'BUZZER_FIRST_CORRECT', 'BUZZER_RANKED', 'TEAM_BATTLE'));

ALTER TABLE rooms ADD COLUMN lobby_max_reveal_rounds INTEGER NOT NULL DEFAULT 3
  CHECK (lobby_max_reveal_rounds >= 1);

ALTER TABLE rooms ADD COLUMN lobby_round_seconds INTEGER NOT NULL DEFAULT 60
  CHECK (lobby_round_seconds >= 1);

ALTER TABLE rooms ADD COLUMN lobby_round_scores TEXT NOT NULL DEFAULT '[3,2,1]';
