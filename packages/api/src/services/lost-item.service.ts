import { getSupabaseClient } from '../client';
import type { LostItem, LostItemStatus, LostItemCategory } from '@tricigo/types';

export const lostItemService = {
  /**
   * Rider reports a lost item for a completed ride.
   */
  async reportLostItem(params: {
    ride_id: string;
    reporter_id: string;
    driver_id: string;
    description: string;
    category: LostItemCategory;
    photo_urls?: string[];
  }): Promise<LostItem> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('lost_items')
      .insert({
        ride_id: params.ride_id,
        reporter_id: params.reporter_id,
        driver_id: params.driver_id,
        description: params.description,
        category: params.category,
        photo_urls: params.photo_urls ?? [],
      })
      .select()
      .single();
    if (error) throw error;
    return data as LostItem;
  },

  /**
   * Get lost item report for a specific ride.
   */
  async getLostItemByRide(rideId: string): Promise<LostItem | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('lost_items')
      .select('*')
      .eq('ride_id', rideId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as LostItem | null;
  },

  /**
   * Get all lost items for a user (as reporter or driver).
   */
  async getMyLostItems(userId: string): Promise<LostItem[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('lost_items')
      .select('*')
      .or(`reporter_id.eq.${userId},driver_id.eq.${userId}`)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as LostItem[];
  },

  /**
   * Driver responds to a lost item report (found or not found).
   */
  async driverRespond(
    lostItemId: string,
    driverId: string,
    found: boolean,
    response?: string,
  ): Promise<LostItem> {
    const supabase = getSupabaseClient();
    const updates: Record<string, unknown> = {
      driver_found: found,
      status: found ? 'found' : 'not_found',
    };
    if (response) {
      updates.driver_response = response;
    }

    const { data, error } = await supabase
      .from('lost_items')
      .update(updates)
      .eq('id', lostItemId)
      .eq('driver_id', driverId)
      .select()
      .single();
    if (error) throw error;
    return data as LostItem;
  },

  /**
   * Arrange return of a found item.
   */
  async arrangeReturn(
    lostItemId: string,
    params: {
      return_fee_cup?: number;
      return_location?: string;
      return_notes?: string;
    },
  ): Promise<LostItem> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('lost_items')
      .update({
        status: 'return_arranged',
        return_fee_cup: params.return_fee_cup ?? null,
        return_location: params.return_location ?? null,
        return_notes: params.return_notes ?? null,
      })
      .eq('id', lostItemId)
      .select()
      .single();
    if (error) throw error;
    return data as LostItem;
  },

  /**
   * Mark item as returned.
   */
  async markReturned(lostItemId: string, resolvedBy: string): Promise<LostItem> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('lost_items')
      .update({
        status: 'returned',
        resolved_by: resolvedBy,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', lostItemId)
      .select()
      .single();
    if (error) throw error;
    return data as LostItem;
  },

  /**
   * Close a lost item case (admin or when not found / abandoned).
   */
  async closeLostItem(
    lostItemId: string,
    resolvedBy: string,
    adminNotes?: string,
  ): Promise<LostItem> {
    const supabase = getSupabaseClient();
    const updates: Record<string, unknown> = {
      status: 'closed',
      resolved_by: resolvedBy,
      resolved_at: new Date().toISOString(),
    };
    if (adminNotes) {
      updates.admin_notes = adminNotes;
    }

    const { data, error } = await supabase
      .from('lost_items')
      .update(updates)
      .eq('id', lostItemId)
      .select()
      .single();
    if (error) throw error;
    return data as LostItem;
  },

  /**
   * Get all lost items (admin). Optional status filter.
   */
  async getAllLostItems(options: {
    status?: LostItemStatus;
    limit?: number;
  } = {}): Promise<LostItem[]> {
    const supabase = getSupabaseClient();
    const { status, limit = 100 } = options;

    let query = supabase
      .from('lost_items')
      .select('*');

    if (status) {
      query = query.eq('status', status);
    }

    query = query
      .order('created_at', { ascending: false })
      .limit(limit);

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as LostItem[];
  },

  /**
   * Add admin notes to a lost item case.
   */
  async addAdminNotes(lostItemId: string, notes: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('lost_items')
      .update({ admin_notes: notes })
      .eq('id', lostItemId);
    if (error) throw error;
  },
};
