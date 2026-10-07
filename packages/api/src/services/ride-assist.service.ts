// ============================================================
// TriciGo — support-assisted matching (migration 00628)
// The rider's "Pedir ayuda" and proposal card, and the admin's assist page.
// The server answers an expected refusal as `{ error: code }`; it comes back here as an
// AppError whose `code` is that string. A missing function (00628 not applied) is PGRST202.
// ============================================================

import { getSupabaseClient } from '../client';
import { AppError } from '../errors';

export type RideOfferStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'superseded';
export type ServiceProposalStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';
export type ServiceChangeMode = 'propose' | 'apply';
export type SupportOfferMode = 'created' | 'rearmed' | 'extended';

/** A row of the admin banner (admin_support_waiting_rides). */
export interface SupportWaitingRide {
  ride_id: string;
  code: string;
  waiting_since: string;
  wait_s: number;
  help_requested_at: string | null;
  service_type: string;
  estimated_fare_cup: number;
  pickup_address: string;
  dropoff_address: string;
  pending_offers: number;
  is_test: boolean;
}

/** The pending proposal a rider sees (get_my_ride_service_proposal). */
export interface ServiceProposal {
  id: string;
  ride_id: string;
  from_service_type: string;
  to_service_type: string;
  from_fare_cup: number;
  to_fare_cup: number;
  expires_at: string;
}

export interface RideAssistOffer {
  driver_profile_id: string;
  driver_name: string;
  status: RideOfferStatus;
  offered_at: string;
  expires_at: string;
  responded_at: string | null;
}

export interface RideAssistProposal {
  id: string;
  from_service_type: string;
  to_service_type: string;
  from_fare_cup: number;
  to_fare_cup: number;
  status: ServiceProposalStatus;
  expires_at: string;
  responded_at: string | null;
  created_at: string;
}

/** Everything the assist page shows about a ride (admin_ride_assist_context). */
export interface RideAssistContext {
  ride: {
    id: string;
    code: string;
    status: string;
    service_type: string;
    ride_mode: string;
    estimated_fare_cup: number;
    discount_amount_cup: number;
    payment_method: string;
    passenger_count: number;
    shared_ride: boolean;
    is_corporate: boolean;
    has_waypoints: boolean;
    pickup_address: string;
    dropoff_address: string;
    pickup_lat: number;
    pickup_lng: number;
    dropoff_lat: number;
    dropoff_lng: number;
    created_at: string;
    wait_s: number;
    customer_id: string;
    customer_name: string;
    customer_phone: string | null;
    customer_is_test: boolean;
  };
  help_requested_at: string | null;
  offers: RideAssistOffer[];
  proposal: RideAssistProposal | null;
}

/** A driver support can call or send the ride to (admin_ride_assist_candidates). */
export interface AssistCandidate {
  driver_profile_id: string;
  full_name: string;
  phone: string | null;
  vehicle_type: 'triciclo' | 'moto' | 'auto' | 'confort';
  vehicle_label: string;
  is_online: boolean;
  last_heartbeat_at: string | null;
  distance_m: number | null;
  busy_ride_id: string | null;
  can_afford: boolean;
  offer_status: RideOfferStatus | null;
  offer_expires_at: string | null;
}

/** The code the assist page shows as "not available yet". */
export const RIDE_ASSIST_UNAVAILABLE = 'ride_assist_unavailable';

interface RpcError {
  code?: string;
  message?: string;
}

function isMissingRpc(error: RpcError | null | undefined): boolean {
  return !!error && (error.code === 'PGRST202'
    || /could not find the function|not found in the schema cache/i.test(error.message ?? ''));
}

function unavailable(rpc: string): AppError {
  return new AppError(`${rpc} is not deployed yet (migration 00628)`, RIDE_ASSIST_UNAVAILABLE, 503);
}

/** `{ error: code }` from an RPC becomes an AppError carrying the code. */
function throwIfRefused(rpc: string, data: unknown): void {
  const code = (data as { error?: unknown } | null)?.error;
  if (typeof code === 'string' && code) {
    throw new AppError(`${rpc} refused: ${code}`, code, 409, data as Record<string, unknown>);
  }
}

