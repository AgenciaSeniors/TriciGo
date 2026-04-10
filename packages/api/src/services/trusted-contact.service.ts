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
};
