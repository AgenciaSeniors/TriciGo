-- ============================================================
-- BUG-167: enforce_max_trusted_contacts() has a TOCTOU race.
-- Two concurrent INSERTs by the same user can both observe
-- count(*) = 4, both pass the `>= 5` check, and both insert →
-- the user ends up with 6 contacts instead of the documented
-- max of 5. Low-impact (no security exposure, just a quota
-- breach) but trivially fixable with a transaction-scoped
-- advisory lock keyed on user_id.
--
-- pg_advisory_xact_lock(hashtext('trusted_contacts:'||user_id))
-- serializes concurrent INSERTs for the SAME user_id only —
-- different users still proceed in parallel. The lock is
-- automatically released at COMMIT/ROLLBACK.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_max_trusted_contacts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Serialize concurrent INSERTs for the same user_id so the
  -- count check + insert is atomic w.r.t. other writers.
  PERFORM pg_advisory_xact_lock(hashtext('trusted_contacts:'||NEW.user_id::text));

  IF (SELECT count(*) FROM trusted_contacts WHERE user_id = NEW.user_id) >= 5 THEN
    RAISE EXCEPTION 'Maximum trusted contacts reached (5)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
