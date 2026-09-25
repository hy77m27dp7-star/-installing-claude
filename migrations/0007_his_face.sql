-- v3.1 (SPEC_V3 section JJ, "What he looks like", 2026-09-25): the seq of her reply on the
-- last turn his reference photos rode along in a conversation, so the Apart cadence
-- (hisFaceApartEvery) can count the turns since. Null on every existing row (never shown
-- yet). Additive: no row is touched, no table dropped. The Worker tolerates the column
-- being absent (the read is a nicety and the write is best effort after the turn's batch).
ALTER TABLE conversations ADD COLUMN his_face_seq INTEGER;
