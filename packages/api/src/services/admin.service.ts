// ============================================================
// TriciGo — Admin Service
// Admin panel operations. Uses service role where needed.
// ============================================================

/** Escape special characters for PostgreSQL ILIKE patterns */
function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, '\\$&');
}

import type {
  AdminAction,
  AuditLog,
  DriverContract,
  DriverDocument,
  DriverProfile,
  DriverProfileWithUser,
  ExchangeRate,
  FeatureFlag,
  IncidentReport,
  LedgerTransaction,
  OnlineFleetDriver,
  PaymentIntent,
  PricingRule,
  Promotion,
  Ride,
  RidePricingSnapshot,
  RideTransition,
  ServiceTypeConfig,
  DriverScoreEvent,
  User,
  Vehicle,
  WalletRechargeRequest,
  WalletTransfer,
  Zone,
  SelfieCheck,
} from '@tricigo/types';
import type { DriverStatus } from '@tricigo/types';
import type { UserLevel } from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { exchangeRateService } from './exchange-rate.service';
import { notificationService } from './notification.service';

/**
 * USD-anchored pricing (migration 00441). When an admin edits a CUP rate, we
 * keep the USD anchor in sync (usd = cup / current_rate) so the nightly FX
 * recompute does NOT overwrite the admin's change. Maps each *_cup field
 * present in `updates` to its matching *_usd field.
 */
const CUP_TO_USD_FIELD: Record<string, string> = {
  base_fare_cup: 'base_fare_usd',
  per_km_rate_cup: 'per_km_rate_usd',
  per_minute_rate_cup: 'per_minute_rate_usd',
  min_fare_cup: 'min_fare_usd',
  per_wait_minute_rate_cup: 'per_wait_minute_rate_usd',
};

