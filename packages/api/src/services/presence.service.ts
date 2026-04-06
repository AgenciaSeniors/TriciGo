// ============================================================
// TriciGo — Presence Service
// Manages Supabase Presence for ride-search driver tracking
// and Broadcast for fast accept notifications.
// ============================================================

import type { RealtimeChannel } from '@supabase/supabase-js';
import type {
  SearchingDriverPresence,
  DriverAcceptedBroadcast,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';

/** Active channels keyed by rideId */
const activeChannels = new Map<string, RealtimeChannel>();

export const presenceService = {
  // ── Driver-side ──────────────────────────────────────────

  /**
   * Driver joins the ride-search Presence channel so the
   * requesting passenger can see them on the map.
   */
  joinRideSearch(
    rideId: string,
    presence: SearchingDriverPresence,
  ): RealtimeChannel {
    const supabase = getSupabaseClient();
    const channelName = `ride-search:${rideId}`;

    // Reuse existing channel if still open
    let channel = activeChannels.get(rideId);
    if (channel) {
      channel.track(presence);
      return channel;
    }

    channel = supabase.channel(channelName);
    channel
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channel!.track(presence);
        }
      });

    activeChannels.set(rideId, channel);
    return channel;
  },

  /**
   * Driver leaves the ride-search Presence channel
   * (dismiss, timeout, navigate away).
   */
  leaveRideSearch(rideId: string): void {
    const channel = activeChannels.get(rideId);
    if (!channel) return;

    channel.untrack();
    const supabase = getSupabaseClient();
    supabase.removeChannel(channel);
    activeChannels.delete(rideId);
  },

  // ── Client-side ──────────────────────────────────────────

  /**
   * Passenger subscribes to the ride-search channel to see
   * which drivers are reviewing the offer, and receive the
   * fast "driver_accepted" broadcast.
   */
  subscribeToSearchingDrivers(
    rideId: string,
    onSync: (drivers: SearchingDriverPresence[]) => void,
    onAccepted: (data: DriverAcceptedBroadcast) => void,
  ): RealtimeChannel {
    const supabase = getSupabaseClient();
    const channelName = `ride-search:${rideId}`;

    const channel = supabase.channel(channelName);

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<SearchingDriverPresence>();
        const drivers: SearchingDriverPresence[] = [];
        for (const presences of Object.values(state)) {
          for (const p of presences) {
            drivers.push({
              driverId: p.driverId,
              name: p.name,
              avatarUrl: p.avatarUrl,
              vehicleType: p.vehicleType,
              rating: p.rating,
              location: p.location,
              joinedAt: p.joinedAt,
            });
          }
        }
        onSync(drivers);
      })
      .on('broadcast', { event: 'driver_accepted' }, (payload) => {
        onAccepted(payload.payload as DriverAcceptedBroadcast);
      })
      .subscribe();

    activeChannels.set(rideId, channel);
    return channel;
  },

  // ── Driver broadcast ─────────────────────────────────────

  /**
   * Driver broadcasts acceptance as a fast-path notification
   * so the client can play the accept animation immediately
   * (before the DB RPC completes).
   */
  broadcastDriverAccepted(
    rideId: string,
    data: DriverAcceptedBroadcast,
  ): void {
    const channel = activeChannels.get(rideId);
    if (channel) {
      channel.send({
        type: 'broadcast',
        event: 'driver_accepted',
        payload: data,
      });
      return;
    }

    // If channel doesn't exist yet (edge case), create a temporary one
    const supabase = getSupabaseClient();
    const channelName = `ride-search:${rideId}`;
    const tempChannel = supabase.channel(channelName);

    // Safety: clean up temp channel regardless of subscription outcome
    const cleanupTimeout = setTimeout(() => {
      supabase.removeChannel(tempChannel);
    }, 5000);

    tempChannel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        tempChannel.send({
          type: 'broadcast',
          event: 'driver_accepted',
          payload: data,
        });
        // Clean up after a short delay (cancel the safety timeout)
        clearTimeout(cleanupTimeout);
        setTimeout(() => {
          supabase.removeChannel(tempChannel);
        }, 2000);
      }
    });
  },

  // ── Cleanup ──────────────────────────────────────────────

  /**
   * Unsubscribe and remove the ride-search channel (client or driver).
   */
  unsubscribeSearch(rideId: string): void {
    const channel = activeChannels.get(rideId);
    if (!channel) return;

    const supabase = getSupabaseClient();
    supabase.removeChannel(channel);
    activeChannels.delete(rideId);
  },

  /**
   * Clean up all active search channels (e.g. on logout).
   */
  cleanupAll(): void {
    const supabase = getSupabaseClient();
    for (const [rideId, channel] of activeChannels) {
      supabase.removeChannel(channel);
      activeChannels.delete(rideId);
    }
  },
};
