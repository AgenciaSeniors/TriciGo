import { getSupabaseClient } from '../client';

export interface HomeAnnouncement {
  id: string;
  title_es: string;
  body_es: string | null;
  image_url: string | null;
  cta_label_es: string | null;
  cta_url: string | null;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  city_id: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

export const announcementService = {
  /**
   * Active announcements for the rider home — RLS already filters out
   * inactive/expired rows. Optional cityId narrows to city-scoped rows
   * plus all-cities rows; when omitted, only all-cities rows are
   * returned to keep the home neutral.
   */
  async getActive(cityId?: string | null, limit = 6): Promise<HomeAnnouncement[]> {
    const supabase = getSupabaseClient();
    let query = supabase
      .from('home_announcements')
      .select('*')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit);
    query = cityId ? query.or(`city_id.is.null,city_id.eq.${cityId}`) : query.is('city_id', null);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as HomeAnnouncement[];
  },

  async getAll(page = 0, pageSize = 20): Promise<HomeAnnouncement[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('home_announcements')
      .select('*')
      .order('created_at', { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw error;
    return (data ?? []) as HomeAnnouncement[];
  },

  async getById(id: string): Promise<HomeAnnouncement | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('home_announcements')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data as HomeAnnouncement | null;
  },

  async create(
    payload: Omit<HomeAnnouncement, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HomeAnnouncement> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('home_announcements')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return data as HomeAnnouncement;
  },

  async update(id: string, updates: Partial<HomeAnnouncement>): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('home_announcements')
      .update(updates)
      .eq('id', id);
    if (error) throw error;
  },

  async setActive(id: string, isActive: boolean): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('home_announcements')
      .update({ is_active: isActive })
      .eq('id', id);
    if (error) throw error;
  },

  async remove(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('home_announcements')
      .delete()
      .eq('id', id);
    if (error) throw error;
  },
};
