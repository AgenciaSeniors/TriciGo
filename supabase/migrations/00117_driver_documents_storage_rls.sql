-- Ensure driver-documents bucket exists
INSERT INTO storage.buckets (id, name, public)
VALUES ('driver-documents', 'driver-documents', false)
ON CONFLICT (id) DO NOTHING;

-- Drivers can upload their own documents
CREATE POLICY "Drivers can upload own documents"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'driver-documents'
  AND (storage.foldername(name))[1] = 'driver-docs'
  AND (storage.foldername(name))[2] = (
    SELECT id::text FROM driver_profiles WHERE user_id = auth.uid()
  )
);

-- Drivers can view their own documents
CREATE POLICY "Drivers can view own documents"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'driver-documents'
  AND (storage.foldername(name))[1] = 'driver-docs'
  AND (storage.foldername(name))[2] = (
    SELECT id::text FROM driver_profiles WHERE user_id = auth.uid()
  )
);

-- Admins can view all documents (for review)
-- Check admin role via users table
CREATE POLICY "Admins can view all documents"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'driver-documents'
  AND EXISTS (
    SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'
  )
);
