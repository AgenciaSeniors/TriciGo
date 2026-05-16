import { useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { chatService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';

const POLL_INTERVAL_MS = 12_000;

/** AsyncStorage key for the "last time the rider opened this chat". */
export const chatLastReadKey = (rideId: string) => `chat_last_read_${rideId}`;

/**
 * Lightweight unread-message counter for the active-trip screen (Bug B).
 *
 * The chat screen's own realtime/poll only runs while THAT screen is
 * mounted. This hook gives the rider an unread badge on TripActionBar
 * while they're looking at the map. "Unread" = messages from the driver
 * (sender_id !== self) with created_at after the `chat_last_read_<id>`
 * timestamp the chat screen persists on open/close.
 *
 * Cost: 1 request / 12s — trivial next to the 1 Hz GPS poll.
 *
 * Returns `markRead()` so the caller can zero the badge instantly when
 * the rider opens the chat (instead of waiting up to 12s for the poll).
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
      const [raw, messages] = await Promise.all([
        AsyncStorage.getItem(chatLastReadKey(id)),
        chatService.getMessages(id),
      ]);
      const lastRead = raw ? new Date(raw).getTime() : 0;
      const unread = messages.filter(
        (m) =>
          m.sender_id !== userId &&
          new Date(m.created_at).getTime() > lastRead,
      ).length;
      setCount(unread);
    } catch {
      /* best-effort — keep the last known count */
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

  /** Zero the badge + persist the read timestamp — call on chat open. */
  const markRead = useCallback(() => {
    const id = rideIdRef.current;
    setCount(0);
    if (id) {
      AsyncStorage.setItem(
        chatLastReadKey(id),
        new Date().toISOString(),
      ).catch(() => { /* best-effort */ });
    }
  }, []);

  return { count, markRead };
}
