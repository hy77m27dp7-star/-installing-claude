-- One sequence number per conversation. Two turns landing at once (two devices, or a
-- story turn racing an operator turn) must not interleave; the loser's batch fails and
-- the Worker recomputes its seq once, with no new model call.
DROP INDEX IF EXISTS idx_messages_conv_seq;
CREATE UNIQUE INDEX idx_messages_conv_seq ON messages(conversation_id, seq);
