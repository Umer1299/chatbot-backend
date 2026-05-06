-- Add conversation intelligence columns to messages
-- All columns are optional – no existing functionality is broken.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS intent_category TEXT,
  ADD COLUMN IF NOT EXISTS is_unanswered BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fallback_used BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS user_message_length INTEGER,
  ADD COLUMN IF NOT EXISTS ai_response_length INTEGER;
