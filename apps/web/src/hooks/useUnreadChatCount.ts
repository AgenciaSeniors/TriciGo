'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { chatService } from '@tricigo/api';

const POLL_INTERVAL_MS = 12_000;

/** localStorage key for "last time the rider opened this chat" (parity con móvil). */
export const chatLastReadKey = (rideId: string) => `chat_last_read_${rideId}`;

/**
 * Persist the last-read timestamp for a ride's chat. Call when the chat opens
 * and closes so the tracking-screen unread badge clears (parity con el sellado
 * de last-read del chat móvil).
 */
export function stampChatRead(rideId: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(chatLastReadKey(rideId), new Date().toISOString());
  } catch {
    /* private mode / quota — best-effort */
  }
}

/**
 * Lightweight unread-message counter for the tracking screen (parity con
 * `useUnreadChatCount` móvil). "Unread" = messages from the other party
 * (`sender_id !== userId`) newer than the persisted `chat_last_read_<id>`
 * timestamp the chat page stamps on open/close. Polls every 12s while mounted.
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
    if (!id || !userId || typeof window === 'undefined') {
      setCount(0);
      return;
    }
    try {
      const raw = localStorage.getItem(chatLastReadKey(id));
      const messages = await chatService.getMessages(id);
      const lastRead = raw ? new Date(raw).getTime() : 0;
      const unread = messages.filter(
        (m) => m.sender_id !== userId && new Date(m.created_at).getTime() > lastRead,
      ).length;
      setCount(unread);
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

  /** Zero the badge + persist the read timestamp — call on chat open. */
  const markRead = useCallback(() => {
    const id = rideIdRef.current;
    setCount(0);
    if (id) stampChatRead(id);
  }, []);

  return { count, markRead };
}
