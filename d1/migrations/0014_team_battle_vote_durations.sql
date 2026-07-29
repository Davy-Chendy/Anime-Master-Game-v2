ALTER TABLE rooms ADD COLUMN lobby_team_reveal_vote_seconds INTEGER NOT NULL DEFAULT 15
  CHECK (lobby_team_reveal_vote_seconds BETWEEN 1 AND 600);

ALTER TABLE rooms ADD COLUMN lobby_team_guess_vote_seconds INTEGER NOT NULL DEFAULT 50
  CHECK (lobby_team_guess_vote_seconds BETWEEN 1 AND 600);
