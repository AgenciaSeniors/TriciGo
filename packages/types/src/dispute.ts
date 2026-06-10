// ============================================================
// TriciGo — Ride Dispute Types
// Formal dispute resolution for completed rides.
// ============================================================

export type DisputeReason =
  | 'wrong_fare'
  | 'wrong_route'
  | 'driver_behavior'
  | 'vehicle_condition'
  | 'safety_issue'
  | 'unauthorized_charge'
  | 'service_not_rendered'
  | 'excessive_wait'
  | 'lost_item'
  | 'other';

// Mirrors the ride_disputes.status CHECK constraint exactly. The previous
// taxonomy (awaiting_response/resolved/denied) never existed in the DB —
// the canonical process_dispute_refund RPC writes resolved_rider/
// resolved_driver/closed, and the CHECK only accepts these six. Using the
// old names made the no_action path 23514, and the admin filters/badges
// match nothing (A4-DISP).
export type DisputeStatus =
  | 'open'
  | 'under_review'
  | 'escalated'
  | 'resolved_rider'
  | 'resolved_driver'
  | 'closed';

export type DisputeResolution =
  | 'full_refund'
  | 'partial_refund'
  | 'credit'
  | 'no_action'
  | 'warning_issued';

export type DisputePriority = 'low' | 'normal' | 'high' | 'urgent';

export interface RideDispute {
  id: string;
  ride_id: string;
  opened_by: string;
  reason: DisputeReason;
  description: string;
  evidence_urls: string[];
  status: DisputeStatus;
  priority: DisputePriority;

  // Respondent (the other party)
  respondent_id: string | null;
  respondent_message: string | null;
  respondent_evidence_urls: string[];
  respondent_replied_at: string | null;

  // Ride fare snapshot (for refund cap)
  ride_final_fare_trc: number | null;
  ride_estimated_fare_trc: number | null;

  // Resolution
  resolution: DisputeResolution | null;
  resolution_notes: string | null;
  refund_amount_trc: number | null;
  refund_transaction_id: string | null;

  // Admin
  assigned_to: string | null;
  admin_notes: string | null;

  // SLA tracking
  sla_first_response_at: string | null;
  sla_resolution_deadline: string | null;

  // Cross-references
  support_ticket_id: string | null;
  incident_report_id: string | null;

  // Timestamps
  created_at: string;
  updated_at: string | null;
  resolved_at: string | null;
}
