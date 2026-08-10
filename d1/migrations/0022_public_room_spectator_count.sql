ALTER TABLE rooms
ADD COLUMN spectator_count INTEGER NOT NULL DEFAULT 0
CHECK (spectator_count >= 0 AND spectator_count <= 50);

UPDATE rooms
SET spectator_count = COALESCE((
  SELECT COUNT(*)
  FROM json_each(rooms.room_state_json, '$.players')
  WHERE json_extract(value, '$.role') = 'SPECTATOR'
), 0)
WHERE room_visibility = 'PUBLIC';
