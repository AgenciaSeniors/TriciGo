import type { TrustedContact } from '@tricigo/types';
import { getSupabaseClient } from '../client';

const MAX_CONTACTS = 5;

export const trustedContactService = {
  async getContacts(userId: string): Promise<TrustedContact[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('trusted_contacts')
      .select('*')
      .eq('user_id', userId)
      .order('is_emergency', { ascending: false })
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as TrustedContact[];
  },

  async addContact(params: {
    user_id: string;
    name: string;
    phone: string;
    relationship?: string;
    auto_share?: boolean;
    is_emergency?: boolean;
  }): Promise<TrustedContact> {
    const supabase = getSupabaseClient();

    // Check max contacts limit
    const { count, error: countError } = await supabase
      .from('trusted_contacts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', params.user_id);
    if (countError) throw countError;
    if ((count ?? 0) >= MAX_CONTACTS) {
      throw { message: 'Maximum contacts reached', code: 'MAX_CONTACTS' };
    }

    const { data, error } = await supabase
      .from('trusted_contacts')
      .insert({
        user_id: params.user_id,
        name: params.name,
        phone: params.phone,
        relationship: params.relationship || null,
        auto_share: params.auto_share ?? true,
        is_emergency: params.is_emergency ?? false,
      })
      .select()
      .single();
    if (error) throw error;
    return data as TrustedContact;
  },

  async updateContact(
    contactId: string,
    updates: Partial<Pick<TrustedContact, 'name' | 'phone' | 'relationship' | 'auto_share' | 'is_emergency'>>,
  ): Promise<TrustedContact> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('trusted_contacts')
      .update(updates)
      .eq('id', contactId)
      .select()
      .single();
    if (error) throw error;
    return data as TrustedContact;
  },

  async deleteContact(contactId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('trusted_contacts')
      .delete()
      .eq('id', contactId);
    if (error) throw error;
  },

  async getAutoShareContacts(userId: string): Promise<TrustedContact[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('trusted_contacts')
      .select('*')
      .eq('user_id', userId)
      .eq('auto_share', true)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as TrustedContact[];
  },

  /**
   * Broadcast an emergency SOS to every trusted contact with
   * `auto_share = true`. Calls the `broadcast-emergency` edge function
   * which proxies to `send-sms` (service-role only) on the server side
   * — the client never touches the service key directly.
   *
   * Rate-limited server-side at 1 broadcast / minute / user. Surfaces
   * `contacts_notified` so the UI can confirm "X contactos avisados".
   */
  async broadcastEmergency(params: {
    rideId?: string;
    latitude: number;
    longitude: number;
    driverName?: string | null;
    vehiclePlate?: string | null;
    riderName?: string | null;
    locale?: 'es' | 'en' | 'pt';
  }): Promise<{
    success: boolean;
    contacts_notified: number;
    contacts_total?: number;
    message?: string;
  }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.functions.invoke('broadcast-emergency', {
      body: {
        ride_id: params.rideId,
        latitude: params.latitude,
        longitude: params.longitude,
        driver_name: params.driverName,
        vehicle_plate: params.vehiclePlate,
        rider_name: params.riderName,
        locale: params.locale ?? 'es',
      },
    });
    if (error) throw error;
    return data as {
      success: boolean;
      contacts_notified: number;
      contacts_total?: number;
      message?: string;
    };
  },
};
