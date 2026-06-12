-- 00404_storage_bucket_hardening_delivery_dispute.sql
-- F6-STORAGE (audit 2026-06-10): the public buckets `delivery-photos` and
-- `dispute-evidence` had NO `file_size_limit` and NO `allowed_mime_types`, so the
-- only size/MIME enforcement lived in their Edge Functions
-- (`upload-delivery-photo`, `storage-upload`). Add bucket-level limits as
-- defense-in-depth: a direct service-role upload (or any future code path) that
-- bypasses the EF is now capped and type-checked at the storage layer too.
--
-- Limits are a SUPERSET of what each EF already enforces, so the EF stays the
-- stricter gate and the bucket never rejects an upload the EF accepted:
--   * upload-delivery-photo: 8 MB, image/(jpe?g|png|webp|heic|heif)
--   * storage-upload (dispute-evidence): 15 MB, image/(jpe?g|png|webp|heic|heif|gif)
--
-- Idempotent (plain UPDATE). Existing objects are unaffected; only NEW uploads
-- are validated. The other 3 buckets (avatars, driver-documents, receipts)
-- already carry bucket-level limits in prod — left untouched.
-- The 2 buckets stay PUBLIC (anonymous ride-tracking / admin dispute viewer read
-- via getPublicUrl); switching dispute-evidence to private + signed URLs is a
-- separate, larger change deferred intentionally.

UPDATE storage.buckets
SET file_size_limit   = 10485760,  -- 10 MB backstop (EF upload-delivery-photo caps at 8 MB)
    allowed_mime_types = ARRAY[
      'image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif'
    ]
WHERE id = 'delivery-photos';

UPDATE storage.buckets
SET file_size_limit   = 15728640,  -- 15 MB (matches EF storage-upload cap)
    allowed_mime_types = ARRAY[
      'image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif','image/gif'
    ]
WHERE id = 'dispute-evidence';
