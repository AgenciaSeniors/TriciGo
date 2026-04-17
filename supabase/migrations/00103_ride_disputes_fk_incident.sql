-- ============================================================
-- Migration 00103: Add FK constraint for incident_report_id
-- BUG-049: ride_disputes.incident_report_id has no FK to
-- incident_reports(id). Orphan records possible on delete.
-- ============================================================

ALTER TABLE ride_disputes
  ADD CONSTRAINT fk_ride_disputes_incident_report
    FOREIGN KEY (incident_report_id)
    REFERENCES incident_reports(id)
    ON DELETE SET NULL;
