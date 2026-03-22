// ============================================================
// TriciGo — Dispute Service
// Formal ride dispute resolution with refund processing.
// ============================================================

import type {
  RideDispute,
  DisputeReason,
  DisputeStatus,
  DisputeResolution,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { validate, createDisputeSchema } from '../schemas';
import { notificationService } from './notification.service';

export const disputeService = {
  /**
   * Open a formal dispute on a completed ride.
   * Automatically determines the respondent from the ride parties,
   * sets SLA deadlines, and marks ride as 'disputed'.
   */
  async createDispute(params: {
    ride_id: string;
    opened_by: string;
    reason: DisputeReason;
    description: string;
    evidence_urls?: string[];
  }): Promise<RideDispute> {
    const validParams = validate(createDisputeSchema, params);
    const supabase = getSupabaseClient();

    // Fetch ride to determine respondent
    const { data: ride, error: rideError } = await supabase
      .from('rides')
      .select('customer_id, driver_id')
      .eq('id', validParams.ride_id)
      .single();
    if (rideError) throw rideError;

    // Determine respondent: if opener is customer, respondent is driver (user_id)
    let respondentId: string | null = null;
    if (ride.customer_id === validParams.opened_by && ride.driver_id) {
      // Opener is customer → respondent is driver's user_id
      const { data: driverProfile } = await supabase
        .from('driver_profiles')
        .select('user_id')
        .eq('id', ride.driver_id)
        .single();
      respondentId = driverProfile?.user_id ?? null;
    } else if (ride.driver_id) {
      // Opener is driver → respondent is customer
      respondentId = ride.customer_id;
    }

    // SLA: first response within 24h, resolution within 72h
    const now = new Date();
    const slaFirstResponse = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const slaResolutionDeadline = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('ride_disputes')
      .insert({
        ride_id: validParams.ride_id,
        opened_by: validParams.opened_by,
        reason: validParams.reason,
        description: validParams.description,
        evidence_urls: validParams.evidence_urls ?? [],
        respondent_id: respondentId,
        sla_first_response_at: slaFirstResponse,
        sla_resolution_deadline: slaResolutionDeadline,
      })
      .select()
      .single();
    if (error) throw error;

    // Mark ride as disputed
    await supabase
      .from('rides')
      .update({ status: 'disputed' })
      .eq('id', validParams.ride_id);

    return data as RideDispute;
  },

  /**
   * Get the dispute for a specific ride (if any).
   */
  async getDisputeByRide(rideId: string): Promise<RideDispute | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_disputes')
      .select('*')
      .eq('ride_id', rideId)
      .maybeSingle();
    if (error) throw error;
    return data as RideDispute | null;
  },

  /**
   * Get all disputes for a user (as opener or respondent).
   */
  async getMyDisputes(userId: string): Promise<RideDispute[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_disputes')
      .select('*')
      .or(`opened_by.eq.${userId},respondent_id.eq.${userId}`)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as RideDispute[];
  },

  /**
   * Get all disputes (admin). Optional status filter.
   */
  async getAllDisputes(params?: {
    status?: DisputeStatus;
    limit?: number;
  }): Promise<RideDispute[]> {
    const supabase = getSupabaseClient();
    let query = supabase
      .from('ride_disputes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(params?.limit ?? 50);

    if (params?.status) {
      query = query.eq('status', params.status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data as RideDispute[];
  },

  /**
   * Respondent submits their side of the dispute.
   * Sets status to 'under_review'.
   */
  async respondToDispute(
    disputeId: string,
    userId: string,
    message: string,
    evidenceUrls?: string[],
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('ride_disputes')
      .update({
        respondent_message: message,
        respondent_evidence_urls: evidenceUrls ?? [],
        respondent_replied_at: new Date().toISOString(),
        status: 'under_review' as DisputeStatus,
      })
      .eq('id', disputeId)
      .eq('respondent_id', userId);
    if (error) throw error;

    // Notify the opener that the respondent replied
    const { data: dispute } = await supabase
      .from('ride_disputes')
      .select('opened_by')
      .eq('id', disputeId)
      .single();
    if (dispute?.opened_by) {
      notificationService
        .sendToUser(dispute.opened_by, 'Respuesta en tu disputa', 'El otro usuario respondió a tu disputa del viaje', 'system')
        .catch((err) => console.warn('[Dispute] notification failed:', err));
    }
  },

  /**
   * Admin updates dispute status and/or assignment.
   */
  async updateDisputeStatus(
    disputeId: string,
    updates: Partial<Pick<RideDispute, 'status' | 'assigned_to'>>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('ride_disputes')
      .update({ ...updates })
      .eq('id', disputeId);
    if (error) throw error;

    // Notify both parties about the status change
    const { data: dispute } = await supabase
      .from('ride_disputes')
      .select('opened_by, respondent_id')
      .eq('id', disputeId)
      .single();
    if (dispute) {
      const userIds = [dispute.opened_by, dispute.respondent_id].filter(Boolean) as string[];
      for (const uid of userIds) {
        notificationService
          .sendToUser(uid, 'Actualización de disputa', 'El estado de tu disputa ha cambiado', 'system')
          .catch((err) => console.warn('[Dispute] notification failed:', err));
      }
    }
  },

  /**
   * Resolve a dispute with optional refund.
   * For 'no_action', sets status to 'denied' without ledger transaction.
   * For refund resolutions, calls the process_dispute_refund RPC.
   */
  async resolveDispute(
    disputeId: string,
    adminId: string,
    resolution: DisputeResolution,
    refundAmountTrc: number,
    notes?: string,
  ): Promise<string | null> {
    const supabase = getSupabaseClient();

    // Helper: notify both parties after resolution
    const notifyBothParties = async () => {
      try {
        const { data: d } = await supabase
          .from('ride_disputes')
          .select('opened_by, respondent_id')
          .eq('id', disputeId)
          .single();
        if (!d) return;
        const userIds = [d.opened_by, d.respondent_id].filter(Boolean) as string[];
        for (const uid of userIds) {
          notificationService
            .sendToUser(uid, 'Disputa resuelta', 'Tu disputa ha sido resuelta. Revisa el resultado.', 'system')
            .catch((err) => console.warn('[Dispute] notification failed:', err));
        }
      } catch (err) {
        console.warn('[Dispute] notification failed:', err);
      }
    };

    if (resolution === 'no_action') {
      // Deny without refund
      const { error } = await supabase
        .from('ride_disputes')
        .update({
          status: 'denied' as DisputeStatus,
          resolution,
          resolution_notes: notes ?? null,
          refund_amount_trc: 0,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', disputeId);
      if (error) throw error;

      // Restore ride status
      const { data: dispute } = await supabase
        .from('ride_disputes')
        .select('ride_id')
        .eq('id', disputeId)
        .single();
      if (dispute) {
        await supabase
          .from('rides')
          .update({ status: 'completed' })
          .eq('id', dispute.ride_id)
          .eq('status', 'disputed');
      }

      notifyBothParties();
      return null;
    }

    // Process refund via RPC
    const { data, error } = await supabase.rpc('process_dispute_refund', {
      p_dispute_id: disputeId,
      p_admin_id: adminId,
      p_refund_amount_trc: refundAmountTrc,
      p_resolution: resolution,
      p_resolution_notes: notes ?? null,
    });
    if (error) throw error;
    notifyBothParties();
    return data as string;
  },

  /**
   * Add or update admin internal notes on a dispute.
   */
  async addAdminNotes(disputeId: string, notes: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('ride_disputes')
      .update({ admin_notes: notes })
      .eq('id', disputeId);
    if (error) throw error;
  },
};
