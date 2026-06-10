-- ============================================================================
-- 00400 — ride_disputes: lock down respondent-writable columns (DISP-RLS)
-- ============================================================================
-- Audit pass #2 (2026-06-10), finding DISP-RLS (P2): the RLS UPDATE policy
-- `dispute_update` is USING ((respondent_id = auth.uid()) OR is_admin()) with
-- NO WITH CHECK and NO column guard, and `authenticated` holds the UPDATE grant
-- on every column. So the RESPONDENT (the accused party) can PATCH ANY column
-- of a dispute they're named on — e.g. set status='resolved_driver'/'closed' to
-- dodge the dispute, fake refund_amount_trc, or wipe admin_notes/resolution.
-- No money moves (the real refund is process_dispute_refund, admin-only), but
-- it corrupts dispute integrity / lets the accused self-resolve.
--
-- Fix: a BEFORE UPDATE trigger that mirrors the tg_*_protect_admin_fields
-- pattern — for non-admin callers it freezes every column EXCEPT the three the
-- respondToDispute flow legitimately writes (respondent_message,
-- respondent_evidence_urls, respondent_replied_at) plus a status move to
-- 'under_review'. Admins (is_admin()) and service-role / SECDEF contexts
-- (auth.uid() IS NULL — process_dispute_refund runs as the admin caller and is
-- exempt via is_admin()) pass through untouched. The permissive policy stays;
-- the trigger is the column-level enforcement, consistent with rides/users/
-- driver_profiles. NOT applied to prod yet (MCP guard).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.tg_ride_disputes_protect_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;
  IF auth.uid() IS NULL THEN
    RETURN NEW;  -- service-role / SECDEF (e.g. process_dispute_refund)
  END IF;

  -- Non-admin = the respondent (the only non-admin allowed to UPDATE per the
  -- dispute_update RLS policy). They may submit their response and move status
  -- to 'under_review' — nothing else.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'under_review' THEN
    NEW.status := OLD.status;
  END IF;

  NEW.id                      := OLD.id;
  NEW.ride_id                 := OLD.ride_id;
  NEW.opened_by               := OLD.opened_by;
  NEW.reason                  := OLD.reason;
  NEW.description             := OLD.description;
  NEW.evidence_urls           := OLD.evidence_urls;       -- opener's evidence
  NEW.priority                := OLD.priority;
  NEW.respondent_id           := OLD.respondent_id;
  NEW.resolution              := OLD.resolution;
  NEW.resolution_notes        := OLD.resolution_notes;
  NEW.refund_amount_trc       := OLD.refund_amount_trc;
  NEW.refund_transaction_id   := OLD.refund_transaction_id;
  NEW.assigned_to             := OLD.assigned_to;
  NEW.admin_notes             := OLD.admin_notes;
  NEW.sla_first_response_at   := OLD.sla_first_response_at;
  NEW.sla_resolution_deadline := OLD.sla_resolution_deadline;
  NEW.support_ticket_id       := OLD.support_ticket_id;
  NEW.incident_report_id      := OLD.incident_report_id;
  NEW.created_at              := OLD.created_at;
  NEW.resolved_at             := OLD.resolved_at;
  NEW.ride_estimated_fare_trc := OLD.ride_estimated_fare_trc;
  NEW.ride_final_fare_trc     := OLD.ride_final_fare_trc;
  -- left writable: respondent_message, respondent_evidence_urls,
  -- respondent_replied_at, updated_at (set by set_ride_disputes_updated_at).
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_ride_disputes_protect_columns ON public.ride_disputes;
CREATE TRIGGER trg_ride_disputes_protect_columns
  BEFORE UPDATE ON public.ride_disputes
  FOR EACH ROW EXECUTE FUNCTION public.tg_ride_disputes_protect_columns();

COMMENT ON FUNCTION public.tg_ride_disputes_protect_columns() IS
  '00400 DISP-RLS: non-admin respondent may only set respondent_message/_evidence_urls/_replied_at and move status to under_review; all other columns frozen. Admin + service-role/SECDEF exempt.';
