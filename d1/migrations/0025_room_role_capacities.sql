ALTER TABLE rooms
ADD COLUMN lobby_player_capacity INTEGER NOT NULL DEFAULT 50
CHECK (lobby_player_capacity BETWEEN 1 AND 50);

ALTER TABLE rooms
ADD COLUMN lobby_spectator_capacity INTEGER NOT NULL DEFAULT 50
CHECK (lobby_spectator_capacity BETWEEN 0 AND 50);

-- member_count historically stored every room member. From this migration onward it is
-- the player-role count; spectator_count remains the spectator-role count.
UPDATE rooms
SET member_count = CASE
  WHEN json_valid(room_state_json) AND json_type(room_state_json, '$.players') = 'array' THEN (
    SELECT COUNT(*)
    FROM json_each(rooms.room_state_json, '$.players')
    WHERE json_extract(value, '$.role') = 'PLAYER'
  )
  ELSE MAX(0, member_count - spectator_count)
END,
spectator_count = CASE
  WHEN json_valid(room_state_json) AND json_type(room_state_json, '$.players') = 'array' THEN (
    SELECT COUNT(*)
    FROM json_each(rooms.room_state_json, '$.players')
    WHERE json_extract(value, '$.role') = 'SPECTATOR'
  )
  ELSE spectator_count
END;
