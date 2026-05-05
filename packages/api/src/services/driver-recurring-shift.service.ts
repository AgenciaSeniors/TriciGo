/**
 * driverRecurringShiftService — Phase 1 D5.
 *
 * CRUD for `driver_recurring_shifts` (migration 00259). Mirrors
 * `recurringRideService` shape so the two halves of the platform
 * share patterns and a future single recurring-engine refactor is
 * cheap.
 *
 * Each method tolerates the table being absent in prod (MCP guard
 * blocks the migration apply). Reads return `[]`; writes throw the
 * Postgres error so the UI can surface a "feature unavailable" toast
 * instead of crashing.
 */
import type { DriverRecurringShift } from '@tricigo/types';
import { getSupabaseClient } from '../client';

const MAX_SHIFTS = 10;

export interface CreateDriverRecurringShiftParams {
  driver_id: string;
  label?: string | null;
  days_of_week: number[];
  start_time: string; // "HH:MM"
  end_time: string;   // "HH:MM"
  preferred_zone_id?: string | null;
}

export interface UpdateDriverRecurringShiftParams {
  label?: string | null;
  days_of_week?: number[];
  start_time?: string;
  end_time?: string;
  preferred_zone_id?: string | null;
}

export const driverRecurringShiftService = {
  /**
   * Returns the driver's active + paused shifts (excludes 'deleted').
   * If the table doesn't exist yet (00259 not applied), returns `[]`
   * so the UI silently shows the empty state.
   */
  async getShifts(driverId: string): Promise<DriverRecurringShift[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_recurring_shifts')
      .select('*')
      .eq('driver_id', driverId)
      .neq('status', 'deleted')
      .order('created_at', { ascending: false });
    if (error) {
      // Table missing in prod yet — silent fallback. Any other error,
      // surface to the caller.
      if (
        error.code === '42P01' || // undefined_table
        error.message?.toLowerCase().includes('does not exist')
      ) {
        return [];
      }
      throw error;
    }
    return (data ?? []) as DriverRecurringShift[];
  },

  async getShift(id: string): Promise<DriverRecurringShift | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_recurring_shifts')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      if (error.code === '42P01' || error.message?.toLowerCase().includes('does not exist')) {
        return null;
      }
      throw error;
    }
    return (data ?? null) as DriverRecurringShift | null;
  },

  async createShift(params: CreateDriverRecurringShiftParams): Promise<DriverRecurringShift> {
    const supabase = getSupabaseClient();

    // Enforce per-driver cap to prevent runaway notifications. Mirrors
    // the rider-side recurringRideService.
    const { count, error: countError } = await supabase
      .from('driver_recurring_shifts')
      .select('*', { count: 'exact', head: true })
      .eq('driver_id', params.driver_id)
      .neq('status', 'deleted');
    if (countError && countError.code !== '42P01') throw countError;
    if ((count ?? 0) >= MAX_SHIFTS) {
      throw { message: 'Maximum recurring shifts reached', code: 'MAX_SHIFTS' };
    }

    // Reuse `compute_next_occurrence` from 00047 — it accepts any
    // (days, time, tz) tuple and returns the next ISO timestamp.
    const { data: nextOccurrence, error: rpcError } = await supabase.rpc(
      'compute_next_occurrence',
      {
        p_days: params.days_of_week,
        p_time: params.start_time,
        p_tz: 'America/Havana',
      },
    );
    if (rpcError) throw rpcError;

    const { data, error } = await supabase
      .from('driver_recurring_shifts')
      .insert({
        driver_id: params.driver_id,
        label: params.label ?? null,
        days_of_week: params.days_of_week,
        start_time: params.start_time,
        end_time: params.end_time,
        preferred_zone_id: params.preferred_zone_id ?? null,
        timezone: 'America/Havana',
        next_occurrence_at: nextOccurrence,
      })
      .select()
      .single();
    if (error) throw error;
    return data as DriverRecurringShift;
  },

  async updateShift(
    id: string,
    updates: UpdateDriverRecurringShiftParams,
  ): Promise<DriverRecurringShift> {
    const supabase = getSupabaseClient();

    // If the schedule changed, recompute next_occurrence_at the same
    // way recurringRideService does.
    let nextOccurrence: string | null = null;
    if (updates.days_of_week || updates.start_time) {
      const { data: current, error: fetchError } = await supabase
        .from('driver_recurring_shifts')
        .select('days_of_week, start_time')
        .eq('id', id)
        .single();
      if (fetchError) throw fetchError;

      const days = updates.days_of_week ?? current.days_of_week;
      const time = updates.start_time ?? current.start_time;
      const { data: rpcResult, error: rpcError } = await supabase.rpc(
        'compute_next_occurrence',
        { p_days: days, p_time: time, p_tz: 'America/Havana' },
      );
      if (rpcError) throw rpcError;
      nextOccurrence = rpcResult;
    }

    const updatePayload: Record<string, unknown> = { ...updates };
    if (nextOccurrence !== null) {
      updatePayload.next_occurrence_at = nextOccurrence;
    }

    const { data, error } = await supabase
      .from('driver_recurring_shifts')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as DriverRecurringShift;
  },

  async pauseShift(id: string): Promise<DriverRecurringShift> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_recurring_shifts')
      .update({ status: 'paused', next_occurrence_at: null })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as DriverRecurringShift;
  },

  async resumeShift(id: string): Promise<DriverRecurringShift> {
    const supabase = getSupabaseClient();

    const { data: current, error: fetchError } = await supabase
      .from('driver_recurring_shifts')
      .select('days_of_week, start_time')
      .eq('id', id)
      .single();
    if (fetchError) throw fetchError;

    const { data: nextOccurrence, error: rpcError } = await supabase.rpc(
      'compute_next_occurrence',
      {
        p_days: current.days_of_week,
        p_time: current.start_time,
        p_tz: 'America/Havana',
      },
    );
    if (rpcError) throw rpcError;

    const { data, error } = await supabase
      .from('driver_recurring_shifts')
      .update({ status: 'active', next_occurrence_at: nextOccurrence })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as DriverRecurringShift;
  },

  async deleteShift(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('driver_recurring_shifts')
      .update({ status: 'deleted', next_occurrence_at: null })
      .eq('id', id);
    if (error) throw error;
  },
};
