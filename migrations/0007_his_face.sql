-- v3.1 (SPEC_V3 section JJ, "What he looks like", 2026-09-25): the seq of her reply on the
-- last turn his reference photos rode along in a conversation, so the Apart cadence
-- (hisFaceApartEvery) can count the turns since. Null on every existing row (never shown
-- yet). Additive: no row is touched, no table dropped. The Worker tolerates the column
-- being absent: the read then counts the turn as "just shown" (FACE_CADENCE_UNREADABLE in
-- src/hisFace.ts), so the Apart cadence waits for this migration and the photos ride only
-- on his first turn, on Together turns and when he mentions his looks; the write after the
-- turn's batch is best effort. Apply this REMOTELY BEFORE the deploy that carries it, as
-- two commands with a check between (the Sept 24 lesson).
ALTER TABLE conversations ADD COLUMN his_face_seq INTEGER;
