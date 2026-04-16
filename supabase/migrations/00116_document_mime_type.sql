-- Add mime_type column to track file format (image vs PDF)
ALTER TABLE driver_documents
  ADD COLUMN IF NOT EXISTS mime_type TEXT DEFAULT 'image/jpeg';

-- Update existing records to set mime_type based on file extension
UPDATE driver_documents
SET mime_type = CASE
  WHEN file_name ILIKE '%.pdf' THEN 'application/pdf'
  WHEN file_name ILIKE '%.png' THEN 'image/png'
  ELSE 'image/jpeg'
END
WHERE mime_type IS NULL OR mime_type = 'image/jpeg';
