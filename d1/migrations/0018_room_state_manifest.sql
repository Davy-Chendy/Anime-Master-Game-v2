ALTER TABLE rooms
ADD COLUMN room_state_version INTEGER
CHECK (room_state_version IS NULL OR room_state_version = 1);

ALTER TABLE rooms
ADD COLUMN room_state_revision INTEGER NOT NULL DEFAULT 0
CHECK (room_state_revision >= 0);

ALTER TABLE rooms
ADD COLUMN room_state_json TEXT;

