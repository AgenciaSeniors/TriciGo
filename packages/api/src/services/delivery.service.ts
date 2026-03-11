// ============================================================
// TriciGo — Delivery Service
// Handles delivery/messaging-specific operations.
// ============================================================

import { getSupabaseClient } from '../client';

export interface DeliveryDetails {
  id: string;
  ride_id: string;
  package_description: string;
  recipient_name: string;
  recipient_phone: string;
  estimated_weight_kg: number | null;
  special_instructions: string | null;
  created_at: string;
}

export interface CreateDeliveryParams {
  ride_id: string;
  package_description: string;
  recipient_name: string;
  recipient_phone: string;
  estimated_weight_kg?: number;
  special_instructions?: string;
}

export const deliveryService = {
  /**
   * Create delivery details for a ride.
   */
  async createDeliveryDetails(params: CreateDeliveryParams): Promise<DeliveryDetails> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('delivery_details')
      .insert({
        ride_id: params.ride_id,
        package_description: params.package_description,
        recipient_name: params.recipient_name,
        recipient_phone: params.recipient_phone,
        estimated_weight_kg: params.estimated_weight_kg ?? null,
        special_instructions: params.special_instructions ?? null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data as DeliveryDetails;
  },

  /**
   * Get delivery details for a ride.
   */
  async getDeliveryDetails(rideId: string): Promise<DeliveryDetails | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('delivery_details')
      .select('*')
      .eq('ride_id', rideId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data as DeliveryDetails | null;
  },
};
