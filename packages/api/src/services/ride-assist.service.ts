// ============================================================
// TriciGo — support-assisted matching (migrations 00628 and 00660)
// The rider's "Pedir ayuda" and proposal card, and the admin's assist page: a searching ride
// (00628) and a ride that already has a driver (00660).
// The server answers an expected refusal as `{ error: code }`; it comes back here as an
// AppError whose `code` is that string. A missing function (migration not applied) is PGRST202.
// ============================================================

import type { VehicleType } from '@tricigo/types';
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
  /**
   * Seconds until it expires by the SERVER's clock, >= 0, as of the response. Absent on a server
   * that predates it. The cards count down from this, starting at `received_at_ms`, and use
   * `expires_at` against the phone's clock only when it is missing: a phone a few minutes off
   * would otherwise hide a fresh proposal, or keep an expired one on screen.
   */
  expires_in_s?: number;
  /** Date.now() when the response arrived, where `expires_in_s` starts counting. Set by getPendingProposal, not by the server. */
  received_at_ms: number;
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
  vehicle_type: VehicleType;
  vehicle_label: string;
  is_online: boolean;
  last_heartbeat_at: string | null;
  distance_m: number | null;
  busy_ride_id: string | null;
  can_afford: boolean;
  offer_status: RideOfferStatus | null;
  offer_expires_at: string | null;
}

/** An action support can take on an active ride (00660). */
export type ActiveRideAction = 'release' | 'advance' | 'complete';

/** What completing the ride would charge (00660 _active_ride_charge_preview). */
export interface ActiveRideChargePreview {
  agreed_cup: number;
  discount_cup: number;
  wait_minutes: number;
  billable_minutes: number;
  wait_cup: number;
  insurance_cup: number;
  is_corporate: boolean;
  total_cup: number;
}

/** Everything the assist page shows for a ride that already has a driver (admin_active_ride_context). */
export interface ActiveRideContext {
  ride: {
    id: string;
    code: string;
    status: string;
    service_type: string;
    payment_method: string;
    is_corporate: boolean;
    pickup_address: string;
    dropoff_address: string;
    created_at: string;
    accepted_at: string | null;
    driver_arrived_at: string | null;
    pickup_at: string | null;
    scheduled_at: string | null;
    estimated_fare_cup: number;
    customer_id: string;
    customer_name: string | null;
    customer_phone: string | null;
    customer_is_test: boolean;
  };
  driver: {
    driver_profile_id: string;
    full_name: string | null;
    phone: string | null;
    is_online: boolean;
    last_heartbeat_at: string | null;
    vehicle_label: string | null;
    /** The type of the vehicle in vehicle_label. Absent before 00669; null without an active vehicle. */
    vehicle_type?: VehicleType | null;
  } | null;
  /** The ride's driver profile. The panel sends it back to the three actions as the driver it saw. */
  driver_profile_id: string | null;
  /** A cargo ride without the recipient's code and the delivery photo: support cannot complete it. */
  delivery_proof_missing: boolean;
  last_point: {
    recorded_at: string;
    received_at: string | null;
    distance_to_pickup_m: number;
    distance_to_dropoff_m: number;
  } | null;
  alert: { reason: string; detected_at: string } | null;
  preview: ActiveRideChargePreview | null;
  /** For arrived_at_pickup: the pickup time "Marcar viaje iniciado" would record. */
  start_pickup_at: string | null;
  start_pickup_source: 'recorded' | 'gps' | 'arrival' | 'now' | null;
  /** What the server would accept now. Empty for an accepted/en-route ride scheduled for later. */
  allowed_actions: ActiveRideAction[];
}

/** What "Avanzar" recorded (admin_advance_active_ride). */
export interface ActiveRideAdvanceResult {
  status: string;
  driver_arrived_at: string | null;
  pickup_at: string | null;
  wait_minutes: number;
  billable_minutes: number;
  wait_cup: number;
}

/** What "Terminar y cobrar" charged (admin_complete_active_ride). */
export interface ActiveRideCompleteResult {
  final_fare_cup: number;
  payment_method: string;
  /** The part the driver collects in cash. Null when the server did not report it. */
  cash_amount_cup: number | null;
  wallet_amount_cup: number | null;
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
  return new AppError(`${rpc} is not deployed yet`, RIDE_ASSIST_UNAVAILABLE, 503);
}

/** A JSON number, or null for anything else (absent, null, not finite). */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
    const proposal = data as Omit<ServiceProposal, 'received_at_ms'> | null;
    return proposal ? { ...proposal, received_at_ms: Date.now() } : null;
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

  /** The active-ride view's data. A missing RPC (00660 not applied) throws RIDE_ASSIST_UNAVAILABLE. */
  async getActiveContext(rideId: string): Promise<ActiveRideContext> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_active_ride_context', { p_ride_id: rideId });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_active_ride_context');
      throw error;
    }
    throwIfRefused('admin_active_ride_context', data);
    return data as ActiveRideContext;
  },

  /**
   * Back to search now. `expectedStatus` and `expectedDriverId` are what support saw: the server
   * refuses with ride_changed if either differs.
   */
  async releaseActiveRide(rideId: string, expectedStatus: string, expectedDriverId: string, reason: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_release_active_ride', {
      p_ride_id: rideId,
      p_expected_status: expectedStatus,
      p_expected_driver_id: expectedDriverId,
      p_reason: reason,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_release_active_ride');
      throw error;
    }
    throwIfRefused('admin_release_active_ride', data);
  },

  /** One step forward. Returns the new status and, from the pickup step on, the wait it recorded. */
  async advanceActiveRide(
    rideId: string,
    expectedStatus: string,
    expectedDriverId: string,
    reason: string,
  ): Promise<ActiveRideAdvanceResult> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_advance_active_ride', {
      p_ride_id: rideId,
      p_expected_status: expectedStatus,
      p_expected_driver_id: expectedDriverId,
      p_reason: reason,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_advance_active_ride');
      throw error;
    }
    throwIfRefused('admin_advance_active_ride', data);
    const r = data as Partial<ActiveRideAdvanceResult>;
    return {
      status: r.status ?? '',
      driver_arrived_at: r.driver_arrived_at ?? null,
      pickup_at: r.pickup_at ?? null,
      wait_minutes: numberOrNull(r.wait_minutes) ?? 0,
      billable_minutes: numberOrNull(r.billable_minutes) ?? 0,
      wait_cup: numberOrNull(r.wait_cup) ?? 0,
    };
  },

  /**
   * Complete and charge `expectedTotalCup`, the amount support confirmed (refused as
   * amount_changed otherwise). Returns what was charged, including the cash part the driver
   * collects when the server reports it.
   */
  async completeActiveRide(
    rideId: string,
    expectedStatus: string,
    expectedDriverId: string,
    expectedTotalCup: number,
    reason: string,
  ): Promise<ActiveRideCompleteResult> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_complete_active_ride', {
      p_ride_id: rideId,
      p_expected_status: expectedStatus,
      p_expected_driver_id: expectedDriverId,
      p_expected_total_cup: expectedTotalCup,
      p_reason: reason,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_complete_active_ride');
      throw error;
    }
    throwIfRefused('admin_complete_active_ride', data);
    const r = data as Record<string, unknown>;
    return {
      final_fare_cup: numberOrNull(r.final_fare_cup) ?? expectedTotalCup,
      payment_method: typeof r.payment_method === 'string' ? r.payment_method : '',
      cash_amount_cup: numberOrNull(r.cash_amount_cup),
      wallet_amount_cup: numberOrNull(r.wallet_amount_cup),
    };
  },
};
