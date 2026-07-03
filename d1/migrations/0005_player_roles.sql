PRAGMA foreign_keys = ON;

ALTER TABLE players
  ADD COLUMN role TEXT NOT NULL DEFAULT 'PLAYER' CHECK (role IN ('PLAYER', 'SPECTATOR'));

CREATE INDEX IF NOT EXISTS players_room_role_idx ON players (room_id, role);
