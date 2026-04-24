-- ============================================================
-- BUG-089 defense: hard-guard service_type values.
--
-- Before this migration, any string could be stored in
-- rides.service_type; the invariant was only enforced at
-- complete_ride_and_pay time by a RAISE EXCEPTION that left the
-- ride in a zombie state. Now we fail at INSERT/UPDATE time so
-- misconfigured clients surface the bug immediately.
--
-- Data has been audited to be clean (0 orphans in all 6 tables)
-- so these FKs add no risk.
-- ============================================================

-- rides.service_type → service_type_configs.slug
ALTER TABLE rides
  ADD CONSTRAINT rides_service_type_fk
  FOREIGN KEY (service_type)
  REFERENCES service_type_configs(slug)
  ON UPDATE CASCADE
  ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE rides VALIDATE CONSTRAINT rides_service_type_fk;

-- recurring_rides.service_type
ALTER TABLE recurring_rides
  ADD CONSTRAINT recurring_rides_service_type_fk
  FOREIGN KEY (service_type)
  REFERENCES service_type_configs(slug)
  ON UPDATE CASCADE
  ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE recurring_rides VALIDATE CONSTRAINT recurring_rides_service_type_fk;

COMMENT ON CONSTRAINT rides_service_type_fk ON rides IS
  'BUG-089: ensures rides cannot be created with invalid service slugs. Fails at INSERT instead of at ride completion time.';
