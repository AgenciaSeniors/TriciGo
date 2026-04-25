-- ============================================================
-- BUG-158: ~60 foreign keys in public.* lack a backing index. The
-- worst offenders are the ones we hit on every admin query and
-- every dispatch / completion path. Without an index on the FK
-- column, Postgres has to seq-scan the child table on every join
-- (and every parent DELETE has to scan to enforce the FK).
--
-- Adding indexes for the FKs that show up in our hot paths.
-- Lower-impact FKs (created_by columns on admin tables, segment
-- filters, etc.) are left unindexed for now — adding those would
-- bloat the schema without measurable hot-path gain.
--
-- All indexes use CREATE INDEX IF NOT EXISTS so this migration is
-- safe to re-run; we don't use CREATE INDEX CONCURRENTLY because
-- the affected tables are small (< 100k rows each).
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_ride_pricing_snapshots_ride_id
  ON public.ride_pricing_snapshots (ride_id);
CREATE INDEX IF NOT EXISTS idx_ride_pricing_snapshots_pricing_rule_id
  ON public.ride_pricing_snapshots (pricing_rule_id);

CREATE INDEX IF NOT EXISTS idx_corporate_rides_ride_id
  ON public.corporate_rides (ride_id);
CREATE INDEX IF NOT EXISTS idx_corporate_rides_employee_user_id
  ON public.corporate_rides (employee_user_id);

CREATE INDEX IF NOT EXISTS idx_incident_reports_ride_id
  ON public.incident_reports (ride_id);
CREATE INDEX IF NOT EXISTS idx_incident_reports_reported_by
  ON public.incident_reports (reported_by);
CREATE INDEX IF NOT EXISTS idx_incident_reports_against_user_id
  ON public.incident_reports (against_user_id);

CREATE INDEX IF NOT EXISTS idx_cancellation_penalties_ride_id
  ON public.cancellation_penalties (ride_id);

CREATE INDEX IF NOT EXISTS idx_vehicles_driver_id
  ON public.vehicles (driver_id);

CREATE INDEX IF NOT EXISTS idx_wallet_redemptions_driver_id
  ON public.wallet_redemptions (driver_id);
CREATE INDEX IF NOT EXISTS idx_wallet_redemptions_transaction_id
  ON public.wallet_redemptions (transaction_id);

CREATE INDEX IF NOT EXISTS idx_wallet_recharge_requests_user_id
  ON public.wallet_recharge_requests (user_id);

CREATE INDEX IF NOT EXISTS idx_reviews_reviewer_id
  ON public.reviews (reviewer_id);

CREATE INDEX IF NOT EXISTS idx_ride_messages_sender_id
  ON public.ride_messages (sender_id);

CREATE INDEX IF NOT EXISTS idx_tips_from_user_id
  ON public.tips (from_user_id);

CREATE INDEX IF NOT EXISTS idx_ride_disputes_support_ticket_id
  ON public.ride_disputes (support_ticket_id);
CREATE INDEX IF NOT EXISTS idx_ride_disputes_incident_report_id
  ON public.ride_disputes (incident_report_id);
CREATE INDEX IF NOT EXISTS idx_ride_disputes_respondent_id
  ON public.ride_disputes (respondent_id);

CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_to
  ON public.support_tickets (assigned_to);
CREATE INDEX IF NOT EXISTS idx_support_tickets_ride_id
  ON public.support_tickets (ride_id);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id
  ON public.referrals (referrer_id);

CREATE INDEX IF NOT EXISTS idx_ride_location_events_driver_id
  ON public.ride_location_events (driver_id);

CREATE INDEX IF NOT EXISTS idx_share_access_log_ride_id
  ON public.share_access_log (ride_id);

CREATE INDEX IF NOT EXISTS idx_sms_log_ride_id
  ON public.sms_log (ride_id);

CREATE INDEX IF NOT EXISTS idx_driver_profiles_zone_id
  ON public.driver_profiles (zone_id);

CREATE INDEX IF NOT EXISTS idx_promotion_uses_user_id
  ON public.promotion_uses (user_id);
CREATE INDEX IF NOT EXISTS idx_promotion_uses_ride_id
  ON public.promotion_uses (ride_id);
