// ============================================================
// TriciGo — Fraud Detection Service
// Fraud alerts, wallet freeze/unfreeze, signal checking.
// ============================================================

import type { FraudAlert } from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const fraudService = {
  /**
   * Get all fraud alerts, optionally filtered by resolution status.
   */
  async getFraudAlerts(params?: {
    resolved?: boolean;
    limit?: number;
  }): Promise<FraudAlert[]> {
    const supabase = getSupabaseClient();
    let query = supabase
      .from('fraud_alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(params?.limit ?? 50);

    if (params?.resolved !== undefined) {
      query = query.eq('resolved', params.resolved);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data as FraudAlert[];
  },

  /**
   * Get fraud alerts for a specific user.
   */
  async getUserAlerts(userId: string): Promise<FraudAlert[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('fraud_alerts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    return data as FraudAlert[];
  },

  /**
   * Resolve a fraud alert.
   */
  async resolveAlert(
    alertId: string,
    resolvedBy: string,
    note?: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('fraud_alerts')
      .update({
        resolved: true,
        resolved_by: resolvedBy,
        resolved_at: new Date().toISOString(),
        resolution_note: note ?? null,
      })
      .eq('id', alertId);
    if (error) throw error;
  },

  /**
   * Freeze a user's wallet.
   */
  async freezeWallet(
    userId: string,
    reason: string,
    adminId: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('freeze_wallet', {
      p_user_id: userId,
      p_reason: reason,
      p_admin_id: adminId,
    });
    if (error) throw error;
  },

  /**
   * Unfreeze a user's wallet.
   */
  async unfreezeWallet(
    userId: string,
    adminId: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('unfreeze_wallet', {
      p_user_id: userId,
      p_admin_id: adminId,
    });
    if (error) throw error;
  },

  /**
   * Manually trigger fraud check for a user.
   */
  async checkFraudSignals(userId: string): Promise<{
    alert_type: string;
    severity: string;
    details: Record<string, unknown>;
  }[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('check_fraud_signals', {
      p_user_id: userId,
    });
    if (error) throw error;
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    return rows;
  },
};
