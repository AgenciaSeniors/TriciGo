-- Clean up duplicate/conflicting policies on storage.objects for driver-documents.
-- Multiple overlapping INSERT policies were causing upload failures because some
-- expected foldername[1] = auth.uid() while the code uses 'driver-docs' as the
-- first folder. Consolidate into 3 clean policies (INSERT/SELECT/UPDATE).

DROP POLICY IF EXISTS "Drivers upload own documents" ON storage.objects;
DROP POLICY IF EXISTS "Drivers view own documents" ON storage.objects;
DROP POLICY IF EXISTS "driver_select" ON storage.objects;
DROP POLICY IF EXISTS "driver_upload" ON storage.objects;
DROP POLICY IF EXISTS "Drivers can upload own documents" ON storage.objects;
DROP POLICY IF EXISTS "Drivers can view own documents" ON storage.objects;
DROP POLICY IF EXISTS "Admins can view all documents" ON storage.objects;

-- INSERT: authenticated drivers upload to driver-docs/{driver_profile_id}/...
-- where driver_profile_id must belong to the authenticated user
CREATE POLICY "driver_documents_insert"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'driver-documents'
  AND (storage.foldername(name))[1] = 'driver-docs'
  AND EXISTS (
    SELECT 1 FROM driver_profiles
    WHERE id::text = (storage.foldername(name))[2]
      AND user_id = auth.uid()
  )
);

-- SELECT: drivers view own documents OR admins view any
CREATE POLICY "driver_documents_select"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'driver-documents'
  AND (
    EXISTS (
      SELECT 1 FROM driver_profiles
      WHERE id::text = (storage.foldername(name))[2]
        AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE id = auth.uid()
        AND role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])
    )
  )
);

-- UPDATE: needed for upsert=true on re-uploads
CREATE POLICY "driver_documents_update"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'driver-documents'
  AND EXISTS (
    SELECT 1 FROM driver_profiles
    WHERE id::text = (storage.foldername(name))[2]
      AND user_id = auth.uid()
  )
);
