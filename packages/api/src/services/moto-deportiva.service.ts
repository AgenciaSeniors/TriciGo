import { getSupabaseClient } from '../client';
import { AppError } from '../errors';
import { parseMotoDeportivaStatus, type MotoDeportivaStatus } from '@tricigo/utils';

export interface MotoDeportivaPilot { driver_profile_id: string; full_name: string | null; is_online: boolean; status: string }
export interface MotoDeportivaOverview {
  active: boolean; status: string; waitlist_count: number; last_notice_at: string | null; pilots: MotoDeportivaPilot[];
}
export interface MotoDeportivaMetrics {
  days: number; subscribers_now: number; subscribers_new: number; notices_sent: number; people_notified: number;
  requests: number; completed: number; canceled: number; switched_to_moto: number; revenue_cup: number;
  first_ride_people: number; pilot_hours_online: number;
}
export interface MotoDeportivaSubscriber {
  user_id: string; full_name: string | null; phone: string | null; subscribed_at: string; notified_at: string | null;
}

function rpcResult<T>(data: unknown, error: { message: string } | null): T {
  if (error) throw new AppError(error.message, 'MOTO_DEPORTIVA_FAILED', 500);
  const d = data as { error?: string } | null;
  if (d && typeof d === 'object' && typeof d.error === 'string') {
    throw new AppError(d.error, `MOTO_DEPORTIVA_${d.error.toUpperCase()}`, 400);
  }
  return data as T;
}

export const motoDeportivaService = {
  /** null when the migration is not applied or the call fails: the apps hide the card. */
  async getStatus(): Promise<MotoDeportivaStatus | null> {
    const { data, error } = await getSupabaseClient().rpc('get_moto_deportiva_status');
    if (error) return null;
    return parseMotoDeportivaStatus(data);
  },
  async setWaitlist(join: boolean): Promise<boolean> {
    const { data, error } = await getSupabaseClient().rpc('set_moto_deportiva_waitlist', { p_join: join });
    return rpcResult<{ waiting: boolean }>(data, error).waiting;
  },
  async overview(): Promise<MotoDeportivaOverview> {
    const { data, error } = await getSupabaseClient().rpc('admin_moto_deportiva_overview');
    return rpcResult<MotoDeportivaOverview>(data, error);
  },
  async subscribers(): Promise<MotoDeportivaSubscriber[]> {
    const { data, error } = await getSupabaseClient().rpc('admin_moto_deportiva_subscribers');
    return rpcResult<{ subscribers: MotoDeportivaSubscriber[] }>(data, error).subscribers;
  },
  async removeSubscriber(userId: string): Promise<void> {
    const { data, error } = await getSupabaseClient().rpc('admin_remove_moto_deportiva_subscriber', { p_user_id: userId });
    rpcResult(data, error);
  },
  async setActive(active: boolean): Promise<{ notified: number }> {
    const { data, error } = await getSupabaseClient().rpc('admin_set_moto_deportiva', { p_active: active });
    return rpcResult<{ notified: number }>(data, error);
  },
  async metrics(days = 30): Promise<MotoDeportivaMetrics> {
    const { data, error } = await getSupabaseClient().rpc('admin_moto_deportiva_metrics', { p_days: days });
    return rpcResult<MotoDeportivaMetrics>(data, error);
  },
  async addPilot(phone: string): Promise<void> {
    const { data, error } = await getSupabaseClient().rpc('admin_add_moto_deportiva_pilot', { p_phone: phone });
    rpcResult(data, error);
  },
  async removePilot(driverProfileId: string): Promise<void> {
    const { data, error } = await getSupabaseClient().rpc('admin_remove_moto_deportiva_pilot', { p_driver_profile_id: driverProfileId });
    rpcResult(data, error);
  },
};
