// ============================================================
// TriciGo — Admin Service
// Admin panel operations. Uses service role where needed.
// ============================================================

import type {
  AdminAction,
  AuditLog,
  DriverProfile,
  Ride,
  User,
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
    return data as {
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
  ): Promise<DriverProfile[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('driver_profiles')
      .select('*, users!inner(full_name, phone, email)')
      .eq('status', status)
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as DriverProfile[];
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
};
