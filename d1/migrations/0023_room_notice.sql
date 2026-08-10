ALTER TABLE rooms
ADD COLUMN room_notice TEXT
CHECK (room_notice IS NULL OR length(room_notice) <= 80);
