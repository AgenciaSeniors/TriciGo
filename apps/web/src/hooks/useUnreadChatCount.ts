'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { chatService } from '@tricigo/api';

const POLL_INTERVAL_MS = 12_000;

/**
 * Unread-message counter for the tracking screen (parity with mobile).
 *
 * "Unread" means `read_at IS NULL` on the server (00516). It used to mean
 * "newer than the chat_last_read_<id> timestamp in this browser's
 * localStorage", which was per-browser, lost with a cleared cache, and bore no
 * relation to the check mark the other party was shown. One fact drives both
 * now — and the same fact drives all three surfaces.
 *
 * Cost: one count/head query every 12s, no rows over the wire. The previous
 * version downloaded the whole thread just to produce a number.
 */
export function useUnreadChatCount(
  rideId: string | null | undefined,
  userId: string | null | undefined,
): { count: number; markRead: () => void } {
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
      /* best-effort — keep the last known count */
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
