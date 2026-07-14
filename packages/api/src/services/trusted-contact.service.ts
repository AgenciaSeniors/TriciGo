import type { TrustedContact } from '@tricigo/types';
import { getSupabaseClient } from '../client';

const MAX_CONTACTS = 5;

/**
 * True when a write failed because the `email` column isn't applied yet
 * (mig 00496 pending). Lets the service retry without `email` so the app
 * keeps working when deployed ahead of the migration.
 */
function isMissingEmailColumn(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  const msg = e?.message ?? '';
  return e?.code === '42703' || /column.*email.*does not exist/i.test(msg) || /schema cache/i.test(msg);
}

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
    email?: string;
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

    const base = {
      user_id: params.user_id,
      name: params.name,
      phone: params.phone,
      relationship: params.relationship || null,
      auto_share: params.auto_share ?? true,
      is_emergency: params.is_emergency ?? false,
    };
    // Empty/whitespace email → null (SMS fallback, current behavior).
    const email = params.email?.trim() ? params.email.trim().toLowerCase() : null;

    let { data, error } = await supabase
      .from('trusted_contacts')
      .insert({ ...base, email })
      .select()
      .single();

    // Tolerate the email column not being applied yet (mig 00496).
    if (error && isMissingEmailColumn(error)) {
      ({ data, error } = await supabase
        .from('trusted_contacts')
        .insert(base)
        .select()
        .single());
    }
    if (error) throw error;
    return data as TrustedContact;
  },

  async updateContact(
    contactId: string,
    updates: Partial<Pick<TrustedContact, 'name' | 'phone' | 'email' | 'relationship' | 'auto_share' | 'is_emergency'>>,
  ): Promise<TrustedContact> {
    const supabase = getSupabaseClient();
    let { data, error } = await supabase
      .from('trusted_contacts')
      .update(updates)
      .eq('id', contactId)
      .select()
      .single();

    // Tolerate the email column not being applied yet (mig 00496).
    if (error && 'email' in updates && isMissingEmailColumn(error)) {
      const rest = { ...updates };
      delete rest.email;
      ({ data, error } = await supabase
        .from('trusted_contacts')
        .update(rest)
        .eq('id', contactId)
        .select()
        .single());
    }
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
