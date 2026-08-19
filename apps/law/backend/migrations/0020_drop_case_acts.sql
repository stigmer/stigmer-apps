-- Drop the acts feature's storage (reverses 0018): the owner removed
-- acts entirely (2026-08-19) — the statutory frame, the bare-act
-- library pile, and the CaseAct resource all go. "What acts apply" is
-- answered by the assistant reading the filed FIR/charge sheet, not by
-- a stored frame. Production held exactly one row at removal time (a
-- same-day demo entry, verified before this migration was written), so
-- nothing of value is lost. DOCUMENT_CATEGORY_ACT = 9 is reserved in
-- document.proto — the value is never reused.
DROP TABLE IF EXISTS case_acts;
