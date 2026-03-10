// ============================================================
// TriciGo — Admin Service
// Admin panel operations. Uses service role where needed.
// ============================================================

import type {
  AdminAction,
  AuditLog,
  DriverDocument,
  DriverProfile,
  DriverProfileWithUser,
  FeatureFlag,
  LedgerTransaction,
  PricingRule,
  Promotion,
  Ride,
  ServiceTypeConfig,
  User,
  Vehicle,
  WalletRedemption,
  Zone,
} from '@tricigo/types';
import type { DriverStatus } from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const adminService = {
  /**
   * Get dashboard metrics.
   */
  async getDashboardMetrics() {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_admin_dashboard_metrics');
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return (row ?? {
      active_rides: 0,
      total_rides_today: 0,
      online_drivers: 0,
      total_revenue_today: 0,
      pending_verifications: 0,
      open_incidents: 0,
    }) as {
      active_rides: number;
      total_rides_today: number;
      online_drivers: number;
      total_revenue_today: number;
      pending_verifications: number;
      open_incidents: number;
    };
  },

  /**
   * Get drivers by verification status.
   */
  async getDriversByStatus(
    status: DriverStatus,
    page = 0,
    pageSize = 20,
  ): Promise<DriverProfileWithUser[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('driver_profiles')
      .select('*, users!inner(full_name, phone, email), vehicles(type, plate_number)')
      .eq('status', status)
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as DriverProfileWithUser[];
  },

  /**
   * Get all drivers (no status filter) with pagination.
   */
  async getAllDrivers(
    page = 0,
    pageSize = 20,
  ): Promise<DriverProfileWithUser[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('driver_profiles')
      .select('*, users!inner(full_name, phone, email), vehicles(type, plate_number)')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as DriverProfileWithUser[];
  },

  /**
   * Get full driver detail: profile + vehicle + documents.
   */
  async getDriverDetail(driverId: string) {
    const supabase = getSupabaseClient();

    const [profileRes, vehiclesRes, documentsRes] = await Promise.all([
      supabase
        .from('driver_profiles')
        .select('*, users!inner(full_name, phone, email)')
        .eq('id', driverId)
        .single(),
      supabase
        .from('vehicles')
        .select('*')
        .eq('driver_id', driverId)
        .eq('is_active', true)
        .limit(1),
      supabase
        .from('driver_documents')
        .select('*')
        .eq('driver_id', driverId)
        .order('uploaded_at', { ascending: false }),
    ]);

    if (profileRes.error) throw profileRes.error;

    return {
      profile: profileRes.data as DriverProfile & {
        users: { full_name: string; phone: string; email: string | null };
      },
      vehicle: (vehiclesRes.data?.[0] as Vehicle) ?? null,
      documents: (documentsRes.data as DriverDocument[]) ?? [],
    };
  },

  /**
   * Get a signed URL for a driver document in Storage.
   */
  async getDocumentUrl(storagePath: string): Promise<string> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage
      .from('driver-documents')
      .createSignedUrl(storagePath, 3600);
    if (error) throw error;
    return data.signedUrl;
  },

  /**
   * Approve a driver.
   */
  async approveDriver(
    driverId: string,
    adminId: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('driver_profiles')
      .update({
        status: 'approved' as DriverStatus,
        approved_at: new Date().toISOString(),
      })
      .eq('id', driverId);
    if (error) throw error;

    // Log admin action
    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: 'approve_driver',
      target_type: 'driver_profile',
      target_id: driverId,
    });
  },

  /**
   * Reject a driver with reason.
   */
  async rejectDriver(
    driverId: string,
    adminId: string,
    reason: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('driver_profiles')
      .update({ status: 'rejected' as DriverStatus })
      .eq('id', driverId);
    if (error) throw error;

    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: 'reject_driver',
      target_type: 'driver_profile',
      target_id: driverId,
      reason,
    });
  },

  /**
   * Suspend a driver.
   */
  async suspendDriver(
    driverId: string,
    adminId: string,
    reason: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('driver_profiles')
      .update({
        status: 'suspended' as DriverStatus,
        is_online: false,
        suspended_at: new Date().toISOString(),
        suspended_reason: reason,
      })
      .eq('id', driverId);
    if (error) throw error;

    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: 'suspend_driver',
      target_type: 'driver_profile',
      target_id: driverId,
      reason,
    });
  },

  /**
   * Get all users with pagination.
   */
  async getUsers(page = 0, pageSize = 20): Promise<User[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as User[];
  },

  /**
   * Get all rides with filters.
   */
  async getRides(
    filters: { status?: string } = {},
    page = 0,
    pageSize = 20,
  ): Promise<Ride[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from('rides')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to);

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data as Ride[];
  },

  /**
   * Get audit log entries.
   */
  async getAuditLog(page = 0, pageSize = 50): Promise<AuditLog[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as AuditLog[];
  },

  /**
   * Get admin action history.
   */
  async getAdminActions(
    page = 0,
    pageSize = 50,
  ): Promise<AdminAction[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('admin_actions')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as AdminAction[];
  },

  /**
   * Get wallet system stats for admin overview.
   */
  async getWalletStats() {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_admin_wallet_stats');
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return (row ?? {
      total_in_circulation: 0,
      pending_redemptions_count: 0,
      pending_redemptions_amount: 0,
    }) as {
      total_in_circulation: number;
      pending_redemptions_count: number;
      pending_redemptions_amount: number;
    };
  },

  /**
   * Get pending redemption requests with driver info.
   */
  async getPendingRedemptions(
    page = 0,
    pageSize = 20,
  ): Promise<(WalletRedemption & { driver_name: string })[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('wallet_redemptions')
      .select(`
        *,
        driver_profiles!inner(
          users!inner(full_name)
        )
      `)
      .eq('status', 'requested')
      .order('requested_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    return (data ?? []).map((row: Record<string, unknown>) => {
      const dp = row.driver_profiles as Record<string, unknown> | undefined;
      const usr = dp?.users as Record<string, string> | undefined;
      return {
        ...(row as unknown as WalletRedemption),
        driver_name: usr?.full_name ?? 'Desconocido',
      };
    });
  },

  /**
   * Approve or reject a redemption request.
   */
  async processRedemption(
    redemptionId: string,
    adminId: string,
    action: 'approved' | 'rejected',
    reason?: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();

    const updatePayload: Record<string, unknown> = {
      status: action,
      processed_at: new Date().toISOString(),
      processed_by: adminId,
    };

    if (action === 'rejected' && reason) {
      updatePayload.rejection_reason = reason;
    }

    const { error } = await supabase
      .from('wallet_redemptions')
      .update(updatePayload)
      .eq('id', redemptionId)
      .eq('status', 'requested');
    if (error) throw error;

    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: action === 'approved' ? 'approve_redemption' : 'reject_redemption',
      target_type: 'wallet_redemption',
      target_id: redemptionId,
      reason: reason ?? null,
    });
  },

  /**
   * Get all ledger transactions for admin view.
   */
  async getAdminTransactions(
    page = 0,
    pageSize = 20,
  ): Promise<LedgerTransaction[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('ledger_transactions')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as LedgerTransaction[];
  },

  // ==================== SERVICE TYPE CONFIGS ====================

  async getServiceTypeConfigs(): Promise<ServiceTypeConfig[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('service_type_configs')
      .select('*')
      .order('slug');
    if (error) throw error;
    return data as ServiceTypeConfig[];
  },

  async updateServiceTypeConfig(
    id: string,
    updates: Partial<Pick<ServiceTypeConfig,
      'name_es' | 'name_en' | 'base_fare_cup' | 'per_km_rate_cup' |
      'per_minute_rate_cup' | 'min_fare_cup' | 'max_passengers' | 'icon_name' | 'is_active'
    >>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('service_type_configs')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  },

  // ==================== PRICING RULES ====================

  async getPricingRules(page = 0, pageSize = 20): Promise<PricingRule[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from('pricing_rules')
      .select('*')
      .order('service_type')
      .range(from, to);
    if (error) throw error;
    return data as PricingRule[];
  },

  async updatePricingRule(
    id: string,
    updates: Partial<Pick<PricingRule,
      'base_fare_cup' | 'per_km_rate_cup' | 'per_minute_rate_cup' | 'min_fare_cup' |
      'surge_threshold' | 'max_surge_multiplier' | 'is_active'
    >>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('pricing_rules')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  },

  async createPricingRule(
    rule: Pick<PricingRule,
      'service_type' | 'base_fare_cup' | 'per_km_rate_cup' | 'per_minute_rate_cup' | 'min_fare_cup'
    > & { zone_id?: string | null; is_active?: boolean },
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('pricing_rules')
      .insert(rule);
    if (error) throw error;
  },

  // ==================== ZONES ====================

  async getZones(): Promise<Omit<Zone, 'boundary'>[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('zones')
      .select('id, name, type, surge_multiplier, is_active, created_at, updated_at')
      .order('name');
    if (error) throw error;
    return data as Omit<Zone, 'boundary'>[];
  },

  async updateZone(
    id: string,
    updates: Partial<Pick<Zone, 'name' | 'surge_multiplier' | 'is_active'>>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('zones')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  },

  // ==================== PROMOTIONS ====================

  async getPromotions(page = 0, pageSize = 20): Promise<Promotion[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from('promotions')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as Promotion[];
  },

  async createPromotion(
    promo: Pick<Promotion, 'code' | 'type' | 'is_active' | 'valid_from'> &
      Partial<Pick<Promotion, 'discount_percent' | 'discount_fixed_cup' | 'max_uses' | 'valid_until'>>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('promotions')
      .insert({ ...promo, created_by: 'admin-placeholder' });
    if (error) throw error;
  },

  async updatePromotion(
    id: string,
    updates: Partial<Pick<Promotion,
      'code' | 'type' | 'discount_percent' | 'discount_fixed_cup' |
      'max_uses' | 'is_active' | 'valid_from' | 'valid_until'
    >>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('promotions')
      .update(updates)
      .eq('id', id);
    if (error) throw error;
  },

  async deletePromotion(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('promotions')
      .delete()
      .eq('id', id)
      .eq('current_uses', 0);
    if (error) throw error;
  },

  // ==================== INCIDENTS ====================

  async getIncidents(
    status?: string,
    page = 0,
    pageSize = 20,
  ) {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from('incident_reports')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to);

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data as Record<string, unknown>[];
  },

  async updateIncidentStatus(
    id: string,
    status: string,
    adminId: string,
    notes?: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const updatePayload: Record<string, unknown> = {
      status,
      resolved_at: status === 'resolved' ? new Date().toISOString() : null,
    };

    const { error } = await supabase
      .from('incident_reports')
      .update(updatePayload)
      .eq('id', id);
    if (error) throw error;

    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: `incident_${status}`,
      target_type: 'incident_report',
      target_id: id,
      reason: notes ?? null,
    });
  },

  // ==================== FEATURE FLAGS ====================

  async getFeatureFlags(): Promise<FeatureFlag[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('feature_flags')
      .select('*')
      .order('key');
    if (error) throw error;
    return data as FeatureFlag[];
  },

  async updateFeatureFlag(
    id: string,
    updates: Partial<Pick<FeatureFlag, 'value' | 'description'>>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('feature_flags')
      .update(updates)
      .eq('id', id);
    if (error) throw error;
  },

  async createFeatureFlag(
    flag: Pick<FeatureFlag, 'key' | 'value' | 'description'>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('feature_flags')
      .insert(flag);
    if (error) throw error;
  },
};
