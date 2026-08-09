ALTER TABLE rooms
ADD COLUMN room_visibility TEXT NOT NULL DEFAULT 'PRIVATE'
CHECK (room_visibility IN ('PRIVATE', 'PUBLIC'));

ALTER TABLE rooms
ADD COLUMN room_name TEXT;

ALTER TABLE rooms
ADD COLUMN member_count INTEGER NOT NULL DEFAULT 0
CHECK (member_count >= 0 AND member_count <= 50);

ALTER TABLE rooms
ADD COLUMN prepared_question_source TEXT
CHECK (
  prepared_question_source IS NULL OR
  prepared_question_source IN ('COMMUNITY', 'CREATION_TOOL', 'MANUAL')
);

CREATE INDEX rooms_public_created_idx
  ON rooms (created_at DESC)
  WHERE room_visibility = 'PUBLIC';
