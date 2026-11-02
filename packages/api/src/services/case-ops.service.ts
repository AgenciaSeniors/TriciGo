// ============================================================
// TriciGo — support, cases and moderation from the panel (00673)
//
// Every action goes through an ops function that admins and operators share (marketing too, for
// tickets): supabase/migrations/00673_operator_support_and_moderation.sql. The server checks the
// caller, binds the action to the state the panel showed, logs it and tells the parties; refusals
// come back as AppErrors carrying the server's code. A refund an operator proposes waits in
// ride_dispute_escalations until an admin pays it.
// ============================================================

import type { DisputeResolution, DisputeStatus, IncidentStatus, LostItemStatus, TicketMessage, TicketStatus } from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { callOpsRpc, trimmedText } from './_ops-rpc';

/** An ops function the database does not have yet (00673 not applied). */
export const CASES_UNAVAILABLE = 'CASES_UNAVAILABLE';

export type IncidentDecision = Extract<IncidentStatus, 'investigating' | 'resolved' | 'dismissed'>;
export type RefundResolution = Extract<DisputeResolution, 'full_refund' | 'partial_refund' | 'credit'>;
export type NoRefundResolution = Extract<DisputeResolution, 'no_action' | 'warning_issued'>;

/** A refund an operator proposed for a dispute (ride_dispute_escalations). */
export interface DisputeEscalation {
  id: string;
  dispute_id: string;
  resolution: RefundResolution;
  suggested_trc: number;
  reason: string;
  status: 'pending' | 'refunded' | 'closed';
  escalated_by: string;
  escalated_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  refund_transaction_id: string | null;
}

const call = (rpc: string, args: Record<string, unknown>) => callOpsRpc(rpc, args, CASES_UNAVAILABLE);

export const caseOpsService = {
  /** Change a ticket's status. `expectedStatus` is the one shown: ticket_changed if it moved. */
  async updateTicket(ticketId: string, status: TicketStatus, expectedStatus: TicketStatus): Promise<void> {
    await call('ops_update_ticket', { p_ticket_id: ticketId, p_status: status, p_expected_status: expectedStatus });
  },

  /** Answer a ticket as support. An open ticket moves to in_progress in the same call. */
  async replyTicket(ticketId: string, message: string): Promise<{ message: TicketMessage; status: TicketStatus }> {
    const result = await call('ops_reply_ticket', { p_ticket_id: ticketId, p_message: trimmedText(message) });
    return { message: result.message as TicketMessage, status: result.status as TicketStatus };
  },

  /**
   * Investigate, resolve or dismiss an incident. `hideReview` hides the review a review_abuse
   * incident reports, in the same call as resolving it.
   */
  async updateIncident(incidentId: string, status: IncidentDecision, expectedStatus: IncidentStatus,
                       opts: { notes?: string | null; hideReview?: boolean } = {}): Promise<void> {
    await call('ops_update_incident', {
      p_incident_id: incidentId,
      p_status: status,
      p_expected_status: expectedStatus,
      p_notes: trimmedText(opts.notes),
      p_hide_review: opts.hideReview ?? false,
    });
  },

  /** Save the team's notes on a lost item (blank clears them). */
  async saveLostItemNotes(itemId: string, expectedStatus: LostItemStatus, notes: string | null): Promise<void> {
    await call('ops_update_lost_item', {
      p_item_id: itemId, p_action: 'notes', p_expected_status: expectedStatus, p_notes: trimmedText(notes),
    });
  },

  /** Close a lost-item report, with an optional note. */
  async closeLostItem(itemId: string, expectedStatus: LostItemStatus, notes?: string | null): Promise<void> {
    await call('ops_update_lost_item', {
      p_item_id: itemId, p_action: 'close', p_expected_status: expectedStatus, p_notes: trimmedText(notes),
    });
  },

  /** Take a dispute: under review and assigned to the caller. The parties are told. */
  async takeDispute(disputeId: string, expectedStatus: DisputeStatus): Promise<void> {
    await call('ops_update_dispute', {
      p_dispute_id: disputeId, p_action: 'take', p_expected_status: expectedStatus, p_notes: null,
    });
  },

  /** Save the team's notes on a dispute (blank clears them). */
  async saveDisputeNotes(disputeId: string, expectedStatus: DisputeStatus, notes: string | null): Promise<void> {
    await call('ops_update_dispute', {
      p_dispute_id: disputeId, p_action: 'notes', p_expected_status: expectedStatus, p_notes: trimmedText(notes),
    });
  },

  /** Resolve in the driver's favour, with no money (no_action, warning_issued). Needs a note. */
  async resolveDisputeWithoutRefund(disputeId: string, resolution: NoRefundResolution,
                                    expectedStatus: DisputeStatus, notes: string): Promise<void> {
    await call('ops_resolve_dispute_without_refund', {
      p_dispute_id: disputeId, p_resolution: resolution, p_expected_status: expectedStatus, p_notes: trimmedText(notes),
    });
  },

  /** Propose a refund to an admin. Returns the proposal's id. */
  async escalateDispute(disputeId: string, resolution: RefundResolution, suggestedTrc: number,
                        expectedStatus: DisputeStatus, reason: string): Promise<string> {
    const result = await call('ops_escalate_dispute', {
      p_dispute_id: disputeId,
      p_resolution: resolution,
      p_suggested_trc: suggestedTrc,
      p_expected_status: expectedStatus,
      p_reason: trimmedText(reason),
    });
    return result.escalation_id as string;
  },

  /** The proposal waiting on a dispute, or null (also while 00673 is not applied). */
  async getPendingEscalation(disputeId: string): Promise<DisputeEscalation | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_dispute_escalations')
      .select('*')
      .eq('dispute_id', disputeId)
      .eq('status', 'pending')
      .maybeSingle();
    if (error) {
      if (error.code === 'PGRST205' || error.code === '42P01') return null;
      throw error;
    }
    return (data as DisputeEscalation | null) ?? null;
  },

  /** Admins: pay a proposal as shown (amount_changed if it moved). Returns the refund's transaction. */
  async refundEscalation(escalationId: string, expectedTrc: number): Promise<string | null> {
    const result = await call('admin_refund_escalated_dispute', { p_escalation_id: escalationId, p_expected_trc: expectedTrc });
    return (result.refund_transaction_id as string | undefined) ?? null;
  },

  /** Show or hide a review. `expectedVisible` is what was shown: review_changed if it moved. */
  async setReviewVisibility(reviewId: string, visible: boolean, expectedVisible: boolean): Promise<void> {
    await call('ops_set_review_visibility', { p_review_id: reviewId, p_visible: visible, p_expected_visible: expectedVisible });
  },

  /** Resolve a fraud alert, with an optional note. */
  async resolveFraudAlert(alertId: string, note?: string | null): Promise<void> {
    await call('ops_resolve_fraud_alert', { p_alert_id: alertId, p_note: trimmedText(note) });
  },
};
