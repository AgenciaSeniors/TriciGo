-- 00380_delivery_photos_bucket.sql
-- Dedicated PUBLIC bucket for proof-of-delivery photos.
--
-- Bug fixed: deliveryService.uploadDeliveryPhoto uploaded to the PRIVATE
-- 'driver-documents' bucket with object path 'delivery-photos/<rideId>/...'.
-- The 'driver_documents_insert' policy requires foldername[1] = 'driver-docs',
-- so the INSERT into storage.objects was rejected with
-- "new row violates row-level security policy".
-- Additionally, 'driver-documents' is private, so getPublicUrl() produced a
-- non-loadable URL — the web tracking pages (including the anonymous share
-- link) render <img src> directly and could never show the photo.
--
-- This public bucket keeps getPublicUrl + <img src> working with no consumer
-- refactor (same model as the existing 'avatars' bucket). Object paths are
-- '<rideId>/<file>', so the URL carries the ride UUID (non-enumerable).

-- 1. Public bucket (idempotent).
INSERT INTO storage.buckets (id, name, public)
VALUES ('delivery-photos', 'delivery-photos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 2. INSERT: only the ASSIGNED driver of the ride may upload.
--    Path contract: foldername[1] = rides.id (e.g. '<rideId>/delivery-...jpg').
DROP POLICY IF EXISTS "delivery_photos_insert" ON storage.objects;
CREATE POLICY "delivery_photos_insert"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'delivery-photos'
  AND EXISTS (
    SELECT 1 FROM rides
    WHERE rides.id::text = (storage.foldername(name))[1]
      AND rides.driver_id = (SELECT id FROM driver_profiles WHERE user_id = auth.uid())
  )
);

-- 3. UPDATE: same gate (covers the client's upsert:true on re-upload of a path).
DROP POLICY IF EXISTS "delivery_photos_update" ON storage.objects;
CREATE POLICY "delivery_photos_update"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'delivery-photos'
  AND EXISTS (
    SELECT 1 FROM rides
    WHERE rides.id::text = (storage.foldername(name))[1]
      AND rides.driver_id = (SELECT id FROM driver_profiles WHERE user_id = auth.uid())
  )
)
WITH CHECK (
  bucket_id = 'delivery-photos'
  AND EXISTS (
    SELECT 1 FROM rides
    WHERE rides.id::text = (storage.foldername(name))[1]
      AND rides.driver_id = (SELECT id FROM driver_profiles WHERE user_id = auth.uid())
  )
);

-- No SELECT policy needed: a public bucket serves objects via
-- /storage/v1/object/public/... without evaluating RLS, so the authenticated
-- tracking page and the anonymous share page both load the <img> fine.
