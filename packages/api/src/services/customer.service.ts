import type { CustomerProfile } from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const customerService = {
  async getProfile(userId: string): Promise<CustomerProfile | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('customer_profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    return data as CustomerProfile | null;
  },

  async createProfile(userId: string): Promise<CustomerProfile> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('customer_profiles')
      .insert({
        user_id: userId,
        default_payment_method: 'cash',
        saved_locations: [],
        emergency_contact: null,
      })
      .select()
      .single();
    if (error) throw error;
    return data as CustomerProfile;
  },

  async updateProfile(
    profileId: string,
    updates: Partial<Pick<CustomerProfile, 'default_payment_method' | 'saved_locations' | 'emergency_contact' | 'ride_preferences'>>,
  ): Promise<CustomerProfile> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('customer_profiles')
      .update(updates)
      .eq('id', profileId)
      .select()
      .single();
    if (error) throw error;
    return data as CustomerProfile;
  },

  async ensureProfile(userId: string): Promise<CustomerProfile> {
    const existing = await customerService.getProfile(userId);
    if (existing) return existing;
    return customerService.createProfile(userId);
  },
};
