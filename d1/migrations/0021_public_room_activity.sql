ALTER TABLE rooms
ADD COLUMN public_activity_at TEXT;

UPDATE rooms
SET public_activity_at = updated_at
WHERE room_visibility = 'PUBLIC';
