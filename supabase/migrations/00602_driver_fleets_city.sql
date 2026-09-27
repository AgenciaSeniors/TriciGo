-- ============================================================
-- 00602 — driver_fleets.city: the fleet's main city / municipality
--
-- The fleet request form in the driver app (FleetRequestForm) requires
-- "Ciudad / municipio principal", but no column held it, so the value the
-- owner typed was dropped on submit and the admin never saw it. It gets its
-- own column rather than riding in operating_zones or notes, so the admin
-- fleet review (FleetReview) shows it as its own field.
--
-- Nullable: fleets sent before this migration, and requests from app builds
-- that do not send the field, have none. fleetService.submitFleetRequest
-- retries without the column while this migration is not applied, so the
-- apps tolerate its absence.
--
-- No grant changes: anon/authenticated hold table-level privileges on
-- driver_fleets, which cover a new column, and the owner/admin RLS policies
-- are row-level.
-- ============================================================

ALTER TABLE public.driver_fleets ADD COLUMN IF NOT EXISTS city text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'driver_fleets_city_length'
      AND conrelid = 'public.driver_fleets'::regclass
  ) THEN
    ALTER TABLE public.driver_fleets
      ADD CONSTRAINT driver_fleets_city_length
      CHECK (city IS NULL OR char_length(city) BETWEEN 1 AND 120);
  END IF;
END $$;

COMMENT ON COLUMN public.driver_fleets.city IS
  '00602: main city / municipality the owner entered in the fleet request form (1..120 chars; NULL on older requests).';
