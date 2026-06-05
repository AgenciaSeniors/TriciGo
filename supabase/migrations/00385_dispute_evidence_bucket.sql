-- ============================================================
-- 00385_dispute_evidence_bucket.sql
--
-- Create the `dispute-evidence` Storage bucket. It NEVER existed (no prior
-- migration, no RLS), so attaching evidence photos when opening a dispute
-- (apps/client/app/ride/dispute/[rideId].tsx) always failed. Discovered while
-- fixing the project-wide "Storage rejects the user JWT as anon since the
-- publishable-key migration" upload breakage.
--
-- PUBLIC bucket, matching delivery-photos + avatars: the dispute upload code
-- stores getPublicUrl() in disputes.evidence_urls (a permanent URL the admin
-- viewer reads back), so a PRIVATE bucket would 403 on read. Paths are two
-- UUIDs deep (disputes/{rideId}/{userId}/{ts}.ext) → effectively unguessable,
-- same posture as delivery-photos. (If stricter privacy is wanted later:
-- switch to private + createSignedUrl in both the upload and the admin viewer.)
--
-- Uploads now go through the `storage-upload` Edge Function (service-role),
-- which authenticates the caller + checks they own the {userId} folder AND are
-- a party (customer/driver) of {rideId}. The INSERT policy below is
-- defense-in-depth: RLS still gates a direct authenticated insert even though
-- the EF bypasses it with service-role.
--
-- Idempotent.
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('dispute-evidence', 'dispute-evidence', true)
ON CONFLICT (id) DO NOTHING;

-- Defense-in-depth INSERT policy. Path: disputes/{rideId}/{userId}/{file}
-- → storage.foldername(name) = {disputes, rideId, userId}; [1]='disputes', [3]=userId.
DROP POLICY IF EXISTS "dispute_evidence_insert" ON storage.objects;
CREATE POLICY "dispute_evidence_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'dispute-evidence'
    AND (storage.foldername(name))[1] = 'disputes'
    AND (storage.foldername(name))[3] = (auth.uid())::text
    -- rideId folder ([2]) must reference a ride the caller is a party to —
    -- mirrors the storage-upload EF so this defense-in-depth policy is as
    -- strict as the real (service-role) upload path, not just a userId check.
    AND EXISTS (
      SELECT 1 FROM rides r
      WHERE r.id::text = (storage.foldername(name))[2]
        AND (
          r.customer_id = auth.uid()
          OR r.driver_id = (SELECT dp.id FROM driver_profiles dp WHERE dp.user_id = auth.uid())
        )
    )
  );
