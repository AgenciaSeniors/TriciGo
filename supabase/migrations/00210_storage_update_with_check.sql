-- ============================================================
-- BUG-168 + BUG-169: two storage.objects UPDATE policies have a
-- USING (qual) clause that restricts WHICH rows you can update,
-- but no WITH CHECK clause to validate the NEW row state. The
-- `name` column holds the full file path, so an UPDATE can rename
-- the object — moving it logically to a different folder and
-- overwriting another user's file in that folder.
--
-- BUG-168 — `Users can update own avatar`:
--   qual: bucket='avatars' AND foldername[1]=auth.uid()
--   Attack: User A updates `userA-uid/avatar.jpg` and sets
--   `name='userB-uid/avatar.jpg'`. The qual passes (old row is in
--   userA's folder), no with_check fails. After the update, userB's
--   avatar is overwritten. Since avatars is a public bucket, this
--   is a defacement vector against any user's profile.
--
-- BUG-169 — `driver_documents_update`:
--   qual: bucket='driver-documents' AND driver_profile.id=foldername[2]
--         AND driver_profiles.user_id=auth.uid()
--   Attack: Driver A renames `driver-docs/A/license.png` to
--   `driver-docs/B/license.png`. The qual passes (old row's folder[2]
--   is A's profile), driver A overwrites driver B's license file.
--   Worse than avatars — these are KYC documents.
--
-- Fix: add a WITH CHECK clause that mirrors USING. Renames must
-- keep the file in the same folder it was in (or another folder
-- the user owns).
-- ============================================================

DROP POLICY IF EXISTS "Users can update own avatar" ON storage.objects;
CREATE POLICY "Users can update own avatar" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

DROP POLICY IF EXISTS driver_documents_update ON storage.objects;
CREATE POLICY driver_documents_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'driver-documents'
    AND EXISTS (
      SELECT 1 FROM driver_profiles
      WHERE driver_profiles.id::text = (storage.foldername(objects.name))[2]
        AND driver_profiles.user_id = auth.uid()
    )
  )
  WITH CHECK (
    bucket_id = 'driver-documents'
    AND (storage.foldername(name))[1] = 'driver-docs'
    AND EXISTS (
      SELECT 1 FROM driver_profiles
      WHERE driver_profiles.id::text = (storage.foldername(objects.name))[2]
        AND driver_profiles.user_id = auth.uid()
    )
  );
