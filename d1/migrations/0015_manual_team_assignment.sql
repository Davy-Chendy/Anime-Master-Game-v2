ALTER TABLE rooms ADD COLUMN lobby_team_assignment_mode TEXT NOT NULL DEFAULT 'AUTO'
  CHECK (lobby_team_assignment_mode IN ('AUTO', 'MANUAL'));

ALTER TABLE rooms ADD COLUMN lobby_team_assignments TEXT NOT NULL DEFAULT '{}';
