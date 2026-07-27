import { useState, useEffect, useCallback, useRef } from 'react';
import { chatService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';

const POLL_INTERVAL_MS = 12_000;

/**
 * Unread-message counter for the active-trip screen (Bug B).
 *
 * The chat screen's own realtime/poll only runs while THAT screen is mounted.
 * This hook gives the rider an unread badge on TripActionBar while they are
 * looking at the map.
 *
 * "Unread" now means `read_at IS NULL` on the server (00516). It used to mean
 * "newer than the chat_last_read_<rideId> timestamp this device happens to hold
 * in AsyncStorage", which was wrong three ways: it did not survive a reinstall,
 * two devices signed into the same account disagreed, and it bore no relation
 * to the check mark the other party was shown. One fact drives both now.
 *
 * Cost: one count/head query every 12s — no rows cross the wire. The previous
 * version fetched the whole thread just to produce a number.
 *
 * Returns `markRead()` so the caller can zero the badge the moment the rider
 * opens the chat, instead of waiting up to 12s for the next poll.
 */
export function useUnreadChatCount(
  rideId: string | null,
): { count: number; markRead: () => void } {
  const userId = useAuthStore((s) => s.user?.id);
  const [count, setCount] = useState(0);
  const rideIdRef = useRef(rideId);
  rideIdRef.current = rideId;

  const recompute = useCallback(async () => {
    const id = rideIdRef.current;
    if (!id || !userId) {
      setCount(0);
      return;
    }
    try {
      setCount(await chatService.getUnreadCount(id, userId));
    } catch {
      /* best-effort — keep the last known count rather than flashing zero */
    }
  }, [userId]);

  // Poll while the trip screen is mounted.
  useEffect(() => {
    if (!rideId || !userId) {
      setCount(0);
      return;
    }
    recompute();
    const interval = setInterval(recompute, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [rideId, userId, recompute]);

  /** Zero the badge and stamp read_at server-side — call on chat open. */
  const markRead = useCallback(() => {
    const id = rideIdRef.current;
    setCount(0);
    if (id) {
      chatService.markRead(id).catch(() => { /* best-effort */ });
    }
  }, []);

  return { count, markRead };
}
