ALTER TABLE buzzer_answers ADD COLUMN server_received_at TEXT;

UPDATE buzzer_answers
SET server_received_at = submitted_at
WHERE server_received_at IS NULL;

CREATE INDEX IF NOT EXISTS buzzer_answers_fair_order_idx
  ON buzzer_answers (game_session_id, question_index, reveal_round, submitted_at, server_received_at, id);