/**
 * Whether a failed respondProposal means the proposal is over for the rider: it expired, a newer
 * one replaced it, it was answered elsewhere, the ride stopped searching, or the change can no
 * longer be applied (the type's minimum fare went up). The card should go. False for a network
 * or database error, which the rider can retry.
 */
export function isProposalGone(err: unknown): boolean {
  return err instanceof AppError && err.statusCode === 409;
}

export const rideAssistService = {
  /**
   * The rider's "Pedir ayuda": marks the ride and alerts support, once. Returns the ride code
   * for the WhatsApp message, or null if the server could not take the request. Never throws:
   * the caller opens WhatsApp either way.
   */
  async requestHelp(rideId: string): Promise<{ code: string } | null> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.rpc('request_ride_help', { p_ride_id: rideId });
      if (error) return null;
      const r = data as { success?: boolean; code?: string } | null;
      return r?.success && r.code ? { code: r.code } : null;
    } catch {
      return null;
    }
  },

  /** The rider's pending, unexpired proposal, or null (none, or the migration is missing). */
  async getPendingProposal(rideId: string): Promise<ServiceProposal | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_my_ride_service_proposal', { p_ride_id: rideId });
    if (error) {
      if (isMissingRpc(error)) return null;
      throw error;
    }
    return (data as ServiceProposal | null) ?? null;
  },

  /** The rider accepts or rejects a proposal. Refusals throw with the server's code. */
  async respondProposal(proposalId: string, accept: boolean): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('respond_ride_service_proposal', {
      p_proposal_id: proposalId,
      p_accept: accept,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('respond_ride_service_proposal');
      throw error;
    }
    throwIfRefused('respond_ride_service_proposal', data);
  },

  /** The admin banner's rides. None when the migration is missing; other errors throw. */
  async getWaitingRides(): Promise<SupportWaitingRide[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_support_waiting_rides');
    if (error) {
      if (isMissingRpc(error)) return [];
      throw error;
    }
    return (data ?? []) as SupportWaitingRide[];
  },

  async getAssistContext(rideId: string): Promise<RideAssistContext> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_ride_assist_context', { p_ride_id: rideId });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_ride_assist_context');
      throw error;
    }
    throwIfRefused('admin_ride_assist_context', data);
    return data as RideAssistContext;
  },

  /** Drivers for the ride's own type, or for `serviceType` when support considers another. */
  async getCandidates(rideId: string, serviceType?: string): Promise<AssistCandidate[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_ride_assist_candidates', {
      p_ride_id: rideId,
      p_service_type: serviceType ?? null,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_ride_assist_candidates');
      throw error;
    }
    return (data ?? []) as AssistCandidate[];
  },

  async offerToDriver(rideId: string, driverProfileId: string): Promise<{ mode: SupportOfferMode; expiresAt: string }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_offer_ride_to_driver', {
      p_ride_id: rideId,
      p_driver_profile_id: driverProfileId,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_offer_ride_to_driver');
      throw error;
    }
    throwIfRefused('admin_offer_ride_to_driver', data);
    const r = data as { mode: SupportOfferMode; expires_at: string };
    return { mode: r.mode, expiresAt: r.expires_at };
  },

  async assignToDriver(rideId: string, driverProfileId: string, reason: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_assign_ride_to_driver', {
      p_ride_id: rideId,
      p_driver_profile_id: driverProfileId,
      p_reason: reason,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_assign_ride_to_driver');
      throw error;
    }
    throwIfRefused('admin_assign_ride_to_driver', data);
  },

  /** Propose the type to the rider, or apply it with the rider's WhatsApp consent (`reason`). */
  async changeServiceType(
    rideId: string,
    serviceType: string,
    fareCup: number,
    mode: ServiceChangeMode,
    reason?: string,
  ): Promise<{ proposalId: string | null; expiresAt: string | null }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_change_ride_service', {
      p_ride_id: rideId,
      p_service_type: serviceType,
      p_fare_cup: fareCup,
      p_mode: mode,
      p_reason: reason ?? null,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_change_ride_service');
      throw error;
    }
    throwIfRefused('admin_change_ride_service', data);
    const r = data as { proposal_id?: string; expires_at?: string };
    return { proposalId: r.proposal_id ?? null, expiresAt: r.expires_at ?? null };
  },
};
