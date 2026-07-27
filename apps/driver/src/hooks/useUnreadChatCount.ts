import { useState, useEffect, useCallback, useRef } from 'react';
import { chatService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';

const POLL_INTERVAL_MS = 12_000;

/**
 * Unread-message badge for the driver's active-trip toolbar.
 *
 * The rider has had one of these for a while; the driver never did, so unless
 * the push notification landed they had no way of knowing the passenger had
 * written — the chat button looked identical either way.
 *
 * "Unread" comes from `ride_messages.read_at` (00516), not from a timestamp
 * kept on this device. That matters here more than on the rider side: a driver
 * signs in on a replacement phone mid-shift and the badge is still right,
 * because the fact lives on the server.
 *
 * Cost: one `count`/`head` query every 12s — no rows cross the wire.
 *
 * `markRead()` is exposed so opening the chat clears the badge at once instead
 * of waiting up to 12s for the next poll.
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

  useEffect(() => {
    if (!rideId || !userId) {
      setCount(0);
      return;
    }
    recompute();
    const interval = setInterval(recompute, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [rideId, userId, recompute]);

  /** Zero the badge and stamp read_at server-side — call when the chat opens. */
  const markRead = useCallback(() => {
    const id = rideIdRef.current;
    setCount(0);
    if (id) {
      chatService.markRead(id).catch(() => { /* best-effort */ });
    }
  }, []);

  return { count, markRead };
}
