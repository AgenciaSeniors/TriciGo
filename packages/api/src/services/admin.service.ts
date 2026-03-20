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
  ExchangeRate,
  FeatureFlag,
  LedgerTransaction,
  PaymentIntent,
  PricingRule,
  Promotion,
  Ride,
  RidePricingSnapshot,
  RideTransition,
  ServiceTypeConfig,
  SurgeZone,
  DriverScoreEvent,
  User,
  Vehicle,
  WalletRechargeRequest,
  Zone,
  SelfieCheck,
} from '@tricigo/types';
import type { DriverStatus } from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { exchangeRateService } from './exchange-rate.service';
import { notificationService } from './notification.service';

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
   * Get all drivers with optional filters and pagination.
   */
  async getAllDrivers(
    page = 0,
    pageSize = 20,
    filters: {
      status?: string;
      search?: string;
      ratingMin?: number;
      vehicleType?: string;
    } = {},
  ): Promise<DriverProfileWithUser[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from('driver_profiles')
      .select('*, users!inner(full_name, phone, email), vehicles(type, plate_number)')
      .order('created_at', { ascending: false })
      .range(from, to);

    if (filters.status && filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }
    if (filters.search) {
      query = query.ilike('users.full_name', `%${filters.search}%`);
    }
    if (filters.ratingMin !== undefined && filters.ratingMin > 0) {
      query = query.gte('rating_avg', filters.ratingMin);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Client-side vehicle type filter (vehicles is a nested array)
    if (filters.vehicleType) {
      return (data as DriverProfileWithUser[]).filter((d) =>
        d.vehicles?.some((v: any) => v.type === filters.vehicleType),
      );
    }

    return data as DriverProfileWithUser[];
  },

  /**
   * Get full driver detail: profile + vehicle + documents.
   */
  async getDriverDetail(driverId: string) {
    const supabase = getSupabaseClient();

    const [profileRes, vehiclesRes, documentsRes, scoreEventsRes] = await Promise.all([
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
      supabase
        .from('driver_score_events')
        .select('*')
        .eq('driver_id', driverId)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    if (profileRes.error) throw profileRes.error;

    // Resolve user_id from profile for score events query
    const profile = profileRes.data as DriverProfile & {
      users: { full_name: string; phone: string; email: string | null };
    };

    return {
      profile,
      vehicle: (vehiclesRes.data?.[0] as Vehicle) ?? null,
      documents: (documentsRes.data as DriverDocument[]) ?? [],
      scoreEvents: (scoreEventsRes.data as DriverScoreEvent[]) ?? [],
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

    // Notify driver
    const { data: profile } = await supabase
      .from('driver_profiles')
      .select('user_id')
      .eq('id', driverId)
      .single();
    if (profile?.user_id) {
      await notificationService.sendToUser(
        profile.user_id,
        'Cuenta aprobada',
        'Tu cuenta de conductor ha sido aprobada. Ya puedes empezar a recibir viajes.',
        adminId,
        { type: 'driver_status', status: 'approved' },
      ).catch(() => {/* non-critical */});
    }
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

    // Notify driver
    const { data: rejProfile } = await supabase
      .from('driver_profiles')
      .select('user_id')
      .eq('id', driverId)
      .single();
    if (rejProfile?.user_id) {
      await notificationService.sendToUser(
        rejProfile.user_id,
        'Solicitud rechazada',
        `Tu solicitud de conductor fue rechazada. Razon: ${reason}`,
        adminId,
        { type: 'driver_status', status: 'rejected', reason },
      ).catch(() => {/* non-critical */});
    }
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

    // Notify driver
    const { data: susProfile } = await supabase
      .from('driver_profiles')
      .select('user_id')
      .eq('id', driverId)
      .single();
    if (susProfile?.user_id) {
      await notificationService.sendToUser(
        susProfile.user_id,
        'Cuenta suspendida',
        `Tu cuenta de conductor ha sido suspendida. Razon: ${reason}`,
        adminId,
        { type: 'driver_status', status: 'suspended', reason },
      ).catch(() => {/* non-critical */});
    }
  },

  /**
   * Get all users with pagination and optional filters.
   */
  async getUsers(
    page = 0,
    pageSize = 20,
    filters: {
      search?: string;
      role?: string;
      dateFrom?: string;
      dateTo?: string;
      isActive?: boolean;
    } = {},
  ): Promise<User[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to);

    if (filters.role && filters.role !== 'all') {
      query = query.eq('role', filters.role);
    }
    if (filters.search) {
      query = query.or(`full_name.ilike.%${filters.search}%,phone.ilike.%${filters.search}%`);
    }
    if (filters.dateFrom) {
      query = query.gte('created_at', filters.dateFrom);
    }
    if (filters.dateTo) {
      query = query.lt('created_at', filters.dateTo + 'T23:59:59');
    }
    if (filters.isActive !== undefined) {
      query = query.eq('is_active', filters.isActive);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data as User[];
  },

  /**
   * Get all rides with advanced filters.
   */
  async getRides(
    filters: {
      status?: string;
      serviceType?: string;
      paymentMethod?: string;
      dateFrom?: string;
      dateTo?: string;
      search?: string;
    } = {},
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
    if (filters.serviceType) {
      query = query.eq('service_type', filters.serviceType);
    }
    if (filters.paymentMethod) {
      query = query.eq('payment_method', filters.paymentMethod);
    }
    if (filters.dateFrom) {
      query = query.gte('created_at', filters.dateFrom);
    }
    if (filters.dateTo) {
      query = query.lt('created_at', filters.dateTo + 'T23:59:59');
    }
    if (filters.search) {
      query = query.or(`pickup_address.ilike.%${filters.search}%,dropoff_address.ilike.%${filters.search}%`);
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
   * Get admin action history with optional date range filter.
   */
  async getAdminActions(
    page = 0,
    pageSize = 50,
    filters: { dateFrom?: string; dateTo?: string } = {},
  ): Promise<AdminAction[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from('admin_actions')
      .select('*')
      .order('created_at', { ascending: false });

    if (filters.dateFrom) {
      query = query.gte('created_at', filters.dateFrom);
    }
    if (filters.dateTo) {
      // Add one day so the "to" date is inclusive
      const toDate = new Date(filters.dateTo);
      toDate.setDate(toDate.getDate() + 1);
      query = query.lt('created_at', toDate.toISOString().split('T')[0]);
    }

    const { data, error } = await query.range(from, to);
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
      'surge_threshold' | 'max_surge_multiplier' | 'is_active' |
      'time_window_start' | 'time_window_end' | 'day_of_week'
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
    > & {
      zone_id?: string | null;
      is_active?: boolean;
      time_window_start?: string | null;
      time_window_end?: string | null;
      day_of_week?: number[] | null;
    },
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('pricing_rules')
      .insert(rule);
    if (error) throw error;
  },

  async deletePricingRule(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('pricing_rules')
      .delete()
      .eq('id', id);
    if (error) throw error;
  },

  // ==================== WEATHER STATUS ====================

  async getWeatherStatus(): Promise<{
    condition: string;
    description: string;
    temp: number;
    multiplier: number;
    lastCheck: string | null;
    surgeActive: boolean;
  }> {
    const supabase = getSupabaseClient();

    // Get last weather check from platform_config
    const { data: configData } = await supabase
      .from('platform_config')
      .select('value')
      .eq('key', 'weather_last_check')
      .single();

    // Check if any weather surge is active
    const { data: activeSurges } = await supabase
      .from('surge_zones')
      .select('id, multiplier')
      .like('reason', 'weather_%')
      .eq('active', true)
      .limit(1);

    const surgeList = activeSurges ?? [];
    const surgeActive = surgeList.length > 0;
    const surgeMultiplier = surgeActive ? (surgeList[0]?.multiplier as number ?? 1.0) : 1.0;

    if (!configData?.value || configData.value === 'null') {
      return {
        condition: 'unknown',
        description: 'No data',
        temp: 0,
        multiplier: surgeMultiplier,
        lastCheck: null,
        surgeActive,
      };
    }

    try {
      const parsed = typeof configData.value === 'string'
        ? JSON.parse(configData.value)
        : configData.value;
      return {
        condition: parsed.condition ?? 'unknown',
        description: parsed.description ?? '',
        temp: parsed.temp ?? 0,
        multiplier: surgeMultiplier > 1.0 ? surgeMultiplier : (parsed.multiplier ?? 1.0),
        lastCheck: parsed.checked_at ?? null,
        surgeActive,
      };
    } catch {
      return {
        condition: 'unknown',
        description: 'Parse error',
        temp: 0,
        multiplier: surgeMultiplier,
        lastCheck: null,
        surgeActive,
      };
    }
  },

  // ==================== AUTO-ADMIN ====================

  /**
   * Get recent automated actions (system user).
   */
  async getRecentAutoActions(limit = 10): Promise<AdminAction[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('admin_actions')
      .select('*')
      .eq('admin_id', '00000000-0000-0000-0000-000000000001')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as AdminAction[];
  },

  // ==================== SURGE STATUS ====================

  async getSurgeStatusForZones(
    zones: { id: string; lat: number; lng: number }[],
  ): Promise<{ zone_id: string; zone_name: string; multiplier: number }[]> {
    const supabase = getSupabaseClient();
    const results: { zone_id: string; zone_name: string; multiplier: number }[] = [];
    for (const zone of zones) {
      try {
        const { data } = await supabase.rpc('calculate_dynamic_surge', {
          p_zone_id: zone.id,
          p_lat: zone.lat,
          p_lng: zone.lng,
          p_radius_m: 3000,
        });
        results.push({
          zone_id: zone.id,
          zone_name: '',
          multiplier: typeof data === 'number' ? data : 1.0,
        });
      } catch {
        results.push({ zone_id: zone.id, zone_name: '', multiplier: 1.0 });
      }
    }
    return results;
  },

  async getLiveMetrics(): Promise<{
    searching_rides: number;
    in_progress_rides: number;
    online_drivers: number;
  }> {
    const supabase = getSupabaseClient();

    const [searchingRes, inProgressRes, driversRes] = await Promise.all([
      supabase
        .from('rides')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'searching'),
      supabase
        .from('rides')
        .select('id', { count: 'exact', head: true })
        .in('status', ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress']),
      supabase
        .from('driver_profiles')
        .select('id', { count: 'exact', head: true })
        .eq('is_online', true),
    ]);

    return {
      searching_rides: searchingRes.count ?? 0,
      in_progress_rides: inProgressRes.count ?? 0,
      online_drivers: driversRes.count ?? 0,
    };
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
    adminId: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('promotions')
      .insert({ ...promo, created_by: adminId });
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

  // ==================== USER DETAIL ====================

  /**
   * Get full user detail: user + wallet + transfers.
   */
  async getUserDetail(userId: string) {
    const supabase = getSupabaseClient();

    const [userRes, walletRes, transfersRes, penaltiesRes] = await Promise.all([
      supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single(),
      supabase
        .from('wallet_accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('account_type', 'customer_cash')
        .maybeSingle(),
      supabase
        .from('wallet_transfers')
        .select('*')
        .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
        .order('created_at', { ascending: false })
        .limit(20),
      supabase
        .from('cancellation_penalties')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    if (userRes.error) throw userRes.error;

    return {
      user: userRes.data as User,
      wallet: walletRes.data as {
        id: string;
        balance: number;
        held_balance: number;
        is_active: boolean;
      } | null,
      transfers: (transfersRes.data ?? []) as Array<{
        id: string;
        from_user_id: string;
        to_user_id: string;
        amount: number;
        note: string | null;
        created_at: string;
      }>,
      penalties: (penaltiesRes.data ?? []) as Array<{
        id: string;
        ride_id: string | null;
        amount: number;
        reason: string | null;
        created_at: string;
      }>,
    };
  },

  /**
   * Update user level (admin override).
   */
  async updateUserLevel(
    userId: string,
    level: 'bronce' | 'plata' | 'oro',
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('users')
      .update({ level })
      .eq('id', userId);
    if (error) throw error;
  },

  /**
   * Toggle user active status (block/unblock).
   */
  async toggleUserActive(
    userId: string,
    isActive: boolean,
    adminId: string,
    reason?: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('users')
      .update({ is_active: isActive })
      .eq('id', userId);
    if (error) throw error;

    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: isActive ? 'unblock_user' : 'block_user',
      target_type: 'user',
      target_id: userId,
      reason: reason ?? null,
    });
  },

  // ==================== RIDE DETAIL ====================

  async getRideDetail(rideId: string) {
    const supabase = getSupabaseClient();

    const [rideRes, transitionsRes, pricingRes] = await Promise.all([
      supabase
        .from('rides')
        .select('*')
        .eq('id', rideId)
        .single(),
      supabase
        .from('ride_transitions')
        .select('*')
        .eq('ride_id', rideId)
        .order('created_at', { ascending: true }),
      supabase
        .from('ride_pricing_snapshots')
        .select('*')
        .eq('ride_id', rideId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (rideRes.error) throw rideRes.error;
    const ride = rideRes.data as Ride;

    // Fetch driver info if assigned
    let driverInfo: { name: string; phone: string } | null = null;
    if (ride.driver_id) {
      const { data: dp } = await supabase
        .from('driver_profiles')
        .select('user_id')
        .eq('id', ride.driver_id)
        .single();
      if (dp) {
        const { data: usr } = await supabase
          .from('users')
          .select('full_name, phone')
          .eq('id', dp.user_id)
          .single();
        if (usr) driverInfo = { name: usr.full_name, phone: usr.phone };
      }
    }

    // Fetch customer info
    let customerInfo: { name: string; phone: string } | null = null;
    const { data: cust } = await supabase
      .from('users')
      .select('full_name, phone')
      .eq('id', ride.customer_id)
      .single();
    if (cust) customerInfo = { name: cust.full_name, phone: cust.phone };

    return {
      ride,
      transitions: (transitionsRes.data as RideTransition[]) ?? [],
      pricing: (pricingRes.data as RidePricingSnapshot) ?? null,
      driverInfo,
      customerInfo,
    };
  },

  // ==================== WALLET RECHARGES ====================

  async getPendingRecharges(
    page = 0,
    pageSize = 20,
  ): Promise<(WalletRechargeRequest & { user_name: string })[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('wallet_recharge_requests')
      .select('*, users!inner(full_name)')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    return (data ?? []).map((row: Record<string, unknown>) => {
      const usr = row.users as Record<string, string> | undefined;
      return {
        ...(row as unknown as WalletRechargeRequest),
        user_name: usr?.full_name ?? 'Desconocido',
      };
    });
  },

  async processRecharge(
    rechargeId: string,
    adminId: string,
    approved: boolean,
    reason?: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();

    if (approved) {
      // Fetch the request
      const { data: req, error: reqErr } = await supabase
        .from('wallet_recharge_requests')
        .select('*')
        .eq('id', rechargeId)
        .eq('status', 'pending')
        .single();
      if (reqErr) throw reqErr;
      const request = req as WalletRechargeRequest;

      // Ensure wallet account
      const { data: accountId } = await supabase.rpc('ensure_wallet_account', {
        p_user_id: request.user_id,
        p_type: 'customer_cash',
      });

      // Get current balance
      const { data: acct } = await supabase
        .from('wallet_accounts')
        .select('balance')
        .eq('id', accountId)
        .single();
      const currentBalance = acct?.balance ?? 0;

      // Create ledger transaction
      const { data: txn } = await supabase
        .from('ledger_transactions')
        .insert({
          idempotency_key: `recharge:${rechargeId}`,
          type: 'recharge',
          status: 'posted',
          reference_type: 'recharge_request',
          reference_id: rechargeId,
          description: `Recarga wallet #${rechargeId.slice(0, 8)}`,
          created_by: adminId,
        })
        .select('id')
        .single();

      if (txn) {
        // Ledger entry
        await supabase.from('ledger_entries').insert({
          transaction_id: txn.id,
          account_id: accountId,
          amount: request.amount,
          balance_after: currentBalance + request.amount,
        });

        // Update wallet balance
        await supabase
          .from('wallet_accounts')
          .update({ balance: currentBalance + request.amount })
          .eq('id', accountId);
      }

      // Mark as approved
      await supabase
        .from('wallet_recharge_requests')
        .update({
          status: 'approved',
          processed_by: adminId,
          processed_at: new Date().toISOString(),
        })
        .eq('id', rechargeId);
    } else {
      // Reject
      await supabase
        .from('wallet_recharge_requests')
        .update({
          status: 'rejected',
          processed_by: adminId,
          processed_at: new Date().toISOString(),
          rejection_reason: reason ?? null,
        })
        .eq('id', rechargeId);
    }

    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: approved ? 'approve_recharge' : 'reject_recharge',
      target_type: 'wallet_recharge_request',
      target_id: rechargeId,
      reason: reason ?? null,
    });
  },

  // ==================== SURGE ZONES ====================

  async getSurgeZones(): Promise<SurgeZone[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('surge_zones')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as SurgeZone[];
  },

  async createSurgeZone(surge: {
    zone_id: string | null;
    multiplier: number;
    reason?: string;
    starts_at?: string;
    ends_at?: string;
  }): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('surge_zones')
      .insert({
        zone_id: surge.zone_id,
        multiplier: surge.multiplier,
        reason: surge.reason ?? null,
        active: true,
        starts_at: surge.starts_at ?? null,
        ends_at: surge.ends_at ?? null,
      });
    if (error) throw error;
  },

  async updateSurgeZone(
    id: string,
    updates: Partial<Pick<SurgeZone, 'multiplier' | 'active' | 'reason' | 'starts_at' | 'ends_at'>>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('surge_zones')
      .update(updates)
      .eq('id', id);
    if (error) throw error;
  },

  async deleteSurgeZone(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('surge_zones')
      .delete()
      .eq('id', id);
    if (error) throw error;
  },

  // ==================== PLATFORM CONFIG ====================

  /**
   * Get all platform config key/value pairs.
   */
  async getPlatformConfig(): Promise<Array<{ key: string; value: string }>> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('platform_config')
      .select('key, value')
      .order('key');
    if (error) throw error;
    return (data ?? []) as Array<{ key: string; value: string }>;
  },

  /**
   * Update a platform config value (upsert).
   */
  async updatePlatformConfig(key: string, value: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('platform_config')
      .upsert({ key, value }, { onConflict: 'key' });
    if (error) throw error;
  },

  // ==================== EXCHANGE RATE ====================

  /**
   * Get current exchange rate with metadata.
   */
  async getExchangeRate(): Promise<ExchangeRate> {
    return exchangeRateService.getCurrentRate();
  },

  /**
   * Get exchange rate history.
   */
  async getExchangeRateHistory(limit = 50): Promise<ExchangeRate[]> {
    return exchangeRateService.getRateHistory(limit);
  },

  /**
   * Set a manual exchange rate (admin override).
   */
  async setManualExchangeRate(usdCupRate: number): Promise<void> {
    return exchangeRateService.setManualRate(usdCupRate);
  },

  // ==================== DRIVER SCORE ====================

  /**
   * Manually adjust a driver's match score (admin action).
   */
  async adjustDriverScore(
    driverId: string,
    delta: number,
    reason?: string,
  ): Promise<number> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('update_driver_score', {
      p_driver_id: driverId,
      p_event_type: 'admin_adjustment',
      p_details: { delta, reason: reason ?? 'Admin adjustment' },
    });
    if (error) throw error;
    return typeof data === 'number' ? data : 50.0;
  },

  // ==================== TROPIPAY PAYMENT INTENTS ====================

  /**
   * Get TropiPay payment intents (admin view).
   */
  async getTropiPayIntents(
    page = 0,
    pageSize = 20,
    statusFilter?: string,
  ): Promise<(PaymentIntent & { user_name: string })[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from('payment_intents')
      .select('*, users!inner(full_name)')
      .order('created_at', { ascending: false })
      .range(from, to);

    if (statusFilter) {
      query = query.eq('status', statusFilter);
    }

    const { data, error } = await query;
    if (error) throw error;

    return (data ?? []).map((row: Record<string, unknown>) => ({
      ...(row as unknown as PaymentIntent),
      user_name: (row.users as { full_name: string } | null)?.full_name ?? 'Unknown',
    }));
  },

  // ==================== DOCUMENT VERIFICATION ====================

  /**
   * Verify or reject an individual driver document.
   */
  async verifyDocument(
    documentId: string,
    adminId: string,
    isVerified: boolean,
    notes?: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('driver_documents')
      .update({
        is_verified: isVerified,
        verified_by: adminId,
        verified_at: new Date().toISOString(),
        verification_notes: notes ?? null,
        rejection_reason: isVerified ? null : (notes ?? null),
      })
      .eq('id', documentId);
    if (error) throw error;

    // Log admin action
    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action_type: isVerified ? 'verify_document' : 'reject_document',
      target_type: 'driver_document',
      target_id: documentId,
      details: { notes },
    });
  },

  /**
   * Get selfie check history for a driver (admin view).
   */
  async getDriverSelfieChecks(
    driverId: string,
    limit = 20,
  ): Promise<SelfieCheck[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('selfie_checks')
      .select('*')
      .eq('driver_id', driverId)
      .order('requested_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data as SelfieCheck[];
  },

  // ==================== Analytics ====================

  /**
   * Get rides grouped by day for trend chart.
   */
  async getRidesByDay(daysBack = 30) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_rides_by_day', { p_days_back: daysBack });
    if (error) throw error;
    return (data ?? []) as { day: string; total: number; completed: number; canceled: number; revenue: number }[];
  },

  /**
   * Get rides grouped by service type.
   */
  async getRidesByServiceType(daysBack = 30) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_rides_by_service_type', { p_days_back: daysBack });
    if (error) throw error;
    return (data ?? []) as { service_type: string; count: number; revenue: number }[];
  },

  /**
   * Get rides grouped by payment method.
   */
  async getRidesByPaymentMethod(daysBack = 30) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_rides_by_payment_method', { p_days_back: daysBack });
    if (error) throw error;
    return (data ?? []) as { payment_method: string; count: number; revenue: number }[];
  },

  /**
   * Get average rides per hour for peak hours analysis.
   */
  async getPeakHours(daysBack = 30) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_peak_hours', { p_days_back: daysBack });
    if (error) throw error;
    return (data ?? []) as { hour: number; avg_rides: number }[];
  },

  /**
   * Get top drivers by completed rides.
   */
  async getTopDrivers(limit = 10) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_top_drivers', { p_limit: limit });
    if (error) throw error;
    return (data ?? []) as { driver_id: string; driver_name: string; rides_count: number; rating: number; revenue: number }[];
  },

  /**
   * Get driver utilization snapshot.
   */
  async getDriverUtilization() {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_driver_utilization');
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return (row ?? { online: 0, busy: 0, idle: 0, offline: 0 }) as { online: number; busy: number; idle: number; offline: number };
  },
};
