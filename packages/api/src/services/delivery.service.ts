// ============================================================
// TriciGo — Delivery Service
// Handles delivery/messaging-specific operations.
// ============================================================

import { getSupabaseClient } from '../client';
import type { PackageCategory, VehicleType } from '@tricigo/types';

export interface DeliveryDetails {
  id: string;
  ride_id: string;
  package_description: string;
  recipient_name: string;
  recipient_phone: string;
  estimated_weight_kg: number | null;
  special_instructions: string | null;
  package_category: PackageCategory | null;
  package_length_cm: number | null;
  package_width_cm: number | null;
  package_height_cm: number | null;
  client_accompanies: boolean;
  delivery_vehicle_type: VehicleType | null;
  delivery_photo_url: string | null;
  created_at: string;
}

export interface CreateDeliveryParams {
  ride_id: string;
  package_description: string;
  recipient_name: string;
  recipient_phone: string;
  estimated_weight_kg?: number;
  special_instructions?: string;
  package_category?: PackageCategory;
  package_length_cm?: number;
  package_width_cm?: number;
  package_height_cm?: number;
  client_accompanies?: boolean;
  delivery_vehicle_type?: VehicleType;
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
        package_category: params.package_category ?? null,
        package_length_cm: params.package_length_cm ?? null,
        package_width_cm: params.package_width_cm ?? null,
        package_height_cm: params.package_height_cm ?? null,
        client_accompanies: params.client_accompanies ?? false,
        delivery_vehicle_type: params.delivery_vehicle_type ?? null,
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

  /**
   * Update delivery photo URL (called by driver at completion).
   */
  async updateDeliveryPhoto(rideId: string, photoUrl: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('delivery_details')
      .update({ delivery_photo_url: photoUrl })
      .eq('ride_id', rideId);

    if (error) throw new Error(error.message);
  },

  /**
   * Upload delivery photo to Supabase Storage and update delivery_details.
   * Called by the driver when completing a delivery ride.
   */
  async uploadDeliveryPhoto(rideId: string, localUri: string): Promise<string> {
    const supabase = getSupabaseClient();

    const fileName = `delivery-${rideId}-${Date.now()}.jpg`;
    const storagePath = `delivery-photos/${rideId}/${fileName}`;

    // Fetch the local file as blob
    const response = await fetch(localUri);
    const blob = await response.blob();

    const { error: uploadError } = await supabase.storage
      .from('driver-documents')
      .upload(storagePath, blob, { upsert: true });

    if (uploadError) throw new Error(uploadError.message);

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('driver-documents')
      .getPublicUrl(storagePath);

    const publicUrl = urlData.publicUrl;

    // Update delivery_details record
    const { error: updateError } = await supabase
      .from('delivery_details')
      .update({ delivery_photo_url: publicUrl })
      .eq('ride_id', rideId);

    if (updateError) throw new Error(updateError.message);

    return publicUrl;
  },
};