async function withUsdAnchors(updates: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cupFields = Object.keys(CUP_TO_USD_FIELD).filter(
    (f) => typeof updates[f] === 'number',
  );
  if (cupFields.length === 0) return updates;
  // Anchor against the live rate. If it can't be resolved, skip anchoring
  // rather than write a wrong USD value (the recompute keeps CUP as-is).
  let rate: number;
  try {
    rate = await exchangeRateService.getUsdCupRate();
  } catch {
    return updates;
  }
  if (!rate || rate <= 0) return updates;
  const out: Record<string, unknown> = { ...updates };
  for (const f of cupFields) {
    const usdField = CUP_TO_USD_FIELD[f];
    if (!usdField) continue;
    out[usdField] = (updates[f] as number) / rate;
  }
  return out;
}

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
   * Get all drivers awaiting admin review.
   * Matches the same criteria as the pending_verifications count in
   * get_admin_dashboard_metrics (status IN pending_verification, under_review).
   */
  async getPendingDrivers(
    page = 0,
    pageSize = 20,
  ): Promise<DriverProfileWithUser[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('driver_profiles')
      .select('*, users!inner(full_name, phone, email), vehicles(type, plate_number)')
      .in('status', ['pending_verification', 'under_review'])
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
      cityId?: string;
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
      query = query.ilike('users.full_name', `%${escapeLikePattern(filters.search)}%`);
    }
    if (filters.ratingMin !== undefined && filters.ratingMin > 0) {
      query = query.gte('rating_avg', filters.ratingMin);
    }
    if (filters.cityId) {
      query = query.eq('city_id', filters.cityId);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Client-side vehicle type filter (vehicles is a nested array)
    if (filters.vehicleType) {
      return (data as DriverProfileWithUser[]).filter((d) =>
        d.vehicles?.some((v: { type: string; plate_number: string }) => v.type === filters.vehicleType),
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
        .order('uploaded_at', { ascending: false })
        .limit(100),
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

    // Driver's LIVE work wallet (single-wallet model: 'tricicoin' — the
    // account the accept-ride commission gate checks, 00300/00340). The admin
    // adjusts THIS wallet via "Ajustar saldo TC", so surface its balance here
    // instead of leaving the admin to top up blind. Tolerate a driver who has
    // no wallet row yet (null).
    const walletRes = await supabase
      .from('wallet_accounts')
      .select('balance, held_balance, is_active, is_frozen, frozen_reason')
      .eq('user_id', profile.user_id)
      .eq('account_type', 'tricicoin')
      .maybeSingle();

    // Keep only the most recent document per document_type.
    // Drivers may re-upload (e.g. after rejection or earlier failures), which
    // leaves stale rows in the table. The admin UI should only see the latest.
    const allDocs = (documentsRes.data as DriverDocument[]) ?? [];
    const latestByType = new Map<string, DriverDocument>();
    for (const doc of allDocs) {
      // Rows come back ordered by uploaded_at DESC, so the first occurrence per type is the latest.
      if (!latestByType.has(doc.document_type)) {
        latestByType.set(doc.document_type, doc);
      }
    }

    return {
      profile,
      vehicle: (vehiclesRes.data?.[0] as Vehicle) ?? null,
      wallet: (walletRes.data as {
        balance: number;
        held_balance: number;
        is_active: boolean;
        is_frozen: boolean;
        frozen_reason: string | null;
      } | null) ?? null,
      documents: Array.from(latestByType.values()),
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
   * Driver T&C-acceptance contract (migration 00405). Returns null when
   * the driver has none yet — or when the migration hasn't been applied
   * (table missing), so the admin UI degrades silently.
   */
  async getDriverContract(driverId: string): Promise<DriverContract | null> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('driver_contracts')
        .select('*')
        .eq('driver_id', driverId)
        .maybeSingle();
      if (error) return null;
      return (data as DriverContract) ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Signed URL for a contract PDF in the private `driver-contracts`
   * bucket (admin storage RLS read; mirrors getReceiptSignedUrl).
   */
  async getContractSignedUrl(storagePath: string, expirySec = 3600): Promise<string> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage
      .from('driver-contracts')
      .createSignedUrl(storagePath, expirySec);
    if (error) throw error;
    return data.signedUrl;
  },

  /**
   * Generate (or force-regenerate) a driver's contract through the
   * generate-driver-contract EF. The EF authorizes the caller as
   * admin/super_admin from the session JWT, builds the ES/RO PDFs,
   * stores them and sends the emails. Returns the fresh contract row.
   */
  async generateDriverContract(driverId: string, force = false): Promise<DriverContract | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.functions.invoke('generate-driver-contract', {
      body: { driver_id: driverId, force },
    });
    if (error) throw error;
    const payload = data as { ok?: boolean; error?: string } | null;
    if (payload?.error) throw new Error(payload.error);
    return this.getDriverContract(driverId);
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
        '¡Tu cuenta de conductor ha sido aprobada. Ya puedes recibir viajes!',
        adminId,
        { type: 'driver_status', status: 'approved' },
      ).catch(err => console.warn('[Admin] Failed to notify driver:', err));
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
        'Tu solicitud de conductor no fue aprobada. Revisa tus documentos.',
        adminId,
        { type: 'driver_status', status: 'rejected', reason },
      ).catch(err => console.warn('[Admin] Failed to notify driver:', err));
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
        'Tu cuenta ha sido suspendida. Contacta soporte para más información.',
        adminId,
        { type: 'driver_status', status: 'suspended', reason },
      ).catch(err => console.warn('[Admin] Failed to notify driver:', err));
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
      const escaped = escapeLikePattern(filters.search);
      query = query.or(`full_name.ilike.%${escaped}%,phone.ilike.%${escaped}%`);
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
      cityId?: string;
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
      const escaped = escapeLikePattern(filters.search);
      query = query.or(`pickup_address.ilike.%${escaped}%,dropoff_address.ilike.%${escaped}%`);
    }
    if (filters.cityId) {
      query = query.eq('city_id', filters.cityId);
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
      .order('created_at', { ascending: false })
      .limit(pageSize);

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
   * Get platform earnings snapshot (balance + today/week/month + rate).
   *
   * Backed by the `get_platform_earnings` RPC (migration 00149). The
   * RPC returns a scalar record so Supabase serializes it as either a
   * 1-row array or a single tuple depending on client version —
   * normalize both shapes into a plain object so callers don't have
   * to care.
   */
  async getPlatformEarnings(): Promise<{
    platform_balance: number;
    earnings_today: number;
    earnings_this_week: number;
    earnings_this_month: number;
    commission_rate: number;
  }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_platform_earnings');
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return {
      platform_balance: Number(row?.platform_balance ?? 0),
      earnings_today: Number(row?.earnings_today ?? 0),
      earnings_this_week: Number(row?.earnings_this_week ?? 0),
      earnings_this_month: Number(row?.earnings_this_month ?? 0),
      commission_rate: Number(row?.commission_rate ?? 0.15),
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

    // PASS #3 ADMIN-LEDGER-AMOUNT: ledger_transactions has no amount column
    // (the amounts live in double-entry ledger_entries). Join them and surface
    // the gross transaction magnitude (max abs of the entries) so the admin
    // ledger shows a "Monto" and the CSV export is not blank.
    const { data, error } = await supabase
      .from('ledger_transactions')
      .select('*, ledger_entries(amount)')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return (data ?? []).map((tx: Record<string, unknown>) => {
      const entries = Array.isArray(tx.ledger_entries)
        ? (tx.ledger_entries as Array<{ amount: number | string }>)
        : [];
      // Gross magnitude moved = sum of the positive (credit) legs. For a
      // balanced double-entry txn this equals one leg's magnitude; for a
      // multi-leg txn (e.g. transfer + commission split) it reflects the full
      // amount instead of just the largest single leg (max-abs hid that).
      const amount = entries.reduce((sum, e) => {
        const a = Number(e.amount) || 0;
        return a > 0 ? sum + a : sum;
      }, 0);
      const { ledger_entries: _entries, ...rest } = tx;
      return { ...rest, amount } as LedgerTransaction;
    });
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
      'per_minute_rate_cup' | 'min_fare_cup' | 'per_wait_minute_rate_cup' |
      'max_passengers' | 'icon_name' | 'is_active'
    >>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    // 00441: keep USD anchors in sync so the FX recompute doesn't revert edits.
    const anchored = await withUsdAnchors(updates as Record<string, unknown>);
    const { error } = await supabase
      .from('service_type_configs')
      .update({ ...anchored, updated_at: new Date().toISOString() })
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
      'base_fare_cup' | 'per_km_rate_cup' | 'per_minute_rate_cup' | 'min_fare_cup' | 'is_active' |
      'time_window_start' | 'time_window_end' | 'day_of_week'
    >>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    // 00441: keep USD anchors in sync so the FX recompute doesn't revert edits.
    const anchored = await withUsdAnchors(updates as Record<string, unknown>);
    const { error } = await supabase
      .from('pricing_rules')
      .update({ ...anchored, updated_at: new Date().toISOString() })
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
    // 00441: anchor the new rule's CUP rates in USD on creation too.
    const anchored = await withUsdAnchors(rule as Record<string, unknown>);
    const { error } = await supabase
      .from('pricing_rules')
      .insert(anchored);
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

    // Weather surge is global now: the current multiplier + the last check
    // both live in platform_config (written by the sync-weather EF).
    const { data: rows } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', ['weather_last_check', 'weather_surge_multiplier']);
    const map = new Map((rows ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));

    const rawMult = map.get('weather_surge_multiplier');
    const parsedMult = typeof rawMult === 'number'
      ? rawMult
      : parseFloat(String(rawMult ?? '').replace(/"/g, ''));
    const multiplier = Number.isFinite(parsedMult) && parsedMult > 0 ? parsedMult : 1.0;
    const surgeActive = multiplier > 1.0;

    const rawCheck = map.get('weather_last_check');
    if (rawCheck == null || rawCheck === 'null') {
      return { condition: 'unknown', description: 'No data', temp: 0, multiplier, lastCheck: null, surgeActive };
    }

    try {
      const parsed = typeof rawCheck === 'string' ? JSON.parse(rawCheck) : rawCheck;
      return {
        condition: parsed.condition ?? 'unknown',
        description: parsed.description ?? '',
        temp: parsed.temp ?? 0,
        multiplier,
        lastCheck: parsed.checked_at ?? null,
        surgeActive,
      };
    } catch {
      return { condition: 'unknown', description: 'Parse error', temp: 0, multiplier, lastCheck: null, surgeActive };
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

  // ==================== CHURN PREDICTION ====================

  async getDriverChurnRisk(driverProfileId: string) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_churn_risk')
      .select('*')
      .eq('driver_profile_id', driverProfileId)
      .single();
    if (error) return null;
    return data;
  },

  async getHighChurnDrivers() {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_churn_risk')
      .select('*')
      .in('risk_level', ['high', 'medium'])
      .order('churn_risk_score', { ascending: false })
      .limit(20);
    if (error) throw error;
    return data ?? [];
  },

  // ==================== LIVE MAP ====================

  async getOnlineDrivers() {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_profiles')
      .select(`
        id,
        user_id,
        status,
        is_online,
        rating_avg,
        current_location,
        vehicles!inner(type)
      `)
      .eq('is_online', true)
      .eq('status', 'approved');
    if (error) throw error;

    // Parse PostGIS POINT to lat/lng + get user name
    const drivers = await Promise.all(
      (data ?? []).map(async (dp: {
        id: string;
        user_id: string;
        status: string;
        is_online: boolean;
        rating_avg: number | null;
        current_location: string | { coordinates: number[] } | null;
        vehicles?: { type: string }[];
      }) => {
        let latitude = 0;
        let longitude = 0;
        if (dp.current_location) {
          // PostGIS format: POINT(lng lat) or {x, y}
          const loc = dp.current_location;
          if (typeof loc === 'string') {
            const match = loc.match(/POINT\(([^ ]+) ([^ ]+)\)/);
            if (match) { longitude = parseFloat(match[1]!); latitude = parseFloat(match[2]!); }
          } else if (loc.coordinates) {
            longitude = loc.coordinates[0]!; latitude = loc.coordinates[1]!;
          }
        }

        // Get user name
        const { data: user } = await supabase
          .from('users')
          .select('full_name')
          .eq('id', dp.user_id)
          .single();

        return {
          id: dp.id,
          full_name: user?.full_name ?? 'Sin nombre',
          vehicle_type: dp.vehicles?.[0]?.type ?? 'auto',
          latitude,
          longitude,
          is_online: dp.is_online,
          rating_avg: dp.rating_avg ?? 0,
        };
      }),
    );

    return drivers.filter((d) => d.latitude !== 0 && d.longitude !== 0);
  },

  // ==================== ZONES ====================

  async getZones(): Promise<Omit<Zone, 'boundary'>[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('zones')
      .select('id, name, type, is_active, created_at, updated_at')
      .order('name');
    if (error) throw error;
    return data as Omit<Zone, 'boundary'>[];
  },

  async updateZone(
    id: string,
    updates: Partial<Pick<Zone, 'name' | 'is_active'>>,
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
      // Record WHO resolved it — incidents/[id] shows the resolver and the audit
      // trail needs it; was left null (resolved_at was set but resolved_by wasn't).
      resolved_by: status === 'resolved' ? adminId : null,
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

  /**
   * Full detail for a single incident: the report plus resolved display names
   * for the reporter / accused / resolver, and a lightweight ride summary.
   * Returns null when the incident does not exist (caller renders not-found).
   */
  async getIncidentDetail(id: string): Promise<{
    incident: IncidentReport;
    reporter: { name: string; phone: string } | null;
    against: { name: string; phone: string } | null;
    resolver: { name: string; phone: string } | null;
    ride: { id: string; status: string; pickup_address: string; dropoff_address: string } | null;
    review: { id: string; rating: number; comment: string | null; is_visible: boolean; created_at: string } | null;
  } | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('incident_reports')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    const incident = data as IncidentReport;

    // Resolve reporter / accused / resolver names in a single query.
    const userIds = [incident.reported_by, incident.against_user_id, incident.resolved_by]
      .filter((v): v is string => Boolean(v));
    const userMap: Record<string, { name: string; phone: string }> = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, full_name, phone')
        .in('id', userIds);
      for (const u of (users ?? []) as { id: string; full_name: string; phone: string }[]) {
        userMap[u.id] = { name: u.full_name, phone: u.phone };
      }
    }

    // Lightweight ride summary if the incident is tied to a ride.
    let ride: { id: string; status: string; pickup_address: string; dropoff_address: string } | null = null;
    if (incident.ride_id) {
      const { data: r } = await supabase
        .from('rides')
        .select('id, status, pickup_address, dropoff_address')
        .eq('id', incident.ride_id)
        .maybeSingle();
      if (r) ride = r as { id: string; status: string; pickup_address: string; dropoff_address: string };
    }

    // Reported review (when type='review_abuse') so the admin can see + moderate it.
    let review: { id: string; rating: number; comment: string | null; is_visible: boolean; created_at: string } | null = null;
    if (incident.type === 'review_abuse' && incident.review_id) {
      const { data: rev } = await supabase
        .from('reviews')
        .select('id, rating, comment, is_visible, created_at')
        .eq('id', incident.review_id)
        .maybeSingle();
      if (rev) review = rev as { id: string; rating: number; comment: string | null; is_visible: boolean; created_at: string };
    }

    return {
      incident,
      reporter: userMap[incident.reported_by] ?? null,
      against: incident.against_user_id ? (userMap[incident.against_user_id] ?? null) : null,
      resolver: incident.resolved_by ? (userMap[incident.resolved_by] ?? null) : null,
      ride,
      review,
    };
  },

  /**
   * Hide a review (is_visible=false) to moderate a reported abusive review.
   * Logs to admin_actions. RLS policy rev_admin allows admin UPDATE.
   */
  async adminHideReview(reviewId: string, adminId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('reviews').update({ is_visible: false }).eq('id', reviewId);
    if (error) throw error;
    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: 'hide_review',
      target_type: 'review',
      target_id: reviewId,
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

    const [userRes, walletRes, transfersRes, penaltiesRes, completedRidesRes] = await Promise.all([
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
      // Total spent = sum of completed-ride fares the user paid as a customer.
      // users.total_spent is a dead cache (the tier system maintains only
      // total_rides), so we derive it live instead of showing a stale figure.
      supabase
        .from('rides')
        .select('final_fare_cup')
        .eq('customer_id', userId)
        .eq('status', 'completed')
        .limit(10000),
    ]);

    if (userRes.error) throw userRes.error;

    const user = userRes.data as User;

    const totalSpentCup = ((completedRidesRes.data ?? []) as Array<{ final_fare_cup: number | null }>)
      .reduce((sum, r) => sum + (r.final_fare_cup ?? 0), 0);

    // Drivers also hold a LIVE work wallet ('tricicoin'). The adjust modal on
    // this page offers it for drivers, so fetch it too — otherwise a tricicoin
    // top-up is invisible here (only customer_cash is shown). Riders skip this.
    type WorkWallet = {
      balance: number;
      held_balance: number;
      is_active: boolean;
      is_frozen: boolean;
      frozen_reason: string | null;
    };
    let driverWallet: WorkWallet | null = null;
    if (user.role === 'driver') {
      const dwRes = await supabase
        .from('wallet_accounts')
        .select('balance, held_balance, is_active, is_frozen, frozen_reason')
        .eq('user_id', userId)
        .eq('account_type', 'tricicoin')
        .maybeSingle();
      driverWallet = (dwRes.data as WorkWallet | null) ?? null;
    }

    return {
      user,
      totalSpentCup,
      wallet: walletRes.data as {
        id: string;
        balance: number;
        held_balance: number;
        is_active: boolean;
      } | null,
      driverWallet,
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
    level: UserLevel,
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

    // wallet_recharge_requests has TWO FKs to users (user_id +
    // processed_by) so the implicit `users!inner(...)` returns
    // PostgREST 300 ("Multiple Choices") and the admin Billeteras →
    // Recargas pendientes tab shows "No pudimos cargar los datos".
    // Naming the FK explicitly picks the requester (user_id).
    const { data, error } = await supabase
      .from('wallet_recharge_requests')
      .select('*, users!wallet_recharge_requests_user_id_fkey!inner(full_name)')
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
      // BUG-116 fix: single atomic RPC instead of the previous 5-call
      // client-side flow that could leave the ledger credited while
      // the wallet balance stayed un-updated on partial failure.
      // `approve_wallet_recharge` is idempotent via
      // ledger_transactions.idempotency_key so retries are safe.
      const { data: txnId, error: rpcErr } = await supabase.rpc('approve_wallet_recharge', {
        p_request_id: rechargeId,
        p_admin_id: adminId,
      });
      if (rpcErr) throw rpcErr;

      // Fire-and-forget business email notification
      if (txnId) {
        void this.notifyBusinessMovement(txnId as string, 'recharge_approved')
          .catch(() => { /* silent */ });
      }
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

  // ==================== USER ROLE PROMOTION ====================

  /**
   * ADM-001: promote a user to a new role (admin → super_admin, or
   * customer → admin, etc). The only legitimate path for role
   * changes: requires super_admin caller, requires a reason (min
   * 10 chars), and logs to admin_actions for audit.
   *
   * Direct UPDATE of users.role is blocked by
   * tg_users_protect_admin_fields (mig 00291) for non-super-admins.
   *
   * @throws Error('forbidden: only super_admin ...') if caller is not super_admin
   * @throws Error('reason required (min 10 chars) ...') if reason too short
   * @throws Error('target user not found ...') if p_target_user_id invalid
   */
  async promoteUserRole(
    targetUserId: string,
    newRole: 'customer' | 'driver' | 'admin' | 'super_admin',
    reason: string,
  ): Promise<{
    success: boolean;
    target_user_id: string;
    old_role: string;
    new_role: string;
    no_change?: boolean;
    reason?: string;
  }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('promote_user_role', {
      p_target_user_id: targetUserId,
      p_new_role: newRole,
      p_reason: reason,
    });
    if (error) throw error;
    return data as Awaited<ReturnType<typeof this.promoteUserRole>>;
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

  // ==================== PAYMENT INTENTS ====================

  /**
   * Get payment intents (admin view).
   */
  async getPaymentIntents(
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
    // Server-side guard: rejection requires a reason. The UI already gates the
    // Reject button on `notes.trim()`, but a caller using the service directly
    // could leave `rejection_reason=NULL` — that state is indistinguishable
    // from "pending" in the `!is_verified && !!rejection_reason` rule the
    // driver app uses to render the red "Rechazado" badge.
    const trimmedNotes = notes?.trim();
    if (!isVerified && !trimmedNotes) {
      throw new Error('Rejection reason is required');
    }

    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('driver_documents')
      .update({
        is_verified: isVerified,
        verified_by: adminId,
        verified_at: new Date().toISOString(),
        verification_notes: trimmedNotes ?? null,
        rejection_reason: isVerified ? null : (trimmedNotes ?? null),
      })
      .eq('id', documentId);
    if (error) throw error;

    // Log admin action
    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: isVerified ? 'verify_document' : 'reject_document',
      target_type: 'driver_document',
      target_id: documentId,
      reason: notes ?? null,
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
  /**
   * 00339 (PR-MAP-1): returns all drivers online + approved with a
   * current location, plus their active ride if any. Used by
   * /admin/fleet map to render the live fleet overview. The RPC
   * gates internally for admin/super_admin role.
   */
  async getOnlineFleet(): Promise<OnlineFleetDriver[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_get_online_fleet');
    if (error) throw error;
    return (data ?? []) as OnlineFleetDriver[];
  },

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

  // ==================== WALLET OPS (admin adjustments) ====================

  /**
   * Credit or debit a user's wallet manually.
   * Calls admin_adjust_wallet RPC (migration 00133).
   *
   * @param targetUserId — user whose wallet is adjusted
   * @param accountType — any value of the wallet_account_type Postgres
   *   enum: 'customer_cash', 'driver_cash', 'driver_hold', 'driver_quota',
   *   'platform_revenue', 'platform_promotions', 'corporate_cash',
   *   'tricicoin'. The RPC validates the value server-side.
   * @param amountCup — positive = credit, negative = debit
   * @param reason — required, ≥3 chars
   */
  async adjustWallet(
    targetUserId: string,
    accountType:
      | 'customer_cash'
      | 'driver_cash'
      | 'driver_hold'
      | 'driver_quota'
      | 'platform_revenue'
      | 'platform_promotions'
      | 'corporate_cash'
      | 'tricicoin',
    amountCup: number,
    reason: string,
  ): Promise<{ transaction_id: string; account_id: string; amount_cup: number; new_balance: number }> {
    const supabase = getSupabaseClient();
    const { data: { user: admin } } = await supabase.auth.getUser();
    if (!admin) throw new Error('Admin not authenticated');

    const { data, error } = await supabase.rpc('admin_adjust_wallet', {
      p_target_user_id: targetUserId,
      p_account_type: accountType,
      p_amount_cup: amountCup,
      p_reason: reason,
      p_admin_user_id: admin.id,
    });
    if (error) throw error;

    // Fire-and-forget business email notification
    void this.notifyBusinessMovement(
      (data as { transaction_id: string }).transaction_id,
      'admin_adjustment',
    ).catch(() => { /* silent — non-critical */ });

    return data as { transaction_id: string; account_id: string; amount_cup: number; new_balance: number };
  },

  // ==================== GIFTS ("Regalo") ====================

  /**
   * Send a promotional gift credit to a user (00345 admin_send_gift).
   * One-sided credit (mirrors admin_adjust_wallet) recorded as a gift
   * with an admin_actions audit row.
   * @returns the new wallet_transfers id
   */
  async sendGift(toUserId: string, amount: number, note: string): Promise<string> {
    const supabase = getSupabaseClient();
    const { data: { user: admin } } = await supabase.auth.getUser();
    if (!admin) throw new Error('Admin not authenticated');

    const { data, error } = await supabase.rpc('admin_send_gift', {
      p_to_user_id: toUserId,
      p_amount: amount,
      p_note: note,
      p_admin_user_id: admin.id,
    });
    if (error) throw error;
    return data as string;
  },

  /**
   * Reverse a user-to-user gift via a compensating ledger transaction
   * (00345 admin_reverse_gift). The ledger is immutable, so this posts
   * a new offsetting transaction and marks the original reversed.
   * @returns the reversal's wallet_transfers id
   */
  async reverseGift(transferId: string): Promise<string> {
    const supabase = getSupabaseClient();
    const { data: { user: admin } } = await supabase.auth.getUser();
    if (!admin) throw new Error('Admin not authenticated');

    const { data, error } = await supabase.rpc('admin_reverse_gift', {
      p_transfer_id: transferId,
      p_admin_user_id: admin.id,
    });
    if (error) throw error;
    return data as string;
  },

  /**
   * List gifts for the admin audit view (newest first). Admin RLS on
   * wallet_transfers grants full read access (00009).
   */
  async listGifts(limit = 100, offset = 0): Promise<WalletTransfer[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('wallet_transfers')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return (data ?? []) as WalletTransfer[];
  },

  /**
   * Global gift KPIs for the admin Regalos panel (00346 get_gift_stats).
   */
  async getGiftStats(): Promise<{
    total_gifts: number;
    reversed: number;
    volume_cup: number;
    gifts_7d: number;
    distinct_senders: number;
  }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_gift_stats');
    if (error) throw error;
    const r = (data ?? {}) as Record<string, unknown>;
    return {
      total_gifts: Number(r.total_gifts ?? 0),
      reversed: Number(r.reversed ?? 0),
      volume_cup: Number(r.volume_cup ?? 0),
      gifts_7d: Number(r.gifts_7d ?? 0),
      distinct_senders: Number(r.distinct_senders ?? 0),
    };
  },

  /**
   * Freeze a user's wallet (blocks send_gift + other debits). Admin id
   * resolved from the session (mirrors adjustWallet). Delegates to the
   * existing freeze_wallet RPC (00013).
   */
  async freezeWallet(userId: string, reason: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { data: { user: admin } } = await supabase.auth.getUser();
    if (!admin) throw new Error('Admin not authenticated');
    const { error } = await supabase.rpc('freeze_wallet', {
      p_user_id: userId,
      p_reason: reason,
      p_admin_id: admin.id,
    });
    if (error) throw error;
  },

  /**
   * Unfreeze a user's wallet. Delegates to unfreeze_wallet (00013/00211).
   */
  async unfreezeWallet(userId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { data: { user: admin } } = await supabase.auth.getUser();
    if (!admin) throw new Error('Admin not authenticated');
    const { error } = await supabase.rpc('unfreeze_wallet', {
      p_user_id: userId,
      p_admin_id: admin.id,
    });
    if (error) throw error;
  },

  /**
   * Refund the commission charged on a specific ride.
   * Credits the driver's driver_cash balance with the commission amount.
   */
  async refundRideCommission(rideId: string, reason: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { data: { user: admin } } = await supabase.auth.getUser();
    if (!admin) throw new Error('Admin not authenticated');

    const { error } = await supabase.rpc('admin_refund_ride_commission', {
      p_ride_id: rideId,
      p_admin_user_id: admin.id,
      p_reason: reason,
    });
    if (error) throw error;
  },

  /**
   * Grant N grace trips (rides where commission is waived) to a driver.
   */
  async grantGraceTrips(driverUserId: string, trips: number, reason: string): Promise<{ trips_added: number; new_total: number }> {
    const supabase = getSupabaseClient();
    const { data: { user: admin } } = await supabase.auth.getUser();
    if (!admin) throw new Error('Admin not authenticated');

    const { data, error } = await supabase.rpc('admin_grant_grace_trips', {
      p_driver_user_id: driverUserId,
      p_trips: trips,
      p_admin_user_id: admin.id,
      p_reason: reason,
    });
    if (error) throw error;
    return data as { trips_added: number; new_total: number };
  },

  /**
   * Fire-and-forget business email notification for significant wallet movements.
   * Hits the notify-business-movement edge function. Fails silently.
   */
  async notifyBusinessMovement(
    transactionId: string,
    eventType: 'admin_adjustment' | 'recharge_approved',
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { data: { session } } = await supabase.auth.getSession();

    const supabaseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl
      ?? process.env.NEXT_PUBLIC_SUPABASE_URL
      ?? process.env.EXPO_PUBLIC_SUPABASE_URL
      ?? '';

    await fetch(`${supabaseUrl}/functions/v1/notify-business-movement`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token ?? ''}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
          ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
          ?? '',
      },
      body: JSON.stringify({ transaction_id: transactionId, event_type: eventType }),
    });
  },

  /**
   * Wallet v2 phase 2 part B: trigger the one-time "+5% bonus" push
   * notification for every user that received a migration bonus
   * (customer_cash + tricicoin + corporate_cash). Routed through
   * admin_send_wallet_v2_bonus_push() which is admin-gated and
   * uses get_service_role_key() server-side to call send-push.
   *
   * Idempotency is the admin's responsibility — calling this twice
   * sends two pushes per user. Confirm target count first via
   * `getMigrationBonusTargetCount()`.
   */
  async sendWalletV2BonusPush(): Promise<{ ok: boolean; pushes_dispatched: number; note: string }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_send_wallet_v2_bonus_push');
    if (error) throw error;
    return data as { ok: boolean; pushes_dispatched: number; note: string };
  },

  /** Wallet v2 phase 2 part B: dry count for the bonus push button. */
  async getMigrationBonusTargetCount(): Promise<number> {
    const supabase = getSupabaseClient();
    const { count, error } = await supabase
      .from('wallet_accounts')
      .select('user_id', { count: 'exact', head: true })
      .gt('migration_bonus_pct', 0)
      .not('balance_usd_cents', 'is', null)
      .not('user_id', 'is', null);
    if (error) throw error;
    return count ?? 0;
  },

  /**
   * Wallet v2 PR 9: list wallet recharge receipts for the admin
   * "Comprobantes emitidos" tab. RLS on wallet_receipts already
   * grants admins full read access via the
   * `wallet_receipts_admin_all` policy from migration 00235.
   *
   * Joined with the user's email/full_name for display.
   */
  async getRecentReceipts(page = 0, pageSize = 50, search?: string) {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;
    let query = supabase
      .from('wallet_receipts')
      .select(
        'id, receipt_no, payment_intent_id, user_id, usd_charged, fee_usd, net_usd, ' +
        'tc_credited, exchange_rate, cup_equivalent, card_brand, card_last4, ' +
        'pdf_storage_path, pdf_generated_at, email_sent_at_user, email_sent_at_admin, ' +
        'created_at, ' +
        'user:users!wallet_receipts_user_id_fkey(full_name, email, phone)',
      )
      .order('created_at', { ascending: false })
      .range(from, to);
    if (search && search.trim().length > 0) {
      query = query.or(`receipt_no.ilike.%${search.trim()}%,stripe_payment_intent_id.ilike.%${search.trim()}%`);
    }
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? [] as unknown[]) as unknown as Array<{
      id: string;
      receipt_no: string;
      payment_intent_id: string;
      user_id: string;
      usd_charged: string;
      fee_usd: string;
      net_usd: string;
      tc_credited: string;
      exchange_rate: string;
      cup_equivalent: string;
      card_brand: string | null;
      card_last4: string | null;
      pdf_storage_path: string | null;
      pdf_generated_at: string | null;
      email_sent_at_user: string | null;
      email_sent_at_admin: string | null;
      created_at: string;
      user: { full_name: string | null; email: string | null; phone: string | null } | null;
    }>;
  },

  /**
   * Wallet v2 PR 9: mint a signed URL for the receipts bucket so
   * admins can download PDFs from the admin tab. Storage RLS allows
   * admins via the `receipts_admin_read` policy.
   */
  async getReceiptSignedUrl(storagePath: string, expirySec = 3600): Promise<string> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage
      .from('receipts')
      .createSignedUrl(storagePath, expirySec);
    if (error) throw error;
    if (!data?.signedUrl) throw new Error('signed_url_missing');
    return data.signedUrl;
  },

  // Note (Wallet v2 PR 9 scope): regenerate-PDF action intentionally
  // omitted from this PR. The generate-recharge-receipt EF requires a
  // service_role apikey, which the admin browser can't expose. A
  // future PR will add an admin-gated RPC that pg_net.http_posts to
  // the EF using get_service_role_key() server-side. For now the
  // admin tab is read-only + download-existing-PDFs.
};
