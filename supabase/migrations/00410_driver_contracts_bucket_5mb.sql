-- ============================================================
-- Migration 00410: raise driver-contracts bucket size limit to 5 MB
--
-- The driver licence contract grew from a one-page acceptance form into
-- the full multi-page formal contract + T&C annex. The original 2 MB
-- cap (00405) was tight headroom for the bilingual variants. 5 MB gives
-- comfortable room regardless of how the embedded font / images evolve.
-- PDF only, still private.
-- ============================================================

UPDATE storage.buckets
SET file_size_limit = 5242880  -- 5 MiB
WHERE id = 'driver-contracts';

-- Verification:
--   SELECT id, file_size_limit FROM storage.buckets WHERE id = 'driver-contracts';
--   -- expected: (driver-contracts, 5242880)
