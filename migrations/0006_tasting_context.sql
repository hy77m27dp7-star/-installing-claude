-- v3 review fix (2026-09-24): a tasting keeps the state its two candidates were generated
-- from (the state sections as sent, the exemplars offered, the half-remembered pick), so
-- the pick commits the provenance the performers saw instead of a state rebuilt minutes
-- later (SPEC_V3 section HH: "the same Prepared"). Runs once through the ledger after
-- 0005b; touches no existing row (the column is null on older tastings, which the pick
-- reads as "rebuild", the previous behaviour).
ALTER TABLE tastings ADD COLUMN context_json TEXT;
