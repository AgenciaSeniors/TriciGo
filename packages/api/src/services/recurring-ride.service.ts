import type { RecurringRide, PaymentMethod, ServiceTypeSlug } from '@tricigo/types';
import { getSupabaseClient } from '../client';

const MAX_RECURRING = 10;

export interface CreateRecurringRideParams {
  user_id: string;
  pickup_latitude: number;
  pickup_longitude: number;
  pickup_address: string;
  dropoff_latitude: number;
  dropoff_longitude: number;
  dropoff_address: string;
  service_type: ServiceTypeSlug;
  payment_method: PaymentMethod;
  days_of_week: number[];
  time_of_day: string; // "HH:MM"
}

export const recurringRideService = {
  async getRecurringRides(userId: string): Promise<RecurringRide[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('recurring_rides')
      .select('*')
      .eq('customer_id', userId)
      .neq('status', 'deleted')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as RecurringRide[];
  },

  async createRecurringRide(params: CreateRecurringRideParams): Promise<RecurringRide> {
    const supabase = getSupabaseClient();

    // Check max limit
    const { count, error: countError } = await supabase
      .from('recurring_rides')
      .select('*', { count: 'exact', head: true })
      .eq('customer_id', params.user_id)
      .neq('status', 'deleted');
    if (countError) throw countError;
    if ((count ?? 0) >= MAX_RECURRING) {
      throw { message: 'Maximum recurring rides reached', code: 'MAX_RECURRING' };
    }

    // Compute next occurrence
    const { data: nextOccurrence, error: rpcError } = await supabase.rpc(
      'compute_next_occurrence',
      {
        p_days: params.days_of_week,
        p_time: params.time_of_day,
        p_tz: 'America/Havana',
      },
    );
    if (rpcError) throw rpcError;

    const { data, error } = await supabase
      .from('recurring_rides')
      .insert({
        customer_id: params.user_id,
        pickup_location: `POINT(${params.pickup_longitude} ${params.pickup_latitude})`,
        pickup_address: params.pickup_address,
        dropoff_location: `POINT(${params.dropoff_longitude} ${params.dropoff_latitude})`,
        dropoff_address: params.dropoff_address,
        service_type: params.service_type,
        payment_method: params.payment_method,
        days_of_week: params.days_of_week,
        time_of_day: params.time_of_day,
        timezone: 'America/Havana',
        next_occurrence_at: nextOccurrence,
      })
      .select()
      .single();
    if (error) throw error;
    return data as RecurringRide;
  },

  async updateRecurringRide(
    id: string,
    updates: Partial<Pick<CreateRecurringRideParams, 'days_of_week' | 'time_of_day' | 'service_type' | 'payment_method'>>,
  ): Promise<RecurringRide> {
    const supabase = getSupabaseClient();

    // If schedule changed, recompute next occurrence
    let nextOccurrence: string | null = null;
    if (updates.days_of_week || updates.time_of_day) {
      // Need current values for fields not being updated
      const { data: current, error: fetchError } = await supabase
        .from('recurring_rides')
        .select('days_of_week, time_of_day')
        .eq('id', id)
        .single();
      if (fetchError) throw fetchError;

      const days = updates.days_of_week ?? current.days_of_week;
      const time = updates.time_of_day ?? current.time_of_day;

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
      .from('recurring_rides')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as RecurringRide;
  },

  async pauseRecurringRide(id: string): Promise<RecurringRide> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('recurring_rides')
      .update({ status: 'paused', next_occurrence_at: null })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as RecurringRide;
  },

  async resumeRecurringRide(id: string): Promise<RecurringRide> {
    const supabase = getSupabaseClient();

    // Get current schedule to recompute
    const { data: current, error: fetchError } = await supabase
      .from('recurring_rides')
      .select('days_of_week, time_of_day')
      .eq('id', id)
      .single();
    if (fetchError) throw fetchError;

    const { data: nextOccurrence, error: rpcError } = await supabase.rpc(
      'compute_next_occurrence',
      {
        p_days: current.days_of_week,
        p_time: current.time_of_day,
        p_tz: 'America/Havana',
      },
    );
    if (rpcError) throw rpcError;

    const { data, error } = await supabase
      .from('recurring_rides')
      .update({ status: 'active', next_occurrence_at: nextOccurrence })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as RecurringRide;
  },

  async deleteRecurringRide(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('recurring_rides')
      .update({ status: 'deleted', next_occurrence_at: null })
      .eq('id', id);
    if (error) throw error;
  },
};
