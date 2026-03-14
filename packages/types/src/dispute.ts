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

export type DisputeStatus =
  | 'open'
  | 'under_review'
  | 'awaiting_response'
  | 'resolved'
  | 'denied'
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
